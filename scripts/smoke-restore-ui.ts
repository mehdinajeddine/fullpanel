/**
 * Opt-in real-browser restoration proof. Run after `npm run build` with Docker
 * available and postgres:17-alpine already present. The real deployment path
 * checks its pinned digest with the registry. No browser interception, runtime
 * replacement, or shared-resource pruning.
 *
 * Usage: npx tsx scripts/smoke-restore-ui.ts
 * Evidence is retained under .local/restore-ui/<run UUID>/; fixture data and
 * resources carrying either of this run's exact service UUIDs are removed.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { createApp } from '../server/app.js';
import { NativeDatabaseTools } from '../server/database-restore.js';
import { command } from '../server/docker.js';
import type { Backup, Deployment, Project, RestoreJob, Service, Session } from '../shared/types.js';

const runId = randomUUID();
const imageTag = 'postgres:17-alpine';
const staticDir = resolve('dist/client');
const evidenceDir = resolve('.local', 'restore-ui', runId);
const serviceIds = new Set<string>();
const cleanupErrors: string[] = [];
let dataDir: string | undefined;
let projectId: string | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let completed = false;

async function eventually<T>(description: string, check: () => Promise<T | undefined>, timeout = 120_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 350));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function api<T>(request: APIRequestContext, path: string, body?: unknown): Promise<T> {
  const response = body === undefined
    ? await request.get(`/api${path}`)
    : await request.post(`/api${path}`, { data: body });
  if (!response.ok()) {
    // API errors contain a public, redacted message; never dump successful
    // responses because owner/service responses can contain fixture secrets.
    throw new Error(`${body === undefined ? 'GET' : 'POST'} ${path} returned ${response.status()}: ${(await response.text()).slice(0, 2000)}`);
  }
  return await response.json() as T;
}

async function capture(surface: Page, filename: string) {
  // Keep docs evidence clean using ordinary user interactions; preserve the
  // app's keyboard focus styling and notification behavior.
  await surface.getByRole('dialog').getByRole('heading', { level: 2 }).click();
  await expect(surface.locator('.toast')).toHaveCount(0, { timeout: 7000 });
  // The dialog backdrop is viewport-fixed; a full-page capture would include
  // offscreen background below that backdrop and misrepresent the open dialog.
  await surface.screenshot({ path: join(evidenceDir, filename) });
}

async function cleanupOwnedResources() {
  // Query both active and retained/candidate resources. Name-based cleanup alone
  // misses a container renamed during the restore switch or a retained volume.
  for (const serviceId of serviceIds) {
    for (const kind of ['container', 'volume'] as const) {
      try {
        const identifiers = (await command('docker', [kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '--quiet', '--filter', 'label=io.harborlight.managed=true', '--filter', `label=io.harborlight.service=${serviceId}`])).trim().split('\n').filter(Boolean);
        for (const identifier of identifiers) {
          const [resource] = JSON.parse(await command('docker', [kind, 'inspect', identifier]));
          const labels = kind === 'container' ? resource.Config?.Labels : resource.Labels;
          assert.ok(labels?.['io.harborlight.managed'] === 'true' && labels['io.harborlight.service'] === serviceId, 'Cleanup must verify exact resource ownership.');
          await command('docker', [kind, 'rm', ...(kind === 'container' ? ['--force'] : []), identifier]);
        }
      } catch (error) { cleanupErrors.push(`Owned ${kind} cleanup for ${serviceId}: ${String(error)}`); }
    }
  }
  if (projectId) {
    try {
      const identifiers = (await command('docker', ['network', 'ls', '--quiet', '--filter', 'label=io.harborlight.managed=true', '--filter', `label=io.harborlight.project=${projectId}`])).trim().split('\n').filter(Boolean);
      for (const identifier of identifiers) {
        const [network] = JSON.parse(await command('docker', ['network', 'inspect', identifier]));
        assert.ok(network.Name === `hl-project-${projectId}` && network.Labels?.['io.harborlight.project'] === projectId && network.Labels?.['io.harborlight.managed'] === 'true', 'Cleanup must verify the exact project network.');
        await command('docker', ['network', 'rm', identifier]);
      }
    } catch (error) { cleanupErrors.push(`Owned network cleanup: ${String(error)}`); }
  }
}

try {
  await access(join(staticDir, 'index.html'));
  await command('docker', ['info', '--format', '{{.ServerVersion}}']);
  // The real driver always pulls. Pin the existing image's digest so a changed
  // upstream tag cannot grow the test footprint or change its database version.
  const [localImage] = JSON.parse(await command('docker', ['image', 'inspect', imageTag]));
  const image = (localImage.RepoDigests as string[]).find(value => /^(?:docker\.io\/library\/)?postgres@sha256:[a-f0-9]{64}$/.test(value));
  assert.ok(image, 'The local PostgreSQL image must have a registry digest.');
  await mkdir(evidenceDir, { recursive: true });
  dataDir = await mkdtemp(join(tmpdir(), 'harborlight-restore-ui-'));
  const originalPublicUrl = process.env.PUBLIC_URL;
  delete process.env.PUBLIC_URL;
  try { app = await createApp({ mode: 'docker', dataDir, staticDir, cookieSecure: false }); }
  finally { if (originalPublicUrl !== undefined) process.env.PUBLIC_URL = originalPublicUrl; }
  const baseURL = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch(process.platform === 'darwin' ? { channel: 'chrome' } : {});
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce' });
  const request = context.request;
  page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const session = await api<Session>(request, '/auth/setup', { name: 'Restore UI proof', email: `restore-${runId}@example.test`, password: randomUUID() + randomUUID() });
  assert.ok(session.authenticated && session.mode === 'docker', 'Browser context must own a real Docker-mode session.');
  const project = await api<Project>(request, '/projects', { name: `restore-ui-${runId.slice(0, 8)}`, description: 'Isolated real-browser restoration fixture.' });
  projectId = project.id;
  const database = new NativeDatabaseTools(command, dataDir);
  async function createDatabase(name: string): Promise<Service> {
    const item = await api<Service>(request, '/services', {
      projectId, name, kind: 'postgres', source: { type: 'image', image },
      env: { POSTGRES_USER: `${name}_owner`, POSTGRES_PASSWORD: randomUUID(), POSTGRES_DB: `${name}_database`, RESTORE_PROOF_SCOPE: name },
      resources: { cpu: 0.5, memoryMb: 256 },
    });
    serviceIds.add(item.id);
    assert.ok(item.mounts.length === 1 && item.mounts[0].mountPath === '/var/lib/postgresql/data', 'API must create the default managed PostgreSQL volume.');
    const deployment = await api<Deployment>(request, `/services/${item.id}/deploy`, {});
    await eventually('PostgreSQL deployment', async () => {
      const current = await api<Deployment>(request, `/deployments/${deployment.id}`);
      if (current.status === 'failed') throw new Error(`Fixture deployment failed: ${current.output}`);
      return current.status === 'success' ? current : undefined;
    });
    await eventually('PostgreSQL SQL readiness', async () => {
      try { await database.ready(`hl-${item.id}`, item); return true; }
      catch { return undefined; }
    });
    return await api<Service>(request, `/services/${item.id}`);
  }
  async function sql(service: Service, query: string, client: Service = service) {
    const args = ['psql', '-X', '-h', client.id === service.id ? '127.0.0.1' : service.name, '-p', '5432', '-U', service.env.POSTGRES_USER, '-d', service.env.POSTGRES_DB, '-v', 'ON_ERROR_STOP=1', '-Atc', query];
    if (client.id === service.id) return (await database.execute(`hl-${client.id}`, service, args)).trim();
    // The product client deliberately pins PGHOSTADDR to its own container.
    // This independent test client must instead resolve the destination DNS;
    // fixture credentials stay in a short-lived 0600 file, never argv or logs.
    const clientEnvironment = join(dataDir!, `external-client-${randomUUID()}.env`);
    await writeFile(clientEnvironment, `PGPASSWORD=${service.env.POSTGRES_PASSWORD}\nPGCONNECT_TIMEOUT=5\n`, { mode: 0o600, flag: 'wx' });
    // libpq treats an empty PGSERVICE as an actual service lookup; remove it
    // instead. Unset host-address/options as well so -h uses destination DNS.
    const unset = ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGPASSFILE'].flatMap(key => ['-u', key]);
    try { return (await command('docker', ['exec', '--env-file', clientEnvironment, `hl-${client.id}`, 'env', ...unset, ...args])).trim(); }
    finally { await rm(clientEnvironment, { force: true }); }
  }
  const source = await createDatabase('source');
  const target = await createDatabase('destination');
  // PostgreSQL's default loopback pg_hba rules can use trust. Cross-container
  // requests exercise the password-protected host rule and private service DNS.
  assert.equal(await sql(source, 'SELECT 1', target), '1');
  assert.equal(await sql(target, 'SELECT 1', source), '1');
  await assert.rejects(sql({ ...target, env: { ...target.env, POSTGRES_PASSWORD: randomUUID() } }, 'SELECT 1', source), /password authentication failed/);
  const sourceValue = `source-snapshot-${runId}`;
  const newerSourceValue = `source-after-snapshot-${runId}`;
  const targetValue = `destination-before-restore-${runId}`;
  await sql(source, `CREATE TABLE restore_proof (value text NOT NULL); INSERT INTO restore_proof VALUES ('${sourceValue}');`);
  await sql(target, `CREATE TABLE restore_proof (value text NOT NULL); INSERT INTO restore_proof VALUES ('${targetValue}');`);
  assert.equal(await sql(target, 'SELECT value FROM restore_proof'), targetValue);
  const queuedBackup = await api<Backup>(request, `/services/${source.id}/backups`, {});
  const backup = await eventually('source backup', async () => {
    const item = (await api<Backup[]>(request, `/services/${source.id}/backups`)).find(item => item.id === queuedBackup.id);
    if (item?.status === 'failed') throw new Error(`Fixture backup failed: ${item.error}`);
    return item?.status === 'success' ? item : undefined;
  });
  assert.ok(backup.metadata?.kind === 'postgres' && backup.metadata.format === 'postgres-sql' && /^17\./.test(backup.metadata.engineVersion || '') && backup.sha256, 'Source backup must contain verified PostgreSQL 17 metadata and integrity hash.');
  await sql(source, `UPDATE restore_proof SET value = '${newerSourceValue}'`);
  console.log('PASS: two live databases have distinct data and credentials; source backup contains the earlier snapshot.');

  // Only the restore itself is driven through the browser. Setup uses the same
  // authenticated HTTP API as the UI, sharing the real browser session cookie.
  await page.goto(`/#/services/${source.id}/backups`);
  const row = page.getByRole('row').filter({ hasText: backup.filename });
  await expect(row.getByRole('button', { name: 'Restore', exact: true })).toBeVisible({ timeout: 15_000 });
  await row.getByRole('button', { name: 'Restore', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Restore a backup' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByLabel('Destination service', { exact: true }).selectOption(target.id);
  await expect(confirmation.getByRole('heading', { name: `Replace data in ${project.name} / ${target.name}`, exact: true })).toBeVisible();
  await expect(confirmation.getByText(/Database credentials from this backup replace/)).toBeVisible();
  const confirmName = confirmation.getByLabel(`Type “${target.name}” to confirm`, { exact: true });
  const restoreButton = confirmation.getByRole('button', { name: 'Restore backup', exact: true });
  await expect(restoreButton).toBeDisabled();
  await confirmName.fill(`${target.name}-wrong`);
  await expect(restoreButton).toBeDisabled();
  await confirmName.fill(target.name);
  await expect(restoreButton).toBeEnabled();
  await capture(page, 'desktop-confirmation.png');
  const submission = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/services/${target.id}/restore`);
  await restoreButton.click();
  const submitted = await submission;
  assert.equal(submitted.status(), 202, 'UI restore submission must be accepted by the real backend.');
  const queuedRestore = await submitted.json() as RestoreJob;
  const progress = page.getByRole('dialog', { name: 'Restore progress' });
  await expect(progress).toBeVisible();
  await expect(progress.getByText('Recovery journal', { exact: true })).toBeVisible();
  for (const name of ['Validating backup', 'Creating recovery backup', 'Restoring into new volumes', 'Finished']) {
    await expect(progress.getByLabel('Restore phases').getByText(name, { exact: true })).toBeVisible();
  }
  await capture(page, 'desktop-progress.png');
  const observedPhases = new Set<RestoreJob['phase']>([queuedRestore.phase]);
  const job = await eventually('real restore job', async () => {
    const current = await api<RestoreJob>(request, `/restores/${queuedRestore.id}`);
    observedPhases.add(current.phase);
    if (current.status === 'failed') throw new Error(`Restoration failed: ${current.error}\n${current.output}`);
    return current.status === 'success' ? current : undefined;
  }, 300_000);
  assert.ok(job.phase === 'finished' && job.finishedAt && job.preRestoreBackupId, 'Restore must finish with a durable job and a pre-restore backup.');
  assert.match(job.output, /Backup integrity verified/);
  assert.match(job.output, /automatic safety backup/);
  assert.match(job.output, /recovery checkpoint before switching/);
  assert.match(job.output, /Restored runtime verified/);
  for (const secret of [source.env.POSTGRES_PASSWORD, target.env.POSTGRES_PASSWORD]) assert.ok(!job.output.includes(secret), 'Restore journal must not expose database passwords.');
  await expect(progress.getByText('Restore completed', { exact: true })).toBeVisible({ timeout: 15_000 });
  const safetyLink = progress.getByRole('link', { name: 'Pre-restore backup', exact: true });
  await expect(safetyLink).toHaveAttribute('href', `/api/backups/${job.preRestoreBackupId}/download`);
  const safety = (await api<Backup[]>(request, '/backups')).find(item => item.id === job.preRestoreBackupId);
  assert.ok(safety?.status === 'success' && safety.serviceId === target.id && safety.restoreJobId === job.id, 'Safety backup must belong to the original destination and this restore job.');
  const downloaded = await request.get(`/api/backups/${job.preRestoreBackupId}/download`);
  assert.ok(downloaded.ok(), 'Safety backup must be downloadable.');
  const safetySql = await downloaded.text();
  assert.ok(safetySql.includes(targetValue) && !safetySql.includes(sourceValue), 'Safety backup must preserve the destination data before restoration.');

  const restored = await api<Service>(request, `/services/${target.id}`);
  assert.ok(restored.status === 'running', 'Destination must be running after restoration.');
  for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB']) assert.ok(restored.env[key] === source.env[key], `Destination must adopt backed-up ${key}.`);
  assert.equal(restored.env.RESTORE_PROOF_SCOPE, target.env.RESTORE_PROOF_SCOPE, 'Non-database target environment must be preserved.');
  await database.ready(`hl-${target.id}`, restored);
  assert.equal(await sql(restored, 'SELECT value FROM restore_proof', source), sourceValue, 'Restoration must use the selected snapshot and authenticate from another container.');
  assert.equal(await sql(source, 'SELECT value FROM restore_proof'), newerSourceValue, 'Restoring a backup must leave the source untouched.');
  await assert.rejects(sql({ ...restored, env: { ...restored.env, POSTGRES_PASSWORD: target.env.POSTGRES_PASSWORD } }, 'SELECT 1', source), /password authentication failed/, 'The previous destination password must not authenticate the adopted database user.');
  const [originalVolume] = JSON.parse(await command('docker', ['volume', 'inspect', `hl-${target.id}-${target.mounts[0].name}`]));
  assert.equal(originalVolume.Labels?.['io.harborlight.service'], target.id, 'Original target volume must be retained.');
  const [restoredContainer] = JSON.parse(await command('docker', ['container', 'inspect', `hl-${target.id}`]));
  const activeData = restoredContainer.Mounts.find((mount: { Destination: string }) => mount.Destination === '/var/lib/postgresql/data');
  assert.ok(activeData?.Name !== originalVolume.Name && activeData?.Name.startsWith(`hl-${target.id}-restore-`), 'Active runtime must use a new candidate volume.');
  await capture(page, 'desktop-completed.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(progress.getByText('Restore completed', { exact: true })).toBeVisible();
  const resizeSamples: Array<{ viewport: number; document: number; main: number; topbar: number }> = [];
  await expect.poll(async () => {
    const sample = await page!.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, main: document.querySelector('.main-shell')!.getBoundingClientRect().width, topbar: document.querySelector('.topbar > div:last-child')!.getBoundingClientRect().right }));
    resizeSamples.push(sample);
    return sample.document - sample.viewport;
  }, { timeout: 3000, message: 'Mobile layout must settle without horizontal page overflow.' }).toBeLessThanOrEqual(1);
  const mobileLayout = await page.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll<HTMLElement>('body *')].filter(element => element.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 25).map(element => ({ tag: element.tagName, class: element.className, right: element.getBoundingClientRect().right, overflow: getComputedStyle(element).overflowX })),
  }));
  assert.ok(mobileLayout.documentWidth <= mobileLayout.width + 1, `Mobile page must not overflow horizontally: ${JSON.stringify(mobileLayout)}`);
  await capture(page, 'mobile-completed.png');
  // Recreate the actual API server from disk, retaining the browser cookie.
  // This checks persisted jobs/configuration rather than only in-memory state.
  await page.goto('about:blank');
  await app.close();
  app = undefined;
  app = await createApp({ mode: 'docker', dataDir, staticDir, cookieSecure: false, publicUrl: baseURL });
  await app.listen({ host: '127.0.0.1', port: Number(new URL(baseURL).port) });
  const persisted = await api<RestoreJob>(request, `/restores/${job.id}`);
  assert.deepEqual(persisted, job, 'Restore outcome and journal must survive API server recreation.');
  const persistedTarget = await api<Service>(request, `/services/${target.id}`);
  for (const key of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB']) assert.ok(persistedTarget.env[key] === source.env[key], `Adopted ${key} must persist.`);
  assert.equal(await sql(persistedTarget, 'SELECT value FROM restore_proof', source), sourceValue);
  assert.ok((await request.get(`/api/backups/${job.preRestoreBackupId}/download`)).ok(), 'Safety backup must remain downloadable after server recreation.');
  await page.goto(`/#/services/${target.id}/backups`);
  await page.getByRole('button', { name: new RegExp(`${target.name} Finished .* Success`, 'i') }).click();
  await expect(page.getByRole('dialog', { name: 'Restore progress' }).getByText('Restore completed', { exact: true })).toBeVisible();
  await capture(page, 'mobile-persisted-journal.png');
  assert.deepEqual(pageErrors, [], 'Restore workflow must not generate browser runtime errors.');
  await writeFile(join(evidenceDir, 'result.json'), JSON.stringify({ runId, result: 'passed', image, projectId, sourceServiceId: source.id, targetServiceId: target.id, sourceBackupId: backup.id, restoreJobId: job.id, preRestoreBackupId: job.preRestoreBackupId, observedPhases: [...observedPhases], resizeSamples, journal: job.output, verified: ['real browser confirmation', 'job, journal, session and adopted credentials persist across API server recreation', 'pre-restore snapshot download', 'selected source snapshot restored', 'source unchanged', 'database credentials adopted', 'previous password rejected over private network', 'other target environment preserved', 'original target volume retained', 'new active candidate volume', 'desktop and mobile UI'] }, null, 2));
  completed = true;
  console.log(`PASS: real UI restore, verified data and credentials, safety backup, retained volumes, desktop/mobile. Evidence: ${evidenceDir}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(evidenceDir, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close().catch(error => cleanupErrors.push(`Browser cleanup: ${String(error)}`));
  // Closing Fastify waits for active jobs before removing their owned runtimes.
  await app?.close().catch(error => cleanupErrors.push(`Server cleanup: ${String(error)}`));
  await cleanupOwnedResources();
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(error => cleanupErrors.push(`Temporary data cleanup: ${String(error)}`));
  if (cleanupErrors.length) {
    console.error(cleanupErrors.join('\n'));
    if (completed) throw new Error('Restore proof passed, but one or more isolated fixture resources could not be removed.');
  } else if (dataDir) console.log('PASS: all test-owned containers, candidate/retained volumes, project network and temporary secrets removed.');
}

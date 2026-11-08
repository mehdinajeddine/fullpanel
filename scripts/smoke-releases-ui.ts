/**
 * Opt-in Docker + browser proof for immutable rollback and native GitHub controls.
 * Run `npm run build`, then `node --import tsx scripts/smoke-releases-ui.ts`.
 * Requires the existing nginx:1.28-alpine image and Chrome on macOS, Chromium on
 * Linux. The image digest is pinned; no GitHub push in this test starts a clone.
 * Evidence: .local/releases-ui/<UUID>/. Cleanup touches only this run's UUIDs.
 */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { createApp } from '../server/app.js';
import { command, DockerDriver } from '../server/docker.js';
import type { Deployment, GitHubWebhookStatus, Project, ReleasesResponse, Service, Session } from '../shared/types.js';

const runId = randomUUID();
const evidenceDir = resolve('.local', 'releases-ui', runId);
const staticDir = resolve('dist/client');
const services: Service[] = [];
const cleanupErrors: string[] = [];
let dataDir: string | undefined, projectId: string | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let browser: Browser | undefined, page: Page | undefined;
let completed = false;

async function api<T>(request: APIRequestContext, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await request.fetch(`/api${path}`, { method, ...(body === undefined ? {} : { data: body }) });
  if (!response.ok()) throw new Error(`${method} ${path}: ${response.status()} ${(await response.text()).slice(0, 2000)}`);
  return await response.json() as T;
}
async function eventually<T>(description: string, check: () => Promise<T | undefined>, timeout = 120_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 400));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
async function screenshot(surface: Page, filename: string) {
  await expect(surface.locator('.toast')).toHaveCount(0, { timeout: 7000 });
  const dialog = surface.getByRole('dialog');
  if (await dialog.count()) await dialog.getByRole('heading', { level: 2 }).click();
  else await surface.getByRole('heading', { level: 1 }).click();
  await surface.screenshot({ path: join(evidenceDir, filename) });
}
async function cleanup() {
  for (const service of services) {
    try {
      const ids = (await command('docker', ['container', 'ls', '-aq', '--filter', 'label=io.harborlight.managed=true', '--filter', `label=io.harborlight.service=${service.id}`])).trim().split('\n').filter(Boolean);
      for (const id of ids) {
        const [container] = JSON.parse(await command('docker', ['container', 'inspect', id]));
        assert.ok(container.Config?.Labels?.['io.harborlight.managed'] === 'true' && container.Config?.Labels?.['io.harborlight.service'] === service.id);
        await command('docker', ['container', 'rm', '--force', id]);
      }
      if (dataDir) await new DockerDriver(dataDir).remove(service);
      const volumes = (await command('docker', ['volume', 'ls', '--quiet', '--filter', 'label=io.harborlight.managed=true', '--filter', `label=io.harborlight.service=${service.id}`])).trim().split('\n').filter(Boolean);
      for (const name of volumes) {
        const [volume] = JSON.parse(await command('docker', ['volume', 'inspect', name]));
        assert.ok(volume.Labels?.['io.harborlight.managed'] === 'true' && volume.Labels?.['io.harborlight.service'] === service.id);
        await command('docker', ['volume', 'rm', name]);
      }
      const repository = `harborlight/${service.id}`;
      const images = (await command('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', repository])).trim().split('\n').filter(Boolean);
      for (const image of new Set(images)) {
        assert.ok(image.startsWith(`${repository}:`));
        const [details] = JSON.parse(await command('docker', ['image', 'inspect', image]));
        assert.ok(details.Config?.Labels?.['io.harborlight.managed'] === 'true' && details.RepoTags?.includes(image));
        await command('docker', ['image', 'rm', image]);
      }
    } catch (error) { cleanupErrors.push(`Cleanup service ${service.id}: ${String(error)}`); }
  }
  if (projectId) {
    try {
      const ids = (await command('docker', ['network', 'ls', '--quiet', '--filter', 'label=io.harborlight.managed=true', '--filter', `label=io.harborlight.project=${projectId}`])).trim().split('\n').filter(Boolean);
      for (const id of ids) {
        const [network] = JSON.parse(await command('docker', ['network', 'inspect', id]));
        assert.ok(network.Name === `hl-project-${projectId}` && network.Labels?.['io.harborlight.managed'] === 'true' && network.Labels?.['io.harborlight.project'] === projectId);
        await command('docker', ['network', 'rm', id]);
      }
    } catch (error) { cleanupErrors.push(`Cleanup network: ${String(error)}`); }
  }
}

try {
  await access(join(staticDir, 'index.html'));
  await command('docker', ['info', '--format', '{{.ServerVersion}}']);
  const [cached] = JSON.parse(await command('docker', ['image', 'inspect', 'nginx:1.28-alpine']));
  const digest = (cached.RepoDigests as string[]).find(value => /^(?:docker\.io\/library\/)?nginx@sha256:[a-f0-9]{64}$/.test(value));
  assert.ok(digest, 'The cached Nginx image must have a registry digest.');
  await mkdir(evidenceDir, { recursive: true });
  dataDir = await mkdtemp(join(tmpdir(), 'harborlight-releases-ui-'));
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
  const session = await api<Session>(request, '/auth/setup', { name: 'Release UI proof', email: `releases-${runId}@example.test`, password: randomUUID() + randomUUID() });
  assert.ok(session.authenticated && session.mode === 'docker');
  const project = await api<Project>(request, '/projects', { name: `releases-ui-${runId.slice(0, 8)}` });
  projectId = project.id;
  async function createService(values: Record<string, unknown>) {
    const service = await api<Service>(request, '/services', { projectId, ...values });
    services.push(service);
    return service;
  }
  async function waitDeployment(id: string) {
    return await eventually('deployment completion', async () => {
      const deployment = await api<Deployment>(request, `/deployments/${id}`);
      if (deployment.status === 'failed') throw new Error(`Deployment failed: ${deployment.output}`);
      return deployment.status === 'success' ? deployment : undefined;
    }, 180_000);
  }
  const firstSecret = randomUUID(), secondSecret = randomUUID();
  const firstSource = { type: 'dockerfile', dockerfile: `FROM ${digest}\nRUN printf version-one > /usr/share/nginx/html/index.html\n` };
  const secondSource = { type: 'dockerfile', dockerfile: `FROM ${digest}\nRUN printf version-two > /usr/share/nginx/html/index.html\n` };
  const web = await createService({ name: 'release-web', kind: 'app', source: firstSource, env: { RELEASE_MARKER: 'version-one', RELEASE_SECRET: firstSecret }, mounts: [{ name: 'data', mountPath: '/state' }], resources: { cpu: 0.5, memoryMb: 128 } });
  await page.goto(`/#/services/${web.id}/releases`);
  await expect(page.getByRole('heading', { name: 'No recorded releases yet', exact: true })).toBeVisible();
  const firstDeployment = await waitDeployment((await api<Deployment>(request, `/services/${web.id}/deploy`, {})).id);
  assert.ok(firstDeployment.releaseId);
  const firstRelease = (await api<ReleasesResponse>(request, `/services/${web.id}/releases`)).releases.find(release => release.id === firstDeployment.releaseId)!;
  assert.ok(firstRelease && /^sha256:[a-f0-9]{64}$/.test(firstRelease.imageId));
  await eventually('first application response', async () => {
    try { return (await command('docker', ['exec', `hl-${web.id}`, 'wget', '-qO-', 'http://127.0.0.1'])).trim() === 'version-one' ? true : undefined; }
    catch { return undefined; }
  });
  await command('docker', ['exec', `hl-${web.id}`, 'sh', '-c', 'printf original-data > /state/proof']);
  await api<Service>(request, `/services/${web.id}`, { source: secondSource, env: { RELEASE_MARKER: 'version-two', RELEASE_SECRET: secondSecret } }, 'PATCH');
  const secondDeployment = await waitDeployment((await api<Deployment>(request, `/services/${web.id}/deploy`, {})).id);
  const secondRelease = (await api<ReleasesResponse>(request, `/services/${web.id}/releases`)).releases.find(release => release.id === secondDeployment.releaseId)!;
  assert.ok(secondRelease && secondRelease.imageId !== firstRelease.imageId, 'Two releases must retain distinct immutable images.');
  await command('docker', ['exec', `hl-${web.id}`, 'sh', '-c', 'printf data-written-after-version-two > /state/proof']);
  await page.reload();
  const firstCard = page.getByRole('article', { name: `Release ${firstRelease.id.slice(0, 8)}`, exact: true });
  await expect(firstCard.getByRole('button', { name: 'Roll back', exact: true })).toBeVisible();
  const metadata = await api<ReleasesResponse>(request, `/services/${web.id}/releases`);
  for (const secret of [firstSecret, secondSecret]) assert.ok(!JSON.stringify(metadata).includes(secret), 'Release metadata must never expose runtime secrets.');
  assert.ok(!JSON.stringify(metadata).includes('RELEASE_MARKER'), 'Release metadata must not expose saved environment maps.');
  await firstCard.getByRole('button', { name: 'Roll back', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Roll back application', exact: true });
  const rollbackButton = dialog.getByRole('button', { name: 'Roll back application', exact: true });
  await expect(dialog.getByText(/Persistent volumes keep their current data/)).toBeVisible();
  await expect(rollbackButton).toBeDisabled();
  await dialog.getByLabel(`Type “${web.name}” to confirm`, { exact: true }).fill(`${web.name}-wrong`);
  await expect(rollbackButton).toBeDisabled();
  await dialog.getByLabel(`Type “${web.name}” to confirm`, { exact: true }).fill(web.name);
  await expect(rollbackButton).toBeEnabled();
  await screenshot(page, 'rollback-confirmation-desktop.png');
  const posted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/services/${web.id}/rollback`);
  await rollbackButton.click();
  const accepted = await posted;
  assert.equal(accepted.status(), 202);
  const queued = await accepted.json() as Deployment;
  const rollback = await waitDeployment(queued.id);
  assert.equal(rollback.rollbackOf, firstRelease.id);
  await expect(page).toHaveURL(new RegExp(`#/deployments/${rollback.id}$`));
  await expect(page.locator('.detail-summary .status-success')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.terminal-output')).toContainText(/rollback|immutable/i);
  const [runtime] = JSON.parse(await command('docker', ['container', 'inspect', `hl-${web.id}`]));
  assert.equal(runtime.Image, firstRelease.imageId, 'Rollback must execute the recorded image ID.');
  assert.ok(runtime.Config.Env.includes('RELEASE_MARKER=version-one') && runtime.Config.Env.includes(`RELEASE_SECRET=${firstSecret}`), 'Runtime must use release-one environment.');
  assert.equal((await command('docker', ['exec', `hl-${web.id}`, 'wget', '-qO-', 'http://127.0.0.1'])).trim(), 'version-one');
  assert.equal((await command('docker', ['exec', `hl-${web.id}`, 'cat', '/state/proof'])).trim(), 'data-written-after-version-two', 'Rollback must preserve newer persistent data.');
  const desired = await api<Service>(request, `/services/${web.id}`);
  assert.ok(desired.env.RELEASE_SECRET === secondSecret && desired.env.RELEASE_MARKER === 'version-two', 'Saved desired environment must remain version two.');
  assert.equal(desired.source.dockerfile, secondSource.dockerfile);
  assert.equal(desired.pendingChanges, true);
  const afterRollback = await api<ReleasesResponse>(request, `/services/${web.id}/releases`);
  assert.equal(afterRollback.releases.length, 3, 'Rollback records a new release rather than rewriting history.');
  assert.equal(afterRollback.activeReleaseId, rollback.releaseId);
  assert.equal(afterRollback.releases.find(release => release.id === rollback.releaseId)?.rollbackOf, firstRelease.id);
  await page.goto(`/#/services/${web.id}/releases`);
  await expect(page.getByText('Saved configuration differs from the current runtime. Select Deploy to apply your saved changes.', { exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: `Release ${rollback.releaseId!.slice(0, 8)}`, exact: true }).getByText('Active', { exact: true })).toBeVisible();
  await screenshot(page, 'release-history-desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page!.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.getByRole('heading', { name: 'Application releases', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidenceDir, 'release-history-mobile.png') });
  console.log('PASS: UI-confirmed immutable rollback restores image/environment, retains newer data and leaves saved configuration pending.');

  // These configuration-only services create no Docker containers or volumes.
  for (const kind of ['postgres', 'compose'] as const) {
    const unsupported = await createService({ name: `unsupported-${kind}`, kind });
    const response = await api<ReleasesResponse>(request, `/services/${unsupported.id}/releases`);
    assert.ok(!response.supported && /single-container applications/.test(response.reason || ''));
    await page.goto(`/#/services/${unsupported.id}/releases`);
    await expect(page.getByRole('heading', { name: 'Release rollback is unavailable', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Roll back', exact: true })).toHaveCount(0);
  }
  const github = await createService({ name: 'github-controls', kind: 'app', source: { type: 'git', repository: 'https://github.com/octocat/Hello-World.git', branch: 'main' } });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.goto(`/#/services/${github.id}/source`);
  await page.getByRole('button', { name: 'Generate GitHub secret', exact: true }).click();
  const hookSecret = await page.getByLabel('New GitHub webhook secret', { exact: true }).inputValue();
  assert.ok(hookSecret.length >= 40);
  const hookPath = `/api/hooks/github/${github.id}`;
  async function delivery(secret: string, payload = '{}', event = 'ping', signedBody = payload) {
    return await request.post(hookPath, { data: payload, headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': randomUUID(), 'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(signedBody).digest('hex')}` } });
  }
  const publicHook = await api<GitHubWebhookStatus>(request, `/services/${github.id}/github-webhook`);
  assert.ok(publicHook.enabled && !JSON.stringify(publicHook).includes(hookSecret));
  assert.equal((await delivery(hookSecret)).status(), 200);
  assert.equal((await delivery(hookSecret, '{"tampered":true}', 'ping', '{}')).status(), 401);
  const mismatch = await delivery(hookSecret, JSON.stringify({ ref: 'refs/heads/other', deleted: false, after: 'a'.repeat(40), repository: { full_name: 'octocat/Hello-World', html_url: 'https://github.com/octocat/Hello-World' } }), 'push');
  assert.equal(mismatch.status(), 200);
  assert.equal((await mismatch.json()).status, 'ignored');
  await page.reload();
  await expect(page.getByLabel('New GitHub webhook secret', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Rotate GitHub secret', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Rotate GitHub secret', exact: true }).click();
  const rotatedSecret = await page.getByLabel('New GitHub webhook secret', { exact: true }).inputValue();
  assert.ok(rotatedSecret !== hookSecret);
  assert.equal((await delivery(hookSecret)).status(), 401);
  assert.equal((await delivery(rotatedSecret)).status(), 200);
  await page.getByLabel('Branch', { exact: true }).fill('release');
  await expect(page.getByRole('button', { name: 'Rotate GitHub secret', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('The repository or branch changed. Rotate the webhook secret to enable deliveries.', { exact: true })).toBeVisible();
  assert.equal((await delivery(rotatedSecret)).status(), 401);
  await page.getByRole('button', { name: 'Rotate GitHub secret', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Rotate GitHub secret', exact: true }).click();
  const finalSecret = await page.getByLabel('New GitHub webhook secret', { exact: true }).inputValue();
  assert.equal((await delivery(finalSecret)).status(), 200);
  await page.getByRole('button', { name: 'I’ve saved the GitHub secret', exact: true }).click();
  await expect(page.getByLabel('New GitHub webhook secret', { exact: true })).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 7000 });
  await page.locator('.github-webhook').screenshot({ path: join(evidenceDir, 'github-configured.png') });
  await page.getByRole('button', { name: 'Revoke GitHub webhook', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke GitHub webhook', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Generate GitHub secret', exact: true })).toBeVisible();
  assert.equal((await delivery(finalSecret)).status(), 401);
  assert.equal((await api<Deployment[]>(request, `/services/${github.id}/deployments`)).length, 0, 'Ignored/test deliveries must never start a clone or deployment.');
  console.log('PASS: real GitHub UI secret once, signature verification, rotation, saved-branch invalidation and revoke; no GitHub fixture was deployed.');

  await page.goto('about:blank');
  await app.close(); app = undefined;
  app = await createApp({ mode: 'docker', dataDir, staticDir, cookieSecure: false, publicUrl: baseURL });
  await app.listen({ host: '127.0.0.1', port: Number(new URL(baseURL).port) });
  const persisted = await api<ReleasesResponse>(request, `/services/${web.id}/releases`);
  assert.deepEqual(persisted, afterRollback);
  assert.equal((await api<Service>(request, `/services/${web.id}`)).pendingChanges, true);
  assert.equal((await api<Deployment>(request, `/deployments/${rollback.id}`)).output, rollback.output);
  await page.goto(`/#/services/${web.id}/releases`);
  await expect(page.getByRole('article', { name: `Release ${rollback.releaseId!.slice(0, 8)}`, exact: true }).getByText('Active', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Saved configuration differs from the current runtime. Select Deploy to apply your saved changes.', { exact: true })).toBeVisible();
  assert.deepEqual(pageErrors, []);
  await writeFile(join(evidenceDir, 'result.json'), JSON.stringify({ runId, result: 'passed', image: digest, projectId, serviceId: web.id, firstReleaseId: firstRelease.id, secondReleaseId: secondRelease.id, rollbackReleaseId: rollback.releaseId, rollbackDeploymentId: rollback.id, journal: rollback.output, verified: ['real exact-name UI rollback', 'immutable image and environment restored', 'newer persistent data retained', 'saved desired configuration unchanged and pending', 'append-only release history', 'metadata contains no environment or secrets', 'history, journal, session and dirty state persist after API restart', 'mobile layout', 'GitHub secret one-time display, signature, rotation, source invalidation and revoke', 'database and Compose gating'] }, null, 2));
  completed = true;
  console.log(`PASS: release and GitHub browser proof complete. Evidence: ${evidenceDir}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(evidenceDir, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close().catch(error => cleanupErrors.push(`Browser: ${String(error)}`));
  await app?.close().catch(error => cleanupErrors.push(`Server: ${String(error)}`));
  await cleanup();
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(error => cleanupErrors.push(`Temporary data: ${String(error)}`));
  if (cleanupErrors.length) {
    console.error(cleanupErrors.join('\n'));
    if (completed) throw new Error('Browser proof passed, but exact fixture cleanup needs attention.');
  } else if (dataDir) console.log('PASS: fixture containers, volumes, release/build tags, project network and temporary secrets removed.');
}

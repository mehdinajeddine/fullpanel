import { test, expect, type BrowserContext } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';

const credentials = { name: 'FullPanel QA', email: 'qa@example.test', password: 'Local-test-password-3472!' };
let ownerCookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
test.describe.serial('Owner workflows', () => {
  test('first owner, authentication, and honest demo dashboard', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/^FullPanel/);
    await expect(page.getByRole('link', { name: 'FullPanel home', exact: true }).first()).toBeVisible();
    expect(await page.locator('.brand-mark img').first().getAttribute('src')).toBe('/assets/fullpanel-logo.png');
    expect(await page.locator('body').evaluate(element => getComputedStyle(element).fontFamily)).toContain('Inter Variable');
    expect(await page.locator('body').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(15);
    await page.getByLabel('Your name').fill(credentials.name);
    await page.getByLabel('Email address').fill(credentials.email);
    await page.getByLabel(/^Password/).fill(credentials.password);
    await page.getByRole('button', { name: /Create.*workspace|Create.*account|Get started/ }).click();
    await expect(page.getByRole('heading', { name: 'Workspace overview' })).toBeVisible();
    await expect(page.locator('.demo-banner')).toContainText('simulated');
    await expect(page.getByRole('list', { name: 'Service states', exact: true })).toBeVisible();
    await expect(page.getByRole('listitem', { name: '3 running services', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Workspace overview' })).toBeVisible();
    await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
    ownerCookies = await page.context().cookies();
  });

  test.beforeEach(async ({ page }, testInfo) => {
    if (testInfo.title.startsWith('first owner')) return;
    await page.context().addCookies(ownerCookies);
  });

  test('create project and application, persist configuration, deploy and inspect logs', async ({ page }) => {
    await page.goto('/#/projects');
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Project name').fill('acceptance-project');
    await modal.getByLabel('Description').fill('An isolated browser acceptance project');
    await modal.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'acceptance-project', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add service', exact: true }).first().click();
    await page.getByRole('dialog').getByLabel('Service name').fill('acceptance-web');
    await page.getByRole('dialog').getByRole('button', { name: 'Create service', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'acceptance-web', exact: true })).toBeVisible();
    await expect(page.getByText('Awaiting first deploy', { exact: true })).toBeVisible();
    await page.getByLabel(/^Image/).fill('nginx:1.28-alpine');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('link', { name: 'Environment', exact: true }).click();
    await page.getByRole('button', { name: 'Add variable', exact: true }).click();
    await page.getByLabel('Variable 1 name').fill('ACCEPTANCE_VALUE');
    await page.getByLabel('Variable 1 value').fill('saved-through-ui');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('Configuration saved. Deploy to apply runtime changes.').first()).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Variable 1 value')).toHaveValue('saved-through-ui');
    await page.getByRole('button', { name: 'Deploy', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Deployment history', exact: true })).toBeVisible();
    await expect(page.locator('.status-success').first()).toBeVisible();
    await page.getByRole('link', { name: 'Logs', exact: true }).click();
    await expect(page.locator('.runtime-logs')).toContainText('DEMO');
    await page.getByLabel('Filter logs').fill('does-not-exist-123');
    await expect(page.locator('.runtime-logs')).toContainText('No lines match');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  });

  test('database credentials, demo backup, and guarded deletion', async ({ page }) => {
    const projects = await (await page.request.get('/api/projects')).json();
    const project = projects.find((p: { name: string }) => p.name === 'acceptance-project');
    await page.goto(`/#/projects/${project.id}`);
    await page.getByRole('button', { name: 'Add service', exact: true }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByRole('button', { name: /PostgreSQL/ }).click();
    await modal.getByLabel('Service name').fill('acceptance-db');
    await modal.getByRole('button', { name: 'Create service', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'acceptance-db', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Deploy', exact: true }).click();
    await expect(page.locator('.status-success').first()).toBeVisible();
    await page.getByRole('link', { name: 'Backups', exact: true }).last().click();
    await page.getByRole('button', { name: 'Run backup', exact: true }).click();
    await expect(page.locator('.status-success').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Download/ }).first()).toBeVisible();
    await page.getByRole('link', { name: 'Settings', exact: true }).last().click();
    await page.getByRole('button', { name: 'Delete service', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
    await page.getByRole('dialog').getByLabel(/Type.*acceptance-db/).fill('acceptance-db');
    await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page.getByRole('heading', { name: 'acceptance-project', exact: true })).toBeVisible();
  });

  test('mobile navigation and page layout', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Workspace overview' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    expect(await page.locator('.page-heading p').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
    expect((await page.getByRole('button', { name: 'Open navigation', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  });

  test('edit projects and navigate through keyboard search', async ({ page }) => {
    const projects = await (await page.request.get('/api/projects')).json();
    const project = projects.find((p: { name: string }) => p.name === 'acceptance-project');
    await page.goto(`/#/projects/${project.id}`);
    await page.getByRole('button', { name: 'Edit project', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Description').fill('Updated description persists');
    await page.getByRole('dialog').getByRole('button', { name: /Save/ }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('Updated description persists', { exact: true })).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').getByLabel('Search workspace').fill('acceptance-web');
    await page.getByRole('dialog').getByRole('button', { name: /acceptance-web/ }).click();
    await expect(page.getByRole('heading', { name: 'acceptance-web', exact: true })).toBeVisible();
  });

  test('deployment token is shown once, rotated and revoked', async ({ page }) => {
    const services = await (await page.request.get('/api/services')).json();
    const service = services.find((s: { name: string }) => s.name === 'acceptance-web');
    await page.goto(`/#/services/${service.id}/deployments`);
    await page.getByRole('button', { name: 'Generate token', exact: true }).click();
    const token = await page.getByLabel('New deployment token').inputValue();
    expect(token.length).toBeGreaterThan(30);
    const hook = `/api/hooks/deploy/${service.id}`;
    expect((await page.request.post(hook, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(202);
    await page.getByRole('button', { name: 'Rotate token', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Rotate token', exact: true }).click();
    await expect(page.getByLabel('New deployment token')).not.toHaveValue(token);
    expect((await page.request.post(hook, { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401);
    await page.getByRole('button', { name: 'Revoke token', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke token', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Generate token', exact: true })).toBeVisible();
    await expect(page.getByLabel('New deployment token')).toHaveCount(0);
  });

  test('backup schedule runs, pauses, and retains files after removal', async ({ page }) => {
    const projects = await (await page.request.get('/api/projects')).json();
    const project = projects.find((p: { name: string }) => p.name === 'acceptance-project');
    const service = await (await page.request.post('/api/services', { data: { projectId: project.id, name: 'scheduled-db', kind: 'postgres' } })).json();
    await page.request.post(`/api/services/${service.id}/deploy`);
    await expect.poll(async () => (await (await page.request.get(`/api/services/${service.id}`)).json()).status).toBe('running');
    await page.goto(`/#/services/${service.id}/backups`);
    await page.getByRole('button', { name: 'Add schedule', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Frequency').selectOption('daily');
    await modal.getByLabel('Hour (UTC)').fill('3');
    await modal.getByLabel('Minute', { exact: true }).fill('30');
    await modal.getByLabel('Successful backups to retain').fill('2');
    await modal.getByRole('button', { name: 'Create schedule', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Daily at 03:30 UTC' })).toBeVisible();
    await page.getByRole('button', { name: 'Run scheduled backup now' }).click();
    await expect(page.getByRole('link', { name: /Download/ }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Pause schedule', exact: true }).click();
    await expect(page.getByText('Schedule paused', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Delete backup schedule', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete schedule', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Give backups a rhythm', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /Download/ }).first()).toBeVisible();
  });

  test('template install and appearance preferences persist', async ({ page }) => {
    await page.goto('/#/templates');
    await page.getByLabel('Search templates').fill('Redis');
    const card = page.locator('.template-card').filter({ has: page.getByRole('heading', { name: 'Redis', exact: true }) });
    await card.getByRole('button', { name: /Add|Use|Deploy/ }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Service name').fill('template-cache');
    await modal.getByRole('button', { name: 'Add to project', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'template-cache', exact: true })).toBeVisible();
    await page.goto('/#/settings');
    await page.getByLabel('Appearance').selectOption('dark');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: 'test-results/settings-dark.png', fullPage: true });
  });

  test('create a viewer account and enforce its project boundary', async ({ page }) => {
    const projects = await (await page.request.get('/api/projects')).json();
    const project = projects.find((item: { name: string }) => item.name === 'acceptance-project');
    const services = await (await page.request.get('/api/services')).json();
    const service = services.find((item: { name: string }) => item.name === 'acceptance-web');
    const outside = services.find((item: { projectId: string }) => item.projectId !== project.id);
    await page.goto('/#/users');
    await page.getByRole('button', { name: 'Add account', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Full name').fill('Project Reader');
    await modal.getByLabel('Account email').fill('reader@example.test');
    await modal.getByLabel('Initial password').fill('Viewer-password-for-testing');
    await modal.getByLabel('acceptance-project', { exact: true }).check();
    await modal.getByLabel('Access to acceptance-project').selectOption('viewer');
    await modal.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(modal).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Project Reader', exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/team-access.png', fullPage: true });
    const login = await page.request.post('/api/auth/login', { data: { email: 'reader@example.test', password: 'Viewer-password-for-testing' } });
    expect(login.ok()).toBeTruthy();
    const credentialReads: string[] = [];
    page.on('request', request => { if (request.url().includes('/source-credentials')) credentialReads.push(request.url()); });
    await page.goto(`/#/services/${service.id}/overview`);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'acceptance-web', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deploy', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Terminal', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Team & access', exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: 'Source', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Application source', exact: true })).toBeVisible();
    expect(credentialReads).toEqual([]);
    const detail = await (await page.request.get(`/api/services/${service.id}`)).json();
    expect(detail.env).toEqual({});
    expect((await page.request.post(`/api/services/${service.id}/deploy`, { data: {} })).status()).toBe(403);
    expect((await page.request.get(`/api/services/${service.id}/terminal`)).status()).toBe(403);
    expect((await page.request.get(`/api/services/${service.id}/metrics`)).status()).toBe(200);
    expect((await page.request.get(`/api/services/${service.id}/ports`)).status()).toBe(200);
    expect((await page.request.get(`/api/services/${service.id}/source-credentials`)).status()).toBe(403);
    expect((await page.request.post(`/api/services/${service.id}/source-credentials/ssh/rotate`, { data: {} })).status()).toBe(403);
    expect((await page.request.get('/api/users')).status()).toBe(403);
    expect((await page.request.get(`/api/services/${outside.id}`)).status()).toBe(404);
    expect((await (await page.request.get('/api/projects')).json()).map((item: { id: string }) => item.id)).toEqual([project.id]);
  });

  test('issue a scoped API key once and revoke it through the UI', async ({ page }) => {
    await page.goto('/#/api-keys');
    await page.getByRole('button', { name: 'New API key', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Key name').fill('Acceptance read key');
    await modal.getByLabel('acceptance-project', { exact: true }).check();
    await modal.getByLabel('Permission', { exact: true }).selectOption('read');
    await modal.getByRole('button', { name: 'Create API key', exact: true }).click();
    const token = await page.getByLabel('New API key token').inputValue();
    expect(token).toMatch(/^hl_[A-Za-z0-9_-]{43}$/);
    const authorized = await page.request.get('/api/projects', { headers: { Authorization: `Bearer ${token}` } });
    expect(authorized.ok()).toBeTruthy();
    expect((await authorized.json()).map((item: { name: string }) => item.name)).toEqual(['acceptance-project']);
    await page.getByRole('button', { name: 'I’ve saved the key', exact: true }).click();
    await page.reload();
    await expect(page.getByLabel('New API key token')).toHaveCount(0);
    await page.getByRole('button', { name: 'Revoke Acceptance read key', exact: true }).click();
    await page.getByRole('dialog').getByLabel(/Type.*Acceptance read key/).fill('Acceptance read key');
    await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    expect((await page.request.get('/api/projects', { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401);
  });

  test('save advanced routing and rotate a write-only proxy password', async ({ page }) => {
    const services = await (await page.request.get('/api/services')).json();
    const service = services.find((item: { name: string }) => item.name === 'acceptance-web');
    await page.goto(`/#/services/${service.id}/domains`);
    await page.getByRole('button', { name: 'Add domain', exact: true }).click();
    await page.getByLabel('Hostname 1', { exact: true }).fill('protected.example.test');
    await page.getByLabel('Path 1', { exact: true }).fill('/app');
    await expect(page.getByText('Unsaved route', { exact: true })).toBeVisible();
    await expect(page.getByText('HTTPS is configured. Certificate issuance, validity and DNS are not verified here.', { exact: true })).toBeVisible();
    await page.getByText('Advanced routing', { exact: true }).click();
    await page.getByLabel('Strip the configured path before forwarding').check();
    await page.getByLabel('Redirect HTTP requests to HTTPS').check();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Protect domain', exact: true })).toBeDisabled();
    await expect(page.getByLabel('Username for protected.example.test')).toBeEnabled();
    await page.getByLabel('Username for protected.example.test').fill('qa-reader');
    await page.getByLabel('Password for protected.example.test').fill('Proxy-original-password');
    await page.getByRole('button', { name: 'Protect domain', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Replace password', exact: true })).toBeVisible();
    await expect(page.getByLabel('Password for protected.example.test')).toHaveValue('');
    await page.reload();
    await expect(page.getByLabel('Hostname 1', { exact: true })).toHaveValue('protected.example.test');
    await page.getByText('Advanced routing', { exact: true }).click();
    await expect(page.getByLabel('Strip the configured path before forwarding')).toBeChecked();
    await expect(page.getByLabel('Redirect HTTP requests to HTTPS')).toBeChecked();
    await page.getByLabel('Password for protected.example.test').fill('Proxy-rotated-password');
    await page.getByRole('button', { name: 'Replace password', exact: true }).click();
    await expect(page.getByLabel('Password for protected.example.test')).toHaveValue('');
    const saved = await (await page.request.get(`/api/services/${service.id}`)).json();
    const metadata = await (await page.request.get(`/api/services/${service.id}/domains/${saved.domains[0].id}/auth`)).json();
    expect(metadata).toEqual({ enabled: true, username: 'qa-reader' });
    while (await page.getByRole('button', { name: 'Dismiss notification', exact: true }).count()) await page.getByRole('button', { name: 'Dismiss notification', exact: true }).first().click();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({ path: 'test-results/domain-routing.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect.poll(async () => { const box = await page.locator('.sidebar').boundingBox(); return Math.round(box ? box.x + box.width : 0); }).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await page.screenshot({ path: 'test-results/domain-routing-mobile.png', fullPage: true });
  });

  test('save and remove a private image credential without exposing its secret', async ({ page }) => {
    const services = await (await page.request.get('/api/services')).json();
    const service = services.find((item: { name: string }) => item.name === 'acceptance-web');
    await page.goto(`/#/services/${service.id}/source`);
    await page.getByLabel('Registry username').fill('test-registry-user');
    await page.getByLabel('Registry password or token').fill('Private-registry-test-token');
    await page.getByRole('button', { name: 'Save credential', exact: true }).click();
    await expect(page.getByText('Credential stored for test-registry-user', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Registry password or token')).toHaveValue('');
    await page.reload();
    await expect(page.getByLabel('Registry password or token')).toHaveValue('');
    const metadata = await (await page.request.get(`/api/services/${service.id}/source-credentials`)).json();
    expect(metadata.registry.configured).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain('Private-registry-test-token');
    await page.getByRole('button', { name: 'Remove credential', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove credential', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByText('Credential stored for test-registry-user', { exact: true })).toHaveCount(0);
  });

  test('import project variables, override one on a service and preserve the save boundary', async ({ page }) => {
    const projects = await (await page.request.get('/api/projects')).json();
    const project = projects.find((item: { name: string }) => item.name === 'acceptance-project');
    const services = await (await page.request.get('/api/services')).json();
    const service = services.find((item: { name: string }) => item.name === 'acceptance-web');
    await page.goto(`/#/projects/${project.id}/environment`);
    await page.getByRole('button', { name: 'Import .env', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Paste .env contents').fill('SHARED_COLOR=sage\nSHARED_COLOR=duplicate');
    await modal.getByRole('button', { name: 'Preview import', exact: true }).click();
    await expect(modal.getByRole('alert')).toContainText('Duplicate variable');
    await expect(modal.getByRole('button', { name: 'Apply to draft', exact: true })).toBeDisabled();
    await modal.getByLabel('Paste .env contents').fill('# shared defaults\nSHARED_COLOR="sage"\nOVERRIDE_ME=project\nLITERAL=${UNEXPANDED}');
    await modal.getByRole('button', { name: 'Preview import', exact: true }).click();
    await expect(modal.locator('.env-preview-list')).not.toContainText('${UNEXPANDED}');
    await modal.getByRole('button', { name: 'Apply to draft', exact: true }).click();
    await expect(modal).not.toBeVisible();
    expect((await (await page.request.get(`/api/projects/${project.id}/environment`)).json()).env).toEqual({});
    await page.getByRole('button', { name: 'Save project variables', exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(`/api/projects/${project.id}/environment`)).json()).env).toEqual({ SHARED_COLOR: 'sage', OVERRIDE_ME: 'project', LITERAL: '${UNEXPANDED}' });
    await page.reload();
    await expect(page.getByLabel('Variable 1 value')).toHaveValue('sage');
    await expect(page.getByLabel('Variable 1 value')).toHaveAttribute('type', 'password');
    await page.goto(`/#/services/${service.id}/environment`);
    await expect(page.getByLabel('Inherited SHARED_COLOR value')).toHaveValue('sage');
    await expect(page.getByLabel('Inherited SHARED_COLOR value')).toHaveAttribute('readonly', '');
    await page.getByRole('button', { name: 'Override OVERRIDE_ME', exact: true }).click();
    // The existing acceptance variable is first; the deliberate override is appended.
    await page.getByLabel('Variable 2 value').fill('service-specific');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(`/api/services/${service.id}/environment`)).json()).effective.OVERRIDE_ME).toBe('service-specific');
    const dirty = await (await page.request.get(`/api/services/${service.id}`)).json();
    expect(Date.parse(dirty.updatedAt)).toBeGreaterThan(Date.parse(dirty.deployedAt));
    expect(dirty.env.SHARED_COLOR).toBeUndefined();
    await page.getByRole('button', { name: 'Remove variable OVERRIDE_ME', exact: true }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(`/api/services/${service.id}/environment`)).json()).effective.OVERRIDE_ME).toBe('project');
    await page.screenshot({ path: 'test-results/project-environment.png', fullPage: true });
  });

  test('demo backups explain their limits and do not offer real restoration', async ({ page }) => {
    const services = await (await page.request.get('/api/services')).json();
    const source = services.find((item: { name: string }) => item.name === 'scheduled-db');
    await page.goto(`/#/services/${source.id}/backups`);
    await expect(page.getByRole('heading', { name: 'Restore journal', exact: true })).toBeVisible();
    await expect(page.getByText('Restoration needs Docker mode', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restore', exact: true })).toHaveCount(0);
    await page.goto('/#/backups');
    await expect(page.getByText('Demo backups are illustrative. Restore is available in Docker mode.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restore', exact: true })).toHaveCount(0);
  });

  test('GitHub and release views explain demo limits without offering live controls', async ({ page }) => {
    const projects = await (await page.request.get('/api/projects')).json();
    const project = projects.find((item: { name: string }) => item.name === 'acceptance-project');
    const response = await page.request.post('/api/services', { data: { projectId: project.id, name: 'github-demo', kind: 'app', source: { type: 'git', repository: 'https://github.com/octocat/Hello-World.git', branch: 'main' } } });
    expect(response.status()).toBe(201);
    const service = await response.json();
    await page.goto(`/#/services/${service.id}/source`);
    await expect(page.getByRole('heading', { name: 'GitHub auto-deploy', exact: true })).toBeVisible();
    await expect(page.getByText('GitHub delivery deployment is unavailable in demo mode.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Generate GitHub secret', exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: 'Releases', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Application releases', exact: true })).toBeVisible();
    await expect(page.getByText('Immutable application releases are unavailable in demo mode.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Roll back', exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: 'Deployments', exact: true }).last().click();
    await expect(page.getByRole('heading', { name: 'CI deployment trigger', exact: true })).toBeVisible();
    await expect(page.getByLabel('Trigger endpoint')).toHaveValue(new RegExp(`/api/hooks/deploy/${service.id}$`));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/#/services/${service.id}/releases`);
    await expect(page.getByRole('heading', { name: 'Release rollback is unavailable', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  });

  test('demo terminal explains its limits without opening a socket or rendering a fake shell', async ({ page }) => {
    const services = await (await page.request.get('/api/services')).json();
    const service = services.find((item: { name: string }) => item.name === 'acceptance-web');
    const sockets: string[] = [];
    page.on('websocket', socket => sockets.push(socket.url()));
    await page.goto(`/#/services/${service.id}/terminal`);
    await expect(page.getByRole('heading', { name: 'Container terminal', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Terminal unavailable', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect terminal', exact: true })).toHaveCount(0);
    await expect(page.locator('.xterm')).toHaveCount(0);
    const capabilities = await (await page.request.get(`/api/services/${service.id}/terminal`)).json();
    expect(capabilities.supported).toBe(false);
    expect(capabilities.available).toBe(false);
    expect(sockets.filter(url => url.includes('/terminal/socket'))).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  });

  test('SSH deploy keys require saved sources and explicit server trust, rotate and revoke without exposing private keys', async ({ page }) => {
    const projects = await (await page.request.get('/api/projects')).json();
    const project = projects.find((item: { name: string }) => item.name === 'acceptance-project');
    const response = await page.request.post('/api/services', { data: { projectId: project.id, name: 'ssh-private-web', kind: 'app', source: { type: 'image', image: 'nginx:1.28-alpine' } } });
    expect(response.status()).toBe(201);
    const service = await response.json();
    const credentialsUrl = `/api/services/${service.id}/source-credentials`;
    const metadata = async () => {
      const response = await page.request.get(credentialsUrl);
      expect(response.ok()).toBeTruthy();
      const body = await response.json();
      expect(JSON.stringify(body)).not.toMatch(/PRIVATE KEY|privateKey/);
      return body;
    };
    const fingerprint = (publicKey: string) => `SHA256:${createHash('sha256').update(Buffer.from(publicKey.split(' ')[1], 'base64')).digest('base64').replace(/=+$/, '')}`;
    await page.goto(`/#/services/${service.id}/source`);
    await page.getByRole('button', { name: /Git repository/ }).click();
    await page.getByLabel(/^Repository URL/).fill('git@SSH.example.test:team/private-site.git/');
    await expect(page.getByRole('button', { name: 'Generate SSH deploy key', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByLabel(/^Repository URL/)).toHaveValue('git@ssh.example.test:team/private-site.git');
    const panel = page.locator('.ssh-credentials');
    await expect(panel.getByRole('list', { name: 'SSH configuration progress', exact: true })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'SSH deploy key', exact: true })).toBeVisible();
    await expect(panel.getByText(/Demo mode generates and stores real SSH keys/)).toBeVisible();
    await expect(panel.getByLabel(/^Trusted server host keys/)).toBeDisabled();
    await panel.getByRole('button', { name: 'Generate SSH deploy key', exact: true }).click();
    const publicField = panel.getByLabel(/^Public deploy key/);
    await expect(publicField).toHaveValue(/^ssh-ed25519 /);
    const firstKey = await publicField.inputValue();
    const first = await metadata();
    expect(first.ssh.fingerprint).toBe(fingerprint(firstKey));
    expect(first.ssh.hostKeyConfigured).toBe(false);
    await expect(panel.getByText('Next: verify the Git server', { exact: true })).toBeVisible();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await panel.getByRole('button', { name: 'Copy SSH public key', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(firstKey);
    // These reserved-domain server keys are an explicit cryptographic fixture; demo mode performs no network trust verification.
    const keyMaterial = firstKey.split(' ').slice(0, 2).join(' ');
    const hostField = panel.getByLabel(/^Trusted server host keys/);
    const verification = panel.getByLabel('I verified these server keys against a trusted provider or administrator.', { exact: true });
    await hostField.fill(`wrong.example.test ${keyMaterial}`);
    await expect(panel.getByRole('button', { name: 'Pin server host keys', exact: true })).toBeDisabled();
    await verification.check();
    const denied = page.waitForResponse(response => response.url().endsWith('/source-credentials/ssh/host-key') && response.request().method() === 'PUT');
    await panel.getByRole('button', { name: 'Pin server host keys', exact: true }).click();
    expect((await denied).status()).toBe(400);
    await expect(panel.locator('.error-box')).toBeVisible();
    expect((await metadata()).ssh.hostKeyConfigured).toBe(false);
    await hostField.fill(`ssh.example.test ${keyMaterial}`);
    await expect(verification).not.toBeChecked();
    await verification.check();
    await panel.getByRole('button', { name: 'Pin server host keys', exact: true }).click();
    await expect(panel.getByText('Server keys pinned', { exact: true })).toBeVisible();
    expect((await metadata()).ssh.hostFingerprints).toEqual([fingerprint(firstKey)]);
    await page.reload();
    await expect(publicField).toHaveValue(firstKey);
    await expect.poll(async () => (await hostField.inputValue()).trim()).toBe(`ssh.example.test ${keyMaterial}`);
    await panel.getByRole('button', { name: 'Rotate deploy key', exact: true }).click();
    await page.getByRole('dialog', { name: 'Rotate SSH deploy key?', exact: true }).getByRole('button', { name: 'Rotate deploy key', exact: true }).click();
    await expect(publicField).not.toHaveValue(firstKey);
    const secondKey = await publicField.inputValue();
    expect(secondKey).toMatch(/^ssh-ed25519 /);
    const rotated = await metadata();
    expect(rotated.ssh.fingerprint).toBe(fingerprint(secondKey));
    expect(rotated.ssh.hostFingerprints).toEqual([fingerprint(firstKey)]);
    expect(rotated.ssh.hostKeyConfigured).toBe(true);
    await hostField.fill(`ssh.example.test ${secondKey.split(' ').slice(0, 2).join(' ')}`);
    await verification.check();
    await panel.getByRole('button', { name: 'Replace pinned host keys', exact: true }).click();
    const trustDialog = page.getByRole('dialog', { name: 'Replace trusted server keys?', exact: true });
    await expect(trustDialog).toBeVisible();
    expect((await metadata()).ssh.hostFingerprints).toEqual([fingerprint(firstKey)]);
    await trustDialog.getByRole('button', { name: 'Replace trusted keys', exact: true }).click();
    await expect(trustDialog).not.toBeVisible();
    expect((await metadata()).ssh.hostFingerprints).toEqual([fingerprint(secondKey)]);
    await page.getByLabel('Branch', { exact: true }).fill('release');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await metadata()).ssh.publicKey).toBe(secondKey);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await expect.poll(async () => { const bounds = await page.locator('.sidebar').boundingBox(); return Math.round(bounds ? bounds.x + bounds.width : 0); }).toBeLessThanOrEqual(0);
    while (await page.getByRole('button', { name: 'Dismiss notification', exact: true }).count()) await page.getByRole('button', { name: 'Dismiss notification', exact: true }).first().click();
    await panel.getByRole('heading', { name: 'SSH deploy key', exact: true }).click();
    await panel.evaluate(element => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 20, behavior: 'instant' }));
    await page.screenshot({ path: 'test-results/ssh-access-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByLabel(/^Repository URL/).fill('ssh://git@SSH.example.test:2222/team/other.git/');
    await expect(panel.getByRole('button', { name: 'Rotate deploy key', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByLabel(/^Repository URL/)).toHaveValue('ssh://git@ssh.example.test:2222/team/other.git');
    await expect(panel.getByRole('button', { name: 'Generate SSH deploy key', exact: true })).toBeVisible();
    expect((await metadata()).ssh.configured).toBe(false);
    await panel.getByRole('button', { name: 'Generate SSH deploy key', exact: true }).click();
    await expect(publicField).toHaveValue(/^ssh-ed25519 /);
    await hostField.fill(`[ssh.example.test]:2222 ${keyMaterial}`);
    await verification.check();
    await panel.getByRole('button', { name: 'Pin server host keys', exact: true }).click();
    await expect(panel.getByText('Server keys pinned', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Remove SSH access', exact: true }).click();
    await page.getByRole('dialog', { name: 'Remove SSH access?', exact: true }).getByRole('button', { name: 'Remove SSH access', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Generate SSH deploy key', exact: true })).toBeVisible();
    expect((await metadata()).ssh.configured).toBe(false);
    await expect(publicField).toHaveCount(0);
    await page.getByLabel(/^Repository URL/).fill('ssh://git@[2001:db8::1]:2222/team/ipv6.git');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(hostField).toHaveAttribute('placeholder', '[2001:db8::1]:2222 ssh-ed25519 <verified-server-public-key>');
    await page.getByLabel(/^Repository URL/).fill('git@[2001:db8::1]:team/ipv6.git');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Generate SSH deploy key', exact: true })).toBeVisible();
    await expect(hostField).toHaveAttribute('placeholder', '2001:db8::1 ssh-ed25519 <verified-server-public-key>');
    await page.getByLabel(/^Repository URL/).fill('https://github.com/octocat/Hello-World.git');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Private Git access', exact: true })).toBeVisible();
    await expect(page.getByLabel('Git authentication options')).toContainText('then Generate SSH deploy key below');
    await expect(panel).toHaveCount(0);
    await expect(page.getByLabel('Git access token')).toBeVisible();
  });


  test('visual states stay explicit in empty projects and real not-found errors', async ({ page }) => {
    const response = await page.request.post('/api/projects', { data: { name: 'visual-empty-project' } });
    expect(response.status()).toBe(201);
    const project = await response.json();
    await page.goto(`/#/projects/${project.id}`);
    await expect(page.getByRole('listitem', { name: '0 running services', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'A fresh space for your next idea', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add service', exact: true }).last()).toBeEnabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.goto(`/#/services/${randomUUID()}`);
    await expect(page.getByRole('alert')).toContainText('Service not found');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Service not found');
    await expect(page.getByRole('button', { name: 'Deploy', exact: true })).toHaveCount(0);
    await page.request.delete(`/api/projects/${project.id}`);
  });

  test('opt in to automatic HTTP test URLs and preserve existing routes when disabled', async ({ page }) => {
    const original = await (await page.request.get('/api/settings')).json();
    const projects = await (await page.request.get('/api/projects')).json();
    const project = projects.find((item: { name: string }) => item.name === 'acceptance-project');
    const createdIds: string[] = [];
    const save = async () => {
      const [response] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PATCH'),
        page.getByRole('button', { name: 'Save settings', exact: true }).click(),
      ]);
      return response;
    };
    try {
      await page.goto('/#/settings');
      const section = page.getByRole('region', { name: 'Automatic test URLs', exact: true });
      await page.getByLabel(/^Base domain/).fill('');
      await page.getByLabel(/^Public server IPv4/).fill('10.0.0.1');
      expect((await save()).status()).toBe(400);
      await expect(page.getByRole('alert')).toBeVisible();
      expect((await (await page.request.get('/api/settings')).json()).testDomainIp || '').toBe(original.testDomainIp || '');
      await page.getByLabel(/^Public server IPv4/).fill('8.8.8.8');
      await page.getByLabel('Appearance').selectOption('light');
      expect((await save()).ok()).toBeTruthy();
      await page.reload();
      await expect(page.getByLabel(/^Public server IPv4/)).toHaveValue('8.8.8.8');
      await expect(section.getByText('Enabled for new apps', { exact: true })).toBeVisible();
      await expect(section.getByLabel('Test URL preview')).toContainText('http://fp-<service-id>.8-8-8-8.sslip.io');
      await expect(section).toContainText('DNS and reachability are not verified here');
      await page.getByLabel(/^Public server IPv4/).fill('8.8.8.8 ');
      await expect(section.getByText('Save to apply', { exact: true })).toBeVisible();
      await expect(section.getByLabel('Test URL preview')).toHaveCount(0);
      await page.getByLabel(/^Public server IPv4/).fill('8.8.8.8');
      await expect(section.getByText('Enabled for new apps', { exact: true })).toBeVisible();
      await page.setViewportSize({ width: 1280, height: 900 });
      await section.getByRole('heading').click();
      await section.evaluate(element => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 20, behavior: 'instant' }));
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: 'test-results/automatic-test-urls-desktop.png' });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(async () => { const box = await page.locator('.sidebar').boundingBox(); return Math.round(box ? box.x + box.width : 0); }).toBeLessThanOrEqual(0);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await section.evaluate(element => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 20, behavior: 'instant' }));
      await page.screenshot({ path: 'test-results/automatic-test-urls-mobile.png' });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/#/projects/${project.id}`);
      await page.getByRole('button', { name: 'Add service', exact: true }).first().click();
      await page.getByRole('dialog').getByLabel('Service name').fill('automatic-url-app');
      await page.getByRole('dialog').getByRole('button', { name: 'Create service', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'automatic-url-app', exact: true })).toBeVisible();
      const serviceId = page.url().match(/services\/([^/]+)/)![1];
      createdIds.push(serviceId);
      const service = await (await page.request.get(`/api/services/${serviceId}`)).json();
      const hostname = `fp-${serviceId.replaceAll('-', '')}.8-8-8-8.sslip.io`;
      expect(service.domains).toHaveLength(1);
      expect(service.domains[0]).toMatchObject({ hostname, port: 80, https: false });
      await page.getByRole('link', { name: 'Domains', exact: true }).click();
      await expect(page.getByLabel('Hostname 1', { exact: true })).toHaveValue(hostname);
      await expect(page.getByLabel('Enable HTTPS with automatic certificates', { exact: true })).not.toBeChecked();
      await page.goto('/#/templates');
      await page.getByLabel('Search templates').fill('Dozzle');
      await page.locator('.template-card').filter({ has: page.getByRole('heading', { name: 'Dozzle', exact: true }) }).getByRole('button', { name: 'Use template', exact: true }).click();
      await page.getByRole('dialog').getByLabel('Project', { exact: true }).selectOption(project.id);
      await page.getByRole('dialog').getByLabel('Service name').fill('automatic-url-template');
      const [installResponse] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/api/templates/dozzle/install') && response.request().method() === 'POST'),
        page.getByRole('dialog').getByRole('button', { name: 'Add to project', exact: true }).click(),
      ]);
      expect(installResponse.ok()).toBeTruthy();
      const templateService = await installResponse.json();
      createdIds.push(templateService.id);
      expect(templateService.domains[0]).toMatchObject({ hostname: `fp-${templateService.id.replaceAll('-', '')}.8-8-8-8.sslip.io`, port: 8080, https: false });
      await expect(page.getByRole('heading', { name: 'automatic-url-template', exact: true })).toBeVisible();
      await page.goto('/#/settings');
      await page.getByLabel(/^Base domain/).fill('apps.example.test');
      expect((await save()).ok()).toBeTruthy();
      await expect(section.getByText('Custom domain takes priority', { exact: true })).toBeVisible();
      await expect(section.getByLabel('Test URL preview')).toHaveCount(0);
      await page.getByLabel(/^Base domain/).fill('');
      await page.getByLabel(/^Public server IPv4/).fill('');
      expect((await save()).ok()).toBeTruthy();
      await page.reload();
      await expect(section.getByText('Off', { exact: true })).toBeVisible();
      expect((await (await page.request.get(`/api/services/${serviceId}`)).json()).domains).toEqual(service.domains);
    } finally {
      await page.request.patch('/api/settings', { data: original });
      for (const id of createdIds) await page.request.delete(`/api/services/${id}`);
    }
  });

  test('service metrics distinguish missing, stopped, recent, partial and stale samples', async ({ page }) => {
    test.setTimeout(65_000);
    const services = await (await page.request.get('/api/services')).json();
    const service = services.find((item: { name: string }) => item.name === 'acceptance-web');
    await page.goto(`/#/services/${service.id}/overview`);
    const metrics = page.getByRole('region', { name: 'Service metrics', exact: true });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(metrics.getByText('Demo · no live measurements', { exact: true })).toBeVisible();
    await expect(metrics.getByText('Unavailable', { exact: true })).toBeVisible();
    await expect(metrics.locator('.service-metric-card')).toHaveCount(0);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(metrics.getByText('Service stopped', { exact: true })).toBeVisible();
    await expect(metrics.getByText('No sample collected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(metrics.getByText('Unavailable', { exact: true })).toBeVisible();
    const fresh = await (await page.request.post('/api/services', { data: { projectId: service.projectId, name: 'metrics-not-deployed', kind: 'app', source: { type: 'image', image: 'nginx:1.28-alpine' } } })).json();
    try {
      await page.goto(`/#/services/${fresh.id}/overview`);
      await expect(metrics.getByText('Not deployed', { exact: true })).toBeVisible();
      await expect(metrics.locator('.service-metric-card')).toHaveCount(0);
    } finally { await page.request.delete(`/api/services/${fresh.id}`); }

    // Controlled browser fixtures exercise rendering/failure states; they are explicitly marked demo.
    let responseKind: 'available' | 'partial' | 'stale' | 'failed' = 'available';
    let requests = 0;
    let sampledAt = '';
    const values = { cpuPercent: 125.4, memoryUsedBytes: 128 * 1024 ** 2, memoryLimitBytes: 512 * 1024 ** 2, networkRxBytes: 12 * 1024 ** 2, networkTxBytes: 3 * 1024 ** 2 };
    await page.route(`**/api/services/${service.id}/metrics`, async route => {
      requests += 1;
      if (responseKind === 'failed') { await route.fulfill({ status: 503, json: { error: 'Controlled metrics refresh failure.' } }); return; }
      sampledAt = new Date(Date.now() - (responseKind === 'stale' ? 90_000 : 0)).toISOString();
      const main = { id: 'main', name: 'application', state: 'running', runtimeStartedAt: new Date(Date.now() - 3_600_000).toISOString(), sampledAt, ...values };
      await route.fulfill({ json: {
        mode: 'demo', serviceId: service.id, state: responseKind === 'partial' ? 'partial' : 'available', sampledAt, checkedAt: new Date().toISOString(),
        totals: responseKind === 'partial' ? { cpuPercent: null, memoryUsedBytes: null, memoryLimitBytes: null, networkRxBytes: null, networkTxBytes: null } : values,
        containers: responseKind === 'partial' ? [main, { ...main, id: 'worker', name: 'worker', state: 'unavailable', sampledAt: null, cpuPercent: null, memoryUsedBytes: null, memoryLimitBytes: null, networkRxBytes: null, networkTxBytes: null }] : [main],
      } });
    });
    await page.goto(`/#/services/${service.id}/overview`);
    await expect(metrics.getByText('Recent sample', { exact: true })).toBeVisible();
    await expect(metrics.getByText('125.4%', { exact: true }).first()).toBeVisible();
    await expect(metrics.getByRole('meter', { name: 'Memory usage' })).toHaveAttribute('aria-valuenow', '25');
    await expect(metrics).toContainText('not transfer rates');
    await expect(metrics.locator('.metrics-timestamps time').first()).toHaveAttribute('datetime', sampledAt);
    await expect(metrics).toContainText('Any displayed sample values are simulated');
    while (await page.getByRole('button', { name: 'Dismiss notification', exact: true }).count()) await page.getByRole('button', { name: 'Dismiss notification', exact: true }).first().click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await metrics.getByRole('heading', { name: 'Service metrics', exact: true }).click();
    await metrics.evaluate(element => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 20, behavior: 'instant' }));
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: 'test-results/r17-metrics-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => { const box = await page.locator('.sidebar').boundingBox(); return Math.round(box ? box.x + box.width : 0); }).toBeLessThanOrEqual(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await metrics.evaluate(element => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 20, behavior: 'instant' }));
    await page.screenshot({ path: 'test-results/r17-metrics-mobile.png' });
    responseKind = 'failed';
    await metrics.getByRole('button', { name: 'Refresh metrics', exact: true }).click();
    await expect(metrics.getByText('Metrics refresh failed', { exact: true })).toBeVisible();
    await expect(metrics.getByText('Stale sample', { exact: true })).toBeVisible();
    await expect(metrics.getByText('125.4%', { exact: true }).first()).toBeVisible();
    await expect(metrics).toHaveAttribute('data-stale', 'true');
    responseKind = 'partial';
    await metrics.getByRole('button', { name: 'Retry metrics', exact: true }).click();
    await expect(metrics.getByText('Partial sample', { exact: true })).toBeVisible();
    await expect(metrics.locator('.service-metric-card').filter({ has: page.getByText('CPU', { exact: true }) })).toContainText('Unavailable');
    await metrics.locator('.metrics-breakdown summary').click();
    await expect(metrics.getByText('worker', { exact: true })).toBeVisible();
    await expect(metrics.getByText('125.4%', { exact: true })).toBeVisible();
    responseKind = 'stale';
    await metrics.getByRole('button', { name: 'Refresh metrics', exact: true }).click();
    await expect(metrics.getByText('Sample is out of date', { exact: true })).toBeVisible();
    await expect(metrics.getByText('Stale sample', { exact: true })).toBeVisible();
    responseKind = 'available';
    await metrics.getByRole('button', { name: 'Refresh metrics', exact: true }).click();
    await expect(metrics).toHaveAttribute('data-stale', 'false');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    const beforeHidden = requests;
    await page.waitForTimeout(10_500);
    expect(requests).toBe(beforeHidden);
    await page.evaluate(() => { delete (document as unknown as Record<string, unknown>).hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(() => requests).toBeGreaterThan(beforeHidden);
    await page.getByRole('link', { name: 'Source', exact: true }).click();
    await expect(metrics).toHaveCount(0);
    const afterUnmount = requests;
    await page.waitForTimeout(10_500);
    expect(requests).toBe(afterUnmount);
  });

  test('inspect listening ports and explicitly save a domain target without trusting EXPOSE or stale data', async ({ page }) => {
    const services = await (await page.request.get('/api/services')).json();
    const service = services.find((item: { name: string }) => item.name === 'acceptance-web');
    const original = await (await page.request.get(`/api/services/${service.id}`)).json();
    let reads = 0;
    page.on('request', request => { if (request.url().endsWith(`/api/services/${service.id}/ports`)) reads += 1; });
    await page.goto(`/#/services/${service.id}/domains`);
    const diagnostic = page.getByRole('region', { name: 'Container port diagnostics', exact: true });
    await expect(diagnostic.getByRole('button', { name: 'Inspect container ports', exact: true })).toBeVisible();
    expect(reads).toBe(0);
    await diagnostic.getByRole('button', { name: 'Inspect container ports', exact: true }).click();
    await expect(diagnostic.getByText('Demo · no live inspection', { exact: true })).toBeVisible();
    await expect(diagnostic.getByText('Unavailable', { exact: true })).toBeVisible();
    await expect(diagnostic.getByRole('button', { name: /^Use TCP port/ })).toHaveCount(0);
    let kind: 'available' | 'partial' | 'stale' | 'failed' | 'exposed' | 'stopped' = 'available';
    await page.route(`**/api/services/${service.id}/ports`, async route => {
      if (kind === 'failed') { await route.fulfill({ status: 503, json: { error: 'Controlled port inspection failure.' } }); return; }
      await route.fulfill({ json: {
        mode: 'demo', serviceId: service.id, state: kind === 'stale' ? 'available' : kind === 'exposed' ? 'unavailable' : kind,
        sampledAt: kind === 'stopped' || kind === 'exposed' ? null : new Date(Date.now() - (kind === 'stale' ? 90_000 : 0)).toISOString(), checkedAt: new Date().toISOString(),
        listeners: kind === 'stopped' || kind === 'exposed' ? [] : [{ port: 3000, protocol: 'tcp', address: '0.0.0.0', family: 'ipv4', scope: 'wildcard' }, { port: 9229, protocol: 'tcp', address: '127.0.0.1', family: 'ipv4', scope: 'loopback' }],
        exposed: [{ port: 80, protocol: 'tcp' }, { port: 53, protocol: 'udp' }],
        message: kind === 'exposed' ? 'Socket inspection unavailable; image declarations only.' : undefined,
      } });
    });
    const refresh = () => diagnostic.getByRole('button', { name: 'Refresh port inspection', exact: true }).click();
    const use3000 = diagnostic.getByRole('button', { name: 'Use TCP port 3000 on 0.0.0.0', exact: true });
    try {
      await refresh();
      await expect(use3000).toBeEnabled();
      await expect(diagnostic.getByRole('button', { name: 'Use TCP port 9229 on 127.0.0.1', exact: true })).toBeDisabled();
      await expect(diagnostic).toContainText('proxy cannot reach a loopback-only listener');
      await expect(diagnostic).toContainText('80/TCP · Declared');
      await expect(diagnostic).toContainText('53/UDP · Declared');
      await expect(diagnostic.getByRole('button', { name: /^Use TCP port 80 / })).toHaveCount(0);
      await expect(diagnostic).toContainText('A TCP listener does not confirm HTTP or HTTPS');
      await page.setViewportSize({ width: 1280, height: 900 });
      await diagnostic.getByRole('heading', { name: 'Container ports', exact: true }).click();
      await diagnostic.evaluate(element => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 20, behavior: 'instant' }));
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: 'test-results/ports-diagnostic-desktop.png' });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(async () => { const box = await page.locator('.sidebar').boundingBox(); return Math.round(box ? box.x + box.width : 0); }).toBeLessThanOrEqual(0);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await diagnostic.evaluate(element => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 20, behavior: 'instant' }));
      await page.screenshot({ path: 'test-results/ports-diagnostic-mobile.png' });
      await use3000.click();
      await expect(page.getByLabel(/^Target port 1/)).toHaveValue('3000');
      expect((await (await page.request.get(`/api/services/${service.id}`)).json()).domains).toEqual(original.domains);
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(page.getByText('Configuration saved. Deploy to apply runtime changes.').first()).toBeVisible();
      await page.reload();
      await expect(page.getByLabel(/^Target port 1/)).toHaveValue('3000');
      const saved = await (await page.request.get(`/api/services/${service.id}`)).json();
      expect(saved.domains[0].port).toBe(3000);
      expect(saved.deployedAt).toBe(original.deployedAt);
      await diagnostic.getByRole('button', { name: 'Inspect container ports', exact: true }).click();
      await expect(use3000).toBeEnabled();
      kind = 'stale'; await refresh();
      await expect(diagnostic.getByText('Refresh before choosing a port', { exact: true })).toBeVisible();
      await expect(use3000).toBeDisabled();
      kind = 'available'; await refresh(); await expect(use3000).toBeEnabled();
      kind = 'failed'; await refresh();
      await expect(diagnostic.getByRole('alert')).toContainText('Controlled port inspection failure');
      await expect(use3000).toBeDisabled();
      await expect(diagnostic.getByText('Previously observed', { exact: true }).first()).toBeVisible();
      kind = 'exposed'; await refresh();
      await expect(diagnostic).toContainText('Socket inspection unavailable');
      await expect(diagnostic.getByRole('button', { name: /^Use TCP port/ })).toHaveCount(0);
      kind = 'stopped'; await refresh();
      await expect(diagnostic.getByText('Service stopped', { exact: true })).toBeVisible();
      kind = 'partial'; await refresh();
      await expect(diagnostic.getByText('Partial inspection', { exact: true })).toBeVisible();
      await expect(use3000).toBeEnabled();
      await page.route(`**/api/services/${service.id}`, route => route.fulfill({ json: { ...saved, containerId: 'controlled-new-runtime-id' } }));
      await expect(diagnostic.getByText('Inspect the current runtime', { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(use3000).toBeDisabled();
    } finally {
      await page.request.patch(`/api/services/${service.id}`, { data: { domains: original.domains } });
    }
  });

  test('Use SSH key saves an explicit draft, uses automatic GitHub trust, and preserves manual overrides', async ({ page }) => {
    const projects = await (await page.request.get('/api/projects')).json();
    const repository = 'https://github.com/octocat/Hello-World.git';
    const created = await page.request.post('/api/services', { data: { projectId: projects[0].id, name: 'github-ssh-switch', kind: 'app', source: { type: 'git', repository, branch: 'main', context: '.', dockerfile: 'Dockerfile' } } });
    expect(created.status()).toBe(201);
    const service = await created.json();
    try {
      expect((await page.request.put(`/api/services/${service.id}/source-credentials/git`, { data: { username: 'git', token: `fixture-token-${randomUUID()}` } })).ok()).toBeTruthy();
      await page.goto(`/#/services/${service.id}/source`);
      const repositoryField = page.getByLabel(/^Repository URL/);
      const guide = page.getByLabel('Git authentication options');
      const useSsh = guide.getByRole('button', { name: 'Use SSH key', exact: true });
      await expect(useSsh).toBeVisible();
      for (const other of ['https://gitlab.com/org/repo.git', 'https://github.com.evil.example/org/repo.git', 'https://github.com/org/repo/tree/main', 'https://user@github.com/org/repo.git', 'https://github.com/org/repo.git?ref=main']) {
        await repositoryField.fill(other);
        await expect(useSsh).toHaveCount(0);
      }
      await repositoryField.fill(repository);
      await expect(useSsh).toBeVisible();
      await page.setViewportSize({ width: 1280, height: 900 });
      await guide.getByText('SSH · deploy key', { exact: true }).click();
      await guide.evaluate(element => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 20, behavior: 'instant' }));
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: 'test-results/ssh-use-key-desktop.png' });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(async () => { const box = await page.locator('.sidebar').boundingBox(); return Math.round(box ? box.x + box.width : 0); }).toBeLessThanOrEqual(0);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await guide.evaluate(element => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 20, behavior: 'instant' }));
      await page.screenshot({ path: 'test-results/ssh-use-key-mobile.png' });
      let writes = 0;
      page.on('request', request => { if (request.method() === 'PATCH' && request.url().endsWith(`/api/services/${service.id}`)) writes += 1; });
      await useSsh.click();
      await expect(repositoryField).toHaveValue('git@github.com:octocat/Hello-World.git');
      await expect(page.getByLabel('Branch', { exact: true })).toHaveValue('main');
      await expect(page.getByText('SSH URL prepared — save to continue', { exact: true })).toBeVisible();
      expect(writes).toBe(0);
      expect((await (await page.request.get(`/api/services/${service.id}`)).json()).source.repository).toBe(repository);
      expect((await (await page.request.get(`/api/services/${service.id}/source-credentials`)).json()).git.configured).toBe(true);
      await expect(page.getByRole('button', { name: 'Generate SSH deploy key', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      const generate = page.getByRole('button', { name: 'Generate SSH deploy key', exact: true });
      await expect(generate).toBeVisible();
      expect(writes).toBe(1);
      const metadata = await (await page.request.get(`/api/services/${service.id}/source-credentials`)).json();
      expect(metadata.git.configured).toBe(false);
      expect(metadata.ssh.configured).toBe(false);
      while (await page.getByRole('button', { name: 'Dismiss notification', exact: true }).count()) await page.getByRole('button', { name: 'Dismiss notification', exact: true }).first().click();
      await generate.scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'test-results/ssh-generate-mobile.png' });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.locator('.ssh-credentials').getByRole('heading', { name: 'SSH deploy key', exact: true }).click();
      await page.locator('.ssh-credentials').evaluate(element => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 20, behavior: 'instant' }));
      await page.screenshot({ path: 'test-results/ssh-generate-desktop.png' });
      let hostWrites = 0;
      page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/source-credentials/ssh/host-key')) hostWrites += 1; });
      await generate.click();
      const publicKey = page.getByLabel(/^Public deploy key/);
      await expect(publicKey).toHaveValue(/^ssh-ed25519 /);
      const panel = page.locator('.ssh-credentials');
      const automatic = panel.getByRole('region', { name: 'GitHub server identity', exact: true });
      await expect(automatic.getByRole('heading', { name: 'GitHub server verification is automatic', exact: true })).toBeVisible();
      await expect(panel.getByRole('heading', { name: 'Verify the Git server', exact: true })).toHaveCount(0);
      await expect(panel.getByRole('button', { name: 'Trust GitHub host key', exact: true })).toHaveCount(0);
      await expect(panel.getByLabel('I verified these server keys against a trusted provider or administrator.', { exact: true })).not.toBeVisible();
      const credentialStatus = async () => (await (await page.request.get(`/api/services/${service.id}/source-credentials`)).json()).ssh;
      const automaticStatus = await credentialStatus();
      expect(automaticStatus.hostKeyConfigured).toBe(true);
      expect(automaticStatus.hostKeySource).toBe('github-published');
      expect(automaticStatus.knownHosts.trim()).toBe('github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl');
      expect(automaticStatus.hostFingerprints).toEqual(['SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU']);
      expect(automaticStatus.hostKeyUpdatedAt).toBeUndefined();
      expect(hostWrites).toBe(0);
      while (await page.getByRole('button', { name: 'Dismiss notification', exact: true }).count()) await page.getByRole('button', { name: 'Dismiss notification', exact: true }).first().click();
      await automatic.getByRole('heading').click();
      await automatic.evaluate(element => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 20, behavior: 'instant' }));
      await page.screenshot({ path: 'test-results/ssh-github-auto-desktop.png' });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(async () => { const box = await page.locator('.sidebar').boundingBox(); return Math.round(box ? box.x + box.width : 0); }).toBeLessThanOrEqual(0);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await automatic.evaluate(element => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 20, behavior: 'instant' }));
      await page.screenshot({ path: 'test-results/ssh-github-auto-mobile.png' });
      await automatic.locator('summary').click();
      await expect(automatic).toContainText(automaticStatus.hostFingerprints[0]);
      await page.reload();
      await expect(automatic).toBeVisible();
      expect(hostWrites).toBe(0);
      // A deliberately different cryptographic fixture tests preservation, not GitHub network trust.
      const manualKey = `github.com ${(await publicKey.inputValue()).split(' ').slice(0, 2).join(' ')}`;
      const override = await page.request.put(`/api/services/${service.id}/source-credentials/ssh/host-key`, { data: { knownHosts: manualKey } });
      expect(override.ok()).toBeTruthy();
      await page.reload();
      await expect(panel.getByText('Custom GitHub server keys are pinned', { exact: true })).toBeVisible();
      await expect(automatic).toHaveCount(0);
      expect((await credentialStatus()).hostKeySource).toBe('manual');
      expect((await credentialStatus()).knownHosts.trim()).toBe(manualKey);
      expect(hostWrites).toBe(0);
      await page.setViewportSize({ width: 1280, height: 900 });
      // Non-default ports and lookalike hosts must keep the explicit trust workflow.
      for (const sshRepository of ['ssh://git@github.com:2222/octocat/Hello-World.git', 'git@github.com.evil.example:octocat/Hello-World.git']) {
        await repositoryField.fill(sshRepository);
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await expect(generate).toBeVisible();
        await expect(automatic).toHaveCount(0);
        await generate.click();
        await expect(publicKey).toHaveValue(/^ssh-ed25519 /);
        await expect(panel.getByText('Next: verify the Git server', { exact: true })).toBeVisible();
        expect((await credentialStatus()).hostKeyConfigured).toBe(false);
        expect((await credentialStatus()).hostKeySource).toBeUndefined();
      }
    } finally { await page.request.delete(`/api/services/${service.id}`); }
  });

});

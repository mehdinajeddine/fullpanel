import { test, expect } from '@playwright/test';

const credentials = { name: 'Harborlight QA', email: 'qa@example.test', password: 'Local-test-password-3472!' };
test.describe.serial('Owner workflows', () => {
  test('first owner, authentication, and honest demo dashboard', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Your name').fill(credentials.name);
    await page.getByLabel('Email address').fill(credentials.email);
    await page.getByLabel(/^Password/).fill(credentials.password);
    await page.getByRole('button', { name: /Create.*workspace|Create.*account|Get started/ }).click();
    await expect(page.getByRole('heading', { name: 'A little clarity. A lot of possibility.' })).toBeVisible();
    await expect(page.locator('.demo-banner')).toContainText('simulated');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'A little clarity. A lot of possibility.' })).toBeVisible();
    await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
  });

  test.beforeEach(async ({ page }, testInfo) => {
    if (testInfo.title.startsWith('first owner')) return;
    const response = await page.request.post('/api/auth/login', { data: { email: credentials.email, password: credentials.password } });
    expect(response.ok()).toBeTruthy();
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
    await expect(page.getByRole('heading', { name: 'A little clarity. A lot of possibility.' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
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
});

import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dataDir = join(tmpdir(), `harborlight-e2e-${randomUUID()}`);
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  metadata: { dataDir },
  use: {
    baseURL: 'http://127.0.0.1:3011',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}),
  },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:3011/api/health',
    env: { HARBORLIGHT_MODE: 'demo', DATA_DIR: dataDir, PORT: '3011', HOST: '127.0.0.1', COOKIE_SECURE: 'false', PUBLIC_URL: '' },
    reuseExistingServer: false,
    timeout: 60000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 },
  },
});

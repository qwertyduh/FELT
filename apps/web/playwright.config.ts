import { defineConfig, devices } from '@playwright/test';

// E2E runs against the real local stack: Supabase (`supabase start`), the game server (3001) and
// the web app (5173). Two ways to run it:
// - `npm run e2e:sandbox`: the Docker-built server (`npm run sandbox:up` first). No server is
//   started here, so a missing sandbox fails instead of being replaced by a dev server.
// - `npm run e2e`: a dev server and the dev Redis (`docker compose up -d redis`; set REDIS_PORT
//   if it is not on 6379). A server already on 3001 is reused.
// Run `npm run env:local -w apps/server` and `-w apps/web` once beforehand. Open the app at
// localhost (not 127.0.0.1) so it matches the server's CORS origin.
const WEB_URL = 'http://localhost:5173';
const SANDBOX = process.env.E2E_SANDBOX === '1';
// Specs that read a stored room look in this Redis container.
if (SANDBOX) process.env.REDIS_CONTAINER ??= 'felt-sandbox-redis-1';

const devServer = {
  command: 'npm run dev -w apps/server',
  cwd: '../..',
  url: 'http://localhost:3001/health',
  env: {
    PORT: '3001',
    REDIS_URL: `redis://localhost:${process.env.REDIS_PORT ?? '6379'}`,
    WEB_ORIGIN: WEB_URL,
  },
  reuseExistingServer: true,
  timeout: 60_000,
};

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: WEB_URL,
    viewport: { width: 375, height: 812 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } },
    },
  ],
  webServer: [
    ...(SANDBOX ? [] : [devServer]),
    {
      command: 'npm run dev -w apps/web',
      cwd: '../..',
      url: WEB_URL,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});

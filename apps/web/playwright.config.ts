import { defineConfig, devices } from '@playwright/test';

// E2E runs against the real local stack: Supabase (`supabase start`), Redis
// (`REDIS_PORT=6380 docker compose up -d redis`), the server (3001) and the web app (5173).
// Run `npm run env:local -w apps/server` and `-w apps/web` once beforehand. Open the app at
// localhost (not 127.0.0.1) so it matches the server's CORS origin.
const WEB_URL = 'http://localhost:5173';

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
    {
      command: 'npm run dev -w apps/server',
      cwd: '../..',
      url: 'http://localhost:3001/health',
      env: {
        PORT: '3001',
        REDIS_URL: 'redis://localhost:6380',
        WEB_ORIGIN: WEB_URL,
      },
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'npm run dev -w apps/web',
      cwd: '../..',
      url: WEB_URL,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});

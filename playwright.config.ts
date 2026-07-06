import { defineConfig, devices } from '@playwright/test';

// PW_PORT lets multiple agent worktrees each run the suite on their own port
// instead of racing on the shared default (each build+start is a full,
// independent server - two of them sharing one port corrupts both runs).
// CI and any local run that doesn't set the env var keep the original 3300
// unchanged.
const PORT = Number(process.env.PW_PORT ?? 3300);

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? undefined : 4,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'webkit-mobile', use: { ...devices['iPhone 13'] } },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] } },
  ],
  // Dedicated port so a dev server on :3000/:3200 never shadows the build under test.
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});

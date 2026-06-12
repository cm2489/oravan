import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:3300',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'webkit-mobile', use: { ...devices['iPhone 13'] } },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] } },
  ],
  // Dedicated port so a dev server on :3000/:3200 never shadows the build under test.
  webServer: {
    command: 'npm run build && npx next start -p 3300',
    port: 3300,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});

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
    // WCAG 1.4.10 reflow is specified AT 320px and neither project above
    // runs there — a reflow bug shipped once because of exactly that gap
    // (see tests/landing.spec.ts). This project runs the @reflow-tagged
    // subset at the criterion's own width (owner decision, 2026-08-02,
    // prelaunch teardown Phase 0). Tag a test @reflow when its assertions
    // are meaningful at 320 (overflow, touch targets, keyboard reach) —
    // not every spec belongs here; the tag is the budget.
    {
      name: 'webkit-320',
      grep: /@reflow/,
      use: { ...devices['iPhone 13'], viewport: { width: 320, height: 844 } },
    },
  ],
  // Dedicated port so a dev server on :3000/:3200 never shadows the build under test.
  //
  // S19: the command is tests/e2e-server.mjs, not a direct `next build &&
  // next start` — it stands up a tiny fake Upstash REST server for the
  // TENANCY database only (seeding tests/fixtures/e2e-tenant.ts's one
  // fixture tenant), sets UPSTASH_TENANCY_REST_URL/TOKEN, then execs the
  // exact same `next build && next start` as its own child. See that
  // file's header comment for why (Playwright starts webServer BEFORE any
  // globalSetup hook runs, so globalSetup can't inject env the server
  // would see). Counters/cache stay unconfigured — nothing about any
  // pre-S19 test's behavior changes.
  webServer: {
    command: `npx tsx tests/e2e-server.mjs`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});

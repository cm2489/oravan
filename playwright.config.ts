import { defineConfig, devices } from '@playwright/test';

// PW_PORT lets multiple agent worktrees each run the suite on their own port
// instead of racing on the shared default (each build+start is a full,
// independent server - two of them sharing one port corrupts both runs).
// CI and any local run that doesn't set the env var keep the original 3300
// unchanged.
const PORT = Number(process.env.PW_PORT ?? 3300);

const UNIT_SPEC = /\.unit\.spec\.ts$/;

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
  // The *.unit.spec.ts files are pure Node: none takes a browser fixture or
  // talks to the server, so running them under each browser project only ran
  // the same code twice. They run once, in the `unit` project below, which
  // needs no server (ci.yml's unit job sets PW_NO_WEBSERVER); the browser
  // projects ignore them. tests/ci-shards.unit.spec.ts pins this split.
  projects: [
    { name: 'webkit-mobile', testIgnore: UNIT_SPEC, use: { ...devices['iPhone 13'] } },
    { name: 'webkit-desktop', testIgnore: UNIT_SPEC, use: { ...devices['Desktop Safari'] } },
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
      testIgnore: UNIT_SPEC,
      use: { ...devices['iPhone 13'], viewport: { width: 320, height: 844 } },
    },
    { name: 'unit', testMatch: UNIT_SPEC },
  ],
  // PW_NO_WEBSERVER=1 skips standing the server up at all. It exists for two
  // callers in ci.yml. One is the docs-only fast path, which runs
  // tests/claim-truth.spec.ts (pure Node — it reads the four constitution
  // documents and shells out to a check script; it never touches `page`) on
  // PRs that skip the build. The other is the unit job, which runs the
  // `unit` project. Without it each would drag a full `next build && next
  // start` behind it for specs that never talk to the server.
  //
  // Not a footgun: setting it for a run that DOES need the server makes every
  // page test fail on connection-refused, loudly and immediately. There is no
  // wording of this variable that produces a false green.
  //
  // Dedicated port so a dev server on :3000/:3200 never shadows the build under test.
  //
  // S19: the command is tests/e2e-server.mjs, not a direct `next build &&
  // next start` — it stands up a tiny fake Upstash REST server for the
  // TENANCY database only (seeding tests/fixtures/e2e-tenant.ts's one
  // fixture tenant), sets UPSTASH_TENANCY_REST_URL/TOKEN, then execs the
  // exact same `next build && next start` as its own child (or, with
  // E2E_SERVER_MODE, only one half of it: ci.yml builds once and every
  // E2E shard starts that same build). See that
  // file's header comment for why (Playwright starts webServer BEFORE any
  // globalSetup hook runs, so globalSetup can't inject env the server
  // would see). Counters/cache stay unconfigured — nothing about any
  // pre-S19 test's behavior changes.
  webServer: process.env.PW_NO_WEBSERVER
    ? undefined
    : {
        command: `npx tsx tests/e2e-server.mjs`,
        port: PORT,
        reuseExistingServer: false,
        // Build+start counts against this: CI was ready in ~223 s at 3d30669, then passed 240 s at 25c68e4 (run 36507348144).
        timeout: 480_000,
      },
});

/**
 * Owner-only tenant admin CLI (S21, embeds spec §6: "admin CLI
 * (list/rotate/revoke tenants) ... admin ≈ 2–3 days as CLI only — kept small
 * precisely by refusing dashboards and passwords").
 *
 *   npx tsx scripts/tenant-admin.mjs <command> [args] [--yes]
 *
 * Commands:
 *   list                                            enumerate all tenants
 *   inspect <tenantId>                               full record + last 3 months' impressions
 *   rotate <tenantId> --yes                          mint a new capability token (shown once)
 *   revoke <tenantId> --yes                          cancel a tenant's subscription now
 *   set-attribution <tenantId> <required|none> --yes writes the honor-system entitlement field
 *   impressions <tenantId> [--months N]              full-window impression pull (default 13)
 *
 * MUST be run through `tsx`, not plain `node` — same reason as scripts/
 * pregen-scripts.mjs: lib/tenant-admin.ts imports lib/tenancy.ts,
 * lib/impressions.ts, and lib/upstash.ts unchanged (reuse, never a second
 * implementation of the token/list/revoke primitives), and Node's native TS
 * type-stripping doesn't resolve their extensionless relative imports —
 * only tsx's esbuild-based resolver does. This file is a thin shim, same
 * split as scripts/pregen-scripts.mjs (script) / lib/pregen-runner.ts
 * (logic): all argument handling and every printed string live in
 * lib/tenant-admin.ts, which is what tests/tenant-admin.unit.spec.ts
 * imports directly.
 *
 * Requires UPSTASH_TENANCY_REST_URL/TOKEN (all commands) and
 * UPSTASH_COUNTERS_REST_URL/TOKEN (inspect/impressions) in THIS PROCESS'S
 * OWN env — refuses loudly (nonzero exit, no silent degrade) if unset. This
 * is an interactive owner tool, not a request-serving route: unlike every
 * route in this repo (which degrades gracefully when Upstash is
 * unconfigured), silence here would just waste the owner's time.
 *
 * FOOTGUN, read before running against a real keyspace: keyPrefix()
 * (lib/upstash.ts) resolves to `VERCEL_ENV ?? 'dev'`. Run from a laptop
 * shell (not `vercel env pull`'d), VERCEL_ENV is unset, so this CLI
 * silently operates on the DEV keyspace unless you `export
 * VERCEL_ENV=production` first. Every invocation prints "Operating on
 * keyspace: <prefix>" before doing anything — read it before confirming a
 * mutating command with --yes.
 */
import { main } from '../lib/tenant-admin';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error('::error::tenant-admin crashed:', err);
    process.exit(1);
  }
);

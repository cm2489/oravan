/**
 * Nightly pre-generation of top-band call scripts (S21, F7).
 *
 *   npx tsx scripts/pregen-scripts.mjs [--dry-run]
 *
 * MUST be run through `tsx`, not plain `node`: the orchestration logic
 * (lib/pregen-runner.ts) imports the real lib/scriptcache.ts,
 * lib/core/bills.ts, and lib/scriptprompt.ts modules unchanged — exactly as
 * instructed ("reuse, never a second implementation") — but Node's native
 * TS type-stripping does not resolve their extensionless relative imports
 * (only a bundler or tsx's esbuild-based resolver does; verified directly:
 * plain `node --experimental-strip-types` throws ERR_MODULE_NOT_FOUND on
 * lib/scriptcache.ts's own `from './upstash'`). `tsx` is a new devDependency
 * added for exactly this one purpose. This file is intentionally a thin
 * shim — same split as scripts/verify-salt.mjs (script) / lib/salt.mjs
 * (logic) — so Playwright's unit tests can import the real logic directly
 * without going through a `.mjs` entrypoint Playwright's own loader
 * doesn't transform.
 *
 * F7 posture (build-time secret / direct Upstash write, never a public
 * flag): this script writes directly into the CACHE database via
 * UPSTASH_CACHE_REST_URL/TOKEN — build-time secrets in this process's own
 * env, never request-supplied — using the SAME lib/scriptcache.ts the live
 * route uses. It never calls /api/script and sends no marker of any kind
 * over the network; app/api/script/route.ts stays completely unaware
 * pregen exists (grep-enforced: tests/pregen-route-posture.unit.spec.ts).
 *
 * Top N bills (default 10, §9.1(d) — the SAME getTopActions "Act now"
 * shortlist the site itself renders) x 3 stances x 2 locales = up to 60
 * combos/night. Already-cached combos (matched by the exact
 * lib/scriptcache.ts key, content-version hash included) are skipped:
 * resume-safe and idempotent — a partial or repeated run never re-spends,
 * and a re-decoded bill's changed version hash invalidates naturally
 * instead of silently serving stale copy.
 *
 * Generation goes through the Anthropic Message Batches API (50% off,
 * `anthropic.messages.batches.*`). Flag on the brief this PR is built
 * against: despite this sprint's brief AND the strategy doc (§9.1(d))
 * both saying pregen reuses "the same async pattern already used by
 * backfill-search-inputs.mjs" — that script does NOT call the batch API;
 * it's a plain sequential loop of `messages.create` per bill (verified by
 * reading it). This is the repo's first real Batch API usage, built fresh
 * from Anthropic's documented Message Batches API, not a reuse of an
 * existing pattern. See the PR description's Deviations section.
 *
 * Batches can take up to 24h to finish; this script polls with a bounded
 * wait (PREGEN_BATCH_MAX_WAIT_MS, default 20 min — batches this small in
 * practice finish in minutes) and exits without writing anything if the
 * batch isn't done in time — never a hard failure of the nightly workflow.
 * It does not persist the batch ID across runs: a timeout on one night
 * just leaves those combos uncached (harmless — /api/script generates them
 * on demand as always, unchanged), and the next night's run submits a
 * fresh batch for whatever is still missing. Cross-run "resume the same
 * in-flight batch" was considered and deliberately cut from this first
 * slice for scope; see the PR description.
 *
 * Env:
 *   PREGEN_TOP_N               bills to pregen (default 10)
 *   PREGEN_BATCH_MAX_WAIT_MS   bounded poll wait, ms (default 1_200_000 = 20 min)
 *   UPSTASH_CACHE_REST_URL / _TOKEN   build-time secrets (F7) — via lib/scriptcache.ts
 *   ANTHROPIC_API_KEY
 */
import { main } from '../lib/pregen-runner';

main().catch((err) => {
  console.error('::error::pregen crashed:', err);
  process.exit(1);
});

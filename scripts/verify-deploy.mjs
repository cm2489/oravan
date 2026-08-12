/**
 * Post-deploy verification. The Vercel deploy hook fires blind: PR #18 proved
 * a deploy can be silently dropped with every dashboard green (bot-authored
 * pushes were BLOCKED for the repo's entire life — see
 * docs/solutions/vercel-bot-push-blocked-deploys.md). So after the hook
 * fires, poll production until the page reports the commit SHA we just
 * pushed, baked in at build time as <meta name="oravan-build">.
 *
 * Env:
 *   PROD_URL    production origin (e.g. https://oravan.example). REQUIRED —
 *               missing is a hard failure, exactly like EXPECT_SHA below.
 *   EXPECT_SHA  the commit SHA the deploy must be built from.
 *
 * WHY PROD_URL IS NO LONGER A SOFT SKIP (2026-08-12). It used to print a
 * ::notice and exit 0, so the four nightly workflows that call this script
 * (sync-bills, hot-bills, newsdesk, refresh-legislators) could be wired up
 * before the repository variable existed. The variable has been set since
 * 2026-07-11 and every run since has actually polled production, so the skip
 * branch no longer buys anything — the only state it can still reach is the
 * one where somebody deletes the variable and all four dead-man's switches go
 * quiet at once, each night printing a green check and a log line nobody
 * reads. That is the same silent-green failure this script was written to
 * catch (PR #18: a deploy dropped with every dashboard green), reproduced one
 * level up in the check itself. A missing PROD_URL is now a red run: the
 * pipeline says out loud that it can no longer see production, and the data
 * commit above it has already landed either way.
 *
 * Stdlib only — runs on a bare Actions runner without npm ci.
 */
const PROD_URL = process.env.PROD_URL;
const EXPECT_SHA = process.env.EXPECT_SHA;

if (!PROD_URL) {
  console.error(
    '::error::PROD_URL is missing — cannot verify the deploy, so this run cannot tell a landed deploy from a dropped one. Set the PROD_URL repository variable (Settings > Secrets and variables > Actions > Variables); if it was set and this still fires, it was deleted or the workflow step stopped passing it.'
  );
  process.exit(1);
}
if (!EXPECT_SHA) {
  console.error('::error::EXPECT_SHA is missing — cannot verify the deploy');
  process.exit(1);
}

const TIMEOUT_MS = 12 * 60 * 1000; // Vercel builds of this site take a few minutes
const INTERVAL_MS = 20_000;
const deadline = Date.now() + TIMEOUT_MS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildIdOf(html) {
  const m =
    html.match(/<meta[^>]*name="oravan-build"[^>]*content="([^"]*)"/) ??
    html.match(/<meta[^>]*content="([^"]*)"[^>]*name="oravan-build"/);
  return m ? m[1] : null;
}

let lastSeen = null;
while (Date.now() < deadline) {
  try {
    const res = await fetch(PROD_URL, {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      lastSeen = buildIdOf(await res.text());
      if (lastSeen === EXPECT_SHA) {
        console.log(`production is serving build ${EXPECT_SHA} — deploy verified`);
        process.exit(0);
      }
      console.log(`production build is ${lastSeen ?? 'unknown'}, waiting for ${EXPECT_SHA}…`);
    } else {
      console.log(`production returned ${res.status}, retrying…`);
    }
  } catch (e) {
    console.log(`fetch failed (${e.message}), retrying…`);
  }
  await sleep(INTERVAL_MS);
}

console.error(
  `::error::Deploy verification timed out after ${TIMEOUT_MS / 60000} min: production still serves build ${lastSeen ?? 'unknown'}, expected ${EXPECT_SHA}. The deploy hook fired but the deploy never landed — check the Vercel dashboard.`
);
process.exit(1);

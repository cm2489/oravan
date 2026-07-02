/**
 * Post-deploy verification. The Vercel deploy hook fires blind: PR #18 proved
 * a deploy can be silently dropped with every dashboard green (bot-authored
 * pushes were BLOCKED for the repo's entire life — see
 * docs/solutions/vercel-bot-push-blocked-deploys.md). So after the hook
 * fires, poll production until the page reports the commit SHA we just
 * pushed, baked in at build time as <meta name="rostra-build">.
 *
 * Env:
 *   PROD_URL    production origin (e.g. https://rostra.example). Unset =
 *               skip with a notice, so the pipeline works before it's wired.
 *   EXPECT_SHA  the commit SHA the deploy must be built from.
 *
 * Stdlib only — runs on a bare Actions runner without npm ci.
 */
const PROD_URL = process.env.PROD_URL;
const EXPECT_SHA = process.env.EXPECT_SHA;

if (!PROD_URL) {
  console.log(
    '::notice::PROD_URL is not configured — skipping post-deploy verification. Set a PROD_URL repository variable (Settings > Secrets and variables > Actions > Variables) to enable it.'
  );
  process.exit(0);
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
    html.match(/<meta[^>]*name="rostra-build"[^>]*content="([^"]*)"/) ??
    html.match(/<meta[^>]*content="([^"]*)"[^>]*name="rostra-build"/);
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

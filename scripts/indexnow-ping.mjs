/**
 * TELL INDEXNOW WHICH PUBLIC PAGES A DATA COMMIT CHANGED — best-effort only.
 *
 *   node scripts/indexnow-ping.mjs                 # HEAD against its parent
 *   node scripts/indexnow-ping.mjs --head <sha>    # <sha> against <sha>^
 *   node scripts/indexnow-ping.mjs --dry-run       # derive and print; never POST
 *
 * The 2026-09-27 audit (SY-19): the site is verified in Bing Webmaster Tools
 * and its sitemaps are submitted, and it is indexed but not ranking. The
 * sitemap tells an engine where pages are; nothing tells it WHEN a page's
 * record moved. IndexNow does: one POST listing the URLs that changed, which
 * the shared endpoint passes to every participating engine.
 *
 * WHERE IT RUNS. A step in sync-bills.yml (nightly) and hot-bills.yml
 * (twice daily), directly after "Verify the deploy landed", passing the SHA
 * the commit step pushed. The URLs are derived from that commit's own diff
 * of data/ (scripts/indexnow-urls.mjs has the file-to-page mapping).
 *
 * The hourly newsdesk.yml is deliberately NOT wired. The protocol's FAQ
 * (indexnow.org/faq) asks senders to "avoid submitting the same URL many
 * times a day unless there are meaningful content changes", and an hourly
 * commit would re-submit the homepage, /bills and /today many times a day.
 * The cost, stated plainly: a change that ONLY a newsdesk commit makes - a
 * floor announcement (data/floor-signals.json), the conversation lamp
 * (data/conversation.json), an intraday roll call or live update - is never
 * pinged, because each ping reads only its own commit's diff. Those pages
 * stay in sitemap.xml, and a bill whose status the nightly later moves is
 * pinged then. Wiring newsdesk.yml is one more copy of this step.
 *
 * DEPLOYMENT LAG: WAIT, DON'T GUESS. A ping can prompt a crawl soon after it
 * lands (a hint, not a guarantee - the engine decides); pinging before Vercel
 * serves the new build could point that crawl at the OLD page and spend the
 * signal. So the step runs only after
 * scripts/verify-deploy.mjs has seen production serve this exact SHA (its
 * 12-minute poll is the wait). If that check fails or times out, the step is
 * skipped and nothing is pinged for that commit — the pages stay in
 * sitemap.xml, and their next change pings them. No fixed sleep anywhere.
 *
 * IT CAN NEVER FAIL THE RUN. Every path exits 0: an unresolvable commit, a
 * missing file, a network error, a 4xx/5xx from the endpoint. Problems print
 * a ::warning:: annotation and the run carries on. The workflow step is also
 * continue-on-error with a short timeout, belt and braces.
 *
 * IT POSTS ONLY FROM GITHUB ACTIONS ON MAIN. Anywhere else — a laptop, a
 * branch validation run, CI's own test run of this file — it derives the
 * list, prints it, and stops (shouldPost below; pinned by the unit test).
 *
 * NO USER DATA. The body is the host, the public key, the key file's URL,
 * and public page URLs derived from committed public data. There is no
 * visitor anywhere in this pipeline to send anything about. $0: IndexNow is
 * free and needs no account; the key is public by design (see
 * scripts/indexnow-urls.mjs's header).
 *
 * Stdlib only — hot-bills.yml runs on a bare runner with no `npm ci`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DATA_FILES,
  INDEXNOW_ENDPOINT,
  buildPayload,
  deriveChangedPaths,
  localizedUrls,
  siteOriginFromSource,
} from './indexnow-urls.mjs';

const POST_TIMEOUT_MS = 30_000;
/** How many paths to print in the log — the full list goes to the engine. */
const LOG_PATHS = 25;

/**
 * The one gate between "derive the list" and "send it". True only inside
 * GitHub Actions, on refs/heads/main, without --dry-run.
 */
export function shouldPost(env, argv) {
  return env.GITHUB_ACTIONS === 'true' && env.GITHUB_REF === 'refs/heads/main' && !argv.includes('--dry-run');
}

/**
 * What an IndexNow status means, from the protocol's own documentation
 * (indexnow.org/documentation). `ok` only for 200 and 202; nothing here throws.
 */
export function describeResponse(status) {
  switch (status) {
    case 200:
      return { ok: true, message: 'OK - the URL list was accepted.' };
    case 202:
      return { ok: true, message: 'Accepted - the key file is still being validated; the list was received.' };
    case 400:
      return { ok: false, message: 'Bad request - the body was not a valid IndexNow submission.' };
    case 403:
      return { ok: false, message: 'Forbidden - the key was not found at keyLocation, or the file does not hold it. Is public/<key>.txt deployed?' };
    case 422:
      return { ok: false, message: 'Unprocessable - a URL is not on the host, or the key does not match the protocol schema.' };
    case 429:
      return { ok: false, message: 'Too many requests - the endpoint read this as potential spam (too many submissions).' };
    default:
      return { ok: false, message: `Unexpected status ${status}.` };
  }
}

/** `--head <sha>` from argv, else INDEXNOW_HEAD_SHA, else HEAD. */
export function headRef(argv, env) {
  const at = argv.indexOf('--head');
  const fromArg = at >= 0 ? argv[at + 1] : undefined;
  return fromArg || env.INDEXNOW_HEAD_SHA || 'HEAD';
}

const warn = (msg) => console.log(`::warning::indexnow: ${msg}`);

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolvesToCommit(ref) {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

const UNREADABLE = Symbol('unreadable');

/** Each DATA_FILES entry at `ref`: parsed JSON, null when absent, UNREADABLE when it will not parse. */
function readDataAt(ref) {
  const out = {};
  for (const f of DATA_FILES) {
    let text;
    try {
      text = git(['show', `${ref}:data/${f}`]);
    } catch {
      out[f] = null; // not in this commit's tree
      continue;
    }
    try {
      out[f] = JSON.parse(text);
    } catch {
      out[f] = UNREADABLE;
    }
  }
  return out;
}

async function main(argv, env) {
  const head = headRef(argv, env);
  const base = `${head}^`;
  if (!resolvesToCommit(head) || !resolvesToCommit(base)) {
    warn(`cannot resolve ${head} and its parent in this checkout - nothing derived, nothing sent.`);
    return;
  }

  let origin = null;
  try {
    origin = siteOriginFromSource(readFileSync(join(process.cwd(), 'lib/site.ts'), 'utf8'));
  } catch {
    origin = null;
  }
  if (!origin) {
    warn('could not read SITE_ORIGIN from lib/site.ts - nothing sent.');
    return;
  }

  const before = readDataAt(base);
  const after = readDataAt(head);
  // A file that will not parse on either side contributes nothing, rather
  // than reading as "every record added" or "every record removed".
  for (const f of DATA_FILES) {
    if (before[f] === UNREADABLE || after[f] === UNREADABLE) {
      warn(`data/${f} did not parse at one side of the diff - skipped.`);
      before[f] = null;
      after[f] = null;
    }
  }

  const paths = deriveChangedPaths(before, after);
  if (paths.length === 0) {
    console.log(`indexnow: no public page changed between ${base} and ${head} - nothing to send.`);
    return;
  }
  const { urls, dropped } = localizedUrls(origin, paths);
  if (dropped > 0) warn(`${dropped} URL(s) over the per-request cap were left out (lowest priority first).`);

  console.log(`indexnow: ${paths.length} changed page(s), ${urls.length} URL(s) across both locales.`);
  for (const p of paths.slice(0, LOG_PATHS)) console.log(`  ${p}`);
  if (paths.length > LOG_PATHS) console.log(`  ... and ${paths.length - LOG_PATHS} more`);

  if (!shouldPost(env, argv)) {
    console.log('indexnow: not sending - this only posts from GitHub Actions on refs/heads/main, without --dry-run.');
    return;
  }

  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(buildPayload(origin, urls)),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    const d = describeResponse(res.status);
    if (d.ok) console.log(`indexnow: ${res.status} ${d.message}`);
    else warn(`${res.status} ${d.message}`);
  } catch (e) {
    warn(`the POST did not complete (${String(e?.message ?? e).split('\n')[0]}) - nothing retried; the next change pings again.`);
  }
}

// Importable for the unit test without deriving or sending anything.
if (process.argv[1] && process.argv[1].endsWith('indexnow-ping.mjs')) {
  main(process.argv.slice(2), process.env)
    .catch((e) => warn(`unexpected error (${String(e?.message ?? e).split('\n')[0]}) - nothing sent.`))
    .finally(() => process.exit(0));
}

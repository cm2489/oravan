/*
 * Redistricting Data Hub monitoring step (S24, §9.1(f) item 3) - runs weekly
 * from refresh-legislators.yml alongside the roster/vacancy refresh. See
 * lib/redistricting-watch.mjs for why this polls RDH's state-sitemap.xml
 * lastmod per tracked state (no RSS/JSON/API exists on RDH's "What's New"
 * page - verified live 2026-07-06) and docs/solutions/
 * two-clock-district-boundaries.md for the full decision record.
 *
 * On a lastmod change: writes the new baseline (rdh_lastmod + checked) back
 * into data/redistricting-watch.json so the SAME already-flagged change
 * doesn't re-fire every week - mirrors vacancy_diff.py's chronic-vs-newly-
 * detected split - but never touches `status`/`note`, which stay
 * human-authored until someone reads what actually changed on RDH and
 * updates them in a follow-up commit. Emits GITHUB_OUTPUT vars the next
 * workflow step ("Open an issue for each changed redistricting-watch
 * state") reads to file one issue per changed state.
 *
 * FAILS (exit 1, no baseline update) only when every tracked state comes
 * back missing from the fetch/parse - RDH restructured the sitemap, or the
 * fetch itself is broken - not real redistricting news. Stdlib-only: no
 * npm ci needed, Node 18+'s global fetch suffices (matches
 * scripts/verify-sync.mjs / verify-salt.mjs).
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import {
  RDH_STATE_SITEMAP_URL,
  parseStateSitemap,
  diffWatch,
  isStructuralFailure,
} from '../lib/redistricting-watch.mjs';

const WATCH_PATH = 'data/redistricting-watch.json';

function writeGithubOutput(vars) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) {
    console.log('GITHUB_OUTPUT not set (local run?) - outputs:', vars);
    return;
  }
  for (const [k, v] of Object.entries(vars)) appendFileSync(file, `${k}=${v}\n`);
}

async function main() {
  const committed = JSON.parse(readFileSync(WATCH_PATH, 'utf8'));
  const trackedCount = Object.keys(committed).length;
  const today = new Date().toISOString().slice(0, 10);

  let xml;
  try {
    const res = await fetch(RDH_STATE_SITEMAP_URL, {
      signal: AbortSignal.timeout(15_000),
      // Identify ourselves - a bare default UA is more likely to get bucketed
      // as generic bot traffic by front-door bot mitigation than a UA that
      // names the project and its (public) source, for a once-a-week request.
      headers: { 'User-Agent': 'oravan-redistricting-watch/1.0 (+https://github.com/cm2489/oravan)' },
    });
    if (!res.ok) throw new Error(`upstream status ${res.status}`);
    xml = await res.text();
  } catch (e) {
    console.error(`::error::could not fetch ${RDH_STATE_SITEMAP_URL}: ${e.message}`);
    writeGithubOutput({ anomalous: 'true', changed_states: '[]' });
    process.exit(1);
    return;
  }

  const fresh = parseStateSitemap(xml);
  const { changed, missing } = diffWatch(committed, fresh);

  if (isStructuralFailure(missing, trackedCount)) {
    console.error(
      `::error::all ${trackedCount} tracked state(s) missing from ${RDH_STATE_SITEMAP_URL} - ` +
        'this looks like RDH restructured the sitemap (or the fetch returned something unexpected), ' +
        'not real redistricting news. Refusing to update data/redistricting-watch.json.'
    );
    writeGithubOutput({ anomalous: 'true', changed_states: '[]' });
    process.exit(1);
    return;
  }

  for (const state of missing) {
    console.log(
      `::warning::${state} not found in ${RDH_STATE_SITEMAP_URL} (was: ${committed[state].rdh_url}) - ` +
        'RDH may have moved/renamed the page; check manually. Not treated as a failure since other ' +
        'tracked states resolved fine.'
    );
  }

  for (const c of changed) {
    console.log(
      `::warning::${c.state} RDH page changed: ${c.prevLastmod} -> ${c.newLastmod} (${c.url}) - ` +
        'review and update data/redistricting-watch.json\'s status/note for this state.'
    );
    committed[c.state].rdh_lastmod = c.newLastmod;
    committed[c.state].checked = today;
  }

  if (changed.length > 0) {
    writeFileSync(WATCH_PATH, `${JSON.stringify(committed, null, 2)}\n`);
  }

  writeGithubOutput({
    anomalous: 'false',
    changed_states: JSON.stringify(changed),
  });

  const silent = trackedCount - changed.length - missing.length;
  console.log(
    `redistricting-watch: ${changed.length} changed, ${missing.length} missing, ${silent} unchanged (of ${trackedCount} tracked)`
  );
}

main().catch((e) => {
  console.error(`::error::redistricting-watch check crashed: ${e.message}`);
  process.exit(1);
});

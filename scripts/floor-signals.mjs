/**
 * data/floor-signals.json — the T0 ANNOUNCED rung of the docket ladder.
 *
 *   node --env-file=.env.local scripts/floor-signals.mjs
 *
 * Runs hourly, as its own step in newsdesk.yml, immediately BEFORE
 * scripts/newsdesk.mjs (which reads the file this writes to decide which
 * bills are worth re-reading — see that script's re-decode trigger). Owns
 * data/floor-signals.json ALONE and touches nothing else, the same disjoint-
 * file discipline scripts/moment-updates.mjs keeps beside the newsdesk.
 *
 * ---- WHY IT EXISTS -------------------------------------------------------
 * Everything the site could rank on until now was BACKWARD-looking: a status
 * derived from `last_action_text`, which Congress overwrites the moment a
 * bill draws real floor action. The 18-snapshot backtest measured the cost —
 * the corpus demoted the continuing resolution to "On the radar" on the day
 * the Senate passed it 90-6, and the week's two hottest vehicles read as
 * `committee` because their passage sentence had been overwritten. The one
 * class of signal that arrives BEFORE the vote is the chamber's own
 * announcement of its own schedule, and both chambers publish one for free.
 *
 * ---- WHAT IT COSTS -------------------------------------------------------
 * $0. Four free requests per run: one docs.house.gov XML, two Congress.gov
 * API calls (the daily-congressional-record list + one issue detail, on the
 * existing CONGRESS_API_KEY) and one congress.gov HTML page. No model calls
 * ever — nothing on this path is AI-generated, by construction: every word
 * stored is a verbatim substring of a government document, with the document's
 * own URL and date beside it.
 *
 * ---- WHAT IT WRITES ------------------------------------------------------
 * Committed JSON, never a cache (owner ruling V5, and the backtest's own
 * lesson: everything the newsdesk kept in its Actions cache is unauditable
 * history now). The full schema, the source_status vocabulary and the
 * carry-forward rules live in scripts/floor-signals-parse.mjs's header — this
 * file is the network and the fs, that one is the judgement.
 *
 * The write is CONDITIONAL: an hourly cron must never become an hourly
 * deploy, so a run whose content matches the committed file writes nothing
 * (shouldWrite / materialFingerprint). A schedule that CHANGED — a bill added,
 * a bill pulled — writes immediately, which is what makes A-1's revalidation
 * real rather than decorative.
 *
 * ---- WHAT IT REFUSES -----------------------------------------------------
 * - To translate a quote (owner ruling V4): `quote` is English verbatim.
 * - To let a nomination into the bill ladder (owner ruling V3): nominations
 *   found in the Senate program route to data/nominations.json's citation or
 *   are dropped with a logged reason, into a separate top-level map.
 * - To read a 404 as a quiet week without independent evidence (critic A-5).
 * - To print or store a secret: the Congress.gov key rides in the query
 *   string of api.congress.gov/api.govinfo.gov requests and is redacted from
 *   every log line and from every URL stored in the file.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cg } from './congress-fetch.mjs';
import {
  FLOOR_SIGNALS_PATH,
  FLOOR_SIGNALS_SCHEMA,
  deriveSourceStatus,
  digestToText,
  govinfoGranuleHtmlUrl,
  mergeSignals,
  parseBillsThisWeek,
  parseProgramBlocks,
  parseSenateProgram,
  resolveMeetingDate,
  selectDigestGranule,
  sessionFromProgram,
  shouldWrite,
} from './floor-signals-parse.mjs';
import { mondayOfWeekET } from './newsdesk-match.mjs';

// Congress.gov sits behind Cloudflare. The browser-shaped UA is the one
// scripts/newsdesk.mjs already uses for its tier-0 feeds; the probe measured
// byte-identical 200s for four UA variants on the /crec/ pages (2026-08-12),
// so this is belt-and-braces against a future tightening, not a workaround.
const TIER0_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 20_000;
// Force the govinfo path even when congress.gov is healthy — the only way to
// exercise the fallback on demand without breaking the primary.
const FORCE_FALLBACK = process.env.FLOOR_SIGNALS_FORCE_FALLBACK === '1';
// How far back to accept a Daily Digest issue as the CURRENT program. Past
// this the newest issue is not "the next session day", it is history: the
// chambers are out and the program it announces has already happened.
const DIGEST_MAX_AGE_DAYS = Number(process.env.FLOOR_SIGNALS_DIGEST_MAX_AGE_DAYS ?? 5);

const redact = (url) => String(url).replace(/api_key=[^&]+/g, 'api_key=REDACTED');

async function getText(url, { ok404 = false } = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': TIER0_USER_AGENT },
  });
  if (res.status === 404 && ok404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${redact(url)}`);
  return res.text();
}

function loadJSONOr(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

// ---- source 1: the House's weekly floor schedule -------------------------
async function fetchBillsThisWeek() {
  const monday = mondayOfWeekET();
  const url = `https://docs.house.gov/billsthisweek/${monday}/${monday}.xml`;
  const weekOf = `${monday.slice(0, 4)}-${monday.slice(4, 6)}-${monday.slice(6, 8)}`;
  try {
    const xml = await getText(url, { ok404: true });
    if (xml === null) return { outcome: 'missing', url, weekOf, items: [], dropped: [], detail: 'no schedule published for this week (404)' };
    const parsed = parseBillsThisWeek(xml, { url, weekOf });
    return {
      outcome: parsed.items.length > 0 ? 'ok' : 'empty',
      url,
      weekOf: parsed.weekDate ?? weekOf,
      items: parsed.items,
      dropped: parsed.dropped,
      detail: `${parsed.items.length} scheduled measure(s)`,
    };
  } catch (e) {
    return { outcome: 'error', url, weekOf, items: [], dropped: [], detail: e.message };
  }
}

// ---- source 2: the Senate's program, from the Daily Digest ---------------
/** congress.gov's whole-digest document: list -> issue detail -> the Daily
 *  Digest section's Formatted Text URL. */
async function fetchDigestPrimary() {
  const list = await cg('/daily-congressional-record', { limit: 5 });
  const issues = list?.dailyCongressionalRecord ?? [];
  if (issues.length === 0) throw new Error('daily-congressional-record list came back empty');
  // The list is issueDate-descending; sort anyway rather than trust it.
  const newest = [...issues].sort((a, b) => String(b.issueDate).localeCompare(String(a.issueDate)))[0];
  const issueDate = String(newest.issueDate).slice(0, 10);
  const detail = await cg(`/daily-congressional-record/${newest.volumeNumber}/${newest.issueNumber}`);
  const issue = Array.isArray(detail?.issue) ? detail.issue[0] : detail?.issue;
  const section = (issue?.fullIssue?.sections ?? []).find((s) => /daily digest/i.test(s?.name ?? ''));
  const url = (section?.text ?? []).find((t) => t?.type === 'Formatted Text')?.url;
  if (!url) throw new Error(`no Formatted Text URL in the Daily Digest section of ${issueDate}`);
  const html = await getText(url);
  return { html, url, issueDate, via: 'congress.gov' };
}

/** govinfo's per-page granules, no key needed for the HTML and the existing
 *  Congress.gov key for the granule list (api.data.gov keyspace — verified
 *  live 2026-08-12). Used only when the primary throws. */
async function fetchDigestFallback(issueDate) {
  const packageId = `CREC-${issueDate}`;
  const key = process.env.CONGRESS_API_KEY;
  if (!key) throw new Error('CONGRESS_API_KEY missing (needed for the govinfo granule list)');
  const listUrl = `https://api.govinfo.gov/packages/${packageId}/granules?offset=0&pageSize=100&api_key=${key}`;
  const res = await fetch(listUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${redact(listUrl)}`);
  const granuleId = selectDigestGranule(await res.json());
  if (!granuleId) throw new Error(`no "Next Meeting of the SENATE" granule in ${packageId}`);
  const url = govinfoGranuleHtmlUrl(packageId, granuleId);
  const html = await getText(url);
  return { html, url, issueDate, via: 'govinfo' };
}

async function fetchDigest({ bySlug, nominations, todayISO }) {
  const base = { items: [], dropped: [], senate: null, house: null, url: null, issueDate: null, via: null };
  let doc;
  try {
    if (FORCE_FALLBACK) throw new Error('FLOOR_SIGNALS_FORCE_FALLBACK=1');
    doc = await fetchDigestPrimary();
  } catch (primaryErr) {
    console.error(`  daily-digest primary path failed: ${primaryErr.message}`);
    try {
      // The fallback needs an issue date and the primary is what supplies it,
      // so when the primary died before naming one, walk back day by day to
      // the same age ceiling the primary path applies. Congress publishes no
      // Record on a day it does not meet, and govinfo simply 404s those, so
      // the walk is what finds the most recent real issue — at most
      // DIGEST_MAX_AGE_DAYS + 1 free requests, only ever on the fallback path.
      const candidates = Array.from({ length: DIGEST_MAX_AGE_DAYS + 1 }, (_, i) =>
        new Date(Date.parse(`${todayISO}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10)
      );
      let lastErr;
      for (const d of candidates) {
        try {
          doc = await fetchDigestFallback(d);
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!doc) throw lastErr ?? new Error('no govinfo granule found');
      console.log(`  daily-digest: recovered via the govinfo fallback (${doc.issueDate})`);
    } catch (fallbackErr) {
      return { ...base, outcome: 'error', detail: `${primaryErr.message}; fallback: ${fallbackErr.message}` };
    }
  }

  const ageDays = (Date.parse(`${todayISO}T00:00:00Z`) - Date.parse(`${doc.issueDate}T00:00:00Z`)) / 86_400_000;
  const text = digestToText(doc.html);
  const blocks = parseProgramBlocks(text);
  if (!blocks.senate) {
    return {
      ...base,
      outcome: 'empty',
      url: doc.url,
      issueDate: doc.issueDate,
      via: doc.via,
      house: blocks.house,
      detail: `no Senate "Program for" block in the ${doc.issueDate} digest`,
    };
  }
  if (Number.isFinite(ageDays) && ageDays > DIGEST_MAX_AGE_DAYS) {
    // Not an error and not a claim: the newest Record is old enough that its
    // program is history rather than a schedule. Nothing is stored from it.
    return {
      ...base,
      outcome: 'empty',
      url: doc.url,
      issueDate: doc.issueDate,
      via: doc.via,
      senate: blocks.senate,
      house: blocks.house,
      detail: `newest Daily Digest is ${Math.round(ageDays)} days old (${doc.issueDate}) — its program has already passed`,
    };
  }
  const coversLabel = blocks.senate.meetingLabel;
  const covers = resolveMeetingDate(coversLabel, doc.issueDate);
  const parsed = blocks.senate.proForma
    ? { items: [], dropped: [] }
    : parseSenateProgram(blocks.senate, {
        issueDate: doc.issueDate,
        url: doc.url,
        covers,
        coversLabel,
        bySlug,
        nominations,
      });
  return {
    outcome: parsed.items.length > 0 ? 'ok' : 'empty',
    url: doc.url,
    issueDate: doc.issueDate,
    via: doc.via,
    senate: blocks.senate,
    house: blocks.house,
    covers,
    coversLabel,
    items: parsed.items,
    dropped: parsed.dropped,
    detail: blocks.senate.proForma
      ? 'Senate program: pro forma session'
      : `${parsed.items.length} announced measure(s)/nomination(s)`,
  };
}

// ---- main ----------------------------------------------------------------
const now = Date.now();
const nowISO = new Date(now).toISOString();
const todayISO = nowISO.slice(0, 10);
const previous = existsSync(FLOOR_SIGNALS_PATH) ? loadJSONOr(FLOOR_SIGNALS_PATH, null) : null;
const bills = loadJSONOr('data/bills.json', []);
const bySlug = new Map(
  bills.map((b) => [`${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase(), b])
);
const nominations = loadJSONOr('data/nominations.json', []);

console.log(`floor-signals [${nowISO}]: fetching the two announcement sources`);
const digest = await fetchDigest({ bySlug, nominations, todayISO });
console.log(`  daily-digest: ${digest.outcome} — ${digest.detail}${digest.via ? ` (via ${digest.via})` : ''}`);
const house = await fetchBillsThisWeek();
console.log(`  billsthisweek: ${house.outcome} — ${house.detail}`);

// The cross-check (critic A-5). Only POSITIVE evidence counts as in_session:
// the digest's own House program tells us whether the House is meeting, and
// the House schedule naming measures tells us the House is meeting. Two dark
// sources produce `unknown`, never `quiet`.
const houseSession = sessionFromProgram(digest.house);
const senateSession = sessionFromProgram(digest.senate);
const digestCrossCheck = house.outcome === 'ok' ? 'in_session' : 'unknown';

const sources = {
  'daily-digest': {
    status: deriveSourceStatus({
      outcome: digest.outcome,
      selfEvidentQuiet: senateSession === 'out_of_session',
      crossCheck: digestCrossCheck,
    }),
    detail: digest.detail,
    checked_at: nowISO,
    url: digest.url,
    published: digest.issueDate,
    covers: digest.covers ?? null,
    covers_label: digest.coversLabel ?? null,
    via: digest.via,
  },
  billsthisweek: {
    status: deriveSourceStatus({
      outcome: house.outcome,
      selfEvidentQuiet: houseSession === 'out_of_session',
      crossCheck: houseSession === 'in_session' ? 'in_session' : houseSession === 'out_of_session' ? 'out_of_session' : 'unknown',
    }),
    detail: house.detail,
    checked_at: nowISO,
    url: house.url,
    published: house.weekOf,
    covers: house.weekOf,
    covers_label: null,
    via: 'docs.house.gov',
  },
};
for (const [name, s] of Object.entries(sources)) {
  if (s.status === 'data_stale' || s.status === 'error') {
    console.log(
      `::warning::floor-signals: ${name} is ${s.status} — ${s.detail}. Nothing from this source may render as a quiet week (critic A-5); the ladder falls back to the record-derived rungs.`
    );
  }
}

const dropped = [...digest.dropped, ...house.dropped];
for (const d of dropped) {
  console.log(`  dropped (${d.source}/${d.reason}): ${d.slug ?? ''} ${d.text ?? ''}`.trim());
}

const merged = mergeSignals({
  previous,
  fetched: [...digest.items, ...house.items],
  sourceStates: sources,
  now,
});

const next = {
  _meta: {
    schema: FLOOR_SIGNALS_SCHEMA,
    fetched_at: nowISO,
    sources,
    in_session: { senate: senateSession, house: houseSession, basis: 'Daily Digest "Program for" blocks' },
    // Capped and truncated: enough to audit why a measure the digest named is
    // not on the page, small enough that it can never dominate the file.
    dropped: dropped.slice(0, 20).map((d) => ({ source: d.source, reason: d.reason, slug: d.slug ?? null, text: (d.text ?? '').slice(0, 160) })),
  },
  signals: merged.signals,
  nominations: merged.nominations,
};

const liveSignals = Object.values(next.signals).filter((s) => s.stale !== true).length;
console.log(
  `floor-signals: ${Object.keys(next.signals).length} bill signal(s) (${liveSignals} live), ${Object.keys(next.nominations).length} nomination(s), ${dropped.length} dropped`
);

if (shouldWrite({ previous, next, now })) {
  writeFileSync(FLOOR_SIGNALS_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`DONE: wrote ${FLOOR_SIGNALS_PATH}`);
} else {
  console.log(`DONE: no change and the stamp is still fresh — ${FLOOR_SIGNALS_PATH} untouched (an hourly run must not produce a deploy)`);
}

/**
 * Nightly ROLL-CALL VOTE sync. Updates data/votes.json with every House and
 * Senate roll call whose vote question references a corpus bill, then CI
 * commits the diff.
 *
 *   node --env-file=.env.local scripts/sync-votes.mjs [--dry-run]
 *
 * Needs CONGRESS_API_KEY (House). NO Anthropic key, no AI, no spend: this is
 * the government's own record — question text, result, tally, the tally by
 * party, and every member's position — and nothing else. The parsing and the gate live in
 * lib/votes-core.mjs; this file is only the I/O around them.
 *
 * ── WHY A SEPARATE SCRIPT AND A SEPARATE STEP ──────────────────────────────
 * The sync-nominations.mjs precedent: the bill corpus is the product's spine,
 * and a vote-side outage (a Congress.gov field change, senate.gov moving a
 * path, a novel vote cast) must never cost a night of bill statuses. The
 * workflow step is `continue-on-error: true`, which makes every verdict
 * downstream of it advisory — so, exactly as sync-nominations.mjs does, this
 * script runs the gate's judgement over the file it has built and refuses to
 * WRITE a failing one. scripts/check-votes.mjs then re-checks the committed
 * shape before the commit step.
 *
 * ── SCOPE ──────────────────────────────────────────────────────────────────
 * Corpus bills only (data/bills.json). The first run reaches back
 * LOOKBACK_DAYS (120) and fixes that date as `_meta.floor`; after that a
 * nightly or intraday run never moves it, and only a back-fill (below) moves
 * it, and only back. A Senate cloture vote on the motion to proceed
 * to H.R. 3633 counts for hr-3633-119, because the record's own question
 * names it. A House RULE vote does not count for the bill it schedules: the
 * rule is a separate measure (an H.Res.), and the record names that measure.
 *
 * ── CURSOR SEMANTICS ───────────────────────────────────────────────────────
 * `_meta.cursor.{house,senate}` = "CONGRESS-SESSION-ROLL", the highest roll
 * number examined in an unbroken run with no failure below it. It lives IN
 * data/votes.json rather than data/sync-state.json on purpose: the cursor and
 * the roll calls it describes are then written in one file write and can
 * never disagree, and sync-state.json's union resolver
 * (scripts/merge-sync-state.mjs) never has to learn a non-timestamp key.
 * A date is not a valid cursor here — roll numbers are the record's own
 * sequence — and the gate pins the format.
 *
 * The cursor is a progress marker, not the only thing standing between the
 * file and a gap: every run re-lists the whole window (two free requests for
 * the House list, one menu fetch for the Senate) and fetches any corpus roll
 * call it does not already hold. That is what makes the sync idempotent and
 * resumable, and it is what catches a bill that joined the corpus AFTER its
 * vote: sync-bills.mjs runs before this, so tonight's new corpus bills get
 * tonight's votes, including older ones inside the window.
 *
 * "Holds" means holds WITH `totalsByParty` (2026-09-29): a roll call on file
 * without its count by party is fetched again like a missing one (isHeld,
 * below). The 2026-09-29 back-fill re-read all of them from the record, so a
 * nightly finds none; the rule is there so a file written by older code can
 * never leave one without it.
 *
 * ── COST ───────────────────────────────────────────────────────────────────
 * Per session in the window: 2 Congress.gov list requests (250 roll calls a
 * page) + 2 per new House corpus roll call, 1 senate.gov menu + 1 per new
 * Senate corpus roll call. With the floor at the Congress's first day that is
 * both sessions for the nightly — 4 list requests and 2 menus. The intraday
 * run (--only-new-rolls) lists only the newest session, because a new roll
 * call can only be in it: 2 list requests and 1 menu, as before the back-fill.
 * All free. Requests are spaced THROTTLE_MS apart.
 *
 * ── BACK-FILL (--backfill-from YYYY-MM-DD, 2026-09-29) ─────────────────────
 * The owner, 2026-09-29: "Can we get the votes from this entire current
 * congress? That is public record so let's back fill them all for every
 * bill." This mode moves `_meta.floor` BACK to the given date (never forward:
 * lib/votes-core.mjs resolveFloor) and fetches every roll call from there on
 * that references a corpus bill, through the same parsers and the same gate:
 *   - House: KEYLESS, from the Clerk's own record (lib/votes-backfill.mjs):
 *     the per-year index page for the highest roll number, then every
 *     `evs/{year}/roll{NNN}.xml` the file does not already hold. No
 *     CONGRESS_API_KEY is read.
 *   - Senate: the nightly's own path — it already needs no key.
 * ALL OR NOTHING FOR THE DAYS IT ADDS: a back-fill with any failed roll call
 * that is (or may be) dated before the file's old floor, or any list it could
 * not read, writes NOTHING, because the new floor would claim a roll call the
 * file does not hold (lib/votes-backfill.mjs backfillBlockers). A failure on
 * or after the old floor was already the nightly's to retry — typically a
 * same-day Senate vote whose XML senate.gov has not published yet — and does
 * not hold the back-fill back. Every fetched roll-call document can be kept in
 * `--cache-dir <dir>` (a scratch directory, never the repo), so re-running
 * after a crash or a failure fetches only what is still missing. The index
 * page and the Senate menus are always re-read: they grow.
 *
 *   node scripts/sync-votes.mjs --backfill-from 2025-01-03 --cache-dir /tmp/votes-cache [--dry-run]
 *
 * A back-fill needs no secret. Run it by hand, commit data/votes.json, and the
 * nightly carries the wider floor from then on (it reads the floor from the
 * file and re-lists every session in it).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONGRESS, cg } from './congress-fetch.mjs';
import { backfillBlockers, walkHouseClerk } from '../lib/votes-backfill.mjs';
import {
  VOTES_PATH,
  VOTES_SCHEMA,
  VoteParseError,
  compareRollCalls,
  congressFirstYear,
  hasPartyTotals,
  legislationText,
  parseHouseApi,
  parseHouseClerkXml,
  parseSenateMenu,
  parseSenateXml,
  resolveBillId,
  resolveFloor,
  rollCallId,
  sessionForYear,
  verifyVotes,
} from '../lib/votes-core.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
/** `--flag value` or `--flag=value`; null when absent. */
function flagValue(name) {
  const i = process.argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return null;
  const a = process.argv[i];
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (process.argv[i + 1] ?? '');
}
/** See BACK-FILL in the header. */
const BACKFILL_FROM = flagValue('--backfill-from');
const BACKFILL = BACKFILL_FROM !== null;
const CACHE_DIR = flagValue('--cache-dir');
/**
 * --only-new-rolls (the intraday newsdesk path, 2026-09-25): write the file
 * ONLY when this run stored at least one new roll call. The one other thing a
 * run can change is the cursor, and the cursor moves on EVERY roll call either
 * chamber takes — corpus bill or not — so without this flag an hourly run on a
 * session day would commit and deploy the whole site for a progress marker
 * nobody reads. Nothing is lost by not persisting it: every run re-lists the
 * whole window and fetches any corpus roll call it does not hold (see CURSOR
 * SEMANTICS above), and the nightly — which runs without the flag — persists
 * the cursor as it always has. When a new roll IS stored, the cursor is
 * written in the same write, so the two can never disagree.
 */
const ONLY_NEW_ROLLS = process.argv.includes('--only-new-rolls');
const THROTTLE_MS = Number(process.env.VOTES_THROTTLE_MS ?? 250);
const UA = 'oravan-votes-sync (+https://oravan.org)';
const UPSTREAM_LEGISLATORS = [
  'https://unitedstates.github.io/congress-legislators/legislators-current.json',
  'https://unitedstates.github.io/congress-legislators/legislators-historical.json',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;
async function throttle() {
  const wait = lastRequestAt + THROTTLE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/** GET a public (keyless) document with the same retry/timeout discipline as
 *  congress-fetch.mjs's cg(): a hung socket retries instead of killing the
 *  run, and the body read happens inside the try. */
async function getText(url) {
  let lastErr;
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) await sleep(2000 * attempt);
    await throttle();
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      // senate.gov answers a moved/missing document with a 301 to an HTML
      // "not available" page — following it would hand the parser HTML.
      if (res.status === 200) return await res.text();
      lastErr = new Error(`${res.status} for ${url}`);
      if (res.status === 404 || (res.status >= 300 && res.status < 400)) break;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function congressGet(path, params) {
  await throttle();
  return cg(path, params);
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const toSeconds = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---- inputs -----------------------------------------------------------------
const bills = readJson('data/bills.json');
const corpus = new Set(bills.map((b) => b.full_identifier));
const legislators = readJson('data/legislators.json');
const vacancies = readJson('data/vacancies.json');
const currentById = new Map(legislators.map((l) => [l.bioguide, l]));
const lisMap = new Map(legislators.filter((l) => l.lis).map((l) => [l.lis, l.bioguide]));

const now = new Date();
const existing = existsSync(VOTES_PATH) ? readJson(VOTES_PATH) : null;
if (BACKFILL && ONLY_NEW_ROLLS) {
  console.log('::error::sync-votes: --backfill-from and --only-new-rolls do not combine (a back-fill writes every roll call it stores, or nothing). Nothing written.');
  process.exit(1);
}
if (CACHE_DIR !== null && !CACHE_DIR) {
  console.log('::error::sync-votes: --cache-dir needs a directory. Nothing written.');
  process.exit(1);
}
let floor;
try {
  floor = resolveFloor({ existingFloor: existing?._meta?.floor ?? null, backfillFrom: BACKFILL_FROM, congress: CONGRESS, now: now.getTime() });
} catch (e) {
  console.log(`::error::sync-votes: ${e.message}. Nothing written.`);
  process.exit(1);
}
const rollCalls = new Map((existing?.rollCalls ?? []).map((r) => [r.id, r]));
const roster = new Map((existing?.members ?? []).map((m) => [m.id, m]));
/**
 * HELD means stored WITH its count by party. A roll call the file holds
 * without `totalsByParty` (every one written before 2026-09-29) is fetched
 * again and replaced, exactly as a missing one is fetched: that is how the
 * field reaches the roll calls already on file, through the same parsers and
 * the same gate, and it makes a run over an older file self-healing rather
 * than a gate failure nobody can fix without a back-fill.
 */
const isHeld = (id) => hasPartyTotals(rollCalls.get(id));
/** The walker's view of the same rule (lib/votes-backfill.mjs reads has/get). */
const heldView = { has: isHeld, get: (id) => rollCalls.get(id) };
const cursor = { house: existing?._meta?.cursor?.house ?? null, senate: existing?._meta?.cursor?.senate ?? null };

// Sessions whose calendar year overlaps [floor, today]. A year outside the
// tracked Congress (after a rollover, before CONGRESS is bumped) contributes
// nothing — that is scripts/check-rollover-tripwire.mjs's alarm, not ours.
const sessions = [];
for (let y = Number(floor.slice(0, 4)); y <= now.getUTCFullYear(); y++) {
  const s = sessionForYear(CONGRESS, y);
  if (s && !sessions.includes(s)) sessions.push(s);
}
if (sessions.length === 0) {
  console.log(`::error::sync-votes: no session of the ${CONGRESS}th Congress (first year ${congressFirstYear(CONGRESS)}) overlaps ${floor}..today — is CONGRESS stale? Nothing written.`);
  process.exit(1);
}
// The intraday run looks for TODAY's votes, which can only be in the newest
// session; the nightly (no flag) re-lists every session in the window, which
// is what catches a bill that joins the corpus after an older vote on it.
if (ONLY_NEW_ROLLS) sessions.splice(0, sessions.length - 1);

let upstreamLoaded = 0;
/** bioguide → full name, from the upstream files, for members
 *  data/legislators.json no longer lists (process-data.py's own rule:
 *  official_full, else first + last). */
const upstreamNames = new Map();
async function loadNextUpstream() {
  const src = UPSTREAM_LEGISLATORS[upstreamLoaded++];
  for (const l of JSON.parse(await getText(src))) {
    if (l.id?.lis && l.id?.bioguide && !lisMap.has(l.id.lis)) lisMap.set(l.id.lis, l.id.bioguide);
    const full = l.name?.official_full || `${l.name?.first ?? ''} ${l.name?.last ?? ''}`.trim();
    if (l.id?.bioguide && full && !upstreamNames.has(l.id.bioguide)) upstreamNames.set(l.id.bioguide, full);
  }
}
/** LIS id → bioguide. data/legislators.json first; on a miss (a senator
 *  sworn in since the weekly legislators refresh, or one who has left), the
 *  same public source that file is built from — current, then historical. */
async function ensureLis(lisIds) {
  while (lisIds.some((id) => !lisMap.has(id)) && upstreamLoaded < UPSTREAM_LEGISLATORS.length) {
    console.log(`  LIS id(s) ${lisIds.filter((id) => !lisMap.has(id)).join(', ')} not in data/legislators.json — reading ${UPSTREAM_LEGISLATORS[upstreamLoaded]}`);
    await loadNextUpstream();
  }
}
/**
 * The Clerk's XML names a member by last name only ("Grijalva", "Johnson
 * (LA)"). For a member data/legislators.json still lists, store() uses that
 * file's name and this changes nothing. For one it no longer lists (died,
 * resigned) and the roster does not already name, the full name comes from
 * the same public source as above, so the vote record's member list reads
 * the member's full name, not "Grijalva". Unresolvable: the Clerk's own name.
 */
async function withFullNames(parsed) {
  const need = parsed.members.filter((m) => !currentById.has(m.id) && !roster.has(m.id)).map((m) => m.id);
  while (need.some((id) => !upstreamNames.has(id)) && upstreamLoaded < UPSTREAM_LEGISLATORS.length) {
    console.log(`  member(s) ${need.filter((id) => !upstreamNames.has(id)).join(', ')} not in data/legislators.json — reading ${UPSTREAM_LEGISLATORS[upstreamLoaded]}`);
    await loadNextUpstream();
  }
  for (const m of parsed.members) if (need.includes(m.id) && upstreamNames.has(m.id)) m.name = upstreamNames.get(m.id);
  return parsed;
}

/** One roll call's document, through --cache-dir when given: a record once
 *  published is re-read from disk on a resumed back-fill, never re-fetched.
 *  Written atomically (temp file + rename), so a crash never leaves half a
 *  document that a later run would trust. */
async function getRoll(url) {
  if (!CACHE_DIR) return getText(url);
  const file = join(CACHE_DIR, url.replace(/^https:\/\//, '').replace(/[^A-Za-z0-9._-]+/g, '_'));
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const text = await getText(url);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(`${file}.part`, text);
  renameSync(`${file}.part`, file);
  return text;
}

const stats = {
  house: { listed: 0, inWindow: 0, corpus: 0, stored: 0, refreshed: 0, viaClerk: 0, failed: 0 },
  senate: { listed: 0, inWindow: 0, corpus: 0, stored: 0, refreshed: 0, failed: 0 },
};

function store(parsed, chamber) {
  const { roll, members } = parsed;
  // Already on file (without its count by party, or it would have been held
  // and never fetched): re-read from the record and replaced.
  if (rollCalls.has(roll.id)) stats[chamber].refreshed++;
  rollCalls.set(roll.id, roll);
  for (const m of members) {
    const cur = currentById.get(m.id);
    roster.set(m.id, {
      id: m.id,
      name: cur?.name ?? roster.get(m.id)?.name ?? m.name,
      state: m.state ?? cur?.state,
      chamber,
    });
  }
  stats[chamber].stored++;
}

/** Advance a chamber's cursor over rolls examined in order, stopping at the
 *  first failure so the next run's cursor never claims a roll it lost. */
function advance(chamber, session, examined) {
  const sorted = [...examined].sort((a, b) => a.roll - b.roll);
  let high = null;
  for (const e of sorted) {
    if (e.failed) break;
    high = e.roll;
  }
  if (high == null) return;
  const next = `${CONGRESS}-${session}-${high}`;
  const prev = cursor[chamber];
  const [, ps, pr] = prev ? prev.split('-').map(Number) : [0, 0, 0];
  if (!prev || session > ps || (session === ps && high > pr)) cursor[chamber] = next;
}

// ---- House --------------------------------------------------------------------
/** Every chamber-session a back-fill examined, for backfillBlockers. */
const backfillExamined = [];

/** Back-fill: the Clerk's record, no key (lib/votes-backfill.mjs). */
async function syncHouseClerk(session) {
  const walk = await walkHouseClerk({
    congress: CONGRESS,
    session,
    floor,
    corpus,
    held: heldView,
    getText,
    getRoll,
    log: (line) => console.log(line),
  });
  for (const one of walk.parsed) store(await withFullNames(one), 'house');
  const h = stats.house;
  h.listed += walk.stats.listed;
  h.inWindow += walk.stats.inWindow;
  h.corpus += walk.stats.corpus;
  h.viaClerk += walk.stats.stored;
  h.failed += walk.stats.failed;
  console.log(`  House ${walk.year}: rolls 1-${walk.maxRoll} examined from the Clerk's record, ${walk.stats.stored} stored, ${walk.stats.failed} failed`);
  backfillExamined.push({ chamber: 'house', session, examined: walk.examined });
  advance('house', session, walk.examined);
}

async function syncHouse(session) {
  if (BACKFILL) return syncHouseClerk(session);
  const items = [];
  for (let offset = 0; ; offset += 250) {
    const page = await congressGet(`/house-vote/${CONGRESS}/${session}`, { limit: 250, offset });
    const got = page.houseRollCallVotes ?? [];
    items.push(...got);
    if (got.length < 250 || items.length >= (page.pagination?.count ?? 0)) break;
  }
  stats.house.listed += items.length;
  const examined = [];
  for (const it of items.sort((a, b) => a.rollCallNumber - b.rollCallNumber)) {
    const date = String(it.startDate ?? '').slice(0, 10);
    if (date < floor) { examined.push({ roll: it.rollCallNumber }); continue; }
    stats.house.inWindow++;
    const id = rollCallId('house', CONGRESS, session, it.rollCallNumber);
    const bill = resolveBillId([legislationText(it.legislationType, it.legislationNumber)], corpus, CONGRESS);
    if (!bill) { examined.push({ roll: it.rollCallNumber }); continue; }
    stats.house.corpus++;
    if (isHeld(id)) { examined.push({ roll: it.rollCallNumber }); continue; }
    try {
      let parsed;
      try {
        const base = `/house-vote/${CONGRESS}/${session}/${it.rollCallNumber}`;
        const detail = await congressGet(base);
        const members = await congressGet(`${base}/members`);
        parsed = parseHouseApi(detail, members, { corpus, sourceUrl: it.sourceDataURL });
      } catch (e) {
        if (e instanceof VoteParseError) throw e; // a shape we can't read is not a transport failure
        // Anything else falls back to the Clerk, including VotePartyDisagreement
        // (lib/votes-core.mjs): the API's party table and its own member rows
        // did not agree, so the count is read from the cited record instead.
        console.log(`  ${id}: Congress.gov failed (${e.message}) — falling back to the Clerk's XML`);
        parsed = await withFullNames(parseHouseClerkXml(await getText(it.sourceDataURL), { corpus, sourceUrl: it.sourceDataURL }));
        stats.house.viaClerk++;
      }
      if (parsed.roll.bill !== bill) throw new VoteParseError(`list said ${bill}, the roll call itself says ${parsed.roll.bill}`);
      store(parsed, 'house');
      examined.push({ roll: it.rollCallNumber });
      console.log(`  ${id} ${parsed.roll.date} ${bill}: ${parsed.roll.question} — ${parsed.roll.result}`);
    } catch (e) {
      stats.house.failed++;
      examined.push({ roll: it.rollCallNumber, failed: true });
      console.log(`::error::sync-votes: ${id} (${bill}) not stored — ${e.message}`);
    }
  }
  advance('house', session, examined);
}

// ---- Senate ---------------------------------------------------------------------
async function syncSenate(session) {
  const menuUrl = `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_${CONGRESS}_${session}.xml`;
  const menu = parseSenateMenu(await getText(menuUrl));
  stats.senate.listed += menu.length;
  const examined = [];
  for (const v of menu.sort((a, b) => a.roll - b.roll)) {
    if (!v.date || v.date < floor) { examined.push({ roll: v.roll, date: v.date }); continue; }
    stats.senate.inWindow++;
    const id = rollCallId('senate', CONGRESS, session, v.roll);
    const menuBill = resolveBillId([v.issue, v.question], corpus, CONGRESS);
    if (!menuBill) { examined.push({ roll: v.roll, date: v.date }); continue; }
    stats.senate.corpus++;
    if (isHeld(id)) { examined.push({ roll: v.roll, date: v.date }); continue; }
    const nnnnn = String(v.roll).padStart(5, '0');
    const url = `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${CONGRESS}${session}/vote_${CONGRESS}_${session}_${nnnnn}.xml`;
    try {
      const xml = await getRoll(url);
      await ensureLis([...xml.matchAll(/<lis_member_id>([^<]+)<\/lis_member_id>/g)].map((m) => m[1].trim()));
      const parsed = parseSenateXml(xml, { corpus, sourceUrl: url, lisToBioguide: (lis) => lisMap.get(lis) ?? null });
      if (!parsed.roll.bill) throw new VoteParseError(`the menu listed ${menuBill}, but the vote record names no corpus bill`);
      store(parsed, 'senate');
      examined.push({ roll: v.roll, date: v.date });
      console.log(`  ${id} ${parsed.roll.date} ${parsed.roll.bill}: ${parsed.roll.question} — ${parsed.roll.result}`);
    } catch (e) {
      stats.senate.failed++;
      examined.push({ roll: v.roll, date: v.date, failed: true });
      console.log(`::error::sync-votes: ${id} (${menuBill}) not stored — ${e.message}`);
    }
  }
  if (BACKFILL) backfillExamined.push({ chamber: 'senate', session, examined });
  advance('senate', session, examined);
}

console.log(
  `sync-votes: ${CONGRESS}th Congress, session(s) ${sessions.join(', ')}, floor ${floor}` +
    (BACKFILL ? ` (BACK-FILL from ${BACKFILL_FROM}; the file's floor was ${existing?._meta?.floor ?? 'unset'}; House from the Clerk's record${CACHE_DIR ? `, cache ${CACHE_DIR}` : ''})` : '') +
    `, ${corpus.size} corpus bills, ${rollCalls.size} roll call(s) already held`
);
let fatal = false;
for (const s of sessions) {
  try {
    await syncHouse(s);
  } catch (e) {
    fatal = true;
    console.log(`::error::sync-votes: the House list for session ${s} could not be read (${e.message}) — House votes not advanced this run`);
  }
  try {
    await syncSenate(s);
  } catch (e) {
    fatal = true;
    console.log(`::error::sync-votes: the Senate vote menu for session ${s} could not be read (${e.message}) — Senate votes not advanced this run`);
  }
}

// ---- build, gate, write -------------------------------------------------------------
const list = [...rollCalls.values()].sort(compareRollCalls);
const referenced = new Set(list.flatMap((r) => Object.values(r.votes).flat()));
const members = [...roster.values()].filter((m) => referenced.has(m.id)).sort((a, b) => a.id.localeCompare(b.id));
// First run with a chamber that had no corpus roll call yet: the cursor still
// has to say where the scan got to, or the gate rightly calls it damage.
for (const c of ['house', 'senate']) if (!cursor[c]) cursor[c] = `${CONGRESS}-${sessions.at(-1)}-0`;

const body = { rollCalls: list, members };
const unchanged =
  existing &&
  JSON.stringify({ rollCalls: existing.rollCalls, members: existing.members, cursor: existing._meta?.cursor }) ===
    JSON.stringify({ ...body, cursor });
const doc = {
  _meta: {
    schema: VOTES_SCHEMA,
    floor,
    updatedAt: unchanged ? existing._meta.updatedAt : toSeconds(now),
    cursor,
    sources: {
      house: 'https://api.congress.gov/v3/house-vote (fallback: https://clerk.house.gov/evs/)',
      senate: 'https://www.senate.gov/legislative/LIS/roll_call_votes/',
    },
  },
  ...body,
};

/** One roll call per line and one roster entry per line: small, reviewable
 *  diffs, where a minified file would rewrite a single line every night. */
function serialize(d) {
  const lines = ['{', `"_meta":${JSON.stringify(d._meta)},`, '"rollCalls":['];
  d.rollCalls.forEach((r, i) => lines.push(JSON.stringify(r) + (i < d.rollCalls.length - 1 ? ',' : '')));
  lines.push('],', '"members":[');
  d.members.forEach((m, i) => lines.push(JSON.stringify(m) + (i < d.members.length - 1 ? ',' : '')));
  lines.push(']', '}');
  return lines.join('\n') + '\n';
}
const text = serialize(doc);
const verdict = verifyVotes({ data: JSON.parse(text), fileBytes: Buffer.byteLength(text), corpus, legislators, vacancies, now: now.getTime() });
for (const w of verdict.warnings) console.log(`::warning::sync-votes: ${w}`);
if (verdict.failures.length) {
  for (const f of verdict.failures) console.log(`::error::sync-votes (pre-write gate): ${f}`);
  console.log(`::error::sync-votes: the file this run built fails the gate — ${VOTES_PATH} NOT written.`);
  process.exit(1);
}

const h = stats.house;
const s = stats.senate;
/** Temp file + rename: a crash mid-write leaves the old file whole, never half
 *  of the new one. */
function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}
// A back-fill answers for the days it adds, before the file's old floor: a
// failure there (or a list it could not read) writes nothing. A failure on or
// after the old floor is the nightly's ordinary kind (a same-day Senate vote
// whose XML is not published yet): logged above, the cursor stops below it,
// the next run fetches it, and the run still exits 1.
const blockers = BACKFILL
  ? backfillExamined.flatMap((b) => backfillBlockers(b.examined, existing?._meta?.floor ?? null).map((roll) => rollCallId(b.chamber, CONGRESS, b.session, roll)))
  : [];
const backfillIncomplete = BACKFILL && (fatal || blockers.length > 0);
if (BACKFILL && !backfillIncomplete && h.failed + s.failed > 0) {
  console.log(`::warning::sync-votes: ${h.failed + s.failed} failed roll call(s) are on or after the old floor ${existing?._meta?.floor} — the nightly's to retry, and they do not hold back the back-fill`);
}
if (DRY_RUN) console.log(`--dry-run: nothing written${backfillIncomplete ? ` (and a real run would write nothing either: back-fill incomplete — ${blockers.join(', ') || 'a list could not be read'})` : ''}`);
else if (backfillIncomplete) {
  console.log(
    `::error::sync-votes: back-fill incomplete (${blockers.length ? `failed before the old floor: ${blockers.join(', ')}` : ''}${fatal ? `${blockers.length ? '; ' : ''}a list could not be read` : ''}) — ${VOTES_PATH} NOT written, so the floor stays ${existing?._meta?.floor ?? 'unset'}. ` +
      `Re-run the same command${CACHE_DIR ? ' (the cache keeps every record already fetched)' : ' with --cache-dir <dir> to keep what was fetched'}.`
  );
} else if (unchanged) console.log(`${VOTES_PATH}: no change`);
else if (ONLY_NEW_ROLLS && h.stored + s.stored === 0) {
  console.log(
    `${VOTES_PATH}: --only-new-rolls and no new roll call stored — the cursor-only change (house ${existing?._meta?.cursor?.house ?? '-'} -> ${cursor.house}, senate ${existing?._meta?.cursor?.senate ?? '-'} -> ${cursor.senate}) is NOT written; the nightly persists it`,
  );
} else writeAtomic(VOTES_PATH, text);
console.log(verdict.notes.join('\n'));
console.log(
  `DONE: House ${h.stored} stored (${h.refreshed} of them re-read to add the count by party; ${h.listed} listed, ${h.inWindow} in window, ${h.corpus} on corpus bills, ${h.viaClerk} via Clerk fallback, ${h.failed} failed); ` +
    `Senate ${s.stored} stored (${s.refreshed} of them re-read to add the count by party; ${s.listed} listed, ${s.inWindow} in window, ${s.corpus} on corpus bills, ${s.failed} failed); ` +
    `file ${list.length} roll call(s) across ${new Set(list.map((r) => r.bill)).size} bill(s), ${members.length} members; ` +
    `cursor house -> ${cursor.house}, senate -> ${cursor.senate}; floor ${floor}`
);
if (fatal || h.failed || s.failed) process.exit(1);

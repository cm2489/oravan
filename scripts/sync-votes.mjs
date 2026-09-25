/**
 * Nightly ROLL-CALL VOTE sync. Updates data/votes.json with every House and
 * Senate roll call whose vote question references a corpus bill, then CI
 * commits the diff.
 *
 *   node --env-file=.env.local scripts/sync-votes.mjs [--dry-run]
 *
 * Needs CONGRESS_API_KEY (House). NO Anthropic key, no AI, no spend: this is
 * the government's own record — question text, result, tally, and every
 * member's position — and nothing else. The parsing and the gate live in
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
 * LOOKBACK_DAYS (120) and fixes that date as `_meta.floor`; after that the
 * record only grows forward. A Senate cloture vote on the motion to proceed
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
 * ── COST ───────────────────────────────────────────────────────────────────
 * A normal night: 2 Congress.gov list requests + 2 per new House corpus roll
 * call, 1 senate.gov menu + 1 per new Senate corpus roll call. All free.
 * Requests are spaced THROTTLE_MS apart.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CONGRESS, cg } from './congress-fetch.mjs';
import {
  LOOKBACK_DAYS,
  VOTES_PATH,
  VOTES_SCHEMA,
  VoteParseError,
  compareRollCalls,
  congressFirstYear,
  legislationText,
  parseHouseApi,
  parseHouseClerkXml,
  parseSenateMenu,
  parseSenateXml,
  resolveBillId,
  rollCallId,
  sessionForYear,
  verifyVotes,
} from '../lib/votes-core.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
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
const floor =
  existing?._meta?.floor ??
  new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
const rollCalls = new Map((existing?.rollCalls ?? []).map((r) => [r.id, r]));
const roster = new Map((existing?.members ?? []).map((m) => [m.id, m]));
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

let upstreamLoaded = 0;
/** LIS id → bioguide. data/legislators.json first; on a miss (a senator
 *  sworn in since the weekly legislators refresh, or one who has left), the
 *  same public source that file is built from — current, then historical. */
async function ensureLis(lisIds) {
  while (lisIds.some((id) => !lisMap.has(id)) && upstreamLoaded < UPSTREAM_LEGISLATORS.length) {
    const src = UPSTREAM_LEGISLATORS[upstreamLoaded++];
    console.log(`  LIS id(s) ${lisIds.filter((id) => !lisMap.has(id)).join(', ')} not in data/legislators.json — reading ${src}`);
    for (const l of JSON.parse(await getText(src))) {
      if (l.id?.lis && l.id?.bioguide && !lisMap.has(l.id.lis)) lisMap.set(l.id.lis, l.id.bioguide);
    }
  }
}

const stats = {
  house: { listed: 0, inWindow: 0, corpus: 0, stored: 0, viaClerk: 0, failed: 0 },
  senate: { listed: 0, inWindow: 0, corpus: 0, stored: 0, failed: 0 },
};

function store(parsed, chamber) {
  const { roll, members } = parsed;
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
async function syncHouse(session) {
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
    if (rollCalls.has(id)) { examined.push({ roll: it.rollCallNumber }); continue; }
    try {
      let parsed;
      try {
        const base = `/house-vote/${CONGRESS}/${session}/${it.rollCallNumber}`;
        const detail = await congressGet(base);
        const members = await congressGet(`${base}/members`);
        parsed = parseHouseApi(detail, members, { corpus, sourceUrl: it.sourceDataURL });
      } catch (e) {
        if (e instanceof VoteParseError) throw e; // a shape we can't read is not a transport failure
        console.log(`  ${id}: Congress.gov failed (${e.message}) — falling back to the Clerk's XML`);
        parsed = parseHouseClerkXml(await getText(it.sourceDataURL), { corpus, sourceUrl: it.sourceDataURL });
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
    if (!v.date || v.date < floor) { examined.push({ roll: v.roll }); continue; }
    stats.senate.inWindow++;
    const id = rollCallId('senate', CONGRESS, session, v.roll);
    const menuBill = resolveBillId([v.issue, v.question], corpus, CONGRESS);
    if (!menuBill) { examined.push({ roll: v.roll }); continue; }
    stats.senate.corpus++;
    if (rollCalls.has(id)) { examined.push({ roll: v.roll }); continue; }
    const nnnnn = String(v.roll).padStart(5, '0');
    const url = `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${CONGRESS}${session}/vote_${CONGRESS}_${session}_${nnnnn}.xml`;
    try {
      const xml = await getText(url);
      await ensureLis([...xml.matchAll(/<lis_member_id>([^<]+)<\/lis_member_id>/g)].map((m) => m[1].trim()));
      const parsed = parseSenateXml(xml, { corpus, sourceUrl: url, lisToBioguide: (lis) => lisMap.get(lis) ?? null });
      if (!parsed.roll.bill) throw new VoteParseError(`the menu listed ${menuBill}, but the vote record names no corpus bill`);
      store(parsed, 'senate');
      examined.push({ roll: v.roll });
      console.log(`  ${id} ${parsed.roll.date} ${parsed.roll.bill}: ${parsed.roll.question} — ${parsed.roll.result}`);
    } catch (e) {
      stats.senate.failed++;
      examined.push({ roll: v.roll, failed: true });
      console.log(`::error::sync-votes: ${id} (${menuBill}) not stored — ${e.message}`);
    }
  }
  advance('senate', session, examined);
}

console.log(`sync-votes: ${CONGRESS}th Congress, session(s) ${sessions.join(', ')}, floor ${floor}, ${corpus.size} corpus bills, ${rollCalls.size} roll call(s) already held`);
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
if (DRY_RUN) console.log('--dry-run: nothing written');
else if (unchanged) console.log(`${VOTES_PATH}: no change`);
else if (ONLY_NEW_ROLLS && h.stored + s.stored === 0) {
  console.log(
    `${VOTES_PATH}: --only-new-rolls and no new roll call stored — the cursor-only change (house ${existing?._meta?.cursor?.house ?? '-'} -> ${cursor.house}, senate ${existing?._meta?.cursor?.senate ?? '-'} -> ${cursor.senate}) is NOT written; the nightly persists it`,
  );
} else writeFileSync(VOTES_PATH, text);
console.log(verdict.notes.join('\n'));
console.log(
  `DONE: House ${h.stored} stored (${h.listed} listed, ${h.inWindow} in window, ${h.corpus} on corpus bills, ${h.viaClerk} via Clerk fallback, ${h.failed} failed); ` +
    `Senate ${s.stored} stored (${s.listed} listed, ${s.inWindow} in window, ${s.corpus} on corpus bills, ${s.failed} failed); ` +
    `file ${list.length} roll call(s) across ${new Set(list.map((r) => r.bill)).size} bill(s), ${members.length} members; ` +
    `cursor house -> ${cursor.house}, senate -> ${cursor.senate}; floor ${floor}`
);
if (fatal || h.failed || s.failed) process.exit(1);

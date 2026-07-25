/**
 * Pure mapping logic for scripts/moment-updates.mjs — the Moments v2 live-layer
 * collector (docs/ideation/2026-07-25-moments-v2.md §5–§6).
 *
 * WHY THIS FILE EXISTS AS A SEPARATE MODULE (deviation from the slice brief,
 * deliberate): the brief named one file, `scripts/moment-updates.mjs`. That
 * file has to open data/, shell out to git, fetch Congress.gov, and construct
 * an Anthropic client at module scope — none of which a unit test may do
 * ("ZERO network in tests"). This repo already answers exactly that problem
 * the same way twice: scripts/newsdesk.mjs / scripts/newsdesk-match.mjs, and
 * scripts/check-moments.mjs / lib/moments-gate.mjs. So the runner keeps the
 * spec's filename and this module holds every pure transform the suite
 * exercises. Its imports are limited to two modules that are themselves
 * import-clean (newsdesk-match.mjs — node:crypto only; moment-updates-gate.mjs
 * — the v1 vocabulary table only), so the whole chain loads under Playwright's
 * transform.
 *
 * ---------------------------------------------------------------------------
 * THE EDITORIAL LAW (owner-settled 2026-07-25, v2 spec §2) — this module is
 * where SELECTION obeys it:
 *
 *   "Truth about the record, attribution about the spin. When the record
 *    speaks, we say it plainly — numbers, dates, tallies, text — even when
 *    plainness lands harder on one side. Balance is not achieved by blunting
 *    facts. When the record is silent — motive, likelihood, what it really
 *    means — Oravan's voice stops, and named sources speak or nobody does.
 *    Speculation never wears our voice."
 *
 * §2.5 — "what the lint cannot catch, the structure does" — is the clause this
 * file answers. The lint can police the WORDS of an update; only the selection
 * rule can police WHICH events become updates at all. So every selection
 * decision here is a declared, mechanical pattern (MILESTONE_PATTERNS,
 * classifyAction, the press-cluster lean rule) rather than a judgement call in
 * prose, and each one names the citizen-legible milestone it is matching. A
 * reader who disagrees with the selection can read the table.
 * ---------------------------------------------------------------------------
 */
import { findCitations, parseFeed } from './newsdesk-match.mjs';
import {
  RECORD_EVENT_CLASSES,
  TEXT_MAX_CHARS,
  computeUpdateId,
  etDay,
  normalizeText,
} from '../lib/moment-updates-gate.mjs';

/** The tracked Congress. Mirrors congress-fetch.mjs's CONGRESS — duplicated,
 *  not imported, to keep this module's import chain test-loadable; pinned
 *  equal by tests/moment-updates-collect.unit.spec.ts. */
export const CONGRESS = 119;

/* ------------------------------------------------------------------ *
 * Slug helpers.
 * ------------------------------------------------------------------ */

/** Congress.gov's URL path segment per bill type — mirrors
 *  congress-fetch.mjs's CHAMBER_PATHS (pinned equal by the unit suite). */
const CHAMBER_PATHS = {
  hr: 'house-bill',
  s: 'senate-bill',
  hjres: 'house-joint-resolution',
  sjres: 'senate-joint-resolution',
  hconres: 'house-concurrent-resolution',
  sconres: 'senate-concurrent-resolution',
};

/** Human citation form of a slug: 'hconres-89-119' -> 'H. Con. Res. 89'. */
const TYPE_LABELS = {
  hr: 'H.R.',
  s: 'S.',
  hjres: 'H.J.Res.',
  sjres: 'S.J.Res.',
  hconres: 'H. Con. Res.',
  sconres: 'S. Con. Res.',
};

export function billLabel(slug) {
  const [type, number] = String(slug ?? '').split('-');
  return `${TYPE_LABELS[type] ?? type?.toUpperCase() ?? ''} ${number ?? ''}`.trim();
}

export function congressGovUrlForSlug(slug) {
  const [type, number] = String(slug ?? '').split('-');
  return `https://www.congress.gov/bill/${CONGRESS}th-congress/${CHAMBER_PATHS[type] ?? 'house-bill'}/${number}`;
}

/** Congress.gov API path parts for a slug: {type, number}. */
export function slugParts(slug) {
  const [type, number] = String(slug ?? '').split('-');
  return { type, number };
}

/**
 * Every (momentId, vehicleSlug) pair the live layer is allowed to touch.
 *
 * Retired moments are excluded outright: v2 spec §4 deletes a retired
 * moment's updates rather than archiving them, so collecting new ones for a
 * retired moment would write rows the very next prune throws away — and the
 * gate fails a stored-retired entry anyway.
 *
 * @param {Record<string, any>} moments parsed data/moments.json
 * @returns {{momentId: string, slug: string}[]}
 */
export function momentVehicles(moments) {
  const out = [];
  for (const [momentId, moment] of Object.entries(moments ?? {})) {
    if (!moment || moment.status === 'retired') continue;
    for (const v of moment.vehicles ?? []) {
      if (v?.slug) out.push({ momentId, slug: v.slug });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * SELECTION — which government actions become updates (§2.5).
 * ------------------------------------------------------------------ */

/**
 * The citizen-legible milestones, as declared patterns over the government's
 * own verbatim action text. An action qualifies as an update when it carries
 * a roll call (always — a recorded vote is the record at its loudest) or when
 * its text matches one of these.
 *
 * Everything else on a bill's action list is procedural bookkeeping — debate
 * opening, the previous question, motions to reconsider laid on the table,
 * committee-referral duplicates. Those are not suppressed because they are
 * inconvenient; they are suppressed because rendering them would pad a
 * timeline with motion that is not movement, which is the exact failure mode
 * §3's "quiet day renders as a quiet day" promise exists to prevent. The
 * honest overflow line on the day still links to Congress.gov's full list, so
 * nothing here is hidden — it is unrendered, and one tap away.
 *
 * `key` is logged on every accepted action so a run's selection is auditable
 * after the fact.
 */
export const MILESTONE_PATTERNS = [
  // The bill physically moves between chambers, or lands at the desk.
  { key: 'chamber_transfer', re: /\breceived in the (senate|house)\b|\bheld at the desk\b/i },
  // Passage/adoption, including the voice-vote and unanimous-consent forms
  // that carry NO roll call and would otherwise be invisible.
  { key: 'passage', re: /\bpassed\/agreed to in\b|\bpassed (house|senate)\b|\bagreed to in (house|senate)\b/i },
  // The end of the road, in either direction.
  { key: 'enactment', re: /\bpresented to president\b|\bsigned by president\b|\bbecame public law\b|\bvetoed\b/i },
  // Scheduling: a calendar placement is the record saying "this can be called up".
  { key: 'calendar', re: /\bplaced on\b[^.]*\bcalendar\b|\bcalendar no\./i },
  { key: 'cloture', re: /\bcloture\b/i },
  // Committee milestones that actually move a bill.
  { key: 'committee_action', re: /\bordered to be reported\b|\breported by\b|\bdischarged\b|\bmark-?up session held\b/i },
];

/** The milestone key an action matches, or null when it is procedural noise. */
export function milestoneOf(action) {
  const text = String(action?.text ?? '');
  for (const { key, re } of MILESTONE_PATTERNS) {
    if (re.test(text)) return key;
  }
  return null;
}

/** Does this action carry a recorded vote? */
function rollCallOf(action) {
  const rv = Array.isArray(action?.recordedVotes) ? action.recordedVotes[0] : null;
  if (!rv || rv.rollNumber === undefined || rv.rollNumber === null) return null;
  const chamber = String(rv.chamber ?? '').toLowerCase();
  if (chamber !== 'house' && chamber !== 'senate') return null;
  return { chamber, number: Number(rv.rollNumber), url: typeof rv.url === 'string' ? rv.url : null };
}

/**
 * The update class of one Congress.gov action, or null when it does not
 * qualify (v2 spec §5).
 *
 *   recordedVotes present ......... 'vote'
 *   a MILESTONE_PATTERNS match .... 'floor_action'
 *   anything else ................. null
 *
 * `status_change` is NOT produced here: a status change is the DIFF of
 * data/bills.json across a run (statusDiffToCandidate), not a property of a
 * single action. Deriving it from an action list would mean re-running
 * mapStatus over history and guessing which action "caused" the stored
 * status — a guess, and the law says our voice stops where the record does.
 *
 * @param {Record<string, any>} action a Congress.gov /actions item
 * @returns {'vote'|'floor_action'|null}
 */
export function classifyAction(action) {
  if (rollCallOf(action)) return 'vote';
  return milestoneOf(action) ? 'floor_action' : null;
}

/* ------------------------------------------------------------------ *
 * Candidate builders. Every one of them returns a FULLY-FORMED update
 * except `text`, which the decode step fills in (and the fallback below
 * fills in when the decode is skipped or fails lint).
 * ------------------------------------------------------------------ */

const isoNow = (recordedAt) => (typeof recordedAt === 'string' ? recordedAt : new Date().toISOString());

/**
 * Attach the deterministic id the gate re-derives on read, and emit the keys
 * in the stored file's own order so a machine-written row and a hand-written
 * one diff cleanly against each other.
 */
function withId(momentId, update) {
  const id = computeUpdateId(momentId, update);
  const { class: klass, vehicle, day, occurred_at, occurred_precision, recorded_at, text, source, record, ai, ...rest } =
    update;
  return {
    id,
    class: klass,
    vehicle,
    day,
    occurred_at,
    occurred_precision,
    recorded_at,
    text,
    source,
    record,
    ai,
    ...rest,
  };
}

/**
 * One Congress.gov action -> one update candidate, or null.
 *
 * `day` is `actionDate` VERBATIM. Congress.gov supplies actionDate already
 * ET-derived (it is the legislative day, not a UTC bucket), so re-deriving it
 * from actionTime would be strictly worse: a 22:14 ET vote carries an 02:14Z
 * timestamp on the following UTC day. The gate enforces this for
 * source.kind === 'congress_actions'.
 *
 * The roll-call URL rides the payload and becomes a second ref — the
 * falsifiability §2.4 promises: one tap from our sentence to the tally.
 *
 * @param {{momentId: string, vehicle: string, action: Record<string, any>, billUrl?: string, recordedAt?: string}} args
 */
export function actionToCandidate({ momentId, vehicle, action, billUrl, recordedAt }) {
  const klass = classifyAction(action);
  if (!klass) return null;
  const day = String(action?.actionDate ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;

  const roll = rollCallOf(action);
  const refs = [billUrl ?? congressGovUrlForSlug(vehicle)];
  if (roll?.url && /^https:\/\//.test(roll.url)) refs.push(roll.url);

  const record = {
    action_text: String(action.text ?? '').trim(),
    action_code: action.actionCode ?? null,
    action_type: action.type ?? null,
    source_system: action.sourceSystem?.name ?? null,
  };
  if (roll) record.roll_call = { chamber: roll.chamber, number: roll.number };
  if (!record.action_text) return null;

  return withId(momentId, {
    class: klass,
    vehicle,
    day,
    occurred_at: day,
    occurred_precision: 'day',
    recorded_at: isoNow(recordedAt),
    text: null,
    source: { kind: 'congress_actions', refs },
    record,
    ai: false,
  });
}

/**
 * A vehicle whose stored status/last action changed between
 * `git show HEAD:data/bills.json` and the working file -> one status_change.
 *
 * The pre-state MUST come from HEAD: congress-fetch.mjs's refreshBillFields
 * mutates the corpus IN PLACE, so by the time this script runs the working
 * file already carries the new status and an in-memory "before" would be the
 * same object.
 *
 * The record here is the bill's own verbatim `last_action_text` — the
 * government's words, exactly as the actions endpoint supplied them to the
 * sync that wrote them.
 *
 * @param {{momentId: string, vehicle: string, before: Record<string, any>, after: Record<string, any>, billUrl?: string, recordedAt?: string}} args
 */
export function statusDiffToCandidate({ momentId, vehicle, before, after, billUrl, recordedAt }) {
  if (!before || !after) return null;
  // A CHANGE IS NOT AN EVENT. Firing on any last_action_text edit emitted
  // `status_change` rows carrying exactly the procedural bookkeeping
  // MILESTONE_PATTERNS exists to suppress — including rows where
  // status_from === status_to, a "status change" that changed no status.
  // Measured: 1,705 of 2,401 corpus bills carry a last_action_text that
  // milestoneOf() rejects, e.g. hconres-38-119's "Motion to reconsider laid
  // on the table Agreed to without objection." (pre-launch audit,
  // 2026-07-25). Two ways to earn a row: the status actually moved, or the
  // new action is a milestone in its own right — the same bar
  // actionToCandidate already applies via classifyAction.
  // Two gates, both required. First: something must have moved AT ALL — a
  // re-fetch that returns byte-identical data is not an event, whatever the
  // action text says.
  const changed =
    before.status !== after.status ||
    before.last_action_date !== after.last_action_date ||
    normalizeText(before.last_action_text) !== normalizeText(after.last_action_text);
  if (!changed) return null;

  // Second: what moved must be worth a row.
  const statusMoved = before.status !== after.status;
  const isMilestone = Boolean(milestoneOf({ text: after.last_action_text }));
  if (!statusMoved && !isMilestone) return null;

  const day = String(after.last_action_date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const actionText = String(after.last_action_text ?? '').trim();
  if (!actionText) return null;

  return withId(momentId, {
    class: 'status_change',
    vehicle,
    day,
    occurred_at: day,
    occurred_precision: 'day',
    recorded_at: isoNow(recordedAt),
    text: null,
    source: { kind: 'congress_actions', refs: [billUrl ?? congressGovUrlForSlug(vehicle)] },
    record: {
      action_text: actionText,
      action_code: null,
      // Not an invented label: this IS the field name Congress.gov's bill
      // detail payload uses for the text we are quoting.
      action_type: 'latestAction',
      source_system: 'Congress.gov bill detail',
      status_from: before.status ?? null,
      status_to: after.status ?? null,
    },
    ai: false,
  });
}

/* ------------------------------------------------------------------ *
 * Tier-0 government feeds -> `scheduled` (v2 spec §5).
 * ------------------------------------------------------------------ */

const unwrapCdata = (s) => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();

/** The channel's own <title>, verbatim — the feed naming itself. */
function channelTitle(xml) {
  const m = String(xml ?? '').match(/<channel[^>]*>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? unwrapCdata(m[1]) : null;
}

/**
 * title -> description for RSS items. parseFeed deliberately does not carry
 * <description> (nothing in the newsdesk pipeline needed it), and the floor
 * feeds put the bill's short title and date there — the only part of the
 * listing that is legible to a reader. Keyed by title so parseFeed stays the
 * single owner of block splitting, citation extraction, and entity decoding.
 */
function descriptionsByTitle(xml) {
  const out = new Map();
  for (const m of String(xml ?? '').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const body = m[1] ?? '';
    const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    const description = body.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1];
    if (title && description) out.set(unwrapCdata(title), unwrapCdata(description));
  }
  return out;
}

/**
 * house-floor-today / senate-floor-today items, WITH the verbatim label a
 * slug-only parser cannot carry.
 *
 * Composed from newsdesk-match.mjs's own exported `parseFeed` + `findCitations`
 * — no parsing logic is duplicated. The slug set this returns is pinned equal
 * to `extractFloorFeedSlugs`'s output by the unit suite, so the two can never
 * drift into disagreeing about which bills a feed names.
 *
 * @param {string} xml
 * @returns {{slug: string, label: string, description: string|null, link: string|null, feedTitle: string|null}[]}
 */
export function floorTodayItems(xml) {
  const feedTitle = channelTitle(xml);
  const descriptions = descriptionsByTitle(xml);
  const out = [];
  const seen = new Set();
  for (const item of parseFeed(xml)) {
    const title = String(item.title ?? '').trim();
    for (const c of findCitations(title)) {
      if (seen.has(c.slug)) continue;
      seen.add(c.slug);
      out.push({
        slug: c.slug,
        label: title,
        description: descriptions.get(title) ?? null,
        link: typeof item.link === 'string' ? item.link : null,
        feedTitle,
      });
    }
  }
  return out;
}

/**
 * docs.house.gov weekly floorschedule <floor-item> rows.
 *
 * The `<legis-num>` scan mirrors extractBillsThisWeekSlugs' own regex (pinned
 * slug-for-slug against it by the unit suite); this walks the enclosing
 * <floor-item> so the item's `<floor-text>`, its `add-date`, and the enclosing
 * `<category type=…>` come along — all three are verbatim government strings
 * and all three are needed to state honestly WHAT was scheduled and WHEN it
 * was put on the schedule.
 *
 * `addDate` is used DATE-PART ONLY. docs.house.gov stamps these without a
 * timezone offset and they are House (Eastern) local; parsing one as an
 * instant would let a 02:00 addition file itself on the previous ET day.
 *
 * @param {string} xml
 * @returns {{slug: string, legisNum: string, floorText: string|null, addDate: string|null, category: string|null, weekDate: string|null}[]}
 */
export function floorScheduleItems(xml) {
  const src = String(xml ?? '');
  const weekDate = src.match(/\bweek-date="([^"]+)"/i)?.[1] ?? null;
  const out = [];
  let category = null;
  const blocks = src.matchAll(/<category\b[^>]*\btype="([^"]*)"[^>]*>|<floor-item\b([^>]*)>([\s\S]*?)<\/floor-item>/gi);
  for (const m of blocks) {
    if (m[1] !== undefined) {
      category = m[1].trim();
      continue;
    }
    const attrs = m[2] ?? '';
    const body = m[3] ?? '';
    const legisNum = body.match(/<legis-num>([\s\S]*?)<\/legis-num>/i)?.[1];
    if (!legisNum) continue;
    const citations = findCitations(legisNum);
    if (citations.length === 0) continue;
    const floorText = body.match(/<floor-text>([\s\S]*?)<\/floor-text>/i)?.[1];
    out.push({
      slug: citations[0].slug,
      legisNum: legisNum.trim(),
      floorText: floorText ? floorText.trim() : null,
      addDate: (attrs.match(/\badd-date="([^"]+)"/i)?.[1] ?? '').slice(0, 10) || null,
      category,
      weekDate,
    });
  }
  return out;
}

/**
 * A tier-0 feed listing -> one `scheduled` candidate.
 *
 * `scheduled` is the one class whose record is a LISTING rather than an
 * action, so the verbatim text is assembled from the feed's own strings and
 * nothing else. Nowhere does this claim a vote will happen — §9.5: nothing
 * claims a date the record does not support. The record says "this bill is on
 * this schedule document"; that is exactly what the update says.
 *
 * @param {{momentId: string, vehicle: string, day: string, actionText: string, actionType?: string|null, sourceSystem: string, refs: string[], recordedAt?: string}} args
 */
export function scheduledToCandidate({
  momentId,
  vehicle,
  day,
  actionText,
  actionType = null,
  sourceSystem,
  refs,
  recordedAt,
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day ?? ''))) return null;
  const text = String(actionText ?? '').trim();
  if (!text) return null;
  const httpsRefs = (refs ?? []).filter((r) => typeof r === 'string' && /^https:\/\//.test(r));
  if (httpsRefs.length === 0) return null;

  return withId(momentId, {
    class: 'scheduled',
    vehicle,
    day,
    occurred_at: day,
    occurred_precision: 'day',
    recorded_at: isoNow(recordedAt),
    text: null,
    source: { kind: 'tier0_feed', refs: httpsRefs },
    record: {
      action_text: text,
      action_code: null,
      action_type: actionType,
      source_system: sourceSystem,
    },
    ai: false,
  });
}

/* ------------------------------------------------------------------ *
 * Press clusters (nightly) — the one class whose record is null.
 * ------------------------------------------------------------------ */

/**
 * Reduce an API source to a bare lowercase domain.
 *
 * DRIFT PIN: this is character-for-character the behaviour of
 * lib/coverage.ts's `normalizeSource`. It is duplicated rather than imported
 * because an .mjs script cannot import TypeScript, and the two are asserted
 * equal over a shared input table in tests/moment-updates-collect.unit.spec.ts
 * — the same "one copy, or a test that proves the copies agree" discipline
 * check-moments.mjs applies to TERMINAL_VEHICLE_STATUSES. If the coverage
 * matcher ever changes, that test goes red before a cluster can be attributed
 * to the wrong outlet.
 */
export function normalizeSource(source) {
  return (source ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

/** AllSides lean for a source, or null when the outlet is unrated. */
export function leanOf(source, leanByDomain) {
  return (leanByDomain ?? {})[normalizeSource(source)] ?? null;
}

/**
 * Is this set of outlet leans publishable as a cluster?
 *
 * The rule is lib/coverage.ts's `coverageTier` verbatim in effect: a cluster
 * whose partisan leans are all on ONE side is 'one_sided' and is dropped, the
 * same way rankNews drops one-sided coverage from discovery. Cross-spectrum
 * and lean-free clusters publish. Never a single-lean channel (v2 spec §5) —
 * which is the whole reason press is allowed on the timeline at all.
 *
 * @param {(string|null)[]} leans
 */
export function clusterIsPublishable(leans) {
  const partisan = new Set((leans ?? []).filter((l) => l === 'left' || l === 'right'));
  return partisan.size !== 1;
}

/**
 * Display names for the outlets the pipeline actually sees. Domains not
 * listed fall back to the domain with its TLD dropped and its first letter
 * capitalized — deterministic, never invented, and the attribution lint
 * checks the update text against whatever this returns, so a fallback name
 * simply means the one-liner must use the fallback spelling.
 */
const OUTLET_DISPLAY_NAMES = {
  'thehill.com': 'The Hill',
  'rollcall.com': 'Roll Call',
  'npr.org': 'NPR',
  'foxnews.com': 'Fox News',
  'cbsnews.com': 'CBS News',
  'politico.com': 'Politico',
  'apnews.com': 'The Associated Press',
  'reuters.com': 'Reuters',
  'nytimes.com': 'The New York Times',
  'washingtonpost.com': 'The Washington Post',
  'wsj.com': 'The Wall Street Journal',
  'usatoday.com': 'USA Today',
  'nbcnews.com': 'NBC News',
  'abcnews.go.com': 'ABC News',
  'cnn.com': 'CNN',
  'axios.com': 'Axios',
  'bloomberg.com': 'Bloomberg',
  'pbs.org': 'PBS',
  'propublica.org': 'ProPublica',
};

export function outletDisplayName(domain) {
  const d = normalizeSource(domain);
  if (OUTLET_DISPLAY_NAMES[d]) return OUTLET_DISPLAY_NAMES[d];
  const stem = d.split('.')[0] ?? d;
  return stem ? stem.charAt(0).toUpperCase() + stem.slice(1) : d;
}

/**
 * One (vehicle, day) group of coverage.json articles -> one press_cluster, or
 * null when it fails the inherited guardrail.
 *
 * Requirements, all inherited rather than invented: ≥2 DISTINCT normalized
 * outlet domains, never a single-lean set, ≥2 https refs, `record: null`, and
 * `outlet_names` populated so the attribution lint has something to check the
 * text against. "When the record is silent … named sources speak or nobody
 * does."
 *
 * @param {{momentId: string, vehicle: string, day: string, articles: {url?: string, source?: string}[], leanByDomain?: Record<string,string>, recordedAt?: string}} args
 */
export function pressClusterToCandidate({ momentId, vehicle, day, articles, leanByDomain, recordedAt }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day ?? ''))) return null;

  /** @type {Map<string, string>} domain -> first https url */
  const byDomain = new Map();
  for (const a of articles ?? []) {
    const domain = normalizeSource(a?.source);
    const url = typeof a?.url === 'string' && /^https:\/\//.test(a.url) ? a.url : null;
    if (!domain || !url) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, url);
  }
  if (byDomain.size < 2) return null;

  const outlets = [...byDomain.keys()].sort();
  const leans = outlets.map((d) => leanOf(d, leanByDomain));
  if (!clusterIsPublishable(leans)) return null;

  return withId(momentId, {
    class: 'press_cluster',
    vehicle,
    day,
    occurred_at: day,
    occurred_precision: 'day',
    recorded_at: isoNow(recordedAt),
    text: null,
    source: {
      kind: 'press',
      refs: outlets.map((d) => byDomain.get(d)),
      outlets,
      outlet_names: outlets.map(outletDisplayName),
      leans: [...new Set(leans.filter(Boolean))].sort(),
    },
    record: null,
    ai: false,
  });
}

/* ------------------------------------------------------------------ *
 * Collector-level suppression (the gate handles the rest).
 * ------------------------------------------------------------------ */

/**
 * Drop a `status_change` whose verbatim record text is already carried by a
 * richer record-class event in the same (vehicle, day).
 *
 * The diff of data/bills.json and the actions endpoint see the SAME event
 * from two angles: the diff knows only `last_action_text`, while the action
 * carries the code, the type, and the roll call. Storing both would render
 * one event twice on one day and burn two of that day's five render slots on
 * a single fact — which is padding, and padding is the thing this product
 * refuses to do. The action wins because it is the richer record.
 *
 * Pure: neither the array nor its members are mutated.
 */
export function suppressRedundantStatusChanges(candidates) {
  const richTextByBucket = new Map();
  for (const c of candidates ?? []) {
    if (c?.class === 'status_change' || !RECORD_EVENT_CLASSES.includes(c?.class)) continue;
    const key = `${c.vehicle}|${c.day}`;
    if (!richTextByBucket.has(key)) richTextByBucket.set(key, new Set());
    richTextByBucket.get(key).add(normalizeText(c.record?.action_text));
  }
  return (candidates ?? []).filter((c) => {
    if (c?.class !== 'status_change') return true;
    const key = `${c.vehicle}|${c.day}`;
    return !richTextByBucket.get(key)?.has(normalizeText(c.record?.action_text));
  });
}

/* ------------------------------------------------------------------ *
 * The non-AI fallback text.
 * ------------------------------------------------------------------ */

/**
 * The verbatim record, wrapped as a QUOTATION — the text an update carries
 * when the AI decode is skipped (batch cap) or its output failed the lint.
 *
 * Quoting is not cosmetic. The inherited vocabulary lint exempts quoted spans
 * (lib/moments-gate.mjs's stripQuoted, added so an official title like the
 * "Stop Harmful Schemes Act" cannot trip the advocacy list), and a verbatim
 * government sentence genuinely IS a quotation rather than Oravan's voice —
 * "SAVE America Act" appears in real action text and would otherwise fail the
 * `save` rule on the fallback path and redden CI on a nightly commit. So the
 * fallback quotes, and the quotation marks are honest typography for what the
 * string is.
 *
 * Inner double quotes are downgraded to single quotes so the exemption span
 * cannot be broken mid-string, and an over-long record is cut with an ellipsis
 * INSIDE the quote, which reads as the truncation it is.
 */
export function quotedRecordText(actionText) {
  const cleaned = String(actionText ?? '')
    .replace(/\s+/g, ' ')
    .replace(/["“”]/g, "'")
    .trim();
  if (!cleaned) return '';
  const budget = TEXT_MAX_CHARS - 2; // the two quote marks
  const body = cleaned.length > budget ? `${cleaned.slice(0, budget - 1).trimEnd()}…` : cleaned;
  return `“${body}”`;
}

/**
 * The bilingual fallback for one candidate.
 *
 * Record classes get the quoted record in BOTH languages. That is a
 * deliberately degraded state, and an honest one: the record is in English
 * and Oravan does not machine-translate the government's words into a
 * quotation it would then be attributing to the government. The runner logs
 * every use of this path loudly, `ai` stays false, and the next run's decode
 * replaces it.
 *
 * A press cluster has no record to quote, so its fallback is a flat,
 * attributed count of the outlets in the cluster — which satisfies the
 * attribution lint in both languages by construction.
 */
export function fallbackTextFor(candidate) {
  if (candidate?.class === 'press_cluster') {
    const names = candidate.source?.outlet_names ?? [];
    const label = billLabel(candidate.vehicle);
    const [a, b] = names;
    const more = names.length > 2 ? ` (+${names.length - 2})` : '';
    return {
      en: `${a} and ${b}${more} published coverage of ${label}.`,
      es: `${a} y ${b}${more} publicaron cobertura sobre ${label}.`,
    };
  }
  const quoted = quotedRecordText(candidate?.record?.action_text);
  return { en: quoted, es: quoted };
}

/* ------------------------------------------------------------------ *
 * Ceilings.
 * ------------------------------------------------------------------ */

/**
 * How many updates the stored file already recorded on one UTC day, counted
 * from `recorded_at`.
 *
 * UTC, not ET, and deliberately: this is a SPEND ceiling, not a legislative
 * fact. It bounds how much a runner may do in a calendar day of machine time,
 * and it is read straight off the committed file so no new Actions cache has
 * to exist for it to hold across runs.
 */
export function dailyEventCount(store, utcDay) {
  let n = 0;
  for (const [key, entry] of Object.entries(store ?? {})) {
    if (key === '_meta') continue;
    for (const u of entry?.updates ?? []) {
      if (String(u?.recorded_at ?? '').slice(0, 10) === utcDay) n++;
    }
  }
  return n;
}

/** ET day of an instant — re-exported so the runner has one time source. */
export { etDay };

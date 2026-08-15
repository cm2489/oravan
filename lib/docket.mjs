/*
 * THE DOCKET LADDER — the ONE ordering for every surface that asks "what is
 * Congress deciding right now", and the replacement for the scalar
 * `effectiveUrgency` cut that used to answer it.
 *
 * ---- WHY A LADDER RATHER THAN A SCORE ------------------------------------
 * `effectiveUrgency` is a real function and it stays exactly where it is —
 * lib/urgency.mjs, unchanged, still the coverage sweep's and the MCP teaser's
 * `urgency_score`. What it cannot do is answer this question, and the corpus
 * proved it three ways in the same fortnight (all measured; see the PR body):
 *
 *   1. IT PROMOTED DEFEATS. A cloture vote that FAILED 52-46 held rank 2 of
 *      the homepage shortlist for four days, because `floor_vote` is a keyword
 *      bucket and 0.9 + a freshness bonus outranks everything. #215 patched
 *      that with a settled guard; the guard is kept below, as a rung.
 *   2. IT COULD NOT SEE THE WEEK'S BIGGEST BILLS. When a measure actually
 *      reaches the floor, Congress OVERWRITES `last_action_text` — "Message on
 *      Senate action sent to the House." — and the derived status falls back
 *      to `committee` (base 0.45). On 2026-08-07 the continuing resolution and
 *      the SEED Act, the two hottest vehicles in the country, were structurally
 *      invisible to a status-based ranking on the days they passed.
 *   3. ITS BANDS TIED. Every bill in a busy week scores 0.95, so the band
 *      floors (lib/taxonomy.ts's `bandFloors`, retired by this change) read a
 *      tie block and the middle band vanished — a bug that had already needed
 *      two reversals and one repair.
 *
 * A rung is not a score. It is a SENTENCE FROM THE RECORD, and every surface
 * that shows a bill can print the sentence that put it there.
 *
 * ---- THE RUNGS ------------------------------------------------------------
 *   T0 ANNOUNCED   The chamber ITSELF named this measure for floor action, in
 *                  its own published words: the House's weekly floor schedule
 *                  (docs.house.gov/billsthisweek) or the Senate's "Program
 *                  for" block in the Daily Digest. Read from
 *                  data/floor-signals.json, rewritten hourly.
 *                  ADMITS ANY STATUS — that is the whole point of (2) above.
 *   T1 VOTE AHEAD  The record says a floor vote is ripening: cloture presented,
 *                  a motion to proceed made, proceedings postponed, a rule
 *                  reported — plus the two rungs the backtest measured as
 *                  missing (see `entersFloorWatch`). Dated inside the signal
 *                  window.
 *   T2 QUEUED      A dated calendar placement, inside the signal window.
 *   T3 ADVANCING   Cleared a real gate recently: passed a chamber, or a markup.
 *   T4 RADAR       Everything else, including terminal bills and — deliberately
 *                  — every measure whose floor question the record has already
 *                  ANSWERED, which is carried as an annotation rather than a
 *                  rung (see `docketRung`).
 *
 * ---- WHAT THIS MODULE MAY NEVER DO ----------------------------------------
 * 1. CLAIM A VOTE DATE. Nothing here reads or produces one. T0 carries the
 *    announcement's own printed dates and nothing else (DESIGN.md's ⚠ ruling).
 * 2. LET A NEWS SIGNAL IN. Every input is Congress's own publication, so no
 *    outside actor can move any ranking at any price (decision of record,
 *    2026-07-31: proximity ranks, volume never does).
 * 3. GO STALE SILENTLY. A T0 signal is only live while the file that carries
 *    it was refreshed recently AND the writer re-observed it this run — see
 *    `signalIsLive`.
 *
 * ---- WHY .mjs -------------------------------------------------------------
 * Same door pattern as lib/urgency.mjs + lib/signal-window.ts: the ladder is
 * read by the React site (through lib/docket.ts, which adds the types and the
 * data import) AND by two node scripts that cannot import TypeScript —
 * scripts/sync-coverage.mjs's head order and scripts/moment-candidates.mjs's
 * comparator. One definition, three callers, no hand-copied twin.
 */
import { FLOOR_SETTLED, floorCalendarChamber } from './floor-text.mjs';
import { TERMINAL_STATUSES, isSignalFresh } from './urgency.mjs';

/** The rungs, loudest first. Array order IS the ranking order. */
export const DOCKET_TIERS = /** @type {const} */ (['t0', 't1', 't2', 't3', 't4']);

/**
 * RUNG -> BAND. The /bills bands stop being percentile cuts and become facts:
 *
 *   Deciding now  T0 ∪ T1 — the chamber named it, or the record says a vote is
 *                 ripening. This is also the act-now pool: one definition of
 *                 "worth a call this week" for the homepage shortlist, the
 *                 /bills lead band, the MCP tool and the feeds, so the site
 *                 cannot contradict itself across one click (the AE3
 *                 equivalence lib/core/bills.ts's `hasActNow` owes /bills).
 *   Moving        T2 ∪ T3 — queued, or it just cleared a gate. T3 is here on
 *                 the critic's A-3 patch: a bill that passed a chamber five
 *                 days ago reading "quieter right now" was a semantic
 *                 regression, and on the day the CR passed the Senate 90-6 the
 *                 old floors dropped it to the radar band.
 *   On the radar  T4, and every terminal bill, pinned.
 */
export const TIER_BAND = /** @type {Record<string, 'now'|'moving'|'radar'>} */ ({
  t0: 'now',
  t1: 'now',
  t2: 'moving',
  t3: 'moving',
  t4: 'radar',
});

/**
 * How old data/floor-signals.json may be before its T0 claims stop counting.
 *
 * The file is rewritten hourly and COMMITTED (owner ruling V5), and the site is
 * statically generated from it — so between builds the page cannot re-check
 * anything, and a workflow that quietly dies would otherwise keep the crown
 * quoting a schedule from whenever it last ran. 48 hours is past a weekend
 * hiccup and well short of a stale claim; the same fail-toward-quiet discipline
 * `isSignalFresh` uses for the 14-day window.
 */
export const SIGNAL_STALE_HOURS = 48;

/**
 * THE T1 RUNG — "the record says a vote is ripening" — and the two sentences
 * it admits that `floorPendingChamber` does not.
 *
 * floorPendingChamber gates the CROWN's claim that a vote is still ahead, and
 * it is deliberately a narrow allow-list: the loudest surface on the site fails
 * closed. This gates a RANKING POSITION, where the cost of a miss is the
 * opposite one — the backtest measured both misses, on the two biggest bills of
 * the fortnight:
 *
 *   "Motion to proceed to measure considered in Senate" (H.R. 6500, the
 *   continuing resolution, 2026-08-04) matched neither pending nor calendar, so
 *   the ladder dropped the CR for two days WHILE IT WAS BEING DEBATED ON THE
 *   SENATE FLOOR, and fell back to a nine-day-old NDAA motion.
 *
 *   "Cloture ... invoked" (H.R. 5334, 2026-07-28) was neither pending nor
 *   settled, so the SEED Act vanished between its 86-12 cloture vote and its
 *   86-11 passage — and the sync had meanwhile derived its status back down to
 *   `committee` off "Measure laid before Senate by motion".
 *
 * Both added sentences are Congress saying the measure is PHYSICALLY ON THE
 * FLOOR, which is strictly further along than "a vote is pending". The settled
 * guard runs first here exactly as it does there, so "cloture ... not invoked"
 * is rejected before the "cloture ... invoked" rule can see it.
 *
 * This is also the predicate scripts/floor-signals-parse.mjs's re-decode queue
 * reads, so "entering the floor watch" means one thing in the ranking and in
 * the decode trigger.
 *
 * @param {string | null | undefined} actionText
 * @returns {boolean}
 */
export function entersFloorWatch(actionText) {
  const t = String(actionText ?? '');
  if (!t) return false;
  if (FLOOR_SETTLED.test(t)) return false;
  return (
    /cloture motion .*presented in senate/i.test(t) ||
    /motion to proceed to consideration of (?:the )?measure made in senate/i.test(t) ||
    /postponed proceedings/i.test(t) ||
    /rules committee resolution .*reported to house/i.test(t) ||
    /cloture .*invoked/i.test(t) ||
    /motion to proceed to (?:the )?measure considered in senate/i.test(t) ||
    /measure laid before senate/i.test(t)
  );
}

/**
 * HAS THE FLOOR ALREADY ANSWERED — the annotation, never a rung.
 *
 * Identical vocabulary to lib/core/bills.ts's `isSettledFloor` (#215), which
 * now calls this one rather than keeping its own body. A defeated motion is a
 * genuine, high-signal floor event and it stays on /bills, in search and on its
 * own page — what it may never be is "worth a call this week", because the
 * question a call would answer has been answered.
 *
 * @param {{ status?: string, last_action_text?: string | null }} bill
 * @returns {boolean}
 */
export function isSettledFloor(bill) {
  if (bill?.status !== 'floor_vote') return false;
  if (!FLOOR_SETTLED.test(bill.last_action_text ?? '')) return false;
  // A dated calendar placement is a live fact whatever else its sentence says.
  return floorCalendarChamber(bill.last_action_text ?? null) === null;
}

/**
 * IS THIS T0 SIGNAL STILL A STATEMENT ABOUT THIS WEEK?
 *
 * Three conditions, and every one of them is critic A-1 ("a Thursday crown
 * quoting Monday's listing for a pulled bill is a false claim in the loudest
 * surface"):
 *
 *   1. `stale !== true` — the writer re-observed this measure on its last
 *      successful fetch. A bill pulled from the schedule is dropped wholesale
 *      within the hour by `mergeSignals`; anything carried forward through a
 *      dark source is marked stale and may rank but never crown.
 *   2. the FILE was refreshed inside SIGNAL_STALE_HOURS — a dead workflow
 *      cannot keep asserting a schedule.
 *   3. the announcement's own horizon (`covers`) has not passed. The House
 *      schedule covers its week, the Senate program its next meeting; a week
 *      later it is a record of what happened, not a schedule.
 *
 * @param {any} signal
 * @param {{ fetchedAt?: string | null, now?: number }} [ctx]
 * @returns {boolean}
 */
export function signalIsLive(signal, ctx) {
  const { fetchedAt = null, now = Date.now() } = ctx ?? {};
  if (!signal || !signal.tier0) return false;
  if (signal.stale === true) return false;
  const stamp = Date.parse(signal.fetched_at ?? fetchedAt ?? '');
  if (!Number.isFinite(stamp)) return false;
  if (now - stamp > SIGNAL_STALE_HOURS * 3_600_000) return false;
  const covers = signal.tier0.covers;
  if (typeof covers === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(covers)) {
    const horizonDays = signal.tier0.source === 'billsthisweek' ? 7 : 2;
    const ends = Date.parse(`${covers}T00:00:00Z`) + horizonDays * 86_400_000;
    if (Number.isFinite(ends) && ends < now) return false;
  }
  return true;
}

/**
 * IS THIS CHAMBER MEETING — the `_meta.in_session` half of the signal file,
 * read the way every other T0 claim is read: only while the file itself is
 * fresh, and only when the stored word is one this build understands.
 *
 * THREE WAYS TO GET `unknown`, and all three are the same discipline
 * (critic A-5: our own outage may never render as a fact about Congress):
 *   1. the file was last refreshed more than SIGNAL_STALE_HOURS ago — a dead
 *      workflow cannot keep asserting that the Senate is in session;
 *   2. the stored value is not one of the three literals — a future writer's
 *      new vocabulary reads as "we don't know", never as a chamber verdict;
 *   3. the field, the chamber's key, or the file itself is absent.
 *
 * KEYED BY CHAMBER, NEVER ITERATED. `_meta.in_session` carries a third key,
 * `basis`, whose value is the sentence naming the document the verdict came
 * out of — so anything that walks the object's values instead of asking for
 * `senate` or `house` picks up a prose string as if it were a session verdict.
 * The literal guard would catch it; asking by name means it never arises.
 *
 * @param {any} meta  data/floor-signals.json's `_meta`
 * @param {'house' | 'senate'} chamber
 * @param {number} [now]
 * @returns {'in_session' | 'out_of_session' | 'unknown'}
 */
export function chamberSessionFrom(meta, chamber, now = Date.now()) {
  const stamp = Date.parse(meta?.fetched_at ?? '');
  if (!Number.isFinite(stamp) || now - stamp > SIGNAL_STALE_HOURS * 3_600_000) return 'unknown';
  const value = meta?.in_session?.[chamber];
  return value === 'in_session' || value === 'out_of_session' ? value : 'unknown';
}

/**
 * WHEN DOES THIS CHAMBER MEET NEXT — the digest's own printed label, and the
 * date derived from it, or null.
 *
 * Null on every shape that is not a claim about a meeting still ahead: no
 * entry at all, a stored date that is not a usable YYYY-MM-DD (the writer
 * derives that date by filling the year in, so a malformed one is arithmetic
 * that failed and is distrusted whole), and a date whose day is already over.
 * A meeting is "ahead" through the END of the day it falls on — a 9 a.m.
 * Thursday sitting is still the next meeting at noon on Thursday.
 *
 * A label with no derivable date is kept (`iso: null`): the document's own
 * sentence is the evidence, and the derived date is the convenience.
 *
 * @param {any} meta  data/floor-signals.json's `_meta`
 * @param {'house' | 'senate'} chamber
 * @param {number} [now]
 * @returns {{ iso: string | null, label: string | null } | null}
 */
export function chamberNextMeetingFrom(meta, chamber, now = Date.now()) {
  const entry = meta?.next_meeting?.[chamber];
  if (!entry || typeof entry !== 'object') return null;
  const rawDate = entry.date ?? null;
  const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : null;
  if (rawDate !== null && rawDate !== undefined) {
    if (typeof rawDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return null;
    const endOfDay = Date.parse(`${rawDate}T00:00:00Z`) + 86_400_000;
    if (!Number.isFinite(endOfDay) || endOfDay < now) return null;
    return { iso: rawDate, label };
  }
  return label ? { iso: null, label } : null;
}

/**
 * SIGNIFICANCE INSIDE T0 (critic A-2), in each chamber's own dialect.
 *
 * A 30-bill Monday puts the continuing resolution and a post-office renaming on
 * the same rung with the same date, and a date-then-slug tiebreak would hand
 * the crown to whichever is alphabetically earlier. Neither chamber leaves us
 * guessing, and neither is being second-guessed here — both keys are the
 * document's own structure:
 *
 *   HOUSE   `<category type="Items that may be considered pursuant to a rule">`
 *           vs "…under suspension of the rules". A rule-governed bill is the
 *           week's real business; the suspension calendar is the consent
 *           agenda.
 *   SENATE  the verb in the program sentence: "the Senate will vote on ..."
 *           outranks "will resume consideration of ...", which outranks a
 *           conditional "If cloture is invoked, ...".
 *
 * Lower is louder. `unspecified` sits between the two so an unknown heading is
 * never promoted above a stated rule nor buried under a stated suspension.
 *
 * @param {any} tier0
 * @returns {number}
 */
export function t0Weight(tier0) {
  const track = tier0?.track ?? 'unspecified';
  const certainty = tier0?.certainty ?? 'consideration';
  if (certainty === 'scheduled_vote') return 0;
  if (track === 'rule') return 1;
  if (certainty === 'conditional') return 4;
  if (track === 'suspension') return 3;
  return 2;
}

/** A bill-and-time announcement beats a week-list one on an exact tie. */
const SOURCE_RANK = { 'daily-digest': 0, billsthisweek: 1 };

/**
 * THE ONE DERIVATION. Which rung does this bill stand on, and what sentence
 * put it there?
 *
 * `signal` is data/floor-signals.json's entry for this bill, or null. Passed in
 * rather than looked up so this module keeps zero data imports (lib/docket.ts
 * and the two scripts each supply it from their own read of the file).
 *
 * ORDER IS THE RULE. Terminal first (a signed law is not a floor event, and no
 * announcement can make it one again); T0 next and unconditionally, because the
 * chamber's own schedule outranks whatever the action text has decayed into;
 * then the record's own sentences, strongest first.
 *
 * @param {{ status?: string, last_action_text?: string | null, last_action_date?: string | null }} bill
 * @param {any} signal
 * @param {{ now?: number }} [ctx]
 * @returns {{ tier: string, annotation: string | null, terminal: boolean, weight: number, source: string | null, announced: any }}
 */
export function docketRung(bill, signal, ctx) {
  const now = ctx?.now ?? Date.now();
  const status = bill?.status ?? '';
  const text = bill?.last_action_text ?? null;
  const date = bill?.last_action_date ?? null;
  const base = { annotation: null, terminal: false, weight: 0, source: null, announced: null };

  if (TERMINAL_STATUSES.has(status)) {
    return { ...base, tier: 't4', terminal: true };
  }
  if (signalIsLive(signal, { now })) {
    return {
      ...base,
      tier: 't0',
      weight: t0Weight(signal.tier0),
      source: signal.tier0.source ?? null,
      announced: signal.tier0,
    };
  }
  const fresh = isSignalFresh(date, now);
  if (fresh && entersFloorWatch(text)) return { ...base, tier: 't1' };
  if (fresh && floorCalendarChamber(text)) return { ...base, tier: 't2' };
  if (fresh && (status === 'passed_chamber' || status === 'markup')) {
    /*
     * THE JUST-PASSED ANNOTATION (backtest K3). On 2026-08-08 the Senate passed
     * the continuing resolution 90-6 — the week's biggest story in national
     * politics — and the old floors moved it to "On the radar" the same day,
     * because `passed_chamber` scores 0.75 and the now-floor sat at 0.95. T3
     * keeps it in Moving; the annotation is what lets a surface say the true and
     * more useful thing, which is that it just passed and the other chamber is
     * next. The annotation NEVER buys loudness — no amber, no green panel — it
     * is a label on a card.
     */
    return {
      ...base,
      tier: 't3',
      annotation: status === 'passed_chamber' ? 'just_passed' : null,
    };
  }
  if (fresh && isSettledFloor(bill)) {
    return { ...base, tier: 't4', annotation: 'just_decided' };
  }
  return { ...base, tier: 't4' };
}

/**
 * The full ordering key for one bill. `slug` and `date` come from the caller
 * because every consumer already has them in its own shape.
 *
 * @param {{ slug: string, date?: string | null, rung: ReturnType<typeof docketRung> }} entry
 * @returns {{ slug: string, date: string, tier: string, tierRank: number, weight: number, sourceRank: number, published: string }}
 */
export function docketKey(entry) {
  const rung = entry.rung;
  const tierRank = DOCKET_TIERS.indexOf(rung.tier);
  return {
    slug: entry.slug,
    date: entry.date ?? '',
    tier: rung.tier,
    tierRank: tierRank < 0 ? DOCKET_TIERS.length : tierRank,
    weight: rung.weight ?? 0,
    sourceRank: SOURCE_RANK[rung.source ?? ''] ?? 9,
    published: rung.announced?.published ?? '',
  };
}

/**
 * THE COMPARATOR. Rung first, then the tier's own significance key, then the
 * record's clock, then the slug so two runs never disagree.
 *
 * WITHIN T2 THE ORDER IS RECENCY, AND THE BACKTEST SAYS RECENCY IS NOT
 * VOTE-PROXIMITY (finding K6: sorting T2 by date demoted the one placement that
 * actually got a vote below fresher placements that never did; the measured
 * placement→vote median is 22 days). It stays, for two reasons: no cheaper
 * signal separates a live queue position from a Rule XIV parking slot, and this
 * change moves T2 OUT of the act-now shortlist into "Moving" — so a
 * mis-ordering inside T2 now costs a position in a browse band instead of a
 * slot in the loudest list on the site. If a better key ever exists, it belongs
 * here and nowhere else.
 *
 * @param {ReturnType<typeof docketKey>} a
 * @param {ReturnType<typeof docketKey>} b
 * @returns {number}
 */
export function compareDocket(a, b) {
  return (
    a.tierRank - b.tierRank ||
    a.weight - b.weight ||
    b.published.localeCompare(a.published) ||
    a.sourceRank - b.sourceRank ||
    b.date.localeCompare(a.date) ||
    a.slug.localeCompare(b.slug)
  );
}

/**
 * Which /bills band this rung renders under. Terminal bills are pinned to the
 * radar band exactly as they were before this change.
 *
 * @param {{ tier: string, terminal?: boolean }} rung
 * @returns {'now' | 'moving' | 'radar'}
 */
export function bandForRung(rung) {
  if (rung?.terminal) return 'radar';
  return TIER_BAND[rung?.tier] ?? 'radar';
}

/** The /bills LEAD BAND's membership test — the two rungs where the floor
 *  question is open and imminent in the chamber's own words.
 *  @param {{ tier: string }} rung @returns {boolean} */
export function isDecidingNow(rung) {
  return rung?.tier === 't0' || rung?.tier === 't1';
}

/**
 * THE ACT-NOW POOL — the homepage shortlist, the crown's candidates, MCP
 * `whats_moving` and both feeds, all reading one predicate.
 *
 * DELIBERATELY ONE RUNG WIDER THAN THE LEAD BAND, and the reason is a
 * cross-surface promise this codebase already makes: a `floor_vote` bill with a
 * dated calendar placement inside the signal window (T2) is exactly the record
 * `liveCallTarget` routes on and exactly what the bill page paints amber for —
 * "this bill is in the Senate's hands right now, your senators are the live
 * call". A homepage that refused to list it while its own bill page said that
 * would be the two-surfaces-one-record contradiction lib/journey.ts exists to
 * end. T3 is excluded: "it just passed" is a fact about a vote that already
 * happened.
 *
 * THE AE3 QUIET-WEEK PROMISE STILL HOLDS, in the direction that matters. This
 * pool is a SUPERSET of the lead band, so "the homepage says the week is quiet"
 * still implies "the /bills lead band is empty" — a false quiet is
 * unrepresentable. The converse is allowed and honest: a week whose only floor
 * facts are calendar placements lists them on the homepage and shows them under
 * "Moving" on /bills, which is what they are.
 *
 * @param {{ tier: string }} rung
 * @returns {boolean}
 */
export function isActNow(rung) {
  return rung?.tier === 't0' || rung?.tier === 't1' || rung?.tier === 't2';
}

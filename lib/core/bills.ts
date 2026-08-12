/*
 * Bill data access — pure functions over the baked JSON corpus. Extracted
 * from lib/data.ts (S9): deliberately NOT 'server-only', unlike the module
 * it replaces. That coupling only ever suited page/RSC callers; a route
 * handler (app/api/mcp) is a legitimate server-side caller too, and future
 * agent surfaces need the same functions without a framework-specific guard
 * in the way. Nothing here changes shape or behavior — see lib/core/index.ts.
 */
import bills from '@/data/bills.json';
import { FLOOR_SETTLED, floorCalendarChamber, statusKeyFor } from '../journey';
import billsEs from '@/data/bills-es.json';
import { formatCitation } from '../format';
import { bandFloors, bandForEff, type UrgencyBand } from '../taxonomy';
import { coverageTier, getCoverage, newestArticleDate, normalizeSource, rankNews } from '../coverage';
import { TERMINAL_STATUSES, effectiveUrgency } from '../urgency.mjs';
import type { Bill, FeedTeaser, NewsBill } from '../types';

export { effectiveUrgency };

const BILLS = bills as Bill[];
const ES = billsEs as Record<
  string,
  { headline: string | null; summary: string; sections?: import('../types').DecodedSections }
>;

/** Overlay the Spanish decoded content when it exists; English is the fallback. */
export function localizeBill(b: Bill, locale: string): Bill {
  if (locale !== 'es') return b;
  const tr = ES[billSlug(b)];
  if (!tr) return b;
  return {
    ...b,
    ai_headline: tr.headline ?? b.ai_headline,
    ai_summary: tr.summary,
    ai_sections: tr.sections ?? b.ai_sections,
  };
}

export function billSlug(b: Pick<Bill, 'bill_type' | 'bill_number' | 'congress_number'>): string {
  return `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();
}

export function getBill(slug: string): Bill | undefined {
  return BILLS.find((b) => billSlug(b) === slug);
}

export function getAllBills(): Bill[] {
  return BILLS;
}

const byUrgencyDesc = <T extends { eff: number; raw: Pick<Bill, 'last_action_date'> }>(a: T, b: T) =>
  b.eff - a.eff || (b.raw.last_action_date ?? '').localeCompare(a.raw.last_action_date ?? '');

/**
 * HAS THE FLOOR ALREADY ANSWERED — the act-now pool's one exclusion, and the
 * reason `status: 'floor_vote'` is not on its own a reason to call.
 *
 * `floor_vote` is a KEYWORD BUCKET (scripts/congress-fetch.mjs's mapStatus), and
 * it is deliberately wide enough to catch a chamber taking a measure up at all.
 * That means it catches DEFEATS: "Cloture on the motion to proceed to the
 * measure not invoked in Senate by Yea-Nay Vote. 52 - 46." carries the corpus's
 * highest status base (0.9) plus the full freshness bonus, so on 2026-08-12 a
 * cloture vote that had already failed held rank 2 of the homepage shortlist —
 * a completed answer sold as the week's most urgent call, and propagated from
 * the same pool into MCP `whats_moving` and the public feeds.
 *
 * THE VOCABULARY IS THE GATE, and it is lib/journey.ts's FLOOR_SETTLED — the
 * same constant floorPendingChamber uses as its rule-0 guard and
 * floorSettledChamber uses as its entry condition. A fourth reader with a
 * private copy is exactly the drift that constant was written once to prevent.
 * Read the vocabulary rather than calling floorSettledChamber: that function
 * additionally needs a readable chamber, and which chamber a defeat happened in
 * says nothing about whether the bill is still worth a call — reusing it would
 * fail OPEN on the texts we classify least confidently. (On today's corpus the
 * two agree exactly, 18 of 348 floor_vote bills; the difference is a promise
 * about texts Congress has not written yet.)
 *
 * A DATED CALENDAR PLACEMENT STILL WINS, the same carve-out floorSettledChamber
 * makes for the same reason: a placement is a live fact whatever else its
 * sentence happens to mention. 0 corpus texts sit in that overlap today.
 *
 * DEMOTED, NOT HIDDEN. This never removes a bill from the corpus, from /bills,
 * from search, or from its own page — getTeasers still lists every one of them,
 * one band lower (see its comment). All that is withdrawn is the claim that a
 * phone call could still change the outcome.
 */
export function isSettledFloor(bill: {
  status: string;
  last_action_text: string | null;
}): boolean {
  if (bill.status !== 'floor_vote') return false;
  if (!FLOOR_SETTLED.test(bill.last_action_text ?? '')) return false;
  return floorCalendarChamber(bill.last_action_text) === null;
}

/*
 * The one place the corpus gets scored and split into active/settled with
 * band floors applied (KTD-2) - getTeasers and getTopActions both read this
 * so "Act now" means the same thing everywhere on the site. A third
 * independent copy of this scoring is the exact drift
 * docs/solutions/stale-urgency-freeze.md closed for the urgency curve
 * itself; this keeps the band-floor logic from re-acquiring that problem.
 */
function scoreActiveBills() {
  const scored = BILLS.map((raw) => ({
    raw,
    eff: effectiveUrgency(raw.status, raw.last_action_date),
    terminal: TERMINAL_STATUSES.has(raw.status),
    settledFloor: isSettledFloor(raw),
  }));
  // Active bills claim the now/moving bands by rank; terminal bills are
  // appended and pinned to radar, so they can never displace an actionable
  // bill. Floors come from the active bills alone, so a settled law can't
  // even raise the bar.
  const activeBills = scored.filter((s) => !s.terminal).sort(byUrgencyDesc);
  const settledBills = scored.filter((s) => s.terminal).sort(byUrgencyDesc);
  const floors = bandFloors(activeBills.map((s) => s.eff));
  /*
   * THE ACT-NOW POOL: active bills whose floor question is still open. Every
   * surface that makes a "worth a call" claim reads THIS, not `activeBills` —
   * the shortlist, the quiet-week claim, the crown's candidate pool, and
   * through getTopActions the MCP `whats_moving` tool and the public feeds.
   *
   * THE FLOORS ARE STILL COMPUTED FROM `activeBills`, settled floor bills
   * included, and that is deliberate rather than an oversight. A failed cloture
   * vote is a genuine, high-signal floor event: it says the week was busy, and
   * the bar for "Act now" is a statement about the week, not about any one
   * bill. Dropping these from the floors as well would be a second change with
   * a ranking ripple across every band on /bills — and would LOWER the bar on
   * exactly the weeks the floor was most active. Terminal bills are excluded up
   * there because a signed law is not a floor event at all; a defeated motion
   * is one.
   */
  const actNowPool = activeBills.filter((s) => !s.settledFloor);
  return { activeBills, settledBills, actNowPool, floors };
}

export function getTeasers(locale = 'en'): FeedTeaser[] {
  const { activeBills, settledBills, floors } = scoreActiveBills();

  return [...activeBills, ...settledBills].map(({ raw, eff, terminal, settledFloor }) => {
    const b = localizeBill(raw, locale);
    return {
      slug: billSlug(b),
      identifier: formatCitation(b.bill_type, b.bill_number),
      headline: b.ai_headline,
      title: b.short_title ?? b.title,
      status: b.status,
      tags: b.issue_tags ?? [],
      /*
       * ONE RUNG DOWN, NEVER OUT (2026-08-12). A bill whose floor question the
       * record has already answered is excluded from the act-now pool above,
       * and /bills has to agree or the site contradicts itself across one
       * click: hasActNow is the quiet-week claim's ONLY signal precisely
       * because it must mean "the Act now band on /bills is non-empty" (AE3 —
       * see hasActNow's own comment). Leaving a defeated motion in this band
       * while the shortlist dropped it would break that equivalence and print
       * "Act now" over a completed vote on the browse page instead of the
       * home page.
       *
       * `moving` and not `radar`: the bill IS still live legislation and the
       * floor did just touch it. Radar is where terminal bills are pinned, and
       * this one is not terminal. Nothing is hidden — it keeps its rank inside
       * the band it lands in, its search entry, and its page.
       */
      band: terminal ? 'radar' : demoteSettled(bandForEff(eff, floors), settledFloor),
      statusKey: statusKeyFor(b.status, b.last_action_text, b.last_action_date),
      lastActionDate: b.last_action_date,
    };
  });
}

/** The band cap applied to a settled floor bill: never "now", otherwise as
 *  scored. Exported for the pin in tests/act-now-pool.unit.spec.ts. */
export function demoteSettled(band: UrgencyBand, settledFloor: boolean): UrgencyBand {
  return settledFloor && band === 'now' ? 'moving' : band;
}

/**
 * Top N most urgent bills that clear the "Act now" floor and have a decoded
 * summary - the "worth a call this week" shortlist. KTD-2: this respects the
 * same absolute+rank floor as getTeasers' "now" band, so a genuinely quiet
 * week returns an empty list here too, instead of backfilling from whatever
 * ranks highest regardless of how urgent it actually is.
 *
 * Reads `actNowPool`, so a bill whose floor question the record has already
 * answered is not here however hot it scores (see isSettledFloor). That
 * exclusion travels from this one function to the MCP `whats_moving` tool and
 * both public feeds, which read this pool rather than re-deriving one.
 */
export function getTopActions(n = 5, locale = 'en'): Bill[] {
  const { actNowPool, floors } = scoreActiveBills();
  return actNowPool
    .filter((s) => s.eff >= floors.nowFloor && s.raw.ai_headline)
    .slice(0, n)
    .map(({ raw }) => localizeBill(raw, locale));
}

/**
 * THE CROWN'S CANDIDATE POOL — every decoded floor_vote bill that clears the
 * SAME "Act now" floor getTopActions uses, newest floor action first, with NO
 * top-N truncation.
 *
 * Why it is not just getTopActions(4) (which is what the homepage used to
 * hand selectFloorVoteFeature): the shortlist is a rank-4 cut across every
 * status, so on a busy floor week — several bills drawing cloture motions the
 * same day — the one bill actually standing on a calendar or facing a pending
 * vote could sit at rank 9 and the page would show NO crown at all. A cap
 * that exists to make the panel mean something was quietly deciding whether
 * the panel appeared. The cap-to-one still holds; it is enforced where it
 * belongs, in selectFloorVoteFeature, which reads this whole list and returns
 * at most one bill.
 *
 * The FLOOR is deliberately shared, not re-implemented: same scoreActiveBills,
 * same `floors.nowFloor`, same `ai_headline` requirement. A quiet week returns
 * an empty list here for exactly the reason it returns an empty shortlist
 * there, and a third independent copy of the scoring is the drift
 * docs/solutions/stale-urgency-freeze.md closed once already.
 *
 * NOTE THAT THIS FLOOR IS TIGHTER THAN THE PANEL'S OWN FRESHNESS WINDOW, and
 * that is deliberate rather than an oversight. `nowFloor` sits at 0.95 on the
 * 2026-08-09 corpus, and a `floor_vote` bill scores 1.0 inside 3 days, 0.95
 * inside 7, and 0.9 after — so the pool is in practice "a floor action in the
 * last week", while selectFloorVoteFeature's isSignalFresh would accept 14
 * days. The crown is the WEEK's masthead; a bill whose last floor action was
 * eleven days ago is not what the week is about, and the same floor governed
 * the old getTopActions(4) pool, so nothing narrowed here.
 *
 * 21 bills on the 2026-08-09 corpus (339 active floor_vote bills, 21 of them
 * over the floor; every one of the 339 carries a decode). The corpus moves
 * nightly — recompute, don't trust.
 *
 * SETTLED TEXTS ARE OUT OF THE POOL as of 2026-08-12 (`actNowPool`, see
 * isSettledFloor), and this changes NOTHING about which bill wears the crown:
 * selectFloorVoteFeature already reads floorCalendarChamber ?? floorPendingChamber,
 * and FLOOR_SETTLED is floorPendingChamber's rule 0, so a defeated motion could
 * never have been selected. What the exclusion removes is a defeated motion
 * sitting in the pool the selector walks — one shared definition of "act-now
 * material" for the crown, the shortlist, the feeds and the MCP tool, instead
 * of one pool the selector had to defend itself against.
 */
export function getFloorFeatureCandidates(locale = 'en'): Bill[] {
  const { actNowPool, floors } = scoreActiveBills();
  return actNowPool
    .filter((s) => s.eff >= floors.nowFloor && s.raw.ai_headline && s.raw.status === 'floor_vote')
    .sort((a, b) => (b.raw.last_action_date ?? '').localeCompare(a.raw.last_action_date ?? ''))
    .map(({ raw }) => localizeBill(raw, locale));
}

/**
 * Whether ANY active bill clears the "Act now" floor - decoded or not. The
 * quiet-week claim must key on this, not on getTopActions() being empty:
 * getTopActions also filters on ai_headline, so an undecoded bill that
 * clears the floor would land in /bills' "Act now" band (getTeasers applies
 * no headline filter) while the decoded shortlist reads empty - and "no bill
 * has cleared the bar" would be a false statement (AE3: never a false quiet).
 *
 * THE EQUIVALENCE THIS FUNCTION OWES /bills is why it reads `actNowPool` and
 * getTeasers demotes the same bills one band (2026-08-12). The two changes are
 * one change: this must stay exactly "the Act now band on /bills is non-empty",
 * or a week whose only over-floor bill is a defeated motion would print a
 * quiet-week state on the home page above a populated "Act now" band one click
 * away. The undecoded-bill gap the paragraph above describes is unchanged.
 */
export function hasActNow(): boolean {
  const { actNowPool, floors } = scoreActiveBills();
  return actNowPool.some((s) => s.eff >= floors.nowFloor);
}

/*
 * The "In the news" discovery lens — feeds rankNews real bills with their
 * coverage tier, outlet count, urgency, and (since 2026-08-12) the date of the
 * newest article stored for them. The ranking/exclusion policy (cross >
 * neutral, one-sided dropped, nothing older than the signal window) lives in
 * lib/coverage so it stays unit-testable; consequence, not partisan attention,
 * decides prominence.
 *
 * WHY THE DATE IS PASSED IN RATHER THAN LOOKED UP THERE: rankNews is generic
 * over anything carrying the four fields, which is what lets the unit spec
 * drive it without the corpus. This function is the one place that knows a bill
 * has stored articles at all.
 */
export function getNewsBills(locale = 'en', n = 6): NewsBill[] {
  const items = BILLS.map((raw) => {
    const articles = getCoverage(billSlug(raw));
    return {
      raw,
      tier: coverageTier(articles),
      sources: new Set(articles.map((a) => normalizeSource(a.source))).size,
      urgency: effectiveUrgency(raw.status, raw.last_action_date),
      newestArticle: newestArticleDate(articles),
    };
  });
  return rankNews(items, n).map(({ raw, tier, sources }) => {
    const b = localizeBill(raw, locale);
    return {
      slug: billSlug(b),
      identifier: formatCitation(b.bill_type, b.bill_number),
      headline: b.ai_headline,
      title: b.short_title ?? b.title,
      status: b.status,
      tags: b.issue_tags ?? [],
      statusKey: statusKeyFor(b.status, b.last_action_text, b.last_action_date),
      lastActionDate: b.last_action_date,
      coverageTier: tier as 'cross' | 'neutral',
      sourceCount: sources,
    };
  });
}

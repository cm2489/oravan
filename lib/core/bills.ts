/*
 * Bill data access — pure functions over the baked JSON corpus. Extracted
 * from lib/data.ts (S9): deliberately NOT 'server-only', unlike the module
 * it replaces. That coupling only ever suited page/RSC callers; a route
 * handler (app/api/mcp) is a legitimate server-side caller too, and future
 * agent surfaces need the same functions without a framework-specific guard
 * in the way. Nothing here changes shape or behavior — see lib/core/index.ts.
 */
import bills from '@/data/bills.json';
import { statusKeyFor } from '../journey';
import billsEs from '@/data/bills-es.json';
import { formatCitation } from '../format';
import {
  bandFor,
  compareDocket,
  docketKey,
  evidenceFor,
  isActNow,
  isDecidingNow,
  isSettledFloor,
  rungFor,
  type DocketEvidence,
  type DocketRung,
} from '../docket';
import { coverageTier, getCoverage, newestArticleDate, normalizeSource, rankNews } from '../coverage';
/* THE LAMP, and this is the ONLY module in lib/core that may import it: the
 * conversation selects and captions the news band and touches nothing else.
 * See getNewsBills' header for the boundary and why it is drawn here. */
import {
  conversationBandPool,
  conversationPosture,
  newsSpread,
  selectConversationBand,
  type NewsCaption,
} from '../conversation';
import { effectiveUrgency } from '../urgency.mjs';
import type { Bill, FeedTeaser, NewsBill } from '../types';

export { effectiveUrgency };
/* Re-exported, not redefined: the settled-floor vocabulary gate moved to
 * lib/docket.mjs with the ladder (it is now a RUNG decision — a settled text
 * lands on T4 with a `just_decided` annotation instead of being filtered out of
 * a pool it had already scored into). Callers that had it from here keep it. */
export { isSettledFloor };

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


/*
 * THE DOCKET LADDER, applied to the corpus — the one place the whole corpus is
 * placed on a rung, ordered, and split into the pools every surface reads.
 *
 * WHAT THIS REPLACED. `scoreActiveBills` scored every bill with
 * `effectiveUrgency` and cut the result with `bandFloors`' percentile+absolute
 * floors. Three measured failures killed that design and they are recorded in
 * lib/docket.mjs's header; the shortest version is that a scalar cannot say WHY
 * a bill is on the list, and on this corpus it kept saying the wrong thing: it
 * promoted a cloture vote that had already FAILED to rank 2 of the homepage
 * shortlist, it could not see the two biggest bills of the fortnight at all
 * (Congress overwrites `last_action_text` when a measure reaches the floor, so
 * their derived status fell back to `committee`), and on a busy week every bill
 * tied at 0.95 and the middle band collapsed.
 *
 * `effectiveUrgency` is NOT retired — it is still the MCP teaser's
 * `urgency_score` and the coverage sweep's tail key. What is retired is its use
 * as the ORDER of the site, and with it `bandFloors`/`bandForEff` (see
 * lib/taxonomy.ts, where that whole v1→v3a history now ends).
 *
 * ONE SORT, MANY POOLS. Everything below is a filter over one ordered list, so
 * the crown, the shortlist, /bills' bands, the MCP tool and both feeds cannot
 * disagree about what is moving — the same house rule that put the urgency
 * curve in one module (docs/solutions/stale-urgency-freeze.md).
 */
interface DocketedBill {
  raw: Bill;
  slug: string;
  rung: DocketRung;
  key: ReturnType<typeof docketKey>;
}

function docketCorpus(now: number = Date.now()): {
  ordered: DocketedBill[];
  actNowPool: DocketedBill[];
} {
  const placed: DocketedBill[] = BILLS.map((raw) => {
    const slug = billSlug(raw);
    const rung = rungFor(raw, slug, now);
    return { raw, slug, rung, key: docketKey({ slug, date: raw.last_action_date, rung }) };
  });
  const ordered = placed.sort((a, b) => compareDocket(a.key, b.key));
  /*
   * THE ACT-NOW POOL: T0 ∪ T1 ∪ T2 — announced by the chamber, a vote ripening
   * in the record, or a dated calendar placement still inside the signal window.
   * Every surface that makes a "worth a call" claim reads THIS: the shortlist,
   * the quiet-week claim, the crown's candidates, and through getTopActions the
   * MCP `whats_moving` tool and the public feeds.
   *
   * A settled floor text (a rejected motion, cloture not invoked) cannot reach
   * it: `entersFloorWatch`'s rule 0 and `isSettledFloor` read the same
   * FLOOR_SETTLED vocabulary, so a bill whose floor question the record has
   * already answered lands on T4 carrying a `just_decided` annotation instead —
   * demoted and annotated, never hidden.
   */
  return { ordered, actNowPool: ordered.filter((s) => isActNow(s.rung)) };
}

export function getTeasers(locale = 'en'): FeedTeaser[] {
  const { ordered } = docketCorpus();
  return ordered.map(({ raw, rung }) => {
    const b = localizeBill(raw, locale);
    return {
      slug: billSlug(b),
      identifier: formatCitation(b.bill_type, b.bill_number),
      headline: b.ai_headline,
      title: b.short_title ?? b.title,
      status: b.status,
      tags: b.issue_tags ?? [],
      /*
       * THE BAND IS THE RUNG — a fact about the record, not a percentile.
       *
       * Deciding now = T0 ∪ T1 · Moving = T2 ∪ T3 · On the radar = T4 and every
       * terminal bill, pinned as before. T3 is in Moving on the critic's A-3
       * patch and the backtest's K3: under the old floors a bill that had just
       * passed a chamber scored 0.75 against a 0.95 now-floor, so on the day the
       * Senate passed the continuing resolution 90-6 the site moved the biggest
       * story in national politics to "quieter right now".
       *
       * A band may now be EMPTY, and that is the point: a fortnight in which
       * Congress announces nothing and files no cloture motions has no "Deciding
       * now" band, instead of promoting whatever happened to rank highest.
       */
      band: bandFor(rung),
      /* The annotation rides the card and never the colour: `just_decided` and
       * `just_passed` are ink labels on a listing. Neither may light amber —
       * amber is one dated floor fact that is still AHEAD. */
      annotation: rung.annotation,
      statusKey: statusKeyFor(b.status, b.last_action_text, b.last_action_date),
      lastActionDate: b.last_action_date,
    };
  });
}

/**
 * The week's shortlist: the top N of the act-now pool in ladder order, decoded
 * only — "what is moving in Congress this week", in the order the record itself
 * puts them.
 *
 * Reads the same pool and the same comparator as the crown and the MCP tool, so
 * a bill's position here is reproducible from the evidence sentence printed
 * beside it (see `docketSignalFor`). A genuinely quiet week returns fewer than N
 * — or none — instead of backfilling from whatever ranks highest.
 */
export function getTopActions(n = 5, locale = 'en'): Bill[] {
  const { actNowPool } = docketCorpus();
  return actNowPool
    .filter((s) => s.raw.ai_headline)
    .slice(0, n)
    .map(({ raw }) => localizeBill(raw, locale));
}

/**
 * THE CROWN'S CANDIDATE POOL — the act-now pool, decoded, in ladder order, with
 * NO top-N truncation.
 *
 * Why it is not just getTopActions(4): the shortlist is a display cut, and on a
 * busy week the one bill actually carrying a live floor fact could sit below it,
 * so the cut would silently decide whether the crown appeared at all. The
 * cap-to-one still holds; it is enforced where it belongs, in
 * `selectFloorVoteFeature`, which reads this whole list and returns at most one.
 *
 * WHAT CHANGED WITH THE LADDER: the pool is no longer restricted to
 * `status === 'floor_vote'`. It could not be, and that restriction was the
 * measured F2 failure — when a measure actually reaches the floor Congress
 * overwrites the action text and the derived status falls back to `committee`,
 * so on 2026-08-07 the two hottest vehicles in the country were ineligible for
 * the crown by construction. A T0 bill is admitted on the chamber's own
 * announcement whatever its status says, and the selector's `announced` kind
 * prints that announcement rather than a status claim.
 */
export function getFloorFeatureCandidates(locale = 'en'): Bill[] {
  const { actNowPool } = docketCorpus();
  return actNowPool.filter((s) => s.raw.ai_headline).map(({ raw }) => localizeBill(raw, locale));
}

/**
 * Whether ANY bill stands in the act-now pool — decoded or not. The quiet-week
 * claim must key on this, not on getTopActions() being empty: getTopActions also
 * filters on `ai_headline`, so an undecoded bill on a live rung would leave the
 * shortlist empty while /bills listed it, and "no bill has cleared the bar"
 * would be a false statement (AE3: never a false quiet).
 *
 * THE AE3 EQUIVALENCE, restated for the ladder. This pool (T0 ∪ T1 ∪ T2) is a
 * SUPERSET of /bills' lead band (T0 ∪ T1), so "the homepage says the week is
 * quiet" still implies "the Deciding now band is empty" — a false quiet stays
 * unrepresentable, which is the whole promise. The converse is deliberately
 * allowed: a week whose only floor facts are calendar placements lists them on
 * the homepage and files them under "Moving" on /bills, because a placement is a
 * queue position, not a chamber deciding today. See lib/docket.mjs's `isActNow`
 * for the cross-surface reason the pool is the wider of the two.
 */
export function hasActNow(): boolean {
  return docketCorpus().actNowPool.length > 0;
}

/** Whether any bill stands on the /bills LEAD BAND (T0 ∪ T1) — the narrower
 *  claim, exported for the corpus invariants that pin the two pools against
 *  each other. */
export function hasDecidingNow(): boolean {
  return docketCorpus().ordered.some((s) => isDecidingNow(s.rung));
}

/**
 * THE EVIDENCE FOR ONE BILL'S POSITION — the rung it stands on and the sentence
 * that put it there, for the surfaces that publish their own reasoning (the
 * crown, MCP `whats_moving`, both feeds).
 *
 * The envelope's checkability promise, extended from "here is the bill" to "here
 * is why it is on this list": a dated, attributed sentence at a URL, in
 * Congress's own English — never translated, always framed (owner ruling V4).
 */
export function docketSignalFor(
  slug: string,
  now: number = Date.now()
): { rung: DocketRung; evidence: DocketEvidence | null } | null {
  const raw = getBill(slug);
  if (!raw) return null;
  const rung = rungFor(raw, slug, now);
  return { rung, evidence: evidenceFor(raw, rung) };
}


/*
 * THE "IN THE NEWS" BAND — the one surface the conversation lamp selects.
 *
 * CONVERSATION NEVER CHANGES DOCKET ORDER. Not the crown, not the shortlist,
 * not /bills' bands, not the MCP act-now pool — every one of those still reads
 * `docketCorpus` above and nothing else. What the lamp owns is the surface that
 * has ALWAYS been press-selected: this band. That boundary is the whole reason
 * the 2026-07-31 decision of record (proximity ranks; volume never does)
 * survives the lamp existing, and it is enforced by construction — this is the
 * only function in this file that imports lib/conversation.
 *
 * TWO MODES, and the posture decides which (lib/conversation.ts):
 *
 *  1. LAMP LIVE — cards come from data/conversation.json's committed evidence:
 *     C1 (two or more RATED outlets published inside the 7-day window) first,
 *     ordered by distinct rated outlets then newest evidence; then C2 (on
 *     congress.gov's own most-viewed list, with either two consecutive weeks or
 *     a rated article beside it), with most-viewed-only cards capped at 2 of 6.
 *     A single outlet is not a rung and cannot render anything, anywhere.
 *     Each card carries the counted facts it was selected on, so the page can
 *     say WHY it is there in words a reader can check against stored evidence.
 *
 *  2. FALLBACK — exactly #215's behavior: `rankNews` over stored coverage,
 *     cross/neutral only, gated to the signal window, ordered by breadth. The
 *     captions are DROPPED rather than guessed, because nothing in this mode
 *     counts who published what THIS WEEK. Design B2's degradation table.
 *
 * `now` is threaded so the whole selection — posture, evidence window and the
 * fallback's recency gate — is evaluated at ONE instant, the same discipline
 * docketCorpus and rankNews already keep.
 */
export function getNewsBills(locale = 'en', n = 6, now: number = Date.now()): NewsBill[] {
  const shape = (
    raw: Bill,
    extra: { coverageTier: 'cross' | 'neutral' | null; sourceCount: number; caption: NewsCaption | null }
  ): NewsBill => {
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
      ...extra,
    };
  };

  if (conversationPosture(now) === 'live') {
    // The corpus is the renderable set: the press cites bill numbers this build
    // does not hold (a measure the sync has not reached, an untracked
    // resolution), and a card has to link somewhere. The CI gate reports those
    // slugs in aggregate; here they are simply skipped.
    const bySlug = new Map(BILLS.map((raw) => [billSlug(raw), raw]));
    return selectConversationBand(conversationBandPool(now), {
      limit: n,
      renderable: (slug) => bySlug.has(slug),
    }).map((sel) =>
      shape(bySlug.get(sel.slug)!, {
        // The spread of the outlets the caption counts — null when the card
        // stands on the most-viewed list alone, which is not a coverage claim.
        coverageTier: sel.caption.outlets >= 2 ? newsSpread(sel.caption.leans) as 'cross' | 'neutral' : null,
        sourceCount: sel.caption.outlets,
        caption: sel.caption,
      })
    );
  }

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
  return rankNews(items, n, now).map(({ raw, tier, sources }) =>
    shape(raw, { coverageTier: tier as 'cross' | 'neutral', sourceCount: sources, caption: null })
  );
}

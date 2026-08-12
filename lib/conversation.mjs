/*
 * THE CONVERSATION LAMP — what the country is actually reading about, kept as
 * evidence rather than as a score, and kept COMMITTED rather than in a cache.
 *
 * ---- WHAT IT IS AND WHAT IT IS NOT ---------------------------------------
 * The docket ladder (lib/docket.mjs) answers "what is Congress deciding". This
 * answers a different question — "what is in the public conversation about
 * Congress" — and it answers it with two counted, checkable facts and nothing
 * else:
 *
 *   1. WHICH RATED OUTLETS carried a story matched to this bill in the last 7
 *      days, with the day each was first and last seen.
 *   2. WHETHER congress.gov's own weekly most-viewed list carries it, at what
 *      rank, for how many consecutive weeks.
 *
 * CONVERSATION NEVER CHANGES DOCKET ORDER. Not the crown, not the shortlist,
 * not the /bills bands, not the MCP `whats_moving` pool. It selects and
 * captions the news band, contributes one C-tier input to the Moment-candidate
 * comparator, and offers an optional MCP facet. That boundary is the whole
 * reason the 2026-07-31 decision of record ("proximity ranks, volume never
 * does") survives this file existing.
 *
 * ---- THE FOUR RULES THIS MODULE ENFORCES AT WRITE TIME --------------------
 * B-1  ONE OUTLET ADMITS NOTHING, ANYWHERE. A single outlet's story can never
 *      produce a rendered card, a caption, or a re-decode. The repo already
 *      wrote this rule down for the TRIGGER path (scripts/newsdesk-match.mjs's
 *      header: letting one outlet's coverage decide which bills get fast-
 *      tracked "would make whichever outlet happens to publish first a de
 *      facto prioritization channel"), and it binds the DISPLAY path for
 *      exactly the same reason. `conversationTier` has no single-outlet rung
 *      to reach — C1 needs two rated outlets, C2 needs the government's own
 *      most-viewed list plus a corroborating second fact.
 * B-2  MOST-VIEWED IS THE CHEAPEST INPUT TO GAME, so it is never sufficient
 *      alone: a most-viewed bill renders only with `weeksOnList >= 2` (the
 *      list carried it two weeks running — a mobilization burst does not) OR
 *      at least one rated basket article beside it. It never fires a re-decode
 *      by itself (only C1 does), and a consumer may render at most
 *      MOST_VIEWED_CARD_CAP cards that are on the page because of the list.
 *      THE CAP COUNTS BOTH ADMISSION ROUTES (widened 2026-08-12, verification
 *      round 1): it was written against the `weeksOnList >= 2` route only, so
 *      the `+ one rated article` route walked past it and a band could fill
 *      with cards resting on one view count and one newsroom apiece — the
 *      concentration the cap exists to prevent, reached through the other
 *      door. Every C2 card counts against the same ceiling now.
 * B-3  ONLY RATED OUTLETS CORROBORATE. An outlet counts toward corroboration
 *      only if data/media-bias.json carries an AllSides lean for its domain.
 *      Unrated domains — the ones a Google News query resolves to, where two
 *      press-release pickups on obscure indexed sites would otherwise present
 *      as "two distinct newsrooms" — are recorded in `unratedOutlets7d` for
 *      observability and counted by nothing. The split is structural, not a
 *      filter applied later: `outlets7d` is unrepresentable without a lean,
 *      and scripts/check-conversation.mjs fails the build if one appears.
 * B-4  A LEAN THAT GOES DARK IS AN ALARM, NOT A SILENCE. `rollLeanHealth` /
 *      `darkLeans` below track, per rated lean, the last day any feed of that
 *      lean produced an item; a lean dark for DARK_LEAN_ALARM_DAYS is a loud
 *      ::warning:: in the newsdesk run and a status in this file, because a
 *      dead right-lean feed does not announce itself — it just quietly makes
 *      the stories one side covers harder to corroborate.
 *
 * ---- WHY THE FILE IS COMMITTED (owner ruling V5, backtest K8) -------------
 * The 18-snapshot backtest could replay the docket half and could NOT replay
 * the press half, for one reason: every signal the newsdesk accumulated lived
 * in an Actions cache that GitHub evicts after 7 days of disuse. "Everything
 * the newsdesk kept in its Actions cache is unauditable history now." So this
 * is a committed file from day one, and the trigger's own `pendingOutlets`
 * cache is left exactly as it is — the lamp reads its own evidence and never
 * the cache, and the cache still decides fires and still deletes on fire.
 *
 * ---- WHY EVERY TIMESTAMP HERE IS A DATE ----------------------------------
 * An hourly cron must never become an hourly deploy (newsdesk.yml's own rule).
 * Observations are therefore stored at DAY granularity, which makes the
 * material-change test trivially honest: re-seeing the same outlet on the same
 * day changes no byte, so it writes nothing. A new outlet, a new day for an
 * existing one, a most-viewed transition, or a window prune are the only
 * things that move the file — a few writes a day, each one meaning something.
 */

export const CONVERSATION_PATH = 'data/conversation.json';
export const CONVERSATION_SCHEMA = 'conversation/v1';

/** The rolling evidence window, in days. Seven, because the claim a consumer
 *  gets to make from it is "this week" — and because the most-viewed list the
 *  other half reads is itself weekly. */
export const OUTLET_WINDOW_DAYS = 7;

/** How many RATED, DISTINCT outlets make a bill corroborated (C1). Two, the
 *  same number and the same reasoning as the trigger path's ≥2-outlet rule. */
export const CORROBORATION_MIN_RATED_OUTLETS = 2;

/** How long a most-viewed observation is kept for accounting after it stops
 *  being current. Longer than the render window on purpose: `weeksOnList`
 *  needs last week's entry to still be here to know this week is consecutive,
 *  and a reader auditing the file benefits from seeing the run-up. */
export const MOST_VIEWED_RETENTION_DAYS = 21;

/** Consecutive weeks on congress.gov's most-viewed list that let the list
 *  stand on its own as a corroborating fact (critic B-2). One week is a
 *  mobilization burst; two weeks running is durable public attention. */
export const MOST_VIEWED_MIN_WEEKS = 2;

/** The ceiling a CONSUMER must apply: at most this many cards in the news band
 *  may owe their place to congress.gov's most-viewed list — every C2 card, by
 *  EITHER admission route (two consecutive weeks, or one rated article beside
 *  the listing). Exported here so the number lives with the rule that
 *  motivates it (critic B-2) and cannot drift between the writer and the
 *  renderer.
 *
 *  RENAMED from MOST_VIEWED_ONLY_CARD_CAP on 2026-08-12: the old name said
 *  "only", and the renderer had implemented the name rather than the rule —
 *  a most-viewed card with one article beside it was uncapped, so five of six
 *  cards could rest on a view count apiece. The name now says what is
 *  counted. */
export const MOST_VIEWED_CARD_CAP = 2;

/** Days a rated lean may produce nothing before the run says so out loud
 *  (critic B-4). Seven: individual feeds break for a day constantly, and the
 *  thing worth waking someone for is a lean that has been structurally absent
 *  from corroboration for a week. */
export const DARK_LEAN_ALARM_DAYS = 7;

/** File-size tripwire. A week of press matches is tens of KB; anything near
 *  this is a writer that has stopped pruning. */
export const CONVERSATION_MAX_BYTES = 256 * 1024;

/** Per-slug caps, so one heavily-aggregated bill can never dominate the file.
 *  The rated cap is above the number of rated domains that plausibly cover one
 *  bill in a week; the unrated cap is the real bound, because a Google News
 *  query resolves to an open-ended set of domains. Trimming keeps the
 *  most-recently-seen entries. Neither cap can affect corroboration: rated
 *  entries are never trimmed below the cap in practice, and unrated entries
 *  count toward nothing by construction (B-3). */
export const MAX_RATED_OUTLETS_PER_SLUG = 40;
export const MAX_UNRATED_OUTLETS_PER_SLUG = 25;

/** The three leans data/media-bias.json collapses AllSides' 5-point scale to.
 *  A domain absent from that file has NO lean and corroborates nothing. */
export const RATED_LEANS = /** @type {const} */ (['left', 'center', 'right']);

const DAY_MS = 86_400_000;

/** YYYY-MM-DD for a ms timestamp, in UTC (the same day key every other
 *  committed data file in this repo uses).
 * @param {number} ms
 * @returns {string}
 */
export function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD day keys (b - a). NaN-safe: an
 *  unparseable date returns Infinity, which every caller reads as "too old",
 *  so a corrupt stamp fails toward dropping evidence rather than keeping it.
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {number}
 */
export function daysBetween(a, b) {
  const am = Date.parse(`${a}T00:00:00Z`);
  const bm = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(am) || !Number.isFinite(bm)) return Infinity;
  return Math.round((bm - am) / DAY_MS);
}

/** Normalize an outlet identifier to the bare lowercase domain
 *  data/media-bias.json keys on. Returns null for anything that isn't one —
 *  including the newsdesk's `unknown` sentinel, which is the ABSENCE of an
 *  outlet and must never become a domain here.
 * @param {string | null | undefined} outlet
 * @returns {string | null}
 */
export function normalizeDomain(outlet) {
  let s = String(outlet ?? '').trim().toLowerCase();
  if (!s || s === 'unknown') return null;
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!s || !s.includes('.')) return null;
  return s;
}

/**
 * The AllSides lean for a domain, or null when the domain carries no rating.
 * THIS IS THE B-3 GATE: null means the outlet corroborates nothing, anywhere.
 *
 * @param {string | null | undefined} outlet
 * @param {Record<string, string> | null | undefined} outlets data/media-bias.json's `outlets` map
 * @returns {'left' | 'center' | 'right' | null}
 */
export function leanOf(outlet, outlets) {
  const domain = normalizeDomain(outlet);
  if (!domain) return null;
  const lean = (outlets ?? {})[domain];
  return RATED_LEANS.includes(lean) ? lean : null;
}

// ---- the evidence document ------------------------------------------------

/** @param {any[] | null | undefined} list @param {string} today @param {number} windowDays */
function pruneList(list, today, windowDays) {
  return (Array.isArray(list) ? list : []).filter(
    (e) => daysBetween(e?.lastSeen, today) <= windowDays && daysBetween(e?.lastSeen, today) >= 0
  );
}

/** Newest-seen first, then domain — deterministic, so two runs that observed
 *  the same thing serialize identically and the churn guard can compare them.
 * @param {any[]} list @param {number} cap
 */
function sortAndCap(list, cap) {
  const sorted = [...list].sort(
    (a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)) || String(a.domain).localeCompare(String(b.domain))
  );
  return sorted.slice(0, cap);
}

/**
 * Fold one run's outlet observations for ONE slug into its previous entry.
 *
 * `observed` is this run's set of outlet identifiers for the slug — citation
 * matches, token matches, LLM-resolved matches and nickname-bridge matches all
 * count the same, because they are all "a newsroom published a story we
 * matched to this bill". Rated and unrated are split HERE, at write time, and
 * never merged again (B-3).
 *
 * @param {any} prev previous entry for this slug (or undefined)
 * @param {{ observed?: Iterable<string>, bias?: Record<string, string>, today: string }} input
 * @returns {{ outlets7d: any[], unratedOutlets7d: any[] }}
 */
export function observeOutlets(prev, { observed, bias, today }) {
  const rated = new Map();
  const unrated = new Map(
    pruneList(prev?.unratedOutlets7d, today, OUTLET_WINDOW_DAYS).map((e) => [e.domain, { domain: e.domain, firstSeen: e.firstSeen, lastSeen: e.lastSeen }])
  );
  // Carried evidence is re-judged against the CURRENT bias table on every
  // build, not just when the outlet is seen again. An edit to
  // data/media-bias.json — a new rating, a withdrawn one, a re-rating — must
  // move the affected observations the same hour, or the file would keep
  // counting an outlet the table no longer rates and the gate would (rightly)
  // fail on a change nobody made to this file.
  for (const e of pruneList(prev?.outlets7d, today, OUTLET_WINDOW_DAYS)) {
    const lean = leanOf(e.domain, bias);
    if (lean) rated.set(e.domain, { domain: e.domain, lean, firstSeen: e.firstSeen, lastSeen: e.lastSeen });
    else unrated.set(e.domain, { domain: e.domain, firstSeen: e.firstSeen, lastSeen: e.lastSeen });
  }
  for (const raw of observed ?? []) {
    const domain = normalizeDomain(raw);
    if (!domain) continue; // the unresolved-outlet sentinel is not an outlet
    const lean = leanOf(domain, bias);
    if (lean) {
      // A domain that has just BEEN rated (data/media-bias.json gained an
      // entry) moves sides and keeps the day it was first seen — when this
      // outlet first carried the story is a fact about the outlet, not about
      // when we learned its lean.
      const firstSeen = rated.get(domain)?.firstSeen ?? unrated.get(domain)?.firstSeen ?? today;
      unrated.delete(domain);
      rated.set(domain, { domain, lean, firstSeen, lastSeen: today });
    } else {
      // ...and a domain that LOST its rating moves back, the same way. It
      // stops corroborating from this run on, which is the point.
      const firstSeen = unrated.get(domain)?.firstSeen ?? rated.get(domain)?.firstSeen ?? today;
      rated.delete(domain);
      unrated.set(domain, { domain, firstSeen, lastSeen: today });
    }
  }
  return {
    outlets7d: sortAndCap([...rated.values()], MAX_RATED_OUTLETS_PER_SLUG),
    unratedOutlets7d: sortAndCap([...unrated.values()], MAX_UNRATED_OUTLETS_PER_SLUG),
  };
}

/**
 * Two most-viewed week keys are consecutive when they sit one publication
 * apart. congress.gov publishes the list weekly (Sunday-dated), so the exact
 * distance is 7 days — the 5..9 tolerance absorbs a publication that slips a
 * day or two without ever letting a two-week gap read as consecutive.
 *
 * @param {string | null | undefined} previousWeek
 * @param {string} week
 * @returns {boolean}
 */
export function isConsecutiveWeek(previousWeek, week) {
  const gap = daysBetween(previousWeek, week);
  return Number.isFinite(gap) && gap >= 5 && gap <= 9;
}

/**
 * Fold one most-viewed observation into a slug's previous `mostViewed` block.
 *
 * `weeksOnList` counts CONSECUTIVE weeks, and resets to 1 after a missed week.
 * That is the stricter reading and the honest one: a bill that appeared in
 * week 1 and week 9 has not been "on the list for two weeks", and B-2 leans on
 * this number as evidence of durable attention rather than a burst.
 *
 * A run that cannot read the feed's own week label advances nothing — the rank
 * and the seen-date are still recorded, because they are observed facts, but
 * an unlabelled observation can never manufacture a second week.
 *
 * @param {any} prev previous mostViewed block (or null)
 * @param {{ rank: number, week?: string | null, today: string }} input
 * @returns {{ weeksOnList: number, lastRank: number, lastSeen: string, lastWeek: string | null }}
 */
export function observeMostViewed(prev, { rank, week, today }) {
  const previousWeek = prev?.lastWeek ?? null;
  const previousCount = Number.isInteger(prev?.weeksOnList) && prev.weeksOnList > 0 ? prev.weeksOnList : 0;
  let weeksOnList;
  if (!week) {
    weeksOnList = previousCount || 1;
  } else if (previousWeek === week) {
    weeksOnList = previousCount || 1;
  } else if (isConsecutiveWeek(previousWeek, week)) {
    weeksOnList = previousCount + 1;
  } else {
    weeksOnList = 1;
  }
  return {
    weeksOnList,
    lastRank: rank,
    lastSeen: today,
    lastWeek: week ?? previousWeek ?? null,
  };
}

/** How many RATED outlets carry this slug inside the window. The one number
 *  corroboration is counted with, anywhere (B-3).
 * @param {any} entry @param {string} today @returns {number}
 */
export function countRatedOutlets(entry, today) {
  return pruneList(entry?.outlets7d, today, OUTLET_WINDOW_DAYS).length;
}

/**
 * The full, caption-ready read on one slug's conversation evidence.
 *
 *   c1  CORROBORATED — two or more RATED outlets inside the window. The only
 *       tier that may fire a re-decode, and the only one that stands on press
 *       alone.
 *   c2  MOST-VIEWED, CORROBORATED — congress.gov's own weekly list carries it
 *       AND (two consecutive weeks OR at least one rated article beside it).
 *   c0  NOTHING RENDERS. Includes the deliberately-unreachable single-outlet
 *       case (B-1) and a one-week most-viewed appearance with no article.
 *
 * Every field returned is a counted fact a reader can check against the stored
 * evidence — there is no score here and nothing is inferred.
 *
 * @param {any} entry
 * @param {{ now?: number, today?: string }} [ctx]
 * @returns {{ tier: 'c0'|'c1'|'c2', ratedOutlets: number, leanSpread: string[], domains: string[], mostViewed: any, weeksOnList: number, newestSeen: string | null, reason: string }}
 */
export function conversationEvidence(entry, ctx) {
  const today = ctx?.today ?? dayKey(ctx?.now ?? Date.now());
  const rated = pruneList(entry?.outlets7d, today, OUTLET_WINDOW_DAYS);
  const leanSpread = [...new Set(rated.map((e) => e.lean))].sort();
  const domains = rated.map((e) => e.domain).sort();
  const mv = entry?.mostViewed ?? null;
  const mvCurrent = mv && daysBetween(mv.lastSeen, today) <= OUTLET_WINDOW_DAYS && daysBetween(mv.lastSeen, today) >= 0
    ? mv
    : null;
  const weeksOnList = Number.isInteger(mvCurrent?.weeksOnList) ? mvCurrent.weeksOnList : 0;
  const newestSeen = [...rated.map((e) => e.lastSeen), ...(mvCurrent ? [mvCurrent.lastSeen] : [])]
    .sort()
    .pop() ?? null;

  let tier = /** @type {'c0'|'c1'|'c2'} */ ('c0');
  let reason = 'no-corroboration';
  if (rated.length >= CORROBORATION_MIN_RATED_OUTLETS) {
    tier = 'c1';
    reason = 'rated-outlets';
  } else if (mvCurrent && weeksOnList >= MOST_VIEWED_MIN_WEEKS) {
    tier = 'c2';
    reason = 'most-viewed-weeks';
  } else if (mvCurrent && rated.length >= 1) {
    tier = 'c2';
    reason = 'most-viewed-plus-article';
  } else if (mvCurrent) {
    reason = 'most-viewed-alone';
  } else if (rated.length === 1) {
    reason = 'single-outlet';
  }
  return {
    tier,
    ratedOutlets: rated.length,
    leanSpread,
    domains,
    mostViewed: mvCurrent,
    weeksOnList,
    newestSeen,
    reason,
  };
}

/** The tier alone. See conversationEvidence for what each one means.
 * @param {any} entry @param {{ now?: number, today?: string }} [ctx] @returns {'c0'|'c1'|'c2'}
 */
export function conversationTier(entry, ctx) {
  return conversationEvidence(entry, ctx).tier;
}

/** Every slug at C1 or C2 in a document, newest-evidence first — the pool a
 *  consumer selects the news band from. Deterministic ties (C1 before C2, then
 *  more outlets, then newest, then slug).
 * @param {any} doc @param {{ now?: number, today?: string }} [ctx]
 * @returns {{ slug: string, tier: 'c1'|'c2', evidence: any }[]}
 */
export function conversationPool(doc, ctx) {
  const out = [];
  for (const [slug, entry] of Object.entries(doc?.slugs ?? {})) {
    const evidence = conversationEvidence(entry, ctx);
    if (evidence.tier === 'c0') continue;
    out.push({ slug, tier: /** @type {'c1'|'c2'} */ (evidence.tier), evidence });
  }
  out.sort(
    (a, b) =>
      a.tier.localeCompare(b.tier) ||
      b.evidence.ratedOutlets - a.evidence.ratedOutlets ||
      String(b.evidence.newestSeen).localeCompare(String(a.evidence.newestSeen)) ||
      a.slug.localeCompare(b.slug)
  );
  return out;
}

// ---- building the document ------------------------------------------------

/** @param {Record<string, any>} obj */
function sortKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

/**
 * Build the next committed document from the previous one plus this run's
 * observations. Pure: the caller supplies the clock, the bias map and the
 * observations; this decides what the file says.
 *
 * @param {{
 *   previous?: any,
 *   outletsBySlug?: Map<string, Iterable<string>> | Record<string, Iterable<string>>,
 *   mostViewed?: { entries?: { slug: string, rank: number }[], week?: string | null, weekLabel?: string | null, status?: string } | null,
 *   bias?: Record<string, string>,
 *   sourceStatus?: Record<string, any>,
 *   now: number,
 *   today?: string,
 * }} input
 * @returns {any}
 */
export function buildConversation({ previous, outletsBySlug, mostViewed, bias, sourceStatus, now, today: dayOverride }) {
  // `now` stamps the file; `today` files the observations. They are the same
  // date except on a run that straddles UTC midnight, where the caller passes
  // the SAME day key its decode budget and tier-0 slots are keyed by, so one
  // run's evidence and one run's spend can never land on different dates.
  const today = dayOverride ?? dayKey(now);
  const observations =
    outletsBySlug instanceof Map ? outletsBySlug : new Map(Object.entries(outletsBySlug ?? {}));
  const prevSlugs = previous?.slugs ?? {};
  const next = {};

  const touch = (slug) => {
    if (!next[slug]) {
      const prev = prevSlugs[slug];
      // Every carried slug goes through observeOutlets even with nothing
      // observed this run: that is what prunes the window AND re-judges each
      // carried outlet against the current bias table (see its comment).
      const folded = observeOutlets(prev, { observed: [], bias, today });
      next[slug] = { ...folded, mostViewed: prev?.mostViewed ?? null };
    }
    return next[slug];
  };

  // 1. carry every previous slug forward through the window prune
  for (const slug of Object.keys(prevSlugs)) touch(slug);

  // 2. fold in this run's press observations
  for (const [slug, observed] of observations) {
    const entry = touch(slug);
    const folded = observeOutlets(entry, { observed, bias, today });
    entry.outlets7d = folded.outlets7d;
    entry.unratedOutlets7d = folded.unratedOutlets7d;
  }

  // 3. fold in this run's most-viewed list
  for (const { slug, rank } of mostViewed?.entries ?? []) {
    const entry = touch(slug);
    entry.mostViewed = observeMostViewed(entry.mostViewed, { rank, week: mostViewed?.week ?? null, today });
  }

  // 4. drop slugs with nothing left to say (the window has passed them by)
  const slugs = {};
  for (const [slug, entry] of Object.entries(next)) {
    const mv =
      entry.mostViewed && daysBetween(entry.mostViewed.lastSeen, today) <= MOST_VIEWED_RETENTION_DAYS
        ? entry.mostViewed
        : null;
    if (entry.outlets7d.length === 0 && entry.unratedOutlets7d.length === 0 && !mv) continue;
    slugs[slug] = {
      outlets7d: entry.outlets7d,
      unratedOutlets7d: entry.unratedOutlets7d,
      mostViewed: mv,
    };
  }

  return {
    _meta: {
      schema: CONVERSATION_SCHEMA,
      fetched_at: new Date(now).toISOString(),
      window_days: OUTLET_WINDOW_DAYS,
      source_status: sourceStatus ?? {},
    },
    slugs: sortKeys(slugs),
  };
}

/**
 * Everything about the document EXCEPT the stamps that move every hour. Two
 * runs that observed the same conversation on the same day produce the same
 * string, which is what keeps an hourly cron from becoming an hourly deploy.
 *
 * Deliberately EXCLUDED: `_meta.fetched_at`, and every `checked_at` /
 * count inside source_status. A feed hiccupping for one run and recovering the
 * next must not produce a commit; the STATUS moving (ok -> dark) must.
 *
 * @param {any} doc
 * @returns {string}
 */
export function materialFingerprint(doc) {
  /** @param {any} v @param {string[]} fields */
  const pick = (v, fields) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? sortKeys(Object.fromEntries(Object.entries(v).filter(([f]) => fields.includes(f))))
      : v ?? null;
  const statuses = Object.fromEntries(
    Object.entries(doc?._meta?.source_status ?? {}).map(([k, v]) => [
      k,
      // `leans` is a MAP of leans, not a source, so it has to be descended
      // into: flattening it would have made a lean going dark — the one status
      // change critic B-4 exists to surface — invisible to the churn guard, and
      // the alarm would have sat in the run log with nothing committed to say
      // it happened.
      k === 'leans'
        ? sortKeys(Object.fromEntries(Object.entries(v ?? {}).map(([lean, s]) => [lean, pick(s, ['status', 'dark_days'])])))
        : pick(v, ['status', 'week']),
    ])
  );
  return JSON.stringify({
    window_days: doc?._meta?.window_days ?? null,
    source_status: sortKeys(statuses),
    slugs: doc?.slugs ?? {},
  });
}

/**
 * Should this run write the file at all? Only when the evidence moved: a new
 * outlet, a new day for one already recorded, a most-viewed transition, a
 * window prune, or a source status change. No age-based restamp — every claim
 * in here is day-granular, so an hours-fresher `fetched_at` would assert
 * nothing new and cost a commit.
 *
 * @param {{ previous: any, next: any }} input
 * @returns {boolean}
 */
export function shouldWrite({ previous, next }) {
  if (!previous) return true;
  return materialFingerprint(previous) !== materialFingerprint(next);
}

/**
 * Slugs that just ENTERED corroborated (C1) state — in `next`, not in
 * `previous`. This is the re-decode queue's eligibility half (the verdict half
 * is scripts/floor-signals-parse.mjs's `redecodeVerdict`, unchanged and
 * shared): a bill the press has just corroborated is a bill readers are about
 * to open, and hr-6500's page explaining the AGOA Extension Act while the
 * Senate voted a continuing resolution under that number is what this exists
 * to heal.
 *
 * ENTERING, not BEING: a bill that has been C1 for three days does not
 * re-queue every hour. And C2 is deliberately absent — most-viewed alone never
 * spends a cent (critic B-2).
 *
 * @param {{ previous?: any, next: any, now?: number, today?: string }} input
 * @returns {string[]}
 */
export function enteredCorroborated({ previous, next, now, today }) {
  const ctx = { today: today ?? dayKey(now ?? Date.now()) };
  const wasC1 = new Set(
    Object.entries(previous?.slugs ?? {})
      .filter(([, e]) => conversationTier(e, ctx) === 'c1')
      .map(([slug]) => slug)
  );
  return Object.entries(next?.slugs ?? {})
    .filter(([slug, e]) => !wasC1.has(slug) && conversationTier(e, ctx) === 'c1')
    .map(([slug]) => slug)
    .sort();
}

// ---- B-4: the dark-lean alarm --------------------------------------------

/**
 * Advance the per-lean liveness record. `liveLeans` is the set of rated leans
 * that produced at least one item this run; every rated lean the BASKET claims
 * to carry is tracked, so a lean whose only feed dies is visible as itself
 * rather than as a slightly smaller item count.
 *
 * Returns a fresh object (never mutates). A lean seen this run stamps today; a
 * lean not seen keeps its previous stamp, and `darkLeans` does the arithmetic.
 *
 * @param {Record<string, any> | null | undefined} prev
 * @param {{ basketLeans: Iterable<string>, liveLeans: Iterable<string>, today: string }} input
 * @returns {Record<string, { last_live: string | null, first_dark: string | null }>}
 */
export function rollLeanHealth(prev, { basketLeans, liveLeans, today }) {
  const live = new Set(liveLeans ?? []);
  const out = {};
  for (const lean of new Set(basketLeans ?? [])) {
    if (!RATED_LEANS.includes(lean)) continue;
    const before = prev?.[lean] ?? {};
    out[lean] = live.has(lean)
      ? { last_live: today, first_dark: null }
      : {
          last_live: before.last_live ?? null,
          // A lean with no history at all starts its clock today rather than
          // reading as infinitely dark on the first run after a cache loss.
          first_dark: before.first_dark ?? before.last_live ?? today,
        };
  }
  return out;
}

/**
 * Which rated leans have been dark for at least `alarmDays`, with how long.
 * A lean with no recorded liveness at all is measured from `first_dark`, which
 * rollLeanHealth always sets — so "we have never seen this lean" becomes an
 * alarm after the same seven days rather than never.
 *
 * @param {Record<string, any> | null | undefined} health
 * @param {{ today: string, alarmDays?: number }} input
 * @returns {{ lean: string, darkDays: number, lastLive: string | null }[]}
 */
export function darkLeans(health, { today, alarmDays = DARK_LEAN_ALARM_DAYS }) {
  const out = [];
  for (const [lean, entry] of Object.entries(health ?? {})) {
    if (entry?.last_live === today) continue;
    const from = entry?.last_live ?? entry?.first_dark ?? null;
    const darkDays = from ? daysBetween(from, today) : Infinity;
    if (Number.isFinite(darkDays) && darkDays >= alarmDays) {
      out.push({ lean, darkDays, lastLive: entry?.last_live ?? null });
    }
  }
  return out.sort((a, b) => b.darkDays - a.darkDays || a.lean.localeCompare(b.lean));
}

/** The status field stored per lean in the committed file: `ok` while the lean
 *  produced items recently, `dark` once it has been silent past the alarm.
 * @param {Record<string, any> | null | undefined} health
 * @param {{ today: string, alarmDays?: number }} input
 * @returns {Record<string, { status: 'ok' | 'dark', last_live: string | null, dark_days: number }>}
 */
export function leanStatuses(health, { today, alarmDays = DARK_LEAN_ALARM_DAYS }) {
  const alarms = new Map(darkLeans(health, { today, alarmDays }).map((d) => [d.lean, d.darkDays]));
  const out = {};
  for (const [lean, entry] of Object.entries(health ?? {})) {
    const from = entry?.last_live ?? entry?.first_dark ?? null;
    const gap = entry?.last_live === today ? 0 : from ? daysBetween(from, today) : 0;
    out[lean] = {
      status: alarms.has(lean) ? 'dark' : 'ok',
      last_live: entry?.last_live ?? null,
      dark_days: Number.isFinite(gap) ? gap : 0,
    };
  }
  return sortKeys(out);
}

// ---- the gate (scripts/check-conversation.mjs + scripts/verify-sync.mjs) ---

/**
 * The judgement half of the conversation gate — same split as
 * verifyFloorSignals / verifyMomentUpdates, so the CI check, the nightly
 * dead-man's-switch and the unit spec all run the identical rules.
 *
 * It polices ONE promise, the one every caption made from this file depends
 * on: the corroborating evidence is rated, dated, and inside the window it
 * claims. An unrated domain in `outlets7d` is not a schema nit — it is the
 * single-outlet prioritization channel B-1/B-3 exist to keep shut, so it fails
 * the build rather than reaching a page.
 *
 * @param {{ data: any, fileBytes?: number, now?: number, knownSlugs?: Set<string> | null, bias?: Record<string, string> | null }} input
 * @returns {{ failures: string[], warnings: string[], notes: string[] }}
 */
export function verifyConversation({ data, fileBytes, now = Date.now(), knownSlugs = null, bias = null }) {
  const failures = [];
  const warnings = [];
  const notes = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    failures.push(`${CONVERSATION_PATH} is not a JSON object`);
    return { failures, warnings, notes };
  }
  const meta = data._meta ?? {};
  if (meta.schema !== CONVERSATION_SCHEMA) {
    failures.push(
      `${CONVERSATION_PATH} carries an unknown _meta.schema (${JSON.stringify(meta.schema)}); this build writes ${CONVERSATION_SCHEMA}`
    );
  }
  if (!meta.fetched_at || !Number.isFinite(Date.parse(meta.fetched_at))) {
    failures.push(`${CONVERSATION_PATH} _meta.fetched_at is missing or unparseable`);
  }
  if (meta.window_days !== OUTLET_WINDOW_DAYS) {
    failures.push(
      `${CONVERSATION_PATH} _meta.window_days is ${JSON.stringify(meta.window_days)}; this build's evidence window is ${OUTLET_WINDOW_DAYS} days`
    );
  }
  if (Number.isFinite(fileBytes) && fileBytes > CONVERSATION_MAX_BYTES) {
    failures.push(
      `${CONVERSATION_PATH} is ${fileBytes} bytes, past the ${CONVERSATION_MAX_BYTES}-byte ceiling — the writer has stopped pruning its window`
    );
  }
  if (data.slugs !== undefined && (typeof data.slugs !== 'object' || data.slugs === null || Array.isArray(data.slugs))) {
    failures.push(`${CONVERSATION_PATH} .slugs is not an object keyed by bill slug`);
    return { failures, warnings, notes };
  }

  const stamp = Number.isFinite(Date.parse(meta.fetched_at)) ? dayKey(Date.parse(meta.fetched_at)) : dayKey(now);
  const tomorrow = dayKey(now + DAY_MS);
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  let ratedTotal = 0;
  let unratedTotal = 0;
  const tiers = { c0: 0, c1: 0, c2: 0 };
  const unknownSlugs = [];

  for (const [slug, entry] of Object.entries(data.slugs ?? {})) {
    if (!entry || typeof entry !== 'object') {
      failures.push(`${CONVERSATION_PATH} ${slug} is not an object`);
      continue;
    }
    for (const field of ['outlets7d', 'unratedOutlets7d']) {
      if (entry[field] !== undefined && !Array.isArray(entry[field])) {
        failures.push(`${CONVERSATION_PATH} ${slug}.${field} is not an array`);
      }
    }
    for (const o of entry.outlets7d ?? []) {
      ratedTotal++;
      const domain = normalizeDomain(o?.domain);
      if (!domain || domain !== o?.domain) {
        failures.push(`${CONVERSATION_PATH} ${slug} carries a non-canonical outlet domain ${JSON.stringify(o?.domain)}`);
        continue;
      }
      if (!RATED_LEANS.includes(o?.lean)) {
        failures.push(
          `${CONVERSATION_PATH} ${slug} outlet ${domain} has lean ${JSON.stringify(o?.lean)} — outlets7d is the CORROBORATING list and every entry must carry an AllSides lean (critic B-3)`
        );
      } else if (bias) {
        const actual = leanOf(domain, bias);
        if (actual === null) {
          failures.push(
            `${CONVERSATION_PATH} ${slug} counts ${domain} toward corroboration, but data/media-bias.json carries no rating for it — unrated domains corroborate nothing (critic B-3)`
          );
        } else if (actual !== o.lean) {
          failures.push(
            `${CONVERSATION_PATH} ${slug} records ${domain} as ${o.lean}; data/media-bias.json says ${actual}`
          );
        }
      }
      if (!isDate(o?.firstSeen) || !isDate(o?.lastSeen)) {
        failures.push(`${CONVERSATION_PATH} ${slug} outlet ${domain} has no YYYY-MM-DD firstSeen/lastSeen pair`);
        continue;
      }
      if (o.firstSeen > o.lastSeen) {
        failures.push(`${CONVERSATION_PATH} ${slug} outlet ${domain} was first seen (${o.firstSeen}) after it was last seen (${o.lastSeen})`);
      }
      if (o.lastSeen > tomorrow) {
        failures.push(`${CONVERSATION_PATH} ${slug} outlet ${domain} was last seen ${o.lastSeen}, in the future`);
      }
      const age = daysBetween(o.lastSeen, stamp);
      if (Number.isFinite(age) && age > OUTLET_WINDOW_DAYS) {
        failures.push(
          `${CONVERSATION_PATH} ${slug} outlet ${domain} was last seen ${o.lastSeen}, ${age} days before this file was written — past the ${OUTLET_WINDOW_DAYS}-day window it claims`
        );
      }
    }
    for (const o of entry.unratedOutlets7d ?? []) {
      unratedTotal++;
      const domain = normalizeDomain(o?.domain);
      if (!domain) {
        failures.push(`${CONVERSATION_PATH} ${slug} carries a non-canonical unrated domain ${JSON.stringify(o?.domain)}`);
        continue;
      }
      if (o?.lean !== undefined && o?.lean !== null) {
        failures.push(
          `${CONVERSATION_PATH} ${slug} unrated outlet ${domain} carries a lean (${JSON.stringify(o.lean)}) — a rated outlet belongs in outlets7d, not here`
        );
      }
      if (bias && leanOf(domain, bias) !== null) {
        failures.push(
          `${CONVERSATION_PATH} ${slug} files ${domain} as unrated, but data/media-bias.json rates it — it belongs in outlets7d where it can corroborate`
        );
      }
      if (!isDate(o?.firstSeen) || !isDate(o?.lastSeen)) {
        failures.push(`${CONVERSATION_PATH} ${slug} unrated outlet ${domain} has no YYYY-MM-DD firstSeen/lastSeen pair`);
      }
    }
    const mv = entry.mostViewed;
    if (mv !== undefined && mv !== null) {
      if (!Number.isInteger(mv.weeksOnList) || mv.weeksOnList < 1) {
        failures.push(`${CONVERSATION_PATH} ${slug} mostViewed.weeksOnList is ${JSON.stringify(mv.weeksOnList)}, not a positive integer`);
      }
      if (!Number.isInteger(mv.lastRank) || mv.lastRank < 1) {
        failures.push(`${CONVERSATION_PATH} ${slug} mostViewed.lastRank is ${JSON.stringify(mv.lastRank)}, not a positive integer`);
      }
      if (!isDate(mv.lastSeen)) {
        failures.push(`${CONVERSATION_PATH} ${slug} mostViewed.lastSeen is not a YYYY-MM-DD date`);
      } else if (mv.lastSeen > tomorrow) {
        failures.push(`${CONVERSATION_PATH} ${slug} mostViewed.lastSeen is ${mv.lastSeen}, in the future`);
      }
    }
    tiers[conversationEvidence(entry, { today: stamp }).tier]++;
    if (knownSlugs && !knownSlugs.has(slug)) unknownSlugs.push(slug);
  }

  // ONE line, not one per slug. A press feed citing a bill number this build
  // does not hold is ordinary (an untracked measure, a bill the sync has not
  // reached yet), it is worth knowing about in aggregate, and a wall of
  // near-identical warnings every CI run is how a gate teaches people to stop
  // reading it.
  if (unknownSlugs.length > 0) {
    warnings.push(
      `${CONVERSATION_PATH} carries ${unknownSlugs.length} slug(s) not in data/bills.json (${unknownSlugs.slice(0, 5).join(', ')}${unknownSlugs.length > 5 ? ', …' : ''}) — the press cited bills this build does not hold; nothing renders for them until the sync picks them up`
    );
  }

  for (const [lean, s] of Object.entries(meta.source_status?.leans ?? {})) {
    if (s?.status === 'dark') {
      warnings.push(
        `${CONVERSATION_PATH}: the ${lean}-rated half of the press basket has produced nothing for ${s.dark_days} days (last live ${s.last_live ?? 'never'}) — cross-spectrum corroboration is skewed while this lasts (critic B-4)`
      );
    }
  }

  notes.push(
    `conversation: ${Object.keys(data.slugs ?? {}).length} slug(s) — ${tiers.c1} corroborated, ${tiers.c2} most-viewed+, ${tiers.c0} evidence-only; ${ratedTotal} rated outlet observation(s), ${unratedTotal} unrated (counted by nothing)`
  );
  return { failures, warnings, notes };
}

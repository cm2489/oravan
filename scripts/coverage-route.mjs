/**
 * Which measure a vote report belongs to — the coverage sync's half of #303.
 * (2026-09-27)
 *
 * WHAT WAS WRONG. On 2026-09-24 the Senate voted 49-50 on H.Con.Res. 89, the
 * House-passed Iran war-powers resolution (data/votes.json s-119-2-244). #303
 * taught the NEWSDESK to send that vote's headlines to H.Con.Res. 89. The
 * nightly COVERAGE sync never got the same fix: it searches each bill on its
 * own, the relevance gate is asked "is this about THIS bill", and a headline
 * like "Senate rejects Iran war powers resolution" reads as being about every
 * one of the twelve Iran war-powers resolutions, which share one sentence of
 * title in two wordings. So on the 2026-09-27 file all five stored articles
 * about the 9/24 vote sat under S.J.Res. 185 (last acted on in June), and
 * H.Con.Res. 89, the measure the Senate actually voted on, held none.
 *
 * WHAT THIS DOES. `route(article, slug)` answers: is this stored (or newly
 * kept) article a report of a roll call the record says was held on a
 * DIFFERENT measure, one this article cannot be told apart from? If so it names
 * that measure, and the caller files the article there instead. All of these
 * must hold:
 *   1. The title reports a vote (VOTE_REPORT_RE).
 *   2. The article is dated, and the bill it is filed under had NO roll call in
 *      the OWN_VOTE_DAYS up to that date. A late write-up of a bill's own vote
 *      stays with that bill.
 *   3. Exactly ONE other measure had a roll call in the VOTE_REPORT_DAYS up to
 *      the article's date — in the chamber the title names, when it names
 *      exactly one — AND the article cannot tell that measure apart from the
 *      bill it is filed under. That test is #303's, imported, not copied:
 *      `headlineCannotSeparate` (scripts/newsdesk-match.mjs), which requires
 *      the two titles to be one family (`titleFamily`), the article to match
 *      the voted measure on a distinctive word the filed bill also carries, and
 *      nothing the article matched on the filed bill's title to name something
 *      the voted measure lacks. A Venezuela headline filed under the Venezuela
 *      resolution stays there while an Iran resolution is voted on.
 *      Two or more candidate measures is ambiguous, and ambiguity stays put.
 *   4. The article does not cite the bill it is filed under, or any measure
 *      other than the voted one (`findCitations`, #303's t1 regex).
 * The window is #303's: FLOOR_RECORD_HOURS (48h, so an article dated the day
 * of the vote through two days after it).
 *
 * TITLE FOR THE TEST, SNIPPET FOR THE VETO. Tests 1 and 3 and the chamber read
 * the TITLE alone, as #303 reads a headline; test 4 reads title and snippet,
 * because a citation anywhere can only block a move. Measured on the
 * 2026-09-27 file: running the separation test over the snippet too made
 * prose words count as subjects — "have" (in "would have required
 * congressional authorization", df 10) is a distinctive word of every S.J.Res.
 * title ("…that have not been authorized…"), so it kept one of the five 9/24
 * vote reports on S.J.Res. 185. The headline matcher was built and measured on
 * headlines; this uses it on one.
 *
 * WHAT IT NEVER DOES. It never deletes: a stored article is moved only when
 * it will be stored on the voted measure (refileStoredCoverage), and one that
 * would not fit stays where it was. It never hides: an article a Read section
 * shows is still shown after the move, there or where it was
 * (readSectionShows). It never moves an article to a bill whose
 * coverage the file will keep for less time than the bill it came from
 * (`coverageDurability`, applied by the caller's `canReceive`) — H.R. 5334 was
 * signed on 9/18 and stays in the sweep only through its 14-day grace, so the
 * Senate-passage articles filed under S. 5025 (still in committee) stay there.
 * It never reads a lean, an outlet or a model: the only inputs are the
 * article's own words and date, the corpus's titles, and the chambers'
 * roll-call record.
 *
 * Pure and I/O-free, like scripts/coverage-query.mjs; pinned by
 * tests/coverage-route.unit.spec.ts.
 */
import {
  FLOOR_RECORD_HOURS,
  NOT_A_CHAMBER_RE,
  buildBillIndex,
  findCitations,
  headlineCannotSeparate,
  tokenize,
} from './newsdesk-match.mjs';
import { articleMatcher, mergeArticles } from './coverage-query.mjs';
import { TERMINAL_STATUSES } from '../lib/urgency.mjs';
import { normalizeSource } from '../lib/press-outlets.mjs';

/** How long after a roll call an article can be a report of it: #303's
 *  floor-record window, in whole days (48h -> the vote's day and two after). */
export const VOTE_REPORT_DAYS = Math.ceil(FLOOR_RECORD_HOURS / 24);

/** A bill that had its OWN roll call this recently keeps a vote report filed
 *  under it: a write-up can trail its vote by a week, and when both the filed
 *  bill and a sibling voted, the article is ambiguous and stays. */
export const OWN_VOTE_DAYS = 7;

/** A title that reports a floor outcome. Deliberately the outcome words only
 *  ("rejects", "passes", "narrowly") and not the legislative vocabulary a
 *  preview or an explainer also uses ("bill", "resolution", "debate"). "Votes"
 *  is in it, so "Senate to vote on…" on the day of the vote qualifies; one the
 *  day before does not, because the window starts at the vote. */
export const VOTE_REPORT_RE =
  /\b(rejects?|rejected|defeats?|defeated|blocks?|blocked|fails?|failed|passes|passed|approves?|approved|votes?|voted|shoots? down|shot down|narrowly|adopts?|adopted|kills?|killed)\b/i;

const DAY_MS = 86_400_000;
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const dayOfArticle = (a) => {
  const d = String(a?.publishedAt ?? '').slice(0, 10);
  return isDay(d) ? d : null;
};
/** Whole days from `earlier` to `later`, both YYYY-MM-DD. */
const daysBetween = (earlier, later) =>
  Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / DAY_MS);
const within = (articleDay, voteDay, days) => {
  const d = daysBetween(voteDay, articleDay);
  return d >= 0 && d <= days;
};

/** The chambers a title names: "Senate", and "House" but never "White House".
 *  @param {string} title @returns {Set<'senate'|'house'>} */
export function chambersNamed(title) {
  const t = String(title ?? '').replace(NOT_A_CHAMBER_RE, ' ');
  /** @type {Set<'senate'|'house'>} */
  const out = new Set();
  if (/\bsenate\b/i.test(t)) out.add('senate');
  if (/\bhouse\b/i.test(t)) out.add('house');
  return out;
}

/**
 * How long data/coverage.json keeps a bill's coverage, as a rank:
 *   2  decoded and not terminal — kept for as long as it stays that way;
 *   1  in tonight's sweep only by an exception (a signed bill inside its
 *      enacted grace window, or a priority bill whatever its status) — kept
 *      only while the exception lasts;
 *   0  not in tonight's sweep — its coverage leaves the file tonight.
 * A move is allowed only to a bill ranked 1 or more AND at least as high as
 * the bill the article came from, so moving can never make an article leave
 * the file sooner than it would have.
 *
 * @param {any} b the bill (data/bills.json), or undefined
 * @param {boolean} inSweep whether tonight's sweep keeps its coverage
 * @returns {0|1|2}
 */
export function coverageDurability(b, inSweep) {
  if (!inSweep || !b) return 0;
  return b.ai_headline && !TERMINAL_STATUSES.has(b.status) ? 2 : 1;
}

/** The marker a moved or routed row carries: where it was found, and the roll
 *  call that says where it belongs. mergeArticles caps rows carrying it apart
 *  from the bill's own rows, so a routed row can never push an own row out. */
export function markRouted(article, from, route) {
  return { ...article, routed: { from, rollCall: route.rollCall } };
}

/**
 * The router over one night's inputs. `bills` is data/bills.json, `votes` is
 * data/votes.json (either may be missing or malformed: then nothing routes).
 *
 * @param {{ bills?: any[], votes?: any }} inputs
 */
export function createVoteRouter({ bills, votes } = {}) {
  const index = buildBillIndex(Array.isArray(bills) ? bills : []);
  const bySlug = index.bySlug ?? new Map();
  /** @type {{ id: string, chamber: 'senate'|'house', date: string, slug: string }[]} */
  const rolls = [];
  const raw = votes && typeof votes === 'object' && Array.isArray(votes.rollCalls) ? votes.rollCalls : [];
  for (const r of raw) {
    if (!r || typeof r.bill !== 'string' || !isDay(r.date)) continue;
    if (r.chamber !== 'senate' && r.chamber !== 'house') continue;
    rolls.push({ id: String(r.id ?? ''), chamber: r.chamber, date: r.date, slug: r.bill.toLowerCase() });
  }

  /**
   * @param {{ title?: string, snippet?: string|null, publishedAt?: string|null }} article
   * @param {string} slug the bill it is filed under
   * @returns {{ to: string, rollCall: string, date: string, chamber: 'senate'|'house' } | null}
   */
  function route(article, slug) {
    if (!article || typeof article !== 'object' || rolls.length === 0) return null;
    const day = dayOfArticle(article);
    if (!day) return null;
    const title = String(article.title ?? '');
    if (!VOTE_REPORT_RE.test(title.replace(NOT_A_CHAMBER_RE, ' '))) return null;
    const own = bySlug.get(slug);
    if (!own) return null;
    if (rolls.some((r) => r.slug === slug && within(day, r.date, OWN_VOTE_DAYS))) return null;

    // A citation anywhere in the article's text only ever BLOCKS a move.
    const cited = findCitations(`${title} ${article.snippet ?? ''}`).map((c) => c.slug);
    if (cited.includes(slug)) return null;
    // The separation test reads the title alone, as #303 reads a headline.
    const hTokens = tokenize(title);
    const chambers = chambersNamed(title);

    /** @type {Map<string, typeof rolls[number]>} */
    const found = new Map();
    for (const r of rolls) {
      if (r.slug === slug || !within(day, r.date, VOTE_REPORT_DAYS)) continue;
      if (chambers.size === 1 && !chambers.has(r.chamber)) continue;
      const f = bySlug.get(r.slug);
      if (!f) continue;
      if (!headlineCannotSeparate(hTokens, f, own, undefined, index, index.df)) continue;
      const prev = found.get(r.slug);
      if (!prev || r.date > prev.date || (r.date === prev.date && r.id > prev.id)) found.set(r.slug, r);
    }
    if (found.size !== 1) return null;
    const [[to, roll]] = found;
    if (cited.some((s) => s !== to)) return null;
    return { to, rollCall: roll.id, date: roll.date, chamber: roll.chamber };
  }

  return { route, rollCalls: rolls.length };
}

/**
 * Does the bill page show a Read section for these rows? lib/coverage.ts's
 * rule (coverageTier !== 'none': two or more distinct outlets), restated for
 * .mjs through lib/press-outlets.mjs's normalizeSource, which is pinned equal
 * to the TS one. tests/coverage-route.unit.spec.ts pins this against the real
 * getCoverage over every bill in the committed file, so a change to the
 * display rule turns that test red until this one follows it.
 *
 * @param {any[]|undefined} rows
 */
export function readSectionShows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return new Set(rows.map((a) => normalizeSource(a?.source))).size >= 2;
}

/**
 * One pass of the re-file: every candidate not in `excluded`, destination by
 * destination, one row at a time.
 * @param {Record<string, any>} src
 * @param {{ key: number, from: string, article: any, route: any }[]} candidates
 * @param {Set<number>} excluded
 * @param {number} cap
 */
function applyMoves(src, candidates, excluded, cap) {
  /** @type {Map<string, typeof candidates>} */
  const wanted = new Map();
  for (const c of candidates) {
    if (excluded.has(c.key)) continue;
    if (!wanted.has(c.route.to)) wanted.set(c.route.to, []);
    wanted.get(c.route.to).push(c);
  }
  /** @type {Map<string, Set<any>>} source slug -> rows leaving it */
  const leaving = new Map();
  /** @type {Map<string, any[]>} destination slug -> its rows after the moves */
  const arriving = new Map();
  const moves = [];
  const noRoom = [];
  const day = (a) => dayOfArticle(a) ?? '';
  for (const [to, list] of [...wanted].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // Newest first, then by source bill, so which rows fit is deterministic.
    const ordered = [...list].sort(
      (x, y) => day(y.article).localeCompare(day(x.article)) || (x.from < y.from ? -1 : x.from > y.from ? 1 : x.key - y.key)
    );
    let current = Array.isArray(src[to]) ? src[to] : [];
    for (const c of ordered) {
      // Same URL or same syndicated title: mergeArticles' own identity.
      const duplicate = articleMatcher(current)(c.article);
      if (!duplicate) {
        // One row at a time, so a move can never push out a row the
        // destination already stores (its own, or one moved on an earlier
        // night): if adding it would, or if it would not itself survive the
        // routed cap, it stays where it is.
        const row = markRouted(c.article, c.from, c.route);
        const next = mergeArticles(current, [row], cap);
        if (!next.includes(row) || current.some((x) => !next.includes(x))) {
          noRoom.push(c);
          continue;
        }
        current = next;
      }
      if (!leaving.has(c.from)) leaving.set(c.from, new Set());
      leaving.get(c.from).add(c.article);
      moves.push({ c, duplicate });
    }
    arriving.set(to, current);
  }

  /** @type {Record<string, any>} */
  const out = {};
  for (const [slug, arts] of Object.entries(src)) {
    if (slug.startsWith('_') || !Array.isArray(arts)) {
      out[slug] = arts;
      continue;
    }
    const base = arriving.get(slug) ?? arts;
    const gone = leaving.get(slug);
    const rows = gone ? base.filter((a) => !gone.has(a)) : base.slice();
    if (rows.length) out[slug] = rows;
  }
  for (const [to, rows] of arriving) {
    if (to in out || to in src) continue;
    const gone = leaving.get(to);
    const kept = gone ? rows.filter((a) => !gone.has(a)) : rows;
    if (kept.length) out[to] = kept;
  }
  return { out, moves, noRoom };
}

/**
 * Move every STORED vote report to the measure the record says was voted on.
 * Moves only, never deletes, never hides, and idempotent:
 *   - A row moves only when the destination will store it: the destination's
 *     routed rows are capped at `cap` (mergeArticles), and a row that would
 *     not survive that cap, or would push out a row the destination already
 *     stores, is NOT moved — it stays where it was. A row whose twin (same
 *     URL or syndicated title) is already on the destination moves too: the
 *     destination stores that article already, so the move removes a
 *     misfiled duplicate.
 *   - NOTHING SHOWN STOPS BEING SHOWN. Every row a Read section shows today
 *     (readSectionShows) is still shown after the pass: on its own bill, or,
 *     if it moved, on the bill it moved to. A move that would leave a shown
 *     row as the only outlet on its new bill, or leave a bill's remaining
 *     rows below the two-outlet floor, is taken back, and the check runs
 *     again until it holds. Measured on the 2026-09-27 file this is what keeps
 *     H.Con.Res. 75's two vote reports (the Senate's 6/23 vote on H.Con.Res.
 *     86, the House's 9/15 vote on H.Con.Res. 93) where readers see them: each
 *     would be the lone outlet on its voted measure.
 *   - A moved row carries `routed: {from, rollCall}`; the destination voted in
 *     the window, so the next pass's own-vote test keeps it there.
 *   - `canReceive(to, from)` must say yes: the destination's coverage stays
 *     in the file at least as long as the source's (coverageDurability).
 * Never mutates `coverage`; metadata keys ("_…") are copied through untouched.
 * A bill left with no rows is removed from the map, exactly as the sync writes
 * a bill with no coverage.
 *
 * @param {Record<string, any>} coverage data/coverage.json
 * @param {{ route: (a: any, slug: string) => any }} router
 * @param {{ cap: number, canReceive?: (to: string, from: string) => boolean }} opts
 * @returns {{ coverage: Record<string, any>, moves: { from: string, to: string, rollCall: string, title: string, url: string, source: string, duplicate: boolean }[], held: { from: string, to: string, rollCall: string, title: string, reason: 'room'|'visibility' }[] }}
 */
export function refileStoredCoverage(coverage, router, { cap, canReceive = () => true }) {
  const src = coverage && typeof coverage === 'object' && !Array.isArray(coverage) ? coverage : {};
  /** @type {{ key: number, from: string, article: any, route: any }[]} */
  const candidates = [];
  for (const [slug, arts] of Object.entries(src)) {
    if (slug.startsWith('_') || !Array.isArray(arts)) continue;
    for (const a of arts) {
      const r = router.route(a, slug);
      if (!r || !canReceive(r.to, slug)) continue;
      candidates.push({ key: candidates.length, from: slug, article: a, route: r });
    }
  }

  /** @type {Set<number>} moves taken back so a shown row stays shown */
  const hidden = new Set();
  let pass = applyMoves(src, candidates, hidden, cap);
  for (;;) {
    const movedTo = new Map(pass.moves.map((m) => [m.c.article, m.c]));
    const takeBack = new Set();
    for (const [slug, arts] of Object.entries(src)) {
      if (slug.startsWith('_') || !readSectionShows(arts)) continue;
      const stillShown = readSectionShows(pass.out[slug]);
      for (const a of arts) {
        const c = movedTo.get(a);
        if (c) {
          if (!readSectionShows(pass.out[c.route.to])) takeBack.add(c.key);
        } else if (!stillShown) {
          // A row that stayed lost its section: the moves out of this bill did it.
          for (const m of pass.moves) if (m.c.from === slug) takeBack.add(m.c.key);
        }
      }
    }
    if (takeBack.size === 0) break;
    for (const k of takeBack) hidden.add(k);
    pass = applyMoves(src, candidates, hidden, cap);
  }

  const note = (c) => ({ from: c.from, to: c.route.to, rollCall: c.route.rollCall, title: String(c.article.title ?? '') });
  return {
    coverage: pass.out,
    moves: pass.moves.map(({ c, duplicate }) => ({
      ...note(c),
      url: String(c.article.url ?? ''),
      source: String(c.article.source ?? ''),
      duplicate,
    })),
    held: [
      ...pass.noRoom.map((c) => ({ ...note(c), reason: /** @type {const} */ ('room') })),
      ...candidates.filter((c) => hidden.has(c.key)).map((c) => ({ ...note(c), reason: /** @type {const} */ ('visibility') })),
    ],
  };
}

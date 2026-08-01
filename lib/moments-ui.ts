/*
 * Presentation-only helpers for the Moments UI. Deliberately separate from
 * lib/moments.ts (the data layer: pure lifecycle computation, gated by
 * scripts/check-moments.mjs and pinned by tests/moments.unit.spec.ts) — this
 * file has no CI gate and no pinned tests of its own, so it stays a thin
 * layer the pages can lean on without touching the tested surface.
 */
import { getBill } from './core/bills';
import { getUpdates, groupUpdatesByDay, type UpdateDayGroup } from './moment-updates';
import { getLiveMoments, type Localized, type MomentVehicle } from './moments';

/*
 * Sentence-final punctuation is ambiguous in legislative prose. "U.S. forces
 * have been involved…", "H.R. 8800 would…", "Sen. Smith said…" all put a
 * period-plus-space *inside* the first sentence, and the naive
 * /^.*?[.!?](?:\s|$)/ this replaced stopped at the first one — so the Iran
 * moment's dek rendered as the literal two-letter string "U.S." on /moments,
 * in the homepage strip, and (worst) as the page's <meta description> and
 * og:description. English only: the Spanish summary opens "Fuerzas de Estados
 * Unidos…" and was unaffected, which is exactly why it survived review.
 *
 * A period ends a sentence only when the token before it is not an
 * abbreviation. Two tests, cheap and locale-safe:
 *   1. any token carrying an internal dot is an initialism (U.S, S.J.Res)
 *   2. an explicit list covers short prose abbreviations in EN and ES
 * MIN_DEK is the backstop for abbreviations neither test knows: a "sentence"
 * shorter than this is never a real one in this corpus.
 */
const ABBREVIATIONS = new Set([
  // legislative citation forms that survive tokenizing
  's', 'no', 'art', 'sec', 'pub', 'stat',
  // titles, EN
  'sen', 'rep', 'gov', 'dr', 'mr', 'mrs', 'ms', 'st', 'vs', 'etc', 'al', 'inc',
  // months, EN
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  // ES
  'ee', 'uu', 'sr', 'sra', 'srta', 'núm', 'pág', 'ej', 'cf',
]);

// Backstop only — the two tests above do the real work. Kept just above the
// length of the longest abbreviation-fragment they could miss, so a genuinely
// short first sentence ("The House voted to pass it.") is not swallowed.
const MIN_DEK = 16;

function endsInAbbreviation(prefix: string): boolean {
  const token = prefix.slice(0, -1).split(/[\s("'“‘¿¡]/).pop() ?? '';
  if (!token) return false;
  if (token.includes('.')) return true; // initialism: U.S, H.R, S.J.Res
  return ABBREVIATIONS.has(token.toLowerCase());
}

/**
 * A short one-line teaser derived from the moment's full summary — the data
 * model (spec §4.1) has no separate one-liner "dek" field, so the dek is the
 * summary's first sentence. Falls back to the whole string when no sentence
 * boundary is found. Pure string logic; adds no new AI surface.
 */
export function momentDek(summary: string): string {
  const text = summary.trim();
  const boundary = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;

  while ((match = boundary.exec(text)) !== null) {
    const end = match.index + 1;
    if (end < MIN_DEK) continue;
    // ? and ! are unambiguous; only . needs the abbreviation test.
    if (match[0] === '.' && endsInAbbreviation(text.slice(0, end))) continue;
    return text.slice(0, end);
  }
  return text;
}

/**
 * The timeline's day frame (v2 spec §3): the last `windowDays` ET days —
 * quiet ones included, because a day nothing happened is a first-class render
 * — PLUS any OLDER day that actually carries a recorded action.
 *
 * The tail matters: retention keeps 60 days, and a roll-call vote from six
 * weeks ago is still the record. Dropping it because it fell off a two-week
 * frame would be an editorial act, which is what §3 exists to forbid. Older
 * days that are EMPTY are dropped, though — a two-month run of "nothing
 * recorded" is not information, it is padding.
 *
 * Implemented by widening the reader's own window rather than hand-rolling a
 * second grouping, so exactly one code path computes days, class-priority
 * ordering, the render cap, and the overflow count.
 *
 * The clock is a defaulted parameter (the same idiom as lib/moments.ts and
 * lib/freshness-state.ts) so tests can pin the frame — and so the pages,
 * which are statically generated, never call an impure function inside a
 * component body.
 */
export function timelineDays(
  momentId: string,
  windowDays: number,
  now: number = Date.now(),
): UpdateDayGroup[] {
  const all = getUpdates(momentId);
  const oldest = all.reduce<string | null>((min, u) => (!min || u.day < min ? u.day : min), null);
  // +2 days of slack absorbs the ET-vs-UTC boundary at both ends of the span.
  const spanDays = oldest
    ? Math.ceil((now - Date.parse(`${oldest}T00:00:00Z`)) / 86_400_000) + 2
    : windowDays;
  const groups = groupUpdatesByDay(momentId, Math.max(windowDays, spanDays), now);
  return [...groups.slice(0, windowDays), ...groups.slice(windowDays).filter((d) => !d.quiet)];
}

/**
 * The display label for an external reference: its host, minus the "www."
 * noise ("https://www.congress.gov/bill/…" → "congress.gov"). Naming the
 * source is the point — a row of "Source 1 · Source 2" links tells a reader
 * nothing about whether the evidence is the government's own record or a
 * newspaper's. Unparseable input returns the raw string rather than throwing:
 * the gate already guarantees https, so this is a belt, not a brace.
 */
export function linkHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * The most recent last_action_date across a moment's vehicle bills — the
 * "updated" date shown on the index card. Read-time, off the live corpus,
 * like every other freshness signal on the site (never stored). A vehicle
 * slug that doesn't resolve (should never happen past the CI gate)
 * contributes nothing rather than throwing.
 */
export function latestVehicleAction(vehicles: MomentVehicle[]): string | null {
  let latest: string | null = null;
  for (const v of vehicles) {
    const d = getBill(v.slug)?.last_action_date;
    if (d && (!latest || d > latest)) latest = d;
  }
  return latest;
}

/*
 * `changed_because` is the collector's own audit trail, not prose. Its values
 * are machine tokens — 'seed', 'updates:+2', 'reanchor:12d',
 * 'status:sjres-185-119 floor_vote→committee' — and the revision-history
 * disclosure printed them verbatim, so /moments/government-funding-deadline
 * read "Rewritten because seed" in English and the IDENTICAL untranslated
 * "Se reescribió porque seed" in Spanish: an English token inside Spanish
 * chrome, past next-intl entirely, live in production. The status form is
 * worse — it carries the raw bill-status enum that scripts/moment-updates.mjs
 * goes out of its way to keep out of reader-facing prose (pre-launch audit
 * 2026-07-25, constitution-07).
 *
 * The stored tokens do not change; this maps each one to a message key the
 * page renders through next-intl, in the reader's language. A token nobody
 * has taught this function about maps to nothing and the reason simply is not
 * shown — silence, never the token, because a reader learns less than nothing
 * from 'reanchor:12d'.
 *
 * The producers: scripts/moment-updates.mjs:597 `changedBecause` emits
 * 'first-summary', `status:${slug} ${from}→${to}`, `updates:+${n}` and
 * `reanchor:${n}d`; 'seed' is the hand-authored first revision the live layer
 * shipped with. tests/moments-ui.unit.spec.ts pins all five against the
 * shipped corpus, so a sixth token cannot land unnoticed.
 */
export type RevisionReasonKey = 'first' | 'newActions' | 'statusMoved' | 'reanchor';

export interface RevisionReason {
  /** Message key under `moments.updates.reason`. */
  key: RevisionReasonKey;
  /** ICU arguments, for the phrases that carry a number. */
  values?: Record<string, number>;
}

const UPDATES_TOKEN = /^updates:\+(\d+)$/;
const REANCHOR_TOKEN = /^reanchor:(\d+)d$/;

function revisionReason(token: string): RevisionReason | null {
  // Two names for one event: the collector's, and the hand-authored seed's.
  if (token === 'first-summary' || token === 'seed') return { key: 'first' };
  const updates = UPDATES_TOKEN.exec(token);
  if (updates) return { key: 'newActions', values: { count: Number(updates[1]) } };
  const reanchor = REANCHOR_TOKEN.exec(token);
  if (reanchor) return { key: 'reanchor', values: { days: Number(reanchor[1]) } };
  // The slug and the from→to enums are dropped on purpose: what a reader is
  // owed here is "a bill moved", not 'sjres-185-119 committee→floor_vote'.
  if (token.startsWith('status:')) return { key: 'statusMoved' };
  return null;
}

/**
 * The renderable reasons for one revision, in the collector's order and
 * de-duplicated — a summary rewritten because three of its bills all changed
 * stage says that once, not three times. An empty array is the honest
 * outcome for a revision whose tokens are all unrecognized: the page renders
 * no reason line at all.
 */
export function revisionReasons(tokens: readonly string[]): RevisionReason[] {
  const out: RevisionReason[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const reason = revisionReason(token);
    if (!reason) continue;
    const fingerprint = `${reason.key}:${JSON.stringify(reason.values ?? null)}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(reason);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * SEARCH PINNING (spec §7.3 — the v1 §4.2 promise that was never built).
 *
 * `aliases` has existed in data/moments.json since the first entry, parity-
 * checked by lib/moments-gate.mjs, and nothing read it. So a visitor typing
 * "ukraine" — or "shutdown", or "war with iran" — into the bills browser hit
 * "No bills match", because the corpus indexes bill titles and identifiers,
 * and no bill is titled with the words a person uses for the fight it is part
 * of. The moment that answers them was one route away and invisible.
 * ------------------------------------------------------------------------ */

/**
 * A live moment reduced to exactly what a pinned search row needs: the two
 * strings it RENDERS (name, dek) and the strings it MATCHES ON and never
 * renders.
 */
export interface MomentSearchTeaser {
  id: string;
  /** Localized display name. */
  name: string;
  /** First sentence of the localized summary — AI-drafted, labeled at the
   *  render site like every other dek. */
  dek: string;
  /**
   * SEARCH-ONLY, NEVER RENDERED — the contract lib/moments.ts states on the
   * field itself. Aliases are the words the press uses ("shutdown",
   * "strikes on iran"); a moment's NAME is the neutral one we chose. Echoing
   * an alias back to a reader would put a headline's framing in our voice on
   * a nonpartisan surface, so no consumer of this type may print them.
   */
  aliases: string[];
}

/**
 * The live moments a query may pin, pre-localized for one locale.
 *
 * LIVE ONLY. `stale` still renders on /moments (with its own badge) and is
 * dropped from the homepage strip and search pinning — the rule
 * app/[locale]/moments/page.tsx already states in the comment above its own
 * filter. Pinning a moment whose scheduled review lapsed would push an
 * unrenewed claim in front of someone who asked about something else;
 * /moments is a page you chose to visit, a pin is not. `settled` and
 * `retired` are excluded by the same call.
 *
 * The clock is a defaulted parameter (the idiom of lib/moments.ts and
 * timelineDays above) so tests can pin the frame and pages never call an
 * impure function inside a component body.
 */
export function getMomentSearchTeasers(locale: string, now: number = Date.now()): MomentSearchTeaser[] {
  const pick = (l: Localized) => (locale === 'es' ? l.es : l.en);
  return getLiveMoments(now).map((m) => ({
    id: m.id,
    name: pick(m.name),
    dek: momentDek(pick(m.summary)),
    // Parity is already enforced by the gate, so reading one locale's list is
    // safe — there is no "fall back to English aliases" path to get wrong.
    aliases: locale === 'es' ? m.aliases.es : m.aliases.en,
  }));
}

/**
 * Two characters. Below that every query matches something under the
 * containment rule below ("a" is inside "war powers"), which is not a search
 * result, it is noise on top of the reader's actual results.
 */
const MIN_QUERY = 2;

/**
 * Which moments a query pins. Pure — no data access, no clock, no locale
 * logic — so the browser can call it on every keystroke and a unit test can
 * pin its rules without the corpus.
 *
 * BIDIRECTIONAL CONTAINMENT, because the two failures are opposite shapes:
 *   - the reader is still typing: "ukr" is a prefix of the alias "ukraine"
 *   - the reader typed a sentence: "war with iran today" CONTAINS the alias
 * A one-directional `alias.includes(q)` catches only the first. The same
 * containment runs against the localized name, so someone who typed the
 * moment's actual title finds it whether or not an alias repeats it.
 *
 * Aliases shorter than MIN_QUERY are skipped in the query-contains-alias
 * direction as well; a one-letter alias would pin every query in the corpus.
 */
export function matchMoments<T extends MomentSearchTeaser>(query: string, teasers: T[]): T[] {
  const q = query.trim().toLowerCase();
  if (q.length < MIN_QUERY) return [];
  return teasers.filter((m) => {
    if (m.name.toLowerCase().includes(q)) return true;
    return m.aliases.some((raw) => {
      const alias = raw.trim().toLowerCase();
      if (alias.length < MIN_QUERY) return false;
      return alias.includes(q) || q.includes(alias);
    });
  });
}

/*
 * Presentation-only helpers for the Moments UI. Deliberately separate from
 * lib/moments.ts (the data layer: pure lifecycle computation, gated by
 * scripts/check-moments.mjs and pinned by tests/moments.unit.spec.ts) — this
 * file has no CI gate and no pinned tests of its own, so it stays a thin
 * layer the pages can lean on without touching the tested surface.
 */
import { getBill } from './core/bills';
import { getUpdates, groupUpdatesByDay, type UpdateDayGroup } from './moment-updates';
import type { MomentVehicle } from './moments';

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

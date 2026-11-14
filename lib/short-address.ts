/*
 * SHORT ADDRESSES FOR BILLS: oravan.org/hr9340 opens that bill's page.
 *
 * Why (owner decisions of 2026-09-26): the bill number is the link a person
 * can say, type or paste from a post where links are not tappable. Every
 * short address lands on the bill's explanation, never on a dialer (card d4:
 * "every link lands on the explanation"); the call is the page's own next
 * step.
 *
 * HOW IT RUNS. proxy.ts, which already runs on every page request for locale
 * negotiation, asks this module one question per request: is this path a
 * short address for a bill the corpus holds, and which one? The answer comes
 * from small tables, one per Congress the corpus holds, each a bitset per
 * bill type (one bit per bill number), encoded at BUILD time by
 * next.config.ts from data/bills.json and inlined into the proxy bundle as
 * strings: one for the tracked Congress, and one for each ended Congress the
 * corpus holds (none while nothing has ended). The corpus itself is never
 * imported here or in proxy.ts, and the lookup is at most one constant-time
 * bit test per table (today: one table, one bit test). Its one
 * import is lib/congress.mjs, the single source of the Congress number and
 * the ended list, which is itself import-free (no imports, no I/O, no
 * environment), so next.config.ts, proxy.ts and the unit specs can all load
 * this file as-is and it can never reach data/.
 *
 * WHEN CONGRESS CHANGES (the owner's ruling, SHORT_ADDRESS_ROLLOVER_RULING
 * below). Bill numbers restart with each Congress, so after Jan 3, 2027
 * /hr1 can name two bills. A short address opens the tracked Congress's bill
 * when the corpus holds it; otherwise the bill with that type and number in
 * the most recently ended Congress that holds one, searching the ended
 * Congresses from the most recent backwards; otherwise the site's normal
 * 404. The ended bill's own page shows how it stands: the ended note for an
 * unfinished bill, its outcome for one that became law or was otherwise
 * decided. Nothing here needs editing at the switch: moving the tracked
 * number and filling ENDED_CONGRESSES in lib/congress.mjs is the whole
 * change, and the switch with no bill of the new Congress yet is covered
 * (every ended bill then resolves to its own page).
 *
 * WHAT IT NEVER DOES: carry a query string onward (a shared link never
 * carries a stance, CLAUDE.md rule 1), answer for a bill the corpus does not
 * hold (those fall through to the site's normal 404), or shadow a real route
 * (tests/short-address.unit.spec.ts lists every top-level segment of the
 * app/ tree and proves none matches the pattern).
 */

import { CONGRESS_POLICY, CURRENT_CONGRESS } from './congress.mjs';

/**
 * The Congress a short address means first. A short address carries no
 * Congress number, so /hr1 resolves to H.R. 1 of THIS Congress when the
 * corpus holds it: the one the whole build tracks, read from lib/congress.mjs
 * (since 2026-11-12 the only place the number is written;
 * tests/congress-source.unit.spec.ts pins this use). When it does not, an
 * ended Congress's bill answers (shortAddressFallbackCongresses below).
 */
export const SHORT_ADDRESS_CONGRESS: number = CURRENT_CONGRESS.number;

/**
 * The owner's dated ruling on what a short address opens once a new Congress
 * has started, quoted in the words of the card he answered. The card's
 * question, its examples and its promise are quoted in
 * tests/short-address.unit.spec.ts, which pins the behaviour built from it.
 *
 * His sentence speaks of one ended Congress ("the ended one"); in 2027 there
 * is only one. What happens once two or more have ended (from 2029) is NOT
 * his sentence: it is the orchestrating session's reading of his words and
 * of the reason the card gave him ("links shared this year keep working for
 * as long as they can"), dated 2026-11-14: search the ended Congresses from
 * the most recent backwards, and open the first that holds the bill.
 */
export const SHORT_ADDRESS_ROLLOVER_RULING: string | null =
  'Decision 190, clicked Saturday, Nov 14, 2026, 12:41 PM ET. Asked "Once the new Congress starts, which bill ' +
  'should a short address open?", the owner chose option a: "The newest Congress, falling back to the ended one ' +
  'when the new one has no such bill yet."';

/**
 * Every bill type a short address can name: the eight measure types
 * Congress numbers. The corpus decides which of them resolve (on 2026-09-29
 * it held hr, s, hjres, sjres, hconres and sconres, and no simple
 * resolutions), so /hres10 parses but, until the corpus holds one, 404s.
 */
export const SHORT_ADDRESS_TYPES = ['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres', 'hres', 'sres'] as const;

export type ShortAddressType = (typeof SHORT_ADDRESS_TYPES)[number];

export interface ShortAddress {
  type: ShortAddressType;
  number: number;
}

// Longest type names first, so "hconres5" is never read as "h…" anything.
// Numbers: no leading zero, at most five digits (the House passes 10,000
// around the end of a Congress; nothing reaches 100,000).
const SHORT_ADDRESS_PATTERN = /^(hconres|sconres|hjres|sjres|hres|sres|hr|s)-?([1-9]\d{0,4})$/;

/**
 * Read one path segment as a short address. Case-insensitive, with or
 * without one hyphen between type and number: hr9340, HR9340, hr-9340,
 * Hr-9340. Anything else (dots, spaces, a Congress suffix, a leading zero,
 * percent-encoding) is not a short address and returns null.
 */
export function parseShortAddress(segment: string): ShortAddress | null {
  const match = SHORT_ADDRESS_PATTERN.exec(segment.toLowerCase());
  if (!match) return null;
  return { type: match[1] as ShortAddressType, number: Number(match[2]) };
}

/** The canonical bill slug a short address points at, e.g. hr-9340-119. */
export function shortAddressSlug(address: ShortAddress, congress: number = SHORT_ADDRESS_CONGRESS): string {
  return `${address.type}-${address.number}-${congress}`;
}

// --- the build-time index -----------------------------------------------------

/** The fields of a corpus bill this index reads (lib/types.ts's Bill has them). */
export interface ShortAddressBill {
  bill_type: string;
  bill_number: number;
  congress_number: number;
}

/**
 * Encode which bills exist, for one Congress, as `type:<base64 bitset>`
 * pairs joined by `;` — bit N of a type's bitset is set when that type's
 * bill N is in the corpus. About 3 KB for the whole 119th Congress. Called
 * by next.config.ts at build time; never at request time.
 */
export function encodeShortAddressIndex(bills: readonly ShortAddressBill[], congress: number): string {
  const byType = new Map<ShortAddressType, number[]>();
  for (const bill of bills) {
    if (bill.congress_number !== congress) continue;
    const parsed = parseShortAddress(`${bill.bill_type}${bill.bill_number}`);
    if (!parsed) continue;
    const list = byType.get(parsed.type) ?? [];
    list.push(parsed.number);
    byType.set(parsed.type, list);
  }
  const parts: string[] = [];
  for (const type of SHORT_ADDRESS_TYPES) {
    const numbers = byType.get(type);
    if (!numbers || numbers.length === 0) continue;
    const bytes = new Uint8Array((Math.max(...numbers) >> 3) + 1);
    for (const n of numbers) bytes[n >> 3] |= 1 << (n & 7);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    parts.push(`${type}:${btoa(binary)}`);
  }
  return parts.join(';');
}

export type ShortAddressIndex = ReadonlyMap<string, Uint8Array>;

/** Decode the string above once, at module load. A malformed pair is skipped. */
export function decodeShortAddressIndex(encoded: string | undefined): ShortAddressIndex {
  const index = new Map<string, Uint8Array>();
  for (const pair of (encoded ?? '').split(';')) {
    const colon = pair.indexOf(':');
    if (colon <= 0) continue;
    try {
      const binary = atob(pair.slice(colon + 1));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      index.set(pair.slice(0, colon), bytes);
    } catch {
      // Not base64: leave that type out, so its addresses 404 rather than throw.
    }
  }
  return index;
}

/** Constant time: one map read and one bit test. */
export function indexHas(index: ShortAddressIndex, address: ShortAddress): boolean {
  const bytes = index.get(address.type);
  if (!bytes) return false;
  const byte = bytes[address.number >> 3];
  return byte !== undefined && (byte & (1 << (address.number & 7))) !== 0;
}

/** The two things the fallback reads from lib/congress.mjs's CONGRESS_POLICY
 *  (a test passes its own, shaped like the switch). */
export interface ShortAddressPolicy {
  tracked: number;
  ended: ReadonlyArray<{ number: number; ended: string }>;
}

/**
 * THE FALLBACK ORDER: every ended Congress whose bills the corpus holds,
 * most recently ended first (empty today: lib/congress.mjs lists no ended
 * Congress). Only a Congress on the ended list counts, and only when the
 * corpus holds at least one of its bills; the latest `ended` date comes
 * first (the larger number on a tie). Called at build time only.
 */
export function shortAddressFallbackCongresses(
  bills: readonly ShortAddressBill[],
  policy: ShortAddressPolicy = CONGRESS_POLICY,
): number[] {
  const held = new Set(bills.map((b) => b.congress_number));
  return policy.ended
    .filter((entry) => entry.number !== policy.tracked && held.has(entry.number))
    .slice()
    .sort((a, b) => (a.ended === b.ended ? b.number - a.number : a.ended < b.ended ? 1 : -1))
    .map((entry) => entry.number)
    .filter((n, i, all) => all.indexOf(n) === i);
}

/**
 * The fallback tables, for proxy.ts: `<congress>@<index>` per ended Congress,
 * in fallback order, joined by `|`; '' when there is none. Built by
 * next.config.ts at build time; '' on every build while the ended list is
 * empty. Each ended Congress adds one table of the size of its own bitset
 * (about 2.9 KB for a full Congress).
 */
export function encodeShortAddressFallback(
  bills: readonly ShortAddressBill[],
  policy: ShortAddressPolicy = CONGRESS_POLICY,
): string {
  return shortAddressFallbackCongresses(bills, policy)
    .map((congress) => `${congress}@${encodeShortAddressIndex(bills, congress)}`)
    .join('|');
}

/** The decoded fallback tables, in the order they are searched. Empty: no fallback. */
export type ShortAddressFallback = ReadonlyArray<{ congress: number; index: ShortAddressIndex }>;

/** Decode the string above once, at module load. A malformed table is skipped; the order is kept. */
export function decodeShortAddressFallback(encoded: string | undefined): ShortAddressFallback {
  const tables: Array<{ congress: number; index: ShortAddressIndex }> = [];
  for (const part of (encoded ?? '').split('|')) {
    const match = /^([1-9]\d{0,3})@(.*)$/.exec(part);
    if (!match) continue;
    const index = decodeShortAddressIndex(match[2]);
    if (index.size > 0) tables.push({ congress: Number(match[1]), index });
  }
  return tables;
}

/**
 * The redirect target for a request path, or null when the path is not a
 * short address for a bill any table holds.
 *
 * Accepted shapes: /<short> and /<locale>/<short> (a trailing slash is
 * tolerated). The target is the bill's canonical page as a PATH only, with
 * no query string: /es/<short> goes to /es/bills/<slug>; /<short> and
 * /en/<short> go to the bare /bills/<slug>, which is the English page under
 * the site's `as-needed` locale prefix (i18n/routing.ts) and which then
 * meets the site's normal locale handling like any other bare path.
 *
 * Which bill: the tracked Congress's when `index` holds it; otherwise the
 * first fallback table, in order, that holds it; otherwise null. With no
 * fallback (empty, as on every build while nothing has ended) this is
 * exactly the one-table lookup of #404.
 */
export function shortAddressTarget(
  pathname: string,
  locales: readonly string[],
  defaultLocale: string,
  index: ShortAddressIndex,
  fallback: ShortAddressFallback = [],
  congress: number = SHORT_ADDRESS_CONGRESS,
): string | null {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  let locale: string | null = null;
  if (segments.length === 2 && locales.includes(segments[0])) locale = segments.shift() ?? null;
  if (segments.length !== 1) return null;
  const address = parseShortAddress(segments[0]);
  if (!address) return null;
  let resolved: number | null = indexHas(index, address) ? congress : null;
  for (const table of fallback) {
    if (resolved !== null) break;
    if (indexHas(table.index, address)) resolved = table.congress;
  }
  if (resolved === null) return null;
  const prefix = locale && locale !== defaultLocale ? `/${locale}` : '';
  return `${prefix}/bills/${shortAddressSlug(address, resolved)}`;
}

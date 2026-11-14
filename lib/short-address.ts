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
 * short address for a bill the corpus holds? The answer comes from a small
 * bitset per bill type (one bit per bill number), encoded at BUILD time by
 * next.config.ts from data/bills.json and inlined into the proxy bundle as a
 * string. The corpus itself is never imported here or in proxy.ts, and the
 * lookup is a constant-time bit test. Its one import is lib/congress.mjs, the
 * single source of the Congress number, which is itself import-free (no
 * imports, no I/O, no environment), so next.config.ts, proxy.ts and the unit
 * specs can all load this file as-is and it can never reach data/.
 *
 * WHAT IT NEVER DOES: carry a query string onward (a shared link never
 * carries a stance, CLAUDE.md rule 1), answer for a bill the corpus does not
 * hold (those fall through to the site's normal 404), or shadow a real route
 * (tests/short-address.unit.spec.ts lists every top-level segment of the
 * app/ tree and proves none matches the pattern).
 */

import { CURRENT_CONGRESS } from './congress.mjs';

/**
 * The Congress a short address means. A short address carries no Congress
 * number, so /hr1 resolves to H.R. 1 of THIS Congress: the one the whole
 * build tracks, read from lib/congress.mjs (since 2026-11-12 the only place
 * the number is written; tests/congress-source.unit.spec.ts pins this use).
 *
 * The owner's go (2026-11-13, 11:21 AM ET: "Go: merge #404 as built, with bill
 * numbers") covers the 119th Congress only. What /hr1 means once the 120th
 * convenes on Jan 3, 2027 is HIS decision, still open. Until he rules,
 * tests/short-address.unit.spec.ts fails the moment lib/congress.mjs lists
 * an ended Congress, or the corpus holds a Congress other than this one, so
 * the January switch cannot quietly re-point every short address.
 */
export const SHORT_ADDRESS_CONGRESS: number = CURRENT_CONGRESS.number;

/**
 * The owner's dated ruling on what a short address means after the change
 * of Congress, quoted word for word with its date, once he gives it. Null
 * until then. Setting it is the deliberate act that lets the corpus hold
 * more than one Congress under the same short addresses, and it lands in the
 * same pull request that builds what he chose.
 */
export const SHORT_ADDRESS_ROLLOVER_RULING: string | null = null;

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

/**
 * The redirect target for a request path, or null when the path is not a
 * short address for a bill the index holds.
 *
 * Accepted shapes: /<short> and /<locale>/<short> (a trailing slash is
 * tolerated). The target is the bill's canonical page as a PATH only, with
 * no query string: /es/<short> goes to /es/bills/<slug>; /<short> and
 * /en/<short> go to the bare /bills/<slug>, which is the English page under
 * the site's `as-needed` locale prefix (i18n/routing.ts) and which then
 * meets the site's normal locale handling like any other bare path.
 */
export function shortAddressTarget(
  pathname: string,
  locales: readonly string[],
  defaultLocale: string,
  index: ShortAddressIndex,
): string | null {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  let locale: string | null = null;
  if (segments.length === 2 && locales.includes(segments[0])) locale = segments.shift() ?? null;
  if (segments.length !== 1) return null;
  const address = parseShortAddress(segments[0]);
  if (!address || !indexHas(index, address)) return null;
  const prefix = locale && locale !== defaultLocale ? `/${locale}` : '';
  return `${prefix}/bills/${shortAddressSlug(address)}`;
}

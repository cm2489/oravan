/*
 * THE ADDRESS THE SHARE PANEL HANDS OUT (DRAFT, 2026-11-14; waits for the
 * owner). His note of Sep 27, 2026: "can you do a link card with a name
 * instead of bill number." Card 191 (Nov 14, 2026, 1:06 PM ET) settled
 * where a name comes from: "Names beside numbers. Each name comes from the
 * bill's own official short title in the record, never chosen by Oravan."
 *
 * His choice on card 193 (Nov 14, 2026, 9:13 PM ET): "Then Share copies the
 * name, or the number when a bill has no short title."
 *
 * So the link a reader copies or shares from a bill page is the bill's
 * SHORT address, worked out at BUILD time from the same tables proxy.ts
 * answers from (lib/short-address.ts), and only when that address really
 * opens THIS bill today, so whoever receives the link lands on the bill the
 * sharer was looking at:
 *   1. its name, when one of its record short titles makes a name no other
 *      bill Oravan tracks makes (several: the shortest, then code-point order);
 *   2. otherwise its number (oravan.org/hr9770), when the number opens it
 *      (always, for a bill of the tracked Congress). This covers a bill with
 *      no short title, AND a bill whose name is SHARED: that name opens the
 *      page listing every bill that makes it, where the reader might pick the
 *      other bill. The shared case is the orchestrating session's reading of
 *      his words (2026-11-15), not his own; he can overrule it;
 *   3. otherwise the full address (/bills/<slug>), as before.
 * English at oravan.org/<address>, Spanish at oravan.org/es/<address>.
 *
 * WHAT IT NEVER DOES: carry a query, a stance or anything about the reader
 * (CLAUDE.md rule 1; tests/share.spec.ts). Server and build only: it reads
 * data/short-titles.json through lib/short-address-build.ts, and only the
 * finished address string reaches the page.
 */
import {
  decodeNameTables,
  decodeShortAddressFallback,
  decodeShortAddressIndex,
  encodeShortAddressFallback,
  encodeShortAddressIndex,
  nameAddressTarget,
  nameSlug,
  SHORT_ADDRESS_CONGRESS,
  shortAddressTarget,
  type NameTables,
  type ShortAddressBill,
  type ShortAddressFallback,
  type ShortAddressIndex,
  type ShortTitleFile,
} from './short-address';
import { nameTablesForBuild, readShortTitles } from './short-address-build';
import { SITE_ORIGIN } from './site';

export interface ShareTables {
  index: ShortAddressIndex;
  fallback: ShortAddressFallback;
  names: NameTables;
  titles: ShortTitleFile;
  congress: number;
}

const LOCALES = ['en', 'es'];

/** The path part of the short address for one bill: '/<name>', '/<type><number>', or null. Pure. */
export function shortSharePath(bill: ShortAddressBill, tables: ShareTables): string | null {
  const slug = `${bill.bill_type}-${bill.bill_number}-${bill.congress_number}`;
  const opens = (path: string) =>
    (shortAddressTarget(path, LOCALES, 'en', tables.index, tables.fallback, tables.congress) ??
      nameAddressTarget(path, LOCALES, 'en', tables.names)) === `/bills/${slug}`;
  const names = [...new Set((tables.titles[slug]?.titles ?? []).map((t) => nameSlug(t)).filter((n): n is string => !!n))]
    .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
    .filter((name) => opens(`/${name}`));
  if (names.length > 0) return `/${names[0]}`;
  const number = `/${bill.bill_type}${bill.bill_number}`;
  return opens(number) ? number : null;
}

/** The absolute URL a share hands out, in the page's language. Pure. */
export function shareAddress(bill: ShortAddressBill, locale: string, tables: ShareTables): string {
  const prefix = locale === 'en' ? '' : `/${locale}`;
  const short = shortSharePath(bill, tables);
  if (short) return `${SITE_ORIGIN}${prefix}${short}`;
  return `${SITE_ORIGIN}${prefix}/bills/${bill.bill_type}-${bill.bill_number}-${bill.congress_number}`;
}

let built: ShareTables | null = null;

/** The tables exactly as next.config.ts builds them for proxy.ts, built once per build process. */
export function shareTablesFor(corpus: readonly ShortAddressBill[]): ShareTables {
  if (built) return built;
  built = {
    index: decodeShortAddressIndex(encodeShortAddressIndex(corpus, SHORT_ADDRESS_CONGRESS)),
    fallback: decodeShortAddressFallback(encodeShortAddressFallback(corpus)),
    names: decodeNameTables(nameTablesForBuild(corpus)),
    titles: readShortTitles(),
    congress: SHORT_ADDRESS_CONGRESS,
  };
  return built;
}

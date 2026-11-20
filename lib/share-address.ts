/*
 * THE ADDRESS THE SHARE PANEL HANDS OUT (DRAFT, 2026-11-14; waits for the
 * owner). His note of Sep 27, 2026: "can you do a link card with a name
 * instead of bill number." Card 191 (Nov 14, 2026, 1:06 PM ET) settled
 * where a name comes from: "Names beside numbers. Each name comes from the
 * bill's own official short title in the record, never chosen by Oravan."
 *
 * His choice on card 193 (Nov 14, 2026, 9:13 PM ET): "Then Share copies the
 * name, or the number when a bill has no short title." His answer `share` = b
 * (Nov 15, 2026): on a bill whose name is SHARED, Share copies THE NAME too,
 * so the friend lands on the page listing the bills and picks.
 *
 * So the link a reader copies or shares from a bill page is the bill's
 * SHORT address, worked out at BUILD time from the same tables proxy.ts
 * answers from (lib/short-address.ts), and only when that address really
 * reaches THIS bill today:
 *   1. its name, when one of its record short titles makes a name no other
 *      bill Oravan tracks makes: the name opens this bill (several: the
 *      shortest, then code-point order);
 *   2. otherwise a SHARED name of its own, when that name opens the page
 *      listing this bill among the others of its Congress
 *      (/names/<its congress>/<name>; same order). A name the new Congress
 *      took after a switch opens another Congress's bill or page and is never
 *      handed out for this one;
 *   3. otherwise the short address that CARRIES ITS CONGRESS
 *      (oravan.org/hr1109-119; lib/short-address.ts), which opens this bill
 *      and never another, before or after the change of Congress. His card
 *      196 (Nov 19, 2026, 12:50 PM ET): "Build a short address that carries
 *      the Congress and never changes, and have Share copy that." It replaced
 *      the bare number (oravan.org/hr1109), which from Jan 3, 2027 opens the
 *      120th Congress's bill of that number;
 *   4. otherwise the full address (/bills/<slug>), which every bill page has.
 * While the fill gate keeps every name off (lib/short-address-build.ts
 * gateNameTables), steps 1 and 2 find nothing and every bill shares step 3:
 * Share never hands out a name that does not open yet. The page's canonical
 * address and og:url stay the permanent /bills/<slug>.
 * English at oravan.org/<address>, Spanish at oravan.org/es/<address>.
 *
 * WHAT IT NEVER DOES: carry a query, a stance or anything about the reader
 * (CLAUDE.md rule 1; tests/share.spec.ts). Server and build only: it reads
 * data/short-titles.json through lib/short-address-build.ts, and only the
 * finished address string reaches the page.
 */
import {
  congressAddressPath,
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

/** The path part of the short address for one bill: '/<name>', '/<type><number>-<congress>', or null. Pure. */
export function shortSharePath(bill: ShortAddressBill, tables: ShareTables): string | null {
  const slug = `${bill.bill_type}-${bill.bill_number}-${bill.congress_number}`;
  const target = (path: string) =>
    shortAddressTarget(path, LOCALES, 'en', tables.index, tables.fallback, tables.congress) ??
    nameAddressTarget(path, LOCALES, 'en', tables.names);
  const opens = (path: string) => target(path) === `/bills/${slug}`;
  const all = [...new Set((tables.titles[slug]?.titles ?? []).map((t) => nameSlug(t)).filter((n): n is string => !!n))].sort(
    (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  const own = all.find((name) => opens(`/${name}`));
  if (own) return `/${own}`;
  const shared = all.find((name) => target(`/${name}`) === `/names/${bill.congress_number}/${name}`);
  if (shared) return `/${shared}`;
  const carried = congressAddressPath(bill);
  return opens(carried) ? carried : null;
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

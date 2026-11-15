/*
 * THE PAGES FOR SHARED NAMES (2026-11-15, DRAFT; the owner's card 193, Nov 14,
 * 2026, 9:13 PM ET: "Build the small page for shared names, so a name never
 * breaks. Then Share copies the name, or the number when a bill has no short
 * title.").
 *
 * A name two or more bills Oravan tracks make (lib/short-address.ts: "A name
 * opens a bill when no other bill Oravan tracks has a short title that makes
 * the same name") used to be the normal not-found. proxy.ts now answers it
 * with a 307 to /names/<congress>/<name>, a page prerendered here at BUILD
 * time that lists those bills and picks none of them.
 *
 * WHICH PAGES EXIST: exactly the shared names the proxy can reach. The proxy
 * searches the Congresses in the number addresses' order (the tracked one,
 * then each ended one, most recently ended first) and the first Congress that
 * holds a name answers. So a page exists for (congress, name) when the name is
 * shared in that Congress and no Congress searched before it holds the name at
 * all. The Congress is in the address, so the same shared name in two
 * Congresses has two stable, unambiguous pages.
 *
 * THE ORDER OF THE BILLS, mechanical and stated on the page: House bills
 * first, then Senate bills; inside each chamber by type in the order Congress
 * numbers them (bills, joint resolutions, concurrent resolutions, simple
 * resolutions), then by number. Nothing ranks, recommends or calls one bill
 * the main one.
 *
 * Build and server only: it reads data/short-titles.json and the route tree
 * through lib/short-address-build.ts. No page's browser code imports it.
 */
import {
  decodeNameTables,
  nameSlug,
  namesOfCongress,
  parseShortAddress,
  SHORT_ADDRESS_CONGRESS,
  shortAddressFallbackCongresses,
  type ShortAddressBill,
  type ShortAddressType,
  type ShortTitleFile,
} from './short-address';
import { nameTablesForBuild, readShortTitles, reservedNames } from './short-address-build';

/** The order a page lists bills in: House types, then Senate types, as Congress numbers them. */
export const SHARED_NAME_TYPE_ORDER: readonly ShortAddressType[] = Object.freeze([
  'hr',
  'hjres',
  'hconres',
  'hres',
  's',
  'sjres',
  'sconres',
  'sres',
]);

export interface SharedNameBill {
  slug: string;
  type: ShortAddressType;
  number: number;
  chamber: 'house' | 'senate';
  /** The bill's own short titles, as the record writes them, that make this name. */
  titles: string[];
}

export interface SharedNamePage {
  congress: number;
  name: string;
  bills: SharedNameBill[];
}

/** Sort bills the stated way. Pure. */
export function inSharedNameOrder<T extends { type: ShortAddressType; number: number }>(bills: readonly T[]): T[] {
  return [...bills].sort(
    (a, b) => SHARED_NAME_TYPE_ORDER.indexOf(a.type) - SHARED_NAME_TYPE_ORDER.indexOf(b.type) || a.number - b.number,
  );
}

/**
 * Every page the proxy can reach, from a corpus, a titles file, the reserved
 * words and the search order. Pure (the build passes what it read).
 */
export function sharedNamePagesFrom(
  bills: readonly ShortAddressBill[],
  titles: ShortTitleFile,
  order: readonly number[],
  reserved: ReadonlySet<string>,
  encodedTables: string,
): SharedNamePage[] {
  const tables = decodeNameTables(encodedTables);
  const seen = new Set<string>();
  const out: SharedNamePage[] = [];
  for (const congress of order.filter((c, i, all) => all.indexOf(c) === i)) {
    const table = tables.find((t) => t.congress === congress);
    if (!table) continue;
    const holders = namesOfCongress(bills, titles, congress, reserved);
    for (const [name, address] of table.names) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (address !== null) continue; // a unique name opens its bill, not a page
      const list = [...(holders.get(name) ?? [])].map((key) => {
        const a = parseShortAddress(key)!;
        const slug = `${a.type}-${a.number}-${congress}`;
        return {
          slug,
          type: a.type,
          number: a.number,
          chamber: a.type.startsWith('h') ? ('house' as const) : ('senate' as const),
          titles: [...new Set((titles[slug]?.titles ?? []).filter((t) => nameSlug(t) === name))].sort(),
        };
      });
      if (list.length > 1) out.push({ congress, name, bills: inSharedNameOrder(list) });
    }
  }
  return out.sort((a, b) => b.congress - a.congress || (a.name < b.name ? -1 : 1));
}

let memo: { key: unknown; pages: SharedNamePage[] } | null = null;

/** Every reachable shared-name page for this build's data. [] while data/short-titles.json does not exist. */
export function sharedNamePages(bills: readonly ShortAddressBill[], root: string = process.cwd()): SharedNamePage[] {
  if (memo && memo.key === bills) return memo.pages;
  const titles = readShortTitles(root);
  const pages =
    Object.keys(titles).length === 0
      ? []
      : sharedNamePagesFrom(
          bills,
          titles,
          [SHORT_ADDRESS_CONGRESS, ...shortAddressFallbackCongresses(bills)],
          reservedNames(root),
          nameTablesForBuild(bills, root),
        );
  memo = { key: bills, pages };
  return pages;
}

/** The address of a shared name's page, locale-relative (no /es). */
export function sharedNamePath(congress: number, name: string): string {
  return `/names/${congress}/${name}`;
}

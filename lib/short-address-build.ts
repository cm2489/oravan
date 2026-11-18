/*
 * BUILD TIME ONLY: the name tables for name addresses, exactly as
 * next.config.ts inlines them into proxy.ts's bundle (SHORT_ADDRESS_NAMES).
 * Read here once so the build and the specs that check the build compute the
 * same string. It reads files (data/short-titles.json, the app/ and public/
 * trees), so it is never imported by proxy.ts or by anything a page renders;
 * tests/static-rendering.spec.ts pins proxy.ts's imports.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { topRouteSegments } from './route-segments.mjs';
import {
  decodeNameTables,
  encodeNameTables,
  NAME_ADDRESS_RESERVED,
  nameAddressAllowed,
  nameSlug,
  SHORT_ADDRESS_CONGRESS,
  shortAddressFallbackCongresses,
  type NameRefusal,
  type ShortAddressBill,
  type ShortTitleFile,
} from './short-address';
import { SHORT_TITLES_PATH, SHORT_TITLES_RETRY_PATH } from './short-titles.mjs';

/** Every word a name may never take: the reserved list and every real route's first segment, read now. */
export function reservedNames(root: string = process.cwd()): Set<string> {
  return new Set([...NAME_ADDRESS_RESERVED, ...topRouteSegments(root)]);
}

/** data/short-titles.json, or {} before the nightly first writes it. */
export function readShortTitles(root: string = process.cwd()): ShortTitleFile {
  const file = join(root, SHORT_TITLES_PATH);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ShortTitleFile) : {};
}

/** data/short-titles-retry.json (the bills whose last read failed), or {} when it does not exist. */
export function readShortTitleRetries(root: string = process.cwd()): Record<string, unknown> {
  const file = join(root, SHORT_TITLES_RETRY_PATH);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
}

/** A corpus bill as this gate reads it: its address, and the title data/bills.json stores for it. */
export type GateBill = ShortAddressBill & { title?: string | null; short_title?: string | null };

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/**
 * THE FILL GATE (hotfix, 2026-11-17). Uniqueness is only knowable once every
 * bill that could share a name has been read. On the first nightly (Nov 17,
 * 2026) 300 of 3,335 bills were read, and oravan.org/laken-riley-act opened
 * H.R. 29 because its twin S. 5 had not been read yet: Oravan picked between
 * two bills, which the owner ruled it never does.
 *
 * THE RULE, applied to the table encodeNameTables built, from the committed
 * files only (no clock, no network). Pure.
 *   - A Congress is READ IN FULL when every bill of it in data/bills.json has
 *     an entry in data/short-titles.json (read) or one in
 *     data/short-titles-retry.json (tried, and its last read failed).
 *   - The Congresses are walked in the search order (the tracked one, then each
 *     ended one, most recently ended first). At the first Congress not read in
 *     full, the walk STOPS: that Congress and every one after it hold no table,
 *     so no name opens a bill there and the search never reaches past it to an
 *     older bill. Before the first fill completes, that is every name.
 *   - In a Congress read in full, a bill never read successfully (tried, no
 *     entry) blocks every name its stored title in data/bills.json makes
 *     (`title`, and `short_title` when present, through the same nameSlug): that
 *     name stays in the table opening nothing, so the search stops there too.
 * THE RESIDUAL: an unread bill whose record short title makes a name its stored
 * title does not can still share that name unseen until it is read.
 */
export function gateNameTables(
  encoded: string,
  bills: readonly GateBill[],
  titles: ShortTitleFile,
  retry: Readonly<Record<string, unknown>>,
  order: readonly number[],
  reserved: ReadonlySet<string>,
): { encoded: string; line: string; blocked: string[] } {
  const built = new Map(decodeNameTables(encoded).map((t) => [t.congress, t.names]));
  const slugOf = (b: GateBill) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`;
  const parts: string[] = [];
  const said: string[] = [];
  const blocked: string[] = [];
  for (const congress of order.filter((c, i, all) => all.indexOf(c) === i)) {
    const tracked = bills.filter((b) => b.congress_number === congress);
    const read = tracked.filter((b) => Object.prototype.hasOwnProperty.call(titles, slugOf(b)));
    const neverTried = tracked.filter((b) => !Object.prototype.hasOwnProperty.call(titles, slugOf(b)) && !Object.prototype.hasOwnProperty.call(retry, slugOf(b)));
    if (neverTried.length > 0) {
      said.push(
        `OFF from the ${ordinal(congress)} Congress on: ${read.length} of its ${tracked.length} bills read, ${neverTried.length} never read or tried, so no name opens a bill there or in any Congress searched after it until every one has been read or tried`,
      );
      break;
    }
    const names = new Map(built.get(congress) ?? []);
    let blockedHere = 0;
    for (const b of tracked) {
      if (Object.prototype.hasOwnProperty.call(titles, slugOf(b))) continue; // read: its record short titles are in the table already
      for (const stored of [b.title, b.short_title]) {
        if (typeof stored !== 'string') continue;
        const name = nameSlug(stored);
        if (!name || !nameAddressAllowed(name, reserved)) continue;
        if (names.get(name) !== null) {
          blocked.push(`${name} (${slugOf(b)} not read yet)`);
          blockedHere++;
        }
        names.set(name, null);
      }
    }
    said.push(`ON for the ${ordinal(congress)} Congress: ${tracked.length} bills, ${read.length} read, ${tracked.length - read.length} tried and waiting; ${blockedHere} name(s) held back by a bill not read yet`);
    if (names.size === 0) continue;
    const entries = [...names.keys()].sort().map((name) => {
      const a = names.get(name);
      return `${name}=${a ? `${a.type}${a.number}` : ''}`;
    });
    parts.push(`${congress}@${entries.join(',')}`);
  }
  return { encoded: parts.join('|'), line: said.join('; '), blocked };
}

/**
 * The SHORT_ADDRESS_NAMES string: per Congress in the number addresses' search
 * order (the tracked one, then each ended one the corpus holds, most recently
 * ended first), every allowed name with its bill, through the fill gate above.
 * '' while no bill has a short title, and while the tracked Congress is not
 * read in full. The build log gets one line saying whether names are on, and why.
 */
export function nameTablesForBuild(
  bills: readonly GateBill[],
  root: string = process.cwd(),
  onRefused?: (refusal: NameRefusal) => void,
): string {
  const titles = readShortTitles(root);
  const order = [SHORT_ADDRESS_CONGRESS, ...shortAddressFallbackCongresses(bills)];
  const reserved = reservedNames(root);
  const encoded = encodeNameTables(bills, titles, order, reserved, onRefused);
  const gate = gateNameTables(encoded, bills, titles, readShortTitleRetries(root), order, reserved);
  onRefused?.({ slug: '', title: '', name: null, reason: gate.line });
  return gate.encoded;
}

/**
 * One build-log line for each record short title that gives no address (no
 * name at all, or a name refused: too short or long, number-like, skipped by
 * the proxy's matcher, a route or reserved word) and for each name two or
 * more bills share (it is in the table, so the search stops there, but it
 * opens none of them).
 */
export function refusalLine(r: NameRefusal): string {
  // The fill gate's one line: names on or off, and why.
  if (!r.slug) return `short-address names: ${r.reason}`;
  if (!r.title) return `short-address names: "${r.name}" opens nothing: ${r.reason} (${r.slug})`;
  return `short-address names: ${r.slug} "${r.title}" -> ${r.name ? `"${r.name}"` : 'no name'} left out: ${r.reason}`;
}

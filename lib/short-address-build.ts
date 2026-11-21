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
  NAME_HELD_BACK,
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
import { fixtureRetries, NAMES_FIXTURE_ON, NAMES_FIXTURE_TITLES_PATH } from './names-fixture.mjs';

/** Every word a name may never take: the reserved list and every real route's first segment, read now. */
export function reservedNames(root: string = process.cwd()): Set<string> {
  return new Set([...NAME_ADDRESS_RESERVED, ...topRouteSegments(root)]);
}

/** data/short-titles.json, or {} before the nightly first writes it. */
export function readShortTitles(root: string = process.cwd(), fixture: boolean = NAMES_FIXTURE_ON): ShortTitleFile {
  // The CI names fixture (lib/names-fixture.mjs, test data only) when its switch is on; data/ otherwise.
  const file = join(root, fixture ? NAMES_FIXTURE_TITLES_PATH : SHORT_TITLES_PATH);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ShortTitleFile) : {};
}

/** data/short-titles-retry.json (the bills whose last read failed), or {} when it does not exist. */
export function readShortTitleRetries(root: string = process.cwd()): Record<string, unknown> {
  const file = join(root, SHORT_TITLES_RETRY_PATH);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
}

/**
 * A names file read for the BUILD, which must never fail because of it (2026-11-18): a missing file
 * is {}, and a file that is empty, not JSON, or not a plain object is {} with the problem named, so
 * the build turns names off and says why instead of throwing and taking the whole deploy with it.
 * verify-sync and CI refuse such files, so this is the last line of defence, not the usual path.
 */
export function readNamesFile(root: string, path: string): { data: Record<string, unknown>; problem: string | null } {
  const file = join(root, path);
  if (!existsSync(file)) return { data: {}, problem: null };
  try {
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { data: {}, problem: `${path} is not an object` };
    return { data: data as Record<string, unknown>, problem: null };
  } catch (e) {
    return { data: {}, problem: `${path} could not be read (${e instanceof Error ? e.message : String(e)})` };
  }
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
 *   - EACH CONGRESS IS JUDGED ON ITS OWN (the second independent check of
 *     #510, Nov 20, 2026; until then the walk stopped at the first Congress
 *     not read in full and turned names off for every older Congress too, so
 *     one unread 120th bill would have removed every 119th name and list page).
 *     A Congress not read in full opens no name of its own: before the first
 *     fill completes, that is every name of the tracked Congress (#517's
 *     safety, unchanged). It holds back, opening nothing, every name it is
 *     known to make (its read bills' record short titles, its unread bills'
 *     stored titles) that an older Congress also holds, so the search never
 *     reaches past it to an older bill for a name it may carry. Every other
 *     name of an older Congress read in full stays on, and its list pages are
 *     built.
 *   - In a Congress read in full, a bill never read successfully (tried, no
 *     entry) blocks every name its stored title in data/bills.json makes
 *     (`title`, and `short_title` when present, through the same nameSlug): that
 *     name stays in the table opening nothing, so the search stops there too.
 *     That includes a name two read bills share: it has no list page until the
 *     unread bill is read, so a list never leaves out a bill that makes the name.
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
): { encoded: string; line: string; blocked: string[]; off: number[] } {
  const built = new Map(decodeNameTables(encoded).map((t) => [t.congress, t.names]));
  const searched = order.filter((c, i, all) => all.indexOf(c) === i);
  const off: number[] = [];
  const slugOf = (b: GateBill) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`;
  // READ means an entry whose `titles` is a list. A malformed entry (`{"titles": 5}`) is NOT read: its
  // record short titles are unknown, so it must not count as a bill read with none (2026-11-18).
  const isRead = (b: GateBill) => {
    const e = (titles as Record<string, unknown>)[slugOf(b)];
    return !!e && typeof e === 'object' && Array.isArray((e as { titles?: unknown }).titles);
  };
  const parts: string[] = [];
  const said: string[] = [];
  const blocked: string[] = [];
  for (const [at, congress] of searched.entries()) {
    const tracked = bills.filter((b) => b.congress_number === congress);
    const read = tracked.filter(isRead);
    const neverTried = tracked.filter((b) => !isRead(b) && !Object.prototype.hasOwnProperty.call(retry, slugOf(b)));
    if (neverTried.length > 0) {
      // This Congress opens no name until every bill is read or tried. A name it is known to make that an
      // older Congress holds is held back here, so the search stops at it instead of reaching the older bill.
      const known = new Set(built.get(congress)?.keys() ?? []);
      for (const b of tracked) {
        if (isRead(b)) continue;
        for (const stored of [b.title, b.short_title]) {
          const name = typeof stored === 'string' ? nameSlug(stored) : null;
          if (name && nameAddressAllowed(name, reserved)) known.add(name);
        }
      }
      const shadowed = [...known].filter((name) => searched.slice(at + 1).some((c) => built.get(c)?.has(name))).sort();
      said.push(
        `OFF for the ${ordinal(congress)} Congress: ${read.length} of its ${tracked.length} bills read, ${neverTried.length} never read or tried, so no name opens a bill of it until every one has been read or tried; ${shadowed.length} name(s) an older Congress also holds held back`,
      );
      off.push(congress);
      if (shadowed.length > 0) parts.push(`${congress}@${shadowed.map((name) => `${name}=-`).join(',')}`);
      continue;
    }
    const names = new Map(built.get(congress) ?? []);
    let blockedHere = 0;
    for (const b of tracked) {
      if (isRead(b)) continue; // read: its record short titles are in the table already
      for (const stored of [b.title, b.short_title]) {
        if (typeof stored !== 'string') continue;
        const name = nameSlug(stored);
        if (!name || !nameAddressAllowed(name, reserved)) continue;
        // Only a name some other bill holds needs holding back: here (it would open that bill) or in a
        // Congress searched after this one (the search would go on to an older bill). A stored title that
        // is a long description nobody else makes adds nothing and is not counted (2026-11-18).
        const here = names.has(name);
        const later = searched.slice(at + 1).some((c) => built.get(c)?.has(name));
        if (!here && !later) continue;
        // Shared here too: held back as well, so no list page is built that leaves this bill out (the
        // independent check of #510, Nov 19, 2026: the page says it lists every tracked bill that makes the
        // name, which is true only once every bill that could make it has been read).
        if (names.get(name) !== NAME_HELD_BACK) {
          blocked.push(`${name} (${slugOf(b)} not read yet)`);
          blockedHere++;
        }
        names.set(name, NAME_HELD_BACK);
      }
    }
    said.push(`ON for the ${ordinal(congress)} Congress: ${tracked.length} bills, ${read.length} read, ${tracked.length - read.length} tried and waiting; ${blockedHere} name(s) held back by a bill not read yet`);
    if (names.size === 0) continue;
    const entries = [...names.keys()].sort().map((name) => {
      const a = names.get(name);
      return `${name}=${a === NAME_HELD_BACK ? '-' : a ? `${a.type}${a.number}` : ''}`;
    });
    parts.push(`${congress}@${entries.join(',')}`);
  }
  return { encoded: parts.join('|'), line: said.join('; '), blocked, off };
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
  fixture: boolean = NAMES_FIXTURE_ON,
): string {
  // The CI names fixture (lib/names-fixture.mjs, test data only): its titles, and every other bill counted as
  // tried. Off, which is every real build, exactly the data files as before.
  const titlesFile = readNamesFile(root, fixture ? NAMES_FIXTURE_TITLES_PATH : SHORT_TITLES_PATH);
  const retryFile = fixture ? { data: fixtureRetries(bills, titlesFile.data), problem: null } : readNamesFile(root, SHORT_TITLES_RETRY_PATH);
  const problems = [titlesFile.problem, retryFile.problem].filter((p): p is string => p !== null);
  if (problems.length > 0) {
    onRefused?.({
      slug: '',
      title: '',
      name: null,
      reason: `OFF: ${problems.join('; ')}, so no name opens a bill until it is fixed (number addresses are unaffected; verify-sync and CI refuse such a file)`,
    });
    return '';
  }
  const titles = titlesFile.data as ShortTitleFile;
  const order = [SHORT_ADDRESS_CONGRESS, ...shortAddressFallbackCongresses(bills)];
  const reserved = reservedNames(root);
  // The encoder's lines wait for the gate, so a "shared by" line can say when it is not in effect.
  const pending: NameRefusal[] = [];
  const encoded = encodeNameTables(bills, titles, order, reserved, (r) => pending.push(r));
  const gate = gateNameTables(encoded, bills, titles, retryFile.data, order, reserved);
  for (const r of pending) {
    const congress = Number(/-(\d+)(?: |$)/.exec(r.slug)?.[1]);
    const sharedLine = !r.title && r.slug !== '';
    onRefused?.(sharedLine && gate.off.includes(congress) ? { ...r, reason: `${r.reason} (not in effect: names are off for the ${ordinal(congress)} Congress)` } : r);
  }
  onRefused?.({ slug: '', title: '', name: null, reason: gate.line });
  return gate.encoded;
}

/**
 * One build-log line for each record short title that gives no address (no
 * name at all, or a name refused: too short or long, number-like, skipped by
 * the proxy's matcher, a route or reserved word) and for each name two or
 * more bills share (it is in the table, so the search stops there, but it
 * opens no single bill: since card 193 it opens the page that lists them).
 */
export function refusalLine(r: NameRefusal): string {
  // The fill gate's one line: names on or off, and why.
  if (!r.slug) return `short-address names: ${r.reason}`;
  if (!r.title) return `short-address names: "${r.name}" opens no single bill: ${r.reason} (${r.slug})`;
  return `short-address names: ${r.slug} "${r.title}" -> ${r.name ? `"${r.name}"` : 'no name'} left out: ${r.reason}`;
}

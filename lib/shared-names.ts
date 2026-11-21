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
 * WHICH PAGES EXIST: one for every name shared in a Congress whose table the
 * build holds (the tracked one, and each ended one). The proxy searches the
 * Congresses in the number addresses' order (the tracked one, then each ended
 * one, most recently ended first) and the first Congress that holds a name
 * answers, so a bare name reaches the newest page. The page of an older
 * Congress is still built when a newer Congress takes the name (the
 * independent check of #510, Nov 19, 2026): its address carries its Congress,
 * someone may have copied it from the address bar, and it must keep opening
 * the same list. The Congress is in the address, so the same shared name in
 * two Congresses has two stable, unambiguous pages.
 *
 * A NAME AN UNREAD BILL COULD ALSO CARRY HAS NO PAGE (same check): the page
 * says the address lists every tracked bill that makes the name, which is
 * true only once every bill that could make it has been read. The fill gate
 * (lib/short-address-build.ts gateNameTables) holds such a name back until
 * then, so it opens nothing and no page is built for it.
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
import type { ChamberSession } from './docket';
import { billFloorBand, deriveJourney, endedDecision, statusKeyFor, type JourneyNowKey, type Chamber, type EndedDecision, type FloorBandKind } from './journey';
import type { StatusLabelKey } from './types';
import { floorSuspendedFrom, siteBillStatusLine } from './floor-session';
import type { StatusLine } from './moment-status.mjs';

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

/*
 * ONE TITLE, NOT TWO (the second independent check of #510, Nov 20, 2026). The
 * record sometimes writes the same short title twice, once with a straight
 * apostrophe and once with a curly one (H.R. 9237: "Take Care of America's
 * Veterans Act" and "Take Care of America’s Veterans Act"), and the page
 * printed both, joined by a slash. Spellings that differ only in apostrophe or
 * quote style, dash style or spacing are one title: the page shows one of the
 * record's own forms (the first in code-point order, so the choice never
 * changes with the order the record lists them in).
 */
export function titleSpellingKey(title: string): string {
  return title
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The distinct spellings of a set of record titles, each one of the record's own forms, in code-point order. Pure. */
export function distinctSpellings(titles: readonly string[]): string[] {
  const kept = new Map<string, string>();
  for (const t of [...new Set(titles)].sort()) {
    const key = titleSpellingKey(t);
    if (!kept.has(key)) kept.set(key, t);
  }
  return [...kept.values()].sort();
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
  const out: SharedNamePage[] = [];
  for (const congress of order.filter((c, i, all) => all.indexOf(c) === i)) {
    const table = tables.find((t) => t.congress === congress);
    if (!table) continue;
    const holders = namesOfCongress(bills, titles, congress, reserved);
    for (const [name, address] of table.names) {
      // A unique name opens its bill, not a page; a held-back name (NAME_HELD_BACK) opens nothing.
      if (address !== null) continue;
      const list = [...(holders.get(name) ?? [])].map((key) => {
        const a = parseShortAddress(key)!;
        const slug = `${a.type}-${a.number}-${congress}`;
        return {
          slug,
          type: a.type,
          number: a.number,
          chamber: a.type.startsWith('h') ? ('house' as const) : ('senate' as const),
          titles: distinctSpellings((titles[slug]?.titles ?? []).filter((t) => nameSlug(t) === name)),
        };
      });
      if (list.length > 1) out.push({ congress, name, bills: inSharedNameOrder(list) });
    }
  }
  return out.sort((a, b) => b.congress - a.congress || (a.name < b.name ? -1 : 1));
}

let memo: { key: unknown; root: string; pages: SharedNamePage[] } | null = null;

/** Every reachable shared-name page for this build's data. [] while data/short-titles.json does not exist. */
export function sharedNamePages(bills: readonly ShortAddressBill[], root: string = process.cwd()): SharedNamePage[] {
  if (memo && memo.key === bills && memo.root === root) return memo.pages;
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
  memo = { key: bills, root, pages };
  return pages;
}

/** The address of a shared name's page, locale-relative (no /es). */
export function sharedNamePath(congress: number, name: string): string {
  return `/names/${congress}/${name}`;
}

/*
 * WHERE EACH LISTED BILL STANDS NOW (2026-11-17; the owner's note of Nov 15,
 * 2026 on this page: "Make sure there is a tag on the bill if it is up for a
 * vote or is about to be. Example, someone clicks the S.5 link but its a
 * couple of days old when they click it and the senate has already voted on
 * it and now it is at the house for a vote.").
 *
 * Two readings the site already makes, and nothing new (hard rule 6):
 *   - THE LINE: lib/moment-status.mjs billStatusLine (through lib/floor-session.ts
 *     siteBillStatusLine, like every site surface since #525), the record-only "where it
 *     stands" line a Big Question's vehicle cards print for the same purpose
 *     (twin bills side by side): "Passed the House; waiting on the Senate.",
 *     "Signed into law as Public Law 119-1.", "In committee.", else the
 *     record's own latest action quoted. It carries the record's date.
 *   - THE TAG: lib/journey.ts billFloorBand, the bill page's own floor gate:
 *     the chamber's own published floor schedule naming the bill (its
 *     publication date), or a fresh calendar placement or pending floor vote
 *     in the record (the record's date). It is dropped when that chamber is
 *     not meeting (`suspended`), exactly as the bill page drops its panel, so
 *     no floor claim is live while nothing can happen. It never prints a vote
 *     date: no record here holds one.
 * Both are read at BUILD time, like every page; the clock and the session
 * reader are parameters so a test pins them.
 *
 * THE LINE MEETS THE SAME MEETING RULE AS THE TAG, ON THIS PAGE (2026-11-17,
 * the independent check of #510). Two of the line's readings sound live and
 * depend only on how recent the action is: `onFloor` ("Moving on the Senate
 * floor, with a vote ahead.") and `clotureFiled` ("… that vote comes within
 * days."). While the chamber they name is not meeting (the same
 * `out_of_session` the tag's gate reads), this page prints the record's own
 * latest action in its own words with its date instead (`recordStep`), which
 * is exactly true. Since main's #525 (2026-11-18) the site's one session gate
 * does this for every surface (lib/floor-session.ts); this page hands it the
 * same session reader its tag uses, so the line and the tag never disagree.
 */

/** The chip strings, exactly the bill page's and the homepage crown's (FLOOR_COPY / FLOOR_LABEL_KEYS). */
export const SHARED_NAME_FLOOR_CHIP = {
  announced: { house: 'bill.floor.announcedHouse', senate: 'bill.floor.announcedSenate' },
  calendar: { house: 'bill.floor.calendarHouse', senate: 'bill.floor.calendarSenate' },
  pending: { house: 'bill.floor.pendingHouse', senate: 'bill.floor.pendingSenate' },
} as const;

export interface SharedNameStanding {
  line: StatusLine;
  /** The live floor tag, or null: no floor fact, or its chamber is not meeting. */
  floor: { kind: FloorBandKind; chamber: Chamber; date: string; key: string } | null;
  /** The status label every card and the bill page read (lib/journey.ts statusKeyFor): "Ended", or the outcome, once its Congress has ended. */
  statusKey: StatusLabelKey;
  /** The bill page's own ended reading (lib/journey.ts endedDecision, which lib/bill-rail.ts reads), or null while its Congress sits. */
  ended: EndedDecision | null;
}

/*
 * A BILL OF AN ENDED CONGRESS (the independent check of #510, Nov 19, 2026;
 * page 1, rule 6). The line's readings describe a stage a bill can still move
 * from ("waiting on the Senate", "can be called up any day…"); once the
 * bill's Congress has ended nothing can move it, and the bill page and every
 * card say "Ended" or its outcome instead. So for such a bill the row prints
 * exactly that: the card's own status label (statusKeyFor, shown on this page
 * only for these bills) and, as the line, the record's own latest step in its
 * own words with its date. Never a present-tense reading, never a tag.
 */

/*
 * NEVER MORE, OR OTHER, THAN THE BILL'S OWN PAGE (the independent check of
 * #510, Nov 19, 2026). The line is lib/moment-status.mjs's reading, which the
 * Big Question cards print; the bill page's own "Right now:" sentence is
 * lib/journey.ts deriveJourney's `nowKey`. They are two readers of one record,
 * and on Nov 19, 2026 they agreed on every bill of the corpus but one: H.R.
 * 8035, where the line read "A House floor vote on it failed." over "Rule H.
 * Res. 1175 failed passage of House." (the RULE failed) while the bill page
 * said a committee is reviewing it. So the row prints a reading only when the
 * bill page's sentence is one this table lists for it; otherwise the record's
 * own latest step, in its own words, with its date, which is always true.
 */
export const LINE_AGREES_WITH: Readonly<Record<string, readonly JourneyNowKey[]>> = Object.freeze({
  signed: ['nowSigned'],
  vetoed: ['nowVetoed'],
  presented: ['nowPassedBoth'],
  bothAgreed: ['nowPassedBoth', 'nowAdoptedBoth'],
  passedBack: ['nowPassedBack', 'nowPassedBackStale'],
  passedOnCalendar: ['nowPassed', 'nowPassedStale'],
  heldAtDesk: ['nowPassed', 'nowPassedStale'],
  passedWaiting: ['nowPassed', 'nowPassedStale'],
  onCalendar: ['nowFloor', 'nowFloorStale'],
  onFloor: ['nowFloorActivity', 'nowFloorClotureInvoked'],
  clotureFiled: ['nowFloorActivity', 'nowFloorClotureInvoked'],
  failed: ['nowFloorPassageRejected', 'nowFloorMotionFailed', 'nowFloorSuspensionFailed'],
  failedReconsider: ['nowFloorMotionFailed'],
  inCommittee: ['nowCommittee'],
});

/** One listed bill's standing. Pure: the record, the bill's live announcement (or null), the clock, the sessions. */
export function sharedNameStanding(
  bill: Parameters<typeof billFloorBand>[0] &
    Parameters<typeof endedDecision>[0] &
    Parameters<typeof deriveJourney>[0] &
    Parameters<typeof statusKeyFor>[0] & { bill_type: string; last_action_text?: string | null },
  announcement: { chamber: Chamber; published: string } | null,
  { now = Date.now(), sessionOf }: { now?: number; sessionOf?: (chamber: Chamber) => ChamberSession } = {},
): SharedNameStanding {
  const band = billFloorBand(bill, announcement, now, sessionOf);
  // The record's own words and date, never a live-sounding line while that chamber is out. With no session
  // reader nothing is suspended, exactly as billFloorBand reads it, so the function stays pure.
  const read: StatusLine = siteBillStatusLine(bill, now, sessionOf ? floorSuspendedFrom(sessionOf) : () => false);
  const ended = endedDecision(bill);
  // Ended, or a reading the bill page's own sentence does not bear out: the record's own words and date only.
  const agrees = read.key === 'recordStep' || (LINE_AGREES_WITH[read.key] ?? []).includes(deriveJourney(bill, now).nowKey);
  const line: StatusLine = ended || !agrees ? { ...read, key: 'recordStep', chamber: null, passedBy: null, law: null } : read;
  return {
    line,
    floor: !ended && band && !band.suspended ? { ...band, key: SHARED_NAME_FLOOR_CHIP[band.kind][band.chamber] } : null,
    statusKey: statusKeyFor(bill, now),
    ended,
  };
}

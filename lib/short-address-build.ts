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
  encodeNameTables,
  NAME_ADDRESS_RESERVED,
  SHORT_ADDRESS_CONGRESS,
  shortAddressFallbackCongresses,
  type NameRefusal,
  type ShortAddressBill,
  type ShortTitleFile,
} from './short-address';
import { SHORT_TITLES_PATH } from './short-titles.mjs';

/** Every word a name may never take: the reserved list and every real route's first segment, read now. */
export function reservedNames(root: string = process.cwd()): Set<string> {
  return new Set([...NAME_ADDRESS_RESERVED, ...topRouteSegments(root)]);
}

/** data/short-titles.json, or {} before the nightly first writes it. */
export function readShortTitles(root: string = process.cwd()): ShortTitleFile {
  const file = join(root, SHORT_TITLES_PATH);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ShortTitleFile) : {};
}

/**
 * The SHORT_ADDRESS_NAMES string: per Congress in the number addresses' search
 * order (the tracked one, then each ended one the corpus holds, most recently
 * ended first), every allowed name with its bill. '' while no bill has a
 * short title.
 */
export function nameTablesForBuild(
  bills: readonly ShortAddressBill[],
  root: string = process.cwd(),
  onRefused?: (refusal: NameRefusal) => void,
): string {
  return encodeNameTables(
    bills,
    readShortTitles(root),
    [SHORT_ADDRESS_CONGRESS, ...shortAddressFallbackCongresses(bills)],
    reservedNames(root),
    onRefused,
  );
}

/**
 * One build-log line for each record short title that gives no address (no
 * name at all, or a name refused: too short or long, number-like, skipped by
 * the proxy's matcher, a route or reserved word) and for each name two or
 * more bills share (it is in the table, so the search stops there, but it
 * opens no single bill: since card 193 it opens the page that lists them).
 */
export function refusalLine(r: NameRefusal): string {
  if (!r.title) return `short-address names: "${r.name}" opens no single bill: ${r.reason} (${r.slug})`;
  return `short-address names: ${r.slug} "${r.title}" -> ${r.name ? `"${r.name}"` : 'no name'} left out: ${r.reason}`;
}

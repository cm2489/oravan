import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import updatesJson from '../data/moment-updates.json';
import { rollCallPage } from '../lib/roll-call-page';

/*
 * The Big Question timeline's "Sources" row (components/MomentTimeline.tsx).
 *
 * A vote update's ref, as the nightly writer stores it in
 * data/moment-updates.json, is the roll call's DATA FILE: the XML the sync
 * read (tests/moment-updates-live-votes.unit.spec.ts pins that). The row now
 * links the chamber's readable page for the same roll call, worked out at
 * render time through lib/roll-call-page.ts, so the data file keeps the ref
 * as stored. Any other ref (a bill's actions page, the Senate floor feed, a
 * press story) is linked exactly as stored.
 *
 * These specs make no network request. tests/timeline-record-links.spec.ts
 * checks the built pages, in both languages.
 */

/** Any address on a chamber's site that is a roll call's data file, in any
 *  shape, known or not. Looser than the helper's own patterns on purpose: a
 *  new shape from the writer must fail here rather than be linked raw. */
const ROLL_CALL_DATA_FILE =
  /^https?:\/\/(?:www\.)?(?:clerk\.house\.gov\/evs\/|senate\.gov\/legislative\/LIS\/roll_call_votes\/).*\.xml(?:[?#].*)?$/i;

type StoredUpdate = { id: string; source?: { refs?: string[] } };

/** Every ref the timeline could print, with where it is stored. */
const storedRefs: { where: string; ref: string }[] = Object.entries(
  updatesJson as unknown as Record<string, { updates?: StoredUpdate[] }>
)
  .filter(([key]) => key !== '_meta')
  .flatMap(([moment, entry]) =>
    (entry.updates ?? []).flatMap((u) =>
      (u.source?.refs ?? []).map((ref) => ({ where: `${moment} ${u.id}`, ref }))
    )
  );

test('every roll-call data file a timeline cites gets its chamber\'s readable page', () => {
  const rollCalls = storedRefs.filter(({ ref }) => ROLL_CALL_DATA_FILE.test(ref));
  // Honest about coverage: retention keeps 60 days, so a later corpus may
  // hold none. The helper's own spec covers both shapes either way.
  test.info().annotations.push({
    type: 'corpus',
    description: `${rollCalls.length} roll-call data-file refs stored in data/moment-updates.json`,
  });
  const raw = rollCalls
    .filter(({ ref }) => {
      const page = rollCallPage(ref);
      return page === ref || /\.xml(?:[?#]|$)/i.test(page);
    })
    .map(({ where, ref }) => `${where}: ${ref}`);
  expect(raw).toEqual([]);
});

test('a ref that is not a roll call\'s data file is linked exactly as stored', () => {
  // The one non-roll-call .xml a timeline carries today: the Senate floor
  // feed on a "scheduled" update. It is not a vote and has no other page.
  const feed = 'https://www.congress.gov/rss/senate-floor-today.xml';
  expect(rollCallPage(feed)).toBe(feed);

  const changed = storedRefs
    .filter(({ ref }) => !ROLL_CALL_DATA_FILE.test(ref) && rollCallPage(ref) !== ref)
    .map(({ where, ref }) => `${where}: ${ref} -> ${rollCallPage(ref)}`);
  expect(changed).toEqual([]);
});

test('the Sources row links each ref through rollCallPage, never the ref itself', () => {
  const src = readFileSync(join(process.cwd(), 'components/MomentTimeline.tsx'), 'utf8');
  expect(src).toMatch(/import \{ rollCallPage \} from '@\/lib\/roll-call-page';/);
  expect(src).toMatch(/\[\.\.\.new Set\(update\.source\.refs\.map\(rollCallPage\)\)\]\.map\(\(href\) =>/);
  expect(src).toMatch(/href=\{href\}/);
  // Keyed by the page too: a React key is serialized into the built page, so
  // keying by the ref would still ship the data file's address.
  expect(src).toMatch(/key=\{href\}/);
  // The label is the host of the page actually linked.
  expect(src).toMatch(/\{linkHost\(href\)\}/);
  expect(src).not.toMatch(/(?:href|key)=\{ref\}/);
});

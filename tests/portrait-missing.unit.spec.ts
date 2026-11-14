import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import missingJson from '../data/portrait-missing.json';
import legislators from '../data/legislators.json';
import zipDistricts from '../data/zip-districts.json';
import { mirroredPortraitBioguides, portraitFlag, portraitKnownMissing } from '../lib/core';
import { membersFor } from '../lib/members';
import type { Legislator } from '../lib/types';

const ZIPS = zipDistricts as Record<string, { state: string; district: number }[]>;

/*
 * A MEMBER WHOSE PHOTO IS MISSING AT THE SOURCE SHOWS THE INITIALS ALONE.
 *
 * data/portrait-missing.json is the portrait mirror job's record of the
 * photos the source answers 404 for. A member card can draw in the browser
 * (components/RepsLookup.tsx), and a client module may not read data/
 * (scripts/check-client-bundle), so the SERVER sets `portraitMissing` on each
 * member it sends a card (lib/members.ts, the seat page) and the card reads
 * the flag. The cards import next-intl's navigation, which does not load
 * under Node, so the rule is held here as data and the card and its callers
 * are read as source (tests/portrait-missing.spec.ts draws the real pages).
 *
 * No member is named: the list is read from the data, so this keeps holding
 * as the mirror job adds and removes members.
 */

const MISSING = Object.keys(missingJson as Record<string, unknown>);
const ROSTER = legislators as Legislator[];
const SITTING = new Set(ROSTER.map((l) => l.bioguide));
const read = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8');

test('the record has sitting members on it, or this file proves nothing', () => {
  expect(MISSING.filter((b) => SITTING.has(b)).length).toBeGreaterThan(0);
});

test('every member on the record is flagged, and nobody else is', () => {
  for (const b of MISSING) {
    expect(portraitKnownMissing(b), b).toBe(true);
    expect(portraitFlag(b), b).toEqual({ portraitMissing: true });
  }
  const others = ROSTER.filter((l) => !MISSING.includes(l.bioguide));
  expect(others.length).toBeGreaterThan(400);
  for (const l of others) expect(portraitFlag(l.bioguide), l.bioguide).toEqual({});
});

test('anything that is not a bioguide id is never "missing"', () => {
  for (const junk of ['', 'm001245', '../etc/passwd', 'toString', '__proto__', 'M00124']) {
    expect(portraitKnownMissing(junk), junk).toBe(false);
    expect(portraitFlag(junk), junk).toEqual({});
  }
});

test('the lookup sends the flag with each member of a ZIP that touches a member on the record', () => {
  const missingSitting = ROSTER.filter((l) => MISSING.includes(l.bioguide));
  let checked = 0;
  for (const l of missingSitting) {
    const zip = Object.keys(ZIPS).find((z) =>
      ZIPS[z].some((d) => d.state === l.state && (l.type === 'sen' || d.district === l.district)),
    );
    if (!zip) continue;
    const reps = membersFor(zip)!.districts.flatMap((d) => d.reps);
    const mine = reps.find((r) => r.bioguide === l.bioguide);
    expect(mine?.portraitMissing, `${l.bioguide} in ${zip}`).toBe(true);
    for (const r of reps) expect(r.portraitMissing === true, r.bioguide).toBe(MISSING.includes(r.bioguide));
    checked++;
  }
  expect(checked, 'at least one member on the record has a ZIP').toBeGreaterThan(0);
});

test('the card reads the flag, and the member page and the seat page pass the record on', () => {
  const card = read('components/RepCard.tsx');
  expect(card).toMatch(/<RepPortrait rep=\{rep\} photo=\{!rep\.portraitMissing\} \/>/);
  const page = read('app/[locale]/reps/[bioguide]/page.tsx');
  expect(page).toMatch(/<RepPortrait rep=\{rep\} large photo=\{!portraitKnownMissing\(rep\.bioguide\)\} \/>/);
  expect(page).toMatch(/<RepCard key=\{s\.bioguide\} rep=\{\{ \.\.\.s, \.\.\.portraitFlag\(s\.bioguide\) \}\} \/>/);
  // No card or page forces a photo past the record.
  for (const file of ['components/RepCard.tsx', 'components/RepsLookup.tsx', 'app/[locale]/reps/[bioguide]/page.tsx']) {
    expect(read(file), file).not.toMatch(/photo=\{true\}/);
  }
});

test('the embed draws a photo only for a mirrored member, and no mirrored member is on the missing record', () => {
  const widget = read('components/embed/RepLookupWidget.tsx');
  expect(widget).toMatch(/portraitSet\.has\(rep\.bioguide\)/);
  const mirrored = new Set(mirroredPortraitBioguides());
  for (const b of MISSING) expect(mirrored.has(b), `${b} is mirrored and on the missing record`).toBe(false);
});

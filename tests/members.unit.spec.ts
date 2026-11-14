import { expect, test } from '@playwright/test';
import { districtsForZip } from '../lib/core';
import { membersFor } from '../lib/members';

/*
 * lib/members.ts: the members page's lookup as plain data (2026-11-12). The
 * rules are the ones the page applied to its address before the ZIP left it;
 * these pin that they did not change in the move, and that the answer
 * survives JSON (with JavaScript off, Next.js sends it to the browser as
 * JSON).
 */

test('no ZIP at all is the prompt, not a failed lookup', () => {
  expect(membersFor(undefined)).toBeNull();
  expect(membersFor('')).toBeNull();
  expect(membersFor('   ')).toBeNull();
});

test('a ZIP that is not five digits matches nothing (the not-found view), and is cut short', () => {
  const r = membersFor('abcdefghijklmnop');
  expect(r).not.toBeNull();
  expect(r!.districts).toEqual([]);
  expect(r!.zip).toBe('abcdefghij');
});

test('a single-district ZIP: one district, House member first, then the senators', () => {
  const r = membersFor(' 78501 ')!;
  expect(r.zip).toBe('78501');
  expect(r.districts).toHaveLength(1);
  const [d] = r.districts;
  expect(d.reps[0].type).toBe('rep');
  expect(d.reps.filter((x) => x.type === 'sen')).toHaveLength(2);
  expect(r.refined).toBe(false);
});

test('a split ZIP lists every candidate; a district from the address form narrows it to one', () => {
  const all = membersFor('10001')!;
  expect(all.districts.length).toBe(districtsForZip('10001').length);
  expect(all.districts.length).toBeGreaterThan(1);

  const one = membersFor('10001', 'NY-12')!;
  expect(one.refined).toBe(true);
  expect(one.refinedOutsideZip).toBe(false);
  expect(one.districts.map((d) => `${d.state}-${d.district}`)).toEqual(['NY-12']);
});

test('a district outside the ZIP is trusted and said; a district with no House seat is ignored', () => {
  const outside = membersFor('10001', 'NY-1')!;
  expect(outside.refined).toBe(true);
  expect(outside.refinedOutsideZip).toBe(true);

  const bogus = membersFor('10001', 'NY-99')!;
  expect(bogus.refined).toBe(false);
  expect(bogus.districts.length).toBe(districtsForZip('10001').length);

  // Without a valid ZIP a district is never read.
  expect(membersFor('nope', 'NY-12')!.districts).toEqual([]);
});

test('the answer is plain data: it survives a JSON round trip unchanged', () => {
  for (const r of [membersFor('78501'), membersFor('10001', 'NY-12'), membersFor('00000')]) {
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  }
});

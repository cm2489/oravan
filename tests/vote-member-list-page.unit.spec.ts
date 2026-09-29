import { expect, test } from '@playwright/test';
import votesJson from '../data/votes.json';
import { memberListPage } from '../lib/votes';
import type { RollCall, VotesFile } from '../lib/types';

/*
 * lib/votes.ts memberListPage: where an OLDER roll call's "How members voted"
 * link goes on the bill page (components/VoteRecord.tsx prints the member list
 * for the newest roll call only). It turns the record's data file, which is
 * what `source` holds, into the chamber's own web page for the same roll call:
 *
 *   https://clerk.house.gov/evs/2025/roll144.xml
 *     -> https://clerk.house.gov/Votes/2025144
 *   https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00244.xml
 *     -> https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00244.htm
 *
 * These specs pin the transform over every stored roll call, and that it never
 * invents an address: an unknown shape comes back as the record's own URL.
 * They make no network request; whether the chamber sites serve those pages
 * was checked by fetching a sample on 2026-09-29 (the PR says which).
 */

const VOTES = votesJson as unknown as VotesFile;
const fake = (source: string, over: Partial<RollCall> = {}): RollCall =>
  ({ ...VOTES.rollCalls[0], source, ...over }) as RollCall;

test('a House roll call maps to the Clerk\'s page for the same year and roll', () => {
  expect(memberListPage(fake('https://clerk.house.gov/evs/2025/roll144.xml'))).toBe(
    'https://clerk.house.gov/Votes/2025144'
  );
  // The Clerk pads the roll to three digits in the file name; the page
  // address keeps the same digits.
  expect(memberListPage(fake('https://clerk.house.gov/evs/2026/roll005.xml'))).toBe(
    'https://clerk.house.gov/Votes/2026005'
  );
});

test('a Senate roll call maps to the Senate\'s .htm page beside the same file', () => {
  expect(
    memberListPage(
      fake('https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00244.xml')
    )
  ).toBe('https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00244.htm');
});

test('any other shape comes back unchanged: the link still reaches the record', () => {
  for (const source of [
    'https://clerk.house.gov/evs/2025/roll144.htm',
    'http://clerk.house.gov/evs/2025/roll144.xml',
    'https://www.congress.gov/votes/house/119-1/144',
    'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00244.htm',
    'https://example.org/clerk.house.gov/evs/2025/roll144.xml',
  ]) {
    expect(memberListPage(fake(source)), source).toBe(source);
  }
});

test('every stored roll call maps to its own chamber\'s page, with the same year, session and roll', () => {
  expect(VOTES.rollCalls.length).toBeGreaterThan(0);
  const wrong: string[] = [];
  for (const r of VOTES.rollCalls) {
    const page = memberListPage(r);
    if (page === r.source) continue; // an unknown shape; pinned above
    if (r.chamber === 'house') {
      const m = /^https:\/\/clerk\.house\.gov\/Votes\/(\d{4})(\d+)$/.exec(page);
      const year = r.source.match(/\/evs\/(\d{4})\//)?.[1];
      if (!m || m[1] !== year || Number(m[2]) !== r.roll || !r.date.startsWith(year)) {
        wrong.push(`${r.id}: ${page}`);
      }
    } else {
      const m = /^https:\/\/www\.senate\.gov\/legislative\/LIS\/roll_call_votes\/vote(\d{3})(\d)\/vote_(\d{3})_(\d)_(\d{5})\.htm$/.exec(page);
      if (
        !m ||
        Number(m[1]) !== r.congress ||
        Number(m[2]) !== r.session ||
        Number(m[3]) !== r.congress ||
        Number(m[4]) !== r.session ||
        Number(m[5]) !== r.roll ||
        page.replace(/\.htm$/, '.xml') !== r.source
      ) {
        wrong.push(`${r.id}: ${page}`);
      }
    }
  }
  expect(wrong).toEqual([]);
});

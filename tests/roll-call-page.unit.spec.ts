import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import votesJson from '../data/votes.json';
import { rollCallPage } from '../lib/roll-call-page';
import type { VotesFile } from '../lib/types';

/*
 * lib/roll-call-page.ts: where a vote card's "Official record" link goes. It
 * turns the record's data file, which is what a roll call's `source` holds,
 * into the chamber's own readable page for the same roll call:
 *
 *   https://clerk.house.gov/evs/2025/roll006.xml
 *     -> https://clerk.house.gov/Votes/20256
 *   https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00250.xml
 *     -> https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00250.htm
 *
 * These specs make no network request. They pin the transform for both
 * chambers, that it never invents an address for an unknown shape, that every
 * stored roll call gets a readable page for its own chamber, year, session and
 * roll, and that the cards link through it rather than to `source`. Whether
 * the sites serve those pages was checked by fetching all 594 on 2026-09-29
 * (lib/roll-call-page.ts's header and the PR say how).
 */

const VOTES = votesJson as unknown as VotesFile;

test.describe('House: the Clerk\'s page for the same year and roll', () => {
  test('the Clerk\'s own address, with the file\'s zero padding dropped', () => {
    expect(rollCallPage('https://clerk.house.gov/evs/2025/roll144.xml')).toBe('https://clerk.house.gov/Votes/2025144');
    // The Clerk's vote list links roll 6 of 2025 as /Votes/20256 and roll 10
    // as /Votes/202510, read live on 2026-09-29.
    expect(rollCallPage('https://clerk.house.gov/evs/2025/roll006.xml')).toBe('https://clerk.house.gov/Votes/20256');
    expect(rollCallPage('https://clerk.house.gov/evs/2025/roll010.xml')).toBe('https://clerk.house.gov/Votes/202510');
    expect(rollCallPage('https://clerk.house.gov/evs/2026/roll307.xml')).toBe('https://clerk.house.gov/Votes/2026307');
  });
});

test.describe('Senate: the .htm page beside the same file', () => {
  test('the page senate.gov\'s vote menu links', () => {
    expect(
      rollCallPage('https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00250.xml')
    ).toBe('https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00250.htm');
    expect(
      rollCallPage('https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_00001.xml')
    ).toBe('https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_00001.htm');
  });
});

test('any other shape comes back unchanged: the link still reaches the record', () => {
  for (const source of [
    'https://clerk.house.gov/evs/2025/roll144.htm',
    'http://clerk.house.gov/evs/2025/roll144.xml',
    'https://clerk.house.gov/evs/2025/roll144.xml?x=1',
    'https://www.congress.gov/votes/house/119-1/144',
    'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00244.htm',
    'https://senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00244.xml',
    'https://example.org/clerk.house.gov/evs/2025/roll144.xml',
    '',
  ]) {
    expect(rollCallPage(source), source).toBe(source);
  }
});

test('every stored roll call gets its own chamber\'s readable page, for its own year, session and roll', () => {
  expect(VOTES.rollCalls.length).toBeGreaterThan(0);
  const wrong: string[] = [];
  for (const r of VOTES.rollCalls) {
    const page = rollCallPage(r.source);
    // A pass-through here would put the raw data file back on a card. A new
    // shape from the nightly sync fails this line, naming the roll call.
    if (page === r.source) {
      wrong.push(`${r.id}: no readable page for ${r.source}`);
      continue;
    }
    if (r.chamber === 'house') {
      const year = r.date.slice(0, 4);
      const fromFile = /\/evs\/(\d{4})\/roll(\d+)\.xml$/.exec(r.source);
      if (
        page !== `https://clerk.house.gov/Votes/${year}${r.roll}` ||
        fromFile?.[1] !== year ||
        Number(fromFile?.[2]) !== r.roll
      ) {
        wrong.push(`${r.id}: ${page}`);
      }
    } else {
      const want =
        `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${r.congress}${r.session}/` +
        `vote_${r.congress}_${r.session}_${String(r.roll).padStart(5, '0')}.htm`;
      if (page !== want || page.replace(/\.htm$/, '.xml') !== r.source) wrong.push(`${r.id}: ${page}`);
    }
  }
  expect(wrong).toEqual([]);
});

test('no page links a roll call\'s data file: every vote card goes through rollCallPage', () => {
  // The three cards that print an official-record link for a roll call: the
  // bill page's vote record (and its no-JavaScript line, which gets the same
  // value), the member page's votes, and the daily brief's vote card.
  for (const file of ['components/VoteRecord.tsx', 'components/MemberVotes.tsx', 'components/TodayVoteCard.tsx']) {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    expect(src, `${file} imports the helper`).toMatch(/from '@\/lib\/roll-call-page'/);
    expect(src, `${file} links a roll call's source directly`).not.toMatch(/(href|source)=\{\s*[\w.]*\.source\s*\}/);
  }
  const record = readFileSync(join(process.cwd(), 'components/VoteRecord.tsx'), 'utf8');
  expect(record).toMatch(/const record = rollCallPage\(r\.source\);/);
  expect(record).toMatch(/href=\{record\}/);
  expect(record).toMatch(/<VoteMembers rollCallId=\{r\.id\} source=\{record\}/);
});

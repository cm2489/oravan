import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { getAllBills } from '../lib/core';
import { fixtureRetries, NAMES_FIXTURE_ENV, NAMES_FIXTURE_ON, NAMES_FIXTURE_TITLES_PATH, namesFixtureFrom } from '../lib/names-fixture.mjs';
import { sharedNamePages, sharedNamePagesFrom } from '../lib/shared-names';
import { encodeNameTables, SHORT_ADDRESS_CONGRESS, shortAddressFallbackCongresses, type ShortTitleFile } from '../lib/short-address';
import { gateNameTables, nameTablesForBuild, readNamesFile, readShortTitles, reservedNames } from '../lib/short-address-build';
import { SHORT_TITLES_PATH, SHORT_TITLES_RETRY_PATH } from '../lib/short-titles.mjs';

/*
 * THE CI NAMES FIXTURE SWITCH (lib/names-fixture.mjs; the independent check of
 * #510, Nov 19, 2026). It must change nothing a real build serves (rules 2 and
 * 11): off, the build reads exactly the data files; it is refused on Vercel;
 * only the CI `names-fixture` job sets it. On, it gives at least three list
 * pages. Pure Node; the corpus is the committed one.
 */

const ROOT = process.cwd();
const BILLS = getAllBills();

test('the switch: off unless exactly "1"; refused on Vercel; any other value refused', () => {
  for (const v of [undefined, '', ' ', '0', 'off', 'OFF', 'false']) expect(namesFixtureFrom({ [NAMES_FIXTURE_ENV]: v }), String(v)).toBe(false);
  expect(namesFixtureFrom({})).toBe(false);
  expect(namesFixtureFrom({ [NAMES_FIXTURE_ENV]: '1' })).toBe(true);
  // CI is where it is for.
  expect(namesFixtureFrom({ [NAMES_FIXTURE_ENV]: '1', CI: 'true', GITHUB_ACTIONS: 'true' })).toBe(true);
  for (const name of ['VERCEL', 'VERCEL_ENV', 'VERCEL_TARGET_ENV', 'VERCEL_URL', 'VERCEL_GIT_COMMIT_SHA']) {
    expect(() => namesFixtureFrom({ [NAMES_FIXTURE_ENV]: '1', [name]: 'production' }), name).toThrow(/refused here/);
  }
  for (const v of ['yes', 'true', '2', '01']) expect(() => namesFixtureFrom({ [NAMES_FIXTURE_ENV]: v }), v).toThrow(/not accepted/);
});

test('this unit run has the switch off (CI’s unit job never sets it), so every default below is a real build’s', () => {
  expect(process.env[NAMES_FIXTURE_ENV] ?? '').toBe('');
  expect(NAMES_FIXTURE_ON).toBe(false);
});

test('off: the name tables, the titles and the list pages are exactly what the data files alone give', () => {
  // What a build computes, by default.
  const built = nameTablesForBuild(BILLS);
  // The same, from the data files read directly, with no fixture anywhere.
  const titles = readNamesFile(ROOT, SHORT_TITLES_PATH).data as ShortTitleFile;
  const retry = readNamesFile(ROOT, SHORT_TITLES_RETRY_PATH).data;
  const order = [SHORT_ADDRESS_CONGRESS, ...shortAddressFallbackCongresses(BILLS)];
  const reserved = reservedNames(ROOT);
  const direct = gateNameTables(encodeNameTables(BILLS, titles, order, reserved), BILLS, titles, retry, order, reserved).encoded;
  expect(built).toBe(direct);
  expect(nameTablesForBuild(BILLS, ROOT, undefined, false)).toBe(direct);
  expect(readShortTitles()).toEqual(titles);
  expect(sharedNamePages(BILLS)).toEqual(sharedNamePagesFrom(BILLS, titles, order, reserved, direct));
});

test('on: the fixture gives at least three list pages, every one of its bills is in the corpus, and nothing in data/ is read for names', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, NAMES_FIXTURE_TITLES_PATH), 'utf8')) as ShortTitleFile;
  const held = new Set(BILLS.map((b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`));
  for (const slug of Object.keys(fixture)) expect(held.has(slug), `${slug} is in data/bills.json`).toBe(true);
  expect(readShortTitles(ROOT, true)).toEqual(fixture);
  const encoded = nameTablesForBuild(BILLS, ROOT, undefined, true);
  expect(encoded).not.toBe('');
  const order = [SHORT_ADDRESS_CONGRESS, ...shortAddressFallbackCongresses(BILLS)];
  const pages = sharedNamePagesFrom(BILLS, fixture, order, reservedNames(ROOT), encoded);
  expect(pages.length).toBeGreaterThanOrEqual(3);
  test.info().annotations.push({ type: 'fixture pages', description: pages.map((p) => `${p.name} (${p.bills.length})`).join(', ') });
  // Every other bill counts as tried, and only those.
  const retry = fixtureRetries(BILLS, fixture);
  expect(Object.keys(retry).length).toBe(BILLS.length - Object.keys(fixture).length);
});

test('only the CI names-fixture job sets the switch, and only lib/short-address-build.ts and tests read it', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const start = ci.indexOf('\n  names-fixture:\n');
  expect(start).toBeGreaterThan(0);
  const next = ci.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  const job = ci.slice(start, next < 0 ? undefined : start + 1 + next);
  const all = ci.split(NAMES_FIXTURE_ENV).length - 1;
  const inJob = job.split(NAMES_FIXTURE_ENV).length - 1;
  expect(inJob).toBeGreaterThan(0);
  expect(all - inJob, 'the switch named outside the names-fixture job').toBe(0);
  for (const f of fs.readdirSync(path.join(ROOT, '.github/workflows'))) {
    if (f === 'ci.yml') continue;
    expect(fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8'), f).not.toContain(NAMES_FIXTURE_ENV);
  }
  const readers = execSync("grep -rln 'names-fixture' app components lib proxy.ts next.config.ts", { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((f) => f !== 'lib/names-fixture.mjs')
    .sort();
  expect(readers).toEqual(['lib/short-address-build.ts']);
});

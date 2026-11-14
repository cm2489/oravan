import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { CONGRESS_POLICY } from '../lib/congress.mjs';
import { NEW_MEMBER_LINE_KEY, memberTurnover, servedLine, showsNoVotesYet } from '../lib/departed-members';
import { ENDED_ONLY_KEYS, browserMessagesFor, withoutEndedMessages } from '../lib/ended-messages';
import { getDepartedMembers, memberTurnover as siteMemberTurnover } from '../lib/core';
import { clientMessages } from '../i18n/client-messages';
import { embedDicts } from '../components/embed/embed-dicts';
import { withSitePolicyForTest } from '../lib/ended-state.mjs';
import { ENDED_119 } from './fixtures/ended-bills';

/*
 * THE MEMBER PAGES' CHANGEOVER SENTENCES STAY OFF THE BROWSER UNTIL A
 * CONGRESS HAS ENDED (the same filter as #486's ended sentences,
 * lib/ended-messages.ts).
 *
 * "Served in the {chamber} until January 3, 2027." and the new-member line
 * "No recorded votes yet on a bill Oravan tracks." (members who leave, #487)
 * can be shown only once a Congress is on the ended list, yet the layout hands
 * the whole catalog to the browser on every page, so they sat in every page's
 * source months early. They are filtered by the same condition (ended list
 * empty), in the same places. What the sixteen mid-term record pages show
 * today is untouched.
 */

type Json = { [k: string]: unknown };
const ended119 = <T>(fn: () => T): T => withSitePolicyForTest(ENDED_119, fn);
const CATALOGS = { en: en as unknown as Json, es: es as unknown as Json };

/** Every leaf's dotted path. */
function leaves(node: unknown, prefix = ''): string[] {
  if (node && typeof node === 'object') {
    return Object.entries(node as Json).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [prefix];
}
const underFilter = (path: string) => ENDED_ONLY_KEYS.some((k) => path === k || path.startsWith(`${k}.`));
const at = (catalog: Json, path: string) =>
  path.split('.').reduce<unknown>((n, k) => (n as Json | undefined)?.[k], catalog);

const CHANGEOVER = {
  en: ['Served in the {chamber} until January 3, 2027.', 'No recorded votes yet on a bill Oravan tracks.'],
  es: [
    (es as unknown as { rep: Record<string, string> }).rep.departedServed,
    (es as unknown as { rep: Record<string, string> }).rep.votesNoneYetTracked,
  ],
};

test('the sentences the filter holds back are the intended ones, in both languages', () => {
  expect(en.rep.departedServed).toBe(CHANGEOVER.en[0]);
  expect(en.rep.votesNoneYetTracked).toBe(CHANGEOVER.en[1]);
  for (const s of CHANGEOVER.es) expect(s.length).toBeGreaterThan(10);
  expect(es.rep.departedServed).not.toBe(en.rep.departedServed);
  expect(NEW_MEMBER_LINE_KEY).toBe('votesNoneYetTracked');
});

test('the filter drops exactly the ended-only paths and nothing else, in both languages', () => {
  for (const [lang, catalog] of Object.entries(CATALOGS)) {
    const before = leaves(catalog);
    const after = new Set(leaves(withoutEndedMessages(catalog)));
    const dropped = before.filter((p) => !after.has(p));
    expect(dropped.sort(), lang).toEqual(before.filter(underFilter).sort());
    // The three changeover paths are among them.
    for (const p of ['rep.departedServed', 'rep.votesNoneYet', 'rep.votesNoneYetTracked']) {
      expect(dropped, `${lang} ${p}`).toContain(p);
    }
    // Every other key keeps its place: the result serializes as a catalog that never had them.
    expect(Object.keys((withoutEndedMessages(catalog).rep as Json)), lang).toEqual(
      Object.keys(catalog.rep as Json).filter((k) => !['departedServed', 'votesNoneYet', 'votesNoneYetTracked'].includes(k)),
    );
  }
});

test('nothing the member pages show today is dropped', () => {
  // What a record page prints today (app/[locale]/reps/[bioguide]/page.tsx):
  // the dated line, the chamber word, the "Former …" role, the crumb.
  const SHOWN_TODAY = [
    'rep.departedServedOn',
    'rep.departedChamber.house',
    'rep.departedChamber.senate',
    'rep.formerRole.senator',
    'rep.formerRole.representative',
    'rep.formerRole.delegate',
    'rep.crumbRecord',
    'rep.votesNone',
  ];
  for (const [lang, catalog] of Object.entries(CATALOGS)) {
    const browser = clientMessages(catalog as never) as Json;
    for (const p of SHOWN_TODAY) {
      expect(at(catalog, p), `${lang} ${p} exists`).toBeTruthy();
      expect(at(browser, p), `${lang} ${p} reaches the browser`).toBe(at(catalog, p));
    }
  }
});

test('no page can show a held-back sentence while no Congress has ended', () => {
  // The site's member turnover is null until a Congress is on the ended list…
  expect(siteMemberTurnover()).toBeNull();
  expect(memberTurnover(CONGRESS_POLICY)).toBeNull();
  // …so every record page prints the dated line, never the changeover line…
  const records = getDepartedMembers();
  expect(records.length).toBeGreaterThan(0);
  for (const d of records) expect(servedLine(d, memberTurnover(CONGRESS_POLICY)).key, d.bioguide).toBe('departedServedOn');
  // …and the new-member line cannot print, whatever the member's votes.
  for (const voteBills of [0, 1, 5]) {
    for (const delegate of [false, true]) {
      for (const reviewNew of [false, true]) {
        expect(showsNoVotesYet({ turnover: null, voteBills, delegate, reviewNew })).toBe(false);
      }
    }
  }
  // The superseded first wording is read by no code at all (lib/departed-members.ts
  // names it only as the type NEW_MEMBER_LINE_KEY may take, and says why;
  // lib/ended-messages.ts names it to hold it back).
  const src = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
  const all = ['app', 'components', 'lib'].flatMap((d) => walk(d)).filter(
    (f) => !['lib/departed-members.ts', 'lib/ended-messages.ts'].includes(f),
  );
  for (const f of all) expect(src(f), f).not.toMatch(/['"`.]votesNoneYet['"`]|rep\.votesNoneYet\b|t\(['"`]votesNoneYet['"`]/);
});

test('the browser catalog leaves them out today, and carries them once a Congress has ended', () => {
  for (const [lang, catalog] of Object.entries(CATALOGS)) {
    const today = JSON.stringify(clientMessages(catalog as never));
    for (const s of [...CHANGEOVER.en, ...CHANGEOVER.es]) expect(today, `${lang}: ${s}`).not.toContain(s);
    expect(today).not.toContain('departedServed"');
    expect(today).not.toContain('votesNoneYet');
    // Ended: the whole catalog (glossary terms aside), these sentences included.
    const ended = JSON.stringify(ended119(() => clientMessages(catalog as never)));
    for (const s of lang === 'en' ? CHANGEOVER.en : CHANGEOVER.es) expect(ended, `${lang} ended: ${s}`).toContain(s);
    expect(at(ended119(() => clientMessages(catalog as never)) as Json, 'rep.votesNoneYet')).toBe(at(catalog, 'rep.votesNoneYet'));
    // The condition is the ended list: the override is the same switch.
    expect(JSON.stringify(browserMessagesFor(catalog, true))).toContain(at(catalog, 'rep.departedServed') as string);
    expect(JSON.stringify(browserMessagesFor(catalog, false))).not.toContain(at(catalog, 'rep.departedServed') as string);
  }
});

test('the embed dictionaries never carry them, in either language, ended Congress or not', () => {
  for (const dicts of [embedDicts(), ended119(() => embedDicts())]) {
    for (const lang of ['en', 'es'] as const) {
      expect('rep' in dicts[lang], `${lang} carries the member-page namespace`).toBe(false);
      const text = JSON.stringify(dicts[lang]);
      for (const s of [...CHANGEOVER.en, ...CHANGEOVER.es]) expect(text).not.toContain(s);
    }
  }
});

test('no browser component reads a held-back key, and the member pages that print them render on the server', () => {
  const browser = [...walk('app'), ...walk('components')].filter((f) =>
    /^['"]use client['"]/m.test(readFileSync(f, 'utf8')),
  );
  expect(browser.length).toBeGreaterThan(20);
  for (const f of browser) {
    expect(readFileSync(f, 'utf8'), f).not.toMatch(/departedServed\b|votesNoneYet|NEW_MEMBER_LINE_KEY/);
  }
  const votes = readFileSync(join(process.cwd(), 'components/MemberVotes.tsx'), 'utf8');
  expect(votes).toContain("from 'next-intl/server'");
  expect(votes).not.toMatch(/^['"]use client['"]/m);
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : /\.(tsx?|mjs)$/.test(d.name) ? [join(dir, d.name)] : [],
  );
}

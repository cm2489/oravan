import { expect, test } from '@playwright/test';
import { ENTRY_KEY, entryFor, readEntry, rememberMembers, sameEntry } from '../lib/members-entry';
import { membersFor } from '../lib/members';

/*
 * THE MEMBERS PAGE'S HISTORY ENTRY (lib/members-entry.ts, 2026-11-12): what
 * the page keeps in its own history entry's state so Reload and Back behave
 * as they did while the ZIP and district sat in the address. The browser
 * half (Next.js's patched history methods, Reload, Back) is pinned by
 * tests/reps-zip-address.spec.ts; this file pins the pure half and what is
 * handed to the history methods.
 */

test('readEntry: reads its own key, and nothing else, totally', () => {
  expect(readEntry({ [ENTRY_KEY]: { zip: '10001', district: 'NY-12' } })).toEqual({ zip: '10001', district: 'NY-12' });
  expect(readEntry({ [ENTRY_KEY]: { zip: '10001' } })).toEqual({ zip: '10001' });
  // A damaged district drops to the unrefined view rather than to nothing.
  expect(readEntry({ [ENTRY_KEY]: { zip: '10001', district: 'ny 12' } })).toEqual({ zip: '10001' });
  for (const junk of [null, undefined, 5, 'x', {}, { __NA: true }, { [ENTRY_KEY]: null }, { [ENTRY_KEY]: { zip: '1001' } }, { [ENTRY_KEY]: { zip: 10001 } }]) {
    expect(readEntry(junk), JSON.stringify(junk)).toBeNull();
  }
});

test('entryFor: the ZIP, plus the district only when a street address refined it', () => {
  expect(entryFor(membersFor('10001'))).toEqual({ zip: '10001' });
  expect(entryFor(membersFor('10001', 'NY-12'))).toEqual({ zip: '10001', district: 'NY-12' });
  // A ZIP that matched nothing is not remembered: Reload shows the prompt.
  expect(entryFor(membersFor('00000'))).toBeNull();
  expect(entryFor(null)).toBeNull();
  expect(sameEntry({ zip: '10001' }, entryFor(membersFor('10001')))).toBe(true);
  expect(sameEntry({ zip: '10001', district: 'NY-12' }, entryFor(membersFor('10001')))).toBe(false);
});

test('rememberMembers: only its own key goes in, the address loses the lookup, push or replace as asked', () => {
  const calls: { method: string; state: unknown; url: string | undefined }[] = [];
  const location = { href: '', pathname: '', search: '', hash: '' };
  const at = (href: string) => {
    const u = new URL(href);
    Object.assign(location, { href: u.href, pathname: u.pathname, search: u.search, hash: u.hash });
  };
  (globalThis as unknown as { window: unknown }).window = {
    location,
    history: {
      pushState: (state: unknown, _: string, url?: string) => calls.push({ method: 'push', state, url }),
      replaceState: (state: unknown, _: string, url?: string) => calls.push({ method: 'replace', state, url }),
    },
  };
  try {
    // An old link: the address is cleaned, the lookup kept in the entry.
    at('https://oravan.org/es/reps?zip=10001&district=NY-12#your-calls');
    rememberMembers({ zip: '10001', district: 'NY-12' }, 'replace');
    // A refinement on the clean address: a new entry, and no URL, so the
    // router has nothing to learn.
    at('https://oravan.org/reps');
    rememberMembers({ zip: '10001', district: 'NY-12' }, 'push');
    // A lookup from "Change ZIP code": `change` goes too.
    at('https://oravan.org/reps?change=1');
    rememberMembers({ zip: '20001' }, 'replace');
    // A ZIP that matched nothing: the entry forgets.
    at('https://oravan.org/reps');
    rememberMembers(null, 'replace');
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
  expect(calls).toEqual([
    { method: 'replace', state: { [ENTRY_KEY]: { zip: '10001', district: 'NY-12' } }, url: '/es/reps#your-calls' },
    { method: 'push', state: { [ENTRY_KEY]: { zip: '10001', district: 'NY-12' } }, url: undefined },
    { method: 'replace', state: { [ENTRY_KEY]: { zip: '20001' } }, url: '/reps' },
    { method: 'replace', state: {}, url: undefined },
  ]);
  // Never Next.js's own marker: an object holding __NA would skip the
  // router's copy of its state (app-router.js, 16.2.12).
  for (const c of calls) expect(c.state).not.toHaveProperty('__NA');
});

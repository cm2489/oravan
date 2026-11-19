import { expect, test } from '@playwright/test';
import { ENTRY_KEY, entryFor, forgetStaleEntry, readEntry, rememberMembers, sameEntry } from '../lib/members-entry';
import { membersFor } from '../lib/members';
import { eraseAll } from '../lib/local';

/*
 * THE MEMBERS PAGE'S HISTORY ENTRY (lib/members-entry.ts, 2026-11-12): what
 * the page keeps in its own history entry's state so Reload and Back behave
 * as they did while the ZIP and district sat in the address. The browser
 * half (Next.js's patched history methods, Reload, Back) is pinned by
 * tests/reps-zip-address.spec.ts; this file pins the pure half and what is
 * handed to the history methods.
 */

const TAG = '0123456789abcdef0123456789abcdef';

test('readEntry: reads its own key, and nothing else, totally', () => {
  expect(readEntry({ [ENTRY_KEY]: { zip: '10001', district: 'NY-12', tag: TAG } }, TAG)).toEqual({ zip: '10001', district: 'NY-12' });
  expect(readEntry({ [ENTRY_KEY]: { zip: '10001', tag: TAG } }, TAG)).toEqual({ zip: '10001' });
  // A damaged district drops to the unrefined view rather than to nothing.
  expect(readEntry({ [ENTRY_KEY]: { zip: '10001', district: 'ny 12', tag: TAG } }, TAG)).toEqual({ zip: '10001' });
  for (const junk of [null, undefined, 5, 'x', {}, { __NA: true }, { [ENTRY_KEY]: null }, { [ENTRY_KEY]: { zip: '1001', tag: TAG } }, { [ENTRY_KEY]: { zip: 10001, tag: TAG } }]) {
    expect(readEntry(junk, TAG), JSON.stringify(junk)).toBeNull();
  }
});

/*
 * AN ERASE MAKES EVERY EARLIER ENTRY UNREADABLE (2026-11-18). An entry counts
 * only while it carries the browser's current tag (lib/local.ts): after an
 * erase there is no tag, and after the next lookup there is a new one, so an
 * entry from before the erase, in this tab or another, reads as empty. So
 * does an entry written before tags existed (still sitting in an open tab
 * when this code loads): ignoring it is the safe reading.
 */
test('readEntry: only an entry carrying the current tag counts', () => {
  const entry = { [ENTRY_KEY]: { zip: '10001', district: 'NY-12', tag: TAG } };
  expect(readEntry(entry, TAG)).toEqual({ zip: '10001', district: 'NY-12' });
  // Erased: no current tag, so nothing reads, whatever the entry says.
  expect(readEntry(entry, null)).toBeNull();
  // A new tag since (the next lookup after the erase): the old entry is dead.
  expect(readEntry(entry, 'fedcba9876543210fedcba9876543210')).toBeNull();
  // Written before tags existed, or with a damaged tag: ignored.
  expect(readEntry({ [ENTRY_KEY]: { zip: '10001' } }, TAG)).toBeNull();
  expect(readEntry({ [ENTRY_KEY]: { zip: '10001', tag: 5 } }, TAG)).toBeNull();
  expect(readEntry({ [ENTRY_KEY]: { zip: '10001', tag: '' } }, '')).toBeNull();
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
  const stored = new Map<string, string>();
  const location = { href: '', pathname: '', search: '', hash: '' };
  const at = (href: string) => {
    const u = new URL(href);
    Object.assign(location, { href: u.href, pathname: u.pathname, search: u.search, hash: u.hash });
  };
  (globalThis as unknown as { window: unknown }).window = {
    location,
    localStorage: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
      removeItem: (k: string) => void stored.delete(k),
    },
    history: {
      pushState: (state: unknown, _: string, url?: string) => calls.push({ method: 'push', state, url }),
      replaceState: (state: unknown, _: string, url?: string) => calls.push({ method: 'replace', state, url }),
    },
  };
  try {
    eraseAll(); // no tag left over in this worker's module from another test
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
  // Every entry carries the one tag the first write made and kept, and only
  // in this browser's storage (see readEntry above).
  const tag = stored.get('oravan.entry');
  expect(tag).toMatch(/^[0-9a-f]{32}$/);
  expect(calls).toEqual([
    { method: 'replace', state: { [ENTRY_KEY]: { zip: '10001', district: 'NY-12', tag } }, url: '/es/reps#your-calls' },
    { method: 'push', state: { [ENTRY_KEY]: { zip: '10001', district: 'NY-12', tag } }, url: undefined },
    { method: 'replace', state: { [ENTRY_KEY]: { zip: '20001', tag } }, url: '/reps' },
    { method: 'replace', state: {}, url: undefined },
  ]);
  // Never Next.js's own marker: an object holding __NA would skip the
  // router's copy of its state (app-router.js, 16.2.12).
  for (const c of calls) expect(c.state).not.toHaveProperty('__NA');
});

test('forgetStaleEntry: an entry the erase made unreadable is emptied; a current one is kept', () => {
  const calls: unknown[] = [];
  const stored = new Map<string, string>();
  const history = {
    state: null as unknown,
    replaceState: (state: unknown) => {
      calls.push(state);
      history.state = state;
    },
  };
  (globalThis as unknown as { window: unknown }).window = {
    history,
    localStorage: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
      removeItem: (k: string) => void stored.delete(k),
    },
  };
  try {
    eraseAll();
    stored.set('oravan.entry', TAG);
    // Current: kept, untouched.
    history.state = { __NA: true, [ENTRY_KEY]: { zip: '10001', tag: TAG } };
    forgetStaleEntry();
    expect(calls).toEqual([]);
    // Erased since (no tag): the ZIP goes, the router's own keys stay.
    eraseAll();
    forgetStaleEntry();
    expect(calls).toEqual([{ __NA: true }]);
    // Nothing of ours in the entry: nothing to do.
    calls.length = 0;
    forgetStaleEntry();
    history.state = null;
    forgetStaleEntry();
    expect(calls).toEqual([]);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

import { expect, test } from '@playwright/test';
import { ensureEntryTag, entryTag, eraseAll, erasureCount, savedZip, setPrefs, subscribe } from '../lib/local';

/*
 * AN ERASE IN ANOTHER TAB, OR WHILE THE PAGE SLEPT (lib/local.ts, 2026-11-18).
 * The erase count that every reader of the ZIP checks must move when another
 * tab erases (the browser's `storage` event: an erase key removed, or the
 * store cleared) and when a page comes back from the back/forward cache
 * (`pageshow`, persisted) to find a key it had read now gone. Driven here with
 * a stand-in `window` whose listeners the test fires by hand.
 *
 * One stand-in for the whole file: lib/local.ts installs its `pageshow`
 * listener once per page, as a page would.
 */

type Handler = (e: unknown) => void;
const handlers = new Map<string, Set<Handler>>();
const data = new Map<string, string>();

test.beforeAll(() => {
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
    addEventListener: (type: string, h: Handler) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(h);
    },
    removeEventListener: (type: string, h: Handler) => void handlers.get(type)?.delete(h),
  };
  eraseAll(); // a clean module
});

test.afterAll(() => {
  delete (globalThis as { window?: unknown }).window;
});

const fire = (type: string, e: unknown) => {
  for (const h of [...(handlers.get(type) ?? [])]) h(e);
};

/** What another tab's eraseAll() looks like from here, one event per key. */
const removed = (key: string) => ({ key, newValue: null, oldValue: 'x' });

test('another tab erasing counts here once, however many readers listen', () => {
  let redraws = 0;
  const offA = subscribe(() => redraws++);
  const offB = subscribe(() => redraws++);
  try {
    const before = erasureCount();
    const e = removed('oravan.entry');
    fire('storage', e);
    expect(erasureCount(), 'one event, two readers: counted once').toBe(before + 1);
    expect(redraws, 'and every reader redraws').toBe(2);

    // The other erase keys count too: an erase made before any tag existed
    // removes only the preferences, the calls and the reads.
    for (const key of ['oravan.prefs', 'oravan.calls', 'oravan.reads']) fire('storage', removed(key));
    expect(erasureCount()).toBe(before + 4);

    // The whole store cleared (key null): an erase.
    fire('storage', { key: null, newValue: null, oldValue: null });
    expect(erasureCount()).toBe(before + 5);
  } finally {
    offA();
    offB();
  }
});

test('ordinary writes in another tab are not an erase', () => {
  const off = subscribe(() => {});
  try {
    const before = erasureCount();
    fire('storage', { key: 'oravan.prefs', newValue: '{"zip":"20001"}', oldValue: null });
    fire('storage', { key: 'oravan.calls', newValue: '[]', oldValue: '[]' });
    fire('storage', { key: 'oravan.locale.chosen', newValue: null, oldValue: 'es' });
    fire('storage', { key: 'oravan.entry', newValue: '0123456789abcdef0123456789abcdef', oldValue: null });
    expect(erasureCount()).toBe(before);
  } finally {
    off();
  }
});

test('back from the back/forward cache: a key this page read and is now gone counts as an erase', () => {
  let redraws = 0;
  const off = subscribe(() => redraws++);
  try {
    data.clear();
    setPrefs({ zip: '20001' });
    ensureEntryTag();
    expect(savedZip()).toBe('20001'); // this page has read the ZIP
    const before = erasureCount();

    // Shown again with nothing changed: no erase, but the readers redraw.
    fire('pageshow', { persisted: true });
    expect(erasureCount()).toBe(before);

    // A first load is not a return from the cache.
    data.clear();
    fire('pageshow', { persisted: false });
    expect(erasureCount()).toBe(before);

    // Erased elsewhere while this page slept (no event reached it).
    redraws = 0;
    fire('pageshow', { persisted: true });
    expect(erasureCount()).toBe(before + 1);
    expect(redraws).toBeGreaterThan(0);
  } finally {
    off();
  }
});

test('the first of another tab\'s erase events revokes the tag this tab can still see', () => {
  const off = subscribe(() => {});
  try {
    data.clear();
    const tag = ensureEntryTag();
    expect(entryTag()).toBe(tag);
    // The preferences' removal arrives first; the tag is still in storage.
    fire('storage', removed('oravan.prefs'));
    expect(data.get('oravan.entry'), 'still stored').toBe(tag);
    expect(entryTag(), 'but no longer read').toBeNull();
    // The next tag made here is a new one.
    const next = ensureEntryTag();
    expect(next).not.toBe(tag);
    expect(entryTag()).toBe(next);
  } finally {
    off();
  }
});

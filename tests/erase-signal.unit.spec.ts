import { expect, test } from '@playwright/test';
import { ensureEntryTag, entryTag, eraseAll, erasureCount, heldSnapshotCaches, savedZip, setPrefs, subscribe } from '../lib/local';
import { shareRepLookup, sharedRepLookupNow } from '../lib/rep-lookup-share';

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

test('an erase made on this page is not counted again when the page comes back from the cache', () => {
  const off = subscribe(() => {});
  try {
    data.clear();
    setPrefs({ zip: '20001' });
    expect(savedZip()).toBe('20001');
    ensureEntryTag();
    expect(entryTag()).not.toBeNull(); // read with a value before the erase, absent after it
    eraseAll(); // here, on this page: counted once, now
    setPrefs({ zip: '10001' }); // a new ZIP after it
    expect(savedZip()).toBe('10001');
    const before = erasureCount();
    fire('pageshow', { persisted: true });
    expect(erasureCount(), 'the members found after the erase stay').toBe(before);
  } finally {
    off();
  }
});

test('an erase empties the members held in memory for the bill and Call pages (lib/rep-lookup-share.ts)', () => {
  const off = subscribe(() => {});
  try {
    const lookup = { zip: '20001', multiDistrict: false, reps: [{ bioguide: 'X000001', name: 'A member', state: 'DC', type: 'rep' as const }] };
    shareRepLookup(lookup);
    expect(sharedRepLookupNow()?.zip).toBe('20001');
    eraseAll();
    expect(sharedRepLookupNow(), 'this tab\'s erase').toBeNull();

    shareRepLookup(lookup);
    fire('storage', removed('oravan.entry'));
    expect(sharedRepLookupNow(), 'another tab\'s erase').toBeNull();
  } finally {
    off();
  }
});

test('an erase that cannot remove a key says so, and removes the tag first', () => {
  const remove = (window as unknown as { localStorage: { removeItem: (k: string) => void } }).localStorage.removeItem;
  for (const stuck of ['oravan.entry', 'oravan.prefs', 'oravan.calls', 'oravan.reads']) {
    data.clear();
    for (const k of ['oravan.entry', 'oravan.prefs', 'oravan.calls', 'oravan.reads']) data.set(k, k === 'oravan.entry' ? '0123456789abcdef0123456789abcdef' : '[]');
    const order: string[] = [];
    (window as unknown as { localStorage: { removeItem: (k: string) => void } }).localStorage.removeItem = (k: string) => {
      order.push(k);
      if (k === stuck) throw new Error('refused');
      data.delete(k);
    };
    try {
      const before = erasureCount();
      expect(eraseAll(), `${stuck} would not go`).toBe(false);
      expect(order[0], 'the tag first').toBe('oravan.entry');
      expect(order, 'every key tried').toEqual(['oravan.entry', 'oravan.prefs', 'oravan.calls', 'oravan.reads']);
      expect([...data.keys()]).toEqual([stuck]);
      expect(erasureCount(), 'counted all the same').toBe(before + 1);
      if (stuck === 'oravan.entry') expect(entryTag(), 'a tag that would not go is dead in this tab').toBeNull();
    } finally {
      (window as unknown as { localStorage: { removeItem: (k: string) => void } }).localStorage.removeItem = remove;
    }
  }
  data.clear();
  expect(eraseAll(), 'nothing stuck: a whole erase').toBe(true);
});

test('an erase leaves no copy of the ZIP in this page\'s memory: snapshot caches and a refused write', () => {
  const store = (window as unknown as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage;
  const set = store.setItem;
  const off = subscribe(() => {});
  try {
    data.clear();
    setPrefs({ zip: '20001' });
    expect(savedZip()).toBe('20001');
    expect(heldSnapshotCaches()).toBeGreaterThan(0);
    eraseAll();
    expect(heldSnapshotCaches(), 'the last string read is not kept').toBe(0);

    // This tab's store refuses writes (full): the ZIP is kept in memory.
    // Another tab then erases: that copy goes too.
    store.setItem = () => {
      throw new Error('full');
    };
    setPrefs({ zip: '20001' });
    expect(savedZip()).toBe('20001');
    fire('storage', removed('oravan.prefs'));
    expect(savedZip(), 'the refused write kept in memory').toBeNull();
  } finally {
    store.setItem = set;
    off();
  }
});

test('another tab\'s erase is not counted again when this page comes back from the cache', () => {
  const off = subscribe(() => {});
  try {
    data.clear();
    setPrefs({ zip: '20001' });
    ensureEntryTag();
    expect(entryTag()).not.toBeNull();
    expect(savedZip()).toBe('20001');
    for (const k of ['oravan.entry', 'oravan.prefs']) {
      data.delete(k);
      fire('storage', removed(k));
    }
    setPrefs({ zip: '10001' }); // a new ZIP after it, read here
    expect(savedZip()).toBe('10001');
    const before = erasureCount();
    fire('pageshow', { persisted: true });
    expect(erasureCount(), 'the members found after that erase stay').toBe(before);
  } finally {
    off();
  }
});

test('another tab\'s erase, tag first: the ZIP still visible here already reads as nothing; a new save there is seen', () => {
  const off = subscribe(() => {});
  try {
    data.clear();
    setPrefs({ zip: '20001' });
    ensureEntryTag();
    expect(savedZip()).toBe('20001');
    // The other tab removes the tag first; its other removals have not
    // reached this tab yet.
    data.delete('oravan.entry');
    fire('storage', removed('oravan.entry'));
    expect(data.has('oravan.prefs'), 'still stored here').toBe(true);
    expect(savedZip(), 'but read as erased').toBeNull();
    // The other tab saves a ZIP again (the same one, even): it is seen.
    data.set('oravan.prefs', JSON.stringify({ zip: '20001' }));
    fire('storage', { key: 'oravan.prefs', newValue: JSON.stringify({ zip: '20001' }), oldValue: null });
    expect(savedZip()).toBe('20001');

    // Erased again from there; then this tab saves the same ZIP itself: seen.
    data.delete('oravan.entry');
    fire('storage', removed('oravan.entry'));
    expect(savedZip()).toBeNull();
    setPrefs({ zip: '20001' });
    expect(savedZip()).toBe('20001');
  } finally {
    off();
  }
});

import { expect, test } from '@playwright/test';
import { ensureEntryTag, entryTag, eraseAll, erasureCount, savedZip, setPrefs, snapshotCacheContents, storeLost, subscribe, upsertCall } from '../lib/local';
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

const docHandlers = new Map<string, Set<Handler>>();
const doc = {
  visibilityState: 'visible',
  addEventListener: (type: string, h: Handler) => {
    if (!docHandlers.has(type)) docHandlers.set(type, new Set());
    docHandlers.get(type)!.add(h);
  },
};
const fireDoc = (type: string) => {
  for (const h of [...(docHandlers.get(type) ?? [])]) h({});
};

test.beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = doc;
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
  delete (globalThis as { document?: unknown }).document;
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

/** Another tab's write, as this tab sees it: storage holds the value when the event comes. */
const wrote = (key: string, newValue: string, oldValue: string | null = null) => {
  data.set(key, newValue);
  return { key, newValue, oldValue };
};

test('ordinary writes in another tab are not an erase', () => {
  const off = subscribe(() => {});
  try {
    const before = erasureCount();
    fire('storage', wrote('oravan.prefs', '{"zip":"20001"}'));
    fire('storage', wrote('oravan.calls', '[]', '[]'));
    fire('storage', { key: 'oravan.locale.chosen', newValue: null, oldValue: 'es' });
    fire('storage', wrote('oravan.entry', '0123456789abcdef0123456789abcdef'));
    expect(erasureCount()).toBe(before);
  } finally {
    off();
    data.clear();
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
      const tagBefore = data.get('oravan.entry');
      if (stuck === 'oravan.entry') {
        // The tag would not go, but a write still works: it is replaced by a
        // fresh random one, so no history copy carries it; that is an erase.
        expect(eraseAll(), 'the tag replaced').toBe(true);
        expect(data.get('oravan.entry')).toMatch(/^[0-9a-f]{32}$/);
        expect(data.get('oravan.entry')).not.toBe(tagBefore);
        expect([...data.keys()]).toEqual(['oravan.entry']);
      } else {
        expect(eraseAll(), `${stuck} would not go`).toBe(false);
        expect([...data.keys()]).toEqual([stuck]);
      }
      expect(order[0], 'the tag first').toBe('oravan.entry');
      expect(order, 'every key tried').toEqual(['oravan.entry', 'oravan.prefs', 'oravan.calls', 'oravan.reads']);
      expect(erasureCount(), 'counted all the same').toBe(before + 1);
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
    expect(snapshotCacheContents().some((raw) => raw?.includes('20001'))).toBe(true);
    eraseAll();
    expect(snapshotCacheContents().filter((raw) => raw?.includes('20001')), 'the last string read is not kept').toEqual([]);

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

test('a tag that will neither go nor be replaced: no whole erase, and it is dead in this tab', () => {
  const store = (window as unknown as { localStorage: Record<string, (...a: string[]) => unknown> }).localStorage;
  const { removeItem, setItem } = store;
  data.clear();
  data.set('oravan.entry', '0123456789abcdef0123456789abcdef');
  store.removeItem = (k: string) => {
    if (k === 'oravan.entry') throw new Error('refused');
    data.delete(k);
  };
  store.setItem = (k: string, v: string) => {
    if (k === 'oravan.entry') throw new Error('refused');
    data.set(k, v);
  };
  try {
    expect(eraseAll()).toBe(false);
    expect(entryTag()).toBeNull();
  } finally {
    store.removeItem = removeItem;
    store.setItem = setItem;
  }
});

test('storage blocked mid-visit, after it held our data: no whole erase', () => {
  const store = (window as unknown as { localStorage: Record<string, (...a: string[]) => unknown> }).localStorage;
  const { removeItem, getItem } = store;
  data.clear();
  setPrefs({ zip: '20001' });
  expect(savedZip()).toBe('20001'); // the store held our data this visit
  store.removeItem = () => {
    throw new Error('blocked');
  };
  store.getItem = () => {
    throw new Error('blocked');
  };
  try {
    expect(eraseAll(), 'it may still be on disk').toBe(false);
  } finally {
    store.removeItem = removeItem;
    store.getItem = getItem;
  }
});

/*
 * WHAT A TAB SHOWS MUST MATCH WHAT STORAGE HOLDS NOW (lib/local.ts, 2026-11-19):
 * an erase elsewhere followed by another ZIP saved there is a change here,
 * however this tab learns of it.
 */
test('back from the cache, shown again, or focused: another ZIP saved meanwhile is a change', () => {
  let redraws = 0;
  const off = subscribe(() => redraws++);
  try {
    for (const how of ['pageshow', 'visibilitychange', 'focus'] as const) {
      data.clear();
      setPrefs({ zip: '78501' });
      expect(savedZip()).toBe('78501');
      ensureEntryTag();
      expect(entryTag()).not.toBeNull();
      // Elsewhere, with no event reaching this tab: erase, then a new ZIP.
      data.clear();
      data.set('oravan.prefs', JSON.stringify({ zip: '10001' }));
      const before = erasureCount();
      redraws = 0;
      if (how === 'pageshow') fire('pageshow', { persisted: true });
      if (how === 'visibilitychange') {
        doc.visibilityState = 'visible';
        fireDoc('visibilitychange');
      }
      if (how === 'focus') fire('focus', {});
      expect(erasureCount(), how).toBe(before + 1);
      expect(redraws, `${how}: the page redraws`).toBeGreaterThan(0);
      // The new ZIP is not marked erased: it fills in.
      expect(savedZip(), how).toBe('10001');
    }
  } finally {
    off();
  }
});

test('nothing changed, or only the topics: not a change', () => {
  const off = subscribe(() => {});
  try {
    data.clear();
    setPrefs({ zip: '78501' });
    expect(savedZip()).toBe('78501');
    const before = erasureCount();
    fire('focus', {});
    doc.visibilityState = 'visible';
    fireDoc('visibilitychange');
    data.set('oravan.prefs', JSON.stringify({ zip: '78501', interests: ['health'] }));
    fire('pageshow', { persisted: true });
    fire('storage', { key: 'oravan.prefs', oldValue: JSON.stringify({ zip: '78501' }), newValue: JSON.stringify({ zip: '78501', interests: ['health'] }) });
    expect(erasureCount()).toBe(before);
  } finally {
    off();
  }
});

test('another tab turns the ZIP or the tag into another value: a change here; a first ZIP or tag is not', () => {
  const off = subscribe(() => {});
  try {
    data.clear();
    eraseAll();
    const before = erasureCount();
    fire('storage', wrote('oravan.prefs', JSON.stringify({ zip: '78501' })));
    fire('storage', wrote('oravan.entry', '0123456789abcdef0123456789abcdef'));
    expect(erasureCount(), 'a first value').toBe(before);
    // This tab reads them (a page shows the members for them).
    expect(savedZip()).toBe('78501');
    expect(entryTag()).toBe('0123456789abcdef0123456789abcdef');
    fire('storage', wrote('oravan.prefs', JSON.stringify({ zip: '10001' }), JSON.stringify({ zip: '78501' })));
    expect(erasureCount(), 'another ZIP').toBe(before + 1);
    expect(entryTag()).toBe('0123456789abcdef0123456789abcdef');
    fire('storage', wrote('oravan.entry', 'fedcba9876543210fedcba9876543210', '0123456789abcdef0123456789abcdef'));
    expect(erasureCount(), 'another tag').toBe(before + 2);
  } finally {
    off();
  }
});

/*
 * WHAT STORAGE HOLDS NOW DECIDES, NOT THE EVENT (check 5, 2026-11-19). The
 * other tab erases and then saves another ZIP; this tab hears the events in
 * the order they happened or (simulated) the other way round. Either way it
 * ends showing what storage holds: the new ZIP, never revoked.
 */
test('another tab erases, then saves another ZIP: the new ZIP is seen, whatever order the events come in', () => {
  const OLD_TAG = '0123456789abcdef0123456789abcdef';
  const NEW_TAG = 'fedcba9876543210fedcba9876543210';
  const OLD = JSON.stringify({ zip: '78501' });
  const NEW = JSON.stringify({ zip: '10001' });
  const off = subscribe(() => {});
  try {
    for (const order of ['as they happened', 'reversed'] as const) {
      data.clear();
      eraseAll();
      data.set('oravan.prefs', OLD);
      data.set('oravan.entry', OLD_TAG);
      data.set('oravan.calls', '[]');
      data.set('oravan.reads', '[]');
      expect(savedZip()).toBe('78501');
      expect(entryTag()).toBe(OLD_TAG);
      const events = [
        { key: 'oravan.entry', oldValue: OLD_TAG, newValue: null, after: () => data.delete('oravan.entry') },
        { key: 'oravan.prefs', oldValue: OLD, newValue: null, after: () => data.delete('oravan.prefs') },
        { key: 'oravan.calls', oldValue: '[]', newValue: null, after: () => data.delete('oravan.calls') },
        { key: 'oravan.reads', oldValue: '[]', newValue: null, after: () => data.delete('oravan.reads') },
        { key: 'oravan.prefs', oldValue: null, newValue: NEW, after: () => data.set('oravan.prefs', NEW) },
        { key: 'oravan.entry', oldValue: null, newValue: NEW_TAG, after: () => data.set('oravan.entry', NEW_TAG) },
      ];
      const before = erasureCount();
      if (order === 'as they happened') {
        // Storage changes one key at a time, each before its event.
        for (const { after, ...e } of events) {
          after();
          fire('storage', e);
          if (e.key === 'oravan.entry' && e.newValue === null) {
            expect(data.get('oravan.prefs'), 'the old ZIP is still visible here').toBe(OLD);
            expect(savedZip(), 'but it reads as erased').toBeNull();
          }
        }
      } else {
        // Every change is already in storage; the events come last first.
        for (const { after } of events) after();
        for (const { key, oldValue, newValue } of [...events].reverse()) {
          const e = { key, oldValue, newValue };
          fire('storage', e);
          expect(savedZip(), `reversed, after ${e.key} ${e.newValue === null ? 'removed' : 'written'}`).toBe('10001');
        }
      }
      expect(erasureCount(), `${order}: a change here`).toBeGreaterThan(before);
      expect(savedZip(), `${order}: the new ZIP, really saved, is seen`).toBe('10001');
      expect(entryTag(), `${order}: and the new tag`).toBe(NEW_TAG);
    }
  } finally {
    off();
  }
});

/* An erase on this page that leaves a key behind (check 5, 2026-11-19): what
   is left is not used here until a new value is written. */
test('an erase that leaves the ZIP behind: this tab does not read it, until a new one is saved', () => {
  const store = (window as unknown as { localStorage: Record<string, (...a: string[]) => unknown> }).localStorage;
  const { removeItem } = store;
  data.clear();
  setPrefs({ zip: '78501' });
  ensureEntryTag();
  store.removeItem = (k: string) => {
    if (k === 'oravan.prefs') throw new Error('refused');
    data.delete(k);
  };
  try {
    expect(eraseAll()).toBe(false);
    expect(data.get('oravan.prefs'), 'still stored').toBe(JSON.stringify({ zip: '78501' }));
    expect(savedZip(), 'but not read here').toBeNull();
    expect(data.has('oravan.entry'), 'the tag went').toBe(false);
    setPrefs({ zip: '10001' });
    expect(savedZip(), 'a new ZIP is read').toBe('10001');
  } finally {
    store.removeItem = removeItem;
  }
});

/* Storage that stops answering mid-visit, after it held ours (check 5,
   2026-11-19): the tab cannot confirm what is saved. It says so to its
   readers (the erase control stays), counts it as a change (the members go),
   and an erase there is not whole. */
test('storage that stops answering after it held ours: lost, a change, and no whole erase', async () => {
  const store = (window as unknown as { localStorage: Record<string, (...a: string[]) => unknown> }).localStorage;
  const { getItem, removeItem } = store;
  data.clear();
  expect(eraseAll(), 'start clean').toBe(true);
  expect(storeLost()).toBe(false);
  setPrefs({ zip: '78501' });
  expect(savedZip()).toBe('78501');
  let redraws = 0;
  const off = subscribe(() => redraws++);
  store.getItem = () => {
    throw new Error('blocked');
  };
  store.removeItem = () => {
    throw new Error('blocked');
  };
  try {
    const before = erasureCount();
    expect(savedZip(), 'nothing can be read').toBeNull();
    expect(storeLost(), 'and that is not "nothing saved"').toBe(true);
    await Promise.resolve(); // the change is told after the read, never during it
    expect(erasureCount(), 'what was shown goes').toBe(before + 1);
    expect(redraws).toBeGreaterThan(0);
    expect(eraseAll(), 'no whole erase').toBe(false);
    expect(storeLost(), 'still unconfirmed').toBe(true);
    store.getItem = getItem;
    expect(savedZip(), 'readable again: still not used until written').toBeNull();
  } finally {
    off();
    store.getItem = getItem;
    store.removeItem = removeItem;
  }
  setPrefs({ zip: '10001' });
  expect(storeLost(), 'a write that succeeds is a store that answers').toBe(false);
  expect(savedZip()).toBe('10001');
});

/* The whole store cleared elsewhere, then a ZIP saved there, the clear's
   event arriving last: the ZIP storage holds is read. */
test('another tab clears the store and saves a ZIP; the clear is heard last: the ZIP is read', () => {
  const off = subscribe(() => {});
  try {
    data.clear();
    eraseAll();
    data.set('oravan.prefs', JSON.stringify({ zip: '10001' }));
    const before = erasureCount();
    fire('storage', { key: null, oldValue: null, newValue: null });
    expect(erasureCount()).toBe(before + 1);
    expect(savedZip()).toBe('10001');
  } finally {
    off();
  }
});

/* An erase that is the first to find the store unreadable says so too. */
test('storage blocked after it held ours, found by the erase itself: lost, and a new tag is read', () => {
  const store = (window as unknown as { localStorage: Record<string, (...a: string[]) => unknown> }).localStorage;
  const { getItem, removeItem } = store;
  data.clear();
  expect(eraseAll(), 'start clean').toBe(true);
  setPrefs({ zip: '78501' }); // written, never read back
  store.getItem = () => {
    throw new Error('blocked');
  };
  store.removeItem = () => {
    throw new Error('blocked');
  };
  try {
    expect(eraseAll()).toBe(false);
    expect(storeLost()).toBe(true);
    store.getItem = getItem;
    // Dead in this tab until written: a new tag written here is read.
    expect(entryTag()).toBeNull();
    const tag = ensureEntryTag();
    expect(entryTag()).toBe(tag);
  } finally {
    store.getItem = getItem;
    store.removeItem = removeItem;
  }
  data.clear();
  expect(eraseAll()).toBe(true);
});

/* A whole erase starts this tab afresh: what an earlier, unfinished one
   left dead here is not dead after it. A ZIP saved later where no event
   reached this page (it slept in the back/forward cache) is read. */
test('a whole erase after an unfinished one: a ZIP saved later is read', () => {
  const store = (window as unknown as { localStorage: Record<string, (...a: string[]) => unknown> }).localStorage;
  const { getItem, removeItem } = store;
  const off = subscribe(() => {});
  try {
    data.clear();
    setPrefs({ zip: '78501' });
    store.getItem = () => {
      throw new Error('blocked');
    };
    store.removeItem = () => {
      throw new Error('blocked');
    };
    expect(eraseAll(), 'blocked: unfinished').toBe(false);
    store.getItem = getItem;
    store.removeItem = removeItem;
    expect(eraseAll(), 'unblocked: whole').toBe(true);
    data.set('oravan.prefs', JSON.stringify({ zip: '10001' }));
    fire('pageshow', { persisted: true });
    expect(savedZip()).toBe('10001');
  } finally {
    store.getItem = getItem;
    store.removeItem = removeItem;
    off();
  }
});

/* The tag a page makes is one it has read (check 5, 2026-11-19): erase and
   another lookup elsewhere, with no event reaching this page, is a change on
   its return, though the saved ZIP did not change. */
test('a tag made here, then replaced elsewhere: a change when the page comes back', () => {
  const off = subscribe(() => {});
  try {
    data.clear();
    eraseAll();
    const tag = ensureEntryTag(); // made here; this page read nothing else
    data.set('oravan.entry', 'fedcba9876543210fedcba9876543210');
    expect(tag).not.toBe('fedcba9876543210fedcba9876543210');
    const before = erasureCount();
    fire('focus', {});
    expect(erasureCount()).toBe(before + 1);
  } finally {
    off();
  }
});

test('storage that stops answering: no whole erase if it held ours (read or written), a whole one if it never did', () => {
  const store = (window as unknown as { localStorage: Record<string, (...a: string[]) => unknown> }).localStorage;
  const { removeItem, getItem } = store;
  const block = () => {
    store.removeItem = () => {
      throw new Error('blocked');
    };
    store.getItem = () => {
      throw new Error('blocked');
    };
  };
  const unblock = () => {
    store.removeItem = removeItem;
    store.getItem = getItem;
  };
  try {
    // Held ours by a read (another tab saved it): no whole erase.
    data.clear();
    expect(eraseAll(), 'start clean').toBe(true);
    data.set('oravan.prefs', JSON.stringify({ zip: '20001' }));
    expect(savedZip()).toBe('20001');
    block();
    expect(eraseAll(), 'read here, then blocked').toBe(false);
    unblock();

    // Held ours by a write here: no whole erase.
    data.clear();
    expect(eraseAll(), 'start clean').toBe(true);
    ensureEntryTag();
    block();
    expect(eraseAll(), 'written here, then blocked').toBe(false);
    unblock();

    // Held ours by a preferences write here (never read back): no whole erase.
    data.clear();
    expect(eraseAll(), 'start clean').toBe(true);
    setPrefs({ zip: '20001' });
    block();
    expect(eraseAll(), 'preferences written here, then blocked').toBe(false);
    unblock();

    // Never held anything of ours (blocked from the start): a whole erase.
    data.clear();
    expect(eraseAll(), 'start clean').toBe(true);
    block();
    expect(eraseAll(), 'blocked from the start').toBe(true);
  } finally {
    unblock();
  }
});

/*
 * CHECK 6 (2026-11-20). An erase revokes only what this tab had read: the
 * reviewer's case, events reversed, the same ZIP saved again from the home
 * page and no new tag. This tab reads nothing between the events (its
 * subscriber does not read), so the ZIP storage holds is read afterwards. A
 * tab that reads between them is the next test.
 */
test('another tab erases and saves the same ZIP again, no new tag, events reversed, nothing read between them: the ZIP is read', () => {
  const P78 = JSON.stringify({ zip: '78501' });
  const TAG = '0123456789abcdef0123456789abcdef';
  const off = subscribe(() => {});
  try {
    data.clear();
    eraseAll();
    for (const [k, v] of [['oravan.prefs', P78], ['oravan.entry', TAG], ['oravan.calls', '[]'], ['oravan.reads', '[]']]) data.set(k, v);
    expect(savedZip()).toBe('78501');
    expect(entryTag()).toBe(TAG);
    // Elsewhere: the erase (tag first), then the same ZIP saved again.
    for (const k of ['oravan.entry', 'oravan.prefs', 'oravan.calls', 'oravan.reads']) data.delete(k);
    data.set('oravan.prefs', P78);
    const events = [
      { key: 'oravan.entry', oldValue: TAG, newValue: null },
      { key: 'oravan.prefs', oldValue: P78, newValue: null },
      { key: 'oravan.calls', oldValue: '[]', newValue: null },
      { key: 'oravan.reads', oldValue: '[]', newValue: null },
      { key: 'oravan.prefs', oldValue: null, newValue: P78 },
    ];
    for (const e of [...events].reverse()) fire('storage', e);
    doc.visibilityState = 'visible';
    fireDoc('visibilitychange');
    fire('focus', {});
    expect(savedZip()).toBe('78501');
  } finally {
    off();
  }
});

/*
 * CHECK 7 (2026-11-21). The same case in a tab that reads on every event, as
 * a page on screen does: its subscriber reads the ZIP and the tag. What the
 * code does, and no more:
 *
 *   - events in the order they happened: the ZIP saved again is read;
 *   - events reversed (the tag's removal heard last): this tab has read the
 *     ZIP saved again by then, the erase revokes it with the rest, and it
 *     stays hidden here until the ZIP is written again, in this tab or in
 *     another. Hidden, never an erased ZIP shown.
 */
test('the same in a tab that reads on every event: in order the ZIP is read; reversed it stays hidden until it is written again', () => {
  const P78 = JSON.stringify({ zip: '78501' });
  const TAG = '0123456789abcdef0123456789abcdef';
  const events = [
    { key: 'oravan.entry', oldValue: TAG, newValue: null },
    { key: 'oravan.prefs', oldValue: P78, newValue: null },
    { key: 'oravan.calls', oldValue: '[]', newValue: null },
    { key: 'oravan.reads', oldValue: '[]', newValue: null },
    { key: 'oravan.prefs', oldValue: null, newValue: P78 },
  ];
  /** The erase elsewhere and the same ZIP saved again, heard here in `order`. */
  const hear = (order: typeof events) => {
    data.clear();
    eraseAll();
    for (const [k, v] of [['oravan.prefs', P78], ['oravan.entry', TAG], ['oravan.calls', '[]'], ['oravan.reads', '[]']]) data.set(k, v);
    expect(savedZip()).toBe('78501');
    expect(entryTag()).toBe(TAG);
    for (const k of ['oravan.entry', 'oravan.prefs', 'oravan.calls', 'oravan.reads']) data.delete(k);
    data.set('oravan.prefs', P78);
    for (const e of order) fire('storage', e);
    doc.visibilityState = 'visible';
    fireDoc('visibilitychange');
    fire('focus', {});
  };
  const off = subscribe(() => {
    savedZip();
    entryTag();
  });
  try {
    hear(events);
    expect(savedZip(), 'in order').toBe('78501');
    expect(entryTag(), 'in order: the erased tag is not read').toBeNull();

    hear([...events].reverse());
    expect(savedZip(), 'reversed: hidden').toBeNull();
    expect(entryTag(), 'reversed: the erased tag is not read').toBeNull();
    // Written again in another tab: read.
    fire('storage', { key: 'oravan.prefs', oldValue: P78, newValue: P78 });
    expect(savedZip(), 'reversed, then written again elsewhere').toBe('78501');

    hear([...events].reverse());
    expect(savedZip(), 'reversed: hidden').toBeNull();
    // Written again in this tab: read.
    setPrefs({ zip: '78501' });
    expect(savedZip(), 'reversed, then written again here').toBe('78501');
  } finally {
    off();
  }
});

/* This tab's own change of ZIP is what it has read: a return is no change. */
test('this tab saves another ZIP: coming back into focus is not a change', () => {
  const off = subscribe(() => {});
  try {
    data.clear();
    eraseAll();
    setPrefs({ zip: '78501' });
    expect(savedZip()).toBe('78501');
    setPrefs({ zip: '10001' }); // the members page's own "Change ZIP code"
    const before = erasureCount();
    fire('focus', {});
    fire('pageshow', { persisted: true });
    expect(erasureCount()).toBe(before);
    expect(savedZip()).toBe('10001');
  } finally {
    off();
  }
});

/* A write the browser refused and does not keep is not something read. */
test('a refused write of the calls is not taken as read: a return is no change', () => {
  const store = (window as unknown as { localStorage: Record<string, (...a: string[]) => unknown> }).localStorage;
  const { setItem } = store;
  const off = subscribe(() => {});
  try {
    data.clear();
    eraseAll();
    store.setItem = (k: string, v: string) => {
      if (k === 'oravan.calls') throw new Error('full');
      data.set(k, v);
    };
    upsertCall({ billSlug: 'hr-1-119', billLabel: 'A bill', repBioguide: 'X000001', repName: 'A member', stance: 'support', outcome: 'voicemail', at: '2026-11-20T15:00:00.000Z' });
    const before = erasureCount();
    fire('focus', {});
    expect(erasureCount()).toBe(before);
  } finally {
    store.setItem = setItem;
    off();
  }
});

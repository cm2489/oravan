import { expect, test } from '@playwright/test';
import { eraseAll, savedZip, setPrefs } from '../lib/local';

/*
 * STORAGE BLOCKED: THE ZIP STILL CROSSES THE VISIT (2026-11-12).
 *
 * Safari set to block all cookies and website data makes every localStorage
 * call throw. Since the members page stopped reading the ZIP from its
 * address (owner, 2026-11-12), a ZIP typed on the home page reaches /reps
 * only through lib/local.ts, so a refused write must be kept in memory for
 * the visit (and nowhere else). These tests drive the module with a stand-in
 * `window` whose storage can be switched off, no browser needed;
 * tests/reps-zip-address.spec.ts does the same in WebKit.
 */

class Store {
  blocked = false;
  data = new Map<string, string>();
  private check() {
    if (this.blocked) throw new DOMException('The operation is insecure.', 'SecurityError');
  }
  getItem(k: string) {
    this.check();
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.check();
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.check();
    this.data.delete(k);
  }
}

function useStore(): Store {
  const store = new Store();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: store,
    addEventListener() {},
    removeEventListener() {},
  };
  eraseAll(); // a clean module: no write kept from an earlier test in this worker
  return store;
}

test.afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

test('a refused write is kept for the visit: the saved ZIP still reads back', () => {
  const store = useStore();
  store.blocked = true;
  setPrefs({ zip: '78501' });
  expect(savedZip()).toBe('78501');
  expect(store.data.size, 'nothing reached storage').toBe(0);
});

test('once storage takes a write again, memory lets go of it', () => {
  const store = useStore();
  store.blocked = true;
  setPrefs({ zip: '78501' });
  store.blocked = false;
  setPrefs({ zip: '10001' });
  expect(JSON.parse(store.data.get('oravan.prefs') ?? 'null')).toEqual({ zip: '10001' });
  // Block it again: the stored value is out of reach and memory holds nothing,
  // so nothing is read. Memory had let go.
  store.blocked = true;
  expect(savedZip()).toBeNull();
});

test('erasing clears what memory kept, too', () => {
  const store = useStore();
  store.blocked = true;
  setPrefs({ zip: '78501' });
  eraseAll();
  expect(savedZip()).toBeNull();
});

test('storage that works is read as before, and memory is never consulted', () => {
  const store = useStore();
  store.data.set('oravan.prefs', JSON.stringify({ zip: '20001' }));
  expect(savedZip()).toBe('20001');
});

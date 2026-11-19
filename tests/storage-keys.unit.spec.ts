import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { ERASED_KEYS, eraseAll } from '../lib/local';

/*
 * EVERY KEY THE SITE CAN WRITE IN THE BROWSER, AND WHAT AN ERASE DOES TO IT
 * (2026-11-18, hardened 2026-11-19).
 *
 * "Erase everything" is a promise about keys. Every key is named once, in
 * lib/storage-keys.ts, and this test holds the code that runs in the browser
 * (app/, components/, lib/, i18n/) to that:
 *
 *   - only three files may touch the browser's storage at all, and only
 *     through `window.localStorage.getItem|setItem|removeItem(NAME…)`, where
 *     NAME is one of lib/storage-keys.ts's constants or a parameter that
 *     lib/local.ts types as one (TypeScript holds those to the same names);
 *   - a key written as a literal, a template or built from parts fails, and
 *     so does any other way in: `sessionStorage`, IndexedDB, the cache API,
 *     cookies, bracket access, a second name for the store
 *     (`const s = window.localStorage`), or the word "Storage" in a string
 *     (`window['local' + 'Storage']`);
 *   - every name in lib/storage-keys.ts is either erased (ERASED_KEYS) or
 *     kept for a reason written below, and nothing else.
 *
 * WHAT STILL GETS PAST IT: code that hides its intent on purpose, such as the
 * store's name split into smaller pieces ('Stor' + 'age'), `eval`, or
 * `Reflect.get(window, …)`; code outside the four folders read here
 * (public/, scripts/, server-only routes, which never run in a visitor's
 * browser); and other browser stores reached by a name this test does not
 * list. It is a guard against mistakes, not against someone hiding a key.
 *
 * KEPT, WITH THE REASON RECORDED WHERE THE KEY IS USED: two keys hold chrome,
 * not the civic record, and an erase leaves them on purpose. `impact.erased`
 * ("All local data erased.") is therefore not literally true of them; the
 * owner rewords that sentence, not this code (PR #521).
 */
const KEPT: Record<string, string> = {
  'oravan.locale.chosen':
    'lib/locale-pref.ts, "WHY IT IS NOT IN lib/local\'s Prefs": a language choice is chrome, not civic record; erasing it would flip the site back for the visitor who chose Spanish',
  'oravan.esNote.dismissed':
    'components/LocalePreferenceNote.tsx: erasing it would bring back the "¿Prefieres español?" note for the visitor who asked it to go away',
};

const KEYS_FILE = 'lib/storage-keys.ts';
/** The only files allowed to call the browser's storage. */
const STORAGE_FILES = ['lib/local.ts', 'lib/locale-pref.ts', 'components/LocalePreferenceNote.tsx'];
/**
 * Parameters lib/local.ts passes as a key, each typed as a StorageKey there:
 * `key` (read, write, the erase's loop) and `newKey` (the one-time migration
 * from the pre-rename names). `oldKey` is that migration's pre-rename name:
 * read once and removed, never written (only removeItem/getItem may take it).
 */
const TYPED_PARAMS: Record<string, readonly string[]> = {
  'lib/local.ts': ['key', 'newKey', 'oldKey'],
};
/** Identifiers that contain "Storage" and are not a way into it. */
const STORAGE_WORDS = new Set(['localStorage', 'StorageEvent', 'StorageKey', 'noteStorageEvent', 'lastStorageEvent', 'onStorage']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}

const FILES = ['app', 'components', 'lib', 'i18n'].flatMap(sources);
/** The code with its comments removed (a `//` inside a string is left alone). */
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
/** The bodies of the string literals in `src`: '…', "…" and `…`. */
const literals = (src: string) => [...src.matchAll(/'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\])*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]);

/** The names lib/storage-keys.ts exports, with their values. */
function keyConstants(): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of code(KEYS_FILE).matchAll(/export const ([A-Z_]+) = '([^']*)';/g)) names.set(m[1], m[2]);
  return names;
}

test('only the three named files reach the browser\'s storage, and by no other way', () => {
  const ways = /\b(localStorage|sessionStorage|indexedDB|caches)\b|document\s*\.\s*cookie|cookieStore/;
  const touching = FILES.filter((f) => ways.test(code(f)));
  expect(touching.sort(), 'files that reach a browser store').toEqual([...STORAGE_FILES].sort());
  for (const f of FILES) {
    const src = code(f);
    expect(src, `${f}: sessionStorage, IndexedDB, the cache API or cookies`).not.toMatch(/\b(sessionStorage|indexedDB|caches)\b|document\s*\.\s*cookie|cookieStore/);
    expect(literals(src).filter((s) => /Storage/.test(s)), `${f}: the store's name in a string`).toEqual([]);
  }
});

test('every storage call names a key constant: no literal, template, built or aliased key', () => {
  const constants = keyConstants();
  for (const f of STORAGE_FILES) {
    const src = code(f);
    const params = TYPED_PARAMS[f] ?? [];
    // Every identifier with "Storage" in it is a known one.
    const words = [...src.matchAll(/\b\w*Storage\w*\b/g)].map((m) => m[0]);
    expect(words.filter((w) => !STORAGE_WORDS.has(w)), `${f}: another name for a store`).toEqual([]);
    // Every use of the store is a direct call with a named key.
    const uses = [...src.matchAll(/localStorage/g)].map((m) => src.slice(m.index! - 7, m.index! + 80));
    for (const use of uses) {
      const call = /^window\.localStorage\.(getItem|setItem|removeItem)\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/.exec(use);
      expect(call, `${f}: a use of the store that is not a named call:\n${use}`).not.toBeNull();
      const [, method, arg] = call!;
      const named = constants.has(arg) || params.includes(arg);
      expect(named, `${f}: ${method}(${arg}) does not name a key constant`).toBe(true);
      if (arg === 'oldKey') expect(method, 'the pre-rename name is never written').not.toBe('setItem');
    }
  }
  // lib/local.ts's key parameters are typed as StorageKey, so TypeScript holds
  // them to the same names.
  const local = code('lib/local.ts');
  expect(local).toMatch(/function read\(key: StorageKey\)/);
  expect(local).toMatch(/function write\(key: StorageKey,/);
  expect(local).toMatch(/const LEGACY: Record<string, StorageKey>/);
  expect(code(KEYS_FILE)).toMatch(/export const ERASED_KEYS: readonly StorageKey\[\]/);
});

test('every key is erased or kept with a reason, and named in one place only', () => {
  const constants = keyConstants();
  const values = [...constants.values()];
  expect(new Set(values).size, 'two names for one key').toBe(values.length);
  const accounted = new Set([...ERASED_KEYS, ...Object.keys(KEPT)]);
  expect(values.filter((k) => !accounted.has(k)), 'a key with no decision').toEqual([]);
  expect([...accounted].filter((k) => !values.includes(k)), 'a decision for a key that is gone').toEqual([]);
  expect(ERASED_KEYS[0], 'the history tag goes first').toBe('oravan.entry');
  for (const k of Object.keys(KEPT)) expect(ERASED_KEYS).not.toContain(k);
  // The key file holds key names and nothing else; no other file spells one.
  expect(literals(code(KEYS_FILE)).sort()).toEqual([...values].sort());
  for (const f of FILES.filter((x) => x !== KEYS_FILE)) {
    expect(literals(code(f)).filter((s) => /^oravan\./.test(s)), `${f}: a key spelled outside ${KEYS_FILE}`).toEqual([]);
  }
});

test('the erase removes exactly ERASED_KEYS, and leaves the kept keys', () => {
  const data = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
    addEventListener() {},
    removeEventListener() {},
  };
  try {
    for (const k of [...ERASED_KEYS, ...Object.keys(KEPT)]) data.set(k, 'x');
    expect(eraseAll()).toBe(true);
    expect([...data.keys()].sort()).toEqual(Object.keys(KEPT).sort());
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

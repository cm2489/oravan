import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { ERASED_KEYS, eraseAll } from '../lib/local';

/*
 * EVERY KEY THE SITE CAN WRITE IN THE BROWSER, AND WHAT AN ERASE DOES TO IT
 * (2026-11-18).
 *
 * "Erase everything" is a promise about keys. This test reads every source
 * file the browser can run (app, components, lib, i18n) and finds every
 * storage key in it, so a new key fails here until it is either erased
 * (lib/local.ts ERASED_KEYS) or named below, with its reason, as kept.
 *
 * KEPT, WITH THE REASON RECORDED WHERE THE KEY LIVES: two keys hold chrome,
 * not the civic record, and an erase leaves them on purpose. Note that
 * `impact.erased` ("All local data erased.") is therefore not literally true
 * of them; the owner rewords that sentence, not this code (PR #521).
 */
const KEPT: Record<string, string> = {
  'oravan.locale.chosen':
    'lib/locale-pref.ts, "WHY IT IS NOT IN lib/local\'s Prefs": a language choice is chrome, not civic record; erasing it would flip the site back for the visitor who chose Spanish',
  'oravan.esNote.dismissed':
    'components/LocalePreferenceNote.tsx: erasing it would bring back the "¿Prefieres español?" note for the visitor who asked it to go away',
};

/*
 * Not counted here: the pre-rename keys lib/local.ts migrates (its LEGACY
 * map), which are read once on the first page load and removed, never
 * written, and whose names the naming gate keeps out of this file.
 */

/** The only files allowed to call the browser's storage. */
const STORAGE_FILES = ['lib/local.ts', 'lib/locale-pref.ts', 'components/LocalePreferenceNote.tsx'];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}

const FILES = ['app', 'components', 'lib', 'i18n'].flatMap(sources);
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('only the known files touch the browser\'s storage', () => {
  const touching = FILES.filter((f) => /\b(localStorage|sessionStorage|indexedDB)\b|document\.cookie/.test(code(f)));
  expect(touching.sort()).toEqual([...STORAGE_FILES].sort());
  // sessionStorage, IndexedDB and cookies: none, anywhere.
  for (const f of FILES) expect(code(f), f).not.toMatch(/\bsessionStorage\b|\bindexedDB\b|document\.cookie/);
});

test('every storage key in the code is erased or kept with a reason', () => {
  const found = new Set<string>();
  for (const f of STORAGE_FILES) {
    for (const m of code(f).matchAll(/['"`](oravan\.[A-Za-z.]+)['"`]/g)) found.add(m[1]);
  }
  const accounted = new Set([...ERASED_KEYS, ...Object.keys(KEPT)]);
  expect([...found].filter((k) => !accounted.has(k)), 'a key with no decision').toEqual([]);
  expect([...accounted].filter((k) => !found.has(k)), 'a decision for a key the code no longer has').toEqual([]);
  expect(ERASED_KEYS).toContain('oravan.entry');
  for (const k of Object.keys(KEPT)) expect(ERASED_KEYS).not.toContain(k);
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
    eraseAll();
    expect([...data.keys()].sort()).toEqual(Object.keys(KEPT).sort());
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

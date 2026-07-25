'use client';

/*
 * All personal data lives HERE, in the visitor's browser. Oravan has no
 * accounts and no server-side user storage - nothing to breach, nothing
 * to subpoena. Clearing browser data (or the Impact page's delete button)
 * erases everything.
 */

import { useSyncExternalStore } from 'react';
import type { CallOutcome, Stance } from './types';

export interface Prefs {
  zip?: string;
  interests?: string[];
}

export interface CallRecord {
  billSlug: string;
  billLabel: string;
  repBioguide: string;
  repName: string;
  stance: Stance;
  outcome: CallOutcome;
  at: string; // ISO timestamp
}

const PREFS_KEY = 'oravan.prefs';
const CALLS_KEY = 'oravan.calls';

// One-time migration from the test-phase names so early testers keep their
// ZIP, interests, and call history across the renames. The legacy literals
// below are founder-exempted from the naming gate (docs/migration/decisions.md
// M2): purging them would silently wipe pre-rename testers' data.
const LEGACY = {
  'cabina.prefs': PREFS_KEY,
  'cabina.calls': CALLS_KEY,
  'rostra.prefs': PREFS_KEY,
  'rostra.calls': CALLS_KEY,
} as const;
if (typeof window !== 'undefined') {
  try {
    for (const [oldKey, newKey] of Object.entries(LEGACY)) {
      const v = window.localStorage.getItem(oldKey);
      if (v !== null && window.localStorage.getItem(newKey) === null) {
        window.localStorage.setItem(newKey, v);
      }
      if (v !== null) window.localStorage.removeItem(oldKey);
    }
  } catch {
    /* storage blocked - nothing to migrate */
  }
}

const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener('storage', cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', cb);
  };
}

function notify() {
  for (const cb of listeners) cb();
}

function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked (private mode) - degrade silently.
  }
  notify();
}

/**
 * Snapshot cache so useSyncExternalStore gets referentially-stable values.
 *
 * `isValid` is not optional politeness — it is the only thing standing between
 * a malformed entry and a blank page. JSON.parse's try/catch catches *syntax*
 * errors, but `null`, `5`, `"x"` and `{}` are all syntactically valid JSON that
 * sailed through the `as T` cast into every consumer. A single
 * `localStorage.setItem('oravan.prefs', 'null')` was enough to throw in
 * ZipForm and unmount the whole tree — and localStorage is the only persistence
 * this product has, so this layer has to be total.
 */
function makeSnapshot<T>(key: string, fallback: T, isValid: (v: unknown) => boolean) {
  let cache: { raw: string | null; value: T } | null = null;
  return () => {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      /* blocked */
    }
    if (!cache || cache.raw !== raw) {
      let value = fallback;
      try {
        const parsed = raw ? JSON.parse(raw) : fallback;
        value = isValid(parsed) ? (parsed as T) : fallback;
      } catch {
        /* corrupted entry */
      }
      cache = { raw, value };
    }
    return cache.value;
  };
}

const EMPTY_PREFS: Prefs = {};
const EMPTY_CALLS: CallRecord[] = [];
const isPlainObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
const prefsSnapshot = makeSnapshot<Prefs>(PREFS_KEY, EMPTY_PREFS, isPlainObject);
const callsSnapshot = makeSnapshot<CallRecord[]>(CALLS_KEY, EMPTY_CALLS, Array.isArray);

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, prefsSnapshot, () => EMPTY_PREFS);
}

export function useCalls(): CallRecord[] {
  return useSyncExternalStore(subscribe, callsSnapshot, () => EMPTY_CALLS);
}

export const setPrefs = (p: Partial<Prefs>) => write(PREFS_KEY, { ...prefsSnapshot(), ...p });

/** One record per (bill, rep): re-logging updates the outcome instead of appending a duplicate. */
export function upsertCall(c: CallRecord) {
  const rest = callsSnapshot().filter(
    (r) => !(r.billSlug === c.billSlug && r.repBioguide === c.repBioguide)
  );
  write(CALLS_KEY, [c, ...rest]);
}

export function removeCall(at: string) {
  write(CALLS_KEY, callsSnapshot().filter((r) => r.at !== at));
}

export function eraseAll() {
  try {
    window.localStorage.removeItem(PREFS_KEY);
    window.localStorage.removeItem(CALLS_KEY);
  } catch {
    /* nothing to erase */
  }
  notify();
}

'use client';

/*
 * All personal data lives HERE, in the visitor's browser. Oravan has no
 * accounts and no server-side user storage - nothing to breach, nothing
 * to subpoena. Clearing browser data (or the civic record page's delete
 * button) erases everything.
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

/**
 * One row of the reading history — what the civic record shows above the
 * calls. Deliberately the thinnest thing that can render a link: a slug, the
 * label to print, and when. No scroll depth, no dwell time, no referrer;
 * "which bills did I look at" is already sensitive enough that anything
 * richer would have to justify itself, and nothing here needs it.
 */
export interface ReadRecord {
  billSlug: string;
  billLabel: string;
  at: string; // ISO timestamp
}

const PREFS_KEY = 'oravan.prefs';
const CALLS_KEY = 'oravan.calls';
const READS_KEY = 'oravan.reads';

/** The reading history is capped: past this many bills the oldest row falls
 *  off. A visitor who reads for a year should not carry an unbounded list in
 *  a quota-limited store — and the far tail of it is of no use to them. */
const READS_CAP = 100;

// One-time migration from the test-phase names so early testers keep their
// ZIP, interests, and call history across the renames. The legacy literals
// below are founder-exempted from the naming gate (docs/migration/decisions.md
// M2): purging them would silently wipe pre-rename testers' data.
// READS_KEY is deliberately absent: `oravan.reads` was born under this name,
// so it has no pre-rename generation to inherit from.
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
const EMPTY_READS: ReadRecord[] = [];
const isPlainObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
const prefsSnapshot = makeSnapshot<Prefs>(PREFS_KEY, EMPTY_PREFS, isPlainObject);
const callsSnapshot = makeSnapshot<CallRecord[]>(CALLS_KEY, EMPTY_CALLS, Array.isArray);
const readsSnapshot = makeSnapshot<ReadRecord[]>(READS_KEY, EMPTY_READS, Array.isArray);

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, prefsSnapshot, () => EMPTY_PREFS);
}

export function useCalls(): CallRecord[] {
  return useSyncExternalStore(subscribe, callsSnapshot, () => EMPTY_CALLS);
}

export function useReads(): ReadRecord[] {
  return useSyncExternalStore(subscribe, readsSnapshot, () => EMPTY_READS);
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

/**
 * One record per bill, newest `at` wins: re-reading a bill moves it back to
 * the top of the list instead of appending a second row (the `upsertCall`
 * rule, one key narrower). The comparison is explicit rather than assumed —
 * a caller with a stale clock, or a tab restored from bfcache, must not be
 * able to make an old visit look like the most recent one.
 *
 * The list is newest-first, so the cap drops from the tail: the oldest read
 * is the one that falls off.
 */
export function upsertRead(r: ReadRecord) {
  const current = readsSnapshot();
  const prior = current.find((x) => x.billSlug === r.billSlug);
  const kept = prior && prior.at > r.at ? prior : r;
  const rest = current.filter((x) => x.billSlug !== r.billSlug);
  write(READS_KEY, [kept, ...rest].slice(0, READS_CAP));
}

export function removeRead(billSlug: string) {
  write(READS_KEY, readsSnapshot().filter((r) => r.billSlug !== billSlug));
}

/**
 * ERASE COMPLETENESS. Every key this module writes is removed here — that is
 * the whole promise the privacy page and `impact.eraseConfirm` make out loud,
 * so a new store is not finished until its key is on this list and named in
 * both locales' confirm string.
 */
export function eraseAll() {
  try {
    window.localStorage.removeItem(PREFS_KEY);
    window.localStorage.removeItem(CALLS_KEY);
    window.localStorage.removeItem(READS_KEY);
  } catch {
    /* nothing to erase */
  }
  notify();
}

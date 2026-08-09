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

/**
 * The page a stored record's slug points at.
 *
 * `billSlug` STOPPED BEING BILLS-ONLY when nominations got a call rail:
 * components/ActionPanel.tsx logs an outcome on a nomination page with the
 * nomination's own `pn-…` slug in that field, and /record linked every row to
 * `/bills/<slug>` — a guaranteed 404, reached from the reader's own civic
 * record, on the page whose entire job is to show them their work was real.
 *
 * READ, DON'T STORE. The alternative was a `kind` field on the record, and it
 * was rejected: every row already written — every call any beta reader has
 * logged on a nomination — carries no such field, so a stored discriminator
 * would need a default, the default would have to be `bill`, and the existing
 * broken rows would stay broken forever. The prefix is not a heuristic; it is
 * an enforced namespace. scripts/nominations-fetch.mjs's nominationSlug()
 * emits `pn-` on every nomination and congress-fetch.mjs's slugOf() emits
 * `hr-`/`s-`/`hjres-`/`sjres-`/`hconres-`/`sconres-` on every bill — a
 * disjointness both corpora are swept for (tests/nomination-status.unit.spec.ts
 * asserts it over all 878 records). So the prefix answers this exactly, for
 * rows written before this function existed as well as after.
 *
 * The field keeps its name. Renaming it would orphan every stored row for a
 * cosmetic gain; the name is a historical fact about the schema, and this
 * comment is where that is written down.
 */
export function recordHref(slug: string): string {
  return slug.startsWith('pn-') ? `/nominations/${slug}` : `/bills/${slug}`;
}

export interface CallRecord {
  /** The vehicle's slug — a bill slug OR a `pn-…` nomination slug. Route it
   *  with recordHref() above, never by hardcoding `/bills/`. */
  billSlug: string;
  /** The label in the locale the interaction happened in — and the only
   *  label rows written before 2026-08 carry (render fallback). */
  billLabel: string;
  /** Both locales' labels, captured AT WRITE TIME from the bill page's own
   *  server-rendered data — so /es/record can print the Spanish headline for
   *  a call logged on the English page WITHOUT ever fetching the record's
   *  contents over the network (the record never leaves this device, and a
   *  render-time lookup request would leak exactly which bills it holds). */
  labelEn?: string;
  labelEs?: string;
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
  /** Same write-time bilingual pair as CallRecord — see that comment. */
  labelEn?: string;
  labelEs?: string;
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
 * `coerce` is not optional politeness — it is the only thing standing between
 * a malformed entry and a blank page. JSON.parse's try/catch catches *syntax*
 * errors, but `null`, `5`, `"x"` and `{}` are all syntactically valid JSON that
 * sailed through the `as T` cast into every consumer. A single
 * `localStorage.setItem('oravan.prefs', 'null')` was enough to throw in
 * ZipForm and unmount the whole tree — and localStorage is the only persistence
 * this product has, so this layer has to be total.
 *
 * IT COERCES RATHER THAN VALIDATES, and that distinction is the repair. A
 * boolean predicate can only accept or reject the stored value WHOLE, so the
 * list stores were guarded by `Array.isArray` alone: `[null]` was "valid", and
 * /record's own `calls.filter(c => c.outcome === 'contact')` threw on it and
 * took the page down — including the erase control that is the way out.
 * Tightening that to "reject the array unless every row is readable" would
 * only trade the crash for silent data loss: one interrupted write, and a
 * reader's entire civic record reads as empty. So the list coercers return the
 * rows they CAN read and drop the ones they cannot. `null` from a coercer
 * means "nothing salvageable here" — only then does the fallback apply.
 *
 * REFERENTIAL STABILITY SURVIVES THE CHANGE because this cache is keyed on the
 * RAW STRING, not on the parsed value: a filtered array is built once per
 * distinct stored string and handed back by identity on every call after. That
 * is a hard requirement of useSyncExternalStore, not a nicety — a getSnapshot
 * that returns a fresh array each time is an infinite render loop, which
 * presents as a hung page rather than as an error anyone can read.
 *
 * The repair is durable, not per-paint: every writer below builds its next
 * value from the snapshot, so the first write after a filtered read persists
 * the cleaned list and the unreadable row is gone from the device for good.
 */
function makeSnapshot<T>(key: string, fallback: T, coerce: (v: unknown) => T | null) {
  let cache: { raw: string | null; value: T } | null = null;
  return () => {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      /* blocked */
    }
    if (!cache || cache.raw !== raw) {
      // Nothing stored is not something to coerce: an absent key returns the
      // shared `fallback` constant itself, which is also what the server
      // snapshot returns — so hydration on a fresh device sees one identity
      // rather than two equal-but-distinct empty values.
      let value = fallback;
      if (raw !== null) {
        try {
          value = coerce(JSON.parse(raw)) ?? fallback;
        } catch {
          /* corrupted entry */
        }
      }
      cache = { raw, value };
    }
    return cache.value;
  };
}

const EMPTY_PREFS: Prefs = {};
const EMPTY_CALLS: CallRecord[] = [];
const EMPTY_READS: ReadRecord[] = [];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isOptionalString = (v: unknown) => v === undefined || typeof v === 'string';
/** `at` is rendered through `Intl` (`format.dateTime(new Date(at))`), which
 *  throws on a date it cannot parse — so "is a string" is not enough here.
 *  It is also the React key of every call row, hence the non-empty check. */
const isTimestamp = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v));

/* The two closed vocabularies, as exhaustive maps: adding a stance or an
   outcome to lib/types.ts without teaching this guard about it is a type
   error rather than a row that silently stops being readable. Both are
   written only by this app's own code, so a value outside them is damage, not
   a newer dialect. `Object.hasOwn`, never `in` — every object inherits
   `constructor` and `toString`, and either would sail through `in`. */
const STANCES: Record<Stance, true> = { support: true, oppose: true, undecided: true };
const OUTCOMES: Record<CallOutcome, true> = { contact: true, voicemail: true, unavailable: true };

/**
 * Row-level guards. Exported because they are the whole safety story of this
 * module and they are testable with no React and no window — see
 * tests/local.unit.spec.ts. They ask for exactly what /record dereferences and
 * nothing more: a row is kept if it can be rendered, not if it is pristine.
 */
export function isCallRecord(v: unknown): v is CallRecord {
  return (
    isPlainObject(v) &&
    typeof v.billSlug === 'string' &&
    v.billSlug.length > 0 &&
    typeof v.billLabel === 'string' &&
    isOptionalString(v.labelEn) &&
    isOptionalString(v.labelEs) &&
    typeof v.repBioguide === 'string' &&
    typeof v.repName === 'string' &&
    typeof v.stance === 'string' &&
    Object.hasOwn(STANCES, v.stance) &&
    typeof v.outcome === 'string' &&
    Object.hasOwn(OUTCOMES, v.outcome) &&
    isTimestamp(v.at)
  );
}

export function isReadRecord(v: unknown): v is ReadRecord {
  return (
    isPlainObject(v) &&
    typeof v.billSlug === 'string' &&
    v.billSlug.length > 0 &&
    typeof v.billLabel === 'string' &&
    isOptionalString(v.labelEn) &&
    isOptionalString(v.labelEs) &&
    isTimestamp(v.at)
  );
}

const sanitizeList =
  <T>(guard: (v: unknown) => v is T) =>
  (v: unknown): T[] | null =>
    Array.isArray(v) ? v.filter(guard) : null;

export const sanitizeCalls = sanitizeList(isCallRecord);
export const sanitizeReads = sanitizeList(isReadRecord);

/**
 * Prefs repairs its two known fields in place rather than rebuilding the
 * object, so an entry written by a newer build (a field this one has never
 * heard of) survives the round trip that `setPrefs`'s spread already promised
 * it would. A non-string `zip` or a non-array `interests` is dropped, and a
 * mixed `interests` array keeps its readable topics: BillsBrowser calls
 * `interests.includes()` during render, so a number there is the same class of
 * blank page as a `null` call row.
 */
export function sanitizePrefs(v: unknown): Prefs | null {
  if (!isPlainObject(v)) return null;
  const out: Record<string, unknown> = { ...v };
  if (typeof out.zip !== 'string') delete out.zip;
  if (Array.isArray(out.interests)) {
    out.interests = out.interests.filter((c) => typeof c === 'string');
  } else {
    delete out.interests;
  }
  return out as Prefs;
}

const prefsSnapshot = makeSnapshot<Prefs>(PREFS_KEY, EMPTY_PREFS, sanitizePrefs);
const callsSnapshot = makeSnapshot<CallRecord[]>(CALLS_KEY, EMPTY_CALLS, sanitizeCalls);
const readsSnapshot = makeSnapshot<ReadRecord[]>(READS_KEY, EMPTY_READS, sanitizeReads);

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

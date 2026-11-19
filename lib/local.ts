'use client';

/*
 * All personal data lives HERE, in the visitor's browser. Oravan has no
 * accounts and no server-side user storage - nothing to breach, nothing
 * to subpoena. Clearing browser data (or the civic record page's delete
 * button) erases everything.
 */

import { useSyncExternalStore } from 'react';
import type { CallOutcome, Stance } from './types';
import { CALLS_KEY, ENTRY_TAG_KEY, ERASED_KEYS, PREFS_KEY, READS_KEY, type StorageKey } from './storage-keys';

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

// Every key lives in lib/storage-keys.ts (tests/storage-keys.unit.spec.ts
// holds every storage call to those names); ERASED_KEYS is what an erase
// removes, the history tag first.
export { ERASED_KEYS };
const isErasedKey = (key: string): key is StorageKey => (ERASED_KEYS as readonly string[]).includes(key);

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
} as const satisfies Record<string, StorageKey>;
type LegacyKey = keyof typeof LEGACY;

/*
 * THE ONLY WAY INTO THE STORE FROM THIS MODULE (2026-11-19). Every read, write
 * and removal goes through these three, typed so that TypeScript refuses any
 * key that is not a named one (lib/storage-keys.ts) or a pre-rename name being
 * migrated away; tests/storage-keys.unit.spec.ts holds this module to them.
 * They throw when the browser refuses storage, as the store itself does.
 */
function storeGet(key: StorageKey | LegacyKey): string | null {
  return window.localStorage.getItem(key);
}
function storeSet(key: StorageKey, value: string): void {
  window.localStorage.setItem(key, value);
}
function storeRemove(key: StorageKey | LegacyKey): void {
  window.localStorage.removeItem(key);
}

if (typeof window !== 'undefined') {
  try {
    for (const [oldKey, newKey] of Object.entries(LEGACY) as [LegacyKey, StorageKey][]) {
      const v = storeGet(oldKey);
      if (v !== null && storeGet(newKey) === null) storeSet(newKey, v);
      if (v !== null) storeRemove(oldKey);
    }
  } catch {
    /* storage blocked - nothing to migrate */
  }
}

const listeners = new Set<() => void>();

/**
 * Memory that can hold the ZIP or the members found for it registers here to
 * be emptied by every erase: this tab's, another tab's, and one seen on a
 * return from the back/forward cache (`noteErase` below). The snapshot caches
 * of this module do (`makeSnapshot`), and so does lib/rep-lookup-share.ts.
 */
const eraseHooks = new Set<() => void>();

export function onErase(hook: () => void): void {
  eraseHooks.add(hook);
}

/** Exported for tests/local-blocked.unit.spec.ts; the hooks below are its users. */
export function subscribe(cb: () => void) {
  const onStorage = (e: StorageEvent) => {
    noteStorageEvent(e);
    cb();
  };
  listeners.add(cb);
  watchReturns();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

/*
 * AN ERASE IN ANOTHER TAB, OR WHILE THIS PAGE SLEPT (2026-11-18).
 *
 * The erase count below lived only in the tab that erased, so another open
 * tab kept the members on its screen, a lookup it had on its way was shown
 * and remembered, and what it did next (a street address, "Show all
 * districts") sent the erased ZIP again. The browser tells every other tab of
 * this site when storage changes (the `storage` event): an erase key removed
 * (only `eraseAll` ever removes one) or the whole store cleared counts as an
 * erase here too. Every subscriber hears the same event object, so it is
 * counted once.
 *
 * A page kept in the browser's back/forward cache hears nothing while it
 * sleeps. When it is shown again (`pageshow`, persisted), any erase key this
 * page had read with a value and that is now gone counts as an erase, and
 * every reader redraws.
 *
 * With storage blocked there is no shared store and no event: what another
 * tab keeps is only in that tab's own memory, out of an erase's reach by
 * construction, and it is gone when that tab reloads or closes.
 */
let lastStorageEvent: Event | null = null;

function noteStorageEvent(e: StorageEvent) {
  if (e === lastStorageEvent) return;
  lastStorageEvent = e;
  if (e.key === null || (isErasedKey(e.key) && e.newValue === null)) noteErase();
  else if (isErasedKey(e.key)) {
    // Another tab wrote a new value since: that one is not erased.
    revoked.delete(e.key);
    // And if it is another ZIP, or another tag, what this tab shows for the
    // old one is not what storage holds now (see "WHAT A TAB SHOWS" below).
    if (e.oldValue !== null && matters(e.key, e.oldValue, e.newValue)) noteChange();
  }
}

/*
 * The other tab's erase arrives here as one event per key, and the first (the
 * tag's, since the erase removes the tag first) comes while the ZIP and the
 * other keys are still visible to this tab: a page that redraws on that first
 * event would read the saved ZIP, or an old entry, and send the erased ZIP.
 * So every value of an erase key visible at an erase is revoked in this tab:
 * it reads as nothing, whatever order the events come in, until a new value
 * is written (here, or in another tab: its event says so).
 */
const revoked = new Map<StorageKey, string>();

function noteErase() {
  for (const key of ERASED_KEYS) {
    try {
      const visible = storeGet(key);
      if (visible !== null) revoked.set(key, visible);
    } catch {
      /* storage blocked: nothing shared to revoke */
    }
  }
  noteChange();
}

/*
 * WHAT A TAB SHOWS MUST MATCH WHAT STORAGE HOLDS NOW (2026-11-19).
 *
 * Whenever the saved ZIP a tab found members for is no longer the saved ZIP,
 * gone or different, those members leave its screen: the prompt comes back
 * and the saved ZIP, if there is one, fills it in. A page remembers the value
 * it last read for each erase key (`seen`), and checks it against storage
 * when it may have missed what happened meanwhile:
 *
 *   - back from the back/forward cache (`pageshow`, persisted): a page there
 *     hears no event while it sleeps;
 *   - shown again (`visibilitychange` to visible) and focused (`focus`): a
 *     hidden tab can be throttled, and events can come late.
 *
 * It counts as a change when the ZIP or the history tag is gone or different,
 * or when the calls or the reads are gone (an erase). The same count every
 * reader already checks rises (`erasures` below), so every page drops what
 * it found for the old ZIP; a value that is merely new is not marked erased.
 * Another tab's `storage` event that turns the ZIP or the tag into another
 * value counts the same way (above).
 */
const seen = new Map<StorageKey, string>();

function zipOf(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return isPlainObject(v) && typeof v.zip === 'string' ? v.zip : null;
  } catch {
    return null;
  }
}

/** Whether `now` makes what was found for `was` stale. */
function matters(key: StorageKey, was: string, now: string | null): boolean {
  if (now === null) return true;
  if (key === PREFS_KEY) return zipOf(was) !== zipOf(now);
  if (key === ENTRY_TAG_KEY) return was !== now;
  return false;
}

/** What storage holds for `key` now, as this tab reads it, without noting it. */
function current(key: StorageKey): string | null {
  const kept = memory.get(key);
  let value: string | null = kept ?? null;
  if (kept === undefined) {
    try {
      value = storeGet(key);
    } catch {
      value = null;
    }
  }
  return value !== null && revoked.get(key) === value ? null : value;
}

function recheck(): boolean {
  for (const [key, was] of seen) {
    if (matters(key, was, current(key))) {
      noteChange();
      return true;
    }
  }
  return false;
}

/** An erase, or the saved ZIP changed elsewhere: everything found before goes. */
function noteChange() {
  memory.clear();
  seen.clear();
  erasures += 1;
  for (const hook of eraseHooks) hook();
}

let watchingReturns = false;

function watchReturns() {
  if (watchingReturns) return;
  watchingReturns = true;
  window.addEventListener('pageshow', (e) => {
    if (!(e as PageTransitionEvent).persisted) return;
    recheck();
    notify();
  });
  const again = () => {
    if (recheck()) notify();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') again();
    });
  }
  window.addEventListener('focus', again);
}

function notify() {
  for (const cb of listeners) cb();
}

/**
 * WHEN THE BROWSER REFUSES STORAGE, KEEP IT FOR THIS VISIT (2026-11-12).
 * Safari set to block all cookies and website data (and a full or disabled
 * store) makes every localStorage call throw. Writes used to be dropped,
 * which was harmless while the members page read the ZIP from its address
 * (/reps?zip=…). Since the owner took it out of the address (2026-11-12),
 * /reps finds the ZIP through this module, so a dropped write left a ZIP
 * typed on the home page or a bill page landing on an empty prompt.
 *
 * So a preferences write the browser refuses is kept HERE, in this page's
 * memory, and every read prefers it. It lasts as long as the page's
 * JavaScript does: across the site's client-side navigations, never past a
 * full page load, a reload or a closed tab, and it is never written anywhere
 * else. Once a write succeeds again, memory lets go of it. Only the
 * preferences (the ZIP, the interests): the call and reading records keep
 * their old behaviour, a refused write is dropped, because nothing needs
 * them to cross a page and keeping them would change what /record shows.
 */
const memory = new Map<StorageKey, string>();
const KEPT_IN_MEMORY = new Set<StorageKey>([PREFS_KEY]);

/** Whether storage has held anything of ours this visit (see `eraseAll`). */
let storeHeldOurs = false;

function write(key: StorageKey, value: unknown) {
  const raw = JSON.stringify(value);
  revoked.delete(key);
  try {
    storeSet(key, raw);
    storeHeldOurs = true;
    memory.delete(key);
  } catch {
    // Storage full or blocked: keep the preferences for this visit (see above).
    if (KEPT_IN_MEMORY.has(key)) memory.set(key, raw);
  }
  notify();
}

/** What is stored under `key`: this visit's refused write first, then storage. */
function read(key: StorageKey): string | null {
  const kept = memory.get(key);
  let value: string | null = kept ?? null;
  if (kept === undefined) {
    try {
      value = storeGet(key);
      if (value !== null) storeHeldOurs = true;
    } catch {
      value = null; // blocked
    }
  }
  if (value !== null && revoked.get(key) === value) value = null; // erased elsewhere (see above)
  if (value !== null && isErasedKey(key)) seen.set(key, value);
  return value;
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
/**
 * Every snapshot's cache, in one place: the last raw string read (the ZIP, in
 * the preferences' case) is not kept in memory past an erase or a change of
 * the saved ZIP made elsewhere.
 */
const snapshotCache = new Map<StorageKey, { raw: string | null; value: unknown }>();
onErase(() => snapshotCache.clear());

/** The raw strings the snapshot caches hold now (tests/erase-signal.unit.spec.ts). */
export function snapshotCacheContents(): (string | null)[] {
  return [...snapshotCache.values()].map((c) => c.raw);
}

function makeSnapshot<T>(key: StorageKey, fallback: T, coerce: (v: unknown) => T | null) {
  return (): T => {
    const raw = read(key);
    let cache = snapshotCache.get(key) as { raw: string | null; value: T } | undefined;
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
      snapshotCache.set(key, cache);
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

/**
 * The saved ZIP as it stands right now, read once and outside React — or null
 * when none is saved or it is not five digits. For a one-shot decision made
 * after hydration (components/SavedZipLookup.tsx), where `usePrefs()` would
 * also fire on a ZIP the reader types a moment later. Browser only.
 */
export function savedZip(): string | null {
  const zip = prefsSnapshot().zip;
  return zip && /^\d{5}$/.test(zip) ? zip : null;
}

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
 * THE KEY TO THE MEMBERS PAGE'S HISTORY ENTRIES (2026-11-18).
 *
 * The members page keeps the ZIP it shows, and a district found for it, in
 * this tab's own history entries (lib/members-entry.ts), so Reload and Back
 * work. An erase cannot reach those entries: a page can rewrite only the entry
 * it stands on, and every earlier entry, and every entry of another open tab,
 * kept the ZIP after "erase everything". Reload or Back to one of them sent the
 * erased ZIP to the lookup and showed the members again.
 *
 * So every entry that carries a ZIP also carries this tag, and an entry counts
 * only while its tag is the one stored here. Erasing deletes the tag, and from
 * then on every entry written before the erase, in this tab or any other, reads
 * as empty. The next lookup makes a new tag.
 *
 * What it is: 32 random hexadecimal characters, made in this browser. It says
 * nothing about the visitor, it is never sent anywhere (no request, address,
 * cookie or log ever carries it), and it is not a fingerprint: it is a fresh
 * random value after every erase, and no other site and no server can read it.
 * When the browser refuses storage it is kept for the visit, in memory, like
 * the preferences (see `memory` above).
 */
const TAG_RE = /^[0-9a-f]{32}$/;

export function entryTag(): string | null {
  const raw = read(ENTRY_TAG_KEY);
  return raw !== null && TAG_RE.test(raw) ? raw : null;
}

function freshTag(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function ensureEntryTag(): string {
  const have = entryTag();
  if (have) return have;
  const tag = freshTag();
  try {
    storeSet(ENTRY_TAG_KEY, tag);
    storeHeldOurs = true;
    memory.delete(ENTRY_TAG_KEY);
  } catch {
    memory.set(ENTRY_TAG_KEY, tag); // storage refused: this visit only (see above)
  }
  return tag;
}

/**
 * How many erases this page has seen: its own, another tab's (the `storage`
 * event) and one made while it slept in the back/forward cache (see "AN ERASE
 * IN ANOTHER TAB" above). Every reader of the ZIP compares it with the count
 * at the moment the visitor acted: members found before a later erase are
 * not shown, and an answer that arrives after one is discarded rather than
 * shown and remembered.
 */
let erasures = 0;

export function erasureCount(): number {
  return erasures;
}

export function useErasures(): number {
  return useSyncExternalStore(subscribe, erasureCount, () => 0);
}

/**
 * ERASE COMPLETENESS. Every key this module writes is removed here — that is
 * the whole promise the privacy page and `impact.eraseConfirm` make out loud,
 * so a new store is not finished until its key is on ERASED_KEYS
 * (lib/storage-keys.ts) and named in both locales' confirm string. The entry
 * tag is the one key that is not named there: it is not the visitor's data
 * but the lock on the ZIP's copies in history, and removing it is what makes
 * "erases your ZIP" true of them.
 *
 * ONLY A WHOLE ERASE SAYS SO (2026-11-19). The removals used to sit in one
 * try, the tag last: when one threw, the rest, the tag included, were never
 * tried, and the page said "All local data erased." all the same, while
 * Reload sent the ZIP again. Now the tag goes first (once it is gone, no copy
 * of the ZIP in history can be read, whatever happens to the rest), each key
 * is tried on its own and then checked, and the count of erases rises either
 * way. A tag that will not go is replaced by a fresh random one, which kills
 * every history copy as surely; if even that write is refused, the store is
 * unusable. The answer is whether every key is gone (or the tag replaced):
 * the callers say "erased" only then. A store the browser will not even read
 * is no erase if it held something of ours this visit (storage blocked
 * mid-visit: the data may still be on disk); one blocked from the start never
 * held anything, and this visit's memory is cleared.
 */
export function eraseAll(): boolean {
  let complete = true;
  for (const key of ERASED_KEYS) {
    try {
      storeRemove(key);
    } catch {
      /* checked just below */
    }
    let left: string | null;
    try {
      left = storeGet(key);
    } catch {
      // The store will not even be read. If it never held anything of ours
      // this visit (storage blocked from the start), there is nothing in it
      // to erase; if it did, it may still hold it, and this is no erase.
      if (storeHeldOurs) complete = false;
      continue;
    }
    if (left === null) continue;
    if (key === ENTRY_TAG_KEY) {
      // A tag that will not go is replaced by a fresh random one: no copy of
      // the ZIP in history carries it, so none can be read again, after a
      // reload either. If even that is refused, the store is unusable.
      try {
        storeSet(key, freshTag());
        continue;
      } catch {
        revoked.set(key, left); // dead in this tab at least
      }
    }
    complete = false;
  }
  memory.clear();
  noteChange();
  notify();
  return complete;
}

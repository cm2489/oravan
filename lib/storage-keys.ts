/*
 * EVERY KEY THE SITE WRITES IN THE BROWSER'S STORAGE, IN ONE PLACE
 * (2026-11-19).
 *
 * "Erase everything" is a promise about keys, so the keys are named here and
 * nowhere else. tests/storage-keys.unit.spec.ts holds every storage call in
 * app/, components/ and lib/ to one of these names: a literal, a template, a
 * key built from parts or a second way into storage fails it.
 *
 * The first four are the visitor's data and the lock on its history copies:
 * an erase removes them, the lock first (lib/local.ts eraseAll). The last two
 * are kept by an erase on purpose; the reason is written where each is used.
 */

/** The ZIP and the topics followed (lib/local.ts). */
export const PREFS_KEY = 'oravan.prefs';
/** The calls logged (lib/local.ts). */
export const CALLS_KEY = 'oravan.calls';
/** The bills read (lib/local.ts). */
export const READS_KEY = 'oravan.reads';
/** The members page's history-entry tag (lib/local.ts ensureEntryTag). */
export const ENTRY_TAG_KEY = 'oravan.entry';

/** The language the visitor chose (lib/locale-pref.ts: kept by an erase, see there). */
export const LOCALE_CHOICE_KEY = 'oravan.locale.chosen';
/** The Spanish suggestion closed (components/LocalePreferenceNote.tsx: kept by an erase, see there). */
export const ES_NOTE_DISMISSED_KEY = 'oravan.esNote.dismissed';

export type StorageKey =
  | typeof PREFS_KEY
  | typeof CALLS_KEY
  | typeof READS_KEY
  | typeof ENTRY_TAG_KEY
  | typeof LOCALE_CHOICE_KEY
  | typeof ES_NOTE_DISMISSED_KEY;

/** What an erase removes, in the order it removes them: the tag first. */
export const ERASED_KEYS: readonly StorageKey[] = [ENTRY_TAG_KEY, PREFS_KEY, CALLS_KEY, READS_KEY];

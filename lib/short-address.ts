/*
 * SHORT ADDRESSES FOR BILLS: oravan.org/hr9340 opens that bill's page.
 *
 * Why (owner decisions of 2026-09-26): the bill number is the link a person
 * can say, type or paste from a post where links are not tappable. Every
 * short address lands on the bill's explanation, never on a dialer (card d4:
 * "every link lands on the explanation"); the call is the page's own next
 * step.
 *
 * HOW IT RUNS. proxy.ts, which already runs on every page request for locale
 * negotiation, asks this module one question per request: is this path a
 * short address for a bill the corpus holds, and which one? The answer comes
 * from small tables, one per Congress the corpus holds, each a bitset per
 * bill type (one bit per bill number), encoded at BUILD time by
 * next.config.ts from data/bills.json and inlined into the proxy bundle as
 * strings: one for the tracked Congress, and one for each ended Congress the
 * corpus holds (none while nothing has ended). The corpus itself is never
 * imported here or in proxy.ts, and the lookup is at most one constant-time
 * bit test per table (today: one table, one bit test). Its one
 * import is lib/congress.mjs, the single source of the Congress number and
 * the ended list, which is itself import-free (no imports, no I/O, no
 * environment), so next.config.ts, proxy.ts and the unit specs can all load
 * this file as-is and it can never reach data/.
 *
 * WHEN CONGRESS CHANGES (the owner's ruling, SHORT_ADDRESS_ROLLOVER_RULING
 * below). Bill numbers restart with each Congress, so after Jan 3, 2027
 * /hr1 can name two bills. A short address opens the tracked Congress's bill
 * when the corpus holds it; otherwise the bill with that type and number in
 * the most recently ended Congress that holds one, searching the ended
 * Congresses from the most recent backwards; otherwise the site's normal
 * 404. The ended bill's own page shows how it stands: the ended note for an
 * unfinished bill, its outcome for one that became law or was otherwise
 * decided. Nothing here needs editing at the switch: moving the tracked
 * number and filling ENDED_CONGRESSES in lib/congress.mjs is the whole
 * change, and the switch with no bill of the new Congress yet is covered
 * (every ended bill then resolves to its own page).
 *
 * WHAT IT NEVER DOES: carry a query string onward (a shared link never
 * carries a stance, CLAUDE.md rule 1), answer for a bill the corpus does not
 * hold (those fall through to the site's normal 404), or shadow a real route
 * (tests/short-address.unit.spec.ts lists every top-level segment of the
 * app/ tree and proves none matches the pattern).
 */

import { CONGRESS_POLICY, CURRENT_CONGRESS } from './congress.mjs';

/**
 * The Congress a short address means first. A short address carries no
 * Congress number, so /hr1 resolves to H.R. 1 of THIS Congress when the
 * corpus holds it: the one the whole build tracks, read from lib/congress.mjs
 * (since 2026-11-12 the only place the number is written;
 * tests/congress-source.unit.spec.ts pins this use). When it does not, an
 * ended Congress's bill answers (shortAddressFallbackCongresses below).
 */
export const SHORT_ADDRESS_CONGRESS: number = CURRENT_CONGRESS.number;

/**
 * The owner's dated ruling on what a short address opens once a new Congress
 * has started, quoted in the words of the card he answered. The card's
 * question, its examples and its promise are quoted in
 * tests/short-address.unit.spec.ts, which pins the behaviour built from it.
 *
 * His sentence speaks of one ended Congress ("the ended one"); in 2027 there
 * is only one. What happens once two or more have ended (from 2029) is NOT
 * his sentence: it is the orchestrating session's reading of his words and
 * of the reason the card gave him ("links shared this year keep working for
 * as long as they can"), dated 2026-11-14: search the ended Congresses from
 * the most recent backwards, and open the first that holds the bill.
 */
export const SHORT_ADDRESS_ROLLOVER_RULING: string | null =
  'Decision 190, clicked Saturday, Nov 14, 2026, 12:41 PM ET. Asked "Once the new Congress starts, which bill ' +
  'should a short address open?", the owner chose option a: "The newest Congress, falling back to the ended one ' +
  'when the new one has no such bill yet."';

/**
 * Every bill type a short address can name: the eight measure types
 * Congress numbers. The corpus decides which of them resolve (on 2026-09-29
 * it held hr, s, hjres, sjres, hconres and sconres, and no simple
 * resolutions), so /hres10 parses but, until the corpus holds one, 404s.
 */
export const SHORT_ADDRESS_TYPES = ['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres', 'hres', 'sres'] as const;

export type ShortAddressType = (typeof SHORT_ADDRESS_TYPES)[number];

export interface ShortAddress {
  type: ShortAddressType;
  number: number;
}

// Longest type names first, so "hconres5" is never read as "h…" anything.
// Numbers: no leading zero, at most five digits (the House passes 10,000
// around the end of a Congress; nothing reaches 100,000).
const SHORT_ADDRESS_PATTERN = /^(hconres|sconres|hjres|sjres|hres|sres|hr|s)-?([1-9]\d{0,4})$/;

/**
 * Read one path segment as a short address. Case-insensitive, with or
 * without one hyphen between type and number: hr9340, HR9340, hr-9340,
 * Hr-9340. Anything else (dots, spaces, a Congress suffix, a leading zero,
 * percent-encoding) is not a short address and returns null.
 */
export function parseShortAddress(segment: string): ShortAddress | null {
  const match = SHORT_ADDRESS_PATTERN.exec(segment.toLowerCase());
  if (!match) return null;
  return { type: match[1] as ShortAddressType, number: Number(match[2]) };
}

/** The canonical bill slug a short address points at, e.g. hr-9340-119. */
export function shortAddressSlug(address: ShortAddress, congress: number = SHORT_ADDRESS_CONGRESS): string {
  return `${address.type}-${address.number}-${congress}`;
}

// --- the build-time index -----------------------------------------------------

/** The fields of a corpus bill this index reads (lib/types.ts's Bill has them). */
export interface ShortAddressBill {
  bill_type: string;
  bill_number: number;
  congress_number: number;
}

/**
 * Encode which bills exist, for one Congress, as `type:<base64 bitset>`
 * pairs joined by `;` — bit N of a type's bitset is set when that type's
 * bill N is in the corpus. About 3 KB for the whole 119th Congress. Called
 * by next.config.ts at build time; never at request time.
 */
export function encodeShortAddressIndex(bills: readonly ShortAddressBill[], congress: number): string {
  const byType = new Map<ShortAddressType, number[]>();
  for (const bill of bills) {
    if (bill.congress_number !== congress) continue;
    const parsed = parseShortAddress(`${bill.bill_type}${bill.bill_number}`);
    if (!parsed) continue;
    const list = byType.get(parsed.type) ?? [];
    list.push(parsed.number);
    byType.set(parsed.type, list);
  }
  const parts: string[] = [];
  for (const type of SHORT_ADDRESS_TYPES) {
    const numbers = byType.get(type);
    if (!numbers || numbers.length === 0) continue;
    const bytes = new Uint8Array((Math.max(...numbers) >> 3) + 1);
    for (const n of numbers) bytes[n >> 3] |= 1 << (n & 7);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    parts.push(`${type}:${btoa(binary)}`);
  }
  return parts.join(';');
}

export type ShortAddressIndex = ReadonlyMap<string, Uint8Array>;

/** Decode the string above once, at module load. A malformed pair is skipped. */
export function decodeShortAddressIndex(encoded: string | undefined): ShortAddressIndex {
  const index = new Map<string, Uint8Array>();
  for (const pair of (encoded ?? '').split(';')) {
    const colon = pair.indexOf(':');
    if (colon <= 0) continue;
    try {
      const binary = atob(pair.slice(colon + 1));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      index.set(pair.slice(0, colon), bytes);
    } catch {
      // Not base64: leave that type out, so its addresses 404 rather than throw.
    }
  }
  return index;
}

/** Constant time: one map read and one bit test. */
export function indexHas(index: ShortAddressIndex, address: ShortAddress): boolean {
  const bytes = index.get(address.type);
  if (!bytes) return false;
  const byte = bytes[address.number >> 3];
  return byte !== undefined && (byte & (1 << (address.number & 7))) !== 0;
}

/** The two things the fallback reads from lib/congress.mjs's CONGRESS_POLICY
 *  (a test passes its own, shaped like the switch). */
export interface ShortAddressPolicy {
  tracked: number;
  ended: ReadonlyArray<{ number: number; ended: string }>;
}

/**
 * THE FALLBACK ORDER: every ended Congress whose bills the corpus holds,
 * most recently ended first (empty today: lib/congress.mjs lists no ended
 * Congress). Only a Congress on the ended list counts, and only when the
 * corpus holds at least one of its bills; the latest `ended` date comes
 * first (the larger number on a tie). Called at build time only.
 */
export function shortAddressFallbackCongresses(
  bills: readonly ShortAddressBill[],
  policy: ShortAddressPolicy = CONGRESS_POLICY,
): number[] {
  const held = new Set(bills.map((b) => b.congress_number));
  return policy.ended
    .filter((entry) => entry.number !== policy.tracked && held.has(entry.number))
    .slice()
    .sort((a, b) => (a.ended === b.ended ? b.number - a.number : a.ended < b.ended ? 1 : -1))
    .map((entry) => entry.number)
    .filter((n, i, all) => all.indexOf(n) === i);
}

/**
 * The fallback tables, for proxy.ts: `<congress>@<index>` per ended Congress,
 * in fallback order, joined by `|`; '' when there is none. Built by
 * next.config.ts at build time; '' on every build while the ended list is
 * empty. Each ended Congress adds one table of the size of its own bitset
 * (about 2.9 KB for a full Congress).
 */
export function encodeShortAddressFallback(
  bills: readonly ShortAddressBill[],
  policy: ShortAddressPolicy = CONGRESS_POLICY,
): string {
  return shortAddressFallbackCongresses(bills, policy)
    .map((congress) => `${congress}@${encodeShortAddressIndex(bills, congress)}`)
    .join('|');
}

/** The decoded fallback tables, in the order they are searched. Empty: no fallback. */
export type ShortAddressFallback = ReadonlyArray<{ congress: number; index: ShortAddressIndex }>;

/** Decode the string above once, at module load. A malformed table is skipped; the order is kept. */
export function decodeShortAddressFallback(encoded: string | undefined): ShortAddressFallback {
  const tables: Array<{ congress: number; index: ShortAddressIndex }> = [];
  for (const part of (encoded ?? '').split('|')) {
    const match = /^([1-9]\d{0,3})@(.*)$/.exec(part);
    if (!match) continue;
    const index = decodeShortAddressIndex(match[2]);
    if (index.size > 0) tables.push({ congress: Number(match[1]), index });
  }
  return tables;
}

/**
 * The redirect target for a request path, or null when the path is not a
 * short address for a bill any table holds.
 *
 * Accepted shapes: /<short> and /<locale>/<short> (a trailing slash is
 * tolerated). The target is the bill's canonical page as a PATH only, with
 * no query string: /es/<short> goes to /es/bills/<slug>; /<short> and
 * /en/<short> go to the bare /bills/<slug>, which is the English page under
 * the site's `as-needed` locale prefix (i18n/routing.ts) and which then
 * meets the site's normal locale handling like any other bare path.
 *
 * Which bill: the tracked Congress's when `index` holds it; otherwise the
 * first fallback table, in order, that holds it; otherwise null. With no
 * fallback (empty, as on every build while nothing has ended) this is
 * exactly the one-table lookup of #404.
 */
export function shortAddressTarget(
  pathname: string,
  locales: readonly string[],
  defaultLocale: string,
  index: ShortAddressIndex,
  fallback: ShortAddressFallback = [],
  congress: number = SHORT_ADDRESS_CONGRESS,
): string | null {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  let locale: string | null = null;
  if (segments.length === 2 && locales.includes(segments[0])) locale = segments.shift() ?? null;
  if (segments.length !== 1) return null;
  const address = parseShortAddress(segments[0]);
  if (!address) return null;
  let resolved: number | null = indexHas(index, address) ? congress : null;
  for (const table of fallback) {
    if (resolved !== null) break;
    if (indexHas(table.index, address)) resolved = table.congress;
  }
  if (resolved === null) return null;
  const prefix = locale && locale !== defaultLocale ? `/${locale}` : '';
  return `${prefix}/bills/${shortAddressSlug(address, resolved)}`;
}

// --- name addresses: oravan.org/continuing-appropriations-act-2027 --------------

/*
 * NAME ADDRESSES (2026-11-14). A bill can also be reached by its own short
 * title: oravan.org/continuing-appropriations-act-2027 opens H.R. 9770,
 * /es/continuing-appropriations-act-2027 its Spanish page. (Not
 * /laken-riley-act: S. 5 and H.R. 29 both carry that title, so it opens
 * neither; see below.)
 *
 * WHERE A NAME COMES FROM (the owner's choice, NAME_ADDRESS_RULING below):
 * only the short titles the record itself labels as the bill's
 * (lib/short-titles.mjs, data/short-titles.json, filled nightly from
 * Congress.gov). Never a title Oravan wrote, never an AI headline, never a
 * popular name, never the official long title. A bill with no short title in
 * the record has a number address only.
 *
 * THE SLUG RULE (nameSlug), one paragraph a reader can check by hand: take
 * the short title exactly as the record gives it; split each accented letter
 * into its letter and its accent (Unicode NFD, which never turns one
 * character into several letters); read a non-breaking space as a space;
 * delete every apostrophe-like mark (the straight apostrophe ', the curly
 * quotes ‘ and ’, the modifier-letter apostrophe ʼ, the okina ʻ, the acute
 * accent ´ and the grave accent `), so "America's" -> "americas" and
 * "Hawaiʻi" -> "hawaii"; drop the accents (é -> e, ñ -> n). If the title then
 * holds ANY character other than the letters A to Z and a to z, the digits 0
 * to 9, the space, and these punctuation marks: hyphen -, en dash –, em dash
 * —, comma, period, colon, semicolon, ampersand &, slash /, parentheses ( ),
 * straight double quote ", curly double quotes “ ”, exclamation mark ! and
 * question mark ?, it gets NO name. So a letter such as Æ, Ø, Ł or ß, any
 * non-Latin character, a non-ASCII digit, a symbol (™, №, ½, a Roman-numeral
 * or ligature character, a full-width letter), any other apostrophe-like
 * mark (′, ‛, ՚, a full-width apostrophe) and every invisible character (soft
 * hyphen, zero-width space, zero-width joiner and non-joiner, word joiner,
 * byte-order mark) all mean no name: nothing is dropped, split, joined or
 * rewritten to make one. Otherwise lower-case it; turn every run of spaces
 * and allowed punctuation into one hyphen; drop a hyphen at either end. No
 * word is dropped, added or changed: no stop-word is removed, "of 2026"
 * stays, "&" does not become "and". A title whose result has no letter
 * (only a number, or nothing) gets no name.
 *
 * WHEN A NAME IS AN ADDRESS (nameAddressAllowed): it has 4 to 200
 * characters; it does not read as a number address, with or without its
 * hyphens (a title that slugs to "hr1", "s-2" or "h-r-1" never becomes a
 * name, so no name can look like /hr1); proxy.ts actually runs on it in every
 * language (its `matcher` skips paths starting with "api", "_next",
 * "_vercel", "embed/" or equal to "embed", and paths with a dot, so a name
 * like "apiary-act" would answer in Spanish and not in English: it is
 * refused, read from PROXY_MATCHER below); and it is not a reserved word: a
 * real route's segment (read from app/ and public/ at build time, so a route
 * added later is reserved by the build that adds it) or one of
 * NAME_ADDRESS_RESERVED below. PRECEDENCE: a real route, then a number
 * address, then a name.
 *
 * NEVER CHOOSING BETWEEN BILLS. Many bills share a short title (a House bill
 * and its Senate twin usually do). A name resolves only when exactly ONE bill
 * of the Congress being searched carries it, among the bills Oravan tracks:
 * A name opens a bill when no other bill Oravan tracks has a short title that
 * makes the same name ("SAFE Act" and "Safe Act" make one name, and so do
 * "Twin Spelling Act" and "Twin-Spelling Act"). A twin Oravan does not track (most bills of a Congress are never in
 * the corpus) is not counted, so which bill a name opens depends on which
 * bills Oravan tracks, and a name can stop opening its bill the day a twin
 * enters the corpus. The Congresses are searched in
 * the number addresses' order (the tracked one, then each ended one, most
 * recently ended first), and the first Congress that holds the name at all
 * answers: with its one bill, or, when it holds two or more, with the normal
 * not-found. A name shared in the tracked Congress never falls through to an
 * older Congress's bill of the same name. (Since the owner's card 193, Nov 14,
 * 2026, 9:13 PM ET, on the draft #510: the shared case opens
 * /names/<congress>/<name>, a prerendered page listing the bills, instead of
 * the not-found.)
 *
 * THE TABLE (encodeNameTables / decodeNameTables). Built at BUILD time by
 * next.config.ts and inlined into the proxy bundle as SHORT_ADDRESS_NAMES:
 * per Congress, every name with its bill's type and number ("continuing-
 * appropriations-act-2027=hr9770"), or nothing after the "=" for a name two or more bills share. The
 * names themselves are stored, not hashes of them, so a string that is not a
 * bill's name can never match: a false hit is impossible, not merely
 * unlikely. Decoded once per server instance into one Map per Congress; a
 * request costs one pattern test and at most one Map lookup per Congress.
 */

/**
 * The owner's dated choice, in the words of the card he answered (card 191).
 * His first ask (Sep 27, 2026): "can you do a link card with a name instead
 * of bill number."
 */
export const NAME_ADDRESS_RULING =
  'Card 191, Saturday, Nov 14, 2026, 1:06 PM ET. Asked what he meant by "A name (oravan.org/gi-bill)" (card 64, ' +
  'Nov 13, 2026), the owner chose: "Names beside numbers. Each name comes from the bill\'s own official short ' +
  'title in the record, never chosen by Oravan."';

/**
 * Words a name may never take, beyond the routes the build reads from app/
 * and public/: Next's and the host's own prefixes, the locales, and words a
 * route could plausibly take later. A name equal to one of these gets no
 * address, today or after a route of that name exists.
 */
export const NAME_ADDRESS_RESERVED: readonly string[] = Object.freeze([
  '_next', '_vercel', 'api', 'embed', 'embeds', 'en', 'es', 'bills', 'bill', 'reps', 'rep', 'members', 'member',
  'senate', 'house', 'congress', 'call', 'calls', 'today', 'questions', 'question', 'moments', 'impact', 'record',
  'votes', 'vote', 'nominations', 'nomination', 'feed', 'search', 'about', 'privacy', 'terms', 'donate', 'partners',
  'admin', 'login', 'logout', 'account', 'settings', 'help', 'static', 'assets', 'public', 'sitemap', 'robots',
  'manifest', 'favicon', 'icon', 'llms', 'mcp', 'glossary', 'citations', 'follow', 'why-call', 'law', 'laws', 'new',
  'week', 'weekly', 'brief', 'briefs', 'topics', 'topic', 'issues', 'issue', 'contact', 'news', 'press', 'blog',
  'names', 'name',
]);

const NAME_MIN = 4;
const NAME_MAX = 200;
const NAME_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * proxy.ts's `config.matcher`, character for character. Next reads that
 * value statically from proxy.ts itself, so it cannot be imported there;
 * tests/short-address-names.unit.spec.ts fails if the two ever differ. A
 * path the matcher skips never reaches the proxy, so a name there would
 * never answer.
 */
export const PROXY_MATCHER = '/((?!api|_next|_vercel|embed/|embed$|.*\\..*).*)';
const PROXY_MATCHER_RE = new RegExp(`^${PROXY_MATCHER}$`);

/** Does proxy.ts run on this path? (Its matcher, read as the whole-path regular expression it is.) */
export function proxySeesPath(pathname: string): boolean {
  return PROXY_MATCHER_RE.test(pathname);
}

/** The site's locales (i18n/routing.ts; the names spec checks they agree). */
export const NAME_ADDRESS_LOCALES: readonly string[] = Object.freeze(['en', 'es']);

/** Apostrophe-like marks the slug rule deletes: ' ‘ ’ ʼ ʻ ´ ` (U+0027, U+2018, U+2019, U+02BC, U+02BB, U+00B4, U+0060). */
const APOSTROPHE_LIKE = /['\u2018\u2019\u02BC\u02BB\u00B4\u0060]/g;
/**
 * Everything a title may hold once accents are dropped: A-Z, a-z, 0-9, the
 * space, and - – — , . : ; & / ( ) " “ ” ! ? (the punctuation the rule above
 * lists). Anything else means no name.
 */
const ALLOWED_AFTER_ACCENTS = /^[A-Za-z0-9 \-\u2013\u2014,.:;&/()"\u201C\u201D!?]*$/;

/** The slug rule, with its reason when a title gets no name (the build log prints it). */
export function slugTitle(title: string): { name: string; reason: null } | { name: null; reason: string } {
  const plain = title
    .normalize('NFD')
    .replace(/\u00A0/g, ' ')
    .replace(APOSTROPHE_LIKE, '')
    .replace(/\p{M}/gu, '');
  if (!ALLOWED_AFTER_ACCENTS.test(plain)) {
    const bad = [...plain].find((ch) => !ALLOWED_AFTER_ACCENTS.test(ch)) ?? '';
    const code = bad.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0');
    return { name: null, reason: `the title holds a character outside the allowed set (U+${code})` };
  }
  const name = plain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!/[a-z]/.test(name)) return { name: null, reason: 'the title has no letter' };
  return { name, reason: null };
}

/** The slug rule above: a short title as the record gives it -> its name, or null when it gets none. */
export function nameSlug(title: string): string | null {
  return slugTitle(title).name;
}

/** Why a name is not an address, or null when it is one. One plain reason per refusal, for the build log. */
export function nameAddressRefusal(
  name: string,
  reserved: ReadonlySet<string>,
  locales: readonly string[] = NAME_ADDRESS_LOCALES,
): string | null {
  if (name.length < NAME_MIN) return `shorter than ${NAME_MIN} characters`;
  if (name.length > NAME_MAX) return `longer than ${NAME_MAX} characters`;
  if (!NAME_SHAPE.test(name) || !/[a-z]/.test(name)) return 'not a-z, 0-9 and single hyphens with a letter';
  if (parseShortAddress(name) !== null || parseShortAddress(name.replace(/-/g, '')) !== null) return 'it reads as a number address';
  if (![`/${name}`, ...locales.map((l) => `/${l}/${name}`)].every(proxySeesPath)) {
    return "proxy.ts's matcher skips it in at least one language";
  }
  if (reserved.has(name)) return 'a route or reserved word of that name';
  return null;
}

/** Is this name an address? (Length, shape, never a number address, seen by the proxy in every language, never reserved.) */
export function nameAddressAllowed(name: string, reserved: ReadonlySet<string>): boolean {
  return nameAddressRefusal(name, reserved) === null;
}

/** The record's short titles, as data/short-titles.json holds them: slug -> { titles }. */
export type ShortTitleFile = Readonly<Record<string, { readonly titles: readonly string[] }>>;

/** One Congress's names: name -> its one bill, or null when two or more bills share it. */
export type NameTable = ReadonlyMap<string, ShortAddress | null>;

export type NameTables = ReadonlyArray<{ congress: number; names: NameTable }>;

/**
 * Every name of every bill of one Congress, grouped: name -> the bills
 * (`type+number`) that carry it. Built from the record's titles alone. Pure;
 * build time and the specs only.
 */
/** A record short title that gives no address, and why (next.config.ts prints one line for each). */
export interface NameRefusal {
  slug: string;
  title: string;
  name: string | null;
  reason: string;
}

export function namesOfCongress(
  bills: readonly ShortAddressBill[],
  titles: ShortTitleFile,
  congress: number,
  reserved: ReadonlySet<string>,
  onRefused?: (refusal: NameRefusal) => void,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const bill of bills) {
    if (bill.congress_number !== congress) continue;
    const address = parseShortAddress(`${bill.bill_type}${bill.bill_number}`);
    if (!address) continue;
    const entry = titles[`${bill.bill_type}-${bill.bill_number}-${bill.congress_number}`];
    for (const title of entry?.titles ?? []) {
      if (typeof title !== 'string') continue;
      const slug = `${bill.bill_type}-${bill.bill_number}-${bill.congress_number}`;
      const slugged = slugTitle(title);
      const name = slugged.name;
      if (!name) {
        onRefused?.({ slug, title, name: null, reason: slugged.reason ?? 'no name' });
        continue;
      }
      const reason = nameAddressRefusal(name, reserved);
      if (reason) {
        onRefused?.({ slug, title, name, reason });
        continue;
      }
      const holders = out.get(name) ?? new Set<string>();
      holders.add(`${address.type}${address.number}`);
      out.set(name, holders);
    }
  }
  return out;
}

/**
 * The name tables for proxy.ts, one per Congress in `order` (the tracked
 * Congress, then shortAddressFallbackCongresses): `<congress>@name=bill,...`
 * joined by `|`, names sorted; `name=` (nothing after it) for a shared name.
 * A Congress with no name is left out. '' when no bill has a short title
 * (every build until the first nightly fills data/short-titles.json).
 */
export function encodeNameTables(
  bills: readonly ShortAddressBill[],
  titles: ShortTitleFile,
  order: readonly number[],
  reserved: ReadonlySet<string>,
  onRefused?: (refusal: NameRefusal) => void,
): string {
  const parts: string[] = [];
  for (const congress of order.filter((c, i, all) => all.indexOf(c) === i)) {
    const names = namesOfCongress(bills, titles, congress, reserved, onRefused);
    if (names.size === 0) continue;
    const entries = [...names.keys()].sort().map((name) => {
      const holders = names.get(name)!;
      if (holders.size > 1) {
        // A shared name is in the table (so the search stops there) and opens no single bill: say so too.
        const bills = [...holders].sort().map((h) => {
          const a = parseShortAddress(h)!;
          return `${a.type}-${a.number}-${congress}`;
        });
        onRefused?.({ slug: bills.join(' '), title: '', name, reason: `shared by ${holders.size} bills, so it opens the page that lists them, /names/${congress}/${name}` });
      }
      return `${name}=${holders.size === 1 ? [...holders][0] : ''}`;
    });
    parts.push(`${congress}@${entries.join(',')}`);
  }
  return parts.join('|');
}

/** Decode the string above once, at module load. A malformed entry or table is skipped; the order is kept. */
export function decodeNameTables(encoded: string | undefined): NameTables {
  const tables: Array<{ congress: number; names: NameTable }> = [];
  for (const part of (encoded ?? '').split('|')) {
    const match = /^([1-9]\d{0,3})@(.+)$/.exec(part);
    if (!match) continue;
    const names = new Map<string, ShortAddress | null>();
    for (const entry of match[2].split(',')) {
      const eq = entry.indexOf('=');
      if (eq <= 0) continue;
      const name = entry.slice(0, eq);
      if (!NAME_SHAPE.test(name)) continue;
      const bill = entry.slice(eq + 1);
      if (bill === '') {
        names.set(name, null);
        continue;
      }
      const address = parseShortAddress(bill);
      if (address && `${address.type}${address.number}` === bill) names.set(name, address);
    }
    if (names.size > 0) tables.push({ congress: Number(match[1]), names });
  }
  return tables;
}

/**
 * The redirect target for a request path read as a NAME address, or null.
 * Same shapes as shortAddressTarget (/<name>, /<locale>/<name>, a trailing
 * slash tolerated, case-insensitive) and the same targets (a bare bill path,
 * English bare, Spanish under /es, never a query). proxy.ts asks this only
 * when shortAddressTarget answered null, so a number address always wins.
 */
export function nameAddressTarget(
  pathname: string,
  locales: readonly string[],
  defaultLocale: string,
  tables: NameTables,
): string | null {
  if (tables.length === 0) return null;
  const segments = pathname.split('/').filter((segment) => segment !== '');
  let locale: string | null = null;
  if (segments.length === 2 && locales.includes(segments[0])) locale = segments.shift() ?? null;
  if (segments.length !== 1) return null;
  const name = segments[0].toLowerCase();
  if (name.length > NAME_MAX || !NAME_SHAPE.test(name)) return null;
  for (const table of tables) {
    if (!table.names.has(name)) continue;
    const address = table.names.get(name);
    const prefix = locale && locale !== defaultLocale ? `/${locale}` : '';
    // Two or more bills of this Congress make the name: never choose. Since the
    // owner's card 193 (Nov 14, 2026), the name opens the page that lists them
    // all (app/[locale]/names/[congress]/[name], prerendered; lib/shared-names.ts),
    // under this Congress's number, never an older Congress's bill.
    if (!address) return `${prefix}/names/${table.congress}/${name}`;
    return `${prefix}/bills/${shortAddressSlug(address, table.congress)}`;
  }
  return null;
}

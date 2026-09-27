/**
 * INDEXNOW: WHICH PUBLIC PAGES DID A DATA COMMIT CHANGE?
 *
 * The pure half of the IndexNow ping (the 2026-09-27 audit, SY-19: the site
 * is indexed but not ranking, and nothing tells a search engine when a page's
 * record moves). scripts/indexnow-ping.mjs reads two versions of data/ out of
 * git and hands them here; this module turns "these records changed" into
 * "these URLs changed" and builds the IndexNow request body. No I/O, no
 * network, no clock — every function is a plain transform, so the unit test
 * (tests/indexnow.unit.spec.ts) can pin each mapping on fixtures.
 *
 * THE KEY IS PUBLIC BY DESIGN, NOT A SECRET. IndexNow proves a site owns its
 * host by serving the same key as a plain file at the site root
 * (public/<INDEXNOW_KEY>.txt, served at https://oravan.org/<key>.txt). Anyone
 * can read it; knowing it lets a third party ping URLs ON THIS HOST only,
 * which at worst asks a search engine to re-crawl our own public pages. It
 * therefore lives in source, not in Actions secrets. To rotate it, change the
 * constant AND rename the file in the same PR — tests/indexnow.unit.spec.ts
 * fails if they disagree, and scripts/check-public-allowlist.mjs admits
 * exactly this one filename.
 *
 * WHAT COUNTS AS A CHANGED PAGE. A page changed when a RECORD it renders
 * changed — a bill's status, its explanation, its coverage, its roll calls,
 * its floor announcement; a Big Question's entry or its live updates. Every
 * page also prints a "data as of" stamp (data/sync-state.json,
 * data/floor-signals-checked.json, each file's _meta timestamp), and those
 * move on every run; counting them would mark the whole site changed every
 * night and turn the ping into a copy of sitemap.xml. They are deliberately
 * NOT read here. The mapping, file by file:
 *
 *   data/bills.json, data/bills-es.json   a record added, removed, or changed
 *                                         in a field its page renders (see
 *                                         PAGE_INVISIBLE_BILL_FIELDS)
 *                                         -> /bills/<slug>
 *   data/bills.json urgency_score alone   -> /today (the one page it orders)
 *   data/coverage.json                    an entry changed -> /bills/<slug>
 *   data/floor-signals.json (.signals)    an announcement changed
 *                                         -> /bills/<slug>
 *   data/floor-signals.json (.nominations), data/nominations.json
 *                                         -> /nominations/<slug>, ONLY when a
 *                                            Big Question cites it (uncited
 *                                            ones serve noindex; see
 *                                            app/sitemap.ts)
 *   data/votes.json (.rollCalls)          a roll call added/changed/removed
 *                                         -> /bills/<its bill>
 *   data/moments.json                     an entry changed -> /questions/<id>
 *                                         and each of its vehicles' pages
 *   data/moment-updates.json              an entry changed -> /questions/<id>
 *   data/conversation.json (.slugs)       the news band -> / and /bills
 *
 * (The mapping is complete; which rows actually fire depends on who commits.
 * Only sync-bills.yml and hot-bills.yml ping. The hourly newsdesk.yml, which
 * is the only writer of conversation.json and floor-signals.json today, does
 * not - so those two rows are dormant until it does. See
 * scripts/indexnow-ping.mjs's header for why.)
 *
 * and the fan-out from a changed bill page: the Big Question pages that
 * carry it as a vehicle and the hubs that list bills (/, /bills, /today);
 * when the bill's own record changed, also its sponsor's member page if the
 * sponsor is sitting (that page lists what they sponsor, as teasers). A bill
 * page touched only because a Big Question citing it changed (its backlink)
 * fans out no further. A changed question page adds / and /questions.
 *
 * A slug that names no page on either side of the diff (coverage kept for a
 * bill the corpus never held, say) is dropped: a ping for a URL that never
 * existed is noise. A page REMOVED by the commit is kept — IndexNow accepts
 * deletions, and the engine learns the page is gone from its 404.
 *
 * Both locales always: /bills/x and /es/bills/x are pinged together, matching
 * the default-locale-unprefixed routing in i18n/routing.ts and the URLs
 * lib/hreflang.ts's absoluteUrl builds for sitemap.xml.
 *
 * Stdlib only: hot-bills.yml runs on a bare runner with no `npm ci`.
 */

/** Public by design — see the header. Must equal public/<key>.txt's content. */
export const INDEXNOW_KEY = '588709dea6fbc8e59899e2a48969d0b6';

/** The shared IndexNow endpoint; participating engines share what it receives. */
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/** The protocol's per-request ceiling. The whole site is ~7,600 URLs, so this
 *  only binds on a pathological diff; the order below decides what survives. */
export const URL_CAP = 10_000;

/** Mirrors i18n/routing.ts (locales + localePrefix 'as-needed'). */
export const LOCALES = ['en', 'es'];
export const DEFAULT_LOCALE = 'en';

/**
 * The data files this module reads, by basename under data/. Everything else
 * in data/ is pipeline state, a freshness stamp, or embed-only
 * (portrait-manifest.json), and is left out on purpose.
 */
export const DATA_FILES = [
  'bills.json',
  'bills-es.json',
  'coverage.json',
  'floor-signals.json',
  'votes.json',
  'moments.json',
  'moment-updates.json',
  'nominations.json',
  'conversation.json',
  // Read at the new commit only, as the list of sitting members whose pages
  // exist. A roster change is refresh-legislators.yml's, which does not ping.
  'legislators.json',
];

/**
 * Bill fields no page renders: decode bookkeeping, the text-version count and
 * the coverage search inputs. The nightly rewrites them for bills whose page
 * did not change, so they are left out of the comparison.
 * tests/indexnow.unit.spec.ts fails if page code ever starts reading one;
 * then it comes off this list. text_version_date and text_version_type came
 * off before they were ever needed: the bill page's "Decoded from" line
 * (2026-09-27 audit, SY-25) prints them, so a change to either re-pings the
 * bill's page.
 */
export const PAGE_INVISIBLE_BILL_FIELDS = [
  'decoded_at',
  'decode_text_sha',
  'decode_text_verified_at',
  'text_version_count',
  'news_query',
  'press_names',
];

/**
 * urgency_score is not on any bill page. Since the docket rework it orders
 * nothing on the site except /today's "moved today" list (lib/today.ts sorts
 * by it); otherwise it feeds the MCP API, the machine feeds and the coverage
 * sweep. So a change to it alone re-pings /today and nothing else. The unit
 * test pins lib/today.ts as its only page-code reader.
 */
export const TODAY_ORDER_BILL_FIELD = 'urgency_score';

/** A bill record as its own page sees it: minus PAGE_INVISIBLE_BILL_FIELDS and urgency_score. */
export function pageFacingBill(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const out = { ...rec };
  for (const f of PAGE_INVISIBLE_BILL_FIELDS) delete out[f];
  delete out[TODAY_ORDER_BILL_FIELD];
  return out;
}

/** Same rule as lib/core/bills.ts billSlug (pinned by the unit test). */
export function billSlug(b) {
  return `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();
}

/** Same rule as lib/core/nominations.ts nominationSlug (pinned by the unit test). */
export function nominationSlug(n) {
  const part = Number(n.part_number ?? 0);
  const base = `pn-${n.pn_number}`;
  return (Number.isInteger(part) && part > 0 ? `${base}-${part}` : base) + `-${n.congress_number}`;
}

/** Same default as lib/moments-gate.mjs vehicleKind. */
function vehicleKind(v) {
  return v?.kind ?? 'bill';
}

/**
 * Key-order-independent serialization, so a writer that reorders a record's
 * keys without changing a value does not read as a changed page.
 */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** An array of records as a Map keyed by keyFn; unkeyable records are skipped. */
export function keyedArray(arr, keyFn) {
  const out = new Map();
  if (!Array.isArray(arr)) return out;
  for (const rec of arr) {
    let k;
    try {
      k = keyFn(rec);
    } catch {
      continue;
    }
    if (typeof k === 'string' && k) out.set(k, rec);
  }
  return out;
}

/** An object's entries as a Map, minus its metadata keys (`_meta`, …). */
export function keyedObject(obj) {
  const out = new Map();
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) if (!k.startsWith('_')) out.set(k, v);
  return out;
}

/** Keys added, removed, or whose value changed between two keyed Maps. */
export function changedKeys(before, after) {
  const out = new Set();
  for (const [k, v] of after) if (!before.has(k) || stableJson(before.get(k)) !== stableJson(v)) out.add(k);
  for (const k of before.keys()) if (!after.has(k)) out.add(k);
  return out;
}

/**
 * The site-relative paths whose content changed between two versions of
 * data/. `before` and `after` map a DATA_FILES basename to its parsed JSON,
 * or null when the file is absent (or unreadable) at that version.
 *
 * Returned in priority order — hubs, questions, bills, nominations, members,
 * each group sorted — so that if URL_CAP ever binds, it drops the least
 * important pages first.
 */
export function deriveChangedPaths(before, after) {
  const b = (f) => before?.[f] ?? null;
  const a = (f) => after?.[f] ?? null;

  const billsBefore = keyedArray(b('bills.json'), billSlug);
  const billsAfter = keyedArray(a('bills.json'), billSlug);
  const momentsBefore = keyedObject(b('moments.json'));
  const momentsAfter = keyedObject(a('moments.json'));

  // A bill's own record, in either language: the only change that reaches
  // its sponsor's member page (which lists sponsored bills as teasers).
  const billRecords = new Set();
  // Every change that shows on the bill page and the hubs that list bills.
  const bills = new Set();
  // A changed Big Question's vehicles: their pages carry its name as a
  // backlink, and nothing else about them changed.
  const backlinks = new Set();
  const questions = new Set();
  const nominations = new Set();
  const members = new Set();
  let newsBand = false;

  const addAll = (set, keys) => {
    for (const k of keys) set.add(k);
  };

  const pageFacing = (m) => new Map([...m].map(([k, v]) => [k, pageFacingBill(v)]));
  addAll(billRecords, changedKeys(pageFacing(billsBefore), pageFacing(billsAfter)));
  const urgencyOf = (m) => new Map([...m].map(([k, v]) => [k, v?.[TODAY_ORDER_BILL_FIELD] ?? null]));
  const urgencyMoved = changedKeys(urgencyOf(billsBefore), urgencyOf(billsAfter)).size > 0;
  addAll(billRecords, changedKeys(keyedObject(b('bills-es.json')), keyedObject(a('bills-es.json'))));
  addAll(bills, billRecords);
  // What the bill page renders beside the record.
  addAll(bills, changedKeys(keyedObject(b('coverage.json')), keyedObject(a('coverage.json'))));
  addAll(bills, changedKeys(keyedObject(b('floor-signals.json')?.signals), keyedObject(a('floor-signals.json')?.signals)));
  addAll(
    nominations,
    changedKeys(keyedObject(b('floor-signals.json')?.nominations), keyedObject(a('floor-signals.json')?.nominations))
  );
  const rollsBefore = keyedArray(b('votes.json')?.rollCalls, (r) => r.id);
  const rollsAfter = keyedArray(a('votes.json')?.rollCalls, (r) => r.id);
  for (const id of changedKeys(rollsBefore, rollsAfter)) {
    for (const rc of [rollsBefore.get(id), rollsAfter.get(id)]) if (typeof rc?.bill === 'string') bills.add(rc.bill);
  }
  addAll(
    nominations,
    changedKeys(keyedArray(b('nominations.json'), nominationSlug), keyedArray(a('nominations.json'), nominationSlug))
  );

  // Big Questions: the entry itself, and the vehicle pages that link back to it.
  for (const id of changedKeys(momentsBefore, momentsAfter)) {
    questions.add(id);
    for (const m of [momentsBefore.get(id), momentsAfter.get(id)]) {
      for (const v of Array.isArray(m?.vehicles) ? m.vehicles : []) {
        if (typeof v?.slug !== 'string') continue;
        (vehicleKind(v) === 'nomination' ? nominations : backlinks).add(v.slug);
      }
    }
  }
  addAll(questions, changedKeys(keyedObject(b('moment-updates.json')), keyedObject(a('moment-updates.json'))));

  if (changedKeys(keyedObject(b('conversation.json')?.slugs), keyedObject(a('conversation.json')?.slugs)).size > 0) {
    newsBand = true;
  }

  // Only slugs that name a page on one side of the diff or the other.
  const isBillPage = (s) => billsBefore.has(s) || billsAfter.has(s);
  const changedBills = [...bills].filter(isBillPage);
  const billPages = [...new Set([...changedBills, ...[...backlinks].filter(isBillPage)])];

  // Fan-out from each changed bill: the Big Questions that carry it (their
  // pages render each vehicle's status), and its sitting sponsor's page.
  const sitting = new Set(
    (Array.isArray(a('legislators.json')) ? a('legislators.json') : []).map((l) => l?.bioguide).filter(Boolean)
  );
  const citesVehicle = (m, kind, slug) =>
    Array.isArray(m?.vehicles) && m.vehicles.some((v) => vehicleKind(v) === kind && v?.slug === slug);
  for (const slug of changedBills) {
    for (const [id, m] of momentsAfter) if (citesVehicle(m, 'bill', slug)) questions.add(id);
  }
  for (const slug of [...billRecords].filter(isBillPage)) {
    for (const rec of [billsBefore.get(slug), billsAfter.get(slug)]) {
      const sponsor = rec?.sponsor_bioguide_id;
      if (sponsor && sitting.has(sponsor)) members.add(sponsor);
    }
  }

  // Nomination pages are indexable only while a Big Question cites them. This
  // reads every entry in data/moments.json; app/sitemap.ts narrows further to
  // live/stale questions (a derived state this module cannot compute without
  // the app), so a settled question's nomination can still be pinged - a
  // crawl of a noindex page, wasted but never a wrong URL.
  const cited = new Set();
  for (const m of momentsAfter.values()) {
    for (const v of Array.isArray(m?.vehicles) ? m.vehicles : []) {
      if (vehicleKind(v) === 'nomination' && typeof v?.slug === 'string') cited.add(v.slug);
    }
  }
  const nominationPages = [...nominations].filter((s) => cited.has(s));
  for (const slug of nominationPages) {
    for (const [id, m] of momentsAfter) if (citesVehicle(m, 'nomination', slug)) questions.add(id);
  }

  const questionPages = [...questions].filter((id) => momentsBefore.has(id) || momentsAfter.has(id));

  const hubs = new Set();
  if (changedBills.length > 0) ['/', '/bills', '/today'].forEach((h) => hubs.add(h));
  if (urgencyMoved) hubs.add('/today');
  if (questionPages.length > 0) ['/', '/questions'].forEach((h) => hubs.add(h));
  if (newsBand) ['/', '/bills'].forEach((h) => hubs.add(h));

  const sorted = (xs) => [...xs].sort();
  return [
    ...sorted(hubs),
    ...sorted(questionPages).map((id) => `/questions/${id}`),
    ...sorted(billPages).map((s) => `/bills/${s}`),
    ...sorted(nominationPages).map((s) => `/nominations/${s}`),
    ...sorted(members).map((id) => `/reps/${id}`),
  ];
}

/**
 * One locale's absolute URL for a site-relative href — the same shape
 * lib/hreflang.ts's absoluteUrl produces for sitemap.xml: the default locale
 * is unprefixed, and the root is the bare origin with no trailing slash.
 */
export function localizedUrl(origin, locale, href) {
  const prefix = locale === DEFAULT_LOCALE ? '' : `/${locale}`;
  const path = href === '/' ? prefix : `${prefix}${href}`;
  return path === '' ? origin : `${origin}${path}`;
}

/** Every path in both locales, path by path, capped at URL_CAP. */
export function localizedUrls(origin, paths, cap = URL_CAP) {
  const all = paths.flatMap((p) => LOCALES.map((l) => localizedUrl(origin, l, p)));
  return { urls: all.slice(0, cap), dropped: Math.max(0, all.length - cap) };
}

/**
 * The IndexNow request body. Four fields, all public: the host, the public
 * key, where the key file lives, and public page URLs. Nothing about any
 * visitor exists in this pipeline to send.
 */
export function buildPayload(origin, urls, key = INDEXNOW_KEY) {
  return {
    host: new URL(origin).host,
    key,
    keyLocation: `${origin}/${key}.txt`,
    urlList: urls,
  };
}

/** Extract `export const SITE_ORIGIN = '...'` from lib/site.ts's source text
 *  (the source-scan idiom scripts/check-server-json.mjs uses; no TS loader). */
export function siteOriginFromSource(source) {
  const m = /export const SITE_ORIGIN\s*=\s*'([^']+)'/.exec(source ?? '');
  return m ? m[1] : null;
}

/*
 * SOCIAL DRAFTS, DRY RUN — drafts post and reply text from the committed
 * record into a review queue on disk. IT SENDS NOTHING.
 *
 *   npx tsx scripts/social-drafts.mjs [--out <dir>] [--now <ISO instant>] [--reply <slug> ...]
 *
 * WHAT THIS IS. The owner has no social accounts yet and has not decided
 * whether anything may post. This script exists so he can read real drafts
 * made from real data and judge them. It reads the committed files in data/
 * and messages/, composes short texts, runs every draft through the gates
 * below, and writes the survivors to a queue file OUTSIDE this repository.
 *
 * WHAT THIS IS NOT, by construction: there is no platform client here, no
 * credential, no login, no scheduler, no network call of any kind, and no
 * code that searches for or targets anyone's post. A reply card is text a
 * PERSON may paste; nothing here decides where. tests/social-drafts.unit.spec.ts
 * reads this file's source and fails if a network module or fetch appears.
 *
 * RUN IT THROUGH tsx, like scripts/pregen-scripts.mjs: it reuses the site's
 * own readers (lib/today.ts, lib/docket.ts, lib/core/bills.ts,
 * lib/status-word.ts, lib/moments.ts, lib/moment-updates.ts) so every fact in
 * a draft is read by the same code the page reads it with. Links are built by
 * scripts/indexnow-urls.mjs's localizedUrl, the pure node-side twin of
 * lib/hreflang.ts's absoluteUrl (which cannot load outside Next), from
 * lib/site.ts's SITE_ORIGIN;
 * and every word Oravan contributes is a message from messages/*.json,
 * rendered the way the page renders it.
 *
 * DETERMINISM. The queue is a pure function of (committed data, `now`).
 * `now` only feeds the live gates (a floor announcement's `announcementFor`,
 * a Big Question's state); it defaults to the clock and is written into the
 * queue, so a run can be reproduced with `--now`.
 *
 * THE GATES (every draft, both languages, both lengths; a failing draft is
 * dropped and counted, never repaired):
 *   rule3      lintForbidden (lib/moments-gate.mjs) on every piece of text the
 *              script composed, quoted record text exempt exactly as the site
 *              exempts it (stripQuoted inside lintForbidden).
 *   rule4      AI-written text carries a label the site already prints, and a
 *              draft with no AI-written text carries no AI label.
 *   rule6      a quote is the record's own words; a floor notice is drafted
 *              only while announcementFor says it is live; no date or time the
 *              record does not hold; every fact prints its date.
 *   record-only a Big Question draft quotes an update that states the official
 *              record (the update's class is vote, status_change or
 *              floor_action), never a line about press coverage
 *              (press_cluster) or a scheduled item. The class field decides,
 *              not the text. Where the newest day's top update is not of a
 *              record class the draft falls back to the newest update that is,
 *              in the site's own order; a question with none is dropped.
 *   record-lag a Big Question update that says where a measure stands must not
 *              be behind the record: if the bill's own status word (lib/status-word)
 *              is settled (law, agreed, rejected, vetoed) and the update's own
 *              action is not the one the record settled on, the draft is
 *              dropped, not queued. Only settled bills are judged; a step
 *              behind on a bill that is still open is not caught.
 *   link       every Oravan link is the canonical page URL (no query, no
 *              fragment, no stance, never the call flow or a phone dialer);
 *              the only other links are a floor notice's government source.
 *   rule9      Oravan's own words are messages, citations, numbers, dates and
 *              separators, nothing else; no web address (domain) appears
 *              outside a record quote. NOT CHECKED: names of outlets, products
 *              or organizations inside AI-written text (headlines and Big
 *              Question lines), and the vocabulary of AI-written headlines;
 *              the site does not check them either.
 *   president  lib/president-style.mjs leaves the text unchanged.
 *   tone       nothing composed expresses urgency, instruction or opinion;
 *              site messages are reused verbatim only.
 *   length     the long form fits PLATFORM_LIMITS.long.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { createFormatter, createTranslator } from 'next-intl';
import enMessages from '../messages/en.json';
import esMessages from '../messages/es.json';
import votesJson from '../data/votes.json';
import { announcementFor, floorSignalsFile } from '../lib/docket';
import { billSlug, getBill, localizeBill } from '../lib/core/bills';
import { formatCitation } from '../lib/format';
import { SITE_ORIGIN } from '../lib/site';
import { localizedUrl } from './indexnow-urls.mjs';
import { getLiveMoments } from '../lib/moments';
import { getUpdates } from '../lib/moment-updates';
import { CLASS_PRIORITY, RECORD_EVENT_CLASSES, selectDayUpdates } from '../lib/moment-updates-gate.mjs';
import { lintForbidden } from '../lib/moments-gate.mjs';
import { normalizePresidentStyle } from '../lib/president-style.mjs';
import { statusWord } from '../lib/status-word';
import { briefToday, briefWindow, buildBrief, dayCountParts, daySummary, shiftDate } from '../lib/today';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

export const QUEUE_SCHEMA = 'social-drafts/v1';

/**
 * LENGTH LIMITS, AS PLAIN DATA. EVERY NUMBER BELOW IS UNVERIFIED until the
 * platform-rules research confirms it: they are working assumptions, not
 * facts about any platform, and nothing here posts anywhere.
 *
 * The first version keeps two variants. `short` counts every character of
 * the link at full length (the strictest reading, so a short draft never
 * relies on a platform shortening its link); `long` does the same. Which
 * platform would take which variant is kept in the private research notes,
 * not here: this public repo names no other product.
 */
export const PLATFORM_LIMITS = Object.freeze({
  verified: false,
  variants: {
    short: { maxChars: 280, linkCounting: 'full length' },
    long: { maxChars: 500, linkCounting: 'full length' },
  },
});

export const KINDS = ['floor-notice', 'roll-call', 'bill-card', 'big-question-update', 'today', 'reply-card'];
export const GATES = ['rule3', 'rule4', 'rule6', 'record-only', 'record-lag', 'link', 'tone', 'rule9', 'president', 'length'];
export const LANGS = ['en', 'es'];

/** The AI labels the site already prints, by message key. Bill headlines take
 *  the label the share image and the embed bill card print (og.aiDecoded);
 *  a Big Question's name and update lines take the question page's own
 *  (moments.updates.summaryAiChip). */
export const AI_LABEL_KEYS = Object.freeze({
  bill: 'og.aiDecoded',
  question: 'moments.updates.summaryAiChip',
});

export const DEFAULT_OUT_DIR = join(homedir(), 'Projects/oravan-private-docs/run1-2026-09-29/research/social/drafts');

const MESSAGES = { en: enMessages, es: esMessages };
const SITE = SITE_ORIGIN;
/** The canonical page URL, as sitemap.xml lists it (no query, ever). */
const absoluteUrl = (lang, href) => localizedUrl(SITE_ORIGIN, lang, href);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CITATION_RE = /^(?:H\.R\.|S\.|H\.Res\.|S\.Res\.|H\.J\.Res\.|S\.J\.Res\.|H\.Con\.Res\.|S\.Con\.Res\.) \d+$/;
const SEPARATOR_RE = /^[ \n·:—,()]*$/u;
const CANONICAL_RE = /^https:\/\/oravan\.org(\/es)?\/(bills|questions|today)\/[a-z0-9-]+$/;
const SOURCE_HOSTS = new Set(['www.congress.gov', 'congress.gov', 'docs.house.gov', 'clerk.house.gov', 'www.senate.gov']);
const TIME_RE = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)(?![\p{L}])/iu;
const MONTH_RE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|ene(?:ro)?|abr(?:il)?|ago(?:sto)?|dic(?:iembre)?|septiembre|octubre|noviembre|diciembre|enero|febrero|marzo|mayo|junio|julio)\b/iu;

/** Words Oravan's own draft text may never carry (tone gate). Site messages
 *  are checked too; quotes of the record and published AI text are not ours
 *  to judge here. */
const TONE_DENY = [
  /\bcall (?:now|today|them|your)\b/i,
  /\bact now\b/i,
  /\burgent(?:ly)?\b/i,
  /\bmatters?\b/i,
  /\bimportant\b/i,
  /\bmust\b/i,
  /\bdon'?t (?:miss|let)\b/i,
  /\bdemand\b/i,
  /\bbreaking\b/i,
  /!/,
  /(?<!\p{L})(?:llama ya|llama hoy|actúa|urgente|importa|importante|exige|no te pierdas|última hora)(?!\p{L})/iu,
  /¡/,
];

/** Rule 9 outside a record quote. The structural rule does the real work
 *  (Oravan's words are only messages, citations, numbers, dates and
 *  separators); this catches a web address in published text. No product
 *  name is listed here on purpose: this repo is public and names none. */
const ORG_DENY = [/(?<![\p{L}@/])[a-z0-9-]+\.(?:com|net|io|co|news|tv|app)(?![\p{L}])/iu];

/* ------------------------------------------------------------------ *
 * Rendering helpers (the page's own formats)
 * ------------------------------------------------------------------ */

const translators = {
  en: createTranslator({ locale: 'en', messages: enMessages }),
  es: createTranslator({ locale: 'es', messages: esMessages }),
};
const formatters = {
  en: createFormatter({ locale: 'en', timeZone: 'UTC' }),
  es: createFormatter({ locale: 'es', timeZone: 'UTC' }),
};

/** Tags in a message render as their plain text (the page wraps them in
 *  glossary links or <strong>; a post has no markup). */
const PLAIN_TAGS = new Proxy({}, { get: () => (chunks) => chunks });

/** A message from messages/<lang>.json, rendered exactly as next-intl renders
 *  it, with its markup tags reduced to text. */
export function msg(lang, key, values = {}) {
  const t = translators[lang];
  const raw = key.split('.').reduce((o, k) => (o == null ? o : o[k]), MESSAGES[lang]);
  if (typeof raw !== 'string') throw new Error(`social-drafts: no message ${key} in ${lang}`);
  if (/<\w+>/.test(raw)) {
    const tags = {};
    for (const m of raw.matchAll(/<(\w+)>/g)) tags[m[1]] = PLAIN_TAGS[m[1]];
    return t.markup(key, { ...values, ...tags });
  }
  return t(key, values);
}

/** "Sep 28, 2026" / "28 sept 2026" — the /today page's `day()` format. */
export function formatDay(lang, iso) {
  return formatters[lang].dateTime(new Date(`${iso}T00:00:00Z`), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/* ------------------------------------------------------------------ *
 * Segments: every draft is a list of pieces that say where they came from
 * ------------------------------------------------------------------ *
 *   sep          separators Oravan adds (": ", " · ", newlines, parentheses)
 *   msg          a site message, rendered verbatim (key + values kept so the
 *                gate can re-render it); `verbatim` names values that are
 *                record text; `dates` names the ISO dates it prints
 *   label        an AI label message
 *   citation     a bill citation (formatCitation)
 *   quote        the record's own words, English, inside “ ”
 *   ai           AI-written text the site publishes
 *   published    other text the site publishes as-is (a Big Question update
 *                line that is itself a record quote)
 *   link         the canonical Oravan page URL
 *   source-link  a government source URL (floor notices only)
 */
const sep = (text, extra = {}) => ({ k: 'sep', text, ...extra });
const m = (lang, key, values = {}, extra = {}) => ({ k: 'msg', key, values, text: msg(lang, key, values), ...extra });
const label = (lang, key, extra = {}) => ({ k: 'label', key, text: msg(lang, key), ...extra });
const cite = (text) => ({ k: 'citation', text });
const quote = (text, extra = {}) => ({ k: 'quote', text: `“${text}”`, raw: text, lang: 'en', ...extra });
const ai = (text, lang, extra = {}) => ({ k: 'ai', text, lang, ...extra });
const published = (text, lang, extra = {}) => ({ k: 'published', text, lang, ...extra });
const link = (url) => ({ k: 'link', text: url });
const sourceLink = (url) => ({ k: 'source-link', text: url });

export const render = (segments) => segments.map((s) => s.text).join('');
export const charCount = (text) => [...text].length;

/**
 * One form of a draft within `maxChars`: optional groups (a note and the
 * separator after it, marked with the same `optional` name) are dropped, last
 * first, until it fits. Record quotes and AI text are never cut, so a draft
 * whose required text is longer than the limit has no form of that size
 * (null, with the reason) rather than a truncated quote.
 */
function fitTo(segments, maxChars) {
  let kept = segments.slice();
  const groups = [...new Set(segments.filter((s) => s.optional).map((s) => s.optional))].reverse();
  for (const g of groups) {
    if (charCount(render(kept)) <= maxChars) break;
    kept = kept.filter((s) => s.optional !== g);
  }
  const text = render(kept);
  return charCount(text) <= maxChars
    ? { text, segments: kept, chars: charCount(text) }
    : { text: null, segments: null, chars: null, reason: `required record or AI text is longer than ${maxChars} characters`, full: charCount(render(kept)) };
}

/** The two forms of one language's draft: short (≤ 280) and long (≤ 500). */
export function variantsOf(segments) {
  return {
    short: fitTo(segments, PLATFORM_LIMITS.variants.short.maxChars),
    long: fitTo(segments, PLATFORM_LIMITS.variants.long.maxChars),
  };
}

/* ------------------------------------------------------------------ *
 * Composers — pure, one per kind. Inputs are plain record objects.
 * ------------------------------------------------------------------ */

const billHref = (slug) => `/bills/${slug}`;

/**
 * A floor notice: the chamber's own announcement, quoted verbatim in English
 * with its published date, its source link, and the bill's page link.
 * `a` is announcementFor's return value.
 */
export function composeFloorNotice({ slug, citation, a }) {
  const segs = (lang) => [
    // The frame is the first thing to go when the quote is long: the source
    // line below already names the chamber's document.
    m(lang, a.chamber === 'senate' ? 'bill.floor.announcedSenate' : 'bill.floor.announcedHouse', {}, { optional: 'frame' }),
    sep(': ', { optional: 'frame' }),
    quote(a.quote),
    sep('\n'),
    a.coversLabel
      ? m(
          lang,
          'today.scheduleMeta',
          {
            source: msg(lang, a.source === 'daily-digest' ? 'home.evidenceSourceDigest' : 'home.evidenceSourceWeekly'),
            published: formatDay(lang, a.published),
            covers: a.coversLabel,
          },
          { verbatim: ['covers'], dates: [a.published] }
        )
      : m(
          lang,
          'today.scheduleMetaNoCovers',
          {
            source: msg(lang, a.source === 'daily-digest' ? 'home.evidenceSourceDigest' : 'home.evidenceSourceWeekly'),
            published: formatDay(lang, a.published),
          },
          { dates: [a.published] }
        ),
    sep('\n'),
    m(lang, 'today.scheduleNote', {}, { optional: 'note' }),
    sep('\n', { optional: 'note' }),
    cite(citation),
    sep(' '),
    link(absoluteUrl(lang, billHref(slug))),
    sep('\n'),
    sourceLink(a.url),
  ];
  return {
    kind: 'floor-notice',
    ref: { slug, chamber: a.chamber, source: a.source },
    factDate: a.published,
    recordQuotes: [a.quote],
    href: billHref(slug),
    segments: { en: segs('en'), es: segs('es') },
  };
}

/** A roll call: chamber, number and date; question and result verbatim; the
 *  tally in the page's own words; the bill's page link. */
export function composeRollCall({ rc, date, citation }) {
  const chamberKey = rc.chamber === 'senate' ? 'today.senate' : 'today.house';
  const segs = (lang) => [
    m(lang, 'today.voteRoll', { chamber: msg(lang, chamberKey), roll: rc.roll }),
    sep(' · '),
    { k: 'date', text: formatDay(lang, date), iso: date },
    sep('\n'),
    quote(rc.question),
    sep(' — '),
    quote(rc.result),
    sep('\n'),
    m(lang, 'today.tally', { ...rc.totals }),
    sep('\n'),
    m(lang, 'today.recordNote', {}, { optional: 'note' }),
    sep('\n', { optional: 'note' }),
    cite(citation),
    sep(' '),
    link(absoluteUrl(lang, billHref(rc.bill.slug))),
  ];
  return {
    kind: 'roll-call',
    ref: { id: rc.id, slug: rc.bill.slug },
    factDate: date,
    recordQuotes: [rc.question, rc.result],
    href: billHref(rc.bill.slug),
    segments: { en: segs('en'), es: segs('es') },
  };
}

/** A bill card: the published plain-words headline with the AI label, its
 *  citation and latest-action date, the site's status word, the link. */
export function composeBillCard({ slug, citation, headline, status, lastActionDate, title }) {
  const segs = (lang) => [
    ai(headline[lang].text, headline[lang].lang),
    sep(' ('),
    label(lang, AI_LABEL_KEYS.bill),
    sep(')'),
    sep('\n'),
    m(lang, 'today.questionVehicle', { citation, date: formatDay(lang, lastActionDate) }, { dates: [lastActionDate], verbatim: ['citation'] }),
    sep(' · '),
    m(lang, `bills.statusWord.${status}`),
    sep('\n'),
    link(absoluteUrl(lang, billHref(slug))),
  ];
  return {
    kind: 'bill-card',
    ref: { slug },
    factDate: lastActionDate,
    recordQuotes: [],
    titles: [title].filter(Boolean),
    href: billHref(slug),
    segments: { en: segs('en'), es: segs('es') },
  };
}

/** The latest published update line for a Big Question: its AI-drafted name,
 *  the line (AI-written, or the record quoted), its day, the page link. */
/** @param {{ id: string, name: any, update: any, tied?: any[], trails?: any }} args */
export function composeQuestionUpdate({ id, name, update, tied = [], trails = null }) {
  const line = (lang) => (update.ai ? ai(update.text[lang], lang) : published(update.text[lang], lang));
  const segs = (lang) => [
    ai(name[lang], lang),
    sep(' ('),
    label(lang, AI_LABEL_KEYS.question),
    sep(')'),
    sep('\n'),
    line(lang),
    sep('\n'),
    { k: 'date', text: formatDay(lang, update.day), iso: update.day },
    sep('\n'),
    link(absoluteUrl(lang, `/questions/${id}`)),
  ];
  return {
    kind: 'big-question-update',
    ref: { id, update: update.id },
    factDate: update.day,
    recordQuotes: [],
    href: `/questions/${id}`,
    ...(tied.length ? { sameDayTie: true, sameDayOthers: tied.map((u) => ({ id: u.id, text: u.text })) } : {}),
    ...(trails ? { trailsRecord: true, laterSameDay: { id: trails.id, text: trails.text } } : {}),
    segments: { en: segs('en'), es: segs('es') },
  };
}

/** One line for a day's page, from the counts that page's own day list prints. */
export function composeToday({ summary }) {
  const parts = dayCountParts(summary);
  const segs = (lang) => {
    const counts =
      parts.length > 0
        ? parts.flatMap((p, i) => [...(i > 0 ? [sep(' · ')] : []), m(lang, `today.${p.key}`, { count: p.count })])
        : [m(lang, 'today.dayNoRecord')];
    return [
      m(lang, 'today.titleDated', { date: formatDay(lang, summary.date) }, { dates: [summary.date] }),
      sep(': '),
      ...counts,
      sep('\n'),
      link(absoluteUrl(lang, `/today/${summary.date}`)),
    ];
  };
  return {
    kind: 'today',
    ref: { date: summary.date, counts: { votes: summary.votes, bills: summary.bills, questions: summary.questions } },
    factDate: summary.date,
    recordQuotes: [],
    href: `/today/${summary.date}`,
    segments: { en: segs('en'), es: segs('es') },
  };
}

/** A reply card: what a PERSON could paste under a post about this bill. */
export function composeReplyCard({ slug, citation, headline, title }) {
  const segs = (lang) => [
    cite(citation),
    sep(': '),
    ai(headline[lang].text, headline[lang].lang),
    sep(' ('),
    label(lang, AI_LABEL_KEYS.bill),
    sep(')'),
    sep('\n'),
    link(absoluteUrl(lang, billHref(slug))),
  ];
  return {
    kind: 'reply-card',
    ref: { slug },
    factDate: null,
    recordQuotes: [],
    titles: [title].filter(Boolean),
    href: billHref(slug),
    note: 'For a person to paste or approve. Nothing searches for, picks or answers any post.',
    segments: { en: segs('en'), es: segs('es') },
  };
}

/* ------------------------------------------------------------------ *
 * The gates
 * ------------------------------------------------------------------ */

/** Text the script composed itself: separators, messages (with their
 *  record-verbatim values blanked), citations, dates and labels. */
function composedPieces(segments, lang) {
  return segments
    .filter((s) => s.k === 'sep' || s.k === 'msg' || s.k === 'label' || s.k === 'citation' || s.k === 'date')
    .map((s) => {
      if (s.k !== 'msg' || !s.verbatim?.length) return s.text;
      const blanked = { ...s.values };
      for (const v of s.verbatim) blanked[v] = '';
      return msg(lang, s.key, blanked);
    });
}

/** The text lintForbidden sees: everything but published AI/site text, with
 *  record quotes left in their quotation marks so stripQuoted exempts them. */
function lintableText(segments) {
  return segments
    .filter((s) => s.k !== 'ai' && s.k !== 'published' && s.k !== 'link' && s.k !== 'source-link')
    .map((s) => s.text)
    .join('');
}

const nonQuoteText = (segments) =>
  segments.filter((s) => s.k !== 'quote' && s.k !== 'link' && s.k !== 'source-link').map((s) => s.text).join('');

const GATE_CHECKS = {
  rule3(draft, lang, segments) {
    const hits = lintForbidden(lintableText(segments), lang);
    return hits.length ? `forbidden vocabulary: ${hits.join(', ')}` : null;
  },

  rule4(draft, lang, segments) {
    const hasAi = segments.some((s) => s.k === 'ai');
    const labels = segments.filter((s) => s.k === 'label');
    const allowed = Object.values(AI_LABEL_KEYS);
    for (const l of labels) {
      if (!allowed.includes(l.key) || l.text !== msg(lang, l.key)) return `label is not the site's own (${l.key})`;
    }
    if (hasAi && labels.length === 0) return 'AI-written text without the AI label';
    if (!hasAi && labels.length > 0) return 'AI label on a draft with no AI-written text';
    return null;
  },

  rule6(draft, lang, segments, ctx) {
    // Quotes are the record's own words, character for character.
    for (const s of segments.filter((x) => x.k === 'quote')) {
      if (!draft.recordQuotes.includes(s.raw)) return 'a quote that is not the record verbatim';
    }
    // A floor notice only while the live gate says it is live, quoting it.
    if (draft.kind === 'floor-notice') {
      const live = ctx.liveAnnouncement(draft.ref.slug);
      if (!live) return 'floor notice is not live (announcementFor returned null)';
      if (!draft.recordQuotes.includes(live.quote) || live.published !== draft.factDate) {
        return 'floor notice does not match the live announcement';
      }
    }
    // No date the record does not hold; no time Oravan wrote.
    const recordDates = ctx.recordDates(draft);
    for (const s of segments) {
      for (const iso of s.k === 'date' ? [s.iso] : s.dates ?? []) {
        if (!DATE_RE.test(iso) || !recordDates.has(iso)) return `date ${iso} is not in the record`;
      }
    }
    const composed = composedPieces(segments, lang).join(' ');
    if (TIME_RE.test(composed)) return 'a time of day in Oravan\'s own words';
    const undated = segments
      .filter((s) => s.k === 'sep' || s.k === 'citation')
      .map((s) => s.text)
      .join(' ');
    if (MONTH_RE.test(undated) || /\d{4}-\d{2}-\d{2}/.test(undated)) return 'a date outside a dated segment';
    // Every fact prints its date.
    if (draft.kind !== 'reply-card') {
      if (!draft.factDate || !recordDates.has(draft.factDate)) return 'a fact without its record date';
      const printed = segments.some((s) => (s.k === 'date' ? s.iso === draft.factDate : (s.dates ?? []).includes(draft.factDate)));
      if (!printed) return 'the fact date is not printed';
    }
    return null;
  },

  link(draft, lang, segments) {
    const text = render(segments);
    if (/\btel:|\bsms:|callto:/i.test(text)) return 'a phone-dialer link';
    const links = segments.filter((s) => s.k === 'link');
    if (links.length !== 1) return 'not exactly one Oravan page link';
    const url = links[0].text;
    if (!CANONICAL_RE.test(url)) return `not a canonical page URL: ${url}`;
    if (url !== `${SITE}${lang === 'es' ? '/es' : ''}${draft.href}`) return 'link is not this draft\'s own page in this language';
    if (/\/call(\/|$)/.test(url)) return 'link goes to the call flow';
    const sources = segments.filter((s) => s.k === 'source-link').map((s) => s.text);
    if (sources.length && draft.kind !== 'floor-notice') return 'a source link on a kind that carries none';
    for (const s of sources) {
      let u;
      try {
        u = new URL(s);
      } catch {
        return `unparseable source link ${s}`;
      }
      if (u.protocol !== 'https:' || !SOURCE_HOSTS.has(u.hostname) || u.search || u.hash) return `source link not allowed: ${s}`;
    }
    const allowed = new Set([url, ...sources]);
    for (const found of text.match(/https?:\/\/\S+/g) ?? []) {
      if (!allowed.has(found)) return `stray URL in the text: ${found}`;
    }
    return null;
  },

  rule9(draft, lang, segments) {
    for (const s of segments) {
      if (s.k === 'sep' && !SEPARATOR_RE.test(s.text)) return 'free text in a separator';
      if (s.k === 'citation' && !CITATION_RE.test(s.text)) return 'a citation that is not a citation';
      if (s.k === 'msg' && s.text !== msg(lang, s.key, s.values)) return `message ${s.key} not verbatim`;
    }
    const outside = nonQuoteText(segments);
    for (const re of ORG_DENY) {
      const hit = outside.match(re);
      if (hit) return `names "${hit[0]}" outside a record quote`;
    }
    return null;
  },

  'record-only'(draft, lang, segments, ctx) {
    return ctx.recordOnly?.(draft) ?? null;
  },

  'record-lag'(draft, lang, segments, ctx) {
    return ctx.recordLag?.(draft) ?? null;
  },

  president(draft, lang, segments) {
    const text = nonQuoteText(segments);
    const out = normalizePresidentStyle(text, lang, { titles: draft.titles ?? [] });
    return out.text === text ? null : 'not in "the president" style';
  },

  tone(draft, lang, segments) {
    const composed = composedPieces(segments, lang).join(' ');
    for (const re of TONE_DENY) {
      const hit = composed.match(re);
      if (hit) return `urgency or instruction: "${hit[0]}"`;
    }
    return null;
  },

  length(draft, lang, segments) {
    const long = fitTo(segments, PLATFORM_LIMITS.variants.long.maxChars);
    return long.segments ? null : `no long form: ${long.full} characters without the optional notes`;
  },
};

/** The first gate a draft fails, in GATES order, or null. Checks both
 *  languages and, for the short form, whatever survived trimming. */
export function gateDraft(draft, ctx) {
  for (const lang of LANGS) {
    if (!draft.segments?.[lang]?.length) return { gate: 'rule5', lang, reason: `no ${lang} text` };
  }
  for (const gate of GATES) {
    for (const lang of LANGS) {
      // The full draft, then each form actually offered.
      const { short, long } = variantsOf(draft.segments[lang]);
      for (const segs of [draft.segments[lang], long.segments, short.segments]) {
        if (!segs) continue;
        const reason = GATE_CHECKS[gate](draft, lang, segs, ctx);
        if (reason) return { gate, lang, reason };
      }
    }
  }
  return null;
}

/** Run every candidate through the gates; keep the passers, count the rest. */
export function admit(candidates, ctx) {
  const items = [];
  const dropped = [];
  for (const d of candidates) {
    const fail = gateDraft(d, ctx);
    if (fail) dropped.push({ kind: d.kind, ref: d.ref, ...fail });
    else items.push(d);
  }
  return { items, dropped };
}

/* ------------------------------------------------------------------ *
 * Reading the committed record
 * ------------------------------------------------------------------ */

const VOTES = votesJson;

function headlineFor(bill) {
  const en = bill.ai_headline?.trim();
  if (!en) return null;
  const es = localizeBill(bill, 'es').ai_headline?.trim() || en;
  // localizeBill falls back to English when no Spanish decode exists; the
  // draft says so rather than presenting English as Spanish.
  const esIsEnglish = es === en;
  return { en: { text: en, lang: 'en' }, es: { text: es, lang: esIsEnglish ? 'en' : 'es' } };
}

function billCardInput(bill) {
  const headline = headlineFor(bill);
  if (!headline || !bill.last_action_date) return null;
  return {
    slug: billSlug(bill),
    citation: formatCitation(bill.bill_type, bill.bill_number),
    headline,
    status: statusWord(bill),
    lastActionDate: bill.last_action_date,
    title: (bill.short_title || bill.title || '').trim(),
  };
}

/**
 * The update a reader sees first on the question's own timeline: the newest
 * day, and within that day the site's own order (selectDayUpdates: class
 * priority, then id). No second ordering is written here.
 *
 * Where the site's order rests on the id alone (two updates of the same day
 * and the same class), the data does not say which came last. The draft then
 * uses the one the page shows first and carries `tied`: the other updates'
 * text, so a reviewer sees both. Same data, same pick, every run.
 */
export function latestUpdate(id) {
  const all = getUpdates(id).filter((u) => u && DATE_RE.test(u.day ?? ''));
  if (!all.length) return null;
  const days = [...new Set(all.map((u) => u.day))].sort().reverse();
  // The whole timeline in the site's own order: newest day first, then
  // selectDayUpdates within the day.
  const ordered = days.flatMap((d) => selectDayUpdates(all.filter((u) => u.day === d), Number.POSITIVE_INFINITY));
  // The top of the page, unless it is not a record line; then the newest
  // record line. A question with no record line keeps its top update and the
  // record-only gate drops it.
  const update = ordered[0] && isRecordClass(ordered[0]) ? ordered[0] : (ordered.find(isRecordClass) ?? ordered[0]);
  if (!update?.text?.en || !update?.text?.es) return null;
  const rank = (u) => CLASS_PRIORITY[u?.class] ?? 0;
  const sameDay = ordered.filter((u) => u.day === update.day && u.id !== update.id);
  const tied = sameDay.filter((u) => rank(u) === rank(update));
  const bill = update.vehicle ? getBill(update.vehicle) : undefined;
  const trails = bill ? trailsRecord(update, sameDay, bill) : null;
  return { update, tied, trails };
}

/** Record classes: an action or a vote in the official record. */
const RECORD_CLASSES = RECORD_EVENT_CLASSES.filter((c) => c !== 'correction');
const isRecordClass = (u) => RECORD_CLASSES.includes(u?.class);

/** Compare two action sentences: whitespace, a trailing "(text: CR …)" or
 *  "(CR …)" reference, and "No:" against "No." do not make a difference. */
export function normalizeAction(x) {
  return String(x ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*\((?:text:|CR\b)[^)]*\)\s*$/, '')
    .replace(/\bNo:/g, 'No.')
    .trim();
}

/**
 * Another update of the same day on the same bill (any class) that IS the
 * bill's latest action, while the drafted update is not: the draft trails the
 * record. Returns that later update's id and text, or null. The draft still
 * quotes what the site's page shows first; this only marks it.
 */
export function trailsRecord(update, sameDayUpdates, bill) {
  const latest = [bill?.last_action_text, bill?.status_basis_text].filter(Boolean).map(normalizeAction);
  const own = normalizeAction(update?.record?.action_text);
  if (!latest.length || (own && latest.includes(own))) return null;
  const later = sameDayUpdates.find(
    (u) => u.id !== update.id && u.day === update.day && u.vehicle === update.vehicle && latest.includes(normalizeAction(u.record?.action_text)),
  );
  return later ? { id: later.id, text: later.text } : null;
}

/**
 * The lag rule, pure. Once the site's own reading of a bill (statusWord) is
 * settled (law, agreed, rejected, vetoed), an update that is not the action
 * the record settled on trails the record: it can only be a step behind.
 * `settledOn` is the bill's own action sentences (last action, status basis).
 * An update with no record sentence, or a bill that is still open, is not
 * judged here.
 * @param {{ billWord?: string, settledOn?: (string | null | undefined)[], updateText?: string | null }} args
 * @returns {string | null}
 */
export function lagReason({ billWord, settledOn = [], updateText }) {
  if (!billWord || billWord === 'open' || !updateText) return null;
  const norm = normalizeAction;
  if (settledOn.some((t) => t && norm(t) === norm(updateText))) return null;
  return `the update's action "${norm(updateText)}" is behind the record, which now reads "${billWord}"`;
}

/**
 * The live-gate and record-date lookups the gates read, from committed data.
 * Tests pass their own.
 */
export function recordContext(now) {
  const liveAnnouncement = (slug) => {
    const bill = getBill(slug);
    if (!bill) return null;
    const a = announcementFor(bill, slug, now);
    if (!a) return null;
    // The /today schedule block's "still ahead" rule (lib/today.ts): a Senate
    // program covers one meeting, the House's weekly schedule its week.
    const today = briefToday();
    if (a.covers && DATE_RE.test(a.covers)) {
      const last = a.source === 'billsthisweek' ? shiftDate(a.covers, 6) : a.covers;
      if (last < today) return null;
    }
    return a;
  };
  const recordDates = (draft) => {
    const set = new Set();
    switch (draft.kind) {
      case 'floor-notice': {
        const a = liveAnnouncement(draft.ref.slug);
        if (a) set.add(a.published);
        break;
      }
      case 'roll-call': {
        const rc = VOTES.rollCalls.find((r) => r.id === draft.ref.id);
        if (rc) set.add(rc.date);
        break;
      }
      case 'bill-card':
      case 'reply-card': {
        const b = getBill(draft.ref.slug);
        if (b?.last_action_date) set.add(b.last_action_date);
        break;
      }
      case 'big-question-update': {
        const u = getUpdates(draft.ref.id).find((x) => x.id === draft.ref.update);
        if (u) set.add(u.day);
        break;
      }
      case 'today':
        if (briefWindow().includes(draft.ref.date)) set.add(draft.ref.date);
        break;
    }
    return set;
  };
  const recordOnly = (draft) => {
    if (draft.kind !== 'big-question-update') return null;
    const u = getUpdates(draft.ref.id).find((x) => x.id === draft.ref.update);
    if (!u || isRecordClass(u)) return null;
    return `the update's class is "${u.class}", not an action or vote in the official record`;
  };
  const recordLag = (draft) => {
    if (draft.kind !== 'big-question-update') return null;
    const u = getUpdates(draft.ref.id).find((x) => x.id === draft.ref.update);
    const bill = u?.vehicle ? getBill(u.vehicle) : undefined;
    if (!u || !bill) return null;
    return lagReason({
      billWord: statusWord(bill),
      settledOn: [bill.last_action_text, bill.status_basis_text],
      updateText: u.record?.action_text,
    });
  };
  return { liveAnnouncement, recordDates, recordLag, recordOnly };
}

/** Every candidate draft the committed record supports, before the gates. */
export function collectCandidates({ now, replySlugs = null }) {
  const ctx = recordContext(now);
  const candidates = [];
  const window = briefWindow();
  const cardBills = new Map();
  const notes = [];

  // floor-notice: every bill signal whose announcement is live right now.
  for (const slug of Object.keys(floorSignalsFile().signals ?? {}).sort()) {
    const bill = getBill(slug);
    if (!bill) continue;
    const a = ctx.liveAnnouncement(slug);
    if (!a) {
      notes.push(`floor-notice ${slug}: announcement not live at ${new Date(now).toISOString()}`);
      continue;
    }
    candidates.push(composeFloorNotice({ slug, citation: formatCitation(bill.bill_type, bill.bill_number), a }));
    cardBills.set(slug, bill);
  }

  // roll-call + the bills that moved: the /today brief's own day blocks, for
  // every day in its window.
  for (const date of window) {
    const day = buildBrief(date).days[0];
    for (const rc of day.rollCalls) {
      candidates.push(composeRollCall({ rc, date, citation: rc.bill.citation }));
      const b = getBill(rc.bill.slug);
      if (b) cardBills.set(rc.bill.slug, b);
    }
    // A moved item carries the bill's reference and its /bills card, not the
    // stored bill (lib/today.ts BriefMovedBill), so the full record is looked
    // up by slug, the same way the roll calls above are.
    for (const mv of day.moved) {
      const b = getBill(mv.slug);
      if (b) cardBills.set(mv.slug, b);
    }
  }

  // bill-card: every bill above that has a published headline.
  const cardSlugs = [...cardBills.keys()].sort();
  for (const slug of cardSlugs) {
    const input = billCardInput(cardBills.get(slug));
    if (input) candidates.push(composeBillCard(input));
    else notes.push(`bill-card ${slug}: no published headline or no action date`);
  }

  // big-question-update: the latest update line of each live Big Question.
  for (const q of getLiveMoments(now).sort((a, b) => a.id.localeCompare(b.id))) {
    const latest = latestUpdate(q.id);
    if (!latest) {
      notes.push(`big-question-update ${q.id}: no update on file`);
      continue;
    }
    candidates.push(composeQuestionUpdate({ id: q.id, name: q.name, update: latest.update, tied: latest.tied, trails: latest.trails }));
  }

  // today: one line per dated page in the window, from its own counts.
  for (const date of window) candidates.push(composeToday({ summary: daySummary(date) }));

  // reply-card: the slugs asked for, else the same bills as the cards.
  for (const slug of replySlugs ?? cardSlugs) {
    const bill = getBill(slug);
    const input = bill ? billCardInput(bill) : null;
    if (input) candidates.push(composeReplyCard(input));
    else notes.push(`reply-card ${slug}: ${bill ? 'no published headline' : 'unknown slug'}`);
  }

  return { candidates, ctx, notes };
}

/** The whole queue for (committed data, now). Pure apart from the data. */
export function buildQueue({ now, replySlugs = null }) {
  const { candidates, ctx, notes } = collectCandidates({ now, replySlugs });
  const { items, dropped } = admit(candidates, ctx);
  const stats = { candidates: {}, admitted: {}, dropped: {}, shortMissing: {} };
  for (const k of KINDS) {
    stats.candidates[k] = candidates.filter((d) => d.kind === k).length;
    stats.admitted[k] = items.filter((d) => d.kind === k).length;
    stats.dropped[k] = {};
    stats.shortMissing[k] = 0;
  }
  for (const d of dropped) stats.dropped[d.kind][d.gate] = (stats.dropped[d.kind][d.gate] ?? 0) + 1;
  const out = items.map((d) => {
    const variants = {};
    for (const lang of LANGS) variants[lang] = variantsOf(d.segments[lang]);
    if (!variants.en.short.text || !variants.es.short.text) stats.shortMissing[d.kind] += 1;
    return {
      id: `${d.kind}:${Object.values(d.ref).filter((v) => typeof v === 'string' || typeof v === 'number').join(':')}`,
      kind: d.kind,
      ref: d.ref,
      factDate: d.factDate,
      aiLabel: d.segments.en.some((s) => s.k === 'label'),
      ...(d.note ? { note: d.note } : {}),
      ...(d.sameDayTie ? { sameDayTie: true, sameDayOthers: d.sameDayOthers } : {}),
      ...(d.trailsRecord ? { trailsRecord: true, laterSameDay: d.laterSameDay } : {}),
      variants: Object.fromEntries(
        LANGS.map((lang) => [
          lang,
          {
            short: publicVariant(variants[lang].short),
            long: publicVariant(variants[lang].long),
          },
        ])
      ),
    };
  });
  return {
    schema: QUEUE_SCHEMA,
    dryRun: true,
    sends: 'nothing — this file is a review queue; no code in this repo posts it anywhere',
    liveGateNow: new Date(now).toISOString(),
    briefDay: briefToday(),
    dataStamps: {
      votes: VOTES._meta?.updatedAt ?? null,
      floorSignals: floorSignalsFile()._meta?.fetched_at ?? null,
    },
    limits: PLATFORM_LIMITS,
    stats,
    dropped,
    notes,
    items: out,
  };
}

function publicVariant(v) {
  if (!v.segments) return { text: null, chars: null, reason: v.reason };
  return {
    text: v.text,
    chars: v.chars,
    // Where each piece came from; `lang: "en"` marks English inside a Spanish draft.
    segments: v.segments.map((s) => ({
      from: s.k,
      text: s.text,
      ...(s.key ? { key: s.key } : {}),
      ...(s.lang ? { lang: s.lang } : {}),
      // Record text set inside a message (a floor notice's own coverage line)
      // stays English in both languages.
      ...(s.k === 'msg' && s.verbatim?.includes('covers') ? { english: [s.values.covers] } : {}),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Output: outside the repository, always
 * ------------------------------------------------------------------ */

/** Every git working tree that contains `dir` (a worktree and its main checkout). */
function gitRootsAbove(dir) {
  const roots = [];
  let cur = resolve(dir);
  for (;;) {
    if (existsSync(join(cur, '.git'))) roots.push(cur);
    const up = dirname(cur);
    if (up === cur) return roots;
    cur = up;
  }
}

const inside = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Throws when `outDir` is inside this repository or any git working tree. */
export function assertOutsideRepo(outDir, cwd = process.cwd()) {
  const target = resolve(cwd, outDir);
  const roots = [...gitRootsAbove(cwd), ...gitRootsAbove(target)];
  for (const root of roots) {
    if (inside(target, root)) {
      throw new Error(`social-drafts: refusing to write inside a repository (${root}): ${target}`);
    }
  }
  return target;
}

export function queueMarkdown(queue) {
  const lines = [
    `# Social drafts — dry run, ${queue.briefDay}`,
    '',
    'Nothing here has been sent anywhere. Every draft is text for the owner to read.',
    '',
    `Live gate checked at ${queue.liveGateNow}. Record day ${queue.briefDay}.`,
    '',
    '| Kind | Candidates | In the queue | Dropped (gate: count) | No short form |',
    '| --- | --- | --- | --- | --- |',
    ...KINDS.map((k) => {
      const drops = Object.entries(queue.stats.dropped[k]).map(([g, n]) => `${g}: ${n}`).join(', ') || '0';
      return `| ${k} | ${queue.stats.candidates[k]} | ${queue.stats.admitted[k]} | ${drops} | ${queue.stats.shortMissing[k]} |`;
    }),
    '',
  ];
  for (const k of KINDS) {
    const items = queue.items.filter((i) => i.kind === k);
    lines.push(`## ${k} (${items.length})`, '');
    for (const item of items) {
      lines.push(`### ${item.id}`, '');
      if (item.note) lines.push(`_${item.note}_`, '');
      for (const lang of LANGS) {
        for (const size of ['short', 'long']) {
          const v = item.variants[lang][size];
          lines.push(`**${lang} · ${size}** (${v.chars ?? '—'} characters)`, '');
          lines.push(v.text ? '```text\n' + v.text + '\n```' : `_No ${size} form: ${v.reason}_`, '');
        }
        if (item.sameDayTie) {
          lines.push(`Same day, also on the record (${lang}):`, '');
          for (const o of item.sameDayOthers) lines.push(`- ${o.text[lang]}`);
          lines.push('');
        }
        if (item.trailsRecord) {
          lines.push(`Later the same day, on the record (${lang}):`, '', `- ${item.laterSameDay.text[lang]}`, '');
        }
      }
    }
  }
  if (queue.dropped.length) {
    lines.push('## Dropped', '');
    for (const d of queue.dropped) lines.push(`- ${d.kind} ${JSON.stringify(d.ref)}: ${d.gate} (${d.lang}) — ${d.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function main(argv) {
  const args = { out: DEFAULT_OUT_DIR, now: Date.now(), reply: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--now') {
      args.now = Date.parse(argv[++i]);
      if (!Number.isFinite(args.now)) throw new Error('social-drafts: --now needs an ISO instant');
    } else if (a === '--reply') args.reply.push(argv[++i]);
    else throw new Error(`social-drafts: unknown argument ${a}`);
  }
  const queue = buildQueue({ now: args.now, replySlugs: args.reply.length ? args.reply : null });
  const dir = join(assertOutsideRepo(args.out), queue.briefDay);
  assertOutsideRepo(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'queue.json'), JSON.stringify(queue, null, 2) + '\n');
  writeFileSync(join(dir, 'queue.md'), queueMarkdown(queue) + '\n');
  console.log(`social-drafts: ${queue.items.length} drafts, ${queue.dropped.length} dropped → ${dir}`);
  return queue;
}

// Run-directly guard without `import.meta` (Playwright transpiles an imported
// .mjs to CJS; scripts/president-style.mjs carries the same guard).
if (/(^|\/)social-drafts\.mjs$/.test(process.argv[1] ?? '') && /(^|\/)scripts\//.test(process.argv[1] ?? '')) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

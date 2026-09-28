import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { floorCalendarChamber, floorCalendarName } from '../lib/journey';
import {
  GLOSSARY_CATEGORIES,
  GLOSSARY_ENTRIES,
  GLOSSARY_PATH,
  GLOSSARY_TERM_IDS,
  NOMINATION_STATUS_TERMS,
  glossaryHref,
  isGlossaryTermId,
  type GlossaryTermId,
} from '../lib/glossary';
import { glossaryLocale, splitGlossaryTerms, type GlossaryLocale } from '../lib/glossary-match';
import { clientMessages } from '../i18n/client-messages';
import { lintForbidden } from '../lib/moments-gate.mjs';

/*
 * THE GLOSSARY — the registry contract (issue #181; expanded 2026-09-28 on
 * the owner's UX-inventory note C05: "I'd rather it be too many definitions
 * than not enough").
 *
 * What can break silently, and the test below that holds each:
 *
 *  1. AN ANCHOR ID IS A PUBLIC STRING. `/glossary#cloture` is a URL anyone can
 *     paste. The list is pinned literally: renaming or reordering an id has to
 *     be a decision someone typed twice, and new terms are appended.
 *  2. PARITY. Every term needs a name and a definition in both languages, and
 *     the Spanish must not be the English left in place.
 *  3. THE COPY CONSTRAINTS (issue #181): 2–4 sentences of mechanics, no dates,
 *     no predictions, no who-wins framing — and, new with the expansion, no
 *     advocacy vocabulary (the same `lintForbidden` the Big Question gate runs,
 *     CLAUDE.md rule 3).
 *  4. SOURCES. Every entry names the official page it is based on.
 *  5. AUTOMATIC MARKING (lib/glossary-match.ts): whole words, longest phrase
 *     first, once per section, and never the near-misses the committed corpus
 *     taught us about.
 *  6. WHAT SHIPS TO THE BROWSER: the definitions stay on the server.
 *  7. A RICH-TEXT TAG THAT EXISTS IN ONE LANGUAGE ONLY (the parity hole the ICU
 *     gate cannot see).
 *
 * The popover's interaction contract is a live render, so it is in
 * tests/glossary.spec.ts, not here.
 */

type Terms = Record<string, { term: string; body: string }>;
const enTerms = en.glossary.terms as Terms;
const esTerms = es.glossary.terms as Terms;
const LANGS = [
  ['en', enTerms],
  ['es', esTerms],
] as const;

const readText = (p: string) => readFileSync(p, 'utf8');

/** Every `<tag>` name opened in an ICU message, in document order. */
function richTags(message: string): string[] {
  return [...message.matchAll(/<([a-zA-Z][\w-]*)>/g)].map((m) => m[1]);
}

/** Flatten a messages object to [dottedKey, string] pairs. */
function flatten(obj: unknown, prefix = ''): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.push([key, v]);
    else if (v && typeof v === 'object') out.push(...flatten(v, key));
  }
  return out;
}

/** The ids a split marked, in order. */
const marked = (text: string, locale: GlossaryLocale, seen = new Set<GlossaryTermId>()) =>
  splitGlossaryTerms(text, locale, seen)
    .filter((p): p is { id: GlossaryTermId; text: string } => typeof p !== 'string')
    .map((p) => p.id);

/* ------------------------------------------------------------------ *
 * 1 · The registry — ids are anchors, and anchors are permanent
 * ------------------------------------------------------------------ */
test.describe('the term registry', () => {
  test('the registry is exactly these ids, in this order', () => {
    // Pinned literally rather than by count: the ids ARE the anchors
    // (/glossary#cloture), so this list is a public interface. The first
    // twelve are the ones that shipped before 2026-09-28, in their original
    // order; everything after them was appended by the expansion.
    expect([...GLOSSARY_TERM_IDS]).toEqual([
      'cloture',
      'unanimous-consent',
      'motion-to-proceed',
      'cloture-on-the-motion-to-proceed',
      'legislative-calendar',
      'union-calendar',
      'executive-calendar',
      'reported-by-committee',
      'amendment-in-the-nature-of-a-substitute',
      'budget-reconciliation',
      'cra-disapproval',
      'pro-forma-session',
      'filibuster',
      'hold',
      'quorum',
      'recess',
      'adjournment',
      'adjournment-sine-die',
      'session',
      'lame-duck-session',
      'legislative-day',
      'floor',
      'point-of-order',
      'germaneness',
      'amendment-tree',
      'motion-to-table',
      'motion-to-reconsider',
      'suspension-of-the-rules',
      'discharge-petition',
      'special-rule',
      'rules-committee',
      'motion-to-recommit',
      'previous-question',
      'committee-of-the-whole',
      'house-calendar',
      'executive-session',
      'vote-a-rama',
      'congressional-record',
      'daily-digest',
      'committee',
      'subcommittee',
      'standing-committee',
      'select-committee',
      'joint-committee',
      'hearing',
      'markup',
      'referral',
      'committee-report',
      'ranking-member',
      'conference-committee',
      'conference-report',
      'oversight',
      'bill',
      'measure',
      'act',
      'joint-resolution',
      'concurrent-resolution',
      'simple-resolution',
      'sense-of-congress',
      'amendment',
      'rider',
      'companion-bill',
      'sponsor',
      'cosponsor',
      'engrossed-bill',
      'enrolled-bill',
      'veto',
      'pocket-veto',
      'veto-override',
      'enacted',
      'public-law',
      'private-law',
      'us-code',
      'codify',
      'executive-order',
      'roll-call-vote',
      'recorded-vote',
      'voice-vote',
      'yea-and-nay',
      'present-vote',
      'not-voting',
      'tie-vote',
      'simple-majority',
      'supermajority',
      'appropriations',
      'authorization',
      'budget-resolution',
      'continuing-resolution',
      'omnibus',
      'supplemental-appropriations',
      'fiscal-year',
      'budget-authority',
      'mandatory-spending',
      'discretionary-spending',
      'entitlement',
      'deficit',
      'national-debt',
      'debt-limit',
      'government-shutdown',
      'cbo-cost-estimate',
      'sequestration',
      'earmark',
      'rescission',
      'tax-credit',
      'tax-deduction',
      'nomination',
      'advice-and-consent',
      'confirmation',
      'returned-nomination',
      'treaty',
      'resolution-of-ratification',
      'impeachment',
      'congress',
      'speaker-of-the-house',
      'majority-leader',
      'minority-leader',
      'whip',
      'president-pro-tempore',
      'presiding-officer',
      'president-of-the-senate',
      'parliamentarian',
      'caucus',
      'congressional-district',
      'at-large',
      'delegate',
      'resident-commissioner',
      'apportionment',
      'redistricting',
      'special-election',
      'vacancy',
      'member-elect',
      'senate-class',
      'inspector-general',
      'gao',
    ]);
  });

  test('the first twelve still open the list exactly as they shipped', () => {
    expect(GLOSSARY_TERM_IDS.slice(0, 12)).toEqual([
      'cloture',
      'unanimous-consent',
      'motion-to-proceed',
      'cloture-on-the-motion-to-proceed',
      'legislative-calendar',
      'union-calendar',
      'executive-calendar',
      'reported-by-committee',
      'amendment-in-the-nature-of-a-substitute',
      'budget-reconciliation',
      'cra-disapproval',
      'pro-forma-session',
    ]);
  });

  test('the expansion added at least 80 terms, with no duplicate id', () => {
    expect(GLOSSARY_TERM_IDS.length - 12).toBeGreaterThanOrEqual(80);
    expect(new Set(GLOSSARY_TERM_IDS).size).toBe(GLOSSARY_TERM_IDS.length);
  });

  test('every id is a legal URL fragment — no spaces, no case, no punctuation', () => {
    for (const id of GLOSSARY_TERM_IDS) {
      expect(id, `${id} must be lowercase kebab-case`).toMatch(/^[a-z][a-z-]*[a-z]$/);
    }
  });

  test('no term id collides with a section anchor on the page', () => {
    for (const c of GLOSSARY_CATEGORIES) {
      expect(isGlossaryTermId(`section-${c}`)).toBe(false);
    }
  });

  test('glossaryHref builds the locale-relative anchor, never an absolute URL', () => {
    expect(glossaryHref('cloture')).toBe('/glossary#cloture');
    expect(GLOSSARY_PATH).toBe('/glossary');
    for (const id of GLOSSARY_TERM_IDS) expect(glossaryHref(id)).toBe(`/glossary#${id}`);
  });

  test('isGlossaryTermId accepts every id and nothing else', () => {
    for (const id of GLOSSARY_TERM_IDS) expect(isGlossaryTermId(id)).toBe(true);
    // `germaneness` was the one issue #181 deferred; the expansion added it.
    expect(isGlossaryTermId('germaneness')).toBe(true);
    expect(isGlossaryTermId('not-a-term')).toBe(false);
    expect(isGlossaryTermId('')).toBe(false);
  });

  test('every entry sits in one of the page sections, and no section is empty', () => {
    for (const e of GLOSSARY_ENTRIES) {
      expect(GLOSSARY_CATEGORIES, `${e.id}: ${e.category}`).toContain(e.category);
    }
    for (const c of GLOSSARY_CATEGORIES) {
      expect(GLOSSARY_ENTRIES.filter((e) => e.category === c).length, c).toBeGreaterThan(0);
    }
  });

  test('every entry names an official .gov source over https', () => {
    // The definitions are paraphrases; the source is where a reader checks
    // them. Official, public-domain pages only — the Senate glossary, the
    // Rules of the House, the U.S. Code, Treasury, Census, the Archives.
    for (const e of GLOSSARY_ENTRIES) {
      const url = new URL(e.source);
      expect(url.protocol, e.id).toBe('https:');
      expect(url.hostname, `${e.id}: ${url.hostname}`).toMatch(/(^|\.)[a-z-]+\.gov$/);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2 · EN/ES parity of the entries themselves
 * ------------------------------------------------------------------ */
test.describe('bilingual parity', () => {
  test('both languages carry a term and a body for every id, and no extras', () => {
    for (const id of GLOSSARY_TERM_IDS) {
      for (const [lang, terms] of LANGS) {
        expect(terms[id], `${lang}: ${id} has no entry`).toBeTruthy();
        expect(terms[id].term.trim().length, `${lang}: ${id}.term`).toBeGreaterThan(0);
        expect(terms[id].body.trim().length, `${lang}: ${id}.body`).toBeGreaterThan(0);
      }
    }
    // An orphan entry is a term the page never prints — dead copy that reads
    // as shipped, and a reviewer's time spent on Spanish nobody sees.
    expect(Object.keys(enTerms).sort()).toEqual([...GLOSSARY_TERM_IDS].sort());
    expect(Object.keys(esTerms).sort()).toEqual([...GLOSSARY_TERM_IDS].sort());
  });

  test('the Spanish body is real Spanish, not the English one left in place', () => {
    for (const id of GLOSSARY_TERM_IDS) {
      expect(esTerms[id].body, `${id}: ES body is identical to EN`).not.toBe(enTerms[id].body);
    }
  });

  test('no entry is a message with arguments or tags — it is prose, read as-is', () => {
    for (const [lang, terms] of LANGS) {
      for (const id of GLOSSARY_TERM_IDS) {
        for (const s of [terms[id].term, terms[id].body]) {
          expect(s, `${lang}: ${id}`).not.toMatch(/[{}<>]/);
        }
      }
    }
  });

  test('the page chrome exists in both languages', () => {
    for (const key of ['title', 'metaDescription', 'intro', 'scopeNote', 'indexLabel', 'sourceLabel'] as const) {
      expect(en.glossary[key].trim().length, `en ${key}`).toBeGreaterThan(0);
      expect(es.glossary[key].trim().length, `es ${key}`).toBeGreaterThan(0);
      expect(es.glossary[key], `${key} was never translated`).not.toBe(en.glossary[key]);
    }
    expect(en.glossary.sourceLabel).toContain('{site}');
    expect(es.glossary.sourceLabel).toContain('{site}');
    for (const c of GLOSSARY_CATEGORIES) {
      const enLabel = (en.glossary.categories as Record<string, string>)[c];
      const esLabel = (es.glossary.categories as Record<string, string>)[c];
      expect(enLabel, `en categories.${c}`).toBeTruthy();
      expect(esLabel, `es categories.${c}`).toBeTruthy();
      expect(esLabel, `categories.${c} was never translated`).not.toBe(enLabel);
    }
    expect(Object.keys(en.glossary.categories).sort()).toEqual([...GLOSSARY_CATEGORIES].sort());
    expect(Object.keys(es.glossary.categories).sort()).toEqual([...GLOSSARY_CATEGORIES].sort());
  });
});

/* ------------------------------------------------------------------ *
 * 3 · What an entry is allowed to say (issue #181's constraints)
 * ------------------------------------------------------------------ */
test.describe('the copy constraints', () => {
  const sentences = (body: string) => body.split(/[.!?](?=\s|$)/).filter((s) => s.trim().length);

  test('every entry is 2–4 sentences, in both languages', () => {
    for (const id of GLOSSARY_TERM_IDS) {
      for (const [lang, terms] of LANGS) {
        const count = sentences(terms[id].body).length;
        expect(count, `${lang}: ${id} has ${count} sentences`).toBeGreaterThanOrEqual(2);
        expect(count, `${lang}: ${id} has ${count} sentences`).toBeLessThanOrEqual(4);
      }
    }
  });

  test('no entry carries a date, in either language', () => {
    // "Static mechanics, not a claim about the current bill; no dates." ONE
    // exemption, for months only: the fiscal year IS a fixed span (October 1
    // to September 30), and an entry that could not say so would be useless.
    // No entry names a year.
    const MONTH_EXEMPT = new Set(['fiscal-year']);
    const YEAR = /\b(19|20)\d{2}\b/;
    // English months are matched CASE-SENSITIVELY on purpose: a date says
    // "May", the modal verb says "may".
    const MONTHS_EN =
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/;
    const MONTHS_ES =
      /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i;
    for (const id of GLOSSARY_TERM_IDS) {
      expect(enTerms[id].body, `en: ${id} names a year`).not.toMatch(YEAR);
      expect(esTerms[id].body, `es: ${id} names a year`).not.toMatch(YEAR);
      if (MONTH_EXEMPT.has(id)) continue;
      expect(enTerms[id].body, `en: ${id} names a month`).not.toMatch(MONTHS_EN);
      expect(esTerms[id].body, `es: ${id} names a month`).not.toMatch(MONTHS_ES);
    }
  });

  test('no entry predicts anything or frames a winner', () => {
    const FORBIDDEN = [
      // predictions
      /\bwill (be voted|pass|fail|likely)\b/i,
      /\b(expected|likely) to (pass|fail|be)\b/i,
      /\bse (espera|prevé) que\b/i,
      /\bva a (aprobarse|fracasar)\b/i,
      // stakes / who-wins framing
      /\bwin(s|ner|ners|ning)?\b/i,
      /\blos(e|es|er|ers|ing)\b/i,
      /\b(defeat|victory)\b/i,
      /\b(gana|ganan|ganador|ganadores|pierde|pierden|derrota|victoria)\b/i,
    ];
    for (const id of GLOSSARY_TERM_IDS) {
      for (const [lang, terms] of LANGS) {
        for (const re of FORBIDDEN) {
          expect(terms[id].body, `${lang}: ${id} matches ${re}`).not.toMatch(re);
        }
      }
    }
  });

  test('no entry uses advocacy vocabulary — the same lint Big Questions run (rule 3)', () => {
    // lib/moments-gate.mjs's list ("fight", "stop", "block", "save", "defend",
    // party names, and their Spanish forms). A glossary that told readers a
    // hold "blocks" a nominee would be taking a side in a sentence that is
    // supposed to be mechanics.
    for (const id of GLOSSARY_TERM_IDS) {
      for (const [lang, terms] of LANGS) {
        const text = `${terms[id].term}. ${terms[id].body}`;
        expect(lintForbidden(text, lang), `${lang}: ${id}`).toEqual([]);
      }
    }
  });

  test('every calendar entry says outright that a calendar schedules nothing', () => {
    // The single most load-bearing sentence in the set. "On the floor
    // calendar" is the phrase a reader is likeliest to read as a scheduled
    // vote, and the corpus holds no scheduled-vote date for any bill.
    expect(enTerms['legislative-calendar'].body).toMatch(/schedules nothing/i);
    expect(esTerms['legislative-calendar'].body).toMatch(/no programa nada/i);
    expect(enTerms['executive-calendar'].body).toMatch(/says nothing about when/i);
    expect(esTerms['executive-calendar'].body).toMatch(/no dice nada sobre cuándo/i);
    // Added 2026-09-28 with the entry, which BillJourney now opens for a
    // "Placed on the House Calendar" record.
    expect(enTerms['house-calendar'].body).toMatch(/schedules nothing/i);
    expect(esTerms['house-calendar'].body).toMatch(/no programa nada/i);
  });

  test('the pro forma entry states the mechanic its two surfaces rest on', () => {
    expect(enTerms['pro-forma-session'].body).toMatch(/cannot be called up/i);
    expect(esTerms['pro-forma-session'].body).toMatch(
      /no se puede someter un proyecto a consideración/i
    );
    expect(enTerms['pro-forma-session'].body).toMatch(/no legislative business/i);
    expect(esTerms['pro-forma-session'].body).toMatch(/no se trata ningún asunto legislativo/i);
    for (const body of [enTerms['pro-forma-session'].body, esTerms['pro-forma-session'].body]) {
      expect(body).not.toMatch(/\brecess\b/i);
      expect(body).not.toMatch(/\breceso\b/i);
    }
  });

  test('cloture on the motion to proceed is stated as a DIFFERENT vote from cloture on the measure', () => {
    expect(enTerms['cloture-on-the-motion-to-proceed'].body).toMatch(/different vote/i);
    expect(esTerms['cloture-on-the-motion-to-proceed'].body).toMatch(/voto distinto/i);
  });

  test('the nomination entries never give the House a vote it does not have', () => {
    // The nominations ruling (2026-08-06): House-pressure copy must never
    // imply a House vote on a nomination. The glossary says so outright.
    expect(enTerms.nomination.body).toMatch(/the House has no vote/i);
    expect(esTerms.nomination.body).toMatch(/la Cámara no vota/i);
    for (const id of ['nomination', 'confirmation', 'advice-and-consent', 'returned-nomination']) {
      expect(enTerms[id].body, id).not.toMatch(/House (votes|confirms|approves)/i);
    }
  });

  test('the treaty entries do not say the Senate ratifies — it consents', () => {
    // senate.gov/about/powers-procedures/treaties.htm: "The Senate does not
    // ratify treaties." A glossary that said otherwise would be wrong on the
    // page it cites.
    expect(enTerms['resolution-of-ratification'].body).toMatch(/does not ratify/i);
    expect(esTerms['resolution-of-ratification'].body).toMatch(/no ratifica/i);
  });
});

/* ------------------------------------------------------------------ *
 * 4 · Automatic marking — lib/glossary-match.ts
 * ------------------------------------------------------------------ */
test.describe('automatic marking', () => {
  test('it marks a listed phrase and keeps the text exactly as written', () => {
    const text = 'HJRES 42 uses the Congressional Review Act to cancel a rule.';
    const parts = splitGlossaryTerms(text, 'en', new Set());
    expect(parts.map((p) => (typeof p === 'string' ? p : p.text)).join('')).toBe(text);
    expect(marked(text, 'en')).toEqual(['cra-disapproval']);
  });

  test('matching ignores case and keeps the words as the record printed them', () => {
    const parts = splitGlossaryTerms('On Motion to Suspend the Rules and Pass', 'en', new Set());
    const hit = parts.find((p) => typeof p !== 'string');
    expect(hit).toEqual({ id: 'suspension-of-the-rules', text: 'Suspend the Rules' });
  });

  test('the longest phrase wins, so the reader gets the entry for what the line says', () => {
    expect(marked('Cloture on the Motion to Proceed Rejected', 'en')).toEqual([
      'cloture-on-the-motion-to-proceed',
    ]);
    expect(marked('the Motion to Proceed was agreed to', 'en')).toEqual(['motion-to-proceed']);
  });

  test('a term is marked once per section; a new section marks it again', () => {
    const seen = new Set<GlossaryTermId>();
    expect(marked('GAO must report. GAO must also brief the committee.', 'en', seen)).toEqual([
      'gao',
    ]);
    // The same Set is the same section: already marked, stays plain.
    expect(marked('Then GAO reports again.', 'en', seen)).toEqual([]);
    // A new Set is a new section.
    expect(marked('Then GAO reports again.', 'en', new Set())).toEqual(['gao']);
  });

  test('whole words only, in both languages', () => {
    expect(marked('the fiscal years ahead', 'en')).toEqual(['fiscal-year']);
    expect(marked('prefiscal yearly', 'en')).toEqual([]);
    expect(marked('para el año fiscal federal', 'es')).toEqual(['fiscal-year']);
    // "daño fiscal" contains "año fiscal" as letters, never as words.
    expect(marked('un daño fiscal grave', 'es')).toEqual([]);
  });

  test('the near-misses the committed corpus taught us stay plain', () => {
    // Each of these is a real sentence shape from data/bills.json or
    // data/bills-es.json that an earlier phrase list marked with the wrong
    // entry. See lib/glossary-terms.ts's header.
    const en = [
      'The bill does not override existing state or local building codes.', // preemption, not a veto override
      'Riders of city buses, subways, and rural transit service', // transit riders
      'HR 7730 raises the debt limit for small businesses using Subchapter V bankruptcy', // bankruptcy threshold
      'It removes a special rule that previously treated certain hospitals differently.', // payment rule
      'adds VA, USDA, and HUD to the federal Appraisal Subcommittee', // an agency panel
      'Members of Congress will use it to direct spending and require progress reports', // a verb
      'drawn guidance must remain listed online with the date and reason for rescission', // guidance
      'Revenue earmarked for highway repair', // "set aside"
      'HR 7735 requires a joint committee of VA and Department of Defense representatives', // agencies
      'the Supplemental Nutrition Assistance Program', // SNAP
      'coverage for hearing aids', // not a committee hearing
      'both chambers are reconciling their versions.', // a conference, not reconciliation
    ];
    for (const text of en) expect(marked(text, 'en'), text).toEqual([]);
    const es = [
      'El cambio terminaría una práctica de codificación que algunos bancos usaban', // coding
      'HR 7730 sube el límite de deuda para pequeños negocios', // bankruptcy threshold
      'No implica gasto directo', // not the budget term
      'HR 7735 ordena a un comité conjunto del VA y el DoD', // agencies
    ];
    for (const text of es) expect(marked(text, 'es'), text).toEqual([]);
  });

  test('the journey sentences that only LOOK like terms are never marked', () => {
    // The automatic pass must honour the same near-miss rule the hand-wired
    // tags do (lib/glossary.ts). Their ICU selects hold only chamber names.
    for (const [lang, msgs] of [
      ['en', en],
      ['es', es],
    ] as const) {
      const journey = msgs.bill.journey as Record<string, string>;
      for (const key of [
        'nowConference',
        'nowPassedStale',
        'nowPassedBackStale',
        'backTrailerStates',
        'nowFloorMotionFailed',
      ]) {
        expect(marked(journey[key], lang), `${lang}: bill.journey.${key}`).toEqual([]);
      }
    }
  });

  test('every phrase belongs to exactly one term, and matches itself', () => {
    for (const locale of ['en', 'es'] as const) {
      const owner = new Map<string, string>();
      for (const e of GLOSSARY_ENTRIES) {
        for (const phrase of e.match[locale]) {
          const key = phrase.toLowerCase();
          expect(owner.get(key) ?? e.id, `${locale}: "${phrase}" is listed under two terms`).toBe(e.id);
          owner.set(key, e.id);
          expect(marked(phrase, locale), `${locale}: "${phrase}"`).toEqual([e.id]);
        }
      }
    }
  });

  test('glossaryLocale reads Spanish as Spanish and everything else as English', () => {
    expect(glossaryLocale('es')).toBe('es');
    expect(glossaryLocale('en')).toBe('en');
    expect(glossaryLocale('')).toBe('en');
  });
});

/* ------------------------------------------------------------------ *
 * 5 · What ships to the browser
 * ------------------------------------------------------------------ */
test.describe('the client payload', () => {
  test('the client provider carries every message except the definitions', () => {
    for (const msgs of [en, es]) {
      const client = clientMessages(msgs) as Record<string, unknown>;
      const glossary = client.glossary as Record<string, unknown>;
      expect(glossary.terms, 'glossary.terms must stay on the server').toBeUndefined();
      // The chrome stays: dropping less than we could is safe.
      expect(glossary.title).toBe(msgs.glossary.title);
      for (const key of Object.keys(msgs)) {
        if (key === 'glossary') continue;
        expect(client[key], key).toEqual((msgs as Record<string, unknown>)[key]);
      }
    }
  });

  test('the layout hands the provider the trimmed catalog', () => {
    const layout = readText('app/[locale]/layout.tsx');
    expect(layout).toContain('clientMessages(await getMessages(');
    expect(layout).toContain('<NextIntlClientProvider messages={messages}>');
  });

  test('no client module reaches the glossary data or the server half of a term', () => {
    // components/GlossaryTerm.tsx reads `glossary.terms`, which the client
    // provider no longer carries; a 'use client' module importing it would
    // throw in the browser. The data table must stay out of client chunks.
    const FORBIDDEN_IMPORTS = [
      '@/components/GlossaryTerm',
      '@/components/glossary-tags',
      '@/lib/glossary-terms',
      '@/lib/glossary-match',
      "@/lib/glossary'",
    ];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk('components');
    walk('app');
    for (const p of files) {
      const src = readText(p);
      if (!src.trimStart().startsWith("'use client'")) continue;
      for (const imp of FORBIDDEN_IMPORTS) {
        expect(src, `${p} imports ${imp}`).not.toContain(imp);
      }
    }
    // And the popover imports nothing but React.
    const popover = readText('components/GlossaryPopover.tsx');
    expect(popover.trimStart().startsWith("'use client'")).toBe(true);
    expect([...popover.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['react', 'react']);
  });
});

/* ------------------------------------------------------------------ *
 * 6 · Rich-text tags — the parity hole the ICU gate cannot see
 * ------------------------------------------------------------------ */
test.describe('in-place wiring', () => {
  test('every message that opens a rich-text tag opens the SAME tags in both languages', () => {
    const esFlat = new Map(flatten(es));
    for (const [key, value] of flatten(en)) {
      const enTags = richTags(value).sort();
      const esValue = esFlat.get(key);
      if (enTags.length === 0 && !(esValue && richTags(esValue).length)) continue;
      expect(esValue, `${key} exists in EN only`).toBeTruthy();
      expect(richTags(esValue!).sort(), `${key}: EN/ES rich-tag sets differ`).toEqual(enTags);
    }
  });

  test('a tag never leaks into a message as literal text a reader could see', () => {
    for (const [lang, msgs] of [
      ['en', en],
      ['es', es],
    ] as const) {
      for (const [key, value] of flatten(msgs)) {
        for (const tag of new Set(richTags(value))) {
          expect(value, `${lang}: ${key} opens <${tag}> without closing it`).toContain(
            `</${tag}>`
          );
        }
      }
    }
  });

  test('the wired sites carry the tags their call sites hand handlers for', () => {
    for (const msgs of [en, es] as const) {
      expect(richTags(msgs.moments.howMadeRule2).sort()).toEqual(['cloture', 'execCalendar']);
      expect(richTags(msgs.bill.journey.nowFloor)).toEqual(['floorCalendar']);
      expect(richTags(msgs.bill.journey.nowFloorStale)).toEqual(['floorCalendar']);
      expect(richTags(msgs.bill.floor.recessSenate).sort()).toEqual(['term', 'when']);
      expect(richTags(msgs.bill.floor.recessHouse).sort()).toEqual(['term', 'when']);
      expect(richTags(msgs.home.weekNoteRecess).sort()).toEqual([
        'houseWhen',
        'senateWhen',
        'term',
      ]);
    }
  });

  test('the stepper sentences that only LOOK like terms carry no tag', () => {
    const journey = en.bill.journey as Record<string, string>;
    for (const key of [
      'nowConference',
      'nowPassedStale',
      'nowPassedBackStale',
      'backTrailerStates',
      'nowFloorMotionFailed',
    ]) {
      expect(journey[key], `bill.journey.${key} must exist to be pinned`).toBeTruthy();
      expect(richTags(journey[key]), `bill.journey.${key} must carry no glossary tag`).toEqual([]);
    }
  });

  test('the wired sentences still say what they said before the tags went in', () => {
    const strip = (s: string) => s.replace(/<\/?[a-zA-Z][\w-]*>/g, '');
    expect(strip(en.moments.howMadeRule2)).toContain('a motion or cloture filing on the floor');
    expect(strip(en.moments.howMadeRule2)).toContain('the Senate Executive Calendar');
    expect(strip(es.moments.howMadeRule2)).toContain('el Calendario Ejecutivo del Senado');
    expect(strip(en.bill.journey.nowFloor)).toContain('floor calendar.');
    expect(strip(es.bill.journey.nowFloor)).toContain('calendario del pleno');
  });

  test('the nomination status map glosses only labels that ARE a term, and maps to real ids', () => {
    // "Reported by committee", "On the Executive Calendar", "Confirmed by the
    // Senate" and "Returned to the President" are the Senate's own names for
    // four procedures. "Senate floor activity" and "Committee hearing held"
    // are Oravan summarising a stage, so they stay plain.
    expect(Object.keys(NOMINATION_STATUS_TERMS).sort()).toEqual([
      'confirmed',
      'exec_calendar',
      'reported',
      'returned',
    ]);
    for (const [status, id] of Object.entries(NOMINATION_STATUS_TERMS)) {
      expect(isGlossaryTermId(id), `${status} → ${id}`).toBe(true);
      const statuses = en.nominations.status as Record<string, string>;
      expect(statuses[status], `nominations.status.${status} does not exist`).toBeTruthy();
    }
    expect(en.nominations.status.reported).toBe('Reported by committee');
    expect(en.nominations.status.exec_calendar).toBe('On the Executive Calendar');
    expect(en.nominations.status.confirmed).toBe('Confirmed by the Senate');
    expect(en.nominations.status.returned).toBe('Returned to the President');
  });
});

/* ------------------------------------------------------------------ *
 * 7 · Source-level wiring pins
 *
 * This suite cannot render an Oravan component (Playwright compiles every
 * .tsx through its own component-testing JSX runtime). What IS assertable
 * without a browser is that the wiring exists at all. The popover's contract
 * — a button that opens in place and never navigates; hover, click, tap,
 * keyboard, Escape — is asserted on the rendered page (tests/glossary.spec.ts,
 * tests/glossary-wiring.spec.ts).
 * ------------------------------------------------------------------ */
test.describe('source wiring', () => {
  test('the page is in the sitemap and linked from the footer', () => {
    expect(readText('app/sitemap.ts')).toContain("'/glossary'");
    const footer = readText('components/Footer.tsx');
    expect(footer).toContain("{ href: '/glossary', key: 'footer.glossary' }");
    expect(en.common.footer.glossary).toBe('Glossary');
    expect(es.common.footer.glossary).toBe('Glosario');
  });

  test('every wired call site hands next-intl a handler for the tag its message opens', () => {
    const questions = readText('app/[locale]/questions/page.tsx');
    expect(questions).toContain("from '@/components/glossary-tags'");
    // The DIRECTIVE is only a directive on the first line. Neither the tag
    // helpers nor the server half of a term may carry one; the popover must.
    expect(readText('components/glossary-tags.tsx').trimStart().startsWith("'use client'")).toBe(
      false
    );
    expect(readText('components/GlossaryTerm.tsx').trimStart().startsWith("'use client'")).toBe(
      false
    );
    expect(questions).toContain("t.rich('moments.howMadeRule2'");
    expect(questions).toContain("cloture: glossaryTag('cloture')");
    expect(questions).toContain("execCalendar: glossaryTag('executive-calendar')");

    const journey = readText('components/BillJourney.tsx');
    expect(journey).toContain('t.rich(journey.nowKey');
    expect(journey).toContain('floorCalendar');

    const recessNote = readText('components/FloorRecessNote.tsx');
    expect(recessNote, 'FloorRecessNote imports the server-safe tag helper').toContain(
      "from '@/components/glossary-tags'"
    );
    expect(recessNote, 'FloorRecessNote hands a handler for <term>').toContain(
      "term: glossaryTag('pro-forma-session')"
    );

    for (const path of [
      'app/[locale]/nominations/[slug]/page.tsx',
      'components/MomentNominationCard.tsx',
    ]) {
      expect(readText(path), `${path} renders the status label itself`).toContain(
        '<NominationStatusLabel'
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * 8 · The calendar the record actually named
 * ------------------------------------------------------------------ */
test.describe('floorCalendarName', () => {
  test('reads WHICH calendar, and keeps the House pair apart', () => {
    expect(
      floorCalendarName('Placed on Senate Legislative Calendar under General Orders. Calendar No. 412.')
    ).toBe('senate-legislative');
    expect(floorCalendarName('Placed on the Union Calendar, Calendar No. 219.')).toBe('union');
    // THE ONE THAT MATTERS: the House keeps two calendars and each now has
    // its own entry. Collapsing them would open the Union Calendar's entry on
    // a "House Calendar" placement — a false claim on a real record.
    expect(floorCalendarName('Placed on the House Calendar, Calendar No. 8.')).toBe('house');
    expect(floorCalendarName('Motion to proceed to consideration of measure rejected.')).toBeNull();
    expect(floorCalendarName(null)).toBeNull();
  });

  test('it agrees with floorCalendarChamber on every text, always', () => {
    const texts = [
      'Placed on Senate Legislative Calendar under General Orders. Calendar No. 412.',
      'Placed on the Union Calendar, Calendar No. 219.',
      'Placed on the House Calendar, Calendar No. 8.',
      'Placed on Senate Calendar, Calendar No. 3.',
      'Cloture motion on the motion to proceed presented in Senate.',
      null,
    ];
    for (const text of texts) {
      const name = floorCalendarName(text);
      const chamber = floorCalendarChamber(text);
      expect(name === null, `${text}`).toBe(chamber === null);
      if (name) expect(name === 'senate-legislative' ? 'senate' : 'house').toBe(chamber);
    }
  });
});

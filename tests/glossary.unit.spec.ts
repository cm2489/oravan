import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { floorCalendarChamber, floorCalendarName } from '../lib/journey';
import {
  GLOSSARY_PATH,
  GLOSSARY_TERM_IDS,
  NOMINATION_STATUS_TERMS,
  glossaryHref,
  isGlossaryTermId,
} from '../lib/glossary';

/*
 * THE PROCEDURAL GLOSSARY — the registry contract (issue #181).
 *
 * Three things here can break silently, and each has a test below:
 *
 *  1. AN ANCHOR ID IS A PUBLIC STRING. `/glossary#cloture` is a URL the issue
 *     names explicitly, every popover's "Full glossary →" builds one, and
 *     anyone can paste one into a message. Renaming an id breaks all of those
 *     at once and nothing else would notice, so the list is pinned literally:
 *     a rename has to be a decision someone typed twice.
 *
 *  2. A RICH-TEXT TAG THAT EXISTS IN ONE LANGUAGE ONLY. The bilingual gate
 *     (scripts/check-messages-parity.mjs) compares ICU ARGUMENTS, and a
 *     `<cloture>` tag is not an argument — so an English sentence carrying the
 *     link and a Spanish one that quietly lost it is full parity by that gate
 *     and a Spanish reader who never gets the explainer. Same shape of hole
 *     the ICU half was added to close, one layer over.
 *
 *  3. THE COPY CONSTRAINTS. The issue fixes what an entry may say — 2–4
 *     sentences of mechanics, never stakes, never who-wins framing, no dates,
 *     no predictions — and those are exactly the rules a later edit softens
 *     without meaning to. A dated example would additionally collide with
 *     DESIGN.md's no-implied-vote-date rule, which is why the calendar entries
 *     are the ones that state the absence of a schedule outright.
 *
 * The component's own a11y contract is a live render, so it is in
 * tests/glossary.spec.ts, not here.
 */

type Terms = Record<string, { term: string; body: string }>;
const enTerms = en.glossary.terms as Terms;
const esTerms = es.glossary.terms as Terms;

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

/* ------------------------------------------------------------------ *
 * 1 · The registry — ids are anchors, and anchors are permanent
 * ------------------------------------------------------------------ */
test.describe('the term registry', () => {
  test('the first batch is exactly these eleven ids, in this order', () => {
    // Pinned literally rather than by count: the ids ARE the anchors
    // (/glossary#cloture), so this list is a public interface. Adding a term
    // is a one-line edit here; renaming one is a decision.
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
    ]);
  });

  test('every id is a legal URL fragment — no spaces, no case, no punctuation', () => {
    for (const id of GLOSSARY_TERM_IDS) {
      expect(id, `${id} must be lowercase kebab-case`).toMatch(/^[a-z][a-z-]*[a-z]$/);
    }
  });

  test('glossaryHref builds the locale-relative anchor, never an absolute URL', () => {
    // Absolute would bypass the i18n Link and drop a Spanish reader onto /en.
    expect(glossaryHref('cloture')).toBe('/glossary#cloture');
    expect(GLOSSARY_PATH).toBe('/glossary');
    for (const id of GLOSSARY_TERM_IDS) expect(glossaryHref(id)).toBe(`/glossary#${id}`);
  });

  test('isGlossaryTermId accepts every id and nothing else', () => {
    for (const id of GLOSSARY_TERM_IDS) expect(isGlossaryTermId(id)).toBe(true);
    expect(isGlossaryTermId('germaneness')).toBe(false); // the deferred one
    expect(isGlossaryTermId('')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 2 · EN/ES parity of the entries themselves
 * ------------------------------------------------------------------ */
test.describe('bilingual parity', () => {
  test('both languages carry a term and a body for every id, and no extras', () => {
    for (const id of GLOSSARY_TERM_IDS) {
      for (const [lang, terms] of [
        ['en', enTerms],
        ['es', esTerms],
      ] as const) {
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

  test('the page chrome exists in both languages', () => {
    for (const key of ['title', 'metaDescription', 'intro', 'scopeNote', 'indexLabel', 'fullGlossary'] as const) {
      expect(en.glossary[key].trim().length, `en ${key}`).toBeGreaterThan(0);
      expect(es.glossary[key].trim().length, `es ${key}`).toBeGreaterThan(0);
      expect(es.glossary[key], `${key} was never translated`).not.toBe(en.glossary[key]);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3 · What an entry is allowed to say (issue #181's constraints)
 * ------------------------------------------------------------------ */
test.describe('the copy constraints', () => {
  const sentences = (body: string) => body.split(/[.!?](?=\s|$)/).filter((s) => s.trim().length);

  test('every entry is 2–4 sentences, in both languages', () => {
    for (const id of GLOSSARY_TERM_IDS) {
      for (const [lang, terms] of [
        ['en', enTerms],
        ['es', esTerms],
      ] as const) {
        const count = sentences(terms[id].body).length;
        expect(count, `${lang}: ${id} has ${count} sentences`).toBeGreaterThanOrEqual(2);
        expect(count, `${lang}: ${id} has ${count} sentences`).toBeLessThanOrEqual(4);
      }
    }
  });

  test('no entry carries a date, in either language', () => {
    // The issue: "static mechanics, not a claim about the current bill; no
    // dates". DESIGN.md's no-implied-vote-date rule is the same constraint
    // arriving from the other direction.
    const YEAR = /\b(19|20)\d{2}\b/;
    // English months are matched CASE-SENSITIVELY on purpose: a date says
    // "May", the modal verb says "may", and a case-blind list bans the verb
    // from every entry that needs it. Spanish month names collide with
    // nothing, so that half stays case-blind.
    const MONTHS_EN =
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/;
    const MONTHS_ES =
      /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/i;
    for (const id of GLOSSARY_TERM_IDS) {
      expect(enTerms[id].body, `en: ${id} names a year`).not.toMatch(YEAR);
      expect(esTerms[id].body, `es: ${id} names a year`).not.toMatch(YEAR);
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
      for (const [lang, terms] of [
        ['en', enTerms],
        ['es', esTerms],
      ] as const) {
        for (const re of FORBIDDEN) {
          expect(terms[id].body, `${lang}: ${id} matches ${re}`).not.toMatch(re);
        }
      }
    }
  });

  test('both calendar entries say outright that a calendar schedules nothing', () => {
    // The single most load-bearing sentence in the batch. "On the floor
    // calendar" is the phrase a reader is likeliest to read as a scheduled
    // vote, and DESIGN.md's still-open printed-date ruling exists because the
    // corpus holds no scheduled-vote date for any bill. If a later edit
    // softens these two, the glossary starts implying what the data cannot say.
    expect(enTerms['legislative-calendar'].body).toMatch(/schedules nothing/i);
    expect(esTerms['legislative-calendar'].body).toMatch(/no programa nada/i);
    expect(enTerms['executive-calendar'].body).toMatch(/says nothing about when/i);
    expect(esTerms['executive-calendar'].body).toMatch(/no dice nada sobre cuándo/i);
  });

  test('cloture on the motion to proceed is stated as a DIFFERENT vote from cloture on the measure', () => {
    // The issue calls this out by name ("two different votes — the S. 4784
    // record shows exactly why the distinction matters"), so the distinction
    // is the entry's reason to exist, not a nicety of its wording.
    expect(enTerms['cloture-on-the-motion-to-proceed'].body).toMatch(/different vote/i);
    expect(esTerms['cloture-on-the-motion-to-proceed'].body).toMatch(/voto distinto/i);
  });
});

/* ------------------------------------------------------------------ *
 * 4 · Rich-text tags — the parity hole the ICU gate cannot see
 * ------------------------------------------------------------------ */
test.describe('in-place wiring', () => {
  test('every message that opens a rich-text tag opens the SAME tags in both languages', () => {
    // scripts/check-messages-parity.mjs compares ICU arguments; a tag is not
    // one. An EN sentence carrying the glossary link beside an ES sentence
    // that lost it passes that gate and ships a Spanish reader a dead end.
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
    // Every tag below is opened AND closed. A stray `<cloture>` with no
    // closing partner renders as characters on the page.
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
    // Each pairing below is a live wiring site. If a message loses its tag the
    // link silently disappears; if a call site loses its handler next-intl
    // throws on render. Both directions are asserted: the tag here, the
    // handler in the source pins below.
    for (const msgs of [en, es] as const) {
      expect(richTags(msgs.moments.howMadeRule2).sort()).toEqual(['cloture', 'execCalendar']);
      expect(richTags(msgs.bill.journey.nowFloor)).toEqual(['floorCalendar']);
      expect(richTags(msgs.bill.journey.nowFloorStale)).toEqual(['floorCalendar']);
    }
  });

  test('the wired sentences still say what they said before the tags went in', () => {
    // The tags are markup, not a rewrite. Stripping them must give back copy
    // that still carries the facts the surrounding gates pin — the published
    // 45-day window (tests/moment-scaffold.unit.spec.ts) among them.
    const strip = (s: string) => s.replace(/<\/?[a-zA-Z][\w-]*>/g, '');
    expect(strip(en.moments.howMadeRule2)).toContain('a motion or cloture filing on the floor');
    expect(strip(en.moments.howMadeRule2)).toContain('the Senate Executive Calendar');
    expect(strip(es.moments.howMadeRule2)).toContain('el Calendario Ejecutivo del Senado');
    expect(strip(en.bill.journey.nowFloor)).toContain('floor calendar.');
    expect(strip(es.bill.journey.nowFloor)).toContain('calendario del pleno');
  });

  test('the nomination status map glosses only labels that ARE a term, and maps to real ids', () => {
    // "Reported by committee" and "On the Executive Calendar" are the Senate's
    // own names for two procedures. "Senate floor activity" is Oravan
    // summarising a stage, so it stays plain — a trigger there would promise
    // an entry that does not describe what the reader is looking at.
    expect(Object.keys(NOMINATION_STATUS_TERMS).sort()).toEqual(['exec_calendar', 'reported']);
    for (const [status, id] of Object.entries(NOMINATION_STATUS_TERMS)) {
      expect(isGlossaryTermId(id), `${status} → ${id}`).toBe(true);
      const statuses = en.nominations.status as Record<string, string>;
      expect(statuses[status], `nominations.status.${status} does not exist`).toBeTruthy();
    }
    expect(en.nominations.status.reported).toBe('Reported by committee');
    expect(en.nominations.status.exec_calendar).toBe('On the Executive Calendar');
  });
});

/* ------------------------------------------------------------------ *
 * 5 · Source-level wiring pins
 *
 * This suite cannot render an Oravan component (Playwright compiles every
 * .tsx through its own component-testing JSX runtime, so react-dom/server
 * gets inert objects — see tests/donate.unit.spec.ts's header). What IS
 * assertable without a browser is that the wiring exists at all, which is the
 * half a live e2e cannot cheaply prove for every call site.
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
    // From the NO-directive module, never from the 'use client' one: every
    // export of a 'use client' file is a client reference, and a server
    // component calling one throws at render rather than at build (it 500'd
    // /questions in both locales once). See components/glossary-tags.tsx.
    expect(questions).toContain("from '@/components/glossary-tags'");
    // The DIRECTIVE, which is only a directive on the first line — the file's
    // header comment quotes the string while explaining exactly this.
    expect(readText('components/glossary-tags.tsx').trimStart().startsWith("'use client'")).toBe(
      false
    );
    expect(readText('components/GlossaryTerm.tsx').trimStart().startsWith("'use client'")).toBe(
      true
    );
    expect(questions).toContain("t.rich('moments.howMadeRule2'");
    expect(questions).toContain("cloture: glossaryTag('cloture')");
    expect(questions).toContain("execCalendar: glossaryTag('executive-calendar')");

    const journey = readText('components/BillJourney.tsx');
    expect(journey).toContain('t.rich(journey.nowKey');
    expect(journey).toContain('floorCalendar');

    // One renderer for the nomination status label, used by both surfaces.
    for (const path of [
      'app/[locale]/nominations/[slug]/page.tsx',
      'components/MomentNominationCard.tsx',
    ]) {
      expect(readText(path), `${path} renders the status label itself`).toContain(
        '<NominationStatusLabel'
      );
    }
  });

  test('the trigger is ink and never amber, and introduces no third radius', () => {
    // DESIGN.md's colour law: `urgent` carries ONE dated floor fact with the
    // date printed beside it, and a glossary entry is dateless by
    // construction. The shape law: two radii, assigned by scale — the panel is
    // hand-sized (control), the trigger is a run of text and takes none.
    // Block comments stripped first — this file EXPLAINS the laws it obeys,
    // and a scan that reads its own reasoning as a violation is a gate that
    // punishes documentation.
    const src = readText('components/GlossaryTerm.tsx').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/\b(bg|text|border|decoration)-urgent\b/);
    expect(src).toContain('rounded-control');
    expect(src).not.toContain('rounded-stamp');
    expect(src).not.toContain('rounded-full');
    // The one radius that is never a component's: globals.css owns it for the
    // focus indicator.
    expect(src).not.toContain('rounded-hair');
  });
});

/* ------------------------------------------------------------------ *
 * 6 · The calendar the record actually named
 * ------------------------------------------------------------------ */
test.describe('floorCalendarName', () => {
  test('reads WHICH calendar, and keeps the House pair apart', () => {
    expect(
      floorCalendarName('Placed on Senate Legislative Calendar under General Orders. Calendar No. 412.')
    ).toBe('senate-legislative');
    expect(floorCalendarName('Placed on the Union Calendar, Calendar No. 219.')).toBe('union');
    // THE ONE THAT MATTERS: the House keeps two calendars and the placement
    // regex accepts both. Collapsing them would send a "House Calendar"
    // placement to the Union Calendar entry — a false claim on a real record.
    expect(floorCalendarName('Placed on the House Calendar, Calendar No. 8.')).toBe('house');
    expect(floorCalendarName('Motion to proceed to consideration of measure rejected.')).toBeNull();
    expect(floorCalendarName(null)).toBeNull();
  });

  test('it agrees with floorCalendarChamber on every text, always', () => {
    // Two derivations of one fact is how they drift. This one is built on the
    // other on purpose (no second copy of the drift-pinned regex), and this
    // asserts the relationship holds rather than trusting the implementation.
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

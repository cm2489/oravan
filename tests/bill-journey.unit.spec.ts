import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
// From lib/journey.ts, not from the component. #220 moved the ending
// derivation there and generalized it to all three endings; this branch had
// moved the boolean it replaced for a narrower reason — the stepper now
// renders a glossary link, which pulls in `@/i18n/navigation`, and that chain
// does not resolve inside this runner. Both reasons point the same way, and
// #220's function is the one that survives.
import { deriveJourney, journeyEnding } from '../lib/journey';
// The fetcher's closed vehicle allowlist — the ONE place the corpus's type
// vocabulary is decided. Imported from the .mjs directly (the same pattern
// tests/journey.unit.spec.ts uses for moment-candidates.mjs); the module
// checks CONGRESS_API_KEY at first fetch, never at import.
import { BILL_TYPES } from '../scripts/congress-fetch.mjs';

/*
 * THE STEPPER'S ONE PROCEDURAL CLAIM ABOUT THE END OF THE ROAD.
 *
 * components/BillJourney.tsx's own header promises the strip "cannot
 * hallucinate procedure", and until 2026-08-09 it did exactly that on every
 * CONCURRENT resolution: step five read "President's desk" and the trailer
 * underneath said the measure goes back to its origin chamber "before reaching
 * the President". A concurrent resolution is never presented to the President
 * and never becomes law — it is the two chambers agreeing with each other
 * (budget resolutions, War Powers directives, adjournment). Six live pages
 * carried the false sentence, in both languages.
 *
 * 2026-08-12 (owner ruling D5) closes the class that fix documented as its
 * known limit: a joint resolution PROPOSING A CONSTITUTIONAL AMENDMENT is not
 * presented to the President either. Article V sends it to the states, and
 * three quarters of them must ratify. 16 corpus pages were promising it a
 * President's desk.
 *
 * The predicate moved to lib/journey.ts in the same change, because the answer
 * is no longer readable from the bill TYPE alone — it needs the record's own
 * title — and every derivation the strip renders lives there.
 *
 * These pin the predicate, the four ending strings, and — the part that
 * actually regresses — that no non-presented string names the President as a
 * destination, in either language.
 */

interface CorpusBill {
  full_identifier: string;
  bill_type: string;
  bill_number: number;
  congress_number: number;
  title: string;
}

const corpus: CorpusBill[] = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'bills.json'), 'utf8')
);

test.describe('journeyEnding', () => {
  test('concurrent resolutions end at adoption by both chambers', () => {
    expect(journeyEnding('hconres')).toBe('bothChambers');
    expect(journeyEnding('sconres')).toBe('bothChambers');
    // Case-insensitive: slugs are lowercased, stored types are not guaranteed to be.
    expect(journeyEnding('HConRes')).toBe('bothChambers');
    // A con-res is a con-res whatever its title says — the type alone settles
    // it, so an Article V-shaped title cannot move one to the states branch
    // (a concurrent resolution cannot propose an amendment).
    expect(
      journeyEnding('hconres', 'Proposing an amendment to the Constitution of the United States.')
    ).toBe('bothChambers');
  });

  test('bills and ordinary joint resolutions end at the President', () => {
    // A joint resolution IS presented unless it proposes an amendment: CRA
    // disapprovals, continuing resolutions, War Powers directives.
    for (const type of ['hr', 's', 'hjres', 'sjres']) {
      expect(journeyEnding(type), type).toBe('president');
    }
    // FIXTURE — a real, ordinary hjres from the corpus (a CRA disapproval).
    // Many hjres are ordinary; this is the record that proves the new branch
    // did not swallow its own vehicle type.
    expect(
      journeyEnding(
        'hjres',
        'Providing for congressional disapproval under chapter 8 of title 5, United States Code, of the rule submitted by the Environmental Protection Agency relating to "Greenhouse Gas Emissions Standards".'
      )
    ).toBe('president');
    // And one whose title contains "Amendment" for an unrelated reason — the
    // D.C. Council's "Temporary Amendment Act" disapprovals.
    expect(
      journeyEnding(
        'hjres',
        'Disapproving the action of the District of Columbia Council in approving the D.C. Income and Franchise Tax Conformity and Revision Temporary Amendment Act of 2025.'
      )
    ).toBe('president');
  });

  test('FIXTURE: an Article V joint resolution goes to the states, never the President', () => {
    // Both title shapes Congress actually writes, both chambers.
    const articleV = [
      ['hjres', 'Proposing an amendment to the Constitution of the United States to limit the number of terms that a Member of Congress may serve.'],
      ['hjres', 'Proposing a balanced budget amendment to the Constitution of the United States.'],
      ['sjres', 'A joint resolution proposing an amendment to the Constitution of the United States relative to the fundamental right to vote.'],
    ] as const;
    for (const [type, title] of articleV) {
      expect(journeyEnding(type, title), title).toBe('states');
    }
  });

  test('the title is only consulted for joint resolutions', () => {
    // An ordinary bill cannot propose an amendment — Article V names joint
    // resolutions — so even the exact formula leaves an `hr` presented.
    expect(
      journeyEnding('hr', 'Proposing an amendment to the Constitution of the United States.')
    ).toBe('president');
  });

  test('FAIL TOWARD EXCLUSION: a near-miss keeps the ordinary ending', () => {
    // hjres-80-119, live in the corpus. It concerns a constitutional amendment
    // but does not PROPOSE one under Article V, and what its path actually is
    // has been litigated rather than settled. The heuristic must not claim it.
    expect(journeyEnding('hjres', 'Establishing the ratification of the Equal Rights Amendment.')).toBe(
      'president'
    );
    // No title, null title, empty title — all the ordinary path.
    expect(journeyEnding('hjres')).toBe('president');
    expect(journeyEnding('hjres', null)).toBe('president');
    expect(journeyEnding('hjres', '')).toBe('president');
    // "Constitution" alone is not the formula.
    expect(journeyEnding('sjres', 'A joint resolution honoring the Constitution of the United States.')).toBe(
      'president'
    );
  });

  test('an unrecognized type defaults to the presented path', () => {
    // Deliberate: presentment is the rule (Article I §7) and both exceptions
    // are closed and constitutional, so an unknown string reads as an ordinary
    // bill rather than silently acquiring a resolution ending. What keeps that
    // safe is the fetcher's closed allowlist, pinned below.
    expect(journeyEnding('')).toBe('president');
  });

  test('deriveJourney carries the ending, and reads the title to get it', () => {
    // The stepper renders `journey.ending` — the prop it used to take is gone,
    // so the derivation is the only thing that can be wrong.
    const articleV = deriveJourney({
      bill_type: 'hjres',
      status: 'committee',
      last_action_text: 'Referred to the House Committee on the Judiciary.',
      last_action_date: null,
      title: 'Proposing an amendment to the Constitution of the United States to provide for balanced budgets for the Government.',
    } as Parameters<typeof deriveJourney>[0]);
    expect(articleV.ending).toBe('states');

    const ordinary = deriveJourney({
      bill_type: 'hjres',
      status: 'committee',
      last_action_text: 'Referred to the House Committee on the Judiciary.',
      last_action_date: null,
      title: 'Providing for congressional disapproval under chapter 8 of title 5, United States Code.',
    } as Parameters<typeof deriveJourney>[0]);
    expect(ordinary.ending).toBe('president');

    // A caller that omits the title (the derivation's other consumers) keeps
    // the ordinary ending rather than throwing or guessing.
    const untitled = deriveJourney({
      bill_type: 'hjres',
      status: 'committee',
      last_action_text: null,
      last_action_date: null,
    } as Parameters<typeof deriveJourney>[0]);
    expect(untitled.ending).toBe('president');

    expect(
      deriveJourney({
        bill_type: 'sconres',
        status: 'floor_vote',
        last_action_text: null,
        last_action_date: null,
      } as Parameters<typeof deriveJourney>[0]).ending
    ).toBe('bothChambers');
  });

  test('the fetched vocabulary is exactly the six types this predicate reasons about', () => {
    // The corpus can only ever hold what scripts/congress-fetch.mjs fetches,
    // and that allowlist is closed (simple resolutions hres/sres are excluded
    // on purpose — see its comment). Both directions are pinned: nothing
    // unreasoned-about can arrive, and a future widening of the allowlist —
    // hres/sres would break the stepper harder than con-res did, since a
    // simple resolution has no other-chamber step at all — fails HERE rather
    // than shipping a fifth-step lie.
    expect([...BILL_TYPES].sort()).toEqual(
      ['hconres', 'hjres', 'hr', 's', 'sconres', 'sjres'].sort()
    );
    const seen = new Set(corpus.map((b) => b.bill_type));
    expect([...seen].filter((t) => !BILL_TYPES.has(t))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * THE CORPUS SWEEP — the flag-first condition on the D5 ruling.
 *
 * The Article V branch is the only part of this predicate that reads free
 * text, so the whole corpus is swept here rather than trusted. The ground
 * truth measured on 2026-08-12: 97 joint resolutions, of which exactly 16
 * carry "Constitution" in the title and all 16 are Article V proposals — 12
 * "Proposing an amendment to the Constitution…", 4 "Proposing a balanced
 * budget amendment to the Constitution…". No false positives, no Article V
 * proposal outside that set.
 * ------------------------------------------------------------------ */
test.describe('the Article V sweep over the live corpus', () => {
  const jointRes = corpus.filter((b) => b.bill_type === 'hjres' || b.bill_type === 'sjres');
  const states = corpus.filter((b) => journeyEnding(b.bill_type, b.title) === 'states');

  test('only joint resolutions ever land on the states path', () => {
    // A bill, a con-res, a simple resolution — none can propose an amendment,
    // whatever their title happens to say.
    expect(states.filter((b) => b.bill_type !== 'hjres' && b.bill_type !== 'sjres')).toEqual([]);
    expect(jointRes.length).toBeGreaterThan(0);
  });

  test('the count stays in the range the sweep measured', () => {
    /*
     * A RANGE, not the literal 16, and deliberately so. The corpus is rebuilt
     * nightly and this file is not: pinning 16 would red an unrelated PR the
     * morning after Congress introduces a seventeenth amendment proposal, and
     * that is the tripwire class this project has already ruled against. The
     * band is wide enough for ordinary drift in a two-year Congress and tight
     * enough that a heuristic which started matching CRA disapprovals (there
     * are ~60 of them) or stopped matching anything fails here.
     */
    expect(states.length).toBeGreaterThanOrEqual(8);
    expect(states.length).toBeLessThanOrEqual(40);
    // And it can never be most of the joint resolutions — the ordinary joint
    // resolution genuinely IS presented to the President.
    expect(states.length).toBeLessThan(jointRes.length / 2);
  });

  test('every matched record really carries the Article V formula', () => {
    // The assertion is on the RECORD, not on the regex: read the title back
    // and check it says what the branch claims it says.
    for (const b of states) {
      expect(b.title, b.full_identifier).toMatch(/amendment to the Constitution/i);
      expect(b.title, b.full_identifier).toMatch(/propos/i);
    }
  });

  test('no joint resolution titled as an amendment to the Constitution is left presented', () => {
    /*
     * The other direction, and the one that catches a NEW title shape rather
     * than a bad one. Any joint resolution whose title says "amendment to the
     * Constitution" and which this predicate still routes to the President's
     * desk is either a title formula the regex has not seen or a genuine
     * near-miss that needs a human ruling. Zero today.
     */
    const missed = jointRes.filter(
      (b) =>
        /amendment to the Constitution/i.test(b.title) &&
        journeyEnding(b.bill_type, b.title) !== 'states'
    );
    expect(missed.map((b) => b.full_identifier)).toEqual([]);
  });

  test('the near-miss on the corpus stays excluded', () => {
    // hjres-80-119 "Establishing the ratification of the Equal Rights
    // Amendment" — mentions an amendment, proposes none. Skipped when the
    // nightly corpus no longer carries it; asserted whenever it does.
    const era = corpus.find((b) => b.full_identifier === 'hjres-80-119');
    if (era) expect(journeyEnding(era.bill_type, era.title)).toBe('president');
  });
});

test.describe('the both-chambers ending, in both languages', () => {
  /*
   * The claim under test is PRESENTMENT, not the word "President".
   *
   * The con-res trailer names the President on purpose — to say the measure
   * never reaches one. So the assertions are: the step LABEL never names a
   * President (it is a destination, and this vehicle's destination is not
   * his desk), and the TRAILER carries the denial while carrying none of the
   * presented path's affirmative claim.
   */
  const locales = [
    {
      locale: 'en',
      messages: en,
      president: /president/i,
      affirmative: /before reaching the President/,
      denial: /never goes to the President and does not become law/,
      statesDenial: /never goes to the President/,
      states: /to the states/,
      ratify: /ratify/i,
      chambers: [/House/, /Senate/],
    },
    {
      locale: 'es',
      messages: es,
      president: /presidente/i,
      affirmative: /antes de llegar al Presidente/,
      denial: /nunca llega al Presidente y no se convierte en ley/,
      statesDenial: /nunca llega al Presidente/,
      states: /a los estados/,
      ratify: /ratificar/i,
      chambers: [/Cámara/, /Senado/],
    },
  ] as const;

  for (const {
    locale,
    messages,
    president,
    affirmative,
    denial,
    statesDenial,
    states,
    ratify,
    chambers,
  } of locales) {
    test(`${locale}: the both-chambers ending denies presentment instead of claiming it`, () => {
      const t = createTranslator({ locale, messages, namespace: 'bill.journey' });
      const step = t('stepBothChambers');
      const trailer = t('backTrailerBothChambers', { chamber: 'House', other: 'Senate' });
      expect(step.length).toBeGreaterThan(0);
      // The fifth step is a destination — it must not be a President's desk.
      expect(step).not.toMatch(president);
      expect(trailer).not.toMatch(affirmative);
      expect(trailer).toMatch(denial);
      // And it still keeps the chamber pair the presented-path trailer carries,
      // so the sentence tells the reader where the text goes back to.
      for (const chamber of chambers) expect(trailer).toMatch(chamber);
    });

    test(`${locale}: the states ending sends the measure to the states, not to a desk`, () => {
      const t = createTranslator({ locale, messages, namespace: 'bill.journey' });
      const step = t('stepStates');
      const trailer = t('backTrailerStates', { chamber: 'House', other: 'Senate' });
      expect(step.length).toBeGreaterThan(0);
      // THE REGRESSION THIS SUITE EXISTS FOR: the fifth step is a
      // DESTINATION, and an Article V proposal's destination is not the
      // President's desk. It must not name one, in either language.
      expect(step).not.toMatch(president);
      // The destination it does name.
      expect(step).toMatch(states);
      // The trailer must not carry the presented path's affirmative claim…
      expect(trailer).not.toMatch(affirmative);
      // …must deny presentment outright…
      expect(trailer).toMatch(statesDenial);
      // …and must say where it actually goes and what has to happen there.
      expect(trailer).toMatch(states);
      expect(trailer).toMatch(ratify);
      // It still keeps the chamber pair, so the reader learns where the text
      // goes back to when the second chamber changes it.
      for (const chamber of chambers) expect(trailer).toMatch(chamber);
    });

    test(`${locale}: the states ending does not borrow the con-res claim`, () => {
      // A proposed amendment does not "become law" — it becomes part of the
      // Constitution — so the con-res trailer's law sentence must not be
      // copied onto it.
      const t = createTranslator({ locale, messages, namespace: 'bill.journey' });
      expect(t('backTrailerStates', { chamber: 'House', other: 'Senate' })).not.toMatch(denial);
    });

    test(`${locale}: the presented-path strings are untouched and still name the President`, () => {
      const t = createTranslator({ locale, messages, namespace: 'bill.journey' });
      expect(t('stepPresident')).toMatch(president);
      expect(t('backTrailer', { chamber: 'House', other: 'Senate' })).toMatch(affirmative);
    });
  }
});

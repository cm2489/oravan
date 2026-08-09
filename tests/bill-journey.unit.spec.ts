import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { endsAtPresident } from '../components/BillJourney';
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
 * These pin the predicate, the two new strings, and — the part that actually
 * regresses — that neither new string names the President in either language.
 */

interface CorpusBill {
  bill_type: string;
  bill_number: number;
  congress_number: number;
}

const corpus: CorpusBill[] = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'bills.json'), 'utf8')
);

test.describe('endsAtPresident', () => {
  test('concurrent resolutions never reach the President', () => {
    expect(endsAtPresident('hconres')).toBe(false);
    expect(endsAtPresident('sconres')).toBe(false);
    // Case-insensitive: slugs are lowercased, stored types are not guaranteed to be.
    expect(endsAtPresident('HConRes')).toBe(false);
  });

  test('bills and joint resolutions do', () => {
    // A joint resolution IS presented (CRA disapprovals, continuing
    // resolutions) — the one exception, an amendment proposal headed for the
    // states, is the documented known limit in BillJourney.tsx and is NOT
    // claimed to be handled here.
    for (const type of ['hr', 's', 'hjres', 'sjres']) {
      expect(endsAtPresident(type), type).toBe(true);
    }
  });

  test('an unrecognized type defaults to the presented path', () => {
    // Deliberate: presentment is the rule (Article I §7) and the exception is
    // closed and constitutional, so an unknown string reads as an ordinary
    // bill rather than silently acquiring the resolution ending. What keeps
    // that safe is the fetcher's closed allowlist, pinned below.
    expect(endsAtPresident('')).toBe(true);
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
      chambers: [/House/, /Senate/],
    },
    {
      locale: 'es',
      messages: es,
      president: /presidente/i,
      affirmative: /antes de llegar al Presidente/,
      denial: /nunca llega al Presidente y no se convierte en ley/,
      chambers: [/Cámara/, /Senado/],
    },
  ] as const;

  for (const { locale, messages, president, affirmative, denial, chambers } of locales) {
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

    test(`${locale}: the presented-path strings are untouched and still name the President`, () => {
      const t = createTranslator({ locale, messages, namespace: 'bill.journey' });
      expect(t('stepPresident')).toMatch(president);
      expect(t('backTrailer', { chamber: 'House', other: 'Senate' })).toMatch(affirmative);
    });
  }
});

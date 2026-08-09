import { expect, test } from '@playwright/test';
import { normChipPair } from '../scripts/bill-decode.mjs';

/*
 * PINS cost-chip bilingual parity (scripts/bill-decode.mjs).
 *
 * The decode prompt states the contract itself — "Same count and order in
 * ES_COST_CHIPS. If a fact can't fit 45 chars, output NONE for both chip tags
 * (prose is the fallback)" — but the validator used to apply it one language
 * at a time. Spanish renders the same fact longer, so the ordinary outcome was
 * an EN chip that fit beside an ES twin that didn't: ES nulled, EN stored, and
 * the bill shipped with a scannable chip row in English and a wall of prose in
 * Spanish. Measured 2026-08-09 on the committed corpus: 157 of the 917
 * chip-carrying bills diverge (146 EN-only, 11 ES-only).
 *
 * If one of these fails, the contract moved: re-derive it deliberately (and
 * update normChipPair's own comment) rather than loosening the pin.
 */

/** 48 is the validator's ceiling; the prompt asks for 45. */
const at = (n: number) => 'x'.repeat(n);

test.describe('cost chips are decided for both languages at once', () => {
  test('an EN chip that fits beside an ES twin that does not drops BOTH — the exact 146-bill shape', () => {
    const en = 'Costs $2 billion over ten years';
    const es = `Cuesta ${at(45)}`; // 52 chars: over the ceiling, as Spanish routinely is
    expect(es.length).toBeGreaterThan(48);

    const out = normChipPair(en, es);

    expect(out.en).toBeNull(); // the EN chips go too, rather than shipping alone
    expect(out.es).toBeNull();
  });

  test('the mirror case drops both as well — the 11-bill shape', () => {
    const out = normChipPair(`Costs ${at(45)}`, 'Cuesta $2 mil millones');
    expect(out.en).toBeNull();
    expect(out.es).toBeNull();
  });

  test('both languages valid: both kept, in order, untouched', () => {
    const out = normChipPair(
      'Costs $2 billion | Paid by employers | Starts in 2027',
      'Cuesta $2 mil millones | Pagan los empleadores | Empieza en 2027'
    );
    expect(out.en).toEqual(['Costs $2 billion', 'Paid by employers', 'Starts in 2027']);
    expect(out.es).toEqual(['Cuesta $2 mil millones', 'Pagan los empleadores', 'Empieza en 2027']);
  });

  test('the ceiling is 48 in BOTH languages — deliberately not language-aware', () => {
    // The alternative considered and rejected was a higher ES ceiling. 48 is a
    // scannability budget, not a layout guard (the Chip shell wraps), so a
    // longer ES ceiling would only ship Spanish "chips" that are sentences.
    expect(normChipPair(at(48), at(48)).en).toEqual([at(48)]);
    expect(normChipPair(at(48), at(48)).es).toEqual([at(48)]);
    // One character past it, in either language, and both drop.
    expect(normChipPair(at(49), at(48)).en).toBeNull();
    expect(normChipPair(at(48), at(49)).en).toBeNull();
    expect(normChipPair(at(48), at(49)).es).toBeNull();
  });

  test('a count mismatch drops both, because the prompt promises the same count', () => {
    // Belt-and-braces: zero bills in the corpus currently diverge on count
    // where both languages have chips. Enforcing a promise costs nothing.
    const out = normChipPair('Costs $2 billion | Paid by employers', 'Cuesta $2 mil millones');
    expect(out.en).toBeNull();
    expect(out.es).toBeNull();
  });

  test('NONE in both — the no-cost case — stays null in both, as before', () => {
    expect(normChipPair('NONE', 'NONE')).toEqual({ en: null, es: null });
    expect(normChipPair('', '')).toEqual({ en: null, es: null });
    expect(normChipPair(undefined, undefined)).toEqual({ en: null, es: null });
  });

  test('NONE in one language only still drops both', () => {
    expect(normChipPair('Costs $2 billion', 'NONE')).toEqual({ en: null, es: null });
    expect(normChipPair('NONE', 'Cuesta $2 mil millones')).toEqual({ en: null, es: null });
  });

  test('more than three chips, or none at all, drops both in either language', () => {
    expect(normChipPair('a | b | c | d', 'a | b | c | d').en).toBeNull();
    expect(normChipPair('a | b | c', 'a | b | c | d').en).toBeNull();
    expect(normChipPair('|', '|').en).toBeNull(); // splits to zero non-empty chips
  });

  test('the return shape is always both keys, so neither section can read undefined', () => {
    for (const out of [normChipPair('a', 'b'), normChipPair('NONE', 'NONE'), normChipPair(at(49), 'b')]) {
      expect(Object.keys(out).sort()).toEqual(['en', 'es']);
    }
  });
});

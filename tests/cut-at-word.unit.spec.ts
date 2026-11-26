import { expect, test } from '@playwright/test';
// Relative import (not '@/'): plain lib modules resolve under the test runner.
import { cutAtWord } from '../lib/format';

/*
 * CODE THAT SHORTENS A TITLE CUTS AT A WORD (2026-11-25).
 *
 * An outside review of the Spanish edition read a headline cut inside a word,
 * "…horas extras federale". That stored headline was cut by the decoder
 * (scripts/bill-decode.mjs, out of scope that night); the code that shortens
 * text on the site itself (JSON-LD, the share images, the home specimen) now
 * goes through cutAtWord, in both languages.
 */

const LONG_ES =
  'Proyecto eximiría a vendedores directos y agentes inmobiliarios del salario mínimo y las horas extras federales que hoy los cubren';

test('text within the limit comes back unchanged', () => {
  expect(cutAtWord('Short headline', 110)).toBe('Short headline');
  expect(cutAtWord('Short headline', 14, '…')).toBe('Short headline');
});

test('a long Spanish headline ends on a whole word, within the limit', () => {
  const out = cutAtWord(LONG_ES, 110);
  expect(out.length).toBeLessThanOrEqual(110);
  expect(LONG_ES.startsWith(out)).toBe(true);
  expect(out.endsWith('federale')).toBe(false);
  expect(out).toBe('Proyecto eximiría a vendedores directos y agentes inmobiliarios del salario mínimo y las horas extras');
});

test('the ellipsis counts toward the limit and follows a whole word', () => {
  const out = cutAtWord(LONG_ES, 110, '…');
  expect(out.length).toBeLessThanOrEqual(110);
  expect(out.endsWith('extras…')).toBe(true);
});

test('a cut that lands exactly on a space keeps the whole last word', () => {
  expect(cutAtWord('abc def ghi', 7)).toBe('abc def');
  expect(cutAtWord('abc def ghi', 8)).toBe('abc def');
});

test('a trailing comma or dash is dropped before the ellipsis', () => {
  expect(cutAtWord('alpha, beta gamma', 9, '…')).toBe('alpha…');
  expect(cutAtWord('alpha — beta gamma', 10, '…')).toBe('alpha…');
});

test('English works the same way', () => {
  const en = 'Bill would swap mineral rights on about 4,660 acres in the Crow Reservation for 4,530 acres in the Bull Mountains';
  const out = cutAtWord(en, 110);
  expect(out).toBe('Bill would swap mineral rights on about 4,660 acres in the Crow Reservation for 4,530 acres in the Bull');
});

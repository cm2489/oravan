/**
 * A sentence reused after a label that ends in a colon ("Right now:" /
 * "Ahora mismo:"), where every other sentence starts lowercase (re-check of
 * #523, round 3: components/BillJourney.tsx prints the Big Questions line
 * "Both chambers passed it, and it has been sent to the president." there).
 *
 * Lowercases the FIRST LETTER only, and only when the first word is an
 * ordinary capitalised word: letters only, the rest of it already lowercase,
 * and not a word that stays capitalised mid-sentence (a chamber, Congress, the
 * President, a month, a day, a language or a nationality, in either
 * language). Anything else is returned unchanged: a bill number ("H.R.
 * 2400"), an acronym ("HHS"), a name the list does not know. Unknown cases
 * keep their capital, which is the safe failure: a capital after a colon is a
 * style slip, a lowercased proper noun would be wrong.
 */
const KEEPS_CAPITAL = new Set([
  // English
  'house', 'senate', 'congress', 'president', 'speaker', 'american', 'english', 'spanish',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'saturday', 'sunday', 'i',
  // Spanish: capitalised as names of institutions
  'cámara', 'senado', 'congreso', 'presidente', 'presidenta', 'ee', 'estados',
]);
const LEAD_WORD = /^([A-ZÁÉÍÓÚÑÜ])([a-záéíóúñü]+)(?=[\s,.;:!?]|$)/;

export function lowercaseLead(sentence: string, locale: string): string {
  const m = LEAD_WORD.exec(sentence);
  if (!m) return sentence;
  const word = (m[1] + m[2]).toLocaleLowerCase(locale);
  if (KEEPS_CAPITAL.has(word)) return sentence;
  return m[1].toLocaleLowerCase(locale) + sentence.slice(1);
}

/**
 * A sentence reused after a label that ends in a colon ("Right now:" /
 * "Ahora mismo:"), where every other sentence starts lowercase (re-check of
 * #523, round 3: components/BillJourney.tsx prints the Big Questions line
 * "Both chambers passed it, and it has been sent to the president." there).
 *
 * SAFE BY CONSTRUCTION (round 4). The first letter is lowercased ONLY when
 * the first word is on a short allow-list of ordinary words for that
 * language. Everything else is returned unchanged: a name ("Thune", "Texas",
 * "Medicare", "Republicans"), a title ("Mr.", "Sr."), a bill number
 * ("H.R. 2400"), an acronym ("HHS"), a chamber. A word not on the list keeps
 * its capital, which is the safe failure: a capital after a colon is a style
 * slip, a lowercased name would be wrong. The two sentences that reach it
 * today start with "Both" and "Ambas"; add a word here only with a sentence
 * that needs it.
 */
const SAFE_LEAD: Record<'en' | 'es', ReadonlySet<string>> = {
  en: new Set(['both', 'the', 'it', 'this']),
  es: new Set(['ambas', 'ambos', 'el', 'la', 'este', 'esta']),
};

export function lowercaseLead(sentence: string, locale: string): string {
  const lang = locale.toLowerCase().startsWith('es') ? 'es' : 'en';
  const m = /^(\p{Lu})(\p{Ll}*)(?=[\s,.;:!?]|$)/u.exec(sentence);
  if (!m) return sentence;
  const word = (m[1] + m[2]).toLocaleLowerCase(lang);
  if (!SAFE_LEAD[lang].has(word)) return sentence;
  return m[1].toLocaleLowerCase(lang) + sentence.slice(1);
}

import { GLOSSARY_ENTRIES, type GlossaryTermId } from './glossary';
import { GLOSSARY_NEAR_MISSES } from './glossary-terms';

/*
 * AUTOMATIC GLOSSARY MARKING — finding the terms that are already there.
 *
 * Owner, 2026-09-28 (UX inventory C05): "Users shouldn't feel dumb if they
 * don't know something when reading the site and it shouldn't take them away
 * from the page." Hand-wiring a tag into every message cannot reach decoded
 * text or the record's own vote lines, which is where most of the jargon is,
 * so this splits a plain string into text and terms, and
 * components/glossary-tags.tsx turns the terms into in-place popovers.
 *
 * THE RULES, each pinned in tests/glossary.unit.spec.ts:
 *
 *   PHRASES, NOT GUESSES. Only the phrases listed per term in
 *   lib/glossary-terms.ts match, per language. Every list was run over the
 *   committed decode corpus before it shipped, and phrases that marked the
 *   wrong thing were cut (the table's header names them). A NEAR MISS
 *   (GLOSSARY_NEAR_MISSES) is matched like a phrase and then left plain, so
 *   "a government shutdown of their mine" marks nothing.
 *   WHOLE WORDS. A phrase never matches inside a longer word, in either
 *   language — the boundaries are Unicode letters and digits, so "vetoed"
 *   is not "veto" + "ed" unless "vetoed" is itself listed, and "año fiscal"
 *   does not match inside "daño fiscal".
 *   LONGEST FIRST. "cloture on the motion to proceed" wins over "cloture", so
 *   the reader gets the entry for what the sentence actually says.
 *   ONCE PER TERM PER SECTION. The caller owns `seen`, one Set per section,
 *   and a term already marked in it stays plain the next time.
 *   NEVER INSIDE LINKS OR HEADINGS. This takes a string and nothing else;
 *   the callers pass only body text (glossary-tags.tsx never walks into an
 *   element), so a term inside a link or a heading is structurally out of
 *   reach rather than filtered out.
 */

export type GlossaryLocale = 'en' | 'es';
export type GlossarySegment = string | { id: GlossaryTermId; text: string };

interface Matcher {
  re: RegExp;
  /** A phrase's term, or null for a near miss: read, then left plain. */
  lookup: Map<string, GlossaryTermId | null>;
}

const cache = new Map<GlossaryLocale, Matcher | null>();

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = (s: string) => s.toLowerCase();

function matcher(locale: GlossaryLocale): Matcher | null {
  if (cache.has(locale)) return cache.get(locale)!;
  const lookup = new Map<string, GlossaryTermId | null>();
  for (const entry of GLOSSARY_ENTRIES) {
    for (const phrase of entry.match[locale]) lookup.set(fold(phrase), entry.id);
  }
  // Near misses join the same alternation, so longest-first lets them claim
  // their words before the shorter listed phrase inside them can.
  for (const phrase of GLOSSARY_NEAR_MISSES[locale]) lookup.set(fold(phrase), null);
  const phrases = [...lookup.keys()].sort((a, b) => b.length - a.length);
  const built =
    phrases.length === 0
      ? null
      : {
          re: new RegExp(
            `(?<![\\p{L}\\p{N}])(${phrases.map(escape).join('|')})(?![\\p{L}\\p{N}])`,
            'giu'
          ),
          lookup,
        };
  cache.set(locale, built);
  return built;
}

/** The locale the matcher should read a page's own copy in. */
export function glossaryLocale(locale: string): GlossaryLocale {
  return locale === 'es' ? 'es' : 'en';
}

/**
 * Split `text` into plain strings and glossary terms. Adds every term it
 * marks to `seen`, and leaves any term already in `seen` as plain text.
 */
export function splitGlossaryTerms(
  text: string,
  locale: GlossaryLocale,
  seen: Set<GlossaryTermId>
): GlossarySegment[] {
  const m = matcher(locale);
  if (!m || !text) return [text];
  const out: GlossarySegment[] = [];
  let last = 0;
  m.re.lastIndex = 0;
  for (let hit = m.re.exec(text); hit; hit = m.re.exec(text)) {
    const id = m.lookup.get(fold(hit[1]));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (hit.index > last) out.push(text.slice(last, hit.index));
    out.push({ id, text: hit[1] });
    last = hit.index + hit[1].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : [text];
}

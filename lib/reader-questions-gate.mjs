/**
 * Reader questions — the gate's logic, pure and importable by the unit suite.
 * scripts/check-reader-questions.mjs does the file I/O and the exit code.
 *
 * data/reader-questions.json holds, per Big Question, a few questions picked
 * from the fixed bank (data/reader-questions-bank.json) and an answer to each,
 * written once by AI on a stated date and never rewritten by a nightly job.
 * The bank itself was drafted with AI and still awaits its one-time owner
 * approval (its `status` says so); what this gate holds is that no question is
 * written for one page: every question is the bank's, word for word.
 *
 * Every sentence of an answer is one of three kinds:
 *   - a quoting sentence (`record` or `analysis`): it rests on stored quotes
 *     from official sources the entry lists;
 *   - an absence line, `absence_kind: "not_found"` (the design's term): we
 *     searched the sources it names for the terms in `absent` and found none;
 *     the page prints it as a plain sentence, because it is a checked finding;
 *   - an absence line, `absence_kind: "not_checked"`: what this answer did not
 *     check (the design's `unreachable` is one case); the page prints it after
 *     "We couldn't check this.".
 * The quotes and the absent terms were checked word for word against saved
 * copies of the sources when the answers were written; this gate cannot
 * re-fetch them, so it checks what the file itself can prove:
 *
 *   - shape: schema, dates, the writing model, `rewritten_nightly: false`;
 *   - bank: every question id exists in the bank, is not one of the bank's
 *     code-built questions, is tagged for this entry's question type
 *     (`type`), and its text is the bank's, word for word, in both languages;
 *   - every sentence: present in English and Spanish, the same numbers in both,
 *     as many quoted spans in Spanish («…») as in English (“…”), and the
 *     Spanish really Spanish (not the English string, and more Spanish than
 *     English function words, with an accented letter once it is long);
 *   - every quoting sentence has at least one cite, each naming a source the
 *     entry lists, with a non-empty quote; every span the reader sees inside
 *     “…” in English is found inside one of that sentence's cite quotes;
 *   - every absence line names its kind and the sources it searched, quotes
 *     nothing, and reads as an absence in our voice: a negation and a word
 *     about searching or checking, in both languages. A `not_found` line also
 *     names the terms it looked for, and every number in it comes from the
 *     titles of the sources it searched (a bill number, the search window), so
 *     a fact cannot ride in on it; a `not_checked` line carries no number;
 *   - 2 to 4 sentences an answer, English at most 1,000 characters;
 *   - our voice: the forbidden-vocabulary and speculation lints the summary
 *     revisions run (lintRevisionText, which carries lintForbidden from
 *     lib/moments-gate.mjs), and the future-vote lint the Big Question drafts
 *     run (FUTURE_VOTE, scripts/moment-draft.mjs). One definition each,
 *     imported, never copied.
 */
import { lintRevisionText } from './moment-updates-gate.mjs';
import { FUTURE_VOTE } from '../scripts/moment-draft.mjs';

// Schema ids, not browser-storage keys: they must not begin with the site's
// storage-key prefix (tests/storage-keys.unit.spec.ts reads every such literal
// as a key).
export const RQ_SCHEMA = 'reader-questions/v1';
export const RQ_BANK_SCHEMA = 'reader-questions/bank-v1';
export const CLAIM_KINDS = ['record', 'analysis', 'absence'];
export const ABSENCE_KINDS = ['not_found', 'not_checked'];
export const SOURCE_KINDS = ['record', 'analysis'];
export const MIN_PICKS = 1;
export const MAX_PICKS = 10;
export const MIN_CLAIMS = 2;
// Raised from 4 sentences and 1,000 characters on 2026-11-24: the cost answer for
// a bill that carries both this year's and next year's money needs a fifth
// sentence to say so (independent review of #544, defect D2).
export const MAX_CLAIMS = 5;
// 1,500 since the Iran set (2026-11-24): its independent check asked for three
// conditions and one quoted remark that did not fit 1,300.
export const MAX_ANSWER_CHARS_EN = 1500;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const isPair = (v) => v && typeof v === 'object' && isText(v.en) && isText(v.es);
const deaccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Quote marks and whitespace made uniform, so a display span and a stored
 *  quote compare on their words. Same normalization as the writing-time check. */
export function normQuote(s) {
  return String(s)
    .replace(/``|''|[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// An absence line reads as one: a negation, and a word about our own search.
const NEGATION = { en: /\b(no|not|none|never|nothing)\b|n't\b/i, es: /\b(no|ningun[oa]?|ningún|nada|ni|nunca)\b/i };
const SEARCH_VOICE = {
  en: /\b(we|search\w*|check\w*|retriev\w*|look\w*)\b/i,
  es: /(busc|consult|comprob|encontr|revis)\w*/i,
};

// A small language check, no library: function words counted in each language.
const EN_WORDS = new Set(['the', 'and', 'of', 'to', 'is', 'was', 'it', 'on', 'for', 'with', 'that', 'has', 'have', 'from', 'by', 'or', 'not', 'its', 'which', 'were', 'be', 'this', 'are', 'at', 'an']);
const ES_WORDS = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'que', 'y', 'en', 'para', 'con', 'por', 'una', 'un', 'es', 'se', 'su', 'sus', 'lo', 'al', 'ni', 'como', 'o', 'sobre', 'según']);
const SPANISH_LETTER = /[áéíóúñüÁÉÍÓÚÑÜ¿¡]/;

/** Why a Spanish string is not Spanish, or null when it reads as Spanish. */
export function notSpanish(es, en) {
  const s = String(es).trim();
  if (en !== undefined && s === String(en).trim()) return 'the Spanish is the English string';
  const words = s
    .replace(/“[^”]*”|"[^"]*"/g, ' ')
    .toLowerCase()
    .match(/[a-záéíóúñü]+/g) ?? [];
  const enN = words.filter((w) => EN_WORDS.has(w)).length;
  const esN = words.filter((w) => ES_WORDS.has(w)).length;
  if (words.length >= 6 && enN >= esN) return `reads as English (${enN} English function words, ${esN} Spanish)`;
  if (s.length > 60 && !SPANISH_LETTER.test(s)) return 'over 60 characters with no accented letter';
  return null;
}

/** The digit runs of a string, sorted — "220–205" and "11,779" compare by their digits. */
export const digitRuns = (s) => (String(s).match(/\d+/g) ?? []).sort();

export const enSpans = (s) => [...String(s).matchAll(/“([^”]*)”/g)].map((m) => m[1]);
export const esSpans = (s) => [...String(s).matchAll(/«([^»]*)»/g)].map((m) => m[1]);

/** Every lint failure for one string in one language (empty = clean). */
export function lintAnswerText(text, lang) {
  const failures = [...lintRevisionText(text, lang)];
  const probe = lang === 'es' ? deaccent(String(text)) : String(text);
  if (FUTURE_VOTE[lang]?.test(probe)) {
    failures.push(`future-vote wording "${probe.match(FUTURE_VOTE[lang])?.[0]}" — no vote date is ever stated or implied`);
  }
  return failures;
}

/**
 * @param {any} file       data/reader-questions.json
 * @param {any} bank       data/reader-questions-bank.json
 * @param {Record<string, any>} moments data/moments.json
 * @param {{ today?: string }} [opts] YYYY-MM-DD; defaults to the UTC day
 * @returns {{ violations: string[], warnings: string[] }}
 */
export function checkReaderQuestions(file, bank, moments, opts = {}) {
  const violations = [];
  const warnings = [];
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  if (!file || typeof file !== 'object') return { violations: ['root: not an object'], warnings };
  if (file.schema !== RQ_SCHEMA) violations.push(`schema: expected "${RQ_SCHEMA}"`);
  if (bank?.schema !== RQ_BANK_SCHEMA) violations.push(`bank file: schema is not "${RQ_BANK_SCHEMA}"`);
  if (file.bank !== bank?.schema) violations.push(`bank: the answers name "${file.bank}", the bank file is "${bank?.schema}"`);
  const bankTypes = bank?.types && typeof bank.types === 'object' ? Object.keys(bank.types) : [];
  const bankById = new Map((bank?.questions ?? []).map((q) => [q.id, q]));

  const entries = file.questions;
  if (!entries || typeof entries !== 'object') {
    violations.push('questions: missing');
    return { violations, warnings };
  }

  for (const [mid, e] of Object.entries(entries)) {
    const at = (p) => `${mid}.${p}`;
    if (!moments?.[mid]) violations.push(`${mid}: no Big Question with this id in data/moments.json`);
    for (const f of ['written', 'record_as_of']) {
      if (!isText(e?.[f]) || !DATE_RE.test(e[f])) violations.push(`${at(f)}: must be YYYY-MM-DD`);
      else if (e[f] > today) violations.push(`${at(f)}: ${e[f]} is in the future`);
    }
    const qtype = e?.type;
    if (!bankTypes.includes(qtype)) violations.push(`${at('type')}: "${qtype}" is not one of the bank's question types (${bankTypes.join(', ')})`);
    if (!isText(e?.model)) violations.push(`${at('model')}: name the model that wrote the answers`);
    if (e?.rewritten_nightly !== false) {
      violations.push(`${at('rewritten_nightly')}: must be false — these answers are written once and dated, and the page says so`);
    }

    const sources = e?.sources ?? {};
    for (const [sid, s] of Object.entries(sources)) {
      if (!SOURCE_KINDS.includes(s?.kind)) violations.push(`${at(`sources.${sid}.kind`)}: one of ${SOURCE_KINDS.join(', ')}`);
      if (!isText(s?.url) || !/^https:\/\/[^\s]+$/.test(s.url)) violations.push(`${at(`sources.${sid}.url`)}: an https URL`);
      if (!isPair(s?.title)) violations.push(`${at(`sources.${sid}.title`)}: needs en and es`);
      else {
        const why = notSpanish(s.title.es, s.title.en);
        if (why) violations.push(`${at(`sources.${sid}.title.es`)}: not Spanish: ${why}`);
      }
    }

    const picks = Array.isArray(e?.picks) ? e.picks : [];
    if (picks.length < MIN_PICKS || picks.length > MAX_PICKS) {
      violations.push(`${at('picks')}: ${picks.length} answers, allowed ${MIN_PICKS} to ${MAX_PICKS}`);
    }
    const seen = new Set();
    picks.forEach((p, pi) => {
      const pat = (s) => at(`picks[${pi}]${s}`);
      const b = bankById.get(p?.bank_id);
      if (!b) {
        violations.push(`${pat('.bank_id')}: "${p?.bank_id}" is not in the bank — a question is never written, only picked`);
      } else {
        if (b.deterministic) violations.push(`${pat('.bank_id')}: "${p.bank_id}" is a code-built question, never AI-written`);
        if (!Array.isArray(b.types) || !b.types.includes(qtype)) {
          violations.push(`${pat('.bank_id')}: "${p.bank_id}" is not tagged for this question's type "${qtype}" (it is for ${(b.types ?? []).join(', ') || 'no type'})`);
        }
        if (p?.q?.en !== b.q.en || p?.q?.es !== b.q.es) {
          violations.push(`${pat('.q')}: must be the bank's own text for "${p.bank_id}", in both languages`);
        }
      }
      if (seen.has(p?.bank_id)) violations.push(`${pat('.bank_id')}: "${p.bank_id}" picked twice`);
      seen.add(p?.bank_id);

      const claims = Array.isArray(p?.claims) ? p.claims : [];
      if (claims.length < MIN_CLAIMS || claims.length > MAX_CLAIMS) {
        violations.push(`${pat('.claims')}: ${claims.length} sentences, allowed ${MIN_CLAIMS} to ${MAX_CLAIMS}`);
      }
      const enLen = claims.map((c) => String(c?.en ?? '')).join(' ').length;
      if (enLen > MAX_ANSWER_CHARS_EN) violations.push(`${pat('')}: English answer is ${enLen} characters, over ${MAX_ANSWER_CHARS_EN}`);

      claims.forEach((c, ci) => {
        const cat = (s) => pat(`.claims[${ci}]${s}`);
        if (!CLAIM_KINDS.includes(c?.kind)) violations.push(`${cat('.kind')}: one of ${CLAIM_KINDS.join(', ')}`);
        if (!isText(c?.en) || !isText(c?.es)) {
          violations.push(`${cat('')}: needs both en and es`);
          return;
        }
        const dEn = digitRuns(c.en).join(',');
        const dEs = digitRuns(c.es).join(',');
        if (dEn !== dEs) violations.push(`${cat('')}: English and Spanish carry different numbers (${dEn} vs ${dEs})`);
        const spansEn = enSpans(c.en);
        const spansEs = esSpans(c.es);
        if (spansEn.length !== spansEs.length) {
          violations.push(`${cat('')}: ${spansEn.length} quoted spans in English, ${spansEs.length} in Spanish`);
        }
        for (const lang of ['en', 'es']) {
          for (const f of lintAnswerText(c[lang], lang)) violations.push(`${cat(`.${lang}`)}: ${f}`);
        }
        const why = notSpanish(c.es, c.en);
        if (why) violations.push(`${cat('.es')}: not Spanish: ${why}`);

        if (c.kind === 'absence') {
          const searched = Array.isArray(c.searched) ? c.searched : [];
          if (searched.length === 0) violations.push(`${cat('.searched')}: an absence line names the sources it searched`);
          for (const s of searched) if (!sources[s]) violations.push(`${cat('.searched')}: "${s}" is not in this entry's sources`);
          if (spansEn.length || spansEs.length) violations.push(`${cat('')}: an absence line quotes nothing`);
          if (c.cites?.length) violations.push(`${cat('.cites')}: an absence line carries no cites; a sentence with a quote is a record or analysis sentence`);
          if (!ABSENCE_KINDS.includes(c.absence_kind)) {
            violations.push(`${cat('.absence_kind')}: one of ${ABSENCE_KINDS.join(', ')} (what we searched and did not find, or what we did not check)`);
          }
          for (const lang of ['en', 'es']) {
            if (!NEGATION[lang].test(c[lang]) || !SEARCH_VOICE[lang].test(c[lang])) {
              violations.push(`${cat(`.${lang}`)}: an absence line says what we searched or did not check, with a negation; this reads as a statement of fact`);
            }
          }
          const nums = digitRuns(c.en);
          if (c.absence_kind === 'not_checked' && nums.length) {
            violations.push(`${cat('.en')}: a "couldn't check" line states no number (${nums.join(', ')}); a fact needs a quote`);
          }
          if (c.absence_kind === 'not_found') {
            const absent = Array.isArray(c.absent) ? c.absent.filter(isText) : [];
            if (absent.length === 0) violations.push(`${cat('.absent')}: a not-found line names the terms it looked for and did not find`);
            const allowed = new Set([...searched.flatMap((s) => digitRuns(sources[s]?.title?.en ?? '')), ...absent.flatMap(digitRuns)]);
            const loose = nums.filter((n) => !allowed.has(n));
            if (loose.length) {
              violations.push(`${cat('.en')}: the numbers ${loose.join(', ')} come from none of the searched sources' titles; a fact needs a quote`);
            }
          }
          return;
        }
        if (c.absence_kind !== undefined) violations.push(`${cat('.absence_kind')}: only an absence line has one`);
        const cites = Array.isArray(c.cites) ? c.cites : [];
        if (cites.length === 0) violations.push(`${cat('.cites')}: every sentence carries a quote and its source`);
        for (const [ti, ct] of cites.entries()) {
          if (!sources[ct?.src]) violations.push(`${cat(`.cites[${ti}].src`)}: "${ct?.src}" is not in this entry's sources`);
          if (!isText(ct?.quote)) violations.push(`${cat(`.cites[${ti}].quote`)}: empty`);
        }
        const pool = cites.map((ct) => normQuote(ct?.quote ?? ''));
        for (const span of spansEn) {
          const sp = normQuote(span).replace(/[.,;:]+$/, '');
          if (!pool.some((q) => q.includes(sp))) {
            violations.push(`${cat('.en')}: the quoted words "${sp}" are in none of this sentence's cite quotes`);
          }
        }
      });
    });
  }
  return { violations, warnings };
}

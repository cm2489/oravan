/**
 * Reader questions — the gate's logic, pure and importable by the unit suite.
 * scripts/check-reader-questions.mjs does the file I/O and the exit code.
 *
 * data/reader-questions.json holds, per Big Question, a few questions picked
 * from the fixed bank (data/reader-questions-bank.json) and an answer to each,
 * written once by AI on a stated date and never rewritten by a nightly job.
 * Every sentence of an answer either quotes an official source it names, or is
 * an "absence" line that says what we could not check and which sources we
 * searched. The quotes were checked word for word against saved copies of the
 * sources when the answers were written; this gate cannot re-fetch them, so it
 * checks what the file itself can prove:
 *
 *   - shape: schema, dates, the writing model, `rewritten_nightly: false`;
 *   - bank: every question id exists in the bank, is not one of the bank's
 *     code-built questions, and its text is the bank's, word for word, in both
 *     languages (AI never writes a question);
 *   - every sentence: present in English and Spanish, the same numbers in both,
 *     as many quoted spans in Spanish («…») as in English (“…”);
 *   - every quoting sentence has at least one cite, each naming a source the
 *     entry lists, with a non-empty quote; every span the reader sees inside
 *     “…” in English is found inside one of that sentence's cite quotes;
 *   - every absence sentence names the sources it searched and quotes nothing;
 *   - 2 to 4 sentences an answer, English at most 1,000 characters;
 *   - our voice: the forbidden-vocabulary and speculation lints the summary
 *     revisions run (lintRevisionText, which carries lintForbidden from
 *     lib/moments-gate.mjs), and the future-vote lint the Big Question drafts
 *     run (FUTURE_VOTE, scripts/moment-draft.mjs). One definition each,
 *     imported, never copied.
 */
import { lintRevisionText } from './moment-updates-gate.mjs';
import { FUTURE_VOTE } from '../scripts/moment-draft.mjs';

export const RQ_SCHEMA = 'oravan.reader-questions/v1';
export const RQ_BANK_SCHEMA = 'oravan.reader-questions/bank-v1';
export const CLAIM_KINDS = ['record', 'analysis', 'absence'];
export const SOURCE_KINDS = ['record', 'analysis'];
export const MIN_PICKS = 1;
export const MAX_PICKS = 10;
export const MIN_CLAIMS = 2;
export const MAX_CLAIMS = 4;
export const MAX_ANSWER_CHARS_EN = 1000;

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
    if (!isText(e?.model)) violations.push(`${at('model')}: name the model that wrote the answers`);
    if (e?.rewritten_nightly !== false) {
      violations.push(`${at('rewritten_nightly')}: must be false — these answers are written once and dated, and the page says so`);
    }

    const sources = e?.sources ?? {};
    for (const [sid, s] of Object.entries(sources)) {
      if (!SOURCE_KINDS.includes(s?.kind)) violations.push(`${at(`sources.${sid}.kind`)}: one of ${SOURCE_KINDS.join(', ')}`);
      if (!isText(s?.url) || !/^https:\/\/[^\s]+$/.test(s.url)) violations.push(`${at(`sources.${sid}.url`)}: an https URL`);
      if (!isPair(s?.title)) violations.push(`${at(`sources.${sid}.title`)}: needs en and es`);
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

        if (c.kind === 'absence') {
          const searched = Array.isArray(c.searched) ? c.searched : [];
          if (searched.length === 0) violations.push(`${cat('.searched')}: an absence line names the sources it searched`);
          for (const s of searched) if (!sources[s]) violations.push(`${cat('.searched')}: "${s}" is not in this entry's sources`);
          if (spansEn.length) violations.push(`${cat('')}: an absence line quotes nothing`);
          return;
        }
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

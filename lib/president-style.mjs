/*
 * "THE PRESIDENT" — how Oravan's own words write the office.
 *
 * Owner, 2026-09-29, reviewing artifact 7BuRDMkWu9zigDE1u2XPLJ: "It's 'the
 * president' just FYI for all future copy (correct any other copy but first
 * find the rules of how and when 'president' is capitalized". His example was
 * the AI headline on /bills/hconres-89-119, "Resolution would direct president
 * to halt military action against Iran", which should read "…direct the
 * president to halt…". The rule, its sources and its limits are written up in
 * docs/copy-style.md; this file is the one deterministic copy of it.
 *
 * WHAT IT DOES, in Oravan's own sentences only:
 *   English  "the President said" → "the president said"; "direct president
 *            to" → "direct the president to"; "a Presidential permit" →
 *            "a presidential permit"; "the Vice President's" → "the vice
 *            president's". A formal title directly before a name keeps its
 *            capital ("President Trump", "Vice President Vance"), and so does a
 *            proper name ("Presidential Medal of Freedom", "President's Park",
 *            "Executive Office of the President").
 *   Spanish  "el Presidente" → "el presidente", even before a name ("el
 *            presidente Trump"), as the RAE and FundéuRAE write it. Institution
 *            names keep their capitals ("Oficina Ejecutiva del Presidente",
 *            "Medalla Presidencial de la Libertad").
 *
 * WHAT IT NEVER TOUCHES — record truth (page 1, rule 6):
 *   - anything inside quotation marks ("…", “…”, «…»): a quote of the record
 *     stays exactly as the record wrote it, "Signed by President." included;
 *   - a bill's official title copied into our text verbatim — its opening six
 *     or more words, or any twelve-word run of it — when the caller passes the
 *     title (a title as officially written is the record's, not ours);
 *   - fields that ARE the record (title, last_action_text, action_text, the
 *     Senate's nomination text). This module is only ever handed Oravan's
 *     own fields; the callers choose them, and scripts/president-style.mjs
 *     lists them.
 *
 * WHAT IT DOES NOT GUESS. Every case it cannot decide from the words around it
 * is left alone and reported (`skipped`, with the reason), never rewritten on
 * a hunch: a capitalized word before "President" that may be part of a name
 * ("Manhattan Borough President"), a bare "president" whose missing article it
 * cannot place, an unbalanced quotation mark. The audit prints them.
 *
 * Pure and deterministic: no I/O, no model, no clock. Idempotent — a second
 * pass over its own output changes nothing (tests/president-style.unit.spec.ts).
 */

/**
 * The same rule, as one line for a prompt. Every model prompt that writes
 * public text carries it (the decode's second call, moment updates, the Big
 * Question draft, the call scripts), and every one of those pipelines also
 * runs the normalizer below on what comes back, so the prompt line is a
 * courtesy to the model and the normalizer is the guarantee.
 *
 * The examples name a historical president on purpose. Two of these prompts
 * (the call scripts) forbid naming a sitting officeholder or a party, and an
 * example sentence is the likeliest thing a model copies.
 */
export const PRESIDENT_STYLE_RULE =
  '- Style for the office: write "the president" and "the vice president" in lowercase and with "the" (never a bare "president" as a subject or object). Capitalize "President" or "Vice President" only as a formal title directly before a name ("President Lincoln") or as part of a proper name ("Presidential Medal of Freedom"). "Presidential" is lowercase unless it is part of a proper name. Anything quoted from the official record stays exactly as written. In Spanish, "presidente", "presidenta", "vicepresidente" and "presidencial" are always lowercase, even before a name ("el presidente Lincoln").';

/* ------------------------------------------------------------------ *
 * Quotation marks
 * ------------------------------------------------------------------ */

/**
 * The spans of `text` that sit inside quotation marks. Straight double quotes
 * toggle; curly and angle quotes nest. An opening mark that never closes
 * protects everything after it (and is reported), because a quote we cannot
 * see the end of is still a quote.
 *
 * @param {string} text
 * @returns {{ spans: Array<[number, number]>, unbalancedAt: number | null }}
 */
export function quotedSpans(text) {
  /** @type {Array<[number, number]>} */
  const spans = [];
  let straightOpen = -1;
  /** @type {number[]} */
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (stack.length) continue; // a straight mark inside a curly quote is part of it
      if (straightOpen < 0) straightOpen = i;
      else {
        spans.push([straightOpen, i + 1]);
        straightOpen = -1;
      }
    } else if (c === '“' || c === '«') {
      if (straightOpen >= 0) continue;
      stack.push(i);
    } else if (c === '”' || c === '»') {
      if (straightOpen >= 0) continue;
      const open = stack.pop();
      if (open !== undefined && stack.length === 0) spans.push([open, i + 1]);
    }
  }
  const openAt = straightOpen >= 0 ? straightOpen : stack.length ? stack[0] : -1;
  if (openAt >= 0) spans.push([openAt, text.length]);
  return { spans, unbalancedAt: openAt >= 0 ? openAt : null };
}

/** @param {Array<[number, number]>} spans @param {number} at */
function insideSpan(spans, at) {
  return spans.some(([a, b]) => at >= a && at < b);
}

/* ------------------------------------------------------------------ *
 * Words around a match
 * ------------------------------------------------------------------ */

const L = '\\p{L}\\p{N}_';

/** Abbreviations whose period does not end a sentence. */
const ABBREVIATIONS = new Set(['u.s.', 'd.c.', 'st.', 'mr.', 'mrs.', 'ms.', 'dr.', 'jr.', 'sr.', 'no.', 'vs.', 'gen.', 'sen.', 'rep.', 'gov.', 'lt.', 'col.', 'e.g.', 'i.e.', 'inc.', 'co.', 'ee.', 'uu.']);

/**
 * The token before `at` (whitespace-separated), its cleaned word, whether
 * punctuation sits between it and the match, and whether the match begins a
 * sentence.
 *
 * @param {string} text
 * @param {number} at
 */
function prevContext(text, at) {
  const before = text.slice(0, at);
  if (/\n\s*$/.test(before) || before.trim() === '') {
    return { token: '', word: '', punct: false, sentenceStart: true, tokenStart: 0 };
  }
  const m = before.match(/(\S+)(\s*)$/);
  if (!m) return { token: '', word: '', punct: false, sentenceStart: true, tokenStart: 0 };
  const token = m[1];
  const tokenStart = before.length - m[0].length;
  // An opening quote or bracket glued to the match ("(President…") is not a
  // word; treat what is before it as the context.
  if (m[2] === '' && /^[(\[“"«]+$/.test(token)) {
    const inner = prevContext(text, tokenStart);
    return { ...inner, punct: true };
  }
  const lower = token.toLowerCase();
  const endsSentence =
    /[.!?:;]["”»)]*$/.test(token) && !ABBREVIATIONS.has(lower.replace(/["”»)]+$/, '')) && !/^[A-Z]\.$/.test(token);
  const word = token.replace(/^[(\[“"«'‘]+/, '').replace(/[.,;:!?)\]”"»'’—–-]+$/, '');
  return {
    token,
    word,
    punct: /[,;:)\]—–]$/.test(token) || endsSentence,
    sentenceStart: endsSentence,
    tokenStart,
  };
}

/**
 * The token after `from`, when exactly one space separates it from the match
 * (a comma, a period or a dash in between means it cannot be a name the title
 * belongs to).
 *
 * @param {string} text
 * @param {number} from
 */
function nextContext(text, from) {
  const rest = text.slice(from);
  const m = rest.match(/^ (\S+)/);
  if (!m) return { word: '', raw: '', spaced: false };
  const raw = m[1];
  const word = raw.replace(/^[(\[“"«]+/, '').replace(/[.,;:!?)\]”"»—–]+$/, '');
  return { word, raw, spaced: true };
}

/* ------------------------------------------------------------------ *
 * English
 * ------------------------------------------------------------------ */

/** Capitalized words that are never a name a title could belong to. */
const NOT_A_NAME = new Set(['I', 'If', 'The', 'A', 'An', 'And', 'But', 'Or', 'Congress', 'Senate', 'House', 'On', 'In', 'Its', 'This', 'That']);

/** Determiners, and words that sit between a determiner and "president". */
const DETERMINERS = new Set(['the', 'a', 'an', 'any', 'every', 'each', 'no', 'this', 'that', 'these', 'those', 'his', 'her', 'their', 'its', 'our', 'your', 'whose', 'which', 'whichever', 'another', 'either', 'neither', 'same', 'one', 'some', 'whatever']);
const PRE_ADJECTIVES = new Set(['sitting', 'current', 'former', 'future', 'incoming', 'outgoing', 'next', 'new', 'then', 'acting', 'u.s', 'us', 'american', 'two-term', 'one-term', 'lame-duck', 'first', 'last', 'elected', 'later', 'previous', 'prior', 'subsequent']);

/** Where a bare "president" reads correctly without an article. */
const NO_ARTICLE_AFTER = new Set(['for', 'as', 'elected', 'elect', 'become', 'becomes', 'became', 'becoming', 'is', 'was', 'were', 'be', 'been', 'being', 'remain', 'remains', 'remained', 'named', 'and', 'or', 'nor', 'vice']);

/**
 * Where a bare "president" is the subject or object of what came before and
 * needs "the": the owner's example is "direct president to halt".
 */
const ARTICLE_AFTER = new Set([
  // verbs that take the office as an object
  'let', 'lets', 'letting', 'direct', 'directs', 'directed', 'directing', 'demand', 'demands', 'demanding',
  'require', 'requires', 'required', 'requiring', 'tell', 'tells', 'told', 'telling', 'order', 'orders',
  'ordered', 'ordering', 'urge', 'urges', 'urged', 'urging', 'allow', 'allows', 'allowed', 'allowing',
  'force', 'forces', 'forced', 'forcing', 'criminalize', 'criminalizes', 'limit', 'limits', 'limited',
  'limiting', 'block', 'blocks', 'blocking', 'bar', 'bars', 'barring', 'stop', 'stops', 'stopping', 'give',
  'gives', 'giving', 'ask', 'asks', 'asked', 'asking', 'press', 'presses', 'pressing', 'push', 'pushes',
  'pushing', 'help', 'helps', 'helping', 'make', 'makes', 'making', 'empower', 'empowers', 'empowering',
  'authorize', 'authorizes', 'authorizing', 'permit', 'permits', 'permitting', 'prohibit', 'prohibits',
  'prohibiting', 'restrict', 'restricts', 'restricting', 'strip', 'strips', 'stripping', 'warn', 'warns',
  'call', 'calls', 'calling', 'send', 'sends', 'sending', 'sent', 'notify', 'notifies', 'advise', 'advises',
  'compel', 'compels', 'compelling', 'instruct', 'instructs', 'instructing', 'pressure', 'pressures',
  'encourage', 'encourages', 'override', 'overrides', 'constrain', 'constrains', 'shield', 'shields',
  'protect', 'protects', 'sue', 'sues', 'remind', 'reminds', 'leave', 'leaves', 'shift', 'shifts', 'move',
  'moves', 'return', 'returns', 'returned', 'present', 'presents', 'presented', 'trust', 'trusts',
  // prepositions and conjunctions that open a noun phrase or a clause
  'to', 'from', 'by', 'against', 'with', 'without', 'on', 'of', 'before', 'after', 'until', 'than', 'toward',
  'towards', 'about', 'under', 'over', 'between', 'among', 'beyond', 'like', 'unlike', 'via', 'not', 'so',
  'if', 'when', 'whenever', 'unless', 'because', 'while', 'once', 'whether', 'that', 'where', 'but', 'since',
  'though', 'although', 'lest',
]);

/** Words that make "President …" at the start of a sentence a subject. */
const SUBJECT_VERBS = new Set(['may', 'might', 'can', 'cannot', 'could', 'would', 'will', 'must', 'shall', 'should', 'has', 'had', 'is', 'was', 'does', 'did', 'gets', 'got']);

/** @param {string} w */
function looksLikeVerb(w) {
  const lw = w.toLowerCase();
  return SUBJECT_VERBS.has(lw) || (/^[a-z]+(?:s|ed)$/.test(w) && !/ss$/.test(w) && w.length > 3);
}

/** @param {string} w */
function isCapitalized(w) {
  return /^\p{Lu}/u.test(w);
}

/** @param {string} w */
function lowerFirst(w) {
  return w ? w[0].toLowerCase() + w.slice(1) : w;
}

/** @param {string} w */
function upperFirst(w) {
  return w ? w[0].toUpperCase() + w.slice(1) : w;
}

/**
 * Walk back over adjectives from `at` and say whether a determiner (or a
 * possessive, or a list/coordination that shares one) already governs the
 * noun. Returns the verdict and the nearest word that decided it.
 *
 * @param {string} text
 * @param {number} at
 * @returns {{ kind: 'determiner' | 'shared' | 'no-article' | 'insert' | 'unknown' | 'sentence-start', word: string }}
 */
function articleContext(text, at) {
  let pos = at;
  for (let hops = 0; hops < 4; hops++) {
    const p = prevContext(text, pos);
    if (p.sentenceStart && !p.word) return { kind: 'sentence-start', word: '' };
    const lw = p.word.toLowerCase();
    // A comma, colon or dash between the previous word and the noun: a list or
    // an aside — "President, Vice President, Senate" — whose members share
    // whatever article (or none) the list has.
    if (p.punct) return { kind: p.sentenceStart ? 'sentence-start' : 'shared', word: p.token };
    if (DETERMINERS.has(lw)) return { kind: 'determiner', word: p.word };
    if (/['’]s$|s['’]$/.test(p.word)) return { kind: 'determiner', word: p.word };
    if (PRE_ADJECTIVES.has(lw) || /^\d+(?:st|nd|rd|th)$/.test(lw)) {
      pos = p.tokenStart;
      continue;
    }
    if (NO_ARTICLE_AFTER.has(lw)) return { kind: lw === 'and' || lw === 'or' || lw === 'nor' ? 'shared' : 'no-article', word: p.word };
    if (ARTICLE_AFTER.has(lw)) return { kind: 'insert', word: p.word };
    return { kind: 'unknown', word: p.word };
  }
  return { kind: 'unknown', word: '' };
}

const EN_TOKEN = new RegExp(
  `(?<![${L}'’-])((?:[Vv]ice[- ])?)([Pp]resident(?:ial|s|cy)?)((?:-elect)?)(?![${L}])`,
  'gu',
);

/** A title is being cited, not paraphrased, when our text carries its
 *  opening words verbatim (capital and all) for at least this many words… */
const TITLE_PREFIX_WORDS = 6;
/** …or any run of the title at least this long. Shorter runs are ordinary
 *  prose that shares the title's vocabulary ("allows the President to award
 *  the Medal of Honor"), and they are ours. */
const TITLE_RUN_WORDS = 12;

/**
 * The spans of `text` that are a bill's official title as written — its
 * opening words verbatim, or a long verbatim run of it — and that contain a
 * president word. Those are the record's words, not ours.
 *
 * @param {string} text
 * @param {string[]} titles
 * @returns {Array<[number, number]>}
 */
function titleSpans(text, titles) {
  /** @type {Array<[number, number]>} */
  const spans = [];
  /** @param {string} needle */
  const findAll = (needle) => {
    let from = 0;
    for (;;) {
      const hit = text.indexOf(needle, from);
      if (hit < 0) break;
      spans.push([hit, hit + needle.length]);
      from = hit + 1;
    }
  };
  for (const title of titles) {
    if (!title || !/[Pp]resident/.test(title)) continue;
    const words = title.split(/\s+/).filter(Boolean);
    // The title's opening, from its first word, as long as our text has it.
    for (let n = words.length; n >= TITLE_PREFIX_WORDS; n--) {
      const run = words.slice(0, n);
      if (!run.some((w) => /[Pp]resident/.test(w))) break;
      const needle = run.join(' ');
      if (text.includes(needle)) {
        findAll(needle);
        break;
      }
    }
    for (let i = 0; i + TITLE_RUN_WORDS <= words.length; i++) {
      const run = words.slice(i, i + TITLE_RUN_WORDS);
      if (run.some((w) => /[Pp]resident/.test(w))) findAll(run.join(' '));
    }
  }
  return spans;
}

/**
 * @typedef {{ at: number, before: string, after: string, rule: string }} Change
 * @typedef {{ at: number, match: string, reason: string }} Skip
 * @typedef {{ text: string, changes: Change[], skipped: Skip[], kept: Skip[] }} Result
 */

/**
 * @param {string} text
 * @param {{ titles?: string[] }} [opts]
 * @returns {Result}
 */
export function normalizeEnglish(text, opts = {}) {
  /** @type {Result} */
  const out = { text, changes: [], skipped: [], kept: [] };
  if (typeof text !== 'string' || !/[Pp]residen/.test(text)) return out;
  const { spans: quoted, unbalancedAt } = quotedSpans(text);
  const protectedTitle = titleSpans(text, opts.titles ?? []);
  /** @type {Array<{ start: number, end: number, replacement: string, rule: string }>} */
  const edits = [];

  for (const m of text.matchAll(EN_TOKEN)) {
    const start = /** @type {number} */ (m.index);
    const [whole, vicePart, word, electPart] = m;
    const end = start + whole.length;
    const possessive = /^['’]s(?![\p{L}])/u.test(text.slice(end));
    const afterToken = end + (possessive ? 2 : 0);
    const base = word.toLowerCase(); // president | presidents | presidential | presidency
    const vice = vicePart !== '';
    const capWord = isCapitalized(word);
    const capVice = vice && isCapitalized(vicePart);
    const anyCap = capWord || capVice;

    if (insideSpan(quoted, start)) {
      if (anyCap || base === 'president') {
        const reason = unbalancedAt !== null && start >= unbalancedAt ? 'after an unclosed quotation mark' : 'inside quotation marks';
        (reason.startsWith('after') ? out.skipped : out.kept).push({ at: start, match: whole, reason });
      }
      continue;
    }
    if (insideSpan(protectedTitle, start)) {
      out.skipped.push({ at: start, match: whole, reason: 'inside words copied verbatim from the official title' });
      continue;
    }

    const prev = prevContext(text, start);
    const next = nextContext(text, afterToken);
    const nextIsName =
      next.spaced && /^\p{Lu}[\p{L}'’.-]*$/u.test(next.word) && !NOT_A_NAME.has(next.word);

    // 1. A title before a name, or a proper name that runs on into capitals.
    if (nextIsName) {
      if (!possessive && (base === 'president' || base === 'presidents') && !electPart) {
        if (!anyCap || (vice && !(capVice && capWord))) {
          const replacement = vice ? `${upperFirst(vicePart)}${upperFirst(word)}` : upperFirst(word);
          edits.push({ start, end: start + vicePart.length + word.length, replacement, rule: 'title before a name' });
        } else {
          out.kept.push({ at: start, match: `${whole} ${next.word}`, reason: 'title before a name' });
        }
      } else if (anyCap) {
        out.kept.push({ at: start, match: `${whole}${possessive ? "'s" : ''} ${next.word}`, reason: 'part of a proper name' });
      }
      continue;
    }

    // 2. "Executive Office of the President": a capitalized name before "of the".
    const lead = base === 'president' && !vice ? text.slice(Math.max(0, start - 60), start).match(/(\S+) of the $/) : null;
    if (lead && isCapitalized(lead[1]) && !prevContext(text, start - lead[0].length).sentenceStart) {
      if (anyCap) out.kept.push({ at: start, match: `${lead[1]} of the ${whole}`, reason: 'part of a proper name' });
      continue;
    }

    // 3. A capitalized word directly before it that is not a sentence start
    //    and not "U.S." may be part of a name ("Manhattan Borough President").
    if (
      !vice &&
      prev.word &&
      isCapitalized(prev.word) &&
      !prev.punct &&
      !prev.sentenceStart &&
      !prevContext(text, prev.tokenStart).sentenceStart &&
      !['U.S', 'US'].includes(prev.word) &&
      !DETERMINERS.has(prev.word.toLowerCase())
    ) {
      if (anyCap) out.skipped.push({ at: start, match: `${prev.word} ${whole}`, reason: 'a capitalized word before it may make it part of a name' });
      continue;
    }

    // 4. A common noun (or adjective): lowercase, except where it starts a sentence.
    let replacement = whole;
    if (vice) {
      const viceWord = prev.sentenceStart ? upperFirst(vicePart) : lowerFirst(vicePart);
      replacement = `${viceWord}${lowerFirst(word)}${electPart}`;
    } else {
      replacement = `${prev.sentenceStart ? word : lowerFirst(word)}${electPart}`;
    }
    const rules = [];
    if (replacement !== whole) rules.push('lowercase');

    // 5. The article, for the singular office ("the president").
    let articleText = '';
    if (base === 'president' && !electPart) {
      const ctx = articleContext(text, start);
      if (ctx.kind === 'insert') {
        articleText = 'the ';
        rules.push(`article after "${ctx.word}"`);
      } else if (ctx.kind === 'sentence-start') {
        if (!possessive && next.spaced && looksLikeVerb(next.word)) {
          articleText = 'The ';
          replacement = `${lowerFirst(vicePart)}${lowerFirst(word)}`;
          rules.push('article at the start of a sentence');
        } else {
          // A sentence that opens on the bare noun and is not followed by a
          // verb ("President's desk", "President of the Senate: …") is a label
          // more often than a sentence; its wording is the editor's call.
          out.skipped.push({
            at: start,
            match: `${whole}${possessive ? "'s" : ''} ${next.word}`.trim(),
            reason: 'opens a sentence or label with no article, and the next word is not a verb',
          });
        }
      } else if (ctx.kind === 'unknown') {
        out.skipped.push({
          at: start,
          match: `${ctx.word} ${whole}`.trim(),
          reason: `no article, and "${ctx.word}" is not a word the rule knows how to follow`,
        });
      }
    }
    const finalText = `${articleText}${replacement}`;
    if (finalText !== whole) {
      edits.push({ start, end, replacement: finalText, rule: rules.join(' + ') || 'lowercase' });
    }
  }

  return applyEdits(out, edits);
}

/* ------------------------------------------------------------------ *
 * Spanish
 * ------------------------------------------------------------------ */

const ES_TOKEN = new RegExp(
  `(?<![${L}])(Vicepresident(?:e|a|es|as)|Presidente|Presidenta|Presidentes|Presidentas|Presidencial(?:es)?|Presidencia)(?![${L}])`,
  'gu',
);

/** Capitalized words before "Presidente" that are not the start of a name. */
const ES_DETERMINERS = new Set(['el', 'la', 'los', 'las', 'al', 'del', 'un', 'una', 'unos', 'unas', 'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'su', 'sus', 'cuando', 'si', 'y', 'o', 'solo', 'sólo', 'como', 'ni']);
const ES_CONNECTORS = new Set(['de', 'del']);

/**
 * @param {string} text
 * @returns {Result}
 */
export function normalizeSpanish(text) {
  /** @type {Result} */
  const out = { text, changes: [], skipped: [], kept: [] };
  if (typeof text !== 'string' || !/Presiden|Vicepresiden/.test(text)) return out;
  const { spans: quoted, unbalancedAt } = quotedSpans(text);
  /** @type {Array<{ start: number, end: number, replacement: string, rule: string }>} */
  const edits = [];

  for (const m of text.matchAll(ES_TOKEN)) {
    const start = /** @type {number} */ (m.index);
    const word = m[0];
    if (insideSpan(quoted, start)) {
      const reason = unbalancedAt !== null && start >= unbalancedAt ? 'after an unclosed quotation mark' : 'inside quotation marks';
      (reason.startsWith('after') ? out.skipped : out.kept).push({ at: start, match: word, reason });
      continue;
    }
    const prev = prevContext(text, start);
    if (prev.sentenceStart) continue;
    // Skip one "de"/"del" to reach the head of a possible institution name:
    // "Oficina Ejecutiva del Presidente", "Medalla Presidencial".
    let head = prev;
    if (ES_CONNECTORS.has(prev.word.toLowerCase()) && !prev.punct) head = prevContext(text, prev.tokenStart);
    const headIsName =
      head.word &&
      isCapitalized(head.word) &&
      !head.punct &&
      !head.sentenceStart &&
      !prevContext(text, head.tokenStart).sentenceStart &&
      !ES_DETERMINERS.has(head.word.toLowerCase());
    if (headIsName) {
      out.kept.push({ at: start, match: `${head.word} … ${word}`, reason: 'part of an institution name' });
      continue;
    }
    if (word === 'Presidencia') {
      out.skipped.push({ at: start, match: `${prev.word} ${word}`, reason: 'the office or the institution — the editor decides' });
      continue;
    }
    edits.push({ start, end: start + word.length, replacement: lowerFirst(word), rule: 'minúscula (RAE)' });
  }
  return applyEdits(out, edits);
}

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */

/**
 * @param {Result} out
 * @param {Array<{ start: number, end: number, replacement: string, rule: string }>} edits
 * @returns {Result}
 */
function applyEdits(out, edits) {
  if (!edits.length) return out;
  const text = out.text;
  let result = '';
  let cursor = 0;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    result += text.slice(cursor, e.start) + e.replacement;
    out.changes.push({ at: e.start, before: text.slice(e.start, e.end), after: e.replacement, rule: e.rule });
    cursor = e.end;
  }
  out.text = result + text.slice(cursor);
  return out;
}

/**
 * The one entry point the pipelines call.
 *
 * @param {string} text
 * @param {'en' | 'es'} lang
 * @param {{ titles?: string[] }} [opts]
 * @returns {Result}
 */
export function normalizePresidentStyle(text, lang, opts = {}) {
  return lang === 'es' ? normalizeSpanish(text) : normalizeEnglish(text, opts);
}

/**
 * The string-only form, for write paths that just need the fixed text.
 * Non-strings (null, undefined, arrays) pass through untouched.
 *
 * @template T
 * @param {T} text
 * @param {'en' | 'es'} lang
 * @param {{ titles?: string[] }} [opts]
 * @returns {T}
 */
export function presidentStyle(text, lang, opts = {}) {
  if (typeof text !== 'string') return text;
  return /** @type {T} */ (normalizePresidentStyle(text, lang, opts).text);
}

/**
 * A decode's sections object ({ tldr, what, who, why, cost, costChips }), with
 * every string and every chip normalized. Other keys pass through.
 *
 * @template {Record<string, any> | null | undefined} S
 * @param {S} sections
 * @param {'en' | 'es'} lang
 * @param {{ titles?: string[] }} [opts]
 * @returns {S}
 */
export function presidentStyleSections(sections, lang, opts = {}) {
  if (!sections || typeof sections !== 'object') return sections;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(sections)) {
    if (typeof v === 'string') out[k] = presidentStyle(v, lang, opts);
    else if (Array.isArray(v)) out[k] = v.map((x) => presidentStyle(x, lang, opts));
    else out[k] = v;
  }
  return /** @type {S} */ (out);
}

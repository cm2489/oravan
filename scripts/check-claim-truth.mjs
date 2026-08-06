/**
 * Zero-survivor claim-truth gate: CI fails when a surface that tells the
 * public HOW AI content gets published says something the pipeline does not
 * do.
 *
 * WHY THIS EXISTS, precisely. CLAUDE.md's 2026-07-25 amendment retired the
 * claim that AI decodes are "human-reviewed before publish" — the nightly
 * sync commits decodes straight to `main` with no human step. The amendment
 * was applied to four strings and missed four more (README principle 5,
 * lib/jsonld.ts's AI_DISCLOSURE, the MCP get_bill description, and BOTH
 * llms.txt occurrences), and were not noticed until 2026-08-06. The root cause
 * was not that someone typed a banned phrase: it was that NO TEST PINNED ANY
 * OF THESE STRINGS and nobody had ever enumerated which surfaces make a
 * publication-provenance claim at all. A phrase denylist would not have
 * helped — a reworded false claim sails straight through one.
 *
 * So the primary rule here is POSITIVE and ENUMERATED (R1): a closed list of
 * the surfaces that make the claim, each of which must carry an approved
 * provenance verb AND must fail every retired-review pattern. Adding a new
 * such surface without adding it here is the failure mode this cannot catch
 * on its own, which is why tests/claim-truth.spec.ts also asserts the
 * constitution documents agree with each other, and why R3 exists.
 *
 * Modeled structurally on scripts/check-naming.mjs, deliberately: patterns
 * assembled from fragments so this file carries no banned literal and needs
 * no self-exemption; a `max`-counted allowlist with written justifications
 * where a STALE entry (zero matches) fails; `--self-test` proving every rule
 * against seeded fixtures BEFORE the tree is scanned, so a broken regex
 * fails loudly instead of passing silently. Stdlib only.
 *
 * Usage:  node scripts/check-claim-truth.mjs --self-test
 *         node scripts/check-claim-truth.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/*
 * Fragments are joined with Array.prototype.join, NOT with `+`. That is not
 * cosmetic: readConcatenated() below splices `'a' + 'b'` back together before
 * matching (it has to — a claim can straddle a concatenation boundary), so a
 * `+`-assembled fragment in this file would reconstruct itself into a real
 * banned literal and the gate would flag its own source. A `,`-separated
 * argument list never does.
 */
const F = (...parts) => parts.join('');

const HUMAN = F('hum', 'an');
const REVIEW = F('rev', 'iew');
const REVISAD = F('revis', 'ad');

/**
 * The retired review claim, in every wording the repo has ever used for it,
 * in both languages. These are what a provenance surface must NOT say.
 */
const RETIRED = [
  {
    name: `"${HUMAN}-${REVIEW}" (EN)`,
    src: `${HUMAN}[\\s-]?${REVIEW}`,
  },
  {
    name: `"${REVIEW}ed by a ${HUMAN}/person" (EN)`,
    src: `${REVIEW}(ed|s)?\\s+by\\s+(a|the)\\s+(${HUMAN}|person)`,
  },
  {
    name: `"${REVISAD}o por una persona" (ES)`,
    src: `${REVISAD}[oa]s?\\s+por\\s+(una?\\s+)?(persona|${HUMAN}o|ser\\s+${HUMAN}o)`,
  },
  {
    name: `"revisión ${HUMAN}a" (ES)`,
    src: `revisi[óo]n\\s+${HUMAN}a`,
  },
];
const retiredRe = (p) => new RegExp(p.src, 'i');
const retiredReG = (p) => new RegExp(p.src, 'gi');

/**
 * The provenance verbs a claim surface IS allowed to make, per CLAUDE.md's
 * amended hard rule: labeled, and gated by automated checks. One of these
 * must be present — a surface that describes publication and names no
 * mechanism at all is the reworded-false-claim case a denylist misses, and
 * it fails here.
 */
const APPROVED = {
  en: [/automated\s+(check|gate)/i, /automatical(ly)?\s+check/i],
  es: [/controles?\s+autom[áa]ticos?/i, /control\s+autom[áa]tico/i, /verificad[oa]s?\s+autom[áa]ticamente/i],
};

/**
 * R2's two factors. Neither alone is a defect: the repo legitimately writes
 * "no advocacy language" as a DESIGN RULE (CLAUDE.md, AGENTS.md) and as a
 * PROMPT INSTRUCTION (lib/scriptprompt.ts, scripts/bill-decode.mjs), and it
 * legitimately describes publication gates all over the place. The defect is
 * the conjunction: naming advocacy as one of the gates a publish must pass,
 * outside Moments — where the forbidden-vocabulary lint really does run.
 *
 * GATE_CLAIM is deliberately phrase-shaped, never a bare /\bgates?\b/: the
 * word "gate" appears in half this repo's filenames (lib/moments-gate.mjs),
 * and a rule that cries wolf gets disabled.
 */
const ADVOCACY = [/\badvocacy\b/i, /\blenguaje\s+de\s+campa[ñn]a\b/i];
const GATE_CLAIM = [
  /\bpublish(es|ed|ing)?\b/i,
  /\bpublication\b/i,
  /automated\s+(check|gate)/i,
  /\bse\s+publica\b/i,
  /\bpublicaci[óo]n\b/i,
  /controles?\s+autom[áa]ticos?/i,
];

// ---------------------------------------------------------------------------
// Reading string literals out of TypeScript, concatenation and all
// ---------------------------------------------------------------------------

const QUOTES = new Set(["'", '"', '`']);
const UNESCAPE = { n: '\n', t: '\t', r: '\r' };

/** One string literal starting at `from`, or null if `from` isn't a quote. */
function readOneLiteral(text, from) {
  const q = text[from];
  if (!QUOTES.has(q)) return null;
  let out = '';
  for (let i = from + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      const next = text[i + 1];
      out += UNESCAPE[next] ?? next;
      i++;
      continue;
    }
    if (c === q) return { value: out, end: i + 1 };
    out += c;
  }
  return null;
}

/**
 * A run of `'…' + '…' + "…"` read as ONE value. This is the fragile part of
 * R1 and the reason it is written by hand rather than as a line regex:
 * TOOL_INFO.get_bill.description is six concatenated literals across six
 * source lines, so a claim can straddle a `+` boundary and be invisible to
 * any per-line match. Mixed quote characters matter too — one fragment is
 * double-quoted because it contains an apostrophe — which is why this reads
 * literals properly instead of splicing the source text.
 */
function readConcatenated(text, from) {
  const first = readOneLiteral(text, from);
  if (!first) return null;
  let value = first.value;
  let i = first.end;
  for (;;) {
    const plus = /^\s*\+\s*/.exec(text.slice(i, i + 200));
    if (!plus) break;
    const next = readOneLiteral(text, i + plus[0].length);
    if (!next) break;
    value += next.value;
    i = next.end;
  }
  return { value, end: i };
}

/**
 * Walk `anchors` in order (each an exact substring), then read the first
 * string literal after the last one. Returns null when any anchor is missing
 * — which the caller treats as a FAILURE, never a skip: an enumerated
 * surface that moved has to be re-enumerated, not silently dropped.
 */
function literalAfter(text, anchors) {
  let i = 0;
  for (const a of anchors) {
    const j = text.indexOf(a, i);
    if (j === -1) return null;
    i = j + a.length;
  }
  for (let k = i; k < text.length; k++) {
    if (QUOTES.has(text[k])) return readConcatenated(text, k)?.value ?? null;
  }
  return null;
}

/** A dotted path out of parsed JSON, or null. */
function jsonPath(obj, path) {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[key];
  }
  return typeof cur === 'string' ? cur : null;
}

/** The single line of a text file that starts with `prefix`, trimmed. */
function lineStartingWith(text, prefix) {
  const line = text.split('\n').find((l) => l.trimStart().startsWith(prefix));
  return line ? line.trim() : null;
}

// ---------------------------------------------------------------------------
// R1 — the enumerated provenance surfaces
// ---------------------------------------------------------------------------

/*
 * THE CLOSED LIST. Every surface here tells a reader (or a machine) how AI
 * content comes to be published. If you add one, add it here; if you delete
 * one, delete it here — a missing anchor fails this gate on purpose.
 *
 * `moments.aiNote` is on the list even though Moments carry the stricter,
 * genuinely-linted guarantee: the list is about surfaces that make the
 * claim, not surfaces suspected of lying.
 */
const ANCHORS = [
  { id: 'messages/en.json citations.aiBody', lang: 'en', kind: 'json', file: 'messages/en.json', path: 'citations.aiBody' },
  { id: 'messages/es.json citations.aiBody', lang: 'es', kind: 'json', file: 'messages/es.json', path: 'citations.aiBody' },
  { id: 'messages/en.json home.heroAiMeta', lang: 'en', kind: 'json', file: 'messages/en.json', path: 'home.heroAiMeta' },
  { id: 'messages/es.json home.heroAiMeta', lang: 'es', kind: 'json', file: 'messages/es.json', path: 'home.heroAiMeta' },
  { id: 'messages/en.json bills.aiNote', lang: 'en', kind: 'json', file: 'messages/en.json', path: 'bills.aiNote' },
  { id: 'messages/es.json bills.aiNote', lang: 'es', kind: 'json', file: 'messages/es.json', path: 'bills.aiNote' },
  { id: 'messages/en.json moments.aiNote', lang: 'en', kind: 'json', file: 'messages/en.json', path: 'moments.aiNote' },
  { id: 'messages/es.json moments.aiNote', lang: 'es', kind: 'json', file: 'messages/es.json', path: 'moments.aiNote' },
  { id: 'lib/core/mcp.ts AI_LABEL_TEXT.en', lang: 'en', kind: 'ts', file: 'lib/core/mcp.ts', anchors: ['AI_LABEL_TEXT', 'en:'] },
  { id: 'lib/core/mcp.ts AI_LABEL_TEXT.es', lang: 'es', kind: 'ts', file: 'lib/core/mcp.ts', anchors: ['AI_LABEL_TEXT', 'es:'] },
  { id: 'lib/core/mcp.ts TOOL_INFO.get_bill.description', lang: 'en', kind: 'ts', file: 'lib/core/mcp.ts', anchors: ['TOOL_INFO', 'get_bill:', 'description:'] },
  { id: 'lib/jsonld.ts AI_DISCLOSURE.en', lang: 'en', kind: 'ts', file: 'lib/jsonld.ts', anchors: ['AI_DISCLOSURE', 'en:'] },
  { id: 'lib/jsonld.ts AI_DISCLOSURE.es', lang: 'es', kind: 'ts', file: 'lib/jsonld.ts', anchors: ['AI_DISCLOSURE', 'es:'] },
  { id: 'app/llms.txt/route.ts corpus sentence', lang: 'en', kind: 'line', file: 'app/llms.txt/route.ts', prefix: 'Oravan publishes a plain-language' },
  { id: 'app/llms.txt/route.ts /bills note', lang: 'en', kind: 'line', file: 'app/llms.txt/route.ts', prefix: '- Content under /bills' },
];

/** R1's rule, run against one anchor's extracted text. Pure — self-tested. */
function checkAnchorText(text, lang) {
  const problems = [];
  if (!text) {
    problems.push('anchor not found — the enumerated surface moved or was deleted; re-enumerate it in ANCHORS');
    return problems;
  }
  for (const p of RETIRED) {
    if (retiredRe(p).test(text)) problems.push(`makes the retired review claim ${p.name}`);
  }
  if (!(APPROVED[lang] ?? []).some((re) => re.test(text))) {
    problems.push(
      `names no approved provenance mechanism (${lang}) — a publication claim must say what actually guards it, ` +
        'not merely drop the false part'
    );
  }
  return problems;
}

function extractAnchor(a, read) {
  if (a.kind === 'json') return jsonPath(JSON.parse(read(a.file)), a.path);
  if (a.kind === 'ts') return literalAfter(read(a.file), a.anchors);
  return lineStartingWith(read(a.file), a.prefix);
}

// ---------------------------------------------------------------------------
// R2 — two-factor: advocacy named AS a publish gate
// ---------------------------------------------------------------------------

/*
 * Sentence splitting stops at . ! ? and newlines ONLY — never at : or ;.
 * citations.aiBody lists its gates after a colon inside one sentence, so
 * splitting there would put the gate verb in one fragment and the advocacy
 * token in another, and the rule would never fire on the exact string it
 * exists to catch.
 */
function sentencesOf(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** R2's rule. Returns the offending sentences (empty = clean). Pure. */
function twoFactorHits(text) {
  return sentencesOf(text).filter(
    (s) => ADVOCACY.some((re) => re.test(s)) && GATE_CLAIM.some((re) => re.test(s))
  );
}

// ---------------------------------------------------------------------------
// R3 — single-factor tripwire over a positive scan set
// ---------------------------------------------------------------------------

/*
 * R1 only knows the surfaces it was told about. R3 is the net under it: a
 * plain scan for the retired claim anywhere a claim could plausibly ship.
 *
 * SCANNED: the app, components, lib, scripts, i18n, the four constitution
 * documents, AGENTS.md, and docs/mcp-server-readme.md (the only doc that is
 * redistributed to third-party directories, so the only doc whose staleness
 * reaches strangers). messages/*.json are scanned separately, per key, so
 * the Moments namespace can be excluded precisely rather than by file.
 *
 * NOT SCANNED, and why — written down because an unexplained exclusion is
 * how a gate rots:
 *   - tests/          builds hostile fixtures on purpose (tests/claim-truth.
 *                     spec.ts literally seeds this gate's violations); a
 *                     scan here would fail on its own test suite.
 *   - docs/migration/ dated historical record of the rename/migration, kept
 *                     verbatim by founder ruling (see check-naming.mjs).
 *   - docs/es-*       dated Spanish spot-check transcripts; they quote the
 *                     copy AS IT WAS on the day of the check, which is the
 *                     whole point of a spot-check record.
 *   - docs/solutions/ dated incident write-ups; same reason.
 *   - .impeccable/    dated design-review captures.
 *   - STATUS.md       dated progress log, append-only by convention.
 *   - data/, public/, .github/, package-lock.json, binaries — not claim
 *     surfaces; data/ is machine-written corpus.
 */
const SCAN_DIRS = ['app/', 'components/', 'lib/', 'scripts/', 'i18n/'];
const SCAN_FILES = [
  'README.md',
  'CLAUDE.md',
  'PRODUCT.md',
  'DESIGN.md',
  'AGENTS.md',
  'docs/mcp-server-readme.md',
];
const SCAN_EXT = /\.(ts|tsx|mjs|js|md)$/;
const MESSAGE_FILES = ['messages/en.json', 'messages/es.json'];

/*
 * THE ONE SELF-EXEMPTION, and why it exists where check-naming.mjs needs
 * none. That gate bans proper nouns, so assembling them from fragments is
 * enough to keep its own source clean. R2 here bans a CONJUNCTION — an
 * advocacy token beside a publish-gate token — and this file cannot explain,
 * name, report, or seed that conjunction without writing it down: its error
 * strings say "names advocacy as a publish gate", its self-test fixtures are
 * deliberately-malformed copy, and its self-test LABELS describe what each
 * fixture does. Rewording all of that to dodge the regex would leave a file
 * nobody can read, which is how a gate stops being maintained.
 *
 * What keeps this from being a hole: nothing in this file is a claim
 * surface. It renders nowhere, ships to no reader, is redistributed to no
 * directory, and holds no user-facing string — every literal in it exists to
 * describe a violation or to seed one. R1's enumerated anchors all live in
 * other files, and they are checked here regardless. The rule's teeth are
 * proven by --self-test, not by scanning its own source.
 */
const SELF = 'scripts/check-claim-truth.mjs';

const inScanSet = (f) =>
  f !== SELF && (SCAN_FILES.includes(f) || (SCAN_DIRS.some((d) => f.startsWith(d)) && SCAN_EXT.test(f)));

/*
 * R3's allowlist. Every entry is a place the retired wording legitimately
 * survives — always as an AMENDMENT RECORD (the constitution quoting what it
 * used to say, so the correction is legible in the file rather than only in
 * git) or as a TRUE, EXPLICITLY-SCOPED claim (call scripts; Moments).
 *
 * `max` is the exact current match count, so a regression past it still
 * fails, and a STALE entry (zero matches) fails too — remove the entry in
 * the same change that removes the last quotation. `allow`, where present,
 * is the closed set of CATEGORIES the quotation's own claim unit must fall
 * into: it is what makes "amendment record" a mechanical category rather
 * than a promise.
 *
 * WHY THE CATEGORIES ARE NAMED PER ENTRY rather than one shared predicate.
 * Until 2026-08-06 there was a single `context` regex, tested against the
 * matching line ±2 lines, and it had a hole wide enough to pass the very
 * claim this gate was built to catch: `origin/main`'s README principle 5
 * ("reviewed by the human before any call") sat one line under principle 4,
 * which carries "(Amended 2026-07-26; previously …)" — so the neighbour's
 * amendment parenthetical excused it and the gate exited 0 on the live
 * false claim. In a dense markdown principles list EVERY line is adjacent
 * to some amendment parenthetical, so README, CLAUDE.md and PRODUCT.md each
 * got a free pass for one live retired claim. Two changes close it: the
 * unit is now the SENTENCE the quotation sits in (see claimUnits below),
 * and each file declares only the categories its own note actually claims,
 * so README — amendment-record only — cannot borrow a Moments carve-out or
 * a denial that belongs to a different document.
 */

/**
 * An AMENDMENT RECORD quotes what the text used to say. Mechanically: the
 * sentence carries a correction marker (`Amended`, `Corrected`, `Reworded`)
 * or a past-tense self-quotation verb ("it said …", "this comment quoted
 * …"). The self-quotation verbs matter — lib/jsonld.ts's note opens its
 * paragraph with "(1) It said "…"", with the dated "Corrected 2026-08-06"
 * a paragraph above, and that is a real amendment record.
 */
const AMENDMENT_RECORD = {
  name: 'amendment record',
  re: /amended|corrected|reworded|retired|previously|inherited the false claim|no longer|never did|\bused to\b|\bit (said|claimed|read)\b|this (line|comment|file|note)\s+(\w+\s+){0,3}(said|read|quoted|carried)/i,
};

/**
 * A DENIAL says the thing does NOT happen — PRODUCT.md's "The nightly
 * decode path is not human-reviewed and the product never claims it is."
 * Deliberately narrow: a bare `\bwithout\b` or a stray `\bnever\b` anywhere
 * in a five-line window is what let tests/claim-truth.spec.ts report zero
 * violations against the pre-fix documents, so this must attach to the
 * claim's own verb, in its own sentence.
 */
const DENIAL = {
  name: 'denial',
  re: /\b(is|are|was|were|has|have|had)\s+(no longer\s+)?not\b|\bnever\s+(been\s+)?(human|revisad|review|claim|did|does|do)/i,
};

/**
 * TRUE AND MOMENTS-SCOPED. Big Question entries really are hand-authored
 * and owner-merged — the explicit carve-out in CLAUDE.md's 2026-07-25
 * amendment — so a review claim whose own sentence names Moments is simply
 * true. Note what this does NOT match: "reviewed by the human before any
 * call" names no scope at all, which is why the pre-fix README still fails.
 */
const MOMENTS_SCOPED = { name: 'true and Moments-scoped', re: /\bmoments?\b|big question|gran(des)? pregunta/i };

/** TRUE AND CALL-SCRIPT-SCOPED. The one review the product really claims. */
const CALL_SCRIPT_SCOPED = {
  name: 'true and call-script-scoped',
  re: /call script|\bcaller\b|guion(es)? de llamada|\bel guion\b/i,
};

const R3_ALLOWLIST = [
  {
    path: 'README.md',
    max: 1,
    allow: [AMENDMENT_RECORD],
    note: "principle 5's amendment parenthetical quotes the wording it retired on 2026-08-06",
  },
  {
    path: 'CLAUDE.md',
    max: 3,
    allow: [AMENDMENT_RECORD, MOMENTS_SCOPED],
    note: 'the 2026-07-25 amendment quotes the retired wording (1), and the sentence after it carves out the one thing that IS reviewed — a Moment entry, hand-authored and owner-merged (2)',
  },
  {
    path: 'PRODUCT.md',
    max: 2,
    allow: [AMENDMENT_RECORD, DENIAL],
    note: "design principle 5 denies the claim for the decode path (1) and records the 2026-08-02 amendment that retired it (1), mirroring CLAUDE.md's",
  },
  {
    path: 'lib/core/mcp.ts',
    max: 2,
    allow: [AMENDMENT_RECORD],
    note: "AI_LABEL_TEXT's correction note (2026-07-25) and getBillDetail's not-in-scope note, both quoting the retired rule as history",
  },
  {
    path: 'lib/jsonld.ts',
    max: 1,
    allow: [AMENDMENT_RECORD],
    note: "AI_DISCLOSURE's correction note (2026-08-06) quoting what it used to say",
  },
  {
    path: 'scripts/moment-updates.mjs',
    max: 1,
    allow: [AMENDMENT_RECORD],
    note: 'the constitutional-posture header records which CLAUDE.md wording it used to quote',
  },
  {
    /*
     * The one entry with no category predicate, and the reason is the file
     * itself: lib/moments-gate.mjs IS the Big Questions gate — every
     * sentence in it is Moments-scoped by construction, so the sentence
     * "Human review enforces the at-creation rule" needs no scope word to
     * be true. Kept at max 1 so a second, differently-scoped claim landing
     * in this file still fails.
     */
    path: 'lib/moments-gate.mjs',
    max: 1,
    note: 'TRUE and Moments-scoped by file: a Moment entry is hand-authored and owner-merged (CLAUDE.md 2026-07-25 carve-out), so review really does enforce the at-creation rule this softening skips',
  },
];

/*
 * The message-key allowlist is separate because messages are scanned per
 * key, not per file. Everything under `moments.` is skipped wholesale:
 * Moment entries genuinely are hand-authored and merged by the owner — the
 * explicit carve-out in CLAUDE.md's 2026-07-25 amendment — so
 * `moments.howMadeBody` saying "reviewed by a person" is the one place the
 * claim is simply true.
 *
 * The claim unit for a message is the WHOLE VALUE, not a sentence: a
 * message is one authored string that ships to one reader as one paragraph,
 * so its scope really is set by any sentence in it. That is still far
 * tighter than a file, which is why files get sentences and messages get
 * values.
 */
const MOMENTS_NAMESPACE = 'moments.';
const R3_KEY_ALLOWLIST = [
  {
    key: 'citations.aiCallScript',
    max: 1,
    allow: [CALL_SCRIPT_SCOPED],
    note: 'TRUE and call-script-scoped: a caller reads and can edit the script before dialing; the MCP server refuses to generate one so an agent cannot skip that (lib/core/mcp.ts getBillDetail)',
  },
];

/** Flatten a messages object to [dottedKey, string] pairs. */
function flattenMessages(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.push([key, v]);
    else if (v && typeof v === 'object') out.push(...flattenMessages(v, key));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The CLAIM UNIT — what an allowlist category is allowed to speak for
// ---------------------------------------------------------------------------

/*
 * A quotation of the retired claim is excused by the amendment record that
 * is ABOUT IT, and by nothing else. Mechanically, "about it" means the two
 * are one sentence — an amendment record quotes the retired wording inside
 * its own clause or parenthetical ("Amended 2026-08-06; previously "…""),
 * it does not merely sit near it.
 *
 * A sentence alone is not enough to compute, though, because this repo's
 * explanatory block comments wrap at ~76 columns: "Corrected 2026-07-25
 * (pre-launch audit): it claimed "human-reviewed before publish"" is one
 * sentence spread over two source lines. So the unit is built in two steps
 * — reassemble the PARAGRAPH across wrapped lines, then take the SENTENCE
 * inside it. The paragraph exists only to undo line wrapping; it never
 * widens the unit past a sentence.
 *
 * What ends a paragraph, and why each boundary is load-bearing:
 *   - a blank line (in a block comment, a bare ` *` counts) — separates
 *     lib/jsonld.ts's dated "Corrected 2026-08-06, twice over." header from
 *     the numbered notes under it;
 *   - in markdown, the start of a list item, numbered item, heading or
 *     quote — this is the boundary the old ±2-line window did not have, and
 *     the reason principle 4's parenthetical could excuse principle 5's
 *     live claim;
 *   - in code, crossing between comment lines and code lines — a comment
 *     never speaks for the statement below it.
 */
const MD_BLOCK_START = /^\s{0,3}([-*+]\s|\d+[.)]\s|#{1,6}\s|>|\|)/;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
const COMMENT_LEADER = /^\s*(\/\*+|\*\/|\*|\/\/+)\s?/;

/** Drop a block/line comment leader so wrapped comment prose reads as prose. */
const stripLeader = (line, markdown) => (markdown ? line : line.replace(COMMENT_LEADER, ''));

/**
 * Every paragraph of `text` as { firstLine, lines, text } — `text` collapsed
 * to one line so a sentence split works across the original wrapping.
 */
function paragraphsOf(text, markdown) {
  const lines = text.split('\n');
  const isBlank = (i) => stripLeader(lines[i], markdown).trim() === '';
  const sameClass = (i, j) => markdown || COMMENT_LINE.test(lines[i]) === COMMENT_LINE.test(lines[j]);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (isBlank(i)) {
      i++;
      continue;
    }
    let end = i;
    while (
      end + 1 < lines.length &&
      !isBlank(end + 1) &&
      sameClass(end, end + 1) &&
      !(markdown && MD_BLOCK_START.test(lines[end + 1]))
    ) {
      end++;
    }
    const slice = lines.slice(i, end + 1);
    out.push({
      firstLine: i + 1,
      lines: slice,
      text: slice
        .map((l) => stripLeader(l, markdown))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    });
    i = end + 1;
  }
  return out;
}

/**
 * Split a collapsed paragraph into sentences. `.`/`!`/`?` followed by
 * whitespace only — never `:` or `;`, for the same reason sentencesOf()
 * above doesn't: a gate list written after a colon is one claim, and
 * splitting it would hand each half a different verdict.
 */
const splitSentences = (paragraph) =>
  paragraph
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * R3's rule over one blob. Returns [{ line, pattern, count, text, context }]
 * where `context` is the CLAIM UNIT — the single sentence the quotation sits
 * in. Pure.
 *
 * `line` is best-effort for the error message: the first source line in the
 * paragraph that carries the pattern on its own, falling back to the
 * paragraph's first line when the match straddles a wrap.
 */
function retiredHits(text, { markdown = false } = {}) {
  const hits = [];
  for (const para of paragraphsOf(text, markdown)) {
    for (const sentence of splitSentences(para.text)) {
      for (const p of RETIRED) {
        const found = sentence.match(retiredReG(p));
        if (!found) continue;
        const offset = para.lines.findIndex((l) => retiredRe(p).test(l));
        hits.push({
          line: para.firstLine + (offset === -1 ? 0 : offset),
          pattern: p.name,
          count: found.length,
          text: sentence,
          context: sentence,
        });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Self-test — must pass before the tree is scanned
// ---------------------------------------------------------------------------

const REAL_GET_BILL_STRADDLE = [
  "  description:",
  "    'Get the full plain-language decode of a federal bill. Returns the AI-generated summary ' +",
  `    '(headline, tl;dr - ${HUMAN}-' +`,
  `    '${REVIEW}ed before publish and automatically checked), the official status.',`,
].join('\n');

function selfTest() {
  const failures = [];
  const seeded = [];
  const seed = (label, fn) => {
    seeded.push(label);
    if (!fn()) failures.push(`seeded violation NOT caught: ${label}`);
  };
  const clean = (label, fn) => {
    if (!fn()) failures.push(`clean fixture wrongly flagged: ${label}`);
  };

  // --- R1 violations -------------------------------------------------------
  seed('R1/en: retired review claim inside an enumerated anchor', () =>
    checkAnchorText(
      `No field publishes unless automated gates pass, and every decode is ${HUMAN}-${REVIEW}ed first.`,
      'en'
    ).length > 0
  );
  seed('R1/en: "reviewed by the human" phrasing', () =>
    checkAnchorText(
      `Every summary is labeled, automatically checked, and ${REVIEW}ed by the ${HUMAN} before any call.`,
      'en'
    ).length > 0
  );
  seed('R1/es: retired review claim in Spanish', () =>
    checkAnchorText(
      `Nada se publica sin pasar controles automáticos y cada resumen es ${REVISAD}o por una persona.`,
      'es'
    ).length > 0
  );
  seed('R1/es: "revisión humana" phrasing', () =>
    checkAnchorText(`Controles automáticos y una revisión ${HUMAN}a antes de publicarse.`, 'es').length > 0
  );
  seed(
    'R1/positive-half: anchor reworded to a bland sentence with NO banned phrase at all — the case a denylist cannot catch',
    () => checkAnchorText('Two kinds of text appear on a bill page, and they are never presented the same way.', 'en').length > 0
  );
  seed('R1: an enumerated anchor that no longer exists', () => checkAnchorText(null, 'en').length > 0);
  seed('R1: violation straddling a `+` concatenation boundary in TypeScript', () => {
    const value = literalAfter(REAL_GET_BILL_STRADDLE, ['description:']);
    // The point of the fixture: no single SOURCE LINE carries the claim...
    const anyRawLine = REAL_GET_BILL_STRADDLE.split('\n').some((l) =>
      RETIRED.some((p) => retiredRe(p).test(l))
    );
    // ...but the joined VALUE does, and R1 sees it.
    return anyRawLine === false && value !== null && checkAnchorText(value, 'en').length > 0;
  });

  // --- R2 violations -------------------------------------------------------
  seed('R2/en: advocacy named as one of the publish gates, same sentence', () =>
    twoFactorHits(
      'No field publishes unless automated gates pass: both languages present, no advocacy language, and a schema.'
    ).length > 0
  );
  seed('R2/es: advocacy named as one of the publish gates, same sentence', () =>
    twoFactorHits(
      'Ningún campo se publica sin pasar controles automáticos: los dos idiomas, sin lenguaje de campaña, y un esquema.'
    ).length > 0
  );

  // --- R3 violations -------------------------------------------------------
  seed('R3: retired claim in an unenumerated file', () =>
    retiredHits(`// every decode is ${HUMAN} ${REVIEW}ed before it ships`).length > 0
  );
  seed('R3: "reviewed by a human before publication" in prose', () =>
    retiredHits(`Content under /bills is ${REVIEW}ed by a ${HUMAN} before publication.`).length > 0
  );
  seed('R3: allowlisted file, but the quotation is a live claim rather than an amendment record', () => {
    const blob = ['// unrelated line', `// every decode is ${HUMAN}-${REVIEW}ed first`, '// unrelated line'].join('\n');
    const hits = retiredHits(blob);
    return hits.length > 0 && !AMENDMENT_RECORD.re.test(hits[0].context);
  });

  /*
   * THE REGRESSION THAT MATTERS, kept as a fixture because it is the exact
   * shape this gate exited 0 on. These are `origin/main`'s README principles
   * 4 and 5, verbatim but for the assembled phrase: 4 carries an amendment
   * parenthetical, 5 is the live false claim. Under the old ±2-line window
   * the neighbour excused it. The claim unit is now principle 5's own
   * sentence, which contains no amendment marker at all.
   */
  const README_NEIGHBOUR_FIXTURE = [
    '4. **Truth first; the call is the natural next step.** Oravan leads as an unbiased, plain-words account of what Congress is actually doing. *(Amended 2026-07-26; previously "The call moment is the product." Enforced by the three named invariants in `tests/funnel.spec.ts`.)*',
    `5. **Honest about AI.** Every generated summary and script is labeled, editable, and ${REVIEW}ed by the ${HUMAN} before any call.`,
  ].join('\n');

  seed(
    "R3: a live claim in a markdown list item whose NEIGHBOUR carries an amendment parenthetical (origin/main's README principles 4+5)",
    () => {
      const hits = retiredHits(README_NEIGHBOUR_FIXTURE, { markdown: true });
      if (hits.length !== 1) return false;
      // The claim unit must be principle 5's sentence, and must NOT have
      // dragged principle 4's "Amended 2026-07-26; previously" along.
      if (/Amended|previously/i.test(hits[0].context)) return false;
      return !AMENDMENT_RECORD.re.test(hits[0].context) && !MOMENTS_SCOPED.re.test(hits[0].context) && !DENIAL.re.test(hits[0].context);
    }
  );

  seed('R3: an amendment record in the same paragraph but a DIFFERENT sentence does not excuse a live claim', () => {
    const blob = [
      ' * Corrected 2026-08-06: the disclosure below no longer overstates the',
      ' * gates. Separately, and still live in the file, every decode is',
      ` * ${HUMAN}-${REVIEW}ed before publication.`,
    ].join('\n');
    const hits = retiredHits(blob);
    return hits.length === 1 && !AMENDMENT_RECORD.re.test(hits[0].context);
  });

  seed('R3: a bare "never"/"without" elsewhere in the paragraph is not a denial of THIS claim', () => {
    const blob = [
      ' * AI content is labeled at first contact and',
      ` * ${HUMAN}-${REVIEW}ed before it drives a call. The label sits with the`,
      ' * content, above the fold — never in a footnote, and without exception.',
    ].join('\n');
    const hits = retiredHits(blob);
    return hits.length === 1 && !DENIAL.re.test(hits[0].context) && !AMENDMENT_RECORD.re.test(hits[0].context);
  });

  // --- Clean fixtures, drawn from REAL shipped text ------------------------
  // Each of these is a string this repo actually ships. If the gate fires on
  // any of them it is crying wolf, and a gate people disable is worse than
  // no gate at all.
  const REAL = {
    aiBodyEn:
      'The plain-language layer is AI-drafted, and no field publishes unless automated gates pass: both languages ' +
      'present, the official record attached, and a schema check on every decode — a decode that comes back ' +
      'missing a required field is discarded rather than stored half-written.',
    aiBodyEs:
      'La capa en lenguaje sencillo la redacta la IA, y ningún campo se publica sin pasar controles automáticos: ' +
      'los dos idiomas presentes, el registro oficial adjunto, y una verificación de esquema en cada resumen.',
    heroEn: 'Nothing publishes without automated checks · the official record is always attached',
    labelEs:
      'Este contenido en lenguaje sencillo es generado por IA y verificado automáticamente antes de publicarse. ' +
      'No es el texto oficial del proyecto de ley.',
    nonpartisanRule: '- **Nonpartisan by construction.** No party-coded colors, no advocacy language, in either language.',
    scriptPrompt: '- Strictly nonpartisan tone: no party language, no attacks, no alarmism, no advocacy-group jargon.',
    decodePrompt: 'Strictly nonpartisan, no advocacy, no preamble, no markdown.',
    momentsAiNoteEn:
      'Every Big Question summary is AI-drafted from the public record and labeled. Nothing publishes until it ' +
      'passes automated checks — both languages, the record attached, no advocacy language.',
    momentsLintHeader:
      ' *     forbidden-vocabulary lint over name/summary/role in BOTH languages — the versioned word list from ' +
      'the spec, so refusals are legible as mechanics. The lint is the tripwire; owner review is the real gate.',
    mcpAvoidList:
      '**Avoid list, honored here on purpose:** no *advocacy*, *mobilize*, *campaign*, *pressure*, or *flood* ' +
      'language anywhere in this file. This is nonpartisan civic information infrastructure.',
  };

  clean('R1: real citations.aiBody (en) passes', () => checkAnchorText(REAL.aiBodyEn, 'en').length === 0);
  clean('R1: real citations.aiBody (es) passes', () => checkAnchorText(REAL.aiBodyEs, 'es').length === 0);
  clean('R1: real home.heroAiMeta (en) passes', () => checkAnchorText(REAL.heroEn, 'en').length === 0);
  clean('R1: real AI_LABEL_TEXT (es) passes', () => checkAnchorText(REAL.labelEs, 'es').length === 0);
  clean("R2: CLAUDE.md's nonpartisan design rule (advocacy, no gate claim)", () => twoFactorHits(REAL.nonpartisanRule).length === 0);
  clean('R2: lib/scriptprompt.ts prompt instruction', () => twoFactorHits(REAL.scriptPrompt).length === 0);
  clean('R2: scripts/bill-decode.mjs prompt instruction', () => twoFactorHits(REAL.decodePrompt).length === 0);
  clean('R2: docs/mcp-server-readme.md avoid list', () => twoFactorHits(REAL.mcpAvoidList).length === 0);
  clean('R2: moments.aiNote is legitimate and namespace-excluded', () => {
    // Two factors DO co-occur here — which is exactly why the Moments
    // namespace is excluded rather than the rule being weakened.
    if (twoFactorHits(REAL.momentsAiNoteEn).length === 0) return false;
    return MOMENTS_NAMESPACE === 'moments.' && 'moments.aiNote'.startsWith(MOMENTS_NAMESPACE);
  });
  clean('R2/R3: lib/moments-gate.mjs header (owner review is real there)', () => twoFactorHits(REAL.momentsLintHeader).length === 0);
  clean('R3: an amendment record satisfies the allowlist category', () =>
    AMENDMENT_RECORD.re.test(`this line previously read "${HUMAN}-${REVIEW}ed", which the decode path never did`)
  );
  clean('R3: ONE sentence wrapped across three comment lines is reassembled, so the marker still reaches its own quotation', () => {
    const blob = [
      ' * Corrected 2026-08-06, because this was never true of the decode',
      ' * path, which commits straight to main:',
      ` * it said "${HUMAN}-${REVIEW}ed before publication".`,
    ].join('\n');
    const hits = retiredHits(blob);
    return hits.length > 0 && AMENDMENT_RECORD.re.test(hits[0].context);
  });
  clean("R3: lib/jsonld.ts's real numbered correction note — a past-tense self-quotation IS an amendment record", () => {
    const blob = [
      ' * Corrected 2026-08-06, twice over.',
      ' *',
      ` * (1) It said "${HUMAN}-${REVIEW}ed before publication", which the decode path has`,
      ' *     never done — the nightly sync commits decodes straight to main.',
    ].join('\n');
    const hits = retiredHits(blob);
    return hits.length === 1 && AMENDMENT_RECORD.re.test(hits[0].context);
  });
  clean("R3: CLAUDE.md's real Moments carve-out is TRUE, and its own sentence names the scope", () => {
    const line = `**What IS ${HUMAN}-${REVIEW}ed stays ${HUMAN}-${REVIEW}ed:** a Moment entry is hand-authored and merged by Colby, and \`moments.howMadeBody\` still says so because it is true.`;
    const hits = retiredHits(line, { markdown: true });
    return hits.length > 0 && hits.every((h) => MOMENTS_SCOPED.re.test(h.context));
  });
  clean("R3: PRODUCT.md's real denial is a denial in its own sentence", () => {
    const line = `The nightly decode path is not ${HUMAN}-${REVIEW}ed and the product never claims it is; what IS hand-reviewed (Big Question entries) says so because it is true.`;
    const hits = retiredHits(line, { markdown: true });
    return hits.length > 0 && hits.every((h) => DENIAL.re.test(h.context));
  });

  if (failures.length) {
    for (const f of failures) console.error(`::error::check-claim-truth self-test failed: ${f}`);
    process.exit(1);
  }
  console.log(`check-claim-truth self-test passed: all ${seeded.length} seeded violations caught, clean fixtures untouched.`);
}

// ---------------------------------------------------------------------------
// Tree scan
// ---------------------------------------------------------------------------

function scanTree() {
  const read = (f) => readFileSync(f, 'utf8');
  let failures = 0;
  const fail = (msg, loc) => {
    console.error(loc ? `::error file=${loc}::check-claim-truth: ${msg}` : `::error::check-claim-truth: ${msg}`);
    failures++;
  };

  // --- R1 ------------------------------------------------------------------
  for (const a of ANCHORS) {
    let text = null;
    try {
      text = extractAnchor(a, read);
    } catch (err) {
      fail(`R1 ${a.id}: could not read the surface (${err.message})`, a.file);
      continue;
    }
    for (const problem of checkAnchorText(text, a.lang)) fail(`R1 ${a.id}: ${problem}`, a.file);
  }

  const files = execSync('git ls-files', { encoding: 'utf8' }).trim().split('\n');
  const scanned = files.filter(inScanSet);
  const allowUsage = new Map();
  const keyAllowUsage = new Map();

  // --- R2 + R3 over the file scan set --------------------------------------
  for (const file of scanned) {
    let content;
    try {
      content = read(file);
    } catch {
      continue;
    }

    for (const sentence of twoFactorHits(content)) {
      fail(
        `R2 names advocacy as a publish gate outside Moments — that lint runs on Big Questions only: ${sentence.slice(0, 160)}`,
        file
      );
    }

    const allowance = R3_ALLOWLIST.find((e) => e.path === file);
    let count = 0;
    for (const hit of retiredHits(content, { markdown: file.endsWith('.md') })) {
      count += hit.count;
      if (!allowance) {
        fail(`R3 line ${hit.line}: retired review claim ${hit.pattern} — ${hit.text.slice(0, 140)}`, file);
      } else if (allowance.allow && !allowance.allow.some((c) => c.re.test(hit.context))) {
        fail(
          `R3 line ${hit.line}: ${file} is allowlisted only for ${allowance.allow.map((c) => c.name).join(' / ')}, ` +
            `and the sentence carrying this quotation is none of those — ${hit.text.slice(0, 140)}`,
          file
        );
      }
    }
    if (allowance) {
      allowUsage.set(allowance, (allowUsage.get(allowance) ?? 0) + count);
      if (count > allowance.max) {
        fail(`R3 ${file} has ${count} retired-claim quotations, allowlist permits ${allowance.max} (${allowance.note})`, file);
      }
    }
  }

  // --- R2 + R3 over the message catalogues, per key -------------------------
  for (const file of MESSAGE_FILES) {
    const entries = flattenMessages(JSON.parse(read(file)));
    for (const [key, value] of entries) {
      if (key.startsWith(MOMENTS_NAMESPACE)) continue;
      for (const sentence of twoFactorHits(value)) {
        fail(`R2 ${key} names advocacy as a publish gate outside the Moments namespace: ${sentence.slice(0, 160)}`, file);
      }
      const allowance = R3_KEY_ALLOWLIST.find((e) => e.key === key);
      const hits = retiredHits(value);
      const count = hits.reduce((n, h) => n + h.count, 0);
      if (count && !allowance) {
        fail(`R3 ${key}: retired review claim ${hits[0].pattern} — ${value.slice(0, 140)}`, file);
      }
      // A message's claim unit is the whole value (see R3_KEY_ALLOWLIST).
      if (count && allowance?.allow && !allowance.allow.some((c) => c.re.test(value))) {
        fail(
          `R3 ${key}: allowlisted only for ${allowance.allow.map((c) => c.name).join(' / ')}, ` +
            `and this message is none of those — ${value.slice(0, 140)}`,
          file
        );
      }
      if (allowance) {
        keyAllowUsage.set(allowance, (keyAllowUsage.get(allowance) ?? 0) + count);
        if (count > allowance.max) {
          fail(`R3 ${key} has ${count} retired-claim mentions, allowlist permits ${allowance.max} (${allowance.note})`, file);
        }
      }
    }
  }

  // --- Stale allowlist entries weaken the gate silently ---------------------
  for (const e of R3_ALLOWLIST) {
    if ((allowUsage.get(e) ?? 0) === 0) fail(`stale allowlist entry ${e.path} (zero matches) — remove it (${e.note})`);
  }
  for (const e of R3_KEY_ALLOWLIST) {
    if ((keyAllowUsage.get(e) ?? 0) === 0) fail(`stale allowlist entry ${e.key} (zero matches) — remove it (${e.note})`);
  }

  if (failures) {
    console.error(
      `check-claim-truth: ${failures} failure(s). A publication-provenance claim must describe what actually runs — ` +
        "see CLAUDE.md's AI-content hard rule and README design principle 5."
    );
    process.exit(1);
  }
  console.log(
    `check-claim-truth passed: ${ANCHORS.length} enumerated provenance surfaces verified, ` +
      `${scanned.length + MESSAGE_FILES.length} files scanned, ` +
      `${R3_ALLOWLIST.length + R3_KEY_ALLOWLIST.length} written exemptions honored, ` +
      '1 self-exemption (this file).'
  );
}

if (process.argv.includes('--self-test')) selfTest();
else scanTree();

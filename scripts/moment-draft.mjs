/**
 * Moment draft — the FIRST DRAFT of a Big Question's prose, written from the
 * candidate's own record so the owner edits instead of composing from blank.
 *
 * WHY THIS EXISTS. scripts/moment-watch.mjs delivered a scaffold whose every
 * user-facing string was empty, under the banner "facts only — you write every
 * sentence". The owner's ruling, 2026-08-07: *"I want to review and edit the
 * writing and the choice of what goes up. I don't actually want to write
 * them."* A blank form is not a smaller ask than a bad draft; it is a bigger
 * one. So this module fills the three slots — name, summary, and the vehicle's
 * role — in both languages, and the owner's job becomes editing and merging,
 * which is what he actually wants to do and what `moments.howMadeBody` has
 * always described.
 *
 * WHAT IT IS NOT. It is not a proposal, it is not publishable, and it is not
 * on any path to `main`. Nothing here writes a file; the draft rides inside a
 * GitHub issue body that a person must copy, edit, and open a PR with, where
 * scripts/check-moments.mjs then runs the real gate. The one automated
 * guarantee made here is stated exactly, below, and no more.
 *
 * ---------------------------------------------------------------------------
 * FOUR PROPERTIES, each of which is why the pipeline it feeds is trusted:
 *
 * 1. DEGRADE, NEVER BLOCK. No key, an API error, an unparseable reply, a
 *    lint-rejected field — every one of them falls back to the blank string
 *    that shipped before this module existed, and the issue still opens. The
 *    watcher's whole value is that silence means "nothing crossed the floor";
 *    that only holds if noise is never silence. Delivery therefore never
 *    depends on the model. Every exit from draftFor() is a return, never a
 *    throw, and tests/moment-draft.unit.spec.ts pins each one.
 *
 * 2. LINTED BEFORE IT IS OFFERED. Handing the owner copy that cannot merge is
 *    worse than handing him blanks — he would edit it, open the PR, and learn
 *    from CI. Every field is run through lintRevisionText (lib/moment-updates-
 *    gate.mjs) in BOTH languages before it is shown: layer 1 of that function
 *    IS `lintForbidden` from lib/moments-gate.mjs — the same table
 *    scripts/check-moments.mjs will apply to the merged entry, imported, never
 *    copied (v2 spec §2.3) — and layer 2 is the speculation lint. A field that
 *    trips either is retried once and then dropped to blank, and the issue
 *    says which field was dropped and why.
 *
 * 3. BILINGUAL, OR NEITHER. EN and ES are validated as a unit per field. A
 *    field whose Spanish is missing, empty, or lint-dirty is blanked in BOTH
 *    languages, because a half-drafted field is a bilingual-parity failure
 *    waiting to be pasted into data/moments.json.
 *
 * 4. VISIBLY A DRAFT. This module returns prose and the notes explaining what
 *    happened to it; scripts/moment-watch.mjs is what labels it in the issue,
 *    and DRAFT_LABEL below is the sentence it prints. Nothing here ever says,
 *    or lets the issue imply, that a person wrote this.
 *
 * NO INVENTED FACTS, and one specific one: **the corpus carries zero
 * forward-looking scheduled-vote dates.** `floor_vote` is a calendar
 * PLACEMENT, not a date; `data/bills.json` has no field that could hold one.
 * So a vote date is not derivable, and a draft that states or implies one is
 * fabricating. The prompt says so twice and FUTURE_VOTE below rejects the
 * constructions mechanically, in both languages, alongside the two lints.
 *
 * NO INTERNAL ENUM EVER REACHES THE MODEL, and this is a rule with a body
 * count. scripts/moment-updates.mjs's first live run leaked the raw token
 * "floor_vote" into published prose in both languages. The record block then
 * leaked a second one for months in a subtler shape — "press: neutral
 * coverage across 3 outlet(s)" handed the model `neutral`, which is a verdict
 * of OUR AllSides lookup table ("two or more outlets, none of them
 * lean-rated") and not a description of anybody's reporting, and it shipped as
 * a published characterization of the press. Both are the same failure: an
 * internal classification read as a fact about the world. So the record block
 * carries only facts a reader could check against the record printed beside
 * it, every classification is stated as a fact about the table that produced
 * it, and enumLeaks() below re-checks the finished block against the known
 * enum vocabularies before a single token is spent (2026-08-09).
 *
 * IMPORT DISCIPLINE, and no module-scope I/O: this file opens nothing, reads
 * no env, and constructs no client at import time — the Anthropic client is a
 * PARAMETER of every function that could spend money, which is what lets the
 * unit suite drive the outage, the garbage reply, and the dirty draft with
 * zero network. Same rule as scripts/moment-updates.mjs's exported halves.
 * Two imports, both pure: the inherited lint, and the status-label gate that
 * scripts/moment-candidates.mjs carries import-free from lib/journey.ts.
 */
import { lintRevisionText } from '../lib/moment-updates-gate.mjs';
import { statusKeyFor } from './moment-candidates.mjs';

/**
 * Sonnet 5, matching scripts/moment-updates.mjs's summary model: this is the
 * same job — a short, fully-grounded, bilingual rewrite of a record — and the
 * ES half is the expensive half. Version-constant, not an inline literal, so a
 * model change is one edit and shows up in the issue footer the owner reads.
 */
export const DRAFT_MODEL = 'claude-sonnet-5';

/** Bumped whenever the prompt below changes in a way that changes output.
 *  Printed in the issue so a bad batch of drafts is attributable.
 *  v2 (2026-08-09): names are bare noun phrases — the "The <subject>
 *  question" wrapper is retired by owner ruling.
 *  v3 (2026-08-09): the RECORD BLOCK changed. The status label now routes
 *  through statusKeyFor, so a cloture-motion bill no longer reads as "On the
 *  floor calendar"; the press line no longer carries the coverage-tier enum.
 *  Drafts written under v2 saw a different, and in two ways wronger, record. */
export const DRAFT_PROMPT_VERSION = 3;

/** The three slots a scaffold leaves empty. Order is display order. */
export const DRAFT_FIELDS = ['name', 'summary', 'role'];

/**
 * Per-field ceilings, measured against the two hand-authored moments in
 * data/moments.json (names 28 and 45 chars; summaries 545 and 700; roles 300
 * to 430) and set roughly 1.5x above the longest real one. A field over its
 * ceiling is a runaway, not a long sentence, and is dropped like any other
 * failure rather than truncated — a truncated summary is a wrong summary.
 */
export const DRAFT_MAX_CHARS = { name: 90, summary: 1100, role: 700 };

/** Default ceiling on drafted candidates per run. See scripts/moment-watch.mjs
 *  (MOMENT_DRAFT_CAP) — the black-swan bound on a night's spend. */
export const DEFAULT_DRAFT_CAP = 10;

/**
 * The sentence scripts/moment-watch.mjs prints above every drafted scaffold.
 * It lives here, next to the code that produces the prose, so the label can
 * never drift from what actually happened.
 */
export const DRAFT_LABEL =
  `**The prose in the scaffold below is an AI first draft**, written by \`${DRAFT_MODEL}\` from the record above and nothing else. ` +
  'It is unreviewed: read every sentence, rewrite what is thin, and delete anything the record does not carry. ' +
  'The Spanish is an unreviewed draft in its own right, not a translation pass over the English. ' +
  'No person has written any of it — it becomes authored when you edit it and merge it.';

/**
 * Layer 3, local to drafting: constructions that assert a FUTURE vote or its
 * timing. The speculation lint (layer 2) already rejects "expected to / set to
 * / on track to / heading to"; these are the flatly-stated versions of the
 * same fabrication, which a confident model reaches for precisely because it
 * does not hedge. There is no record behind any of them — see the header.
 */
export const FUTURE_VOTE = {
  en: /\b(will (be )?(vote|voted|voting|take up|taken up|consider(ed)?)|is scheduled|are scheduled|scheduled (for|to)|due (for|to) a vote|comes up for a vote|awaits a vote|before the (senate|house) votes)\b/i,
  // Written WITHOUT accents and matched against a de-accented probe (see
  // deaccent below). `\b` is ASCII-only in JavaScript, so a trailing boundary
  // after "á" never fires — /\bvotará\b/ does not match "votará la medida",
  // which is exactly the sentence this layer exists to catch.
  es: /\b(votaran?|se votara|estan? programad[oa]s?|programad[oa]s? para|pendiente de votacion|antes de que (el senado|la camara) vote)\b/i,
};

/** Combining marks stripped so ASCII `\b` works on Spanish. Never applied to
 *  the stored text — only to the string the regexes are tested against. */
const deaccent = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const FUTURE_VOTE_LABEL =
  'asserts a future vote or its timing — the corpus has no scheduled-vote date and none is derivable from a calendar placement';

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/** A field with nothing in it, in both languages — byte-for-byte what the
 *  scaffold carried before drafting existed. */
const blankField = () => ({ en: '', es: '' });

/**
 * The zero value. `drafted: false` is what scripts/moment-watch.mjs reads to
 * decide which standing line to print, so a blank draft renders the issue
 * exactly as it rendered before this module existed.
 *
 * @param {string[]} [notes] why it is blank — printed in the issue, never swallowed
 */
export function blankDraft(notes = []) {
  return { drafted: false, name: blankField(), summary: blankField(), role: blankField(), notes };
}

/**
 * The complete, closed record a draft may be grounded in. Every fact here is
 * ALSO printed in the issue by scripts/moment-watch.mjs, which is the point:
 * "every claim is traceable to the record in the issue" is only checkable if
 * the model and the reader were handed the same facts. (The two RENDER
 * differently — the issue prints a markdown block for a human, recordLines
 * prints one fact per line for the prompt — but neither carries a fact the
 * other does not.)
 *
 * `statusPhrases` is the UI's own `bills.status.*` vocabulary from
 * messages/*.json, passed in rather than read here (no module-scope I/O) and
 * never copied into a local table.
 *
 * THE STATUS LABEL GOES THROUGH THE GATE, not straight into the phrase table.
 * `bills.status[c.status]` was the bug: `floor_vote` is derived looser than
 * "On the floor calendar" claims, so s-4668-119 (status floor_vote, last
 * action a cloture motion) handed the model a record block that said BOTH
 * "where it stands: On the floor calendar" AND "floor calendar: not on a
 * floor calendar", and the draft resolved toward the label. statusKeyFor
 * (lib/journey.ts, carried import-free in scripts/moment-candidates.mjs) is
 * the gate every other status-printing surface routes through; a prompt is a
 * printing surface.
 *
 * ONE DECISION, BOTH LINES. `floorCalendar` is derived from that same key
 * rather than from `c.floorCalendar`, so the record block cannot contradict
 * itself again from a different direction: the label and the calendar line
 * are now two renderings of one answer.
 *
 * @param {Record<string, any>} c        one entry of buildReport().candidates
 * @param {Record<string, any>} [bill]   its data/bills.json row, for the two
 *        fields the candidate object does not carry (title, last_action_text)
 * @param {{ en?: Record<string, string>, es?: Record<string, string> } | null} [statusPhrases]
 *        messages/*.json `bills.status`, per language
 */
export function groundFor(c, bill, statusPhrases = null) {
  const lastActionText = bill?.last_action_text ?? null;
  const lastActionDate = c.lastActionDate ?? bill?.last_action_date ?? null;
  const statusKey = statusKeyFor(c.status, lastActionText, lastActionDate);
  const phrase = (lang) =>
    statusPhrases?.[lang]?.[statusKey] ?? String(statusKey ?? '').replace(/_/g, ' ');
  return {
    slug: c.slug,
    citation: c.citation,
    title: bill?.title ?? null,
    headline: c.headline ?? null,
    status: c.status,
    statusKey,
    statusEn: phrase('en'),
    statusEs: phrase('es'),
    lastActionDate: c.lastActionDate ?? null,
    lastActionText,
    tier: c.tier,
    outlets: c.outlets,
    /** True iff the bill's OWN last action says a chamber placed it on a
     *  calendar — the same answer statusKey gives, never a second one.
     *
     *  BOTH placement keys count. Since N3 (2026-08-11) statusKeyFor splits a
     *  placement by AGE — `floor_vote` fresh, `floor_vote_stale` aged — and
     *  reading only the fresh one here would have made this line say "not on a
     *  floor calendar" about a bill that is demonstrably on one, which is a
     *  new falsehood in the record block rather than the old one fixed. The
     *  two keys differ in TENSE, and the tense is already carried by the
     *  status phrase two fields up; this boolean answers "is there a
     *  placement", which is age-independent. */
    floorCalendar: statusKey === 'floor_vote' || statusKey === 'floor_vote_stale',
    floorChamber: c.floorChamber ?? null,
    /** Whether ANY outlet covering this bill carries a lean rating in our own
     *  media-bias table. A fact about the table, not about the press — see
     *  recordLines for why the tier enum itself never travels. */
    leanRated: (c.leans ?? []).some((l) => l === 'left' || l === 'right'),
    url: c.url ?? null,
  };
}

/**
 * The record, one fact per line — the ENTIRE ground the prompt gives the
 * model, and the thing enumLeaks() is run over before any of it is sent.
 *
 * THE PRESS LINE IS DELIBERATELY THIN. It used to read "press: neutral
 * coverage across 3 outlet(s)", which handed over the internal tier enum as
 * though it described the journalism. `neutral` is a verdict of our AllSides
 * lookup — it means "two or more outlets and none of them is lean-rated in
 * OUR table" — and a model told that a bill has "neutral coverage" will
 * reasonably write that the press covered it neutrally, which is a claim
 * nobody here is entitled to make and which duly shipped. What survives is
 * what a reader could check: how many outlets, and whether our table rates
 * any of them at all, said as a fact about the table.
 *
 * "(not on file)" rather than "(none on file)" is not a style edit: `none` is
 * itself a coverage-tier value, and a placeholder shaped like an enum is
 * exactly what the guard below exists to keep out of the block.
 */
export function recordLines(g) {
  return [
    `citation: ${g.citation}`,
    `official title: ${g.title ?? '(not on file)'}`,
    `plain-language headline (AI-decoded, already published on the bill page): ${g.headline ?? '(not on file)'}`,
    `where it stands: EN "${g.statusEn}" / ES "${g.statusEs}"`,
    `last action, ${g.lastActionDate ?? 'undated'}: ${g.lastActionText ?? '(not on file)'}`,
    `news coverage: ${g.outlets} outlet(s) in Oravan's stored coverage for this bill; ` +
      `Oravan's own media-bias table gives a lean rating to ${g.leanRated ? 'at least one' : 'zero'} of them. ` +
      'That is a fact about that table, not a description of the reporting, and not something to write about.',
    `floor calendar: ${g.floorCalendar ? `on the ${g.floorChamber ?? 'unnamed'} floor calendar (a placement — the record states no date)` : 'not on a floor calendar'}`,
    `official record: ${g.url ?? '(not on file)'}`,
  ];
}

/**
 * The internal vocabularies that must never travel to the model as facts.
 *
 * Every token here is a value some part of this repo stores in a field: bill
 * statuses (data/bills.json `status`, plus `floor_activity`, which exists only
 * as a derived message key), coverage tiers (scripts/moment-candidates.mjs
 * coverageTier), qualifying-signal types (lib/moments-gate.mjs SIGNAL_TYPES),
 * and stored moment statuses. Listed literally rather than imported: this
 * guard has to keep working when a list moves, and the point is the SHAPE of
 * the leak rather than any one list's current contents.
 *
 * SIX BILL STATUSES ARE DELIBERATELY ABSENT — introduced, committee, markup,
 * conference, signed, vetoed. Each is its own published English label ("In
 * committee", "In markup", "Signed into law"), so scanning for them would fire
 * on the correct, human-facing rendering of exactly the fact the line is there
 * to state. A guard that cannot tell the label from the enum is noise, and
 * noise here degrades every draft to blank. The tokens that remain are the
 * ones that CANNOT appear except by interpolating a stored value: the
 * snake_case statuses, the tier words (which are our verdicts, not English
 * descriptions of coverage), the signal types, and the stored moment statuses.
 */
export const INTERNAL_ENUM_TOKENS = [
  // bill status (data/bills.json) + the derived label keys — see the note
  // above. `floor_vote_stale` is listed SEPARATELY and is not covered by
  // `floor_vote`: enumLeaks matches on word boundaries that treat `_` as a
  // word character, so `floor_vote` does not fire inside `floor_vote_stale`.
  'floor_vote', 'floor_vote_stale', 'floor_activity', 'passed_chamber',
  // coverage tier (scripts/moment-candidates.mjs coverageTier)
  'cross', 'neutral', 'one_sided', 'none',
  // qualifying-signal type (lib/moments-gate.mjs SIGNAL_TYPES)
  'tier0_floor', 'tier0_scheduled', 'tier0_most_viewed', 'tier0_exec_calendar', 'press',
  // stored moment status (lib/moments-gate.mjs)
  'live', 'retired',
];

/**
 * Does the finished record block leak an internal enum token?
 *
 * The VERBATIM spans — the citation, the official title, the decoded
 * headline, Congress's own last-action sentence, the record URL — are removed
 * before the scan, because those are somebody else's words passing through
 * and a bill genuinely titled "…Cross-Border…" is not a leak. Everything
 * left is text THIS FILE composed, where an enum token can only have arrived
 * by being interpolated out of a stored field.
 *
 * Returns the leaked tokens, empty when clean. draftFor() refuses to spend on
 * a leaking block — it degrades to the blank scaffold with the reason named,
 * like every other refusal here, rather than throwing.
 *
 * @param {ReturnType<typeof groundFor>} g
 * @returns {string[]}
 */
export function enumLeaks(g) {
  const verbatim = [g.citation, g.title, g.headline, g.lastActionText, g.url].filter(isNonEmptyString);
  let scanned = recordLines(g).join('\n');
  for (const span of verbatim) scanned = scanned.split(span).join(' ');
  return INTERNAL_ENUM_TOKENS.filter((token) =>
    new RegExp(`(?<![\\p{L}\\p{N}_])${token}(?![\\p{L}\\p{N}_])`, 'iu').test(scanned),
  );
}

/**
 * The prompt. Exported so tests/moment-draft.unit.spec.ts can assert the two
 * rules that carry the most risk — the no-scheduled-vote-date rule and the
 * closed record — are actually in the text the model is sent, rather than only
 * in this comment.
 */
export function draftPrompt(g) {
  return `You are writing the FIRST DRAFT of one entry in Oravan's "Big Questions" file — a nonpartisan US civic site. A human editor reads every sentence, rewrites it, and merges it; nothing you write publishes as you wrote it. A thin, true draft is useful to that editor. An interesting, invented one is worthless.

THE EDITORIAL LAW:
"Truth about the record, attribution about the spin. When the record speaks, we say it plainly — numbers, dates, tallies, text — even when plainness lands harder on one side. Balance is not achieved by blunting facts. When the record is silent — motive, likelihood, what it really means — Oravan's voice stops, and named sources speak or nobody does. Speculation never wears our voice."

THE RECORD — this is the ENTIRE record you may use. There is nothing else, and you may not recall anything about this measure from memory:
${recordLines(g).map((l) => `- ${l}`).join('\n')}

WRITE THREE THINGS, each in English and Spanish:

1. "name" — what a reader would call the question this measure puts to Congress. A short BARE noun phrase, 2 to 7 words, sentence case, no question mark, and no wrapper: write "Syria sanctions repeal", never "The Syria sanctions repeal question" — the page already frames every name as a Big Question, in both languages (owner ruling, 2026-08-09). Name the QUESTION, not the bill and not a side.

2. "summary" — 70 to 110 words per language, for someone reading at an 8th-grade level. Open with what is actually before Congress and where it sits right now, then what the measure would do as far as the record states it, then what a yes and a no each mean. Both answers are legitimate; write so a reader on either side recognizes their own position.

3. "role" — 2 to 3 sentences per language on what THIS measure does inside that question: what a yes vote does, what a no vote leaves in place, and where the measure sits.

HARD RULES:
- Use ONLY the record above. Never add a number, date, dollar figure, name, motive, or consequence that is not in it. If the record does not say what the measure would do beyond its title, say what the record does say and stop.
- THERE IS NO SCHEDULED VOTE DATE IN THIS RECORD, and none can be derived from it. Never say when a vote will happen, never say a vote is scheduled or awaited, never imply timing the record does not state. A floor-calendar placement is a placement, not a date.
- No forecasting and no hedging: no "expected to", "likely to", "could", "might", "set to", "poised to", "on track to", "heading to", "headed for"; no "se espera", "probablemente", "podría", "podrían", "estaría", "estarían", "previsto que", "a punto de", "rumbo a", "camino de".
- Never name a political party. Never use advocacy verbs — fight, resist, stop, save, defend, block / luchar, resistir, detener, salvar, defender, bloquear — and never crisis, attack, or scheme framing, in either language. This is machine-checked in both languages before the editor sees your draft, and a single hit throws that whole field away in both languages.
- Describe the question, never a position on it. No urgency the record does not carry.
- The Spanish is native Latin-American-neutral Spanish at an 8th-grade level, with correct accents (aprobó, Cámara, comité, votación), carrying the same facts — not a gloss of the English. Bill citations keep their English form (S. 3172, H.R. 9770).
- Dates the way a reader says them: "July 27, 2026" in English, "27 de julio de 2026" in Spanish. Never ISO "2026-07-27" in prose. Never an internal token like "floor_vote" — if you find yourself writing an underscore, stop.
- Plain text. No markdown, no headings, no meta-commentary about this draft.

SHAPE (placeholders in angle brackets — never copy these words, they are not facts):
{"name":{"en":"<subject>","es":"<sujeto>"},"summary":{"en":"<70-110 words>","es":"<70-110 words>"},"role":{"en":"<2-3 sentences>","es":"<2-3 sentences>"}}

Output STRICT JSON only — no prose, no markdown fences, no other text.`;
}

/** Strip a ```json fence a model added despite being told not to. Same
 *  tolerance scripts/moment-updates.mjs applies to its two JSON replies. */
function parseStrictJSON(text) {
  return JSON.parse(String(text ?? '').trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, ''));
}

/**
 * Validate ONE field's {en, es} pair. Returns the failure strings — empty
 * means the pair may be offered to the owner.
 *
 * The three layers, in the order they run:
 *   1. shape + parity   — both languages present and non-empty, under ceiling
 *   2. lintRevisionText — lintForbidden (lib/moments-gate.mjs, the same table
 *                         check-moments.mjs will run on the merged entry) plus
 *                         the speculation lint
 *   3. FUTURE_VOTE      — the flatly-asserted vote date that has no record
 */
export function lintField(field, value) {
  const failures = [];
  const max = DRAFT_MAX_CHARS[field] ?? Infinity;
  for (const lang of ['en', 'es']) {
    const text = value?.[lang];
    if (!isNonEmptyString(text)) {
      failures.push(`${lang}: missing or empty`);
      continue;
    }
    const trimmed = text.trim();
    if (trimmed.length > max) failures.push(`${lang}: ${trimmed.length} chars over the ${max}-char ceiling`);
    for (const f of lintRevisionText(trimmed, lang)) failures.push(`${lang}: ${f}`);
    const probe = deaccent(trimmed);
    if (FUTURE_VOTE[lang].test(probe)) {
      failures.push(`${lang}: "${probe.match(FUTURE_VOTE[lang])?.[0] ?? ''}" ${FUTURE_VOTE_LABEL}`);
    }
  }
  return failures;
}

/**
 * Validate a whole parsed reply, per field. Returns the clean fields (trimmed)
 * and, for the rest, why they were refused.
 *
 * @returns {{ clean: Record<string, {en: string, es: string}>, problems: Record<string, string[]> }}
 */
export function validateDraft(parsed) {
  const clean = {};
  const problems = {};
  for (const field of DRAFT_FIELDS) {
    const value = parsed?.[field];
    const failures = lintField(field, value);
    if (failures.length) problems[field] = failures;
    else clean[field] = { en: value.en.trim(), es: value.es.trim() };
  }
  return { clean, problems };
}

/**
 * One API call. Every failure mode — outage, non-text reply, unparseable JSON
 * — returns `{ fatal: <why> }` rather than throwing, so the caller's retry and
 * fallback logic is the only place control flow lives.
 */
async function attemptDraft(anthropic, g) {
  let text;
  try {
    const msg = await anthropic.messages.create({
      model: DRAFT_MODEL,
      max_tokens: 1500,
      // Sonnet 5 runs adaptive thinking when the field is OMITTED. This is a
      // short, fully-grounded write with a closed record; unbounded thinking
      // would add spend a nightly issue-opener has no business paying for.
      // `disabled` is accepted on Sonnet 5 (unlike xhigh/max on the Opus line).
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: draftPrompt(g) }],
    });
    text = msg?.content?.[0]?.type === 'text' ? msg.content[0].text : '';
  } catch (e) {
    return { fatal: `the drafting call failed (${e.message})` };
  }
  let parsed;
  try {
    parsed = parseStrictJSON(text);
  } catch (e) {
    return { fatal: `the model's reply was not JSON (${e.message})` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { fatal: "the model's reply was not a JSON object" };
  }
  return validateDraft(parsed);
}

/**
 * Draft one candidate. NEVER THROWS and never returns partial nonsense: the
 * worst case is blankDraft(), which renders the issue exactly as it rendered
 * before this module existed.
 *
 * The retry is deliberately whole-call rather than per-field: the three fields
 * are written together and a second pass at only the dirty one loses the
 * context that made the clean ones coherent. Fields that passed on attempt 1
 * are KEPT — attempt 2 is only ever allowed to rescue what failed, never to
 * replace what already cleared the lint.
 *
 * @param {{messages: {create: Function}}|null} anthropic  null = no key, no spend
 * @param {ReturnType<typeof groundFor>} g
 * @param {{ attempts?: number }} [opts]
 */
export async function draftFor(anthropic, g, { attempts = 2 } = {}) {
  if (!anthropic) {
    return blankDraft(['`ANTHROPIC_API_KEY` is unset, so nothing was drafted — the scaffold above is the blank form it has always been.']);
  }

  /* THE ENUM GUARD, before a token is spent. A record block carrying an
     internal classification has already produced published prose asserting
     something nobody here can assert, twice. Refusing is cheap; the owner gets
     the blank form and a note naming the token, which is a bug report he can
     act on. Same posture as every other refusal in this file: a return, never
     a throw, and the issue still opens. */
  const leaks = enumLeaks(g);
  if (leaks.length) {
    return blankDraft([
      `**nothing was drafted** — the record block leaked the internal token(s) \`${leaks.join('`, `')}\`, which are our own classifications rather than facts about this measure. ` +
        'Drafting on a leaking block is how "neutral coverage" and "floor_vote" reached published prose, so the call was not made. Fix `recordLines` in `scripts/moment-draft.mjs`.',
    ]);
  }

  const kept = {};
  const notes = [];
  let lastProblems = {};

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await attemptDraft(anthropic, g);
    if (result.fatal) {
      notes.push(`attempt ${attempt}: ${result.fatal}`);
      lastProblems = {};
      continue;
    }
    for (const [field, value] of Object.entries(result.clean)) {
      if (!kept[field]) kept[field] = value;
    }
    lastProblems = Object.fromEntries(
      Object.entries(result.problems).filter(([field]) => !kept[field]),
    );
    if (Object.keys(lastProblems).length === 0) break;
    if (attempt < attempts) notes.push(`attempt ${attempt}: ${describeProblems(lastProblems)} — retrying once`);
  }

  for (const [field, failures] of Object.entries(lastProblems)) {
    notes.push(`**${field} left blank** after ${attempts} attempt(s) — ${failures.join('; ')}`);
  }
  const missing = DRAFT_FIELDS.filter((f) => !kept[f] && !lastProblems[f]);
  if (missing.length) notes.push(`**${missing.join(', ')} left blank** — no usable reply after ${attempts} attempt(s).`);

  const drafted = DRAFT_FIELDS.some((f) => Boolean(kept[f]));
  return {
    drafted,
    name: kept.name ?? blankField(),
    summary: kept.summary ?? blankField(),
    role: kept.role ?? blankField(),
    notes,
  };
}

function describeProblems(problems) {
  return Object.entries(problems)
    .map(([field, failures]) => `${field} rejected (${failures.join('; ')})`)
    .join('; ');
}

/**
 * Draft a list of candidates, in rank order, up to `cap`. Everything past the
 * cap gets a blank draft with a note saying so — a bounded spend that is
 * visible in the issue beats an unbounded one that is not.
 *
 * Sequential on purpose: this runs at most a handful of times a night, the
 * ceiling is the point, and a parallel fan-out would make a rate-limit burst
 * the failure mode of a job whose entire job is to be quiet and reliable.
 *
 * @returns {Promise<Map<string, ReturnType<typeof blankDraft>>>} keyed by slug
 */
export async function draftAll(anthropic, grounds, { cap = DEFAULT_DRAFT_CAP, attempts = 2 } = {}) {
  const out = new Map();
  for (const [i, g] of grounds.entries()) {
    if (i >= cap) {
      out.set(g.slug, blankDraft([`past the ${cap}-candidate drafting cap for one run (\`MOMENT_DRAFT_CAP\`) — the scaffold above is left blank.`]));
      continue;
    }
    out.set(g.slug, await draftFor(anthropic, g, { attempts }));
  }
  return out;
}

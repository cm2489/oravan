/**
 * Shared decode-before-publish + priority-gate resolution for ONE bill,
 * used by BOTH scripts/sync-bills.mjs (nightly recent-first + ascending-
 * backlog passes) and scripts/newsdesk.mjs (hourly headline-triggered
 * resync, Part 2 of the 2026-07-16 spend-reduction pair). One copy so the
 * gate, the FORCE_DECODE_SLUGS bypass, and the actual decode-before-publish
 * AI calls can't drift between callers — same "one copy" discipline as
 * lib/urgency.mjs's STATUS_BASE and congress-fetch.mjs's refreshBillFields.
 *
 * Extracted 2026-07-16 from what was previously sync-bills.mjs's own
 * module-scope decode() + syncOneBill(): moving these here (as functions
 * that take bills/es/bySlug/anthropic explicitly rather than closing over
 * module-scope state) is what lets scripts/newsdesk.mjs decode a
 * press-triggered new bill via the EXACT SAME decode-before-publish path
 * the nightly sync uses, instead of maintaining a second copy of the
 * summary/headline/ES prompts that could drift.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CONGRESS,
  cg,
  congressGovUrl,
  mapStatus,
  readableAction,
  refreshBillFields,
  tagBill,
  updateSlug,
  urgencyScore,
} from './congress-fetch.mjs';
import { passesGate } from './decode-gate.mjs';
import { generateSearchInputs } from './search-inputs.mjs';

// Sonnet 5's tokenizer runs ~30% more tokens than 4.6 for the same text, so
// max_tokens caps on its calls are sized up accordingly; thinking is disabled
// explicitly because Sonnet 5 defaults it ON when the field is omitted, which
// would add unbounded thinking spend to batch calls.
export const DECODE_MODEL = 'claude-sonnet-5';

/*
 * The two calls' output ceilings, exported because lib/decode-batch.mjs has
 * to reproduce them EXACTLY — a batched decode that capped its output
 * differently would be a second, quietly divergent decoder.
 *
 * MEASURED 2026-09-18, and left alone deliberately. These numbers do not cost
 * anything: the Messages API bills the tokens a reply actually contains, not
 * the ceiling it was allowed. Raising or lowering a cap changes only whether
 * a reply gets cut off mid-sentence. And the corpus says 900 is already the
 * binding edge for call 1 — the longest stored `ai_summary` is 2,774
 * characters, which at the ~3.1 chars/token this model's tokenizer produces
 * on this prose is ~895 tokens, i.e. that summary ran into the cap. Trimming
 * it would truncate real summaries for zero saving. Call 2's largest stored
 * payload is ~7,436 characters (~2,650 tokens across both languages), so
 * 3,250 has headroom and costs nothing to keep.
 */
export const DECODE_SUMMARY_MAX_TOKENS = 900;
export const DECODE_STRUCTURE_MAX_TOKENS = 3250;

/*
 * How much of a bill's document a decode reads. UNCHANGED, and measured
 * before it was left unchanged (2026-09-18, 66 bills sampled at random from
 * the committed corpus, text pulled from congress.gov): after this truncation
 * the mean document is ~10,159 characters and the median ~5,195, so the cap
 * binds on only 5 of 66 bills — 7.6%. Those five are the appropriations- and
 * authorization-scale bills where a summary matters most, and they are
 * exactly what a lower cap would start cutting. Lowering it would save
 * roughly a tenth of one call's input on the 92% of bills it never touches
 * and would degrade the 8% it does. Left at 60,000 on purpose.
 */
const BILL_TEXT_MAX_CHARS = 60_000;

/**
 * A stable fingerprint of the exact document a decode was written from.
 *
 * WHY IT EXISTS: `redecodeVerdict`'s stale-decode rule (floor-signals-parse.mjs)
 * fires when a bill's ACTION DATE moves past the day its decode was written.
 * That is the right trigger — an action can mean a new engrossed text — but it
 * is not the right *answer*: plenty of floor actions (a rule adopted, a motion
 * to recommit, a calendar placement) move the date without changing a word of
 * the document. Re-decoding an unchanged document pays two Sonnet calls to
 * regenerate the summary we already hold. Storing the fingerprint lets the
 * re-decode path notice that and skip the spend — not by predicting the
 * answer, but by observing that the INPUT is byte-identical, which is the only
 * condition under which "same output" is a fact rather than a hope.
 *
 * It is a fingerprint of the truncated text — the actual model input — not of
 * the source document, so a bill that grows past the cap without its first
 * 60,000 characters changing correctly reads as unchanged: the decode never
 * saw the difference.
 */
export function textFingerprint(text) {
  return createHash('sha256').update(text ?? '', 'utf8').digest('hex').slice(0, 16);
}

const formattedTextUrl = (v) =>
  (v?.formats ?? []).find((f) => f?.type === 'Formatted Text')?.url ?? null;

/**
 * The version of a bill we decode from: the CURRENT one — Congress.gov's
 * /text `textVersions` array as returned, first entry carrying a Formatted
 * Text URL. Null when the bill has no retrievable text at all.
 *
 * This used to iterate `[...versions].reverse()`, which took the LAST entry
 * and therefore decoded almost every bill from the text as INTRODUCED, no
 * matter how far it had since moved. Live-verified against the API on
 * 2026-08-09, 67 multi-version bills of the 119th:
 *
 *   s/1199    Engrossed in Senate@2026-04-29 | Reported@2025-07-30 | Introduced@2025-03-27
 *   hr/2701   Placed on Calendar Senate@2025-12-09 | Engrossed in House@2025-09-15
 *             | Reported in House@2025-09-09 | Introduced in House@2025-04-07
 *
 * The array is ordered MOST-ADVANCED FIRST. It is NOT simply date-descending,
 * and a future reader must not "fix" it by sorting on `date`: the two
 * terminal texts of an enacted bill sit outside the date order entirely —
 * `Enrolled Bill` is pinned FIRST and carries `date: null`, and `Public Law`
 * is pinned LAST despite holding the NEWEST date (hr/1: Enrolled@null |
 * Engrossed Amendment Senate@2025-07-01 | ... | Reported@2025-05-20 |
 * Public Law@2025-07-05). Measured 2026-08-09: Enrolled first in 25/25 and
 * Public Law last in 25/25 enacted bills sampled, and entry [0] was the
 * most-advanced text in 42/42 in-progress multi-version bills. So entry [0]
 * is the current text in every observed shape, and the old reverse() landed
 * on `Introduced` for everything still moving — while accidentally landing
 * on the correct `Public Law` for bills already enacted, which is why the
 * damage never showed up in the enacted records anyone spot-checked.
 *
 * Versions with no Formatted Text URL are skipped, not treated as the end of
 * the list — the pick is "the newest version we can actually read".
 */
export function pickTextVersion(versions) {
  return (versions ?? []).find((v) => formattedTextUrl(v)) ?? null;
}

/**
 * The current text of one bill as plain words, or null when Congress.gov
 * publishes NO text for it yet (the caller refuses to decode on null — see
 * syncOneBill). Throws when a version exists but its document can't be
 * fetched, which is a retryable failure rather than a text-less bill.
 *
 * Only the current version is fetched. The old loop fell through to the next
 * version on a non-ok response, which — now that we start from the newest
 * rather than the oldest — would quietly decode a SUPERSEDED document
 * whenever the current one's HTML lagged, reintroducing exactly the staleness
 * above with no marker on the record to show it. Nothing distinguishes a
 * summary of last month's text from a summary of this week's once it is
 * stored, so a text we can't fetch is refused and retried, never approximated
 * from an older one.
 */
async function fetchBillText(type, number) {
  const data = await cg(`/bill/${CONGRESS}/${type}/${number}/text`);
  const version = pickTextVersion(data.textVersions);
  if (!version) return null;
  const url = formattedTextUrl(version);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bill text ${res.status} for ${type}/${number} (${version.type})`);
  const html = await res.text();
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, BILL_TEXT_MAX_CHARS);
}

const DECODE_TAGS = [
  'HEADLINE_EN', 'HEADLINE_ES',
  'TLDR', 'WHAT', 'WHO', 'WHY', 'COST', 'COST_CHIPS',
  'ES_TLDR', 'ES_WHAT', 'ES_WHO', 'ES_WHY', 'ES_COST', 'ES_COST_CHIPS', 'ES_SUMMARY',
];

function parseTagged(text) {
  const out = {};
  for (let i = 0; i < DECODE_TAGS.length; i++) {
    const tag = DECODE_TAGS[i];
    const start = text.indexOf(`[${tag}]`);
    if (start === -1) throw new Error(`missing [${tag}]`);
    const next = DECODE_TAGS.slice(i + 1)
      .map((t) => text.indexOf(`[${t}]`))
      .filter((x) => x > start);
    const end = next.length ? Math.min(...next) : text.length;
    out[tag] = text.slice(start + tag.length + 2, end).trim();
  }
  return out;
}

const normCost = (s) => (s === 'NONE' || !s ? null : s);

// The prompt asks for chips of at most 45 characters; the validator allows 48.
// That 3-character slack is deliberate tolerance and is left alone here.
const CHIP_MAX = 48;

function parseChips(s) {
  if (s === 'NONE' || !s) return null;
  const chips = s.split('|').map((c) => c.trim()).filter(Boolean);
  if (chips.length < 1 || chips.length > 3 || chips.some((c) => c.length > CHIP_MAX)) return null;
  return chips;
}

/**
 * Both languages' cost chips, or none in either. Never one language's chips
 * beside the other language's null.
 *
 * The prompt states this contract itself — "Same count and order in
 * ES_COST_CHIPS. If a fact can't fit 45 chars, output NONE for both chip tags
 * (prose is the fallback)" — but the validator used to enforce it one language
 * at a time. Spanish renders the same fact longer, so the ordinary outcome was
 * an EN chip that fit beside an ES twin that didn't: the ES chips were nulled
 * and the EN chips stored, and the bill shipped with a scannable chip row in
 * English and a wall of prose in Spanish. Measured 2026-08-09 on the committed
 * corpus: of the 917 bills carrying chips in either language, 157 diverge (146
 * EN-only, 11 ES-only) — 16% — and of the 906 carrying EN chips, 146 have no
 * ES counterpart.
 *
 * The count check is belt-and-braces: zero bills currently diverge on count
 * where both languages have chips. It is here because the prompt promises it
 * and enforcing a promise costs nothing.
 *
 * ON THE CEILING, deliberately NOT made language-aware. The alternative was a
 * higher ES ceiling to keep more Spanish chips alive, and it was rejected on
 * three grounds. First, 48 is a SCANNABILITY budget, not a layout guard: the
 * Chip shell is `inline-flex w-fit` inside a `flex-wrap` list with no
 * `whitespace-nowrap` (components/system/Chip.tsx), so a longer chip wraps
 * rather than breaking the page — nothing is protected by the number except
 * the chip's reason for existing. A fact needing 58 characters is not a chip,
 * and the prompt already names the right answer for it: prose. Second, giving
 * Spanish a longer ceiling would ship ES readers a different, worse-scanning
 * artifact under the same name, which is not what bilingual parity means.
 * Third, no honest ES ceiling can be derived from the committed data: every
 * over-length ES chip was nulled by this very bug, so the stored ES lengths
 * are censored at 48 (stored ES chips average 34.8 chars vs EN's 32.5 — a 7%
 * gap that measures only the survivors, not the real inflation). Picking a
 * number would be a guess dressed as a measurement.
 */
export function normChipPair(enRaw, esRaw) {
  const en = parseChips(enRaw);
  const es = parseChips(esRaw);
  if (!en || !es || en.length !== es.length) return { en: null, es: null };
  return { en, es };
}

/*
 * THE TWO PROMPTS, AS FUNCTIONS (extracted 2026-09-18).
 *
 * They used to be template literals inline in decode() below. They are
 * functions now for one reason: lib/decode-batch.mjs submits the SAME two
 * calls through the Message Batches API, and a batched decode that differed
 * from the synchronous one by so much as a newline would be a second decoder
 * wearing the first one's label — the exact drift this file's header comment
 * exists to prevent between sync-bills.mjs and newsdesk.mjs. One copy, two
 * transports. tests/decode-batch.unit.spec.ts pins that the batch request
 * body and the synchronous request body are built from these same functions.
 *
 * Nothing about the prompt text changed in that extraction; the decode a bill
 * gets today is byte-for-byte the decode it got yesterday.
 */

/** Call 1: the plain-language summary, from the bill's own document. */
export function buildSummaryPrompt(bill, text) {
  return `Explain this congressional bill in plain language for an everyday US resident (8th-grade reading level). 2-3 short paragraphs: what it actually does, and who it affects. Strictly nonpartisan, no advocacy, no preamble, no markdown.

Bill: ${bill.bill_type.toUpperCase()} ${bill.bill_number} — ${bill.title}

Full text (may be truncated):
${text}`;
}

/** Call 2: headlines, scannable sections, and the Spanish twin — from call
 *  1's summary ONLY, never from the document. That constraint is the
 *  hallucination guard ("Use ONLY facts present in the summary"), and it is
 *  why the two calls are not merged into one cheaper call: a single call
 *  reading the 60,000-character document directly would be free to write
 *  sections the summary never supports. The saving is real (~$0.002 a decode
 *  in re-sent input) and it is declined. */
export function buildStructurePrompt(bill, ai_summary) {
  return `From this plain-language bill summary, produce headlines, scannable sections, and a Spanish translation.

Bill: ${bill.bill_type.toUpperCase()} ${bill.bill_number}
Summary:
${ai_summary}

STRICT RULES:
- Use ONLY facts present in the summary. Never invent numbers, costs, or claims.
- Headlines: 45-90 chars, sentence case, factual news-desk style, varied construction (NOT "Topic — Consequence", avoid colons), never start with "Congress". Prioritize the most decision-relevant specifics: what it does, who it affects, what it costs, or where it stands.
- TLDR: one sentence, max 160 chars, the single most decision-relevant fact.
- WHAT: 1-3 sentences. WHO: 1-2. WHY: 1-2 sentences of neutral consequence, never benefits-framing.
- COST: 1-2 sentences ONLY if the summary contains spending/funding/fines/who-pays content; otherwise output exactly NONE (and ES_COST, COST_CHIPS, ES_COST_CHIPS all NONE too).
- COST_CHIPS: when COST exists, compress it to 2-3 chips separated by " | ", each a standalone fact fragment max 45 chars, sentence case, no period. Same count and order in ES_COST_CHIPS. If a fact can't fit 45 chars, output NONE for both chip tags (prose is the fallback).
- Spanish: natural Latin American Spanish, 8th-grade level; citations/numbers exact; agency names in English with a short gloss when helpful. ES_SUMMARY is the full summary translation.
- Plain text, no markdown.

Output exactly this tagged format, each tag on its own line followed by its content:
[HEADLINE_EN]
[HEADLINE_ES]
[TLDR]
[WHAT]
[WHO]
[WHY]
[COST]
[COST_CHIPS]
[ES_TLDR]
[ES_WHAT]
[ES_WHO]
[ES_WHY]
[ES_COST]
[ES_COST_CHIPS]
[ES_SUMMARY]`;
}

/**
 * Turn the two calls' raw replies into the stored decode, or throw.
 *
 * THE PUBLISH GATE LIVES HERE and is unchanged: a reply missing any required
 * field throws 'bad decode shape' and the caller stores NOTHING, in either
 * language. Batched and synchronous decodes go through this one function, so
 * neither transport can invent a looser standard for itself.
 */
export function assembleDecode(ai_summary, structureText) {
  const p = parseTagged(structureText);
  if (!p.HEADLINE_EN || !p.TLDR || !p.WHAT || !p.WHO || !p.WHY || !p.ES_SUMMARY) {
    throw new Error('bad decode shape');
  }
  // Chips are decided for BOTH languages at once — see normChipPair.
  const chips = normChipPair(p.COST_CHIPS, p.ES_COST_CHIPS);
  return {
    ai_summary,
    ai_headline: p.HEADLINE_EN.slice(0, 110),
    ai_sections: {
      tldr: p.TLDR, what: p.WHAT, who: p.WHO, why: p.WHY,
      cost: normCost(p.COST), costChips: chips.en,
    },
    es_headline: p.HEADLINE_ES.slice(0, 110),
    es_summary: p.ES_SUMMARY,
    es_sections: {
      tldr: p.ES_TLDR, what: p.ES_WHAT, who: p.ES_WHO, why: p.ES_WHY,
      cost: normCost(p.ES_COST), costChips: chips.es,
    },
  };
}

/** Decode ONE bill from its own text, synchronously — two Messages API calls,
 *  the second reading the first's reply. `text` is required and is always the
 *  document — it used to fall back to `bill.title` when fetchBillText came
 *  back null, which produced a normal-looking, unlabeled AI summary of a
 *  document the model had never read. See syncOneBill's null-text refusal.
 *
 *  This is the LATENCY-SENSITIVE transport: the hourly newsdesk's re-decodes
 *  heal a live page and cannot wait on a batch queue. The nightly sync uses
 *  lib/decode-batch.mjs instead (half price, minutes of wait) and falls back
 *  to exactly this function whenever the batch can't deliver. */
export async function decodeBill(anthropic, bill, text) {
  const sum = await anthropic.messages.create({
    model: DECODE_MODEL,
    max_tokens: DECODE_SUMMARY_MAX_TOKENS,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: buildSummaryPrompt(bill, text) }],
  });
  const ai_summary = sum.content[0].text.trim();

  const rest = await anthropic.messages.create({
    model: DECODE_MODEL,
    max_tokens: DECODE_STRUCTURE_MAX_TOKENS,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: buildStructurePrompt(bill, ai_summary) }],
  });
  return assembleDecode(ai_summary, rest.content[0].text.trim());
}

/**
 * Write a finished decode onto a brand-new bill and push it into the corpus.
 *
 * THE ONE PLACE an added bill's decode is stored, called by the synchronous
 * path in syncOneBill and by the batch drain in scripts/sync-bills.mjs alike.
 * It exists so "what a decode writes" cannot differ between the two
 * transports: the EN record, the ES twin, the timestamps, and the search
 * handles are one sequence in one function, and the bill reaches `bills` only
 * on its last line — decode-before-publish, unchanged.
 *
 * `decode_text_sha` and `decode_text_verified_at` are stamped beside
 * `decoded_at`, from the exact text the model was handed. See
 * textFingerprint: they are what lets the re-decode path later tell "this
 * bill moved" from "this bill's document changed".
 */
export async function completeDecode({ slug, bill, text, dec, bills, es, bySlug, anthropic }) {
  bill.ai_summary = dec.ai_summary;
  bill.ai_headline = dec.ai_headline;
  bill.ai_sections = dec.ai_sections;
  // Stamped only here and in redecodeBill — after the decode returned a
  // shape the gate accepted, never before it. A failed decode leaves no
  // stamp because it left no decode.
  const stampedAt = new Date().toISOString();
  bill.decoded_at = stampedAt;
  bill.decode_text_sha = textFingerprint(text);
  bill.decode_text_verified_at = stampedAt;
  // Search handles for the coverage sync (press names + subject query).
  // Non-fatal: the backfill script sweeps up any misses.
  try {
    const si = await generateSearchInputs(anthropic, bill);
    bill.press_names = si.press_names;
    bill.news_query = si.news_query;
  } catch (e) {
    console.error(`  search-inputs failed for ${slug}: ${e.message}`);
  }
  es[slug] = { headline: dec.es_headline, summary: dec.es_summary, sections: dec.es_sections };
  bills.push(bill);
  bySlug.set(slug, bill);
}

/**
 * Fetch one bill's current detail and either refresh it (already in the
 * corpus — free, unconditional) or, for a brand-new bill, run it through
 * the priority gate and decode-before-publish. The ONE place both
 * sync-bills.mjs's passes and newsdesk.mjs's trigger path turn a
 * Congress.gov update item ({type, number}) into a corpus mutation, so the
 * gate, the force-bypass, and the refresh fields can't drift between
 * callers.
 *
 * `u` is `{type, number}` (Congress.gov's shape, or newsdesk.mjs's own
 * slug-derived equivalent). `ctx`:
 *   - allowDecode: this call may spend a decode if it clears the gate
 *     (the caller's own budget bookkeeping — MAX_NEW_DECODES for
 *     sync-bills.mjs, NEWSDESK_DECODE_CAP for newsdesk.mjs).
 *   - forceSlugs: a Set of slugs that bypass the priority gate entirely
 *     (still subject to allowDecode). Populated from FORCE_DECODE_SLUGS
 *     for manual/workflow_dispatch runs, or built in-process by
 *     newsdesk.mjs from headline-triggered bills — see decode-gate.mjs.
 *   - bills, es, bySlug, anthropic: the caller's loaded corpus + client.
 *
 * Returns one of:
 *   'refreshed' — an existing bill's fields were updated in place (free)
 *   'skipped_partial' — the bill was fetched fine, but Congress.gov's reply
 *                 carried no readable `latestAction` text (readableAction in
 *                 congress-fetch.mjs), so NOTHING was written: an existing
 *                 bill was left byte-identical, and a brand-new one was NOT
 *                 created and NOT decoded. Neither a change nor a failure —
 *                 idempotent, nothing to retry, and the bill re-enters on
 *                 its next real move via Congress.gov's own updateDate.
 *   'skipped_no_text' — a brand-new bill cleared the gate, but Congress.gov
 *                 publishes no readable text version for it yet, so NOTHING
 *                 was written and no decode was spent: we will not summarize
 *                 a document we could not read. Like 'gated' and unlike
 *                 'failed' — nothing stored, nothing to retry, and the bill
 *                 re-enters via its own updateDate when its text lands.
 *   'added'     — a brand-new bill was decoded and pushed into the corpus
 *   'queued_decode' — only when ctx.decodeQueue is present: the bill cleared
 *                 every gate and its text was fetched, and the caller now owns
 *                 the two model calls (scripts/sync-bills.mjs's batch drain).
 *                 NOTHING was written and nothing was spent yet; the bill
 *                 enters the corpus only if the drain produces a decode, and
 *                 counts as 'failed' (still needs work) if it does not. A
 *                 caller that passes no decodeQueue can never see this.
 *   'gated'     — a brand-new bill was found but shows no real legislative
 *                 motion (and isn't force-bypassed) — NOT stored anywhere.
 *                 Fully handled: if it later moves, Congress.gov's own
 *                 updateDate advances past the caller's cursor and the
 *                 update feed resurfaces it on a future run, when the gate
 *                 re-evaluates against its then-current status.
 *   'budget'    — a brand-new bill cleared the gate (or was forced) but
 *                 `allowDecode` was false this call
 *   'failed'    — the fetch or decode threw (including a text version that
 *                 exists but whose document couldn't be fetched — retryable,
 *                 unlike 'skipped_no_text'); `isNew` tells the caller
 *                 whether this was a new-bill decode failure (must retry)
 *                 or an existing bill's transient refresh failure
 *                 (idempotent, self-heals on its next update).
 *
 * Every result also carries `decodeAttempted`: true once this call has
 * reached the first Anthropic request, false otherwise. It is the ONLY
 * honest answer to "did this call cost money", and the outcome string is
 * not: 'failed' covers both a free Congress.gov timeout and a decode that
 * paid for two Sonnet calls and then failed its shape check. Callers that
 * charge a spend budget must charge on this, not on 'added' — see
 * chargeableDecode in scripts/newsdesk-match.mjs for the failure this fixed.
 */
export async function syncOneBill(u, ctx) {
  const { allowDecode, forceSlugs = new Set(), bills, es, bySlug, anthropic, decodeQueue = null } = ctx;
  const type = u.type.toLowerCase();
  const slug = updateSlug(u);
  let decodeAttempted = false;
  try {
    const { bill: d } = await cg(`/bill/${CONGRESS}/${type}/${u.number}`);
    const existing = bySlug.get(slug);
    if (existing) {
      // The sentinel IS the outcome: a payload we refused to write surfaces
      // to every caller as 'skipped_partial' instead of posing as a refresh
      // that happened to change nothing.
      //
      // `fetchedTitle` rides along unwritten. refreshBillFields deliberately
      // does NOT touch `title` — a title that changes without the decode
      // changing with it is a page whose headline and summary describe a
      // different document — but the caller needs the served title to notice
      // a VEHICLE SWAP (hr-6500-119 carried an AGOA decode while Congress was
      // voting the continuing resolution under the same number). The
      // re-decode trigger in scripts/newsdesk.mjs compares the two and, when
      // they diverge, re-reads the document and writes the new title WITH the
      // new decode, together, via redecodeBill below.
      return { outcome: refreshBillFields(existing, d), slug, decodeAttempted, fetchedTitle: d.title ?? null };
    }
    // Same fail-closed posture as refreshBillFields, one step earlier and via
    // the same shared predicate. A brand-new bill whose payload carries no
    // readable latestAction is not a bill with nothing happening; it's a
    // reply we can't read. Storing it would MINT a published record whose
    // status was never read from the official record — mapStatus(undefined)
    // invents 'committee' — with a null date and null text sitting beside
    // it, and would spend a decode doing it. That is the same downgrade the
    // refresh path used to commit, but with no prior value to contradict it,
    // so it's harder to spot: it is what left hr-2-119, hr-5-119 and
    // hr-10-119 in the corpus with null text AND null date.
    //
    // Nothing is stored, rather than stored with explicit nulls. There is no
    // honest null for `status`: the whole read side (lib/urgency.mjs's
    // STATUS_BASE, the feed, the bill page) expects one of the mapped
    // strings, so a null-status record would have to be papered over
    // downstream, and any placeholder we picked would be a claim about the
    // official record we never actually read. This is the posture the decode
    // path already takes on a bad decode shape — nothing partial ships, the
    // bill is simply not added, and it re-enters cleanly on a later run.
    //
    // The guard sits BEFORE the priority gate on purpose: 'gated' asserts
    // something about the BILL ("no real legislative motion"), and an
    // unreadable payload cannot support that claim about anything. Non-forced
    // bills only ever reached that verdict through mapStatus(undefined)'s
    // invented 'committee' — accidentally harmless, for a reason that wasn't
    // true. Forced slugs skipped the gate entirely and stored the nulls.
    //
    // Not a failure either: nothing was stored, so there is nothing to retry
    // and nothing for the cursor to freeze on. Congress.gov's own updateDate
    // resurfaces the bill the moment it really moves, exactly as it does for
    // a gated one.
    const action = readableAction(d);
    if (!action) return { outcome: 'skipped_partial', slug, decodeAttempted };
    const status = mapStatus(action.text);
    const forced = forceSlugs.has(slug);
    if (!forced && !passesGate(status)) {
      return { outcome: 'gated', slug, status, decodeAttempted };
    }
    if (!allowDecode) return { outcome: 'budget', slug, decodeAttempted };
    const lastActionDate = action.actionDate ?? null;
    const bill = {
      full_identifier: slug,
      congress_number: CONGRESS,
      bill_type: type,
      bill_number: Number(u.number),
      title: d.title,
      short_title: null,
      ai_summary: null, ai_headline: null,
      // WHEN this record's decode was produced. Null for every bill decoded
      // before 2026-08-12 and null is tolerated everywhere — it means
      // "unknown", never "old", and the re-decode trigger
      // (scripts/floor-signals-parse.mjs redecodeVerdict) skips on it rather
      // than re-explaining a decode that was probably fine. Without it
      // nothing downstream can tell a decode of THIS document from a decode
      // of the document this bill used to be.
      decoded_at: null,
      sponsor_bioguide_id: d.sponsors?.[0]?.bioguideId ?? null,
      introduced_date: d.introducedDate ?? null,
      last_action_date: lastActionDate,
      last_action_text: action.text,
      status,
      issue_tags: tagBill(d.policyArea?.name),
      policy_area: d.policyArea?.name ?? null,
      urgency_score: urgencyScore(status, lastActionDate),
      congress_gov_url: congressGovUrl(type, u.number),
    };
    // No text, no decode. fetchBillText returns null when Congress.gov
    // publishes no readable text version for this bill at all, and the decode
    // used to paper over that by feeding the model `bill.title` instead — one
    // sentence of formal long title, from which it produced a full
    // plain-language summary that reads exactly like every other decode. The
    // model has no way to say "I was not given the bill", so it wrote what a
    // bill of that name usually contains: sconres-39-119's shipped summary
    // states that a budget resolution "typically breaks down spending limits
    // by category ... and it may include instructions", as fact, about a
    // document nobody read. That is a fabricated record wearing the same
    // AI label as a real one, on the same page as the official citation.
    //
    // Store nothing rather than store that — the identical posture the
    // unreadable-payload guard above takes, and for the identical reason:
    // there is no honest partial version of "here is what this bill does".
    // Not a failure either: the payload was fine and the bill is real, it
    // simply has no text yet. So there is nothing to retry and nothing for
    // the cursor to freeze on — Congress.gov bumps the bill's updateDate when
    // its text is published, and the update feed resurfaces it then, exactly
    // as it does for a gated one. Callers count the skip and name it in their
    // run log, so a night that refuses N bills says so out loud.
    const text = await fetchBillText(type, u.number);
    if (text === null) return { outcome: 'skipped_no_text', slug, decodeAttempted };

    // THE BATCH HAND-OFF (2026-09-18). With a `decodeQueue` in ctx the caller
    // has taken responsibility for spending this decode itself, through
    // lib/decode-batch.mjs, at half price. Everything above this line — the
    // readable-payload refusal, the priority gate, the force bypass, the
    // budget, the no-text refusal — has already run and reached the same
    // verdict it always does; only the two model calls move. The bill is NOT
    // pushed into the corpus here: decode-before-publish is the whole point,
    // so it enters only once completeDecode below has a decode in hand.
    //
    // `decodeAttempted` stays FALSE on this return, and that is the honest
    // answer to the question it exists to answer ("did this call cost
    // money"): nothing has been submitted yet. The drain reports its own
    // spend.
    if (decodeQueue) {
      decodeQueue.push({ slug, bill, text });
      return { outcome: 'queued_decode', slug, decodeAttempted };
    }

    // Set BEFORE the await, not after: a throw inside decode() (its shape
    // check, a parse failure, an SDK error past the retries) still means the
    // request was issued and billed.
    decodeAttempted = true;
    const dec = await decodeBill(anthropic, bill, text);
    await completeDecode({ slug, bill, text, dec, bills, es, bySlug, anthropic });
    return { outcome: 'added', slug, decodeAttempted };
  } catch (e) {
    console.error(`FAIL ${slug}: ${e.message}`);
    return { outcome: 'failed', slug, isNew: !bySlug.has(slug), decodeAttempted };
  }
}

/**
 * RE-DECODE one bill already in the corpus, from its CURRENT text.
 *
 * syncOneBill above only ever decodes a bill it is adding: an existing record
 * gets its status and dates refreshed for free and keeps whatever decode it
 * was born with. That was fine while a bill's document was assumed to stand
 * still, and the corpus proves it does not — hr-6500-119 shipped a decode of
 * the AGOA Extension Act on the page where the Senate was voting a continuing
 * resolution under the same bill number, and the record's own action text had
 * moved seven times since the decode was written.
 *
 * WHO MAY CALL THIS: scripts/newsdesk.mjs's re-decode trigger, and only under
 * its EXISTING tier-0 decode budget. The verdict itself
 * (redecodeVerdict, scripts/floor-signals-parse.mjs) is pure and tested; this
 * function does not decide, it spends.
 *
 * THE SAME PUBLISH GATE AS EVERY OTHER DECODE, and for the same reason: the
 * new decode is written only after decode() has returned a shape the parser
 * accepted, both languages at once, so a partial reply leaves the OLD decode
 * standing rather than half-replacing it. A bill's page is never blank
 * because a re-read failed.
 *
 * `title` is the title Congress serves today. It is written ONLY here and
 * ONLY beside the new decode — the whole point is that the two can never
 * describe different documents.
 *
 * THE UNCHANGED-DOCUMENT SHORT-CIRCUIT (2026-09-18, the single largest
 * measured line in the pipeline's bill). `redecodeVerdict`'s stale-decode
 * rule fires on a DATE — the bill's latest action is newer than the day its
 * decode was written — and that is the right trigger, because an action can
 * mean a newly engrossed text. It is not, on its own, an answer: a rule
 * adopted, a motion to recommit, a placement on the calendar all move the
 * date without changing a word of the document. Re-decoding then pays two
 * Sonnet calls to rewrite a summary of text we have already read.
 *
 * So: when this call is NOT healing a vehicle swap (`title` is null) and the
 * document we just fetched is byte-identical to the one the stored decode was
 * written from, no model call is made. `decode_text_verified_at` is stamped —
 * a field that says exactly and only what happened, "on this date we
 * confirmed the stored decode's source text is still the current text" — and
 * the outcome is 'text-unchanged'. `decoded_at` is NOT touched: no decode was
 * produced, and that field means when one was.
 *
 * It cannot degrade a decode, because it never declines to re-read: the
 * document is fetched and compared every time. The only thing it declines is
 * paying a model to transform identical input into what must be the same
 * answer. A bill with no stored fingerprint (the whole pre-2026-09-18 corpus)
 * behaves exactly as before and picks one up on its next real re-decode, so
 * the saving phases in on its own with no backfill.
 *
 * A vehicle swap never short-circuits: a title that changed under us is the
 * one case where the record and the document have to be rewritten together,
 * and `title` being non-null is precisely that case.
 *
 * Returns `{ outcome, slug, decodeAttempted }`:
 *   'redecoded'       — new decode + ES twin stored, decoded_at stamped
 *   'text-unchanged'  — the current document is byte-identical to the one this
 *                 bill's decode was written from, so no model call was made
 *                 and the existing decode stands, re-verified. FREE, and the
 *                 bill IS mutated (decode_text_verified_at), so callers must
 *                 treat it as a data change worth committing.
 *   'missing'         — the slug isn't in the corpus (caller bug; free)
 *   'skipped_no_text' — Congress.gov publishes no readable text (free)
 *   'failed'          — the fetch or the decode threw; the old decode stands
 */
export async function redecodeBill(slug, ctx) {
  const { anthropic, es, bySlug, title = null } = ctx;
  const bill = bySlug.get(slug);
  if (!bill) return { outcome: 'missing', slug, decodeAttempted: false };
  let decodeAttempted = false;
  try {
    const text = await fetchBillText(bill.bill_type, bill.bill_number);
    if (text === null) return { outcome: 'skipped_no_text', slug, decodeAttempted };
    const fingerprint = textFingerprint(text);
    // See "THE UNCHANGED-DOCUMENT SHORT-CIRCUIT" above. Never on a vehicle
    // swap, and never on a bill whose decode predates the fingerprint.
    if (!title && bill.decode_text_sha && bill.decode_text_sha === fingerprint) {
      bill.decode_text_verified_at = new Date().toISOString();
      return { outcome: 'text-unchanged', slug, decodeAttempted };
    }
    const subject = title ? { ...bill, title } : bill;
    decodeAttempted = true;
    const dec = await decodeBill(anthropic, subject, text);
    if (title) bill.title = title;
    bill.ai_summary = dec.ai_summary;
    bill.ai_headline = dec.ai_headline;
    bill.ai_sections = dec.ai_sections;
    const stampedAt = new Date().toISOString();
    bill.decoded_at = stampedAt;
    bill.decode_text_sha = fingerprint;
    bill.decode_text_verified_at = stampedAt;
    es[slug] = { headline: dec.es_headline, summary: dec.es_summary, sections: dec.es_sections };
    // Search handles too, but ONLY when the vehicle changed under us: the old
    // press_names/news_query still name the old act, so the coverage sync and
    // the newsdesk's own t2 matcher would keep hunting for the wrong bill.
    // Non-fatal, exactly as on the add path — the backfill script sweeps
    // misses, and a failed search-input call must not cost a good decode.
    if (title) {
      try {
        const si = await generateSearchInputs(anthropic, bill);
        bill.press_names = si.press_names;
        bill.news_query = si.news_query;
      } catch (e) {
        console.error(`  search-inputs failed for ${slug}: ${e.message}`);
      }
    }
    return { outcome: 'redecoded', slug, decodeAttempted };
  } catch (e) {
    console.error(`FAIL redecode ${slug}: ${e.message}`);
    return { outcome: 'failed', slug, decodeAttempted };
  }
}

/** Read+parse a data/*.json file — tiny shared helper so both callers open
 *  the corpus the same way. */
export function loadJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

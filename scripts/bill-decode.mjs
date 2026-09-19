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
import { formattedTextUrl, pickTextVersion, textVersionStamp, versionCount } from './text-version.mjs';
import { classifyApiError } from './api-billing.mjs';
import { bumpCounter, recordApiError } from './run-counters.mjs';

/** Re-exported, not re-implemented: the "which document is the current text"
 *  question moved to scripts/text-version.mjs on 2026-09-18 so the re-decode
 *  trigger asks it the same way this file answers it. Existing importers
 *  (tests/bill-text-source.unit.spec.ts) are unchanged. */
export { pickTextVersion };

// Sonnet 5's tokenizer runs ~30% more tokens than 4.6 for the same text, so
// max_tokens caps on its calls are sized up accordingly; thinking is disabled
// explicitly because Sonnet 5 defaults it ON when the field is omitted, which
// would add unbounded thinking spend to batch calls.
export const DECODE_MODEL = 'claude-sonnet-5';

/**
 * ONE bill's published text versions, plus the count Congress.gov reports for
 * them. The single /text request both the decode path below and the nightly
 * re-decode probe (scripts/sync-bills.mjs) go through, so "what text exists
 * for this bill" is asked one way and counted one way — see versionCount in
 * scripts/text-version.mjs for why the count must not simply be the array's
 * length.
 */
export async function fetchTextVersions(type, number) {
  const data = await cg(`/bill/${CONGRESS}/${type}/${number}/text`);
  return {
    versions: Array.isArray(data.textVersions) ? data.textVersions : [],
    count: versionCount(data),
  };
}

/**
 * The current text of one bill as plain words — plus WHICH version that was,
 * so the record can say which document it was decoded from — or null when
 * Congress.gov publishes NO text for it yet (the caller refuses to decode on
 * null — see syncOneBill). Throws when a version exists but its document
 * can't be fetched, which is a retryable failure rather than a text-less bill.
 *
 * Only the current version is fetched. The old loop fell through to the next
 * version on a non-ok response, which — now that we start from the newest
 * rather than the oldest — would quietly decode a SUPERSEDED document
 * whenever the current one's HTML lagged, reintroducing exactly the staleness
 * pickTextVersion's comment describes. Nothing on the record distinguished a
 * summary of last month's text from a summary of this week's once it was
 * stored, which is precisely the gap the returned `version` now closes; a
 * text we can't fetch is still refused and retried, never approximated from
 * an older one.
 */
async function fetchBillText(type, number) {
  const { versions, count } = await fetchTextVersions(type, number);
  const version = pickTextVersion(versions);
  if (!version) return null;
  const url = formattedTextUrl(version);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bill text ${res.status} for ${type}/${number} (${version.type})`);
  const html = await res.text();
  return {
    text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60_000),
    version,
    count,
  };
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

/** Decode ONE bill from its own text. `text` is required and is always the
 *  document — it used to fall back to `bill.title` when fetchBillText came
 *  back null, which produced a normal-looking, unlabeled AI summary of a
 *  document the model had never read. See syncOneBill's null-text refusal. */
async function decode(anthropic, bill, text) {
  const sum = await anthropic.messages.create({
    model: DECODE_MODEL, max_tokens: 900, thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: `Explain this congressional bill in plain language for an everyday US resident (8th-grade reading level). 2-3 short paragraphs: what it actually does, and who it affects. Strictly nonpartisan, no advocacy, no preamble, no markdown.

Bill: ${bill.bill_type.toUpperCase()} ${bill.bill_number} — ${bill.title}

Full text (may be truncated):
${text}` }],
  });
  const ai_summary = sum.content[0].text.trim();

  const rest = await anthropic.messages.create({
    model: DECODE_MODEL, max_tokens: 3250, thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: `From this plain-language bill summary, produce headlines, scannable sections, and a Spanish translation.

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
[ES_SUMMARY]` }],
  });
  const p = parseTagged(rest.content[0].text.trim());
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

/**
 * The billing half of a 'failed' result, shared by both decode paths.
 *
 * A failure BEFORE the first Anthropic call (`decodeAttempted` false) is free
 * and always was - a Congress.gov 500, a timeout fetching the bill text. What
 * this adds is the second free case: the call was made and the API REFUSED it
 * before generating anything. Both are reported to the caller as
 * `unbilledApiError: true`, and every counter the run's honesty alarm reads is
 * recorded here, once, at the single point where a decode failure is known.
 *
 * `apiErrorKind` rides along for the log line only. It is a short label this
 * repo generates (scripts/api-billing.mjs), never a server message - nothing
 * that could carry request content into a counter file.
 */
function failureBilling(err, decodeAttempted) {
  if (!decodeAttempted) return { unbilledApiError: true, apiErrorKind: 'before_first_call' };
  const v = classifyApiError(err);
  recordApiError(v);
  if (v.unbilled) {
    console.error(
      `  ^ the API refused that request before generating (${v.kind}${v.status === null ? '' : `, HTTP ${v.status}`}) - NOT billed, so it is not charged to any decode cap${v.creditBalance ? '. THIS IS THE CREDIT-BALANCE REFUSAL: top up the Anthropic account' : ''}`
    );
  }
  return { unbilledApiError: v.unbilled, apiErrorKind: v.kind };
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
 *
 * And `unbilledApiError`: true when the call reached the API and the API
 * REFUSED it before generating anything — a credit-balance 400, any other
 * invalid_request_error, a 401/403/404/413/422/429, or a 5xx (see
 * scripts/api-billing.mjs). `decodeAttempted` is set before the request, so it
 * is true for those too, and on 2026-09-09/10 that let a credit outage spend
 * a whole day of decode caps on requests nobody was invoiced for. A caller
 * charging a budget must exempt them; chargeableDecode does.
 */
export async function syncOneBill(u, ctx) {
  const { allowDecode, forceSlugs = new Set(), bills, es, bySlug, anthropic } = ctx;
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
      //
      // `textVersionCount` rides along the same way and for the same kind of
      // reason: it is Congress.gov's own count of published text versions,
      // free in this payload, and it is the only signal a refresh can give
      // about whether the DOCUMENT changed rather than the calendar entry.
      // scripts/sync-bills.mjs compares it against the stored count to decide
      // which refreshed bills are worth a (free) /text probe. It is a hint
      // for ordering, never the thing that spends a decode — see
      // countSaysNewText in scripts/text-version.mjs.
      return {
        outcome: refreshBillFields(existing, d),
        slug,
        decodeAttempted,
        fetchedTitle: d.title ?? null,
        textVersionCount: Number.isFinite(d.textVersions?.count) ? d.textVersions.count : null,
      };
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
      // WHICH DOCUMENT this record's decode was produced from, and how many
      // text versions existed when we last looked. Declared null here and
      // written only beside a decode that succeeded (see the stamp below), so
      // a record can never claim provenance it doesn't have. Null is tolerated
      // everywhere and means "unknown" — scripts/text-version.mjs's
      // dateSaysNewText falls back to the bill's EARLIEST published version as
      // the baseline for those, which is the conservative direction: it can
      // only over-trigger a re-read, never let a stale explanation stand.
      text_version_date: null,
      text_version_type: null,
      text_version_count: null,
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
    const fetched = await fetchBillText(type, u.number);
    if (fetched === null) return { outcome: 'skipped_no_text', slug, decodeAttempted };
    // Set BEFORE the await, not after: a throw inside decode() (its shape
    // check, a parse failure, an SDK error past the retries) still means the
    // request was ISSUED. Whether it was BILLED is a second question, and the
    // catch below answers it — see `unbilledApiError`.
    decodeAttempted = true;
    bumpCounter('decodeAttempts');
    const dec = await decode(anthropic, bill, fetched.text);
    bill.ai_summary = dec.ai_summary;
    bill.ai_headline = dec.ai_headline;
    bill.ai_sections = dec.ai_sections;
    // Stamped only here and in redecodeBill — after the decode returned a
    // shape the gate accepted, never before it. A failed decode leaves no
    // stamp because it left no decode. The text-version stamp rides in the
    // same breath for the same reason: it describes the document `dec` was
    // produced from, and the two must never be able to come apart.
    bill.decoded_at = new Date().toISOString();
    Object.assign(bill, textVersionStamp(fetched.version, fetched.count));
    // Search handles for the coverage sync (press names + subject query).
    // Non-fatal: the backfill script sweeps up any misses.
    try {
      const si = await generateSearchInputs(anthropic, bill);
      bill.press_names = si.press_names;
      bill.news_query = si.news_query;
    } catch (e) {
      console.error(`  search-inputs failed for ${slug}: ${e.message}`);
      recordApiError(classifyApiError(e));
    }
    es[slug] = { headline: dec.es_headline, summary: dec.es_summary, sections: dec.es_sections };
    bills.push(bill);
    bySlug.set(slug, bill);
    return { outcome: 'added', slug, decodeAttempted };
  } catch (e) {
    console.error(`FAIL ${slug}: ${e.message}`);
    const billing = failureBilling(e, decodeAttempted);
    return {
      outcome: 'failed',
      slug,
      isNew: !bySlug.has(slug),
      decodeAttempted,
      unbilledApiError: billing.unbilledApiError,
      apiErrorKind: billing.apiErrorKind,
    };
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
 * WHO MAY CALL THIS, and under whose budget — two callers, two budgets, and
 * neither of them is this function's to decide:
 *   - scripts/newsdesk.mjs's re-decode trigger, under its EXISTING tier-0
 *     decode budget. Its verdict (redecodeVerdict, scripts/floor-signals-parse
 *     .mjs) asks "is this bill about to be seen, explained from the wrong
 *     document".
 *   - scripts/sync-bills.mjs's new-text trigger (2026-09-18), under its own
 *     REDECODE_MAX_PER_NIGHT ceiling. Its verdict (dateSaysNewText,
 *     scripts/text-version.mjs) asks a narrower question the newsdesk's
 *     cannot: has Congress published a NEWER TEXT than the one this record was
 *     decoded from — an amendment in committee, which moves no headline and
 *     trips no floor signal, and which is the likeliest single moment for a
 *     decode to stop describing its own bill.
 * Both are pure and tested. This function does not decide, it spends.
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
 * Returns `{ outcome, slug, decodeAttempted }`:
 *   'redecoded'       — new decode + ES twin stored, decoded_at stamped
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
    const fetched = await fetchBillText(bill.bill_type, bill.bill_number);
    if (fetched === null) return { outcome: 'skipped_no_text', slug, decodeAttempted };
    const subject = title ? { ...bill, title } : bill;
    decodeAttempted = true;
    bumpCounter('decodeAttempts');
    const dec = await decode(anthropic, subject, fetched.text);
    if (title) bill.title = title;
    bill.ai_summary = dec.ai_summary;
    bill.ai_headline = dec.ai_headline;
    bill.ai_sections = dec.ai_sections;
    bill.decoded_at = new Date().toISOString();
    // The whole point of the new-text trigger: the record now says which
    // version it was re-read from, so the next run measures against THIS
    // document rather than re-queueing the bill forever. Stamped from the
    // version fetchBillText actually read, never from textVersions[0] blind —
    // see dateSaysNewText's note on comparing like with like.
    Object.assign(bill, textVersionStamp(fetched.version, fetched.count));
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
        recordApiError(classifyApiError(e));
      }
    }
    return { outcome: 'redecoded', slug, decodeAttempted };
  } catch (e) {
    console.error(`FAIL redecode ${slug}: ${e.message}`);
    const billing = failureBilling(e, decodeAttempted);
    return {
      outcome: 'failed',
      slug,
      decodeAttempted,
      unbilledApiError: billing.unbilledApiError,
      apiErrorKind: billing.apiErrorKind,
    };
  }
}

/** Read+parse a data/*.json file — tiny shared helper so both callers open
 *  the corpus the same way. */
export function loadJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

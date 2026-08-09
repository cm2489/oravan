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

// Sonnet 5's tokenizer runs ~30% more tokens than 4.6 for the same text, so
// max_tokens caps on its calls are sized up accordingly; thinking is disabled
// explicitly because Sonnet 5 defaults it ON when the field is omitted, which
// would add unbounded thinking spend to batch calls.
export const DECODE_MODEL = 'claude-sonnet-5';

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
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60_000);
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

function normChips(s) {
  if (s === 'NONE' || !s) return null;
  const chips = s.split('|').map((c) => c.trim()).filter(Boolean);
  if (chips.length < 1 || chips.length > 3 || chips.some((c) => c.length > 48)) return null;
  return chips;
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
  return {
    ai_summary,
    ai_headline: p.HEADLINE_EN.slice(0, 110),
    ai_sections: {
      tldr: p.TLDR, what: p.WHAT, who: p.WHO, why: p.WHY,
      cost: normCost(p.COST), costChips: normChips(p.COST_CHIPS),
    },
    es_headline: p.HEADLINE_ES.slice(0, 110),
    es_summary: p.ES_SUMMARY,
    es_sections: {
      tldr: p.ES_TLDR, what: p.ES_WHAT, who: p.ES_WHO, why: p.ES_WHY,
      cost: normCost(p.ES_COST), costChips: normChips(p.ES_COST_CHIPS),
    },
  };
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
 */
export async function syncOneBill(u, ctx) {
  const { allowDecode, forceSlugs = new Set(), bills, es, bySlug, anthropic } = ctx;
  const type = u.type.toLowerCase();
  const slug = updateSlug(u);
  try {
    const { bill: d } = await cg(`/bill/${CONGRESS}/${type}/${u.number}`);
    const existing = bySlug.get(slug);
    if (existing) {
      // The sentinel IS the outcome: a payload we refused to write surfaces
      // to every caller as 'skipped_partial' instead of posing as a refresh
      // that happened to change nothing.
      return { outcome: refreshBillFields(existing, d), slug };
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
    if (!action) return { outcome: 'skipped_partial', slug };
    const status = mapStatus(action.text);
    const forced = forceSlugs.has(slug);
    if (!forced && !passesGate(status)) {
      return { outcome: 'gated', slug, status };
    }
    if (!allowDecode) return { outcome: 'budget', slug };
    const lastActionDate = action.actionDate ?? null;
    const bill = {
      full_identifier: slug,
      congress_number: CONGRESS,
      bill_type: type,
      bill_number: Number(u.number),
      title: d.title,
      short_title: null,
      ai_summary: null, ai_headline: null,
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
    if (text === null) return { outcome: 'skipped_no_text', slug };
    const dec = await decode(anthropic, bill, text);
    bill.ai_summary = dec.ai_summary;
    bill.ai_headline = dec.ai_headline;
    bill.ai_sections = dec.ai_sections;
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
    return { outcome: 'added', slug };
  } catch (e) {
    console.error(`FAIL ${slug}: ${e.message}`);
    return { outcome: 'failed', slug, isNew: !bySlug.has(slug) };
  }
}

/** Read+parse a data/*.json file — tiny shared helper so both callers open
 *  the corpus the same way. */
export function loadJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

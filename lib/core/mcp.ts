/*
 * MCP tool data-shaping (S10). Pure functions over lib/core + baked JSON -
 * the same corpus the site itself reads, through the same scoring path, so
 * neither surface carries a second copy of the data or of the urgency model.
 * No network calls happen here; the one network-shaped feature the spec
 * allows (Census address refinement) is deliberately NOT implemented in this
 * release - see lookupRepresentatives' doc comment for the scope decision
 * and its follow-up.
 *
 * PURE OVER THE DATA, NOT OVER THE CLOCK. Corrected 2026-08-08: this comment
 * said "an agent's answer and a visitor's page always agree", and the
 * time-dependent code below makes that false. whatsMoving cuts on
 * `Date.now() - days`; getBillDetail reads `urgency_band` out of getTeasers;
 * searchBills sorts by, and shapeBillTeaser stamps, `urgency_score` - and
 * every one of those is lib/urgency.mjs's effectiveUrgency, whose freshness
 * bonus and staleness decay move with elapsed days. whatsMoving's empty
 * result is then judged by emptyStateVerdict. All of them default to the
 * real clock. app/api/mcp/[transport]/route.ts is `force-dynamic`, so here
 * that clock is request time; the site's pages are statically generated, so
 * there it was build time. Identical inputs, two evaluation instants: the
 * answers can differ, and when they do this one is the fresher of the two,
 * never the staler. See that route's header for the full statement and why
 * the behaviour was left alone.
 *
 * Every tool's payload nests the citation envelope under `meta` (matching
 * the project records §2's illustrated shape) rather than
 * spreading the 5 fields at the top level, so envelope fields can never
 * collide with a tool's own data fields.
 */
import enMessages from '@/messages/en.json';
import { statusKeyFor, type StatusKeyBill } from '../journey';
import esMessages from '@/messages/es.json';
import { getFreshness } from '../freshness';
import { emptyStateVerdict } from '../freshness-state';
import { formatCitation } from '../format';
import { SITE_ORIGIN } from '../site';
import { TERMINAL_STATUSES } from '../urgency.mjs';
import {
  billSearchDoc,
  compareLastActionDesc,
  isEmptyBillQuery,
  matchesBillQuery,
  parseBillQuery,
  type BillSearchDoc,
} from '../bill-search.mjs';
import { decisionState } from '../docket.mjs';
/* The conversation lamp, for `whats_moving`'s optional evidence facet only. It
 * never touches the POOL or its order — that is the docket ladder's, and this
 * tool's whole contract is that Congress's own record decides what is moving.
 * The facet carries congress.gov's most-viewed listing and nothing read from
 * the AllSides table (see lib/core/mcp-conversation.ts). */
import { conversationBandPool } from '../conversation';
import { conversationFacet, type BillConversationOut } from './mcp-conversation';
import type { Bill, BillStatus, Legislator } from '../types';
import {
  billSlug,
  docketSignalFor,
  effectiveUrgency,
  getActNowInWindow,
  getAllBills,
  getBill,
  getTeasers,
  localizeBill,
} from './bills';
import { districtsForZip, getLegislator, portraitUrl, repsForDistrict, vacancyForDistrict } from './reps';

export type Locale = 'en' | 'es';

/*
 * The MCP server's real, live Streamable HTTP endpoint (S12). mcp-handler
 * derives this itself from route.ts's `basePath: '/api/mcp'` config
 * (deriveEndpointsFromBasePath: basePath + "/mcp" - verified against
 * mcp-handler's source and pinned by tests/helpers.ts's MCP_ENDPOINT), but
 * nothing before this sprint exported that literal anywhere a human-facing
 * surface could read it without re-deriving it by hand. Exported here so the
 * public /mcp docs page, llms.txt, and any future caller share one source
 * instead of each hardcoding the path fragment separately.
 */
export const MCP_ENDPOINT_PATH = '/api/mcp/mcp';
export const MCP_ENDPOINT_URL = `${SITE_ORIGIN}${MCP_ENDPOINT_PATH}`;

export function normalizeLocale(input?: string): Locale {
  return input === 'es' ? 'es' : 'en';
}

/* ---------------------------------------------------------------------- *
 * Citation envelope
 * ---------------------------------------------------------------------- */

export interface Envelope {
  as_of: string;
  source: string;
  canonical_url: string;
  ai_label: string | null;
  license: string;
}

// Exported (not just module-local): the citations/correction page (S23)
// quotes these same four strings verbatim so a reporter reading that page
// sees exactly what an agent's `meta` envelope says — one copy, not a
// second hand-written description that can drift from the real envelope.
//
// Keyed by locale (found + fixed post-#46): these five fields are the one
// thing every MCP response hands a caller to relay verbatim - an AI
// disclosure a Spanish-locale agent reads in English isn't a disclosure at
// all to the person on the other end. Bilingual parity is a CLAUDE.md hard
// rule; a redistributed surface like this one holds to the *higher* bar
// (project records, not in this repo). "CC BY 4.0" and
// "Congress.gov" stay untranslated in the Spanish text on purpose - a
// license identifier and a proper noun, not prose - the same convention the
// rest of the corpus follows for bill citations and source names.
export const SOURCE: Record<Locale, string> = {
  en: "Congress.gov and unitedstates/congress-legislators, via Oravan's nightly sync",
  es: 'Congress.gov y unitedstates/congress-legislators, mediante la sincronización nocturna de Oravan',
};

/**
 * The AI disclosure carried in every envelope. Corrected 2026-07-25
 * (pre-launch audit): it claimed "human-reviewed before publish", which was
 * never true of the decode path — the nightly sync commits decodes straight
 * to main with no human step, and the Moments live layer publishes its
 * summaries the same way. An agent consuming this API was being told a
 * provenance fact that did not hold, which is worse than saying less.
 *
 * What IS true, and is what it now says: the content is AI-generated, it is
 * always labeled, and it does not publish unless automated gates pass.
 */
export const AI_LABEL_TEXT: Record<Locale, string> = {
  en: 'This plain-language content is AI-generated and automatically checked before publish. It is not the official bill text.',
  es: 'Este contenido en lenguaje sencillo es generado por IA y verificado automáticamente antes de publicarse. No es el texto oficial del proyecto de ley.',
};

export const LICENSE_PUBLIC_DOMAIN: Record<Locale, string> = {
  en: 'Public domain (Congress.gov; unitedstates/congress-legislators).',
  es: 'Dominio público (Congress.gov; unitedstates/congress-legislators).',
};

export const LICENSE_AI_CONTENT: Record<Locale, string> = {
  en: "CC BY 4.0 (Oravan's AI-generated plain-language content); underlying official data is U.S. public domain (Congress.gov).",
  es: 'CC BY 4.0 (el contenido en lenguaje sencillo generado por IA de Oravan); los datos oficiales subyacentes son de dominio público en EE. UU. (Congress.gov).',
};

/*
 * i18n/routing.ts pins `localePrefix: 'as-needed'` with 'en' as the default
 * locale: en carries no prefix, es gets a leading /es. Reimplemented as a
 * literal branch (rather than importing next-intl's navigation helpers,
 * built for React rendering, into a headless JSON-RPC handler) because it's
 * the more legible source of truth for a data-only surface with exactly two
 * locales - if a third locale is ever added, routing.ts's own locale list
 * changing is the signal to revisit this.
 */
function localizedPath(locale: Locale, path: string): string {
  if (locale !== 'es') return path;
  // '/' + '/es' prefix must collapse to "/es", not "/es/" - next-intl's own
  // as-needed-prefix routing has no trailing slash on a locale root either.
  return path === '/' ? '/es' : `/es${path}`;
}

function absoluteUrl(locale: Locale, path: string): string {
  return `${SITE_ORIGIN}${localizedPath(locale, path)}`;
}

/** Every tool response's `meta` field - the one place all 5 fields are assembled. */
export function buildEnvelope(path: string, locale: Locale, hasAiContent: boolean): Envelope {
  return {
    as_of: getFreshness().checkedAt,
    source: SOURCE[locale],
    canonical_url: absoluteUrl(locale, path),
    ai_label: hasAiContent ? AI_LABEL_TEXT[locale] : null,
    license: hasAiContent ? LICENSE_AI_CONTENT[locale] : LICENSE_PUBLIC_DOMAIN[locale],
  };
}

/* ---------------------------------------------------------------------- *
 * Tool metadata (S12): the exact title/description strings
 * app/api/mcp/[transport]/route.ts hands an agent for each of the 5 tools,
 * relocated here so the public /mcp docs page (S12) can quote them verbatim
 * instead of hand-copying a second version that could silently drift from
 * what the live server actually sends. route.ts imports these same constants
 * for its registerTool() calls - one copy, two readers, same pattern as the
 * citation envelope above.
 *
 * English-only by design, like every other piece of tool/schema metadata a
 * calling agent's model reads (see route.ts's own header comment on this) -
 * never translated, unlike the envelope fields above, which ARE relayed to
 * an end user and so carry the higher bilingual-parity bar. The /mcp page
 * explains this distinction in prose rather than translating protocol
 * metadata that no agent would ever request in Spanish.
 * ---------------------------------------------------------------------- */

export const TOOL_NAMES = [
  'lookup_representatives',
  'get_bill',
  'search_bills',
  'whats_moving',
  'get_representative',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolInfo {
  title: string;
  description: string;
}

export const TOOL_INFO: Record<ToolName, ToolInfo> = {
  lookup_representatives: {
    title: 'Look up representatives by ZIP',
    description:
      "Look up a person's U.S. House member and two Senators by 5-digit ZIP code. Returns each " +
      "member's name, party, phone, official website, portrait URL, and district office phone " +
      'numbers - the number a constituent should actually call. Some ZIP codes span more than one ' +
      'congressional district (needs_address: true, all candidate districts returned); this tool ' +
      'does not perform address-level refinement itself in this release - point the person to the ' +
      "response's reps_url, where a stateless, unlogged Census-geocoder proxy narrows it to a " +
      'single district from a street address that Oravan never stores. When a House seat currently ' +
      'has no member, `vacancies` lists the empty seat(s) (state + district) explicitly - the ' +
      'departed member is never returned as if still serving, and no election timeline is implied.',
  },
  get_bill: {
    title: 'Get a bill decode',
    description:
      'Get the full plain-language decode of a federal bill by slug (e.g. "hr-2701-119") or ' +
      'citation (e.g. "H.R. 2701" - resolves to the most recent Congress on a match). Returns the ' +
      'AI-generated summary (headline, tl;dr, what/who/why/cost - automatically checked before ' +
      'publish and clearly labeled when present), the official status in plain language, a ' +
      'decision_state (pending, settled or enacted, with the official record\'s own sentence in ' +
      'settled_reason once the decision is settled or enacted), an urgency band and an urgency_score (the ' +
      'score is ranked from status and recency alone; decision_state, not the score, says whether a ' +
      'decision is still ahead), sponsor, key dates, the ' +
      "official Congress.gov page, and - while the decision is still pending - an act_url to Oravan's " +
      'on-site call flow. This tool never drafts a phone script - script generation happens only on-site, ' +
      'where the caller reads and can edit the script before dialing; that is not available over ' +
      'this API.',
  },
  search_bills: {
    title: 'Search bills',
    description:
      "Search Oravan's bilingual federal bill corpus by free-text query, issue topic, status, or " +
      'active-only. Returns short teasers (headline, status, decision_state, urgency) for matching ' +
      'bills, most urgent first. The urgency_score is ranked from status and recency alone; ' +
      'decision_state says whether a decision is still ahead.',
  },
  whats_moving: {
    title: "What's moving in Congress",
    description:
      "What's moving in Congress recently: active, plain-language-decoded bills that cleared " +
      "Oravan's 'act now' urgency bar within the last N days (default 7), optionally filtered by " +
      'topic. Returns an honest empty list with quiet_week: true when nothing has cleared the bar - ' +
      'this tool never pads the list to look busier than Congress actually is this week. If the ' +
      "list is empty because Oravan's own data sync looks stale rather than Congress being quiet, " +
      'data_stale is set instead so that distinction is never lost.',
  },
  get_representative: {
    title: 'Get a representative',
    description:
      'Get full details for one member of Congress by bioguide ID (e.g. "W000797"), plus their 5 ' +
      'most recently active sponsored bills. Facts only: no scorecards, ratings, or vote grades.',
  },
};

/* ---------------------------------------------------------------------- *
 * Plain-language labels - read off messages/{locale}.json directly rather
 * than through next-intl's getTranslations(), which is built around
 * request-scoped React rendering. This route has no such request context
 * (a single, non-locale-prefixed JSON-RPC path), and the strings needed
 * here are a small, fixed set already baked into the message files.
 * ---------------------------------------------------------------------- */

type Messages = typeof enMessages;
const MESSAGES: Record<Locale, Messages> = { en: enMessages, es: esMessages as Messages };

export function statusLabel(bill: StatusKeyBill, locale: Locale): string {
  // Label gate (Wave B #1): an activity-only floor_vote bill answers "Floor
  // activity", never the placement claim — the same statusKeyFor gate every
  // citizen surface uses. The date joined it with N3 (2026-08-11): a
  // placement the record has shown nothing about for over 14 days answers
  // "Placed on the calendar" rather than the present-tense "On the floor
  // calendar". And since 2026-09-29 the gate takes the whole record, so a
  // measure the second chamber passed without amendment answers "Passed both
  // chambers" and an adopted concurrent resolution "Adopted by both chambers",
  // never "Passed one chamber" (the passage readings need the bill type and
  // the status basis). Both call sites below hand over the bill itself, so
  // the approximation this function used to document for callers without the
  // text or the date no longer exists.
  const key = statusKeyFor(bill);
  const labels = MESSAGES[locale].bills.status as Record<string, string>;
  return labels[key] ?? labels[bill.status] ?? bill.status;
}

export function categoryLabel(category: string, locale: Locale): string {
  return (MESSAGES[locale].categories as Record<string, string>)[category] ?? category;
}

/* ---------------------------------------------------------------------- *
 * Tool-error copy - the same class of gap as the citation envelope: an
 * agent relays these strings verbatim on a bad ZIP/slug/citation/bioguide,
 * so they need a locale pair too, not just the happy-path payloads. Kept
 * here (not messages/{locale}.json) because these are MCP-protocol error
 * text, not site UI copy - app/api/mcp/[transport]/route.ts is the only
 * caller.
 * ---------------------------------------------------------------------- */

export function noDistrictDataError(zip: string, locale: Locale): string {
  return locale === 'es'
    ? `No se encontraron datos de distrito congresional para el código postal ${zip}.`
    : `No congressional district data found for ZIP ${zip}.`;
}

export function missingBillIdentifierError(locale: Locale): string {
  return locale === 'es' ? 'Proporciona "slug" o "citation".' : 'Provide either "slug" or "citation".';
}

export function billNotFoundError(input: { slug?: string; citation?: string }, locale: Locale): string {
  if (locale === 'es') {
    return `No se encontró ningún proyecto de ley para ${
      input.slug ? `el slug "${input.slug}"` : `la citación "${input.citation}"`
    }.`;
  }
  return `No bill found for ${input.slug ? `slug "${input.slug}"` : `citation "${input.citation}"`}.`;
}

export function representativeNotFoundError(bioguide: string, locale: Locale): string {
  return locale === 'es'
    ? `No se encontró ningún representante para el bioguide "${bioguide}".`
    : `No representative found for bioguide "${bioguide}".`;
}

/* ---------------------------------------------------------------------- *
 * Shared bill-teaser shaping (search_bills, whats_moving, get_representative)
 * ---------------------------------------------------------------------- */

export interface TeaserTopic {
  id: string;
  label: string;
}

/**
 * WHY A BILL IS ON THIS LIST — the envelope's checkability promise extended
 * from "here is the bill" to "here is the sentence that put it here".
 *
 * `tier` is the docket rung (lib/docket.mjs): `t0` the chamber named it on its
 * own published floor schedule, `t1` the record says a vote is ripening, `t2` a
 * dated calendar placement, `t3` it just cleared a gate, `t4` everything else.
 * The three evidence fields are what an agent can check the claim against
 * without trusting us: a sentence, a date, and a URL.
 *
 * `evidence_sentence` IS ENGLISH IN BOTH LOCALES, always, and that is a
 * decision rather than an omission (owner ruling V4): it is a verbatim quote of
 * a government document, and translating a quote turns it into a paraphrase
 * wearing quotation marks. Spanish payloads frame it; they never rewrite it.
 */
export interface BillSignalOut {
  tier: 't0' | 't1' | 't2' | 't3' | 't4';
  /** `just_decided` (the floor answered and the answer was no) or
   *  `just_passed` (a chamber passed it inside the signal window). */
  annotation: 'just_decided' | 'just_passed' | null;
  evidence_sentence: string | null;
  evidence_url: string | null;
  evidence_date: string | null;
}

/**
 * IS A DECISION STILL AHEAD (2026-09-27, the 2026-09-27 audit SY-03) — see
 * lib/docket.mjs `decisionState` for the three values and what each is read
 * from. ADDITIVE: `status` and `status_label` are unchanged for every existing
 * client; this is the field that says what they could not — that a vote to
 * pass the measure failed, or that the measure is law. Since 2026-09-29 (the
 * owner's pick (a): "Only a law or a failed final vote counts as finished")
 * a failed procedural vote, a failed two-thirds suspension vote and a veto
 * all read `pending`, and `get_bill` offers `act_url` on them, exactly as the
 * bill page keeps its call panel on them.
 */
export type DecisionStateOut = 'pending' | 'settled' | 'enacted';

export interface BillTeaserOut {
  slug: string;
  citation: string;
  url: string;
  headline: string | null;
  /** True only when `headline` IS the AI decode - house rule from the OG
   *  cards: a bill without an AI headline carries no AI chip. */
  ai_generated: boolean;
  title: string;
  status: BillStatus;
  status_label: string;
  decision_state: DecisionStateOut;
  /** The record's own sentence the decision was read from, verbatim and in
   *  English in both locales (a quote is never translated - owner ruling V4);
   *  null while `decision_state` is `pending`. */
  settled_reason: string | null;
  topics: TeaserTopic[];
  last_action_date: string | null;
  urgency_score: number;
  /** Set by `whats_moving` only — the tool whose whole answer is "what is
   *  moving and why". `search_bills` and `get_representative` return teasers
   *  that answer a different question and do not carry it. */
  signal?: BillSignalOut;
  /** Set by `whats_moving` only, and only for a bill on congress.gov's current
   *  most-viewed list at least two weeks running (lib/core/mcp-conversation.ts).
   *  Absent is the normal case. It is evidence, never a ranking: nothing here
   *  reorders `bills`. Until 2026-09-28 it also carried `outlets_7d` and
   *  `lean_spread`, both read from the AllSides table; the owner removed them
   *  that day ("Remove allsides leans from MCP"). */
  conversation?: BillConversationOut;
}

/** `bill` must already be locale-resolved (see localizeBill) before shaping. */
function shapeBillTeaser(bill: Bill, locale: Locale): BillTeaserOut {
  const slug = billSlug(bill);
  const decision = decisionState(bill);
  return {
    slug,
    citation: formatCitation(bill.bill_type, bill.bill_number),
    url: absoluteUrl(locale, `/bills/${slug}`),
    headline: bill.ai_headline,
    ai_generated: Boolean(bill.ai_headline),
    title: bill.short_title ?? bill.title,
    status: bill.status,
    status_label: statusLabel(bill, locale),
    decision_state: decision.state,
    settled_reason: decision.reason,
    topics: (bill.issue_tags ?? []).map((id) => ({ id, label: categoryLabel(id, locale) })),
    last_action_date: bill.last_action_date,
    urgency_score: effectiveUrgency(bill.status, bill.last_action_date),
  };
}

/* ---------------------------------------------------------------------- *
 * Citation parsing ("H.R. 2701", "S.J.Res. 99") for get_bill's `citation`
 * input - the app itself never needs this (pages always resolve by slug),
 * so it lives here rather than in lib/format.ts.
 * ---------------------------------------------------------------------- */

const CITATION_TYPE_CODES: Record<string, string> = {
  HR: 'hr',
  S: 's',
  HRES: 'hres',
  SRES: 'sres',
  HJRES: 'hjres',
  SJRES: 'sjres',
  HCONRES: 'hconres',
  SCONRES: 'sconres',
};

export function parseCitation(input: string): { billType: string; billNumber: number } | null {
  const cleaned = input.trim().toUpperCase().replace(/[.\s]/g, '');
  const m = /^([A-Z]+)(\d+)$/.exec(cleaned);
  if (!m) return null;
  const billType = CITATION_TYPE_CODES[m[1]];
  return billType ? { billType, billNumber: Number(m[2]) } : null;
}

/* ---------------------------------------------------------------------- *
 * Tool 1: lookup_representatives
 * ---------------------------------------------------------------------- */

const REPS_PATH = '/reps';

/**
 * ZIP-only in this release. the project records §2 specs
 * an optional `address` param routed through the existing stateless Census-
 * geocoder proxy (app/api/district) for split-ZIP refinement, but also
 * explicitly permits shipping ZIP-only with a `refine_hint` when that adds
 * more risk than an S10 sprint should carry - proxying an external geocoder
 * from inside a keyless, agent-facing MCP tool (retries, timeouts, an
 * agent's own caching behavior around a "sometimes ok" call) is exactly
 * that complexity. `refine_hint` below points at the site's own address
 * form instead, which already has this: the address travels once, in a
 * POST body, never stored or logged (app/api/district/route.ts). Follow-up,
 * not forgotten.
 */
export function lookupRepresentatives(zip: string, locale: Locale) {
  const districts = districtsForZip(zip);
  if (districts.length === 0) return null;

  const seen = new Set<string>();
  const representatives = districts
    .flatMap((d) => repsForDistrict(d))
    .filter((r) => (seen.has(r.bioguide) ? false : (seen.add(r.bioguide), true)))
    .map((r) => ({ ...r, portrait_url: portraitUrl(r.bioguide) }));
  // A vacant House seat (S24 groundwork, the project records §9.1(f)) is named explicitly here rather than left as "one
  // fewer representative than expected" - an agent reading this response has
  // no other way to distinguish a vacancy from, say, a data gap. Fact only
  // (state + district); `since` is pipeline bookkeeping, not surfaced here
  // so an agent never repeats it to a user as a confirmed resignation date.
  const vacancies = districts
    .map((d) => vacancyForDistrict(d))
    .filter((v): v is NonNullable<typeof v> => Boolean(v))
    .map((v) => ({ state: v.state, district: v.district }));
  const needsAddress = districts.length > 1;
  const repsUrl = `${absoluteUrl(locale, REPS_PATH)}?zip=${zip}`;

  return {
    zip,
    districts,
    representatives,
    vacancies,
    needs_address: needsAddress,
    refine_hint: needsAddress ? refineHintText(locale, repsUrl) : null,
    reps_url: repsUrl,
    meta: buildEnvelope(REPS_PATH, locale, false),
  };
}

// Same class of gap as the envelope (found alongside it): user-relayable
// prose that ignored `locale` entirely. `repsUrl` is already locale-prefixed
// by `absoluteUrl` above, so only the surrounding sentence needs a pair.
function refineHintText(locale: Locale, repsUrl: string): string {
  return locale === 'es'
    ? `Este código postal abarca más de un distrito congresional. Para obtener una respuesta de un solo distrito, indica a la persona que vaya a ${repsUrl} e ingrese allí una dirección postal - el refinamiento ocurre mediante un proxy sin estado del geocodificador del Census que nunca guarda ni registra la dirección. Esta herramienta no realiza el refinamiento por dirección directamente.`
    : `This ZIP code spans more than one congressional district. For a single-district answer, direct the person to ${repsUrl} and enter a street address there - refinement happens through a stateless Census-geocoder proxy that never stores or logs the address. This tool does not perform address-level refinement itself.`;
}

/* ---------------------------------------------------------------------- *
 * Tool 2: get_bill
 * ---------------------------------------------------------------------- */

export function getBillDetail(input: { slug?: string; citation?: string }, locale: Locale) {
  let bill: Bill | undefined = input.slug ? getBill(input.slug) : undefined;

  if (!bill && input.citation) {
    const parsed = parseCitation(input.citation);
    if (parsed) {
      // Two congresses (118, 119) coexist in the corpus; a bare citation
      // like "H.R. 2701" doesn't name one, so the most recent congress wins.
      bill = getAllBills()
        .filter((b) => b.bill_type === parsed.billType && b.bill_number === parsed.billNumber)
        .sort((a, b) => b.congress_number - a.congress_number)[0];
    }
  }
  if (!bill) return null;

  const localized = localizeBill(bill, locale);
  const slug = billSlug(localized);
  const url = absoluteUrl(locale, `/bills/${slug}`);
  const sponsor = localized.sponsor_bioguide_id ? getLegislator(localized.sponsor_bioguide_id) : undefined;
  // Reuse the site's own scored+floored band (KTD-2) rather than re-deriving
  // it - the one copy of "what counts as Act now" this week.
  const band = getTeasers(locale).find((t) => t.slug === slug)?.band ?? 'radar';
  const hasAiContent = Boolean(localized.ai_headline);
  const decision = decisionState(localized);

  // NOT in scope, by settled decision (the project records (kept out of this repo)
  // §2): this tool never drafts a call script. That's the product's only
  // per-call Anthropic cost and its highest platform-policy risk surface -
  // exposing it over a keyless MCP tool would also skip the one review step
  // the product actually has: on-site, the caller reads the script and can
  // edit it before dialing (citations.aiCallScript). An agent calling an API
  // is not that caller. `act_url` below is the deliberate replacement, every
  // time. (Reworded 2026-08-06: this used to quote a CLAUDE.md rule about AI
  // content being "human-reviewed before it drives a call" that the file no
  // longer carries in that form - see its 2026-07-25 amendment.)
  return {
    bill: {
      slug,
      citation: formatCitation(localized.bill_type, localized.bill_number),
      title: localized.title,
      short_title: localized.short_title,
      headline: localized.ai_headline,
      ai_generated: hasAiContent,
      decoded: localized.ai_sections
        ? {
            tldr: localized.ai_sections.tldr,
            what: localized.ai_sections.what,
            who: localized.ai_sections.who,
            why: localized.ai_sections.why,
            cost: localized.ai_sections.cost,
            cost_chips: localized.ai_sections.costChips ?? null,
          }
        : null,
      summary: localized.ai_summary,
      status: localized.status,
      status_label: statusLabel(localized, locale),
      decision_state: decision.state,
      settled_reason: decision.reason,
      urgency_score: effectiveUrgency(localized.status, localized.last_action_date),
      urgency_band: band,
      topics: (localized.issue_tags ?? []).map((id) => ({ id, label: categoryLabel(id, locale) })),
      sponsor: sponsor
        ? {
            bioguide: sponsor.bioguide,
            name: sponsor.name,
            party: sponsor.party,
            type: sponsor.type,
            state: sponsor.state,
            district: sponsor.district,
          }
        : null,
      introduced_date: localized.introduced_date,
      last_action_date: localized.last_action_date,
      last_action_text: localized.last_action_text,
      congress_gov_url: localized.congress_gov_url,
      url,
      // The only on-site call flow this tool ever hands back (see the
      // draft_call_script decision above) - identical to `url` while a
      // decision is still ahead, since the bill page IS the call-flow entry
      // point, kept as its own field because the two mean different things
      // (citation vs. call-to-action).
      //
      // NULL ONCE THE DECISION IS SETTLED OR ENACTED (2026-09-27, the
      // 2026-09-27 audit SY-03). A call-to-action for a resolution the Senate
      // has already voted down, or for a law, sends an agent's user to call
      // about a question with no vote left on it. `url` still carries the
      // citation; only the invitation to act is withdrawn.
      act_url: decision.state === 'pending' ? url : null,
    },
    meta: buildEnvelope(`/bills/${slug}`, locale, hasAiContent),
  };
}

/* ---------------------------------------------------------------------- *
 * Tool 3: search_bills
 * ---------------------------------------------------------------------- */

/*
 * The matcher is lib/bill-search.mjs, built to be shared with the site's
 * bills search (the 2026-09-27 audit, SY-21: both surfaces used to match the
 * whole query as a single substring, so "Iran war powers" found 1 of 12 and
 * "hconres 89" found nothing). What this tool contributes is only its list
 * of fields: the official title, the short title, the AI headline and summary
 * in the requested locale, and the localized topic labels. The citation
 * joins them inside billSearchDoc.
 *
 * Folding a summary is the expensive part (the whole corpus takes a few
 * hundred ms), so each bill's searchable form is built once per locale and
 * kept. The key is the raw corpus object, which lives as long as the module
 * does: the corpus is baked JSON and never changes inside a process.
 */
const SEARCH_DOCS: Record<Locale, WeakMap<Bill, BillSearchDoc>> = { en: new WeakMap(), es: new WeakMap() };

function searchDocFor(raw: Bill, locale: Locale): BillSearchDoc {
  const cached = SEARCH_DOCS[locale].get(raw);
  if (cached) return cached;
  const b = localizeBill(raw, locale);
  const doc = billSearchDoc(billSlug(b), [
    b.title,
    b.short_title,
    b.ai_headline,
    b.ai_summary,
    ...(b.issue_tags ?? []).map((id) => categoryLabel(id, locale)),
  ]);
  SEARCH_DOCS[locale].set(raw, doc);
  return doc;
}

export interface SearchBillsParams {
  query?: string;
  topic?: string;
  status?: BillStatus;
  activeOnly?: boolean;
  limit?: number;
}

const SEARCH_PATH = '/bills';

export function searchBills(params: SearchBillsParams, locale: Locale) {
  let bills = getAllBills();
  if (params.topic) bills = bills.filter((b) => (b.issue_tags ?? []).includes(params.topic!));
  if (params.status) bills = bills.filter((b) => b.status === params.status);
  if (params.activeOnly) bills = bills.filter((b) => !TERMINAL_STATUSES.has(b.status));
  if (params.query) {
    // A query with nothing searchable in it (blank, punctuation only) is no
    // filter, exactly as an omitted one.
    const query = parseBillQuery(params.query);
    if (!isEmptyBillQuery(query)) bills = bills.filter((b) => matchesBillQuery(query, searchDocFor(b, locale)));
  }

  // Most urgent first - the same "consequence, not novelty, decides
  // prominence" rule the rest of the corpus's feeds use. Equal urgency is
  // broken by the most recent last action (SY-21: a phrase search that
  // surfaced one stale resolution while a newer one had just been voted).
  const sorted = [...bills].sort(
    (a, b) =>
      effectiveUrgency(b.status, b.last_action_date) - effectiveUrgency(a.status, a.last_action_date) ||
      compareLastActionDesc(a.last_action_date, b.last_action_date)
  );
  const limit = params.limit ?? 20;
  const limited = sorted.slice(0, limit).map((b) => shapeBillTeaser(localizeBill(b, locale), locale));
  const hasAiContent = limited.some((t) => t.ai_generated);

  return {
    results: limited,
    total_matches: sorted.length,
    query: params.query ?? null,
    topic: params.topic ?? null,
    status: params.status ?? null,
    active_only: Boolean(params.activeOnly),
    meta: buildEnvelope(SEARCH_PATH, locale, hasAiContent),
  };
}

/* ---------------------------------------------------------------------- *
 * Tool 4: whats_moving
 * ---------------------------------------------------------------------- */

export interface WhatsMovingParams {
  days?: number;
  topic?: string;
  limit?: number;
}

const HOME_PATH = '/';

export function whatsMoving(params: WhatsMovingParams, locale: Locale) {
  const days = params.days ?? 7;
  const limit = params.limit ?? 10;

  // The exact set the homepage's "Act now" section reads (getTopActions's
  // pool, whole and uncut) - one urgency/floor scoring path, per KTD-2's house
  // rule against a second copy of it drifting from the site's own
  // (docs/solutions/stale-urgency-freeze.md) - inside the `days` window. The
  // window is tested on the date of the signal that put each bill in the pool
  // (a live chamber announcement's own date), then on its last action; see
  // `insideSignalWindow` in lib/docket.ts for why.
  const pool = getActNowInWindow(days, locale);
  const filtered = params.topic
    ? pool.filter((b) => (b.issue_tags ?? []).includes(params.topic as string))
    : pool;
  /*
   * EVERY ITEM CARRIES ITS OWN REASON (2026-08-12). The pool is the docket
   * ladder's act-now set, so each bill is here because of one sentence Congress
   * published — the chamber's floor schedule, or the bill's own last action —
   * and an agent should not have to take our ordering on faith. `signal` is
   * that sentence, its date and its URL.
   *
   * `conversation` is a SECOND, independent fact about the same bill and it
   * arrives as evidence only: whether congress.gov's own readers have kept it
   * on their most-viewed list. It is computed once per call (the pool is a few
   * dozen entries at most) and joined by slug; a bill the list does not carry
   * simply has no field. Nothing in it is read from the AllSides table.
   */
  const conversationBySlug = new Map(conversationBandPool().map((item) => [item.slug, item.evidence]));
  const limited = filtered.slice(0, limit).map((b) => {
    const teaser = shapeBillTeaser(b, locale);
    const conversation = conversationFacet(conversationBySlug.get(teaser.slug));
    const withEvidence: BillTeaserOut = conversation ? { ...teaser, conversation } : teaser;
    const signal = docketSignalFor(teaser.slug);
    if (!signal) return withEvidence;
    return {
      ...withEvidence,
      signal: {
        tier: signal.rung.tier,
        annotation: signal.rung.annotation,
        evidence_sentence: signal.evidence?.sentence ?? null,
        evidence_url: signal.evidence?.url ?? null,
        evidence_date: signal.evidence?.date ?? null,
      },
    };
  });
  const hasAiContent = limited.some((t) => t.ai_generated);

  /*
   * AE3/KTD-2 honesty rule, reusing lib/freshness-state.ts's collapse rather
   * than re-deriving it (that file's own doc comment names this exact
   * tool): an empty result reads as a genuine "quiet week" only while the
   * nightly pipeline itself looks alive AND the sync cursor/corpus itself
   * shows real recent progress (not just "the job executed" - see
   * emptyStateVerdict's own doc comment for why both signals matter). A
   * stale or dead pipeline must never be dressed up as "nothing to act on
   * this week" - that would hand an agent a fact about our sync health
   * disguised as a fact about Congress.
   */
  const verdict = limited.length === 0 ? emptyStateVerdict(getFreshness()) : null;

  return {
    bills: limited,
    days,
    topic: params.topic ?? null,
    quiet_week: verdict === 'quiet_week',
    data_stale: verdict === 'data_stale',
    meta: buildEnvelope(HOME_PATH, locale, hasAiContent),
  };
}

/* ---------------------------------------------------------------------- *
 * Tool 5: get_representative
 * ---------------------------------------------------------------------- */

export function getRepresentativeDetail(bioguide: string, locale: Locale) {
  const legislator: Legislator | undefined = getLegislator(bioguide);
  if (!legislator) return null;

  const sponsored = getAllBills()
    .filter((b) => b.sponsor_bioguide_id === bioguide)
    .sort((a, b) => (b.last_action_date ?? '').localeCompare(a.last_action_date ?? ''))
    .slice(0, 5)
    .map((b) => shapeBillTeaser(localizeBill(b, locale), locale));
  const hasAiContent = sponsored.some((t) => t.ai_generated);

  return {
    representative: {
      ...legislator,
      portrait_url: portraitUrl(bioguide),
      // Facts only, per the spec's nonpartisan line: no scorecards, grades,
      // or vote ratings ever get added here.
      recent_sponsored: sponsored,
    },
    meta: buildEnvelope(REPS_PATH, locale, hasAiContent),
  };
}

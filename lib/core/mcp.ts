/*
 * MCP tool data-shaping (S10). Pure functions over lib/core + baked JSON -
 * the same corpus the site itself reads, so an agent's answer and a
 * visitor's page always agree. No network calls happen here; the one
 * network-shaped feature the spec allows (Census address refinement) is
 * deliberately NOT implemented in this release - see lookupRepresentatives'
 * doc comment for the scope decision and its follow-up.
 *
 * Every tool's payload nests the citation envelope under `meta` (matching
 * docs/ideation/2026-07-02-mcp-spec.md §2's illustrated shape) rather than
 * spreading the 5 fields at the top level, so envelope fields can never
 * collide with a tool's own data fields.
 */
import enMessages from '@/messages/en.json';
import esMessages from '@/messages/es.json';
import { getFreshness } from '../freshness';
import { emptyStateVerdict } from '../freshness-state';
import { formatCitation } from '../format';
import { SITE_ORIGIN } from '../site';
import { TERMINAL_STATUSES } from '../urgency.mjs';
import type { Bill, BillStatus, Legislator } from '../types';
import {
  billSlug,
  effectiveUrgency,
  getAllBills,
  getBill,
  getTeasers,
  getTopActions,
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
// (docs/ideation/2026-07-05-build-gtm-strategy.md). "CC BY 4.0" and
// "Congress.gov" stay untranslated in the Spanish text on purpose - a
// license identifier and a proper noun, not prose - the same convention the
// rest of the corpus follows for bill citations and source names.
export const SOURCE: Record<Locale, string> = {
  en: "Congress.gov and unitedstates/congress-legislators, via Oravan's nightly sync",
  es: 'Congress.gov y unitedstates/congress-legislators, mediante la sincronización nocturna de Oravan',
};

export const AI_LABEL_TEXT: Record<Locale, string> = {
  en: 'This plain-language content is AI-generated and human-reviewed before publish. It is not the official bill text.',
  es: 'Este contenido en lenguaje sencillo es generado por IA y revisado por una persona antes de publicarse. No es el texto oficial del proyecto de ley.',
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
      'AI-generated summary (headline, tl;dr, what/who/why/cost - human-reviewed before publish and ' +
      'clearly labeled when present), the official status in plain language, an urgency band, ' +
      "sponsor, key dates, the official Congress.gov page, and an act_url to Oravan's on-site call " +
      'flow. This tool never drafts a phone script - script generation only happens on-site, behind ' +
      'a human-review step, never over this API.',
  },
  search_bills: {
    title: 'Search bills',
    description:
      "Search Oravan's bilingual federal bill corpus by free-text query, issue topic, status, or " +
      'active-only. Returns short teasers (headline, status, urgency) for matching bills, most ' +
      'urgent first.',
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

export function statusLabel(status: BillStatus, locale: Locale): string {
  return MESSAGES[locale].bills.status[status] ?? status;
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
  topics: TeaserTopic[];
  last_action_date: string | null;
  urgency_score: number;
}

/** `bill` must already be locale-resolved (see localizeBill) before shaping. */
function shapeBillTeaser(bill: Bill, locale: Locale): BillTeaserOut {
  const slug = billSlug(bill);
  return {
    slug,
    citation: formatCitation(bill.bill_type, bill.bill_number),
    url: absoluteUrl(locale, `/bills/${slug}`),
    headline: bill.ai_headline,
    ai_generated: Boolean(bill.ai_headline),
    title: bill.short_title ?? bill.title,
    status: bill.status,
    status_label: statusLabel(bill.status, locale),
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
 * ZIP-only in this release. docs/ideation/2026-07-02-mcp-spec.md §2 specs
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
  // A vacant House seat (S24 groundwork, docs/ideation/2026-07-05-build-gtm-
  // strategy.md §9.1(f)) is named explicitly here rather than left as "one
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

  // NOT in scope, by settled decision (docs/ideation/2026-07-02-mcp-spec.md
  // §2): this tool never drafts a call script. That's the product's only
  // per-call Anthropic cost and its highest platform-policy risk surface -
  // exposing it over a keyless MCP tool would also bypass "AI content is
  // human-reviewed before it drives a call" (CLAUDE.md). `act_url` below is
  // the deliberate replacement, every time.
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
      status_label: statusLabel(localized.status, locale),
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
      // draft_call_script decision above) - identical to `url` today since
      // the bill page IS the call-flow entry point, kept as its own field
      // because the two mean different things (citation vs. call-to-action).
      act_url: url,
    },
    meta: buildEnvelope(`/bills/${slug}`, locale, hasAiContent),
  };
}

/* ---------------------------------------------------------------------- *
 * Tool 3: search_bills
 * ---------------------------------------------------------------------- */

function matchesQuery(bill: Bill, query: string): boolean {
  const q = query.toLowerCase();
  return [bill.title, bill.short_title, bill.ai_headline, bill.ai_summary]
    .filter((v): v is string => Boolean(v))
    .some((v) => v.toLowerCase().includes(q));
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
    const query = params.query;
    bills = bills.filter((b) => matchesQuery(localizeBill(b, locale), query));
  }

  // Most urgent first - the same "consequence, not novelty, decides
  // prominence" rule the rest of the corpus's feeds use.
  const sorted = [...bills].sort(
    (a, b) => effectiveUrgency(b.status, b.last_action_date) - effectiveUrgency(a.status, a.last_action_date)
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

// getTopActions' own `n` param is a display cap, not a data-completeness
// one - passing a ceiling well above the corpus size returns the FULL
// "act now" set so this tool's own topic/day filters run over all of it,
// not a pre-truncated slice (n=10 would silently miss a topic-13th bill).
const WHATS_MOVING_POOL_SIZE = 10_000;

export interface WhatsMovingParams {
  days?: number;
  topic?: string;
  limit?: number;
}

const HOME_PATH = '/';

export function whatsMoving(params: WhatsMovingParams, locale: Locale) {
  const days = params.days ?? 7;
  const limit = params.limit ?? 10;
  const cutoff = Date.now() - days * 86_400_000;

  // The exact set the homepage's "Act now" section reads (getTopActions) -
  // one urgency/floor scoring path, per KTD-2's house rule against a second
  // copy of it drifting from the site's own (docs/solutions/
  // stale-urgency-freeze.md).
  const pool = getTopActions(WHATS_MOVING_POOL_SIZE, locale);
  const filtered = pool.filter((b) => {
    if (params.topic && !(b.issue_tags ?? []).includes(params.topic)) return false;
    if (!b.last_action_date) return false; // a recency claim needs a known date
    return new Date(b.last_action_date).getTime() >= cutoff;
  });
  const limited = filtered.slice(0, limit).map((b) => shapeBillTeaser(b, locale));
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

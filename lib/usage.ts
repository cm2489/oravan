// Type-only import (erased at compile time, zero runtime cost) — a VALUE
// import from lib/core/mcp.ts would transitively pull in lib/freshness.ts's
// `import 'server-only'`, which only resolves inside Next's own bundler
// (webpack/turbopack), not under plain node or tsx. scripts/daily-metrics.mjs
// (this file's one non-Next caller, via readUsageWindow below) MUST run
// under tsx to resolve lib/upstash.ts's own extensionless imports, so this
// module cannot depend on lib/core/mcp.ts at runtime — see MCP_TOOL_NAMES
// below for the (compile-time-checked) workaround.
import type { ToolName } from './core/mcp';
import { pageShapeForPath, type PageShape } from './page-shape';
import { countersClient, keyPrefix, noteUpstashError, type UpstashClient } from './upstash';

/*
 * MCP tool / AI-script usage counters (traffic-watch design, 2026-07).
 * This module is the ONLY place usage-database keys are built — it is the
 * SEVENTH registry scripts/check-key-namespaces.mjs gates on, alongside
 * lib/ratelimit.ts, lib/scriptcache.ts, lib/embed-referrer.ts,
 * lib/tenancy.ts, and lib/impressions.ts.
 *
 * WHAT THIS IS, STATED PLAINLY: a daily, per-tool invocation count and a
 * daily per-client-software initialize-handshake count for the MCP server
 * (app/api/mcp/[transport]/route.ts), plus a daily generation count for
 * /api/script (app/api/script/route.ts) — an internal operating signal for
 * a founder-facing digest (scripts/daily-metrics.mjs), never a per-caller
 * or per-content record. Counts every MCP tool INVOCATION
 * regardless of outcome (a not_found/bad_zip toolError still counts — "how
 * many times was the tool called," not a success-rate metric); a
 * rate-limited (429) request never reaches this module at all, since
 * app/api/mcp/[transport]/route.ts's limitedPost returns before the
 * handler runs. /api/script counts only real cache-miss generations (an
 * actual Anthropic spend), not cache hits.
 *
 * WHY `tool` IS SAFE HERE AND NOWHERE ELSE (the load-bearing property):
 * scripts/check-key-namespaces.mjs's CONTENT_IDENTIFIER list forbids the
 * literal substring "tool" in every OTHER counters-family registry,
 * because for rate-limiting a tool name is content, not identity. This
 * registry is the deliberate exception: `tool` is drawn from `McpToolName`
 * below, a closed 5-member compile-time union the MCP SDK itself supplies
 * to each registerTool callback — it is NEVER caller-controlled input. An
 * unknown tool name never reaches any handler (the SDK dispatches only to
 * its own registered table), so there is no code path through which a
 * request could inject an arbitrary string into a usage key. See the new
 * `usage-content`/`usage-caller` rules in scripts/check-key-namespaces.mjs
 * for how this is CI-enforced (usage-content is the same CONTENT_IDENTIFIER
 * list minus `tool` — a caller's ZIP, bill slug, or search string must
 * still never reach a usage key).
 *
 * Key registry — the only shapes ever written under this family:
 *
 *   <env>:usage:mcp:<tool>:<YYYY-MM-DD>          an INCR'd daily counter per tool
 *   <env>:usage:mcp-client:<client>:<YYYY-MM-DD> an INCR'd daily counter per
 *                                                self-reported MCP client
 *                                                software name — initialize
 *                                                HANDSHAKES, not tool calls
 *                                                (see noteMcpClientHandshake)
 *   <env>:usage:script:<YYYY-MM-DD>              an INCR'd daily counter
 *   <env>:usage:pageview:<surface>:<YYYY-MM-DD> an INCR'd daily counter per
 *                                                route-TEMPLATE label — the
 *                                                SHAPE of the page (home,
 *                                                bills-index, bill, …),
 *                                                never which page (see the
 *                                                CONSTITUTIONAL CONSTRAINT
 *                                                comment at PAGEVIEW_SURFACES)
 *   <env>:usage:script-refusal:<scope>:<YYYY-MM-DD>
 *                                                an INCR'd daily counter per
 *                                                /api/script 429 LIMITER —
 *                                                which guard said no, never
 *                                                to whom or about what (see
 *                                                SCRIPT_REFUSAL_SCOPES)
 *   <env>:usage:pageview-browser:<surface>:<YYYY-MM-DD>
 *                                                an INCR'd daily counter per
 *                                                route-TEMPLATE label, of the
 *                                                page views isBrowserPageLoad
 *                                                labels "browser" (2026-11-23)
 *   <env>:usage:rep-lookup:<YYYY-MM-DD>          an INCR'd daily counter of
 *                                                ZIP lookups that found
 *                                                members (2026-11-23)
 *   <env>:usage:script-served:<YYYY-MM-DD>       an INCR'd daily counter of
 *                                                call scripts served, cache
 *                                                hits included (2026-11-23)
 *   <env>:usage:read:<surface>:<YYYY-MM-DD>      an INCR'd daily counter per
 *                                                route-TEMPLATE label, of the
 *                                                reading signals app/api/seen
 *                                                accepted (2026-11-23, step 2)
 *
 * scripts/check-key-namespaces.mjs (usage-shape) holds this list as exact
 * key literals: a usage key built any other way fails CI.
 *
 * All of these families are content-free (no slug/stance/locale/query/bill)
 * and caller-free (no IP/UA/referer/salt) by construction: noteMcpToolCall's
 * only parameter is a closed-union tool name, noteScriptGeneration takes no
 * parameter at all, noteMcpClientHandshake's one input is force-
 * sanitized into a bounded software-name alphabet before any key is built
 * (see the CONSTITUTIONAL CONSTRAINT comment at sanitizeMcpClientName), and
 * notePageview's and noteScriptRefusal's are each force-narrowed to a closed
 * label union the same structural way (the route-template vocabulary and the
 * refusal-scope vocabulary below, both pinned by
 * scripts/check-key-namespaces.mjs).
 */

// 90 days: long enough for month-over-month trend context beyond a single
// week-over-week comparison (scripts/daily-metrics.mjs's own WoW compares
// day-1 against day-8), short enough that this stays an internal operating
// signal, not a durable business record — well short of the impressions
// family's 400d (lib/impressions.ts), which IS a sold, business-facing
// metric. Revisit if the digest ever grows a month-over-month view.
const USAGE_TTL_SECONDS = 90 * 24 * 60 * 60;

export type McpToolName = ToolName;

// A runtime-safe DUPLICATE of lib/core/mcp.ts's TOOL_NAMES — see the
// import comment above for why this can't be a runtime import instead.
// Compile-time-checked, not just hand-maintained: `_AssertComplete` below
// fails to typecheck (never a silent runtime drift) the moment ToolName
// gains or loses a member and this array isn't updated to match.
export const MCP_TOOL_NAMES = [
  'lookup_representatives',
  'get_bill',
  'search_bills',
  'whats_moving',
  'get_representative',
] as const satisfies readonly ToolName[];

type _AssertMcpToolNamesComplete = ToolName extends (typeof MCP_TOOL_NAMES)[number] ? true : never;
const _mcpToolNamesComplete: _AssertMcpToolNamesComplete = true;
void _mcpToolNamesComplete;

// --- usage-database key builders (the whole registry) -----------------------

export function mcpUsageKey(tool: McpToolName, day: string): string {
  return `${keyPrefix()}:usage:mcp:${tool}:${day}`;
}

export function scriptUsageKey(day: string): string {
  return `${keyPrefix()}:usage:script:${day}`;
}

export function brandUsageKey(day: string): string {
  return `${keyPrefix()}:usage:brand:${day}`;
}

/** UTC calendar date, YYYY-MM-DD — the daily bucket a usage count lives under. */
export function usageDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// --- MCP client-software handshake counters (2026-07) -----------------------

/*
 * CONSTITUTIONAL CONSTRAINT (CLAUDE.md "no server-side user data"): the
 * <client> key segment is the CLIENT SOFTWARE's self-reported name from the
 * MCP initialize handshake's params.clientInfo.name (e.g. "claude-ai",
 * "glama") — the identity of a PROGRAM, never of a person. Nothing else is
 * ever stored: no clientInfo.version, no User-Agent, no IP, no session
 * correlation — the counter is one integer per software name per UTC day.
 *
 * Unlike `tool` above (a closed compile-time union), this segment IS
 * caller-controlled input, so sanitization is structural, not advisory:
 * mcpClientUsageKey applies sanitizeMcpClientName itself, leaving no code
 * path through which a raw name can reach a key. The sanitized alphabet
 * ([a-z0-9._-], max 32 chars, "unknown" fallback) cannot carry the key
 * separator (":"), a glob character, or meaningful free-text — a hostile
 * clientInfo.name degrades to a short ASCII token, never key-structure
 * injection or an unbounded-length key.
 */

export const UNKNOWN_MCP_CLIENT = 'unknown';
const MCP_CLIENT_NAME_MAX_CHARS = 32;

/**
 * Lowercase, strip everything outside [a-z0-9._-], THEN truncate to 32
 * chars (strip-before-truncate keeps more signal from a name padded with
 * separators); empty/missing/non-string input degrades to "unknown".
 * Idempotent: sanitize(sanitize(x)) === sanitize(x).
 */
export function sanitizeMcpClientName(raw: unknown): string {
  if (typeof raw !== 'string') return UNKNOWN_MCP_CLIENT;
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, MCP_CLIENT_NAME_MAX_CHARS);
  return cleaned === '' ? UNKNOWN_MCP_CLIENT : cleaned;
}

export function mcpClientUsageKey(client: string, day: string): string {
  // Sanitization applied HERE, not just at the call site — see the
  // CONSTITUTIONAL CONSTRAINT comment above for why this is structural.
  return `${keyPrefix()}:usage:mcp-client:${sanitizeMcpClientName(client)}:${day}`;
}

// --- site page-view counters (site-counter, 2026-09) ------------------------

/*
 * WHAT THIS IS, STATED PLAINLY: one integer per ROUTE TEMPLATE per UTC day.
 * "The bill-detail template was requested 412 times yesterday" — never
 * WHICH bill, never by whom, never from where. It is a first-party,
 * server-side turnstile count for the founder-facing digest
 * (scripts/daily-metrics.mjs), and it is the reason the digest's long-
 * standing "site page-view traffic: not measured" disclosure changed: the
 * compliant data source the digest said did not exist is this one.
 *
 * CONSTITUTIONAL CONSTRAINT (CLAUDE.md "no server-side user data", "no
 * analytics trackers"): the <surface> segment is drawn from the closed
 * PAGEVIEW_SURFACES union below — route-template labels, fixed at compile
 * time, twelve of them. A path, a slug, a query string, a locale prefix, a
 * referer, an IP, or a User-Agent can never become one, and the narrowing
 * is STRUCTURAL rather than advisory: pageviewUsageKey pipes its own
 * argument through asPageviewSurface, so even an untyped or hostile caller
 * lands on 'other' instead of injecting a key segment. Same discipline as
 * mcpClientUsageKey/sanitizeMcpClientName above, one step stricter (a
 * closed set, not a bounded alphabet). The vocabulary itself is
 * CI-enforced: scripts/check-key-namespaces.mjs holds the canonical
 * allowlist, so adding a label means editing the privacy gate on purpose.
 *
 * NOTHING per-visitor is stored or derivable: no cookie is set or read, no
 * session, no ordering, no cross-request correlation, no client script at
 * all (the write happens in proxy.ts, server-side, inside waitUntil).
 * There is deliberately NO unique/visitor count IN THIS FAMILY: that would
 * need an identity this family is built to not have. The owner ruled one in
 * on 2026-09-25 as a SEPARATE structure — a single site-wide daily
 * HyperLogLog sketch of a salted address hash, with no route or page
 * dimension, hardened on 2026-09-27 to use its own salt that is deleted
 * when its UTC day ends — and it lives in lib/ratelimit.ts, the
 * caller-keyed registry, precisely so no caller-derived value ever sits in
 * this file (see noteDistinctAddress there).
 *
 * WHY THE COUNTERS DATABASE IS THE RIGHT HOME (lib/upstash.ts's split is
 * the rule being reasoned against): a pageview write adds a "what SHAPE of
 * page" entry to the database that also carries caller-hashed rate-limit
 * entries, so the temporal re-pairing risk that justified the three-way
 * split deserves an answer rather than a shrug. The answer is that this
 * family is strictly weaker than an already-accepted precedent: the
 * usage:script family is written in the SAME REQUEST as that request's own
 * rl:script:<callerHash> write, while a pageview write happens on a page
 * request that touches no rate limiter at all (the proxy matcher excludes
 * /api), and the most a log-level correlation could ever yield is "that
 * caller hash looked at some bill-shaped page" — the template, which the
 * URL in the same log line already states. No new class of linkage is
 * created; a family of thinner ones is not enough to justify a fourth
 * database.
 */

/**
 * The closed route-template vocabulary. Order is stable (digest rendering
 * reads it); 'other' is last and is the fallback every unrecognised path
 * collapses into.
 *
 * 'member' and 'today' joined on 2026-09-27 (the 2026-09-27 audit, SY-49):
 * until then the 1,082 member pages and the daily brief were counted under
 * 'other', which on 2026-09-25 held 1,824 of 4,529 views — the digest's one
 * traffic instrument could not see the member pages at all. Both are still
 * TEMPLATE labels ('member' is the member-page template, never which member;
 * 'today' is the daily-brief template, never which date), so the privacy
 * posture is unchanged: one integer per template per UTC day.
 *
 * 'short' joined on 2026-09-29 (owner, card d3, 2026-09-26: "Count
 * short-address visits (one number a day, nothing about who)"): one count
 * per UTC day of requests that a short address (/hr9340, lib/short-address.ts)
 * redirected to a bill page. It is the short-address TEMPLATE, never which
 * bill: proxy.ts passes the literal label and the path is dropped. It is not
 * a page of its own - each such visit also lands as a 'bill' view one hop
 * later - so scripts/daily-metrics.mjs leaves it out of the site total.
 * pageviewSurfaceForPath never returns it: only a redirect the proxy
 * actually made is counted, so a mistyped number that 404s stays 'other'.
 *
 * scripts/check-key-namespaces.mjs parses THIS declaration by name and
 * fails CI on any label outside its own allowlist — keep the two in sync
 * deliberately, which is the point.
 */
export const PAGEVIEW_SURFACES = [
  'home',
  'bills-index',
  'bill',
  'questions-index',
  'question',
  'reps',
  'member',
  'record',
  'nominations',
  'today',
  'short',
  'other',
] as const;

export type PageviewSurface = (typeof PAGEVIEW_SURFACES)[number];

export const OTHER_PAGEVIEW_SURFACE: PageviewSurface = 'other';

const PAGEVIEW_SURFACE_SET: ReadonlySet<string> = new Set<string>(PAGEVIEW_SURFACES);

/** Force any input onto the closed union; anything unrecognised is 'other'. */
export function asPageviewSurface(raw: unknown): PageviewSurface {
  return typeof raw === 'string' && PAGEVIEW_SURFACE_SET.has(raw)
    ? (raw as PageviewSurface)
    : OTHER_PAGEVIEW_SURFACE;
}

export function pageviewUsageKey(surface: PageviewSurface, day: string): string {
  // Narrowing applied HERE, not just at the call site — see the
  // CONSTITUTIONAL CONSTRAINT comment above for why this is structural.
  return `${keyPrefix()}:usage:pageview:${asPageviewSurface(surface)}:${day}`;
}

/**
 * Map a request path to its route-template label. The rule itself lives in
 * lib/page-shape.ts (moved there unchanged on 2026-11-23, with its full
 * comment) so the reading signal's browser script can use the same rule
 * without the counters client; this is the server's name for it.
 */
export function pageviewSurfaceForPath(pathname: string, locales: readonly string[] = []): PageviewSurface {
  return pageShapeForPath(pathname, locales);
}

// Compile-time: every shape the mapping can return is in the closed
// vocabulary, so a new shape cannot reach a key without being added there
// (and to the gate's allowlist) first.
type _AssertPageShapesInVocabulary = PageShape extends PageviewSurface ? true : never;
const _pageShapesInVocabulary: _AssertPageShapesInVocabulary = true;
void _pageShapesInVocabulary;

/**
 * Is this request one page view worth counting? Kept HERE rather than in
 * proxy.ts so the whole pageview family — vocabulary, key, predicate,
 * write, read — is reviewable in one file, and so the predicate is unit-
 * testable without importing Next's middleware runtime.
 *
 * Counted: a GET whose Accept asks for HTML. Excluded: every non-GET; RSC
 * payload fetches and router prefetches (the `RSC` / `Next-Router-Prefetch`
 * / `Next-Router-State-Tree` headers Next sets on its own client-side
 * navigations), which would otherwise multiply one human page view into
 * several. Static assets, /api, /_next, /_vercel and /embed never reach
 * here at all — proxy.ts's matcher already excludes them.
 *
 * Headers are READ and discarded; none of them reaches a key.
 */
export function isCountablePageviewRequest(req: {
  method: string;
  headers: { get(name: string): string | null };
}): boolean {
  if (req.method !== 'GET') return false;
  if (req.headers.get('rsc') !== null) return false;
  if (req.headers.get('next-router-prefetch') !== null) return false;
  if (req.headers.get('next-router-state-tree') !== null) return false;
  return (req.headers.get('accept') ?? '').includes('text/html');
}

// --- browser page loads (owner, 2026-11-23, card `people`, option b) --------

/*
 * WHAT THIS IS, STATED PLAINLY: a yes/no label on one countable page load —
 * "did this request arrive the way a web browser opening a page does, from
 * a program that does not call itself a crawler?" It exists because the
 * page-view count above includes every bot: on 2026-11-21 it read 4,410 page
 * loads from 1,737 distinct addresses but only 114 home-page loads. The
 * owner's words that started this, typed 2026-11-23: "I really need a way to
 * see how many real users are coming to the site while still preserving our
 * security guarantee."
 *
 * HOW IT DECIDES, from headers proxy.ts already receives and drops — read
 * here, answered as one boolean, and discarded:
 *   1. `Sec-Fetch-Dest: document` and `Sec-Fetch-Mode: navigate`. A browser
 *      sets these itself on a top-level page open (a script on a page cannot
 *      forge them); most crawlers and HTTP libraries send neither.
 *   2. a non-empty `Accept-Language`, which a browser always sends and many
 *      automated clients do not.
 *   3. a User-Agent that does NOT match SELF_DECLARED_CRAWLER below — the
 *      programs that say what they are.
 * All three must hold.
 *
 * WHAT IT GETS WRONG, said here so nobody reads the number as exact:
 *   - a bot that copies a browser's headers passes (headless browsers do);
 *   - browsers too old to send Sec-Fetch-* headers (Safari before 16.4,
 *     2023) fail, so they count as "not browser";
 *   - a person who opens a page from a link-preview or reader app may fail.
 * It is a label for an aggregate, not a verdict on anyone.
 *
 * NOTHING ABOUT THE LABEL IS STORED WITH A VISITOR. It chooses which
 * counters a load ALSO increments (the browser page-view count by route
 * template below, and lib/ratelimit.ts's second daily sketch); the
 * User-Agent, the language, and the headers themselves never reach a key.
 */

/**
 * Self-declared crawlers, matched case-insensitively against the User-Agent.
 * Every entry is a name its operator publishes in its own documentation for
 * site owners to recognise. Grouped so a new entry has an obvious home:
 *   search engines   Googlebot (and Google's other documented agents:
 *                    AdsBot-Google, Mediapartners-Google, Google-InspectionTool,
 *                    GoogleOther, Storebot-Google, Google-Read-Aloud), bingbot,
 *                    BingPreview, adidxbot, DuckDuckBot, YandexBot (Yandex*),
 *                    Baiduspider, Applebot, Slurp, Sogou, SeznamBot, PetalBot,
 *                    Qwantbot/Qwantify, Exabot, MojeekBot, coccocbot, Yeti, Neevabot
 *   AI crawlers and  GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot,
 *   assistants       Claude-User, Claude-SearchBot, anthropic-ai, PerplexityBot,
 *                    Perplexity-User, CCBot, Bytespider, Amazonbot,
 *                    meta-externalagent, meta-externalfetcher, FacebookBot,
 *                    cohere-ai, Diffbot, YouBot, Timpibot, ImagesiftBot,
 *                    Applebot-Extended, MistralAI-User, DuckAssistBot, AI2Bot
 *   link previews    facebookexternalhit, Twitterbot, LinkedInBot, Slackbot,
 *                    Discordbot, TelegramBot, WhatsApp, Pinterestbot, redditbot,
 *                    Embedly, SkypeUriPreview, Iframely, vkShare
 *   SEO tools        AhrefsBot, AhrefsSiteAudit, SemrushBot, SiteAuditBot,
 *                    MJ12bot, DotBot, rogerbot, BLEXBot, DataForSeoBot,
 *                    Screaming Frog, serpstatbot, barkrowler, SEOkicks, Sitebulb
 *   uptime/monitors  UptimeRobot, Pingdom, StatusCake, Better Uptime, Site24x7,
 *                    checkly, Datadog Synthetics, NewRelicPinger, Uptime-Kuma,
 *                    Freshping, Hetrix
 *   automation       HeadlessChrome, Lighthouse, Chrome-Lighthouse, PTST
 *                    (WebPageTest), GTmetrix, vercel-screenshot, python-requests,
 *                    python-urllib, aiohttp, httpx, Go-http-client, curl, Wget,
 *                    node-fetch, undici, axios, okhttp, Java/, libwww-perl,
 *                    Scrapy, HTTrack
 * plus the generic words "crawler" and "spider", and "bot" as a whole word
 * ("compatible; bot"). The generic rule is deliberately NOT a bare substring:
 * real phones whose model names contain those three letters ("Cubot") must
 * not be called bots.
 */
const SELF_DECLARED_CRAWLER = new RegExp(
  [
    // search engines
    'googlebot',
    'adsbot-google',
    'mediapartners-google',
    'google-inspectiontool',
    'googleother',
    'storebot-google',
    'google-read-aloud',
    'bingbot',
    'bingpreview',
    'adidxbot',
    'duckduckbot',
    'yandex',
    'baiduspider',
    'applebot',
    'slurp',
    'sogou',
    'seznambot',
    'petalbot',
    'qwantbot',
    'qwantify',
    'exabot',
    'mojeekbot',
    'coccocbot',
    '\\byeti\\b',
    'neevabot',
    // AI crawlers and assistants
    'gptbot',
    'chatgpt-user',
    'oai-searchbot',
    'claudebot',
    'claude-user',
    'claude-searchbot',
    'anthropic-ai',
    'perplexitybot',
    'perplexity-user',
    'ccbot',
    'bytespider',
    'amazonbot',
    'meta-externalagent',
    'meta-externalfetcher',
    'facebookbot',
    'cohere-ai',
    'diffbot',
    'youbot',
    'timpibot',
    'imagesiftbot',
    'mistralai-user',
    'duckassistbot',
    'ai2bot',
    // link previews
    'facebookexternalhit',
    'twitterbot',
    'linkedinbot',
    'slackbot',
    'discordbot',
    'telegrambot',
    'whatsapp',
    'pinterestbot',
    'redditbot',
    'embedly',
    'skypeuripreview',
    'iframely',
    'vkshare',
    // SEO tools
    'ahrefsbot',
    'ahrefssiteaudit',
    'semrushbot',
    'siteauditbot',
    'mj12bot',
    'dotbot',
    'rogerbot',
    'blexbot',
    'dataforseobot',
    'screaming frog',
    'serpstatbot',
    'barkrowler',
    'seokicks',
    'sitebulb',
    // uptime and monitors
    'uptimerobot',
    'pingdom',
    'statuscake',
    'better uptime',
    'site24x7',
    'checkly',
    'datadog',
    'newrelicpinger',
    'uptime-kuma',
    'freshping',
    'hetrix',
    // automation and HTTP libraries
    'headlesschrome',
    'lighthouse',
    '\\bptst\\b',
    'gtmetrix',
    'vercel-screenshot',
    'python-requests',
    'python-urllib',
    'aiohttp',
    'python-httpx',
    'go-http-client',
    '\\bcurl\\/',
    '\\bwget\\/',
    'node-fetch',
    'undici',
    'axios\\/',
    'okhttp',
    '\\bjava\\/',
    'libwww-perl',
    'scrapy',
    'httrack',
    // generic self-descriptions
    'crawler',
    'spider',
    '\\bbot\\b',
  ].join('|'),
  'i'
);

/** Does this User-Agent name itself as a crawler, preview fetcher, monitor or script? */
export function isSelfDeclaredCrawler(userAgent: string | null): boolean {
  return SELF_DECLARED_CRAWLER.test(userAgent ?? '');
}

/**
 * The browser label for one page load. Pure: reads four headers, returns one
 * boolean, keeps nothing. proxy.ts asks it only of a load that
 * isCountablePageviewRequest already counts, so a non-GET, a prefetch or an
 * RSC fetch is never "browser" either way. See the section comment above for
 * what it decides from and what it gets wrong.
 */
export function isBrowserPageLoad(headers: { get(name: string): string | null }): boolean {
  if ((headers.get('sec-fetch-dest') ?? '').toLowerCase() !== 'document') return false;
  if ((headers.get('sec-fetch-mode') ?? '').toLowerCase() !== 'navigate') return false;
  if ((headers.get('accept-language') ?? '').trim() === '') return false;
  return !isSelfDeclaredCrawler(headers.get('user-agent'));
}

/*
 * The browser page-view count: one integer per ROUTE TEMPLATE per UTC day,
 * of the page views above that isBrowserPageLoad labels "browser". Split by
 * template because the all-loads count already is: this divides an existing
 * aggregate into two aggregates and adds nothing about a visitor (no path,
 * no header value, no address — the same closed PAGEVIEW_SURFACES label,
 * narrowed inside the key builder). It is what lets the digest say how many
 * of 114 home-page loads came from a browser, where bots crawl bill pages
 * far more than they open the home page.
 */
export function browserPageviewUsageKey(surface: PageviewSurface, day: string): string {
  // Narrowing applied HERE, not just at the call site — same structural rule
  // as pageviewUsageKey.
  return `${keyPrefix()}:usage:pageview-browser:${asPageviewSurface(surface)}:${day}`;
}

// --- ZIP lookups and scripts served (owner, 2026-11-23, card `people`) ------

/*
 * Two plain daily totals with NO dimension at all — not by route, page,
 * bill, stance, ZIP, district, language, tenant, or caller:
 *
 *   rep-lookup     /api/reps answered a valid ZIP with at least one
 *                  district. It counts lookups, not people: a bill page asks
 *                  again on its own whenever a ZIP is saved on that device,
 *                  and Oravan's partner widgets call the same route.
 *   script-served  /api/script handed a call script to the page that asked,
 *                  drafted now OR already drafted (cache hits included) — the
 *                  count usage:script above leaves out on purpose, since that
 *                  one tracks spend. Partner widgets call the same route.
 *
 * Each is incremented with after() from its route, after the answer is
 * built, by a function that takes no argument — so there is no parameter
 * through which a ZIP, a bill or a stance could reach the key.
 */
export function repLookupUsageKey(day: string): string {
  return `${keyPrefix()}:usage:rep-lookup:${day}`;
}

export function scriptServedUsageKey(day: string): string {
  return `${keyPrefix()}:usage:script-served:${day}`;
}

// --- the reading signal (owner, 2026-11-23, card `people`, option b, step 2)

/*
 * WHAT THIS IS, STATED PLAINLY: one integer per ROUTE TEMPLATE per UTC day —
 * how many times Oravan's own browser script (lib/read-signal.ts) reported
 * that someone, on a page of that shape, first scrolled, tapped or pressed a
 * key while the page was visible. app/api/seen is the one writer. The value
 * the browser sends is accepted only if it is EXACTLY one of
 * PAGEVIEW_SURFACES (anything else is answered 204 and counted nowhere), and
 * the key builder narrows it again, so a request can never write a label of
 * its own. No path, bill, query, locale, header, address or timing reaches
 * the key.
 */
export function readUsageKey(surface: PageviewSurface, day: string): string {
  // Narrowing applied HERE as well — same structural rule as pageviewUsageKey.
  return `${keyPrefix()}:usage:read:${asPageviewSurface(surface)}:${day}`;
}

/**
 * Exact membership in the closed vocabulary, WITHOUT the 'other' fallback
 * asPageviewSurface applies: app/api/seen counts only a value that already
 * is a label, and drops everything else rather than filing it under 'other'.
 */
export function isPageviewSurface(raw: unknown): raw is PageviewSurface {
  return typeof raw === 'string' && PAGEVIEW_SURFACE_SET.has(raw);
}

// --- /api/script refusal counters (2026-09-27) ------------------------------

/*
 * WHAT THIS IS, STATED PLAINLY: one integer per /api/script LIMITER per UTC
 * day — "the daily spend breaker answered 429 three times yesterday". Never
 * which bill, which stance, which caller, which tenant, or from where.
 *
 * WHY IT EXISTS (the 2026-09-27 audit, SY-48): usage:script counts only
 * SUCCESSFUL cache-miss generations, and `script-day` (app/api/script/
 * route.ts) is a fail-CLOSED spend breaker. So a digest reading "Script
 * generations 0" could mean a quiet site or a call path that refused every
 * uncached request all day, and nothing told the two apart. This family is
 * the other half of that number: how many times each guard said no.
 *
 * The scopes are the three places the route answers 429, named for the guard,
 * not the person:
 *   'daily'   the GLOBAL spend breaker (script-day). Fail-closed, so it also
 *             refuses when the counters database cannot be reached.
 *   'burst'   the per-caller limiter (20 requests / 10 min).
 *   'tenant'  an embed tenant's own limiters (embed-script / -day).
 *
 * CONSTITUTIONAL CONSTRAINT (CLAUDE.md "no server-side user data"): the
 * <scope> segment is drawn from the closed union below, fixed at compile
 * time, and scriptRefusalUsageKey narrows its own argument through
 * asScriptRefusalScope — the pageview family's structural discipline, not a
 * convention. scripts/check-key-namespaces.mjs holds the canonical scope
 * allowlist and fails CI on any other label.
 *
 * NO NEW LINKAGE CLASS: the write happens in the same request as that
 * request's rl:script:<callerHash> check, which is exactly the usage:script
 * precedent argued above (the most a log-level correlation could yield is
 * "that caller hash was refused", which the 429 in the same log line already
 * says).
 *
 * WHAT IT CANNOT SEE, said here so nobody reads a zero as an all-clear: a
 * counters-database OUTAGE cannot count itself. The breaker refuses
 * (fail-closed) and this write, which goes to the same database, falls back
 * to per-instance memory with it. On such a day the digest shows zero here
 * AND the site page-view counts collapse too — that collapse is the tell.
 */
export const SCRIPT_REFUSAL_SCOPES = ['daily', 'burst', 'tenant'] as const;

export type ScriptRefusalScope = (typeof SCRIPT_REFUSAL_SCOPES)[number];

const SCRIPT_REFUSAL_SCOPE_SET: ReadonlySet<string> = new Set<string>(SCRIPT_REFUSAL_SCOPES);

/**
 * Force any input onto the closed union. Unlike the page-view vocabulary
 * there is no 'other' bucket: an unrecognised scope is a programming error,
 * and it collapses onto 'daily' — the one scope whose non-zero count the
 * digest flags — so a mistaken call site is noticed rather than hidden.
 */
export function asScriptRefusalScope(raw: unknown): ScriptRefusalScope {
  return typeof raw === 'string' && SCRIPT_REFUSAL_SCOPE_SET.has(raw) ? (raw as ScriptRefusalScope) : 'daily';
}

export function scriptRefusalUsageKey(scope: ScriptRefusalScope, day: string): string {
  // Narrowing applied HERE, not just at the call site — same structural rule
  // as pageviewUsageKey.
  return `${keyPrefix()}:usage:script-refusal:${asScriptRefusalScope(scope)}:${day}`;
}

// --- the ingestion calls ------------------------------------------------------

// In-memory fallback (env absent — local dev/CI/preview without env): same
// shape as lib/impressions.ts's own fallback map. Nothing here ever
// survives a redeploy — this path only exists so a usage write never
// throws when Upstash isn't configured.
const memoryCounts = new Map<string, number>();
const MEMORY_MAX_ENTRIES = 2000;

let fallbackLogged = false;

/** Test seam only — mirrors lib/impressions.ts's single-startup-line seam. */
export function __resetUsageFallbackLogForTests(): void {
  fallbackLogged = false;
}

/** Test seam only — reads the in-memory fallback count for one key. */
export function __memoryUsageCountForTests(key: string): number {
  return memoryCounts.get(key) ?? 0;
}

function logFallbackOnce(): void {
  if (fallbackLogged) return;
  fallbackLogged = true;
  console.log(
    'usage: counters database not configured (env absent) — using per-instance in-memory usage counts (expected in local dev, CI, and previews without env)'
  );
}

function memoryIncrement(key: string): void {
  if (memoryCounts.size >= MEMORY_MAX_ENTRIES) memoryCounts.clear(); // crude memory cap
  memoryCounts.set(key, (memoryCounts.get(key) ?? 0) + 1);
}

async function durableIncrement(client: UpstashClient, key: string): Promise<void> {
  // SET NX EX before INCR: the TTL is attached at creation, mirroring
  // lib/impressions.ts's durableIncrement, so a crash between commands can
  // never leave a TTL-less (effectively permanent) usage counter.
  const created = await client.cmd(['SET', key, '0', 'NX', 'EX', String(USAGE_TTL_SECONDS)]);
  const count = await client.cmd(['INCR', key]);
  if (count === 1 && created !== 'OK') {
    // The key expired between SET and INCR and INCR recreated it bare —
    // rare window-boundary race; re-attach the TTL.
    await client.cmd(['EXPIRE', key, String(USAGE_TTL_SECONDS)]);
  }
}

async function noteUsage(key: string): Promise<void> {
  const client = countersClient();
  if (!client) {
    logFallbackOnce();
    memoryIncrement(key);
    return;
  }
  try {
    await durableIncrement(client, key);
  } catch (err) {
    noteUpstashError('counters', err);
    memoryIncrement(key); // fail open — never blocks or fails the request
  }
}

/**
 * Record one MCP tool invocation. Called via `after()` (or, if `after()`'s
 * AsyncLocalStorage propagation through mcp-handler's callback dispatch
 * turns out not to hold, a direct unawaited call — see this file's PR
 * notes) from inside each registerTool callback in
 * app/api/mcp/[transport]/route.ts, so a slow or failed write can never
 * delay the tool's own response. Never throws.
 */
export async function noteMcpToolCall(tool: McpToolName): Promise<void> {
  await noteUsage(mcpUsageKey(tool, usageDayKey()));
}

/**
 * Record one real (cache-miss) script generation. Called via `after()` from
 * app/api/script/route.ts immediately after a successful cache.set, so a
 * slow or failed write can never delay the response. Never throws.
 */
export async function noteScriptGeneration(): Promise<void> {
  await noteUsage(scriptUsageKey(usageDayKey()));
}

/**
 * Record one real (cache-miss) brand-preview generation — an actual
 * Anthropic spend on /api/brand. Same after()-only, content-free,
 * caller-free contract as noteScriptGeneration. Never throws.
 */
export async function noteBrandPreview(): Promise<void> {
  await noteUsage(brandUsageKey(usageDayKey()));
}

/**
 * Record one /api/script 429, by the guard that returned it. Called via
 * `after()` from app/api/script/route.ts at each of its three 429 sites, so a
 * slow or failed write never delays the refusal itself. Content-free and
 * caller-free: the one input is narrowed onto SCRIPT_REFUSAL_SCOPES before
 * any key is built. Never throws.
 */
export async function noteScriptRefusal(scope: ScriptRefusalScope): Promise<void> {
  await noteUsage(scriptRefusalUsageKey(scope, usageDayKey()));
}

/**
 * Record one MCP initialize HANDSHAKE — a client software connecting, NOT a
 * tool call. Handshakes are the honest unit for this family: the HTTP route
 * is deliberately stateless (fresh McpServer per POST), so the SDK's
 * initialize-time clientInfo (server.server.getClientVersion()) is always
 * undefined by the time a separate tools/call POST arrives — verified
 * empirically against mcp-handler@1.1.0 + @modelcontextprotocol/sdk@1.26.0.
 * The initialize request's own body is the one place the name exists, so
 * that is what gets counted, once per handshake.
 *
 * Called via `after()` from app/api/mcp/[transport]/route.ts's limitedPost
 * (rate-limited requests never reach it), so a slow or failed write can
 * never delay the response. Takes the RAW caller-controlled
 * params.clientInfo.name as `unknown` and sanitizes before any key is
 * built (see sanitizeMcpClientName). Never throws.
 */
export async function noteMcpClientHandshake(clientName: unknown): Promise<void> {
  await noteUsage(mcpClientUsageKey(sanitizeMcpClientName(clientName), usageDayKey()));
}

/**
 * Record one site page view against a route-template label. Called from
 * proxy.ts inside `event.waitUntil()` — the middleware equivalent of the
 * `after()` the other writers use — so the response is already on its way
 * out before this runs and a slow or failed counters write can never delay
 * or fail a page load. Takes the label as `unknown`-tolerant input by way
 * of pageviewUsageKey's own narrowing. Never throws.
 */
export async function notePageview(surface: PageviewSurface): Promise<void> {
  await noteUsage(pageviewUsageKey(surface, usageDayKey()));
}

/**
 * Record one BROWSER page view against a route-template label — called from
 * proxy.ts, in its own waitUntil, only for a load isBrowserPageLoad labelled
 * "browser" (that load is ALSO counted by notePageview). Same contract as
 * notePageview. Never throws.
 */
export async function noteBrowserPageview(surface: PageviewSurface): Promise<void> {
  await noteUsage(browserPageviewUsageKey(surface, usageDayKey()));
}

/**
 * Record one ZIP lookup that found members of Congress. No parameter: the ZIP,
 * the districts and the members stay in app/api/reps. Never throws.
 */
export async function noteRepLookup(): Promise<void> {
  await noteUsage(repLookupUsageKey(usageDayKey()));
}

/**
 * Record one call script served, drafted now or already drafted. No
 * parameter: the bill, stance, language and caller stay in app/api/script.
 * Never throws.
 */
export async function noteScriptServed(): Promise<void> {
  await noteUsage(scriptServedUsageKey(usageDayKey()));
}

/**
 * Record one reading signal against a route-template label. Called by
 * app/api/seen only after the value passed isPageviewSurface. Never throws.
 */
export async function noteRead(surface: PageviewSurface): Promise<void> {
  await noteUsage(readUsageKey(surface, usageDayKey()));
}

// --- the digest read path (scripts/daily-metrics.mjs, via tsx) --------------

export type UsageWindowResult =
  | {
      ok: true;
      mcp: Record<McpToolName, number[]>;
      script: number[];
      scriptRefusals: Record<ScriptRefusalScope, number[]>;
    }
  | { ok: false };

/**
 * Read `days.length` days' worth of counts for all 5 MCP tools + script
 * generations + script refusals by scope (added 2026-09-27, SY-48 — read
 * beside the generations they explain), ONE Upstash round trip via MGET,
 * never N sequential GETs —
 * mirrors lib/impressions.ts's readImpressionsWindow. `days` is caller-
 * supplied (scripts/daily-metrics.mjs's trailingWindowDays, from
 * lib/traffic-metrics.mjs) and this function is order-agnostic beyond
 * "index i in `days` maps back to index i in each returned array."
 *
 * DELIBERATE WRITE/READ ASYMMETRY (same reasoning as
 * readImpressionsWindow): the write path above fails open and silent. This
 * read fails LOUD instead — `{ ok: false }` on an unconfigured counters
 * client, an Upstash request error, or a malformed MGET result, never a
 * silently-degraded number. The per-instance in-memory fallback the write
 * path uses would badly undercount here too (this read runs once, from a
 * short-lived GitHub Actions process, not a long-lived serverless
 * instance — there is no meaningful in-memory fallback to fall back TO),
 * so the caller (scripts/daily-metrics.mjs) turns `{ ok: false }` into a
 * loud CI failure, never a digest with an invented number in it.
 */
export async function readUsageWindow(days: string[]): Promise<UsageWindowResult> {
  const client = countersClient();
  if (!client) return { ok: false };

  const allKeys = [
    ...MCP_TOOL_NAMES.flatMap((tool) => days.map((day) => mcpUsageKey(tool, day))),
    ...days.map((day) => scriptUsageKey(day)),
    ...SCRIPT_REFUSAL_SCOPES.flatMap((scope) => days.map((day) => scriptRefusalUsageKey(scope, day))),
  ];

  let raw: unknown;
  try {
    raw = await client.cmd(['MGET', ...allKeys]);
  } catch (err) {
    noteUpstashError('counters', err, 'failing closed to a digest read error (usage window, never a degraded number)');
    return { ok: false };
  }
  if (!Array.isArray(raw) || raw.length !== allKeys.length) return { ok: false };

  const toNum = (v: unknown): number => (typeof v === 'string' ? Number(v) || 0 : 0);
  const mcp = {} as Record<McpToolName, number[]>;
  let cursor = 0;
  for (const tool of MCP_TOOL_NAMES) {
    mcp[tool] = raw.slice(cursor, cursor + days.length).map(toNum);
    cursor += days.length;
  }
  const script = raw.slice(cursor, cursor + days.length).map(toNum);
  cursor += days.length;
  const scriptRefusals = {} as Record<ScriptRefusalScope, number[]>;
  for (const scope of SCRIPT_REFUSAL_SCOPES) {
    scriptRefusals[scope] = raw.slice(cursor, cursor + days.length).map(toNum);
    cursor += days.length;
  }

  return { ok: true, mcp, script, scriptRefusals };
}

export type PageviewWindowResult =
  | { ok: true; surfaces: Record<PageviewSurface, number[]> }
  | { ok: false };

/**
 * Read `days.length` days' worth of counts for every surface, ONE Upstash
 * round trip via MGET — same shape and same DELIBERATE WRITE/READ ASYMMETRY
 * as readUsageWindow above (the write fails open and silent; this fails
 * LOUD with `{ ok: false }` rather than hand the digest a degraded number).
 * Index i in `days` maps back to index i in each returned array.
 *
 * An empty `days` is answered with empty series rather than an MGET with no
 * arguments, which Upstash rejects.
 */
export async function readPageviewWindow(days: string[]): Promise<PageviewWindowResult> {
  const client = countersClient();
  if (!client) return { ok: false };

  const emptySurfaces = (): Record<PageviewSurface, number[]> => {
    const out = {} as Record<PageviewSurface, number[]>;
    for (const surface of PAGEVIEW_SURFACES) out[surface] = [];
    return out;
  };
  if (days.length === 0) return { ok: true, surfaces: emptySurfaces() };

  const allKeys = PAGEVIEW_SURFACES.flatMap((surface) => days.map((day) => pageviewUsageKey(surface, day)));

  let raw: unknown;
  try {
    raw = await client.cmd(['MGET', ...allKeys]);
  } catch (err) {
    noteUpstashError(
      'counters',
      err,
      'failing closed to a digest read error (page-view window, never a degraded number)'
    );
    return { ok: false };
  }
  if (!Array.isArray(raw) || raw.length !== allKeys.length) return { ok: false };

  const toNum = (v: unknown): number => (typeof v === 'string' ? Number(v) || 0 : 0);
  const surfaces = emptySurfaces();
  let cursor = 0;
  for (const surface of PAGEVIEW_SURFACES) {
    surfaces[surface] = raw.slice(cursor, cursor + days.length).map(toNum);
    cursor += days.length;
  }

  return { ok: true, surfaces };
}

export type PeopleSignalsWindowResult =
  | {
      ok: true;
      /** Browser page views per route template (browserPageviewUsageKey). */
      browserSurfaces: Record<PageviewSurface, number[]>;
      /** ZIP lookups that found members (repLookupUsageKey). */
      repLookups: number[];
      /** Call scripts served, cache hits included (scriptServedUsageKey). */
      scriptsServed: number[];
      /** Reading signals per route template (readUsageKey, step 2). */
      readSurfaces: Record<PageviewSurface, number[]>;
    }
  | { ok: false };

/**
 * Read `days.length` days of the 2026-11-23 "people" counts in ONE MGET:
 * browser page views by template, ZIP lookups, scripts served. Index i in
 * `days` maps back to index i in each array. Fails closed (`{ ok: false }`)
 * like every digest read here; scripts/daily-metrics.mjs treats that as
 * "not read" on the People block only, since these keys are new.
 *
 * Exported for the weekly owner note as well as the daily digest:
 * lib/traffic-metrics.mjs's peopleEstimate turns one day of this (plus the
 * page-view window and lib/ratelimit.ts's two sketch readings) into the
 * floor / ceiling / bots' share the digest prints.
 */
export async function readPeopleSignalsWindow(days: string[]): Promise<PeopleSignalsWindowResult> {
  const client = countersClient();
  if (!client) return { ok: false };

  const emptySurfaces = (): Record<PageviewSurface, number[]> => {
    const out = {} as Record<PageviewSurface, number[]>;
    for (const surface of PAGEVIEW_SURFACES) out[surface] = [];
    return out;
  };
  if (days.length === 0) {
    return { ok: true, browserSurfaces: emptySurfaces(), repLookups: [], scriptsServed: [], readSurfaces: emptySurfaces() };
  }

  const allKeys = [
    ...PAGEVIEW_SURFACES.flatMap((surface) => days.map((day) => browserPageviewUsageKey(surface, day))),
    ...days.map((day) => repLookupUsageKey(day)),
    ...days.map((day) => scriptServedUsageKey(day)),
    ...PAGEVIEW_SURFACES.flatMap((surface) => days.map((day) => readUsageKey(surface, day))),
  ];

  let raw: unknown;
  try {
    raw = await client.cmd(['MGET', ...allKeys]);
  } catch (err) {
    noteUpstashError('counters', err, 'failing closed to a digest read error (people counts, never a degraded number)');
    return { ok: false };
  }
  if (!Array.isArray(raw) || raw.length !== allKeys.length) return { ok: false };

  const toNum = (v: unknown): number => (typeof v === 'string' ? Number(v) || 0 : 0);
  const browserSurfaces = emptySurfaces();
  let cursor = 0;
  for (const surface of PAGEVIEW_SURFACES) {
    browserSurfaces[surface] = raw.slice(cursor, cursor + days.length).map(toNum);
    cursor += days.length;
  }
  const repLookups = raw.slice(cursor, cursor + days.length).map(toNum);
  cursor += days.length;
  const scriptsServed = raw.slice(cursor, cursor + days.length).map(toNum);
  cursor += days.length;
  const readSurfaces = emptySurfaces();
  for (const surface of PAGEVIEW_SURFACES) {
    readSurfaces[surface] = raw.slice(cursor, cursor + days.length).map(toNum);
    cursor += days.length;
  }

  return { ok: true, browserSurfaces, repLookups, scriptsServed, readSurfaces };
}

export type McpClientDayResult =
  | { ok: true; clients: Array<{ client: string; count: number }> }
  | { ok: false };

// SCAN page budget for readMcpClientDay. The sanitized-name alphabet caps
// the family at one key per distinct 32-char token per day, so a day's
// worth of client keys is small; 50 pages × COUNT 100 is orders of
// magnitude of headroom. If the cursor still hasn't exhausted by then,
// something is wrong — fail closed rather than under-report.
const MCP_CLIENT_SCAN_MAX_PAGES = 50;

/**
 * Read ONE day's MCP client-handshake counts, every client name seen that
 * day. Client names are open-ended (self-reported), so unlike
 * readUsageWindow there is no fixed key list to MGET directly — this SCANs
 * the day's `usage:mcp-client:*` pattern first (cursor loop, bounded), then
 * MGETs the found keys in one round trip. Returns clients sorted by count
 * descending, ties alphabetical.
 *
 * Same DELIBERATE WRITE/READ ASYMMETRY as readUsageWindow above: fails
 * LOUD (`{ ok: false }`) on an unconfigured client, a request error, a
 * malformed reply, or an unexhausted scan — never a silently-degraded
 * list. A day with genuinely no handshakes is `{ ok: true, clients: [] }`,
 * which the digest renders as an honest "none recorded".
 */
export async function readMcpClientDay(day: string): Promise<McpClientDayResult> {
  const client = countersClient();
  if (!client) return { ok: false };

  const prefix = `${keyPrefix()}:usage:mcp-client:`;
  const suffix = `:${day}`;

  const found = new Set<string>(); // SCAN may return a key more than once
  let scanCursor = '0';
  try {
    for (let page = 0; page < MCP_CLIENT_SCAN_MAX_PAGES; page += 1) {
      const raw = await client.cmd(['SCAN', scanCursor, 'MATCH', `${prefix}*${suffix}`, 'COUNT', '100']);
      if (!Array.isArray(raw) || raw.length !== 2 || !Array.isArray(raw[1])) return { ok: false };
      for (const key of raw[1]) {
        if (typeof key === 'string') found.add(key);
      }
      scanCursor = String(raw[0]);
      if (scanCursor === '0') break;
    }
  } catch (err) {
    noteUpstashError(
      'counters',
      err,
      'failing closed to a digest read error (MCP client handshakes, never a degraded number)'
    );
    return { ok: false };
  }
  if (scanCursor !== '0') return { ok: false }; // never exhausted — refuse to under-report

  const keys = [...found];
  if (keys.length === 0) return { ok: true, clients: [] };

  let counts: unknown;
  try {
    counts = await client.cmd(['MGET', ...keys]);
  } catch (err) {
    noteUpstashError(
      'counters',
      err,
      'failing closed to a digest read error (MCP client handshakes, never a degraded number)'
    );
    return { ok: false };
  }
  if (!Array.isArray(counts) || counts.length !== keys.length) return { ok: false };

  const clients = keys
    .map((key, i) => ({
      client: key.slice(prefix.length, key.length - suffix.length),
      count: typeof counts[i] === 'string' ? Number(counts[i]) || 0 : 0,
    }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || (a.client < b.client ? -1 : a.client > b.client ? 1 : 0));

  return { ok: true, clients };
}

/**
 * Upstash key-namespace privacy gate (S11; KTD-3, AE5). Fails CI when code
 * would blur the line between the counters, cache, and tenancy Upstash
 * databases, or let the domain-nomination family (S15, F3) drift outside
 * its own rules:
 *
 *   counters DB — TWO key families live here, both caller-agnostic in the
 *                 sense that neither may ever carry the OTHER family's kind
 *                 of material:
 *                   - rate-limit counters: caller-keyed, short-lived.
 *                     No slug/stance/locale/tool/bill identifier may ever
 *                     reach one (lib/ratelimit.ts is the single registry).
 *                   - embed-domain nominations (S15, F3): domain-keyed,
 *                     content-free AND caller-free. No slug/stance/locale/
 *                     tool identifier, no IP/caller-hash/salt/address
 *                     material, and never the raw Referer/URL itself may
 *                     reach one (lib/embed-referrer.ts is the single
 *                     registry).
 *   cache DB    — content-keyed script cache ONLY. No IP-, caller-, salt-,
 *                 or address-derived material may ever reach a cache key
 *                 (lib/scriptcache.ts is the single registry).
 *   tenancy DB  — durable institutional tenant records + capability-token
 *                 reverse index (S18). No IP-, caller-, salt-, or
 *                 address-derived material may ever reach a tenancy key
 *                 either (lib/tenancy.ts is the single registry) — tenant
 *                 config is institutional, not caller data, and must not
 *                 blur into the caller-keyed doctrine any more than the
 *                 cache database may.
 *
 * counters DB gains a THIRD family (S20): impression counts
 *                 (tenantId + day, content-free AND caller-free, same shape
 *                 discipline as the embed-domain-nomination family —
 *                 lib/impressions.ts is the single registry).
 *
 * counters DB gains a FOURTH family (traffic-watch, 2026-07): MCP tool /
 *                 AI-script usage counters (lib/usage.ts is the single
 *                 registry). Content-free like every other counters family
 *                 (no slug/stance/locale/query/bill — a caller's own lookup
 *                 key must never reach a usage key), but with ONE
 *                 deliberate carve-out from CONTENT_IDENTIFIER: `tool` is
 *                 allowed here, and ONLY here — it is drawn from a closed
 *                 5-member compile-time union the MCP SDK itself supplies,
 *                 never caller-controlled input (see lib/usage.ts's header
 *                 comment for the full argument). Still caller-free — no
 *                 IP/UA/referer/salt may reach a usage key either.
 *
 * The usage family gains a THIRD key shape (mcp-client handshakes,
 *                 2026-07): a daily counter per self-reported MCP client
 *                 SOFTWARE name (initialize's params.clientInfo.name —
 *                 program identity, never user data). Unlike `tool`, that
 *                 segment IS caller-controlled, so lib/usage.ts sanitizes
 *                 it structurally inside the key builder itself
 *                 ([a-z0-9._-], max 32 chars, "unknown" fallback). The
 *                 adjacent temptations stay banned by rule: no User-Agent
 *                 material (CALLER_MATERIAL names it) and no client
 *                 VERSION (USAGE_CONTENT_IDENTIFIER names it — software
 *                 name only) may ever reach a usage key.
 *
 * The usage family gains a FOURTH key shape (site page views,
 *                 site-counter 2026-09): a daily counter per ROUTE-TEMPLATE
 *                 label — the shape of the page ('bill'), never which page.
 *                 Two teeth, because this family is the first one whose
 *                 input starts life as a URL:
 *                   - the `pageview-surface` rule below holds the CANONICAL
 *                     label vocabulary. lib/usage.ts's PAGEVIEW_SURFACES
 *                     declaration is parsed and every label checked against
 *                     it, so widening the vocabulary means editing this
 *                     privacy gate on purpose rather than editing a list in
 *                     passing. A pageview key with no parsable declaration
 *                     behind it fails too — the check cannot be removed by
 *                     renaming the constant.
 *                   - RAW_REFERER_MATERIAL now applies to this registry the
 *                     way it already applies to embed-domain nominations:
 *                     the raw pathname/URL/query the label is DERIVED from
 *                     must never itself reach a key. (`bill` reads as a
 *                     forbidden token in USAGE_CONTENT_IDENTIFIER, and
 *                     correctly so for an interpolation — a caller's bill
 *                     identifier is content. It survives as a LABEL here
 *                     only because it is a fixed member of the closed
 *                     vocabulary this gate itself pins, never an
 *                     interpolated value.)
 *                 Widened 2026-09-27 (the 2026-09-27 audit, SY-49) by two
 *                 template labels, 'member' (/reps/<id>) and 'today'
 *                 (/today and /today/<date>) — still templates, never which
 *                 member or which date.
 *
 * The usage family gains a FIFTH key shape (script refusals, 2026-09-27,
 *                 the 2026-09-27 audit, SY-48): a daily counter per
 *                 /api/script 429 LIMITER — 'daily' (the global spend
 *                 breaker), 'burst' (the per-caller limiter), 'tenant' (an
 *                 embed tenant's limiters). Same closed-vocabulary teeth as
 *                 the pageview shape: the `script-refusal-scope` rule below
 *                 holds the canonical scope list, lib/usage.ts's
 *                 SCRIPT_REFUSAL_SCOPES declaration is parsed and checked
 *                 against it, and a registry that writes refusal keys with no
 *                 parsable declaration fails. A scope names a GUARD; nothing
 *                 about the caller, the tenant, or the request's content may
 *                 become one.
 *
 * counters DB gains a FIFTH family (daily distinct-address count, owner
 *                 ruling 2026-09-25): ONE HyperLogLog sketch per UTC day for
 *                 the whole site, fed the rate limiter's own salted caller
 *                 hash. It is the first structure whose VALUE (not just its
 *                 key) is derived from caller material, so it lives in the
 *                 caller-keyed registry (lib/ratelimit.ts) and never in the
 *                 content-free usage registry, and it gets three teeth of
 *                 its own:
 *                   - distinct-shape: inside lib/ratelimit.ts the family's
 *                     key is exactly the literal DISTINCT_KEY_LITERAL below
 *                     (env prefix + day, nothing else) — a route, page,
 *                     surface, bill, or locale folded into it is a failure,
 *                     because a per-page sketch would pair an address-derived
 *                     token with a political interest. PFMERGE (a multi-day
 *                     sketch) is banned outright.
 *                   - distinct-confinement: the family's key marker and the
 *                     HyperLogLog commands appear in NO other scanned file,
 *                     so a second sketch cannot be built somewhere else.
 *                   - distinct-raw-address: a PFADD element is never the raw
 *                     address — the database would hash it with its own
 *                     UNSALTED function and it would stay testable forever.
 *                 Comments are ignored by these three (they describe the
 *                 shape in prose); code is not.
 *
 * The distinct-address family gains its OWN SALT (hardened 2026-09-27, owner
 *                 decision "2. b": "the sketch gets its own salt, deleted
 *                 when its UTC day ends, which closes the after-the-day
 *                 window"). One key per UTC day, `<env>:uniques-salt:<day>`,
 *                 read and written only by lib/ratelimit.ts's
 *                 distinctDaySalt. Four more teeth, code-only like the three
 *                 above:
 *                   - distinct-salt-shape: inside the registry the salt key
 *                     is exactly DISTINCT_SALT_KEY_LITERAL — env prefix and
 *                     day, nothing else.
 *                   - distinct-salt-confinement: the salt family and its two
 *                     accessors appear in NO other scanned file, so nothing
 *                     else can read the salt while it lives.
 *                   - distinct-salt-expiry: the salt dies at or before the
 *                     end of its UTC day and is never extended. Every command
 *                     on the salt key is a read, a delete, SET NX with EXAT
 *                     at distinctSaltExpiresAt(...), or EXPIREAT at that same
 *                     deadline; any relative expiry (EX/PX/EXPIRE), KEEPTTL,
 *                     PERSIST, or other writer fails. distinctSaltExpiresAt's
 *                     own body is parsed and its offset past the day's
 *                     00:00:00Z must be at most one day (86,400s).
 *                   - distinct-salt-separation: the rate limiter's salt and
 *                     hash (currentSalt, saltKey, parseSaltRecord, callerHash)
 *                     never appear in a function that feeds the sketch or
 *                     makes its salt or element — the limiter's salt lives
 *                     24h from creation, not to the end of a UTC day.
 *
 * Also enforces:
 *   - env/client confinement: only the registry modules may touch their
 *     database's env vars or client constructor, so key construction can't
 *     quietly appear elsewhere.
 *   - the house request-shape invariant: no content identifier in a
 *     caller-originating URL query string across /api/script, MCP, and
 *     (future) embed surfaces — the district route's POST-not-GET rule,
 *     promoted to a gate.
 *   - vocabulary discipline: hashed-IP records are "short-lived rate-limit
 *     counters", never "anonymized" — hashing a 32-bit space is
 *     pseudonymization, and code comments don't get to claim otherwise.
 *
 * `--self-test` runs every rule against seeded violation fixtures and exits
 * nonzero if any seeded violation goes undetected — so the gate itself is
 * tested, not trusted (tests/key-namespaces.spec.ts runs both modes).
 *
 * Stdlib only, like the other CI gates (check-messages-parity.mjs).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

// Production code only: routes, lib, app pages/components, root proxy.
// tests/ and scripts/ are out of scope (tests must be free to build hostile
// fixtures; scripts/verify-salt.mjs legitimately reads the counters env).
const SCAN_DIRS = ['app', 'lib'];
const SCAN_ROOT_FILES = ['proxy.ts'];
const EXTENSIONS = ['.ts', '.tsx'];

// The five registries.
const COUNTERS_REGISTRY = 'lib/ratelimit.ts';
const CACHE_REGISTRY = 'lib/scriptcache.ts';
const DOMAIN_REGISTRY = 'lib/embed-referrer.ts';
const TENANCY_REGISTRY = 'lib/tenancy.ts';
const IMPRESSION_REGISTRY = 'lib/impressions.ts';
const USAGE_REGISTRY = 'lib/usage.ts';
const CLIENT_MODULE = 'lib/upstash.ts';

// Identifier fragments that mark CONTENT (never allowed near counters or
// domain-nomination keys) and CALLER material (never allowed near cache or
// domain-nomination keys).
// `\bzip\b` added with the 'reps' route label (fix/api-reps-rate-limit):
// /api/reps is the first rate-limited route whose request carries a ZIP, and
// a ZIP is the one identifier that is BOTH the caller's own lookup key and a
// location — precisely the "network address linked to a political position"
// the constitution forbids. CALLER_MATERIAL already named it, but
// CALLER_MATERIAL is deliberately NOT applied to the counters registry
// (caller material is that registry's whole point), so before this a
// `${zip}` interpolation in lib/ratelimit.ts would have passed every rule.
// Naming it here closes that hole without weakening anything: no counters/
// domain/impression key has any business carrying a ZIP.
const CONTENT_IDENTIFIER = /slug|stance|locale|\blang\b|bill|tool|summary|title|topic|query|citation|\bzip\b/i;
// `useragent`/`\bua\b` added with the mcp-client handshake shape (2026-07):
// a client SOFTWARE name is allowed into the usage registry, but the
// adjacent temptation — User-Agent header material — is caller material in
// every registry, named here so a `${userAgent}` interpolation can never
// pass as "just another client identifier".
const CALLER_MATERIAL = /(^|[^a-z])ip([^a-z]|$)|forwarded|caller|salt|address|\bzip\b|useragent|\bua\b/i;
// The usage registry's OWN content rule (traffic-watch, 2026-07): identical
// to CONTENT_IDENTIFIER except `tool` is deliberately removed — this is the
// one registry where a tool name is the intentional dimension, not content
// (see lib/usage.ts's header comment). Every OTHER forbidden term
// (slug/stance/locale/lang/bill/summary/title/topic/query/citation) still
// applies unchanged — a caller's ZIP, bill slug, or search string must
// never reach a usage key. `version` added with the mcp-client handshake
// shape (2026-07): that family stores the client software's NAME only, by
// owner decision — a `${clientVersion}` (or any version) interpolation in
// a usage key is a violation.
const USAGE_CONTENT_IDENTIFIER = /slug|stance|locale|\blang\b|bill|summary|title|topic|query|citation|version/i;
// S19: the counters registry's SECOND identity shape (tenant-id-keyed,
// alongside the caller-hash-keyed one) must never fold caller material into
// the SAME interpolation as a tenant identifier — that would start building
// a per-visitor-within-tenant profile the product never asked for.
const TENANT_IDENTIFIER = /tenantId/;
// The domain-nomination registry's own extra rule (S15, F3): even the raw
// Referer/URL material it starts from must never make it into a template
// interpolation — the only interpolations that belong in that file's key
// builder are the already-truncated domain and a date bucket.
// `nexturl` named explicitly (site-counter, 2026-09): `\burl\b` cannot see
// it — there is no word boundary inside `req.nextUrl` — and NextRequest's
// nextUrl is exactly the object proxy.ts reads the pathname from, so it is
// the most likely spelling of this mistake in this repo, not a hypothetical.
const RAW_REFERER_MATERIAL = /referer|referrer|pathname|nexturl|\bhref\b|\bsearch\b|\burl\b/i;
// The pageview family's CANONICAL route-template vocabulary (site-counter,
// 2026-09). The gate holds this list, not lib/usage.ts, and lib/usage.ts's
// PAGEVIEW_SURFACES declaration is checked against it — so a new surface
// label is a deliberate edit to the privacy gate, reviewed as such, rather
// than one more string appended to an array. Every label is a route
// TEMPLATE: the shape of the page, never which page, never a path segment
// taken from a request.
// 'member' and 'today' added 2026-09-27 (the 2026-09-27 audit, SY-49): the
// member-page template (/reps/<id>) and the daily-brief template (/today,
// /today/<date>). Both were counted under 'other' until then.
const ALLOWED_PAGEVIEW_SURFACES = new Set([
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
  'other',
]);
// Matches lib/usage.ts's `export const PAGEVIEW_SURFACES = [ ... ]`. Kept
// deliberately literal (the constant's exact name, an array literal): a
// rename or a computed list stops matching, which the missing-declaration
// check below turns into a failure rather than a silent pass.
const PAGEVIEW_SURFACES_DECL = /PAGEVIEW_SURFACES\s*=\s*\[([\s\S]*?)\]/;
const PAGEVIEW_KEY_MARKER = 'usage:pageview:';
// The daily distinct-address family (owner ruling 2026-09-25). The ONE key
// shape it may ever have, as the exact source literal lib/ratelimit.ts's
// distinctAddressKey returns: the env prefix and the UTC day, nothing else.
// Deliberately literal, like PAGEVIEW_SURFACES_DECL — a rename of `day` or
// any extra segment stops matching, which is a failure rather than a pass.
const DISTINCT_KEY_LITERAL = '`${keyPrefix()}:uniques:${day}`';
const DISTINCT_KEY_MARKER = 'uniques:';
// HyperLogLog commands, as quoted command names in a command array.
const HLL_COMMAND = /['"`]PF(ADD|COUNT|MERGE)['"`]/i;
const HLL_MERGE = /['"`]PFMERGE['"`]/i;
// A PFADD command array, capturing everything after the command name.
const PFADD_ARRAY = /\[\s*['"`]PFADD['"`]\s*,([^\]]*)\]/gi;
// Raw-address material that must never be a PFADD element: the address
// variable itself (as a standalone identifier — `ip`, `address`, `addr`),
// callerIp(...), or anything read straight off the forwarding headers.
// Narrower than CALLER_MATERIAL on purpose — `callerHash(...)` and `salt`
// ARE the intended element, and `distinctAddressKey(day)` names the key
// (the standalone-identifier form is what keeps that call from matching).
const RAW_ADDRESS_ELEMENT = /(^|[^a-z])(ip|address|addr)([^a-z]|$)|callerip|forwarded|headers/i;
// The sketch's OWN day salt (hardened 2026-09-27). Same literal discipline as
// DISTINCT_KEY_LITERAL. The marker omits the trailing colon on purpose, so a
// concatenated `'uniques-salt' + ':'` is still seen.
const DISTINCT_SALT_KEY_LITERAL = '`${keyPrefix()}:uniques-salt:${day}`';
const DISTINCT_SALT_MARKER = 'uniques-salt';
// The only two names through which the day salt is reached.
const DISTINCT_SALT_ACCESSOR = /\bdistinctSaltKey\s*\(|\bdistinctDaySalt\s*\(/;
// The rate limiter's own salt and hash machinery. None of it may appear in a
// function that feeds the sketch or makes its salt or element.
const LIMITER_SALT_MATERIAL = /\bcallerHash\s*\(|\bcurrentSalt\s*\(|\bsaltKey\s*\(|\bparseSaltRecord\s*\(/;
// Commands allowed on the salt key: reads, a delete, and the two absolute
// writers (SET with NX + EXAT, EXPIREAT), both checked for their deadline.
const SALT_KEY_OPS_ALLOWED = new Set(['GET', 'TTL', 'PTTL', 'EXISTS', 'DEL', 'SET', 'EXPIREAT']);
// SET flags that would give the salt a relative or inherited lifetime.
const SALT_SET_FORBIDDEN_FLAGS = new Set(['EX', 'PX', 'PXAT', 'KEEPTTL']);
// distinctSaltExpiresAt's whole body, whitespace removed: the day's
// 00:00:00Z in unix seconds plus a product of integer literals. Anything
// else (a named constant, a second statement) is unverifiable and fails.
const SALT_DEADLINE_BODY = /^returnMath\.floor\(Date\.parse\(`\$\{day\}T00:00:00Z`\)\/1000\)\+(\d+(?:\*\d+)*);$/;
const ONE_DAY_SECONDS = 24 * 60 * 60;

/**
 * Top-level function declarations of a (comment-blanked) source text, each
 * with its full text up to the next line that starts with `}`. Not a parser:
 * it leans on this codebase's formatting, where only a top-level block
 * closes at column zero.
 */
function topLevelFunctions(code) {
  const out = [];
  const re = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm;
  let m;
  while ((m = re.exec(code)) !== null) {
    const close = code.indexOf('\n}', m.index);
    const end = close === -1 ? code.length : close + 2;
    const text = code.slice(m.index, end);
    const firstBreak = text.indexOf('\n');
    out.push({
      name: m[1],
      index: m.index,
      text,
      // Everything after the declaration line: the body, for "does this
      // function CALL x" questions that the signature itself must not answer.
      body: firstBreak === -1 ? '' : text.slice(firstBreak + 1),
    });
  }
  return out;
}

/** Split a comma-separated argument list at depth zero (parens, brackets, braces). */
function splitArgs(list) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

/** Every Redis command array (`['OP', arg, ...]`, OP upper-case) in a text. */
function commandArrays(text) {
  const out = [];
  const re = /\[\s*['"`]([A-Z][A-Z]+)['"`]\s*((?:,[^\]]*)?)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ op: m[1], args: splitArgs(m[2].replace(/^\s*,/, '')), index: m.index });
  }
  return out;
}

/** A command-array argument as a bare token: quotes stripped, upper-cased. */
function flagToken(arg) {
  return arg.replace(/^['"`]|['"`]$/g, '').toUpperCase();
}

/**
 * The source text with comments blanked out, line structure preserved, for
 * the distinct-address rules only (every older rule reads comments too, and
 * keeps doing so). Handles the two comment shapes this codebase writes —
 * whole-line `//` comments, block comments that open at the start of a line
 * (JSDoc and the section banners), and a trailing ` // note` after code —
 * without trying to be a tokenizer: a `/*` inside a string (an Accept
 * header's `image/*`, say) is never mistaken for a comment opener, because
 * only a line-leading one is honoured.
 */
function codeOnly(text) {
  let inBlock = false;
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (inBlock) {
        if (trimmed.includes('*/')) inBlock = false;
        return '';
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/', 2)) inBlock = true;
        return '';
      }
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return '';
      return line.replace(/\s\/\/\s.*$/, '');
    })
    .join('\n');
}

// The script-refusal family's CANONICAL scope vocabulary (2026-09-27, the
// 2026-09-27 audit, SY-48). Same arrangement as the pageview list above: the
// gate holds it, lib/usage.ts's SCRIPT_REFUSAL_SCOPES is checked against it.
// Every scope names one of /api/script's 429 GUARDS — never a caller, a
// tenant, a bill, or anything else a request carries.
const ALLOWED_SCRIPT_REFUSAL_SCOPES = new Set(['daily', 'burst', 'tenant']);
const SCRIPT_REFUSAL_SCOPES_DECL = /SCRIPT_REFUSAL_SCOPES\s*=\s*\[([\s\S]*?)\]/;
const SCRIPT_REFUSAL_KEY_MARKER = 'usage:script-refusal:';

/** Every ${...} interpolation inside template literals of a source text. */
function templateInterpolations(text) {
  const out = [];
  const re = /\$\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ expr: m[1], line });
  }
  return out;
}

/**
 * Every whole backtick-delimited template literal in a source text, as its
 * full text (every interpolation still inside, unlike templateInterpolations
 * above which flattens each `${...}` out on its own). Needed for rule 3b
 * below: a violation is two DIFFERENT interpolations — `${tenantId}` and
 * `${callerHash}` — combined in the SAME key-builder string, so checking
 * interpolations one at a time (as every other rule in this file does) can't
 * see the combination. Simple backtick-to-backtick match — this codebase's
 * key builders are single-line, unescaped, non-nested template literals by
 * convention (every existing one already is), so this doesn't need a real
 * parser.
 */
function templateLiterals(text) {
  const out = [];
  const re = /`[^`]*`/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ full: m[0], line });
  }
  return out;
}

/**
 * Rules 4f and 4g: a usage-registry key segment drawn from a closed label
 * list. Reads the DECLARATION rather than an interpolation — the segment is a
 * fixed label, so the thing worth gating is the set of labels that exists at
 * all. Two teeth: every declared label must be on the gate's own allowlist,
 * and a registry that writes the family's keys must carry a parsable
 * declaration (renaming the constant is a failure, not an escape).
 */
function checkClosedVocabulary(text, add, { rule, constName, decl: declRe, allowed, marker, offLabel }) {
  const decl = declRe.exec(text);
  const line = decl ? text.slice(0, decl.index).split('\n').length : 0;
  if (decl) {
    const labels = [...decl[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
    if (labels.length === 0) {
      add(rule, line, `${constName} declares no labels — the closed vocabulary cannot be checked`);
    }
    for (const label of labels) {
      if (!allowed.has(label)) add(rule, line, offLabel(label));
    }
  } else if (text.includes(marker)) {
    add(
      rule,
      0,
      `the usage registry writes ${marker} keys but declares no parsable ${constName} list — the closed vocabulary cannot be checked`
    );
  }
}

/**
 * Rule engine: scan one file's text, return violations.
 * Each violation: { rule, file, line, detail }.
 */
export function scanText(file, text) {
  const violations = [];
  const add = (rule, line, detail) => violations.push({ rule, file, line, detail });
  const lines = text.split('\n');

  // 1. env confinement: each database's env vars appear ONLY in the client
  //    module (which is also the only place a REST call is built).
  if (file !== CLIENT_MODULE) {
    lines.forEach((l, i) => {
      if (l.includes('UPSTASH_COUNTERS_REST')) {
        add('env-confinement', i + 1, `UPSTASH_COUNTERS_REST_* referenced outside ${CLIENT_MODULE}`);
      }
      if (l.includes('UPSTASH_CACHE_REST')) {
        add('env-confinement', i + 1, `UPSTASH_CACHE_REST_* referenced outside ${CLIENT_MODULE}`);
      }
      if (l.includes('UPSTASH_TENANCY_REST')) {
        add('env-confinement', i + 1, `UPSTASH_TENANCY_REST_* referenced outside ${CLIENT_MODULE}`);
      }
    });
  }

  // 2. client confinement: countersClient only in the four registries built
  //    on the counters database (rate-limit counters, domain nominations,
  //    impression counts, and usage counters), cacheClient only in the
  //    cache registry, tenancyClient only in the tenancy registry (plus
  //    their definitions in the client module itself). The Stripe webhook
  //    route must import functions FROM lib/tenancy.ts, never touch
  //    tenancyClient() directly — mirrors how app/api/script never touches
  //    cacheClient() directly.
  if (
    file !== CLIENT_MODULE &&
    file !== COUNTERS_REGISTRY &&
    file !== DOMAIN_REGISTRY &&
    file !== IMPRESSION_REGISTRY &&
    file !== USAGE_REGISTRY &&
    /\bcountersClient\b/.test(text)
  ) {
    add(
      'client-confinement',
      0,
      `countersClient used outside ${COUNTERS_REGISTRY}, ${DOMAIN_REGISTRY}, ${IMPRESSION_REGISTRY}, or ${USAGE_REGISTRY}`
    );
  }
  if (file !== CLIENT_MODULE && file !== CACHE_REGISTRY && /\bcacheClient\b/.test(text)) {
    add('client-confinement', 0, `cacheClient used outside ${CACHE_REGISTRY}`);
  }
  if (file !== CLIENT_MODULE && file !== TENANCY_REGISTRY && /\btenancyClient\b/.test(text)) {
    add('client-confinement', 0, `tenancyClient used outside ${TENANCY_REGISTRY}`);
  }

  // 3. counters keys carry no content: inside the counters registry, no
  //    template interpolation may mention a content identifier. Applied to
  //    every interpolation in the file — the registry is small on purpose.
  if (file === COUNTERS_REGISTRY) {
    for (const { expr, line } of templateInterpolations(text)) {
      if (CONTENT_IDENTIFIER.test(expr)) {
        add('counters-content', line, `content identifier "${expr.trim()}" interpolated in the counters registry`);
      }
    }
  }

  // 3b. tenant-keyed counters (S19) must never ALSO fold in caller material
  //     in the SAME key-builder string — e.g.
  //     `${route}:${tenantId}:${callerHash}`. Checked per WHOLE template
  //     literal (templateLiterals, not templateInterpolations) because the
  //     violation shape is two SEPARATE `${...}` interpolations combined in
  //     one key, not one interpolation expression containing both. A bare
  //     `${tenantId}` with no caller material anywhere in that same literal
  //     is the legitimate S19 shape and must NOT be flagged (that's rule 3's
  //     job, and tenantId doesn't match CONTENT_IDENTIFIER either — it's
  //     institutional "who", not content).
  if (file === COUNTERS_REGISTRY) {
    for (const { full, line } of templateLiterals(text)) {
      if (TENANT_IDENTIFIER.test(full) && CALLER_MATERIAL.test(full)) {
        add(
          'counters-tenant-caller-mix',
          line,
          `tenantId mixed with caller-derived material in one counters-registry key: ${full.trim()}`
        );
      }
    }
  }

  // 4. cache keys carry no caller material: mirror rule for the cache registry.
  if (file === CACHE_REGISTRY) {
    for (const { expr, line } of templateInterpolations(text)) {
      if (CALLER_MATERIAL.test(expr)) {
        add('cache-caller', line, `caller-derived material "${expr.trim()}" interpolated in the cache registry`);
      }
    }
  }

  // 4b. domain-nomination keys (S15, F3) carry neither content nor caller
  //     material, and never the raw referer/URL itself — three checks
  //     against the one file this ever applies to.
  if (file === DOMAIN_REGISTRY) {
    for (const { expr, line } of templateInterpolations(text)) {
      if (CONTENT_IDENTIFIER.test(expr)) {
        add(
          'domain-content',
          line,
          `content identifier "${expr.trim()}" interpolated in the domain-nomination registry`
        );
      }
      if (CALLER_MATERIAL.test(expr)) {
        add(
          'domain-caller',
          line,
          `caller-derived material "${expr.trim()}" interpolated in the domain-nomination registry`
        );
      }
      if (RAW_REFERER_MATERIAL.test(expr)) {
        add(
          'domain-raw-referer',
          line,
          `raw referer/URL material "${expr.trim()}" interpolated in the domain-nomination registry`
        );
      }
    }
  }

  // 4c. tenancy keys carry no caller material (S18): tenant config is
  //     institutional, not caller data, and must never blur into the
  //     caller-keyed doctrine either — mirrors rule 4's cache-caller check.
  if (file === TENANCY_REGISTRY) {
    for (const { expr, line } of templateInterpolations(text)) {
      if (CALLER_MATERIAL.test(expr)) {
        add('tenancy-caller', line, `caller-derived material "${expr.trim()}" interpolated in the tenancy registry`);
      }
    }
  }

  // 4d. impression keys (S20) carry no content identifier and no
  //     caller-derived material — mirrors rule 4b's domain-content/
  //     domain-caller checks. This family has no raw-referer input to guard
  //     against (unlike domain nominations, which start from a Referer
  //     header), so only two checks apply here, not three. A bare
  //     `${tenantId}` is the legitimate S20 shape and must NOT be flagged —
  //     tenantId matches neither CONTENT_IDENTIFIER nor CALLER_MATERIAL.
  if (file === IMPRESSION_REGISTRY) {
    for (const { expr, line } of templateInterpolations(text)) {
      if (CONTENT_IDENTIFIER.test(expr)) {
        add(
          'impression-content',
          line,
          `content identifier "${expr.trim()}" interpolated in the impression registry`
        );
      }
      if (CALLER_MATERIAL.test(expr)) {
        add(
          'impression-caller',
          line,
          `caller-derived material "${expr.trim()}" interpolated in the impression registry`
        );
      }
    }
  }

  // 4e. usage keys (traffic-watch, 2026-07) carry no content identifier
  //     (using the usage-specific list, which allows `tool`) and no
  //     caller-derived material — mirrors rule 4d's impression-content/
  //     impression-caller checks. A bare `${tool}` or `${day}` interpolation
  //     is the legitimate shape and must NOT be flagged.
  //     The pageview shape (site-counter, 2026-09) adds a THIRD check here,
  //     the same one the domain-nomination family already carries: this is
  //     the first usage shape whose input starts life as a URL, so the raw
  //     pathname/URL/query it is derived from must never reach a key either.
  if (file === USAGE_REGISTRY) {
    for (const { expr, line } of templateInterpolations(text)) {
      if (USAGE_CONTENT_IDENTIFIER.test(expr)) {
        add('usage-content', line, `content identifier "${expr.trim()}" interpolated in the usage registry`);
      }
      if (CALLER_MATERIAL.test(expr)) {
        add('usage-caller', line, `caller-derived material "${expr.trim()}" interpolated in the usage registry`);
      }
      if (RAW_REFERER_MATERIAL.test(expr)) {
        add('usage-raw-path', line, `raw path/URL material "${expr.trim()}" interpolated in the usage registry`);
      }
    }
  }

  // 4f. the pageview family's closed vocabulary (site-counter, 2026-09).
  //     Unlike every rule above, this one reads a DECLARATION rather than an
  //     interpolation: the surface segment is a fixed label, so the thing
  //     worth gating is the set of labels that exists at all. Two teeth —
  //     every declared label must be on this gate's own allowlist, and a
  //     registry that writes pageview keys must have a parsable declaration
  //     to check (renaming the constant is a failure, not an escape).
  if (file === USAGE_REGISTRY) {
    checkClosedVocabulary(text, add, {
      rule: 'pageview-surface',
      constName: 'PAGEVIEW_SURFACES',
      decl: PAGEVIEW_SURFACES_DECL,
      allowed: ALLOWED_PAGEVIEW_SURFACES,
      marker: PAGEVIEW_KEY_MARKER,
      offLabel: (label) =>
        `page-view surface "${label}" is not in the gate's allowlist — a surface label is a route TEMPLATE, never a path, slug, query, or locale`,
    });
  }

  // 4g. the script-refusal family's closed vocabulary (2026-09-27, SY-48).
  //     Rule 4f's two teeth, applied to the scope list: every declared scope
  //     is on this gate's allowlist, and refusal keys with no parsable
  //     declaration behind them fail.
  if (file === USAGE_REGISTRY) {
    checkClosedVocabulary(text, add, {
      rule: 'script-refusal-scope',
      constName: 'SCRIPT_REFUSAL_SCOPES',
      decl: SCRIPT_REFUSAL_SCOPES_DECL,
      allowed: ALLOWED_SCRIPT_REFUSAL_SCOPES,
      marker: SCRIPT_REFUSAL_KEY_MARKER,
      offLabel: (label) =>
        `script-refusal scope "${label}" is not in the gate's allowlist — a scope names one of /api/script's 429 guards, never a caller, tenant, or request content`,
    });
  }

  // 4g. the daily distinct-address sketch (owner ruling 2026-09-25): one
  //     key per UTC day, no dimension, built in one file, never fed a raw
  //     address. Read against codeOnly(text) — these rules police CODE, and
  //     the registry's own comments spell the shape out in prose.
  {
    const code = codeOnly(text);
    const lineOf = (index) => code.slice(0, index).split('\n').length;
    if (file === COUNTERS_REGISTRY) {
      // Every appearance of the family marker must sit inside the canonical
      // literal — anything else (an extra segment, a concatenated string, a
      // second builder) is a stray.
      const markerOffset = DISTINCT_KEY_LITERAL.indexOf(DISTINCT_KEY_MARKER);
      for (let at = code.indexOf(DISTINCT_KEY_MARKER); at !== -1; at = code.indexOf(DISTINCT_KEY_MARKER, at + 1)) {
        if (code.startsWith(DISTINCT_KEY_LITERAL, at - markerOffset)) continue;
        add(
          'distinct-shape',
          lineOf(at),
          `the daily distinct-address key is built as something other than ${DISTINCT_KEY_LITERAL} — one key per UTC day, never a route, page, surface, bill, or locale dimension`
        );
      }
      const merge = HLL_MERGE.exec(code);
      if (merge) {
        add('distinct-shape', lineOf(merge.index), 'PFMERGE would build a multi-day distinct-address sketch — one sketch per UTC day, never combined');
      }
      for (const m of code.matchAll(PFADD_ARRAY)) {
        // distinctAddressElement(address, daySalt) inline IS the salted
        // element — its own arguments are the one place the address may
        // appear. (callerHash is no longer exempted, 2026-09-27: the sketch
        // does not use the limiter's hash, and distinct-salt-separation says
        // so; an inline callerHash(ip, ...) is caught here too.)
        const elements = m[1].replace(/distinctAddressElement\([^)]*\)/g, 'HASHED');
        if (RAW_ADDRESS_ELEMENT.test(elements)) {
          add(
            'distinct-raw-address',
            lineOf(m.index),
            `a PFADD element carries raw-address material ("${m[1].trim()}") — only the salted caller hash may be added`
          );
        }
      }
    } else {
      const marker = code.indexOf(DISTINCT_KEY_MARKER);
      if (marker !== -1) {
        add(
          'distinct-confinement',
          lineOf(marker),
          `the daily distinct-address key family is referenced outside ${COUNTERS_REGISTRY}`
        );
      }
      const hll = HLL_COMMAND.exec(code);
      if (hll) {
        add(
          'distinct-confinement',
          lineOf(hll.index),
          `a HyperLogLog command is used outside ${COUNTERS_REGISTRY} — the site has exactly one sketch family, and it lives there`
        );
      }
    }
  }

  // 4h. the sketch's OWN day salt (hardened 2026-09-27, owner decision
  //     "2. b"): one key per UTC day, reachable only from the registry, dead
  //     at or before the end of its UTC day and never extended, and never
  //     mixed with the rate limiter's salt or hash. Code-only, like 4g.
  {
    const code = codeOnly(text);
    const lineOf = (index) => code.slice(0, index).split('\n').length;
    if (file === COUNTERS_REGISTRY) {
      // distinct-salt-shape: every appearance of the salt marker sits inside
      // the canonical literal.
      const markerOffset = DISTINCT_SALT_KEY_LITERAL.indexOf(DISTINCT_SALT_MARKER);
      let saltFamilyUsed = false;
      for (let at = code.indexOf(DISTINCT_SALT_MARKER); at !== -1; at = code.indexOf(DISTINCT_SALT_MARKER, at + 1)) {
        saltFamilyUsed = true;
        if (code.startsWith(DISTINCT_SALT_KEY_LITERAL, at - markerOffset)) continue;
        add(
          'distinct-salt-shape',
          lineOf(at),
          `the distinct-address salt key is built as something other than ${DISTINCT_SALT_KEY_LITERAL} — one salt per UTC day, no other segment`
        );
      }

      const fns = topLevelFunctions(code);

      // distinct-salt-expiry (a): the deadline function's own arithmetic.
      if (saltFamilyUsed) {
        const deadlineFn = fns.find((f) => f.name === 'distinctSaltExpiresAt');
        const body = deadlineFn ? deadlineFn.body.replace(/\n\}$/, '').replace(/\s+/g, '') : '';
        const parsed = SALT_DEADLINE_BODY.exec(body);
        if (!deadlineFn) {
          add(
            'distinct-salt-expiry',
            0,
            'the distinct-address salt family is used but distinctSaltExpiresAt is not defined — its end-of-day deadline cannot be checked'
          );
        } else if (!parsed) {
          add(
            'distinct-salt-expiry',
            lineOf(deadlineFn.index),
            'distinctSaltExpiresAt is not `return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + <integer literals>;` — the salt\'s deadline cannot be verified to fall at or before the end of its UTC day'
          );
        } else {
          const offset = parsed[1].split('*').reduce((acc, n) => acc * Number(n), 1);
          if (offset > ONE_DAY_SECONDS) {
            add(
              'distinct-salt-expiry',
              lineOf(deadlineFn.index),
              `distinctSaltExpiresAt adds ${offset}s to the day's 00:00:00Z — the salt must die at or before the end of its UTC day (${ONE_DAY_SECONDS}s)`
            );
          }
        }
      }

      for (const fn of fns) {
        // distinct-salt-expiry (b): every command on the salt key, inside
        // every function that reaches it.
        if (/\bdistinctSaltKey\s*\(/.test(fn.body)) {
          const aliases = new Set([...fn.body.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*distinctSaltKey\s*\(/g)].map((a) => a[1]));
          for (const cmd of commandArrays(fn.text)) {
            const keyArg = cmd.args[0] ?? '';
            if (!aliases.has(keyArg) && !/^distinctSaltKey\s*\(/.test(keyArg)) continue;
            const line = lineOf(fn.index + cmd.index);
            if (!SALT_KEY_OPS_ALLOWED.has(cmd.op)) {
              add(
                'distinct-salt-expiry',
                line,
                `${cmd.op} on the distinct-address salt key — only reads, DEL, SET NX with EXAT, or EXPIREAT at distinctSaltExpiresAt(...) may touch it (never a relative expiry, PERSIST, or another writer)`
              );
              continue;
            }
            if (cmd.op === 'SET') {
              const flags = cmd.args.slice(2).map(flagToken);
              const exatAt = flags.indexOf('EXAT');
              const deadlineArg = exatAt === -1 ? '' : (cmd.args[2 + exatAt + 1] ?? '');
              const forbidden = flags.filter((f) => SALT_SET_FORBIDDEN_FLAGS.has(f));
              if (!flags.includes('NX') || exatAt === -1 || !/\bdistinctSaltExpiresAt\s*\(/.test(deadlineArg) || forbidden.length > 0) {
                add(
                  'distinct-salt-expiry',
                  line,
                  `the distinct-address salt is SET without NX + EXAT at distinctSaltExpiresAt(...)${forbidden.length ? ` (found ${forbidden.join(', ')})` : ''} — it must be born with its end-of-day deadline and never replaced`
                );
              }
            }
            if (cmd.op === 'EXPIREAT' && !/\bdistinctSaltExpiresAt\s*\(/.test(cmd.args[1] ?? '')) {
              add(
                'distinct-salt-expiry',
                line,
                `EXPIREAT on the distinct-address salt key with a deadline other than distinctSaltExpiresAt(...) ("${(cmd.args[1] ?? '').trim()}") — that could carry it past the end of its UTC day`
              );
            }
          }
        }

        // distinct-salt-separation: a function that feeds the sketch, makes
        // its day salt, or makes its element never touches the limiter's
        // salt or hash.
        const feedsSketch = commandArrays(fn.text).some((c) => c.op === 'PFADD');
        const makesSalt = /\bdistinctSaltKey\s*\(/.test(fn.body) || fn.name === 'distinctDaySalt';
        const makesElement = fn.name === 'distinctAddressElement';
        if (feedsSketch || makesSalt || makesElement) {
          const hit = LIMITER_SALT_MATERIAL.exec(fn.body);
          if (hit) {
            add(
              'distinct-salt-separation',
              lineOf(fn.index + fn.text.indexOf('\n') + 1 + hit.index),
              `${fn.name} uses the rate limiter's salt or hash ("${hit[0].replace(/\s*\($/, '')}") — the distinct-address sketch has its own day salt, and the limiter's lives 24h from creation, past the end of the UTC day`
            );
          }
        }
      }
    } else {
      const marker = code.indexOf(DISTINCT_SALT_MARKER);
      if (marker !== -1) {
        add(
          'distinct-salt-confinement',
          lineOf(marker),
          `the distinct-address salt key family is referenced outside ${COUNTERS_REGISTRY}`
        );
      }
      const accessor = DISTINCT_SALT_ACCESSOR.exec(code);
      if (accessor) {
        add(
          'distinct-salt-confinement',
          lineOf(accessor.index),
          `the distinct-address day salt is reached outside ${COUNTERS_REGISTRY} ("${accessor[0].replace(/\s*\($/, '')}") — nothing else may read it while it lives`
        );
      }
    }
  }

  // 5. request-shape invariant: content identifiers never travel in a
  //    caller-originating URL query string to /api/script or /api/mcp
  //    (POST bodies only — the district route's house rule). Two teeth:
  //    (a) no code anywhere builds such a URL;
  lines.forEach((l, i) => {
    if (/\/api\/(script|mcp)[^\s'"`]*\?[^\s'"`]*(slug|stance|locale|lang|bill|topic|query)=/i.test(l)) {
      add('request-shape', i + 1, 'content identifier in a caller-originating /api/script|/api/mcp query string');
    }
  });
  //    (b) the dynamic routes never read a query string at all.
  if (/^app\/api\/(script|district|feedback|mcp)\//.test(file)) {
    lines.forEach((l, i) => {
      if (/searchParams\.get\(|\bnextUrl\b/.test(l)) {
        add('request-shape', i + 1, 'dynamic route reads a caller-originating query string');
      }
    });
  }

  // 6. vocabulary discipline: never "anonymized"/"anonymised" — these are
  //    short-lived rate-limit counters (pseudonymous), and the code doesn't
  //    get to overclaim.
  lines.forEach((l, i) => {
    if (/anonymi[sz]/i.test(l)) {
      add('vocabulary', i + 1, '"anonymized" claimed — say "short-lived rate-limit counters" (pseudonymization)');
    }
  });

  return violations;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (EXTENSIONS.some((e) => full.endsWith(e))) out.push(full);
  }
  return out;
}

function scanRepo() {
  const files = [];
  for (const dir of SCAN_DIRS) files.push(...walk(join(ROOT, dir)));
  for (const f of SCAN_ROOT_FILES) {
    try {
      statSync(join(ROOT, f));
      files.push(join(ROOT, f));
    } catch {
      /* optional root file absent */
    }
  }
  const violations = [];
  for (const full of files) {
    const rel = relative(ROOT, full).replaceAll('\\', '/');
    violations.push(...scanText(rel, readFileSync(full, 'utf8')));
  }
  return violations;
}

// The real, compliant salt-deadline function, prefixed onto fixtures whose
// seeded violation is somewhere else — so each one fails for its OWN reason,
// not merely because the deadline function is missing.
const SALT_DEADLINE_FN =
  'export function distinctSaltExpiresAt(day: string): number {\n' +
  '  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + 24 * 60 * 60;\n' +
  '}\n';

// Seeded violations: every rule must catch its fixture or the gate is broken.
const SELF_TEST_FIXTURES = [
  {
    name: 'stance interpolated into a counters key',
    file: COUNTERS_REGISTRY,
    text: 'const k = `${keyPrefix()}:rl:${route}:${stance}:${hash}`;',
    rule: 'counters-content',
  },
  {
    name: 'bill slug interpolated into a counters key',
    file: COUNTERS_REGISTRY,
    text: 'const k = `${keyPrefix()}:rl:${opts.route}:${slug}`;',
    rule: 'counters-content',
  },
  {
    // The 'reps' route label's own hazard (fix/api-reps-rate-limit): the ZIP
    // /api/reps reads must never become a counter-key segment. Seeded so the
    // CONTENT_IDENTIFIER addition above stays tested, not trusted.
    name: 'a ZIP interpolated into a counters key',
    file: COUNTERS_REGISTRY,
    text: 'const k = `${keyPrefix()}:rl:${opts.route}:${zip}:${callerHash}`;',
    rule: 'counters-content',
  },
  {
    name: 'caller hash interpolated into a cache key',
    file: CACHE_REGISTRY,
    text: 'const k = `${keyPrefix()}:script:${parts.slug}:${callerHash}`;',
    rule: 'cache-caller',
  },
  {
    name: 'salt interpolated into a cache key',
    file: CACHE_REGISTRY,
    text: 'const k = `${keyPrefix()}:script:${salt}:${parts.slug}`;',
    rule: 'cache-caller',
  },
  {
    name: 'content identifier in a caller-originating query string',
    file: 'app/[locale]/bills/[slug]/call-panel.tsx',
    text: "await fetch(`/api/script?slug=${slug}&stance=support`);",
    rule: 'request-shape',
  },
  {
    name: 'dynamic route reading a query string',
    file: 'app/api/script/route.ts',
    text: "const stance = req.nextUrl.searchParams.get('stance');",
    rule: 'request-shape',
  },
  {
    name: 'counters env var outside the client module',
    file: 'app/api/script/route.ts',
    text: 'const url = process.env.UPSTASH_COUNTERS_REST_URL;',
    rule: 'env-confinement',
  },
  {
    name: 'cache client used outside the cache registry',
    file: 'app/api/feedback/route.ts',
    text: "import { cacheClient } from '@/lib/upstash';",
    rule: 'client-confinement',
  },
  {
    name: '"anonymized" overclaim in a comment',
    file: COUNTERS_REGISTRY,
    text: '// counters are fully anonymized',
    rule: 'vocabulary',
  },
  {
    name: 'bill slug interpolated into a domain-nomination key',
    file: DOMAIN_REGISTRY,
    text: 'const k = `${keyPrefix()}:embed-domain:${day}:${slug}`;',
    rule: 'domain-content',
  },
  {
    name: 'caller IP interpolated into a domain-nomination key',
    file: DOMAIN_REGISTRY,
    text: 'const k = `${keyPrefix()}:embed-domain:${day}:${ip}`;',
    rule: 'domain-caller',
  },
  {
    name: 'the raw (untruncated) referer interpolated into a domain-nomination key',
    file: DOMAIN_REGISTRY,
    text: 'const k = `${keyPrefix()}:embed-domain:${day}:${referer}`;',
    rule: 'domain-raw-referer',
  },
  {
    name: 'countersClient used outside any allowed registry (embed layout)',
    file: 'app/embed/layout.tsx',
    text: "import { countersClient } from '@/lib/upstash';",
    rule: 'client-confinement',
  },
  {
    name: 'caller hash interpolated into a tenancy key',
    file: TENANCY_REGISTRY,
    text: 'const k = `${keyPrefix()}:tenant:${callerHash}`;',
    rule: 'tenancy-caller',
  },
  {
    name: 'caller IP interpolated into a tenancy key',
    file: TENANCY_REGISTRY,
    text: 'const k = `${keyPrefix()}:token:${ip}`;',
    rule: 'tenancy-caller',
  },
  {
    name: 'tenancy env var outside the client module',
    file: 'app/api/stripe/webhook/route.ts',
    text: 'const url = process.env.UPSTASH_TENANCY_REST_URL;',
    rule: 'env-confinement',
  },
  {
    name: 'tenancyClient used outside the tenancy registry (webhook route)',
    file: 'app/api/stripe/webhook/route.ts',
    text: "import { tenancyClient } from '@/lib/upstash';",
    rule: 'client-confinement',
  },
  {
    name: 'tenantId mixed with a caller hash in one counters-registry interpolation (S19)',
    file: COUNTERS_REGISTRY,
    text: 'const k = `${keyPrefix()}:rl:${opts.route}:${tenantId}:${callerHash}`;',
    rule: 'counters-tenant-caller-mix',
  },
  {
    name: 'tenantId mixed with a raw caller IP in one counters-registry interpolation (S19)',
    file: COUNTERS_REGISTRY,
    text: 'const k = `${keyPrefix()}:rl:${opts.route}:${tenantId + ip}`;',
    rule: 'counters-tenant-caller-mix',
  },
  {
    name: 'caller IP interpolated into an impression key (S20)',
    file: IMPRESSION_REGISTRY,
    text: 'const k = `${keyPrefix()}:imp:${tenantId}:${ip}`;',
    rule: 'impression-caller',
  },
  {
    name: 'bill slug interpolated into an impression key (S20)',
    file: IMPRESSION_REGISTRY,
    text: 'const k = `${keyPrefix()}:imp:${slug}:${day}`;',
    rule: 'impression-content',
  },
  {
    name: 'bill slug interpolated into a usage key (traffic-watch)',
    file: USAGE_REGISTRY,
    text: 'const k = `${keyPrefix()}:usage:mcp:${tool}:${slug}`;',
    rule: 'usage-content',
  },
  {
    name: 'caller IP interpolated into a usage key (traffic-watch)',
    file: USAGE_REGISTRY,
    text: 'const k = `${keyPrefix()}:usage:mcp:${tool}:${ip}`;',
    rule: 'usage-caller',
  },
  {
    name: 'User-Agent material interpolated into an mcp-client usage key (2026-07)',
    file: USAGE_REGISTRY,
    text: 'const k = `${keyPrefix()}:usage:mcp-client:${userAgent}:${day}`;',
    rule: 'usage-caller',
  },
  {
    name: 'client version interpolated into an mcp-client usage key (software name only, 2026-07)',
    file: USAGE_REGISTRY,
    text: 'const k = `${keyPrefix()}:usage:mcp-client:${client}:${clientVersion}:${day}`;',
    rule: 'usage-content',
  },
  {
    // The hazard this family is built around: the label is DERIVED from a
    // path, so the path itself must never take the label's place.
    name: 'the raw request pathname interpolated into a page-view key (site-counter)',
    file: USAGE_REGISTRY,
    text: 'const k = `${keyPrefix()}:usage:pageview:${pathname}:${day}`;',
    rule: 'usage-raw-path',
  },
  {
    name: 'the raw request URL interpolated into a page-view key (site-counter)',
    file: USAGE_REGISTRY,
    text: 'const k = `${keyPrefix()}:usage:pageview:${req.nextUrl}:${day}`;',
    rule: 'usage-raw-path',
  },
  {
    name: 'a page-view surface label that is a path, not a route template (site-counter)',
    file: USAGE_REGISTRY,
    text: "const PAGEVIEW_SURFACES = ['home', '/bills/hr-1234'] as const;",
    rule: 'pageview-surface',
  },
  {
    name: 'a page-view surface label outside the gate allowlist (site-counter)',
    file: USAGE_REGISTRY,
    text: "const PAGEVIEW_SURFACES = ['home', 'bill', 'visitor-id'] as const;",
    rule: 'pageview-surface',
  },
  {
    name: 'page-view keys written with no parsable surface declaration to check (site-counter)',
    file: USAGE_REGISTRY,
    text: 'const k = `${keyPrefix()}:usage:pageview:${surface}:${day}`;',
    rule: 'pageview-surface',
  },
  {
    // The hazard the whole family is built around: a route dimension. Rule 3
    // (counters-content) cannot see this one — `route` is not a content
    // identifier anywhere else in this registry — which is why distinct-shape
    // exists.
    name: 'a route label folded into the daily distinct-address key (2026-09-25)',
    file: COUNTERS_REGISTRY,
    text: 'const k = `${keyPrefix()}:uniques:${route}:${day}`;',
    rule: 'distinct-shape',
  },
  {
    name: 'a per-page-surface distinct-address sketch (2026-09-25)',
    file: COUNTERS_REGISTRY,
    text: 'const k = `${keyPrefix()}:uniques:${day}:${surface}`;',
    rule: 'distinct-shape',
  },
  {
    name: 'the distinct-address key assembled by string concatenation, dodging the literal (2026-09-25)',
    file: COUNTERS_REGISTRY,
    text: "const k = keyPrefix() + ':uniques:' + day + ':' + page;",
    rule: 'distinct-shape',
  },
  {
    name: 'a multi-day sketch via PFMERGE (2026-09-25)',
    file: COUNTERS_REGISTRY,
    text: "await client.cmd(['PFMERGE', weekKey, distinctAddressKey(a), distinctAddressKey(b)]);",
    rule: 'distinct-shape',
  },
  {
    name: 'the raw address added to the sketch instead of its salted hash (2026-09-25)',
    file: COUNTERS_REGISTRY,
    text: "await client.cmd(['PFADD', distinctAddressKey(day), ip]);",
    rule: 'distinct-raw-address',
  },
  {
    name: 'the trimmed address variable added to the sketch raw (2026-09-25)',
    file: COUNTERS_REGISTRY,
    text: "await client.cmd(['PFADD', distinctAddressKey(day), address]);",
    rule: 'distinct-raw-address',
  },
  {
    name: 'a forwarding header added to the sketch raw (2026-09-25)',
    file: COUNTERS_REGISTRY,
    text: "await client.cmd(['PFADD', key, req.headers.get('x-forwarded-for')]);",
    rule: 'distinct-raw-address',
  },
  {
    name: 'a per-page distinct-address sketch built in the usage registry (2026-09-25)',
    file: USAGE_REGISTRY,
    text: 'const k = `${keyPrefix()}:uniques:${asPageviewSurface(surface)}:${day}`;',
    rule: 'distinct-confinement',
  },
  {
    name: 'a HyperLogLog command outside the counters registry (2026-09-25)',
    file: 'lib/usage.ts',
    text: "await client.cmd(['PFADD', pageviewUsageKey(surface, day), hash]);",
    rule: 'distinct-confinement',
  },
  {
    name: 'a per-bill sketch in a page component (2026-09-25)',
    file: 'app/[locale]/bills/[slug]/page.tsx',
    text: "await counters.cmd(['PFADD', `uniques:bills/${slug}`, hash]);",
    rule: 'distinct-confinement',
  },
  // --- the sketch's own day salt (hardened 2026-09-27) ---
  {
    name: 'a route folded into the day-salt key (2026-09-27)',
    file: COUNTERS_REGISTRY,
    text: SALT_DEADLINE_FN + 'const k = `${keyPrefix()}:uniques-salt:${day}:${route}`;',
    rule: 'distinct-salt-shape',
  },
  {
    name: 'the day-salt key assembled by concatenation, dodging the literal (2026-09-27)',
    file: COUNTERS_REGISTRY,
    text: SALT_DEADLINE_FN + "const k = keyPrefix() + ':uniques-salt' + ':' + day;",
    rule: 'distinct-salt-shape',
  },
  {
    name: 'the day salt read from the usage registry (2026-09-27)',
    file: USAGE_REGISTRY,
    text: "const s = await client.cmd(['GET', `${keyPrefix()}:uniques-salt:${day}`]);",
    rule: 'distinct-salt-confinement',
  },
  {
    name: 'a route handler reaching the day salt through its accessor (2026-09-27)',
    file: 'app/api/reps/route.ts',
    text: 'const k = distinctSaltKey(day);',
    rule: 'distinct-salt-confinement',
  },
  {
    name: 'the day salt created with a relative 24h EX — it would outlive its UTC day (2026-09-27)',
    file: COUNTERS_REGISTRY,
    text:
      SALT_DEADLINE_FN +
      'async function distinctDaySalt(client, day) {\n' +
      '  const key = distinctSaltKey(day);\n' +
      "  await client.cmd(['SET', key, fresh, 'NX', 'EX', String(86400)]);\n" +
      '}',
    rule: 'distinct-salt-expiry',
  },
  {
    name: 'the day salt created with no expiry at all (2026-09-27)',
    file: COUNTERS_REGISTRY,
    text:
      SALT_DEADLINE_FN +
      'async function distinctDaySalt(client, day) {\n' +
      "  await client.cmd(['SET', distinctSaltKey(day), fresh, 'NX']);\n" +
      '}',
    rule: 'distinct-salt-expiry',
  },
  {
    name: 'the day salt re-set without NX (a mid-day overwrite with KEEPTTL) (2026-09-27)',
    file: COUNTERS_REGISTRY,
    text:
      SALT_DEADLINE_FN +
      'async function distinctDaySalt(client, day) {\n' +
      '  const key = distinctSaltKey(day);\n' +
      "  await client.cmd(['SET', key, fresh, 'KEEPTTL']);\n" +
      '}',
    rule: 'distinct-salt-expiry',
  },
  {
    name: 'the day salt extended with a relative EXPIRE (2026-09-27)',
    file: COUNTERS_REGISTRY,
    text:
      SALT_DEADLINE_FN +
      'async function distinctDaySalt(client, day) {\n' +
      '  const key = distinctSaltKey(day);\n' +
      "  await client.cmd(['SET', key, fresh, 'NX', 'EXAT', String(distinctSaltExpiresAt(day))]);\n" +
      "  await client.cmd(['EXPIRE', key, '172800']);\n" +
      '}',
    rule: 'distinct-salt-expiry',
  },
  {
    name: "the day salt given the SKETCH's 48h-grace deadline via EXPIREAT (2026-09-27)",
    file: COUNTERS_REGISTRY,
    text:
      SALT_DEADLINE_FN +
      'async function distinctDaySalt(client, day) {\n' +
      '  const saltAt = distinctSaltKey(day);\n' +
      "  await client.cmd(['EXPIREAT', saltAt, String(distinctAddressExpiresAt(day))]);\n" +
      '}',
    rule: 'distinct-salt-expiry',
  },
  {
    name: 'the day salt made permanent with PERSIST (2026-09-27)',
    file: COUNTERS_REGISTRY,
    text:
      SALT_DEADLINE_FN +
      'async function distinctDaySalt(client, day) {\n' +
      "  await client.cmd(['PERSIST', distinctSaltKey(day)]);\n" +
      '}',
    rule: 'distinct-salt-expiry',
  },
  {
    name: 'the salt deadline given a grace period past the end of its UTC day (2026-09-27)',
    file: COUNTERS_REGISTRY,
    text:
      'export function distinctSaltExpiresAt(day: string): number {\n' +
      '  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + 48 * 60 * 60;\n' +
      '}\n' +
      'const k = `${keyPrefix()}:uniques-salt:${day}`;',
    rule: 'distinct-salt-expiry',
  },
  {
    name: 'the salt deadline built from a named constant the gate cannot check (2026-09-27)',
    file: COUNTERS_REGISTRY,
    text:
      'export function distinctSaltExpiresAt(day: string): number {\n' +
      '  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + 24 * 60 * 60 + DISTINCT_ADDRESS_GRACE_SECONDS;\n' +
      '}\n' +
      'const k = `${keyPrefix()}:uniques-salt:${day}`;',
    rule: 'distinct-salt-expiry',
  },
  {
    name: 'the salt family used with no deadline function at all (2026-09-27)',
    file: COUNTERS_REGISTRY,
    text: 'const k = `${keyPrefix()}:uniques-salt:${day}`;',
    rule: 'distinct-salt-expiry',
  },
  {
    name: "the sketch fed the rate limiter's hash and salt again (2026-09-27)",
    file: COUNTERS_REGISTRY,
    text:
      'export async function noteDistinctAddress(ip, now) {\n' +
      '  const element = callerHash(address, await currentSalt(client));\n' +
      "  await client.cmd(['PFADD', key, element]);\n" +
      '}',
    rule: 'distinct-salt-separation',
  },
  {
    name: "the day salt derived from the rate limiter's salt record (2026-09-27)",
    file: COUNTERS_REGISTRY,
    text:
      SALT_DEADLINE_FN +
      'async function distinctDaySalt(client, day) {\n' +
      '  const key = distinctSaltKey(day);\n' +
      "  const base = await client.cmd(['GET', saltKey()]);\n" +
      '}',
    rule: 'distinct-salt-separation',
  },
  {
    name: "the sketch element delegating to the rate limiter's hash (2026-09-27)",
    file: COUNTERS_REGISTRY,
    text:
      'export function distinctAddressElement(address: string, daySalt: string): string {\n' +
      '  return callerHash(address, daySalt);\n' +
      '}',
    rule: 'distinct-salt-separation',
  },
  {
    // The member-page label is the TEMPLATE; the member id it replaced in the
    // path must never become a label of its own (SY-49).
    name: 'a page-view surface label that is a member id, not the member template (2026-09-27)',
    file: USAGE_REGISTRY,
    text: "const PAGEVIEW_SURFACES = ['home', 'member', 'A000370'] as const;",
    rule: 'pageview-surface',
  },
  {
    name: 'a script-refusal scope outside the gate allowlist (2026-09-27)',
    file: USAGE_REGISTRY,
    text: "const SCRIPT_REFUSAL_SCOPES = ['daily', 'burst', 'hr-1234-119'] as const;",
    rule: 'script-refusal-scope',
  },
  {
    name: 'script-refusal keys written with no parsable scope declaration to check (2026-09-27)',
    file: USAGE_REGISTRY,
    text: 'const k = `${keyPrefix()}:usage:script-refusal:${scope}:${day}`;',
    rule: 'script-refusal-scope',
  },
  {
    // The scope names a guard; the caller that guard refused must never ride
    // along in the same key.
    name: 'a caller hash interpolated into a script-refusal key (2026-09-27)',
    file: USAGE_REGISTRY,
    text: 'const k = `${keyPrefix()}:usage:script-refusal:${asScriptRefusalScope(scope)}:${callerHash}:${day}`;',
    rule: 'usage-caller',
  },
];

// A clean sample must produce zero violations (guards against a gate that
// flags everything and gets ignored).
const SELF_TEST_CLEAN = [
  {
    file: COUNTERS_REGISTRY,
    text: 'const k = `${keyPrefix()}:rl:${opts.route}:${callerHash(ip, salt)}`;',
  },
  {
    file: CACHE_REGISTRY,
    text: 'const k = `${keyPrefix()}:script:${parts.slug}:${parts.stance}:${parts.lang}:${parts.version}`;',
  },
  {
    // The legitimate S19 tenant-keyed counter shape: a bare tenantId, no
    // caller material folded in — proves rule 3b doesn't false-positive on
    // the real createTenantRateLimiter usage (counterKey(route, tenantId)).
    file: COUNTERS_REGISTRY,
    text: 'const k = `${keyPrefix()}:rl:${opts.route}:${tenantId}`;',
  },
  {
    // Proves countersClient is allowed in the domain registry too (rule 2
    // must not flag its own intended use), and that a proper
    // domain+day-only key builder produces zero violations.
    file: DOMAIN_REGISTRY,
    text: "import { countersClient } from './upstash';\nconst k = `${keyPrefix()}:embed-domain:${day}:${domain}`;",
  },
  {
    // Proves tenancyClient is allowed in its own registry (rule 2 must not
    // flag its own intended use), and that the real tenant/token/
    // stripe-event key builders produce zero violations.
    file: TENANCY_REGISTRY,
    text:
      "import { tenancyClient } from './upstash';\n" +
      'const a = `${keyPrefix()}:tenant:${tenantId}`;\n' +
      'const b = `${keyPrefix()}:token:${hash}`;\n' +
      'const c = `${keyPrefix()}:stripe-event:${eventId}`;',
  },
  {
    // Proves countersClient is allowed in the impression registry too (rule
    // 2 must not flag its own intended use), and that the real
    // imp:${tenantId}:${day} shape produces zero violations.
    file: IMPRESSION_REGISTRY,
    text: "import { countersClient } from './upstash';\nconst k = `${keyPrefix()}:imp:${tenantId}:${day}`;",
  },
  {
    // Proves countersClient is allowed in the usage registry too (rule 2
    // must not flag its own intended use), and that the real
    // usage:mcp:${tool}:${day} shape produces zero violations — `tool` is
    // the deliberate carve-out this registry alone permits.
    file: USAGE_REGISTRY,
    text: "import { countersClient } from './upstash';\nconst k = `${keyPrefix()}:usage:mcp:${tool}:${day}`;",
  },
  {
    // The real usage:script:${day} shape (no `tool` segment at all).
    file: USAGE_REGISTRY,
    text: 'const k = `${keyPrefix()}:usage:script:${day}`;',
  },
  {
    // The real mcp-client handshake shape (2026-07), exactly as
    // lib/usage.ts's mcpClientUsageKey builds it — the sanitizer call is
    // part of the interpolation on purpose (structural sanitization) and
    // must not false-positive against any rule.
    file: USAGE_REGISTRY,
    text: 'const k = `${keyPrefix()}:usage:mcp-client:${sanitizeMcpClientName(client)}:${day}`;',
  },
  {
    // The real page-view shape (site-counter, 2026-09), declaration and key
    // builder together, exactly as lib/usage.ts ships them — the closed
    // vocabulary on the allowlist, and the structural narrowing call inside
    // the interpolation. Must produce zero violations across all four usage
    // rules, including the missing-declaration tooth.
    file: USAGE_REGISTRY,
    text:
      "const PAGEVIEW_SURFACES = ['home', 'bills-index', 'bill', 'questions-index', 'question', 'reps', 'member', 'record', 'nominations', 'today', 'other'] as const;\n" +
      'const k = `${keyPrefix()}:usage:pageview:${asPageviewSurface(surface)}:${day}`;',
  },
  {
    // The real daily distinct-address shape (2026-09-25, hardened
    // 2026-09-27), as lib/ratelimit.ts ships it: both canonical key
    // literals, the compliant salt deadline, the day salt born with SET NX +
    // EXAT and otherwise only read, the element built from that salt, the
    // sketch's own absolute deadline, the digest's PFCOUNT, and doc comments
    // that spell the shapes out in prose (including the limiter's names,
    // which comments may mention). Must produce zero violations across every
    // rule, including rule 3.
    file: COUNTERS_REGISTRY,
    text:
      '/**\n * Key: <env>:uniques:<YYYY-MM-DD>, one per UTC day, with a :uniques:route shape never allowed.\n */\n' +
      'export function distinctAddressKey(day: string): string {\n' +
      '  return `${keyPrefix()}:uniques:${day}`;\n' +
      '}\n' +
      '/** Salt: <env>:uniques-salt:<day>, never callerHash() or currentSalt(). */\n' +
      'export function distinctSaltKey(day: string): string {\n' +
      '  return `${keyPrefix()}:uniques-salt:${day}`;\n' +
      '}\n' +
      SALT_DEADLINE_FN +
      'export function distinctAddressElement(address: string, daySalt: string): string {\n' +
      "  return createHash('sha256').update(daySalt + address).digest('hex');\n" +
      '}\n' +
      'async function distinctDaySalt(client: UpstashClient, day: string, nowMs: number): Promise<string> {\n' +
      '  const key = distinctSaltKey(day);\n' +
      "  const existing = await client.cmd(['GET', key]);\n" +
      "  const created = await client.cmd(['SET', key, fresh, 'NX', 'EXAT', String(distinctSaltExpiresAt(day))]);\n" +
      "  const raced = await client.cmd(['GET', key]);\n" +
      '}\n' +
      'export async function noteDistinctAddress(ip: string, now: Date = new Date()): Promise<void> {\n' +
      '  const key = distinctAddressKey(day);\n' +
      '  const element = distinctAddressElement(address, await distinctDaySalt(client, day, now.getTime()));\n' +
      "  const altered = await client.cmd(['PFADD', key, element]);\n" +
      "  await client.cmd(['EXPIREAT', key, String(distinctAddressExpiresAt(day))]); // re-asserts the same uniques: deadline\n" +
      '}\n' +
      'export async function readDistinctAddressCount(day: string): Promise<DistinctAddressCountResult> {\n' +
      "  const count = await client.cmd(['PFCOUNT', key]);\n" +
      '}',
  },
  {
    // The rate limiter itself keeps using its own salt and hash freely:
    // separation binds only the sketch's functions, never createRateLimiter.
    file: COUNTERS_REGISTRY,
    text:
      'export function createRateLimiter(opts: { route: RouteName }): RateLimiter {\n' +
      '  const salt = await currentSalt(client);\n' +
      '  const k = counterKey(opts.route, callerHash(ip, salt));\n' +
      "  await client.cmd(['SET', k, '0', 'NX', 'EX', String(opts.windowSec)]);\n" +
      '}',
  },
  {
    // proxy.ts and lib/usage.ts DESCRIBE the family in comments; only code
    // is confined, so prose about it elsewhere must not false-positive.
    file: 'proxy.ts',
    text:
      '// adds the salted hash to <env>:uniques:<day> (PFADD) in lib/ratelimit.ts\n' +
      'event.waitUntil(noteDistinctAddress(callerIp(req.headers)).catch(() => {}));',
  },
  {
    // The real script-refusal shape (2026-09-27), declaration and key builder
    // together, exactly as lib/usage.ts ships them.
    file: USAGE_REGISTRY,
    text:
      "const SCRIPT_REFUSAL_SCOPES = ['daily', 'burst', 'tenant'] as const;\n" +
      'const k = `${keyPrefix()}:usage:script-refusal:${asScriptRefusalScope(scope)}:${day}`;',
  },
];

function selfTest() {
  let failed = false;
  for (const fixture of SELF_TEST_FIXTURES) {
    const hits = scanText(fixture.file, fixture.text);
    if (!hits.some((v) => v.rule === fixture.rule)) {
      console.error(`::error::self-test: seeded violation NOT caught: ${fixture.name} (expected rule "${fixture.rule}")`);
      failed = true;
    }
  }
  for (const sample of SELF_TEST_CLEAN) {
    const hits = scanText(sample.file, sample.text);
    if (hits.length > 0) {
      console.error(`::error::self-test: clean sample false-positived in ${sample.file}: ${hits[0].rule} — ${hits[0].detail}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(`key-namespace gate self-test: all ${SELF_TEST_FIXTURES.length} seeded violations caught, ${SELF_TEST_CLEAN.length} clean samples pass`);
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const violations = scanRepo();
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`::error file=${v.file},line=${v.line}::[${v.rule}] ${v.detail}`);
    }
    process.exit(1);
  }
  console.log('key namespaces clean: counters DB sees only hashed callers, cache DB sees only content keys, no content identifiers in caller-originating query strings');
}

// Run when invoked as a script; stay importable for tests. The argv[1]
// test is the same guard scripts/check-run-honesty.mjs and
// scripts/check-cursor-age.mjs use. It replaced a module-URL comparison
// (2026-09-27) because the Playwright unit runner failed to load this file
// with one ("exports is not defined in ES module scope"), and
// tests/key-namespaces.spec.ts now imports scanText to run the
// distinct-address rules against the real shipped files.
if (/(^|[\\/])check-key-namespaces\.mjs$/.test(process.argv[1] ?? '')) {
  main();
}

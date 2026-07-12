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
const CONTENT_IDENTIFIER = /slug|stance|locale|\blang\b|bill|tool|summary|title|topic|query|citation/i;
const CALLER_MATERIAL = /(^|[^a-z])ip([^a-z]|$)|forwarded|caller|salt|address|\bzip\b/i;
// The usage registry's OWN content rule (traffic-watch, 2026-07): identical
// to CONTENT_IDENTIFIER except `tool` is deliberately removed — this is the
// one registry where a tool name is the intentional dimension, not content
// (see lib/usage.ts's header comment). Every OTHER forbidden term
// (slug/stance/locale/lang/bill/summary/title/topic/query/citation) still
// applies unchanged — a caller's ZIP, bill slug, or search string must
// never reach a usage key.
const USAGE_CONTENT_IDENTIFIER = /slug|stance|locale|\blang\b|bill|summary|title|topic|query|citation/i;
// S19: the counters registry's SECOND identity shape (tenant-id-keyed,
// alongside the caller-hash-keyed one) must never fold caller material into
// the SAME interpolation as a tenant identifier — that would start building
// a per-visitor-within-tenant profile the product never asked for.
const TENANT_IDENTIFIER = /tenantId/;
// The domain-nomination registry's own extra rule (S15, F3): even the raw
// Referer/URL material it starts from must never make it into a template
// interpolation — the only interpolations that belong in that file's key
// builder are the already-truncated domain and a date bucket.
const RAW_REFERER_MATERIAL = /referer|referrer|pathname|\bhref\b|\bsearch\b|\burl\b/i;

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
  if (file === USAGE_REGISTRY) {
    for (const { expr, line } of templateInterpolations(text)) {
      if (USAGE_CONTENT_IDENTIFIER.test(expr)) {
        add('usage-content', line, `content identifier "${expr.trim()}" interpolated in the usage registry`);
      }
      if (CALLER_MATERIAL.test(expr)) {
        add('usage-caller', line, `caller-derived material "${expr.trim()}" interpolated in the usage registry`);
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

// Run when invoked as a script; stay importable for tests.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main();
}

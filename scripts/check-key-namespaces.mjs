/**
 * Upstash key-namespace privacy gate (S11; KTD-3, AE5). Fails CI when code
 * would blur the line between the two physically separate Upstash databases:
 *
 *   counters DB — caller-keyed, short-lived rate-limit counters ONLY.
 *                 No slug/stance/locale/tool/bill identifier may ever reach
 *                 a counters key (lib/ratelimit.ts is the single registry).
 *   cache DB    — content-keyed script cache ONLY. No IP-, caller-, salt-,
 *                 or address-derived material may ever reach a cache key
 *                 (lib/scriptcache.ts is the single registry).
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

// The two registries.
const COUNTERS_REGISTRY = 'lib/ratelimit.ts';
const CACHE_REGISTRY = 'lib/scriptcache.ts';
const CLIENT_MODULE = 'lib/upstash.ts';

// Identifier fragments that mark CONTENT (never allowed near counters keys)
// and CALLER material (never allowed near cache keys).
const CONTENT_IDENTIFIER = /slug|stance|locale|\blang\b|bill|tool|summary|title|topic|query|citation/i;
const CALLER_MATERIAL = /(^|[^a-z])ip([^a-z]|$)|forwarded|caller|salt|address|\bzip\b/i;

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
    });
  }

  // 2. client confinement: countersClient only in the counters registry,
  //    cacheClient only in the cache registry (plus their definitions).
  if (file !== CLIENT_MODULE && file !== COUNTERS_REGISTRY && /\bcountersClient\b/.test(text)) {
    add('client-confinement', 0, `countersClient used outside ${COUNTERS_REGISTRY}`);
  }
  if (file !== CLIENT_MODULE && file !== CACHE_REGISTRY && /\bcacheClient\b/.test(text)) {
    add('client-confinement', 0, `cacheClient used outside ${CACHE_REGISTRY}`);
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

  // 4. cache keys carry no caller material: mirror rule for the cache registry.
  if (file === CACHE_REGISTRY) {
    for (const { expr, line } of templateInterpolations(text)) {
      if (CALLER_MATERIAL.test(expr)) {
        add('cache-caller', line, `caller-derived material "${expr.trim()}" interpolated in the cache registry`);
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

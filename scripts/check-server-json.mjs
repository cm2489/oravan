/**
 * server.json validation gate (S12). CI fails a PR that ships a server.json
 * the Official MCP Registry (registry.modelcontextprotocol.io) would reject,
 * or one that has silently drifted from package.json's version or
 * lib/site.ts's SITE_ORIGIN. S12's own Done criterion is literally
 * "server.json validates" — this script is that criterion, automated.
 *
 * Rules mirror (not re-derive) the official schema, verified 2026-07-11
 * against the live schema at
 * https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
 * and docs/reference/server-json/{generic-server-json,official-registry-
 * requirements}.md in modelcontextprotocol/registry — not guessed:
 *   - name: reverse-DNS namespace + "/" + server name, 3-200 chars,
 *     `^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`, exactly one "/".
 *   - description: 1-100 chars (the schema's own maxLength).
 *   - version: non-empty, <=255 chars, no semver-range operators (the
 *     schema explicitly rejects "^1.2.3", "~1.2.3", ">=1.2.3", "1.x", "1.*").
 *   - remotes[]: at least one entry when the server ships no packages (true
 *     here — Oravan's MCP server is remote-only); each entry needs
 *     type "streamable-http" or "sse" and an https:// url.
 *   - repository, when present: url + source required.
 *
 * Two Oravan-specific cross-checks the generic schema doesn't know about,
 * added so a future edit can't silently drift the file from the app it
 * describes:
 *   - version must equal package.json's "version" (both track "0.1.0" today
 *     — one number, two files, checked equal rather than trusted equal).
 *   - the namespace half of "name" must be the reverse-DNS form of
 *     lib/site.ts's SITE_ORIGIN hostname, and the first remotes[].url must
 *     start with that same origin's "/api/mcp/" — the same "SITE_ORIGIN is
 *     the one place the domain lives" rule lib/site.ts states for app code,
 *     enforced here for the one static file that can't just `import` it.
 *
 * `--self-test` runs every rule against seeded bad fixtures (and one clean
 * fixture) and exits nonzero if any seeded violation goes uncaught or the
 * clean fixture false-positives — same convention as the repo's other
 * self-test-first gates (check-naming.mjs, check-key-namespaces.mjs,
 * check-embed-fingerprinting.mjs). Stdlib only.
 */
import { existsSync, readFileSync } from 'node:fs';

const SERVER_JSON_PATH = 'server.json';
const PACKAGE_JSON_PATH = 'package.json';
const SITE_TS_PATH = 'lib/site.ts';

const NAME_PATTERN = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const URL_PATTERN = /^https?:\/\/[^\s]+$/;
const SEMVER_RANGE_PATTERN = /[\^~*]|>=|<=|(?<![\w.])[<>](?!=)|[xX](?=\.|$)/;

/** Reverse-DNS form of a hostname: "oravan.org" -> "org.oravan". */
export function reverseDns(hostname) {
  return hostname.split('.').reverse().join('.');
}

/** Extract `export const SITE_ORIGIN = '...'` from lib/site.ts's source text
 *  (stdlib-only: no TS module loader here, same source-text-scan pattern the
 *  other CI gates already use rather than importing app code). */
export function siteOriginFromSource(source) {
  const m = /export const SITE_ORIGIN\s*=\s*'([^']+)'/.exec(source);
  return m ? m[1] : null;
}

/**
 * Validate a parsed server.json document. Returns an array of error strings
 * (empty = valid). `packageVersion`/`siteOrigin` are injected rather than
 * read from disk here so the self-test below can exercise the rules against
 * fixtures without touching the filesystem.
 */
export function validateServerJson(doc, { packageVersion, siteOrigin } = {}) {
  const errors = [];
  const req = (cond, msg) => {
    if (!cond) errors.push(msg);
  };

  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return ['server.json must be a JSON object'];
  }

  req(typeof doc.$schema === 'string' && doc.$schema.length > 0, '$schema is required');
  if (typeof doc.$schema === 'string') {
    req(
      doc.$schema.startsWith('https://static.modelcontextprotocol.io/schemas/'),
      '$schema must point at the official static.modelcontextprotocol.io schema host'
    );
  }

  req(typeof doc.name === 'string', 'name is required and must be a string');
  if (typeof doc.name === 'string') {
    req(doc.name.length >= 3 && doc.name.length <= 200, `name must be 3-200 chars (got ${doc.name.length})`);
    req(
      NAME_PATTERN.test(doc.name),
      `name "${doc.name}" must match reverse-dns-namespace/server-name (${NAME_PATTERN})`
    );
    req((doc.name.match(/\//g) ?? []).length === 1, 'name must contain exactly one "/"');
    if (siteOrigin) {
      const hostname = siteOrigin.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const expectedNamespace = reverseDns(hostname);
      const namespace = doc.name.split('/')[0];
      req(
        namespace === expectedNamespace,
        `name's namespace "${namespace}" must be the reverse-DNS form of SITE_ORIGIN ("${expectedNamespace}", from ${siteOrigin}) — domain-verified namespace ownership must match the domain actually being served`
      );
    }
  }

  req(typeof doc.description === 'string', 'description is required and must be a string');
  if (typeof doc.description === 'string') {
    req(
      doc.description.length >= 1 && doc.description.length <= 100,
      `description must be 1-100 chars (got ${doc.description.length})`
    );
  }

  req(typeof doc.version === 'string' && doc.version.length > 0, 'version is required and must be a non-empty string');
  if (typeof doc.version === 'string') {
    req(doc.version.length <= 255, 'version must be <=255 chars');
    req(
      !SEMVER_RANGE_PATTERN.test(doc.version),
      `version "${doc.version}" must be a literal version, not a range (^, ~, *, x, >=, <=, >, <)`
    );
    if (packageVersion) {
      req(
        doc.version === packageVersion,
        `version "${doc.version}" must match package.json's version "${packageVersion}"`
      );
    }
  }

  if (doc.websiteUrl !== undefined) {
    req(
      typeof doc.websiteUrl === 'string' && URL_PATTERN.test(doc.websiteUrl),
      'websiteUrl must be a valid http(s) URL'
    );
  }

  if (doc.repository !== undefined) {
    req(typeof doc.repository === 'object' && doc.repository !== null, 'repository must be an object');
    if (typeof doc.repository === 'object' && doc.repository !== null) {
      req(
        typeof doc.repository.url === 'string' && URL_PATTERN.test(doc.repository.url),
        'repository.url must be a valid http(s) URL'
      );
      req(
        typeof doc.repository.source === 'string' && doc.repository.source.length > 0,
        'repository.source is required when repository is present'
      );
    }
  }

  const hasRemotes = Array.isArray(doc.remotes) && doc.remotes.length > 0;
  const hasPackages = Array.isArray(doc.packages) && doc.packages.length > 0;
  req(
    hasRemotes || hasPackages,
    'server.json must declare at least one of remotes[] or packages[] (Oravan\'s MCP server is remote-only, so remotes[])'
  );

  if (Array.isArray(doc.remotes)) {
    doc.remotes.forEach((remote, i) => {
      req(typeof remote === 'object' && remote !== null, `remotes[${i}] must be an object`);
      if (typeof remote !== 'object' || remote === null) return;
      req(
        remote.type === 'streamable-http' || remote.type === 'sse',
        `remotes[${i}].type must be "streamable-http" or "sse"`
      );
      req(typeof remote.url === 'string' && URL_PATTERN.test(remote.url), `remotes[${i}].url must be a valid http(s) URL`);
      req(typeof remote.url === 'string' && remote.url.startsWith('https://'), `remotes[${i}].url must be https`);
      if (i === 0 && siteOrigin && typeof remote.url === 'string') {
        req(
          remote.url.startsWith(`${siteOrigin}/api/mcp/`),
          `remotes[0].url "${remote.url}" must start with SITE_ORIGIN + "/api/mcp/" ("${siteOrigin}/api/mcp/") — the deployed MCP route's own basePath`
        );
      }
    });
  }

  return errors;
}

/* --- Self-test: the gate must catch every seeded bad fixture, and pass a known-good one. --- */

const GOOD_DOC = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
  name: 'org.example/mcp',
  title: 'Example',
  description: 'A short, valid description under the 100-character schema limit.',
  version: '0.1.0',
  websiteUrl: 'https://example.org/mcp',
  repository: { url: 'https://github.com/example/example', source: 'github' },
  remotes: [{ type: 'streamable-http', url: 'https://example.org/api/mcp/mcp' }],
};
const GOOD_CTX = { packageVersion: '0.1.0', siteOrigin: 'https://example.org' };

const BAD_FIXTURES = [
  { name: 'missing name', doc: { ...GOOD_DOC, name: undefined }, expectSubstr: 'name is required' },
  { name: 'name with no slash', doc: { ...GOOD_DOC, name: 'org.example' }, expectSubstr: 'must match reverse-dns-namespace' },
  {
    name: 'name namespace does not match SITE_ORIGIN',
    doc: { ...GOOD_DOC, name: 'com.wrongdomain/mcp' },
    expectSubstr: 'must be the reverse-DNS form of SITE_ORIGIN',
  },
  {
    name: 'description over 100 chars',
    doc: { ...GOOD_DOC, description: 'x'.repeat(101) },
    expectSubstr: 'description must be 1-100 chars',
  },
  { name: 'version missing', doc: { ...GOOD_DOC, version: '' }, expectSubstr: 'version is required' },
  {
    name: 'version mismatched with package.json',
    doc: { ...GOOD_DOC, version: '9.9.9' },
    expectSubstr: "must match package.json's version",
  },
  {
    name: 'version is a semver range',
    doc: { ...GOOD_DOC, version: '^1.2.3' },
    expectSubstr: 'must be a literal version, not a range',
  },
  {
    name: 'remote url is http, not https',
    doc: { ...GOOD_DOC, remotes: [{ type: 'streamable-http', url: 'http://example.org/api/mcp/mcp' }] },
    expectSubstr: 'must be https',
  },
  {
    name: "remote url doesn't match SITE_ORIGIN's /api/mcp/ path",
    doc: { ...GOOD_DOC, remotes: [{ type: 'streamable-http', url: 'https://elsewhere.example/mcp' }] },
    expectSubstr: 'must start with SITE_ORIGIN',
  },
  {
    name: 'no remotes and no packages',
    doc: { ...GOOD_DOC, remotes: [] },
    expectSubstr: 'must declare at least one of remotes[] or packages[]',
  },
];

function selfTest() {
  let failed = false;
  for (const fixture of BAD_FIXTURES) {
    const errors = validateServerJson(fixture.doc, GOOD_CTX);
    if (!errors.some((e) => e.includes(fixture.expectSubstr))) {
      console.error(`::error::self-test: seeded violation NOT caught: "${fixture.name}" (expected an error containing "${fixture.expectSubstr}")`);
      console.error(`  actual errors: ${JSON.stringify(errors)}`);
      failed = true;
    }
  }
  const cleanErrors = validateServerJson(GOOD_DOC, GOOD_CTX);
  if (cleanErrors.length > 0) {
    console.error(`::error::self-test: known-good fixture false-positived: ${JSON.stringify(cleanErrors)}`);
    failed = true;
  }
  if (failed) process.exit(1);
  console.log(`check-server-json self-test: all ${BAD_FIXTURES.length} seeded violations caught, clean fixture passes`);
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }

  if (!existsSync(SERVER_JSON_PATH)) {
    console.error(`::error::check-server-json: ${SERVER_JSON_PATH} does not exist`);
    process.exit(1);
  }

  let doc;
  try {
    doc = JSON.parse(readFileSync(SERVER_JSON_PATH, 'utf8'));
  } catch (e) {
    console.error(`::error::check-server-json: ${SERVER_JSON_PATH} is not valid JSON: ${e.message}`);
    process.exit(1);
  }

  let packageVersion;
  try {
    packageVersion = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')).version;
  } catch (e) {
    console.error(`::error::check-server-json: could not read ${PACKAGE_JSON_PATH}: ${e.message}`);
    process.exit(1);
  }

  let siteOrigin = null;
  if (existsSync(SITE_TS_PATH)) {
    siteOrigin = siteOriginFromSource(readFileSync(SITE_TS_PATH, 'utf8'));
    if (!siteOrigin) {
      console.error(`::error::check-server-json: could not find SITE_ORIGIN in ${SITE_TS_PATH} — the cross-check would silently no-op`);
      process.exit(1);
    }
  }

  const errors = validateServerJson(doc, { packageVersion, siteOrigin });
  if (errors.length > 0) {
    for (const e of errors) console.error(`::error file=${SERVER_JSON_PATH}::${e}`);
    console.error(`check-server-json: ${errors.length} failure(s).`);
    process.exit(1);
  }
  console.log(`check-server-json passed: ${SERVER_JSON_PATH} validates (name "${doc.name}", version "${doc.version}").`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main();
}

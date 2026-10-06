/**
 * ZIP-out-of-addresses gate (2026-10-06). A visitor's ZIP code must never
 * travel in the ADDRESS of a request to Oravan's own routes: not in a query
 * string, not in a path segment.
 *
 * Why: the hosting provider's request logs keep each request's path WITH its
 * query string, next to the caller's network address and user agent, and do
 * not keep the request body. While the rep lookup was `GET /api/reps?zip=…`
 * the ZIP sat in those logs, which made the shipped promise ("used in memory,
 * never stored", privacy.p2 and its siblings) untrue of the host. The lookup
 * now POSTs the ZIP in a JSON body (lib/reps-lookup.ts), the way
 * /api/district has sent the street address since #373. This gate stops the
 * old shape from coming back in one helpful-looking line.
 *
 * The rules, over every first-party source file in SCAN_DIRS / SCAN_FILES
 * (comments are skipped; string and template literals are read by a small
 * lexer, not by a regex over the whole file):
 *
 *   api-address-input   A literal that is an /api/ address (it starts with
 *                       `/api/`, or with an origin or a `${…}` and then
 *                       `/api/`) may not carry a query string (`?`) or an
 *                       interpolation (`${…}`), and may not be the left side
 *                       of a `+` concatenation. Input to our own APIs goes in
 *                       the body. No route needs an exception today; one that
 *                       does is named in API_ADDRESS_EXCEPTIONS with a reason.
 *   zip-in-address      A literal that is an /api/ or /embed/ address may not
 *                       mention a ZIP at all (`zip=`, `/zip/`, `${zip}` …).
 *   zip-param-builder   No `.set('zip', …)` / `.append('zip', …)`: the
 *                       URLSearchParams way of writing the same address.
 *   server-reads-zip    No `searchParams.get('zip')` (or getAll/has) anywhere,
 *                       and no `zip` member in a page's `searchParams` type
 *                       under app/api or app/embed: the server side of the
 *                       same shape (the embed page's dormant `?zip=` was
 *                       removed with this gate).
 *   loader-zip-attr     public/embed.js may not name a `zip` attribute: the
 *                       loader builds the embed's iframe address from a list
 *                       of attribute names, so a 'zip' entry there would put
 *                       the ZIP back in the /embed/ address.
 *
 * DELIBERATELY OUT OF SCOPE, and why: the page address `/reps?zip=NNNNN`
 * (the ZIP form, the saved-ZIP swap, the address form's return, the "see
 * your members" links and the MCP server's reps_url all write it, and the
 * page renders per request from it). Taking the ZIP out of that address
 * changes what readers see and share, so it is the owner's decision (open as
 * of 2026-10-06); until then this gate does not look at `/reps` addresses.
 * When that lands, add `/reps` to ADDRESS_PREFIXES and the
 * `app/[locale]/reps` page to SERVER_PAGE_DIRS.
 *
 * HONEST LIMITS: a source-text gate. It cannot follow a URL assembled out of
 * variables several lines apart (`const p = '/api/' + name; fetch(p + q)`),
 * a computed property name, or code in node_modules. It is a tripwire for
 * the realistic regression, not a proof; tests/embed-rep-lookup.spec.ts and
 * tests/reps.spec.ts check the request a browser actually sends.
 *
 * `--self-test` runs every rule against seeded violations and clean samples
 * and exits nonzero if any violation goes undetected or any clean sample is
 * flagged. Stdlib only, like the repo's other CI gates.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

const SCAN_DIRS = ['app', 'components', 'lib'];
const SCAN_FILES = ['proxy.ts', 'public/embed.js'];
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];

/** Where a request to one of Oravan's own routes is addressed. */
const ADDRESS_PREFIXES = ['/api/', '/embed/'];
/** Server code whose `searchParams` type may not name a zip. */
const SERVER_PAGE_DIRS = ['app/api/', 'app/embed/'];

/**
 * /api/ addresses allowed a query string or an interpolation, each with its
 * reason. Empty on purpose: every API input travels in a body today.
 * Shape: { file, literal, reason }.
 */
const API_ADDRESS_EXCEPTIONS = [];

const KEYWORDS_BEFORE_EXPRESSION = new Set([
  'return', 'case', 'typeof', 'in', 'of', 'else', 'yield', 'await', 'void', 'delete', 'throw', 'new', 'extends', 'do',
]);

/**
 * Every string and template literal in `src`, as { text, start, end, line }
 * (`text` is the content between the quotes; a template's `${…}` stays in it
 * verbatim). Comments and regex literals are skipped. JSX text is code to
 * this lexer, so an apostrophe in prose (`don't`) must not open a string: a
 * quote opens one only where an expression can begin.
 */
export function literals(src) {
  const out = [];
  let i = 0;
  // What came last: 'word' (identifier/number/keyword), 'close' () or ]),
  // 'literal', or a punctuator character.
  let prev = 'start';
  let prevWord = '';

  const exprCanStart = () =>
    prev === 'start' ||
    (prev === 'word' && KEYWORDS_BEFORE_EXPRESSION.has(prevWord)) ||
    (prev !== 'word' && prev !== 'close' && prev !== 'literal');

  const lineAt = (idx) => src.slice(0, idx).split('\n').length;

  function readQuoted(start) {
    const q = src[start];
    let j = start + 1;
    while (j < src.length && src[j] !== q) {
      if (src[j] === '\\') j++;
      else if (src[j] === '\n') return null; // not a string after all
      j++;
    }
    return j < src.length ? j : null;
  }

  function readTemplate(start) {
    let j = start + 1;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '`') return j;
      if (c === '$' && src[j + 1] === '{') {
        j = readInterpolation(j + 2);
        if (j === null) return null;
        continue;
      }
      j++;
    }
    return null;
  }

  /** From just inside `${`, the index just past its closing `}`. */
  function readInterpolation(start) {
    let depth = 1;
    let j = start;
    while (j < src.length) {
      const c = src[j];
      if (c === '`') {
        const end = readTemplate(j);
        if (end === null) return null;
        out.push({ text: src.slice(j + 1, end), start: j, end, line: lineAt(j) });
        j = end + 1;
        continue;
      }
      if (c === "'" || c === '"') {
        const end = readQuoted(j);
        if (end !== null) {
          out.push({ text: src.slice(j + 1, end), start: j, end, line: lineAt(j) });
          j = end + 1;
          continue;
        }
      }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return j + 1;
      j++;
    }
    return null;
  }

  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close === -1 ? src.length : close + 2;
      continue;
    }
    if ((c === "'" || c === '"') && exprCanStart()) {
      const end = readQuoted(i);
      if (end !== null) {
        out.push({ text: src.slice(i + 1, end), start: i, end, line: lineAt(i) });
        i = end + 1;
        prev = 'literal';
        continue;
      }
    }
    if (c === '`') {
      const end = readTemplate(i);
      if (end !== null) {
        out.push({ text: src.slice(i + 1, end), start: i, end, line: lineAt(i) });
        i = end + 1;
        prev = 'literal';
        continue;
      }
    }
    if (c === '/' && exprCanStart() && prev !== '<' && src[i + 1] !== '>') {
      // A regex literal: skip to its unescaped closing slash on this line.
      let j = i + 1;
      let inClass = false;
      let ok = false;
      for (; j < src.length && src[j] !== '\n'; j++) {
        if (src[j] === '\\') {
          j++;
          continue;
        }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) {
          ok = true;
          break;
        }
      }
      if (ok) {
        i = j + 1;
        while (/[a-z]/i.test(src[i] ?? '')) i++; // flags
        prev = 'literal';
        continue;
      }
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      prevWord = src.slice(i, j);
      prev = 'word';
      i = j;
      continue;
    }
    prev = c === ')' || c === ']' ? 'close' : c;
    prevWord = '';
    i++;
  }
  return out;
}

/** The literal's address part, if it is addressed to one of our routes: '/api/…' or '/embed/…'. */
function addressOf(text) {
  const rest = text.replace(/^(?:https?:\/\/[^/'"`\s]*|\$\{[^}]*\})/, '');
  return ADDRESS_PREFIXES.some((p) => rest.startsWith(p)) ? rest : null;
}

const ZIP_WORD = /zip/i;

/** Scan one file's text; returns violations { rule, file, line, detail }. */
export function scanText(file, src) {
  const violations = [];
  const push = (rule, line, detail) => violations.push({ rule, file, line, detail });

  for (const lit of literals(src)) {
    const address = addressOf(lit.text);
    if (address === null) continue;
    const isApi = address.startsWith('/api/');
    const excepted = API_ADDRESS_EXCEPTIONS.some((e) => e.file === file && e.literal === lit.text);
    if (isApi && !excepted) {
      if (address.includes('?') || address.includes('${')) {
        push(
          'api-address-input',
          lit.line,
          `"${lit.text}" puts input into the address of a request to our own API. Send it in the request body (see lib/reps-lookup.ts).`
        );
      } else if (/^\s*\+/.test(src.slice(lit.end + 1, lit.end + 40))) {
        push(
          'api-address-input',
          lit.line,
          `"${lit.text}" is concatenated into a longer /api/ address. Send the input in the request body instead.`
        );
      }
    }
    if (ZIP_WORD.test(address)) {
      push('zip-in-address', lit.line, `"${lit.text}" puts a ZIP into the address of a request to Oravan's own routes.`);
    }
  }

  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length)).replace(/(^|[^:])\/\/.*$/gm, '$1');
  const lineOf = (idx) => stripped.slice(0, idx).split('\n').length;

  for (const m of stripped.matchAll(/\.\s*(?:set|append)\(\s*['"`]zip['"`]/gi)) {
    push('zip-param-builder', lineOf(m.index), 'a URL parameter named zip is being written; the ZIP goes in a request body.');
  }
  for (const m of stripped.matchAll(/searchParams\s*\.\s*(?:get|getAll|has)\(\s*['"`]zip['"`]/gi)) {
    push('server-reads-zip', lineOf(m.index), 'the ZIP is read from a request address; read it from the request body.');
  }
  if (SERVER_PAGE_DIRS.some((d) => file.startsWith(d))) {
    for (const m of stripped.matchAll(/searchParams\s*:\s*Promise<\s*\{/g)) {
      let depth = 0;
      let j = m.index + m[0].length - 1;
      for (; j < stripped.length; j++) {
        if (stripped[j] === '{') depth++;
        else if (stripped[j] === '}' && --depth === 0) break;
      }
      if (/\bzip\??\s*:/i.test(stripped.slice(m.index, j))) {
        push('server-reads-zip', lineOf(m.index), "this page's searchParams accept a zip, so a ZIP can arrive in its address.");
      }
    }
  }
  if (file === 'public/embed.js') {
    for (const lit of literals(src)) {
      if (/^(?:data-)?zip$/i.test(lit.text)) {
        push('loader-zip-attr', lit.line, 'the loader names a zip attribute, which would put the ZIP into the embed address.');
      }
    }
  }
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

export function scanRepo(root = ROOT) {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const full = join(root, dir);
    if (existsSync(full)) files.push(...walk(full));
  }
  for (const f of SCAN_FILES) {
    const full = join(root, f);
    if (existsSync(full)) files.push(full);
  }
  const violations = [];
  for (const full of files) {
    const rel = relative(root, full).replaceAll('\\', '/');
    violations.push(...scanText(rel, readFileSync(full, 'utf8')));
  }
  return { files: files.length, violations };
}

// Seeded violations: each must be caught by the named rule. The first six are
// the six lookups as they shipped before 2026-10-06, verbatim.
const SELF_TEST_FIXTURES = [
  ['the call panel lookup, as it shipped', 'components/ActionPanel.tsx', '    fetch(`/api/reps?zip=${zip}`)', 'api-address-input'],
  ['the call hub lookup, as it shipped', 'components/CallHubReach.tsx', '    fetch(`/api/reps?zip=${zip}`)', 'zip-in-address'],
  ['the hero lookup, as it shipped', 'components/HeroSavedZip.tsx', '    fetch(`/api/reps?zip=${zip}`)', 'api-address-input'],
  ['the settled panel lookup, as it shipped', 'components/SettledPanel.tsx', '    fetch(`/api/reps?zip=${zip}`)', 'api-address-input'],
  ['the action-panel embed lookup, as it shipped', 'components/embed/ActionPanelWidget.tsx', '    fetch(`/api/reps?zip=${z}`)', 'api-address-input'],
  ['the rep-lookup embed lookup, as it shipped', 'components/embed/RepLookupWidget.tsx', '      const res = await fetch(`/api/reps?zip=${value}`);', 'api-address-input'],
  ['a ZIP as a path segment', 'components/Fixture.tsx', 'fetch(`/api/reps/${zip}`)', 'api-address-input'],
  ['a ZIP by concatenation', 'components/Fixture.tsx', "fetch('/api/reps?zip=' + zip)", 'api-address-input'],
  ['an address concatenated from a bare /api/ literal', 'components/Fixture.tsx', "fetch('/api/reps' + query)", 'api-address-input'],
  ['an absolute origin in front', 'lib/fixture.ts', 'fetch(`${SITE_ORIGIN}/api/reps?zip=${zip}`)', 'api-address-input'],
  ['a ZIP in an embed address', 'components/Fixture.tsx', "const src = '/embed/rep-lookup?locale=en&zip=78501';", 'zip-in-address'],
  ['a URLSearchParams zip', 'components/Fixture.tsx', "const u = new URL('/api/reps', location.origin); u.searchParams.set('zip', zip);", 'zip-param-builder'],
  ['a zip appended to params', 'components/Fixture.tsx', 'params.append("zip", zip);', 'zip-param-builder'],
  ['the route reading the query, as it shipped', 'app/api/reps/route.ts', "  const zip = req.nextUrl.searchParams.get('zip') ?? '';", 'server-reads-zip'],
  [
    "the embed page's dormant param, as it shipped",
    'app/embed/rep-lookup/page.tsx',
    'export default async function P({ searchParams }: { searchParams: Promise<{\n    locale?: string;\n    zip?: string;\n    token?: string;\n  }> }) {}',
    'server-reads-zip',
  ],
  ['the loader naming a zip attribute', 'public/embed.js', "var THEME_ATTRS = ['accent', 'zip', 'mode'];", 'loader-zip-attr'],
];

// Clean samples: ordinary code that must NOT trip the gate (a gate that flags
// everything gets switched off). The /reps page address is here on purpose:
// it is out of scope until the owner decides it (see the header).
const SELF_TEST_CLEAN = [
  ['the POST helper', 'lib/reps-lookup.ts', "export const P = '/api/reps';\nfetch(P, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ zip }) });"],
  ['a component calling it', 'components/ActionPanel.tsx', '    lookupReps(zip)\n      .then((r) => (r.ok ? r.json() : Promise.reject()))'],
  ['the district POST', 'components/AddressForm.tsx', "const res = await fetch('/api/district', { method: 'POST', body: JSON.stringify({ address, zip }) });"],
  ['a portrait path with a member id', 'components/embed/RepLookupWidget.tsx', 'src={`/embed/portrait/${rep.bioguide}`}'],
  ['the configurator preview (no zip param)', 'components/EmbedConfigurator.tsx', "params.set('accent', a);\nreturn `/embed/${widget}?${params.toString()}`;"],
  ['the /reps page address (owner decision, out of scope)', 'components/ZipForm.tsx', 'router.push(`/reps?zip=${clean}`);'],
  ['FormData read of the form field', 'components/ZipForm.tsx', "const raw = new FormData(e.currentTarget).get('zip');"],
  [
    'JSX prose with apostrophes, closing tags and a regex',
    'components/Fixture.tsx',
    "return (<p>We don't keep it. It's yours.</p>);\nconst ok = /^\\d{5}$/.test(zip);\n<a href=\"/reps\">x</a>",
  ],
  ['prose that names the old shape inside a comment', 'components/Fixture.tsx', '// it used to be fetch(`/api/reps?zip=${zip}`)\n/* `/embed/rep-lookup?zip=` */'],
  ['a log message that mentions an API in prose', 'lib/moments-gate.mjs', 'warnings.push(`${vp}.slug: "${v.slug}" has an unclassified status, so /api/script refuses it`);'],
];

function selfTest() {
  let failed = false;
  for (const [name, file, text, rule] of SELF_TEST_FIXTURES) {
    const hits = scanText(file, text);
    if (!hits.some((v) => v.rule === rule)) {
      console.error(`::error::self-test: seeded violation NOT caught: ${name} (expected rule "${rule}", got ${JSON.stringify(hits.map((h) => h.rule))})`);
      failed = true;
    }
  }
  for (const [name, file, text] of SELF_TEST_CLEAN) {
    const hits = scanText(file, text);
    if (hits.length > 0) {
      console.error(`::error::self-test: clean sample flagged (${name}): [${hits[0].rule}] ${hits[0].detail}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(
    `zip-urls gate self-test: all ${SELF_TEST_FIXTURES.length} seeded violations caught, ${SELF_TEST_CLEAN.length} clean samples pass`
  );
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const { files, violations } = scanRepo();
  if (files === 0) {
    console.error('::error::zip-urls gate scanned no files; run it from the repo root');
    process.exit(1);
  }
  if (violations.length > 0) {
    for (const v of violations) console.error(`::error file=${v.file},line=${v.line}::[${v.rule}] ${v.detail}`);
    process.exit(1);
  }
  console.log(`zip-urls gate clean: ${files} files, no ZIP in the address of a request to Oravan's own routes`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main();
}

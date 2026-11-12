/**
 * ZIP-out-of-addresses gate (2026-10-06; the members page added 2026-11-12).
 * A visitor's ZIP code must never travel in the ADDRESS of a request to
 * Oravan's own routes or pages: not in a query string, not in a path segment.
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
 *                       `/api/`, or with `${NAME}` where NAME is a constant
 *                       bound to an /api/ address, such as REPS_LOOKUP_PATH)
 *                       may not carry a query string (`?`) or an
 *                       interpolation (`${…}`), and may not be the left side
 *                       of a `+` concatenation; nor may such a constant be.
 *                       Input to our own APIs goes in the body. This is a
 *                       policy wider than the ZIP (no query string on any of
 *                       our /api/ addresses), chosen because it is clean today
 *                       and the narrower rule is easy to dodge. A route that
 *                       needs an exception is named in API_ADDRESS_EXCEPTIONS
 *                       with a reason.
 *   zip-in-address      A literal that is an /api/, /embed/ or /reps address
 *                       may not mention a ZIP at all (`zip=`, `/zip/`,
 *                       `${zip}` …), unless it is named in
 *                       ZIP_ADDRESS_EXCEPTIONS with a reason.
 *   zip-query           Any literal that writes a `zip=` or `district=` query
 *                       parameter (`?zip=`, `&district=`, or a literal that
 *                       starts `zip=`), wherever its address comes from,
 *                       unless the literal is named in ZIP_ADDRESS_EXCEPTIONS
 *                       with a reason. This catches the shapes whose address
 *                       the lexer cannot see (`${base}?zip=…`,
 *                       `u.search = \`zip=…\``). The refined district sat
 *                       next to the ZIP in the members page's address until
 *                       2026-11-12, so it is held to the same rule.
 *   reps-address-query  A literal that is the members page's address (`/reps`,
 *                       `/es/reps`, with or without an origin) may carry no
 *                       query string but `?change=1`: anything else there
 *                       (`?district=…`, `?${params}`) is how the lookup used
 *                       to travel. Member pages (`/reps/${bioguide}`) are not
 *                       the members page and are not affected.
 *   zip-param-builder   No `.set('zip', …)` / `.append('zip', …)` (or
 *                       'district'), no `new URLSearchParams({ zip })` or
 *                       `new URLSearchParams([['zip', …]])`, and no `query`
 *                       object naming a zip or district
 *                       (`{ pathname: '/reps', query: { zip } }`, the
 *                       next-intl Link and router shape): the ways of writing
 *                       the same address without a literal.
 *   server-reads-zip    No `searchParams.get('zip')` (or getAll/has) anywhere,
 *                       and, under app/api, app/embed and the members page
 *                       (app/[locale]/reps), no `zip` member in a page's
 *                       `searchParams` type and no `{ zip } = … searchParams`
 *                       destructuring: the server side of the same shape (the
 *                       embed page's dormant `?zip=` was removed with this
 *                       gate). The members page itself is named in
 *                       SERVER_READS_EXCEPTIONS: it still reads an OLD link's
 *                       ?zip= once, so bookmarks and shared links keep working,
 *                       and drops it from the address on arrival.
 *   loader-zip-attr     public/embed.js may not name a `zip` attribute (as a
 *                       string or as `dataset.zip`): the
 *                       loader builds the embed's iframe address from a list
 *                       of attribute names, so a 'zip' entry there would put
 *                       the ZIP back in the /embed/ address.
 *
 * MESSAGES (2026-11-12). messages/*.json are scanned too: a translated string
 * can hold an address (a rich-text link, a sentence naming a page). Every
 * string value is read as a literal for zip-query, and every address inside
 * it (`/reps…`, `/es/reps…`, `/api/…`, `/embed/…`, with or without an
 * origin) is held to zip-in-address, reps-address-query and
 * api-address-input; an ICU placeholder (`{zip}`) in an address counts as a
 * ZIP. Prose that only names the ZIP (`ZIP {zip}`) is not an address.
 *
 * THE MEMBERS PAGE (owner, 2026-11-12). Until that day the page address
 * `/reps?zip=NNNNN` was out of scope: the ZIP form, the saved-ZIP swap, the
 * address form's return (`&district=`), the "see your members" links and the
 * MCP server's reps_url all wrote it. The owner took the ZIP out of it, so
 * `/reps` is an address here now and its page sits in SERVER_PAGE_DIRS. The
 * lookup travels in a POST body (lib/members-action.ts,
 * components/RepsLookup.tsx). The rep-lookup embed's link-out for a split
 * ZIP, the last writer, now opens the bare page and asks the visitor to
 * enter the ZIP there, so ZIP_ADDRESS_EXCEPTIONS is empty and the one named
 * exception left is the members page's reader of old links.
 *
 * Address constants: before scanning, the gate collects every
 * `const NAME = '/api/…'` (or `/embed/…`, a same-origin path) in the scanned tree, and each
 * `import { NAME as ALIAS }` of one, so `${REPS_LOOKUP_PATH}?zip=${zip}` and
 * `REPS_LOOKUP_PATH + '?…'` are read as the /api/ addresses they are.
 *
 * HONEST LIMITS: a source-text gate. It cannot follow a URL assembled out of
 * variables several lines apart (`const p = '/api/' + name; fetch(p + q)`),
 * a constant that is not a plain string literal, a computed property name,
 * or code in node_modules. A form's native submission (no JavaScript, or
 * before hydration) is not source text either: the embed widgets' ZIP forms
 * carry `method="post"` for that, pinned by tests/embed-rep-lookup.spec.ts,
 * and the site's ZIP forms POST to /reps through a server action, pinned by
 * tests/reps-zip-address.spec.ts. It is a tripwire for the realistic
 * regression, not a proof; tests/embed-rep-lookup.spec.ts, tests/reps.spec.ts
 * and tests/reps-zip-address.spec.ts check the requests a browser actually
 * sends.
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
/** Translated strings, read as JSON (see MESSAGES above). */
const MESSAGE_DIRS = ['messages'];

/** Where a request to one of Oravan's own routes is addressed. */
const ADDRESS_PREFIXES = ['/api/', '/embed/', '/reps', '/es/reps', '/en/reps'];
/** Server code whose `searchParams` type may not name a zip. */
const SERVER_PAGE_DIRS = ['app/api/', 'app/embed/', 'app/[locale]/reps/'];

/**
 * Server files allowed to read a zip from their own address, each with its
 * reason. Shape: { file, reason }.
 */
const SERVER_READS_EXCEPTIONS = [
  {
    file: 'app/[locale]/reps/page.tsx',
    reason:
      'old /reps?zip= links (bookmarks, shared links, search results) keep working: the page answers that one request with the members and components/RepsLookup.tsx drops the ZIP from the address on arrival; nothing Oravan renders writes that address (owner, 2026-11-12)',
  },
];

/**
 * /api/ addresses allowed a query string or an interpolation, each with its
 * reason. Empty on purpose: every API input travels in a body today.
 * Shape: { file, literal, reason }.
 */
const API_ADDRESS_EXCEPTIONS = [];

/**
 * Literals allowed to put a ZIP in an address, each with its reason (the
 * zip-query, zip-in-address and reps-address-query rules all honour it).
 * Empty on purpose since 2026-11-12: nothing Oravan renders writes one.
 * Shape: { file, literal, reason }.
 */
const ZIP_ADDRESS_EXCEPTIONS = [];

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

const IDENT = '[A-Za-z_$][\\w$]*';
const ADDRESS_CONST = new RegExp(
  `\\b(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=;]+)?=\\s*(['"\`])((?:${ADDRESS_PREFIXES.map((p) => p.replaceAll('/', '\\/')).join('|')})[^'"\`$]*)\\2`,
  'g'
);

/** Comments blanked out, line count kept. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length)).replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Constants in `src` bound to one of our route addresses, as a Map of
 * NAME -> address ('/api/reps'). Only plain string literals holding a
 * same-origin path are followed: an absolute URL constant is usually another
 * service's endpoint (a news API's `/api/v2/…`), not ours.
 */
export function addressConstants(src) {
  const names = new Map();
  for (const m of stripComments(src).matchAll(ADDRESS_CONST)) {
    names.set(m[1], m[3]);
  }
  return names;
}

/** `known` plus each `import { NAME as ALIAS }` of a known NAME in `src`. */
function withAliases(src, known) {
  const names = new Map(known);
  for (const [name, address] of known) {
    for (const m of src.matchAll(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s+as\\s+(${IDENT})`, 'g'))) {
      names.set(m[1], address);
    }
  }
  for (const [name, address] of addressConstants(src)) names.set(name, address);
  return names;
}

/**
 * The literal's address part, if it is addressed to one of our routes:
 * '/api/…' or '/embed/…'. A leading `${NAME}` whose NAME is a known address
 * constant is read as that address.
 */
function addressOf(text, names) {
  const lead = text.match(/^\$\{\s*([A-Za-z_$][\w$]*)\s*\}/);
  if (lead && names.has(lead[1])) return names.get(lead[1]) + text.slice(lead[0].length);
  const rest = text.replace(/^(?:https?:\/\/[^/'"`\s]*|\$\{[^}]*\})/, '');
  return ADDRESS_PREFIXES.some((p) => rest.startsWith(p)) ? rest : null;
}

const ZIP_WORD = /zip/i;
/** A query parameter that carried the lookup: the ZIP, or the refined district. */
const LOOKUP_QUERY = /(?:^|[?&])(?:zip|district)=/i;
/** The members page's own address, its locale prefix dropped. */
const MEMBERS_PAGE = /^\/(?:(?:es|en)\/)?reps(?=$|[?#])/;

/** The one query the members page's address may carry ("Change ZIP code"). */
function repsQueryAllowed(address) {
  const m = address.match(/^\/(?:(?:es|en)\/)?reps(\?[^#]*)?/);
  return !m || m[1] === undefined || m[1] === '?change=1';
}

/**
 * `src` with comments removed and the contents of every string and template
 * literal blanked (quotes and line breaks kept), so a pattern over code never
 * matches inside text (`\`${address}, ${zip}\`` is not an object key).
 */
function codeOnly(src) {
  const chars = src.split('');
  for (const lit of literals(src)) {
    for (let i = lit.start + 1; i < lit.end; i++) if (chars[i] !== '\n') chars[i] = ' ';
  }
  return stripComments(chars.join(''));
}

/** From the index of a `{`, the text up to its matching `}`. */
function braceBody(text, open) {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}' && --depth === 0) return text.slice(open, j + 1);
  }
  return text.slice(open);
}

/** An object literal's text names a `zip` or `district` key (bare, shorthand or quoted). */
function namesLookupKey(body) {
  return /[{,]\s*(?:(['"`])(?:zip|district)\1|(?:zip|district))\s*(?=[:,}])/i.test(body);
}

/**
 * Scan one file's text; returns violations { rule, file, line, detail }.
 * `knownAddresses` is the Map of address constants collected from the whole
 * tree (addressConstants); the file's own constants and import aliases are
 * added to it here.
 */
export function scanText(file, src, knownAddresses = new Map()) {
  const violations = [];
  const push = (rule, line, detail) => violations.push({ rule, file, line, detail });
  const names = withAliases(src, knownAddresses);

  for (const lit of literals(src)) {
    const zipExcepted = ZIP_ADDRESS_EXCEPTIONS.some((e) => e.file === file && e.literal === lit.text);
    if (LOOKUP_QUERY.test(lit.text) && !zipExcepted) {
      push('zip-query', lit.line, `"${lit.text}" writes a zip= or district= query parameter; the lookup goes in a request body.`);
    }
    const address = addressOf(lit.text, names);
    if (address === null) continue;
    if (MEMBERS_PAGE.test(address) && !repsQueryAllowed(address) && !zipExcepted) {
      push('reps-address-query', lit.line, `"${lit.text}" puts a query on the members page's address; only ?change=1 may go there.`);
    }
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
    if (ZIP_WORD.test(address) && !zipExcepted) {
      push('zip-in-address', lit.line, `"${lit.text}" puts a ZIP into the address of a request to Oravan's own routes.`);
    }
  }

  const stripped = stripComments(src);
  const lineOf = (idx) => stripped.slice(0, idx).split('\n').length;

  for (const [name, address] of names) {
    if (!address.startsWith('/api/')) continue;
    for (const m of stripped.matchAll(new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}\\s*\\+`, 'g'))) {
      push(
        'api-address-input',
        lineOf(m.index),
        `${name} (${address}) is concatenated into a longer address. Send the input in the request body instead.`
      );
    }
  }

  for (const m of stripped.matchAll(/\.\s*(?:set|append)\(\s*['"`](?:zip|district)['"`]/gi)) {
    push('zip-param-builder', lineOf(m.index), 'a URL parameter named zip or district is being written; the lookup goes in a request body.');
  }
  for (const m of stripped.matchAll(/\bURLSearchParams\s*\(\s*\[\s*\[\s*['"`](?:zip|district)['"`]/gi)) {
    push('zip-param-builder', lineOf(m.index), 'URLSearchParams is built with a zip or district entry; the lookup goes in a request body.');
  }
  // Object shapes, read over code only, so a ZIP inside a string value (the
  // geocoder's `address: \`${address}, ${zip}\``) is not mistaken for a key.
  const code = codeOnly(src);
  for (const m of code.matchAll(/\bURLSearchParams\s*\(\s*\{/g)) {
    if (namesLookupKey(braceBody(code, m.index + m[0].length - 1))) {
      push('zip-param-builder', lineOf(m.index), 'URLSearchParams is built from an object with a zip or district key; the lookup goes in a request body.');
    }
  }
  for (const m of code.matchAll(/\bquery\s*:\s*\{/g)) {
    if (namesLookupKey(braceBody(code, m.index + m[0].length - 1))) {
      push('zip-param-builder', lineOf(m.index), 'a `query` object names a zip or district, so the lookup would be written into an address.');
    }
  }
  for (const m of stripped.matchAll(/searchParams\s*\.\s*(?:get|getAll|has)\(\s*['"`]zip['"`]/gi)) {
    push('server-reads-zip', lineOf(m.index), 'the ZIP is read from a request address; read it from the request body.');
  }
  if (SERVER_PAGE_DIRS.some((d) => file.startsWith(d)) && !SERVER_READS_EXCEPTIONS.some((e) => e.file === file)) {
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
    for (const m of stripped.matchAll(/\{[^{}]*\bzip\b[^{}]*\}\s*=\s*(?:await\s+)?(?:[\w$]+\s*\.\s*)*searchParams\b/gi)) {
      push('server-reads-zip', lineOf(m.index), 'a zip is destructured from searchParams, so a ZIP can arrive in this address.');
    }
  }
  if (file === 'public/embed.js') {
    for (const lit of literals(src)) {
      if (/^(?:data-)?zip$/i.test(lit.text)) {
        push('loader-zip-attr', lit.line, 'the loader names a zip attribute, which would put the ZIP into the embed address.');
      }
    }
    for (const m of stripped.matchAll(/\.\s*dataset\s*\.\s*zip\b|\bdataset\s*\[\s*['"`]zip['"`]\s*\]/gi)) {
      push('loader-zip-attr', lineOf(m.index), 'the loader reads a zip data attribute, which would put the ZIP into the embed address.');
    }
  }
  return violations;
}

/** Every string value in a parsed JSON tree, with its dotted key. */
function jsonStrings(node, path = '', out = []) {
  if (typeof node === 'string') out.push([path, node]);
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) jsonStrings(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

/** An address inside a string of prose: a path to one of our routes, with or without an origin. */
const EMBEDDED_ADDRESS = /(?:https?:\/\/[^\s/"'<>]+)?(\/(?:(?:es|en)\/)?(?:reps|api\/|embed\/)[^\s"'<>)\]]*)/g;

/**
 * Scan one messages/*.json file (see MESSAGES above); returns violations
 * like scanText. `line` is the line of the string's key.
 */
export function scanMessages(file, src) {
  const violations = [];
  let tree;
  try {
    tree = JSON.parse(src);
  } catch {
    return [{ rule: 'messages-unreadable', file, line: 1, detail: 'not valid JSON, so its strings could not be checked.' }];
  }
  const lines = src.split('\n');
  const lineOfKey = (path) => {
    const key = path.split('.').pop();
    const i = lines.findIndex((l) => l.includes(`"${key}"`));
    return i === -1 ? 1 : i + 1;
  };
  for (const [path, text] of jsonStrings(tree)) {
    const push = (rule, detail) => violations.push({ rule, file, line: lineOfKey(path), detail: `${path}: ${detail}` });
    if (/[?&](?:zip|district)=/i.test(text) || /^(?:zip|district)=/i.test(text)) {
      push('zip-query', `"${text}" writes a zip= or district= query parameter.`);
    }
    for (const m of text.matchAll(EMBEDDED_ADDRESS)) {
      const address = m[1];
      if (ZIP_WORD.test(address)) push('zip-in-address', `"${address}" puts a ZIP into the address of one of Oravan's routes.`);
      if (MEMBERS_PAGE.test(address) && !repsQueryAllowed(address)) {
        push('reps-address-query', `"${address}" puts a query on the members page's address; only ?change=1 may go there.`);
      }
      if (address.startsWith('/api/') && /[?{]/.test(address)) {
        push('api-address-input', `"${address}" puts input into the address of a request to our own API.`);
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
  const sources = files.map((full) => [relative(root, full).replaceAll('\\', '/'), readFileSync(full, 'utf8')]);
  const known = repoAddressConstants(sources);
  const violations = [];
  for (const [rel, src] of sources) violations.push(...scanText(rel, src, known));
  let messageFiles = 0;
  for (const dir of MESSAGE_DIRS) {
    const full = join(root, dir);
    if (!existsSync(full)) continue;
    for (const entry of readdirSync(full).filter((f) => f.endsWith('.json'))) {
      const rel = `${dir}/${entry}`;
      violations.push(...scanMessages(rel, readFileSync(join(full, entry), 'utf8')));
      messageFiles++;
    }
  }
  return { files: files.length + messageFiles, violations, addressConstants: known };
}

/** Every address constant declared anywhere in `sources` ([file, text] pairs). */
export function repoAddressConstants(sources) {
  const known = new Map();
  for (const [, src] of sources) for (const [name, address] of addressConstants(src)) known.set(name, address);
  return known;
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
  // Through the lookup helper's own exported constant (lib/reps-lookup.ts),
  // the most natural one-line regression; SELF_TEST_KNOWN stands in for the
  // tree-wide collection that scanRepo does.
  ['a ZIP query on REPS_LOOKUP_PATH, by template', 'components/ActionPanel.tsx', '    fetch(`${REPS_LOOKUP_PATH}?zip=${zip}`)', 'api-address-input'],
  ['the same line, by the zip-query rule', 'components/ActionPanel.tsx', '    fetch(`${REPS_LOOKUP_PATH}?zip=${zip}`)', 'zip-query'],
  ['a ZIP query on REPS_LOOKUP_PATH, by concatenation', 'components/ActionPanel.tsx', '    fetch(REPS_LOOKUP_PATH + `?zip=${zip}`)', 'api-address-input'],
  ['a ZIP path segment on REPS_LOOKUP_PATH', 'components/ActionPanel.tsx', '    fetch(`${REPS_LOOKUP_PATH}/${zip}`)', 'api-address-input'],
  ['URLSearchParams on REPS_LOOKUP_PATH', 'components/ActionPanel.tsx', '    fetch(`${REPS_LOOKUP_PATH}?${new URLSearchParams({ zip })}`)', 'api-address-input'],
  [
    'REPS_LOOKUP_PATH under an import alias',
    'components/ActionPanel.tsx',
    "import { REPS_LOOKUP_PATH as P } from '@/lib/reps-lookup';\nfetch(`${P}?q=${zip}`)",
    'api-address-input',
  ],
  ['an /api/ constant declared in the same file', 'components/Fixture.tsx', "const API = '/api/reps';\nfetch(`${API}/${zip}`)", 'api-address-input'],
  ['a zip= search string with no visible address', 'components/Fixture.tsx', 'u.search = `zip=${zip}`;', 'zip-query'],
  ['a zip= query on an address the lexer cannot see', 'components/Fixture.tsx', 'fetch(`${base}?locale=en&zip=${zip}`)', 'zip-query'],
  ['a zip destructured from an embed page\'s searchParams', 'app/embed/rep-lookup/page.tsx', '  const { locale, zip } = await searchParams;', 'server-reads-zip'],
  ['the loader reading a zip data attribute', 'public/embed.js', 'var z = el.dataset.zip;', 'loader-zip-attr'],
  // The members page's address, as each writer shipped it before 2026-11-12.
  ['the ZIP form, as it shipped', 'components/ZipForm.tsx', '    else router.push(`/reps?zip=${clean}`);', 'zip-in-address'],
  ['the ZIP form, by the zip-query rule', 'components/ZipForm.tsx', '    else router.push(`/reps?zip=${clean}`);', 'zip-query'],
  ['the saved-ZIP swap, as it shipped', 'components/SavedZipLookup.tsx', '    router.replace(`/reps?zip=${saved}${window.location.hash}`);', 'zip-in-address'],
  ['the address form return, as it shipped', 'components/AddressForm.tsx', '        router.push(`/reps?zip=${zip}&district=${state}-${district}`);', 'zip-in-address'],
  ['a "see your members" link, as it shipped', 'components/HeroSavedZip.tsx', '  const lookupHref = `/reps?zip=${zip}`;', 'zip-in-address'],
  ["the MCP envelope's reps_url, as it shipped", 'lib/core/mcp.ts', '  const repsUrl = `${absoluteUrl(locale, REPS_PATH)}?zip=${zip}`;', 'zip-query'],
  ['an embed link-out not on the exception list', 'components/embed/ActionPanelWidget.tsx', 'href={`${siteBase}/reps?zip=${zip}`}', 'zip-in-address'],
  ["the rep-lookup embed's link-out, as it shipped", 'components/embed/RepLookupWidget.tsx', 'href={`${siteBase}/reps?zip=${zip}`}', 'zip-in-address'],
  // The four shapes the 2026-11-12 review found the gate missing.
  ['the refined district alone on /reps', 'components/AddressForm.tsx', '        router.push(`/reps?district=${state}-${district}`);', 'reps-address-query'],
  ['the same line, by the zip-query rule', 'components/AddressForm.tsx', '        router.push(`/reps?district=${state}-${district}`);', 'zip-query'],
  ['any other query on the Spanish members page', 'components/Fixture.tsx', 'href={`/es/reps?${params}`}', 'reps-address-query'],
  ['a next-intl href object with a zip query', 'components/Fixture.tsx', "<Link href={{ pathname: '/reps', query: { zip } }}>x</Link>", 'zip-param-builder'],
  ['a router call with a district query', 'components/Fixture.tsx', "router.push({ pathname: '/reps', query: { zip: z, 'district': d } });", 'zip-param-builder'],
  ['URLSearchParams from a zip shorthand', 'components/Fixture.tsx', 'const q = new URLSearchParams({ zip });\nlocation.assign(`${base}?${q}`);', 'zip-param-builder'],
  ['URLSearchParams from entries', 'components/Fixture.tsx', "const q = new URLSearchParams([['zip', zip]]);", 'zip-param-builder'],
  ['a district parameter set on a URL', 'components/Fixture.tsx', "u.searchParams.set('district', d);", 'zip-param-builder'],
  [
    "a member page reading a zip from its searchParams",
    'app/[locale]/reps/[bioguide]/page.tsx',
    '  const { zip } = await searchParams;',
    'server-reads-zip',
  ],
];

// Seeded violations in a messages file: each must be caught by the named rule.
const SELF_TEST_MESSAGE_FIXTURES = [
  ['a ZIP query in a translated string', 'messages/en.json', '{"reps": {"see": "Open /reps?zip={zip} to see them"}}', 'zip-query'],
  ['a ZIP placeholder in a rich-text link', 'messages/es.json', '{"home": {"go": "<link href=\\"/es/reps/{zip}\\">Tus miembros</link>"}}', 'zip-in-address'],
  ['a district query on the members page, with an origin', 'messages/en.json', '{"a": {"b": "https://oravan.org/reps?district={district}"}}', 'reps-address-query'],
];
const SELF_TEST_MESSAGE_CLEAN = [
  ['ICU placeholders in prose, and the bare page', 'messages/en.json', '{"reps": {"zipLine": "ZIP {zip}", "go": "Enter your ZIP at /reps.", "change": "/reps?change=1"}}'],
];

/** The tree's real lookup constant, collected the way scanRepo collects it. */
const SELF_TEST_KNOWN = addressConstants("export const REPS_LOOKUP_PATH = '/api/reps';");

// Clean samples: ordinary code that must NOT trip the gate (a gate that flags
// everything gets switched off).
const SELF_TEST_CLEAN = [
  ['the POST helper', 'lib/reps-lookup.ts', "export const P = '/api/reps';\nfetch(P, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ zip }) });"],
  ['a component calling it', 'components/ActionPanel.tsx', '    lookupReps(zip)\n      .then((r) => (r.ok ? r.json() : Promise.reject()))'],
  ['the district POST', 'components/AddressForm.tsx', "const res = await fetch('/api/district', { method: 'POST', body: JSON.stringify({ address, zip }) });"],
  ['a portrait path with a member id', 'components/embed/RepLookupWidget.tsx', 'src={`/embed/portrait/${rep.bioguide}`}'],
  ['the configurator preview (no zip param)', 'components/EmbedConfigurator.tsx', "params.set('accent', a);\nreturn `/embed/${widget}?${params.toString()}`;"],
  ['the bare members page', 'components/ZipForm.tsx', "router.push('/reps');"],
  ['the Change ZIP link and a member page', 'components/RepsLookup.tsx', '<Link href="/reps?change=1">x</Link>\n<Link href={`/reps/${rep.bioguide}`}>y</Link>'],
  ['FormData read of the form field', 'components/ZipForm.tsx', "const raw = new FormData(e.currentTarget).get('zip');"],
  [
    'JSX prose with apostrophes, closing tags and a regex',
    'components/Fixture.tsx',
    "return (<p>We don't keep it. It's yours.</p>);\nconst ok = /^\\d{5}$/.test(zip);\n<a href=\"/reps\">x</a>",
  ],
  ['prose that names the old shape inside a comment', 'components/Fixture.tsx', '// it used to be fetch(`/api/reps?zip=${zip}`)\n/* `/embed/rep-lookup?zip=` */'],
  ['a log message that mentions an API in prose', 'lib/moments-gate.mjs', 'warnings.push(`${vp}.slug: "${v.slug}" has an unclassified status, so /api/script refuses it`);'],
  ['the helper POSTing to its constant', 'lib/reps-lookup.ts', "fetch(REPS_LOOKUP_PATH, { method: 'POST', body: JSON.stringify({ zip }) });"],
  ["the rep-lookup embed's link-out to the bare members page", 'components/embed/RepLookupWidget.tsx', 'href={`${siteBase}/reps`}'],
  [
    "the district route's geocoder query (a ZIP in a value, not a key)",
    'app/api/district/route.ts',
    'const params = new URLSearchParams({ address: `${address}, ${zip}`, ...CENSUS_QUERY });',
  ],
  ['a Link href object with the Change ZIP query', 'components/Fixture.tsx', "<Link href={{ pathname: '/reps', query: { change: 1 } }}>x</Link>"],
  ['a member page by bioguide, with a query', 'components/Fixture.tsx', 'href={`/reps/${rep.bioguide}?tab=votes`}'],
  ['the members page reading an old link (named exception)', 'app/[locale]/reps/page.tsx', '  searchParams: Promise<{ zip?: string; district?: string }>;'],
  ["the MCP envelope's bare /reps link", 'lib/core/mcp.ts', 'const repsUrl = absoluteUrl(locale, REPS_PATH);'],
  ['a page destructuring other params', 'app/embed/action-panel/page.tsx', '  const { locale, slug, token } = await searchParams;'],
];

function selfTest() {
  let failed = false;
  for (const [name, file, text, rule] of SELF_TEST_FIXTURES) {
    const hits = scanText(file, text, SELF_TEST_KNOWN);
    if (!hits.some((v) => v.rule === rule)) {
      console.error(`::error::self-test: seeded violation NOT caught: ${name} (expected rule "${rule}", got ${JSON.stringify(hits.map((h) => h.rule))})`);
      failed = true;
    }
  }
  for (const [name, file, text] of SELF_TEST_CLEAN) {
    const hits = scanText(file, text, SELF_TEST_KNOWN);
    if (hits.length > 0) {
      console.error(`::error::self-test: clean sample flagged (${name}): [${hits[0].rule}] ${hits[0].detail}`);
      failed = true;
    }
  }
  for (const [name, file, text, rule] of SELF_TEST_MESSAGE_FIXTURES) {
    const hits = scanMessages(file, text);
    if (!hits.some((v) => v.rule === rule)) {
      console.error(`::error::self-test: seeded violation NOT caught: ${name} (expected rule "${rule}", got ${JSON.stringify(hits.map((h) => h.rule))})`);
      failed = true;
    }
  }
  for (const [name, file, text] of SELF_TEST_MESSAGE_CLEAN) {
    const hits = scanMessages(file, text);
    if (hits.length > 0) {
      console.error(`::error::self-test: clean sample flagged (${name}): [${hits[0].rule}] ${hits[0].detail}`);
      failed = true;
    }
  }
  if (SELF_TEST_KNOWN.get('REPS_LOOKUP_PATH') !== '/api/reps') {
    console.error('::error::self-test: the address-constant collector did not read REPS_LOOKUP_PATH');
    failed = true;
  }
  if (failed) process.exit(1);
  console.log(
    `zip-urls gate self-test: all ${SELF_TEST_FIXTURES.length + SELF_TEST_MESSAGE_FIXTURES.length} seeded violations caught, ${SELF_TEST_CLEAN.length + SELF_TEST_MESSAGE_CLEAN.length} clean samples pass`
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

// No import.meta here: tests/reps-route.unit.spec.ts imports this module, and
// the test runner loads it as CommonJS (the same guard as indexnow-ping.mjs).
if (process.argv[1] && process.argv[1].endsWith('check-zip-urls.mjs')) {
  main();
}

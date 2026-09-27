/**
 * Client-bundle gate: what actually shipped to the browser, measured after
 * `next build` (the 2026-09-27 audit, card a6).
 *
 * Two rules over every JavaScript file under .next/static/chunks/, the
 * directory the browser downloads from:
 *
 *   1. NO CORPUS TEXT. No chunk may carry content from data/. The markers are
 *      read from data/*.json at check time (40-character runs of plain prose
 *      from the middle of the files' own long string values), so they follow
 *      the nightly data instead of pinning a slug that will rot; two
 *      structural markers of the bill corpus's JSON shape back them up.
 *   2. SIZE BUDGET. No single chunk may exceed CHUNK_BUDGET_BYTES
 *      uncompressed. The number comes from the 2026-09-27 measurement: the
 *      largest legitimate chunk is React DOM at 232,557 bytes, the next is
 *      204,307, and the corpus chunk this gate exists to stop was 23,279,372.
 *      300 KB leaves React DOM about 30% of headroom and would have failed
 *      the corpus chunk by a factor of 75. A data file with no prose (the
 *      ZIP table is numbers) cannot be caught by rule 1; at 1.7 MB it cannot
 *      pass rule 2 either.
 *
 * scripts/check-client-imports.mjs is the pre-build half: it names the import
 * chain before anything is built. This half is the ground truth — it reads
 * the bundler's output, so a path the import walk cannot see (a package, a
 * bundler setting, a data directory that moved) still fails here.
 *
 * CI runs it right after the E2E step, which is the step that builds the
 * app (playwright.config.ts's webServer runs `npm run build`).
 *
 *   node scripts/check-client-bundle.mjs              check .next/static/chunks
 *   node scripts/check-client-bundle.mjs --self-test  prove the rules still bite
 *   node scripts/check-client-bundle.mjs --dir <path> check another chunk dir
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

/* Run from the repository root, as CI does. No `import.meta` here, for the
   reason scripts/check-client-imports.mjs gives at the same line. */
const REPO = process.cwd();

/** 300 KB, uncompressed. See the header for the measurement behind it. */
export const CHUNK_BUDGET_BYTES = 300 * 1024;

/** Length of a prose marker, and how many each data file contributes. */
export const MARKER_LENGTH = 40;
export const MARKERS_PER_FILE = 8;
/**
 * Markers come from the MIDDLE of long strings only. The opening words of a
 * short string are often a stock congressional phrase ("Received in the
 * Senate and referred to the Committee on…") that client code classifying
 * action text could legitimately contain; forty characters from the middle
 * of a 100-character-plus summary or verbatim record passage cannot be in
 * code by accident. Keeps a nightly data change from turning into a red
 * build on an unrelated PR.
 */
export const MIN_SOURCE_LENGTH = 100;
export const SKIP_LEADING_CHARS = 40;

/**
 * The bill corpus's JSON shape, as a bundler inlines it
 * (`JSON.parse('[{"full_identifier":"…","congress_number":119,…')`). No
 * client code has a reason to contain either key in JSON form.
 */
export const STRUCTURAL_MARKERS = [
  { source: 'data/bills.json (shape)', text: '"full_identifier":"' },
  { source: 'data/bills.json (shape)', text: '"ai_summary":"' },
];

/* Letters, digits and single spaces only: survives every escaping a bundler
   can apply to a string literal (quotes, backslashes and non-ASCII are the
   characters that get rewritten), so a marker found in data is found
   verbatim in a chunk that inlined it. */
const PROSE_RUN = new RegExp(`[A-Za-z0-9]+(?: [A-Za-z0-9]+){5,}`, 'g');

function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

/**
 * Up to MARKERS_PER_FILE distinct prose markers from one parsed data file,
 * spread evenly across the file so a partial leak (one slice of a corpus)
 * is still likely to be caught. Deterministic for a given file.
 */
export function markersFromData(source, parsed) {
  const candidates = [];
  const seen = new Set();
  for (const s of collectStrings(parsed, [])) {
    if (s.length < MIN_SOURCE_LENGTH) continue;
    for (const match of s.slice(SKIP_LEADING_CHARS).matchAll(PROSE_RUN)) {
      if (match[0].length < MARKER_LENGTH) continue;
      const text = match[0].slice(0, MARKER_LENGTH);
      if (!seen.has(text)) {
        seen.add(text);
        candidates.push(text);
      }
      break; // one marker per string value is plenty
    }
  }
  if (candidates.length <= MARKERS_PER_FILE) return candidates.map((text) => ({ source, text }));
  const picked = [];
  for (let i = 0; i < MARKERS_PER_FILE; i++) {
    picked.push({ source, text: candidates[Math.floor((i * candidates.length) / MARKERS_PER_FILE)] });
  }
  return picked;
}

/** The first-party source a client chunk is legitimately built from. */
const SOURCE_DIRS = ['app', 'components', 'lib', 'i18n', 'messages'];

function firstPartySource(repo) {
  const parts = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(tsx?|mjs|cjs|jsx?|json)$/.test(entry.name)) parts.push(readFileSync(abs, 'utf8'));
    }
  };
  for (const dir of SOURCE_DIRS) walk(join(repo, dir));
  return parts.join('\n');
}

/**
 * Markers for every data/*.json in the repository, plus the structural ones.
 * A marker that also appears in first-party source is dropped: code (a
 * classifier regex, a test fixture, a comment) may quote the record, and a
 * chunk built from that code is not a leak. That makes a false positive from
 * this rule impossible by construction, whatever the nightly data holds.
 */
export function corpusMarkers(repo = REPO) {
  const dataDir = join(repo, 'data');
  const source = firstPartySource(repo);
  const markers = [...STRUCTURAL_MARKERS];
  const withoutProse = [];
  for (const name of readdirSync(dataDir).filter((f) => f.endsWith('.json')).sort()) {
    const parsed = JSON.parse(readFileSync(join(dataDir, name), 'utf8'));
    const found = markersFromData(`data/${name}`, parsed).filter((m) => !source.includes(m.text));
    if (found.length === 0) withoutProse.push(`data/${name}`);
    markers.push(...found);
  }
  return { markers, withoutProse };
}

/** Every .js file under a chunk directory, recursively. */
export function readChunks(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.js')) {
        const bytes = readFileSync(abs);
        out.push({ file: relative(dir, abs), bytes: bytes.length, text: bytes.toString('utf8') });
      }
    }
  };
  walk(dir);
  return out;
}

/** Apply both rules. Pure, so the unit spec can drive it with fixtures. */
export function checkChunks(chunks, markers, budget = CHUNK_BUDGET_BYTES) {
  const failures = [];
  for (const chunk of chunks) {
    if (chunk.bytes > budget) {
      failures.push({
        rule: 'budget',
        file: chunk.file,
        detail: `${chunk.bytes.toLocaleString('en-US')} bytes, over the ${budget.toLocaleString('en-US')}-byte budget`,
      });
    }
    const hits = new Set();
    for (const marker of markers) {
      if (!hits.has(marker.source) && chunk.text.includes(marker.text)) {
        hits.add(marker.source);
        failures.push({ rule: 'corpus', file: chunk.file, detail: `carries text from ${marker.source}: "${marker.text}"` });
      }
    }
  }
  return failures;
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

/* ------------------------------------------------------------------------ */
/* Self-test                                                                 */
/* ------------------------------------------------------------------------ */

function selfTest() {
  const data = {
    bills: [
      {
        full_identifier: 'hr-1-119',
        ai_summary:
          "This bill would change how the program's grants are awarded to states and counties each year, and it would add a yearly report to Congress on where the money went.",
      },
    ],
  };
  const markers = [...STRUCTURAL_MARKERS, ...markersFromData('data/fixture.json', data)];
  const inline = JSON.stringify(data.bills).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const chunk = (file, text, bytes = Buffer.byteLength(text)) => ({ file, text, bytes });
  const cases = [
    { name: 'a chunk that inlines the corpus as JSON.parse(...)', chunk: chunk('a.js', `x.exports=JSON.parse('${inline}')`), rule: 'corpus' },
    {
      name: 'a chunk that inlines corpus prose as an object literal',
      chunk: chunk('b.js', `x.exports=[{id:"hr-1-119",summary:${JSON.stringify(data.bills[0].ai_summary)}}]`),
      rule: 'corpus',
    },
    { name: 'a chunk over the size budget', chunk: chunk('c.js', 'a'.repeat(CHUNK_BUDGET_BYTES + 1)), rule: 'budget' },
  ];
  let failed = false;
  if (markersFromData('data/fixture.json', data).length === 0) {
    console.error('::error::self-test: no prose marker extracted from a fixture that has prose');
    failed = true;
  }
  for (const c of cases) {
    const found = checkChunks([c.chunk], markers);
    if (!found.some((f) => f.rule === c.rule)) {
      console.error(`::error::self-test: seeded violation NOT caught: ${c.name} (expected rule "${c.rule}")`);
      failed = true;
    }
  }
  const clean = [
    chunk('ok.js', 'export function matchMoments(q,t){return t.filter(m=>m.name.includes(q))}'),
    chunk('edge.js', 'b'.repeat(CHUNK_BUDGET_BYTES)),
  ];
  const falsePositives = checkChunks(clean, markers);
  if (falsePositives.length > 0) {
    console.error(`::error::self-test: clean sample failed: ${falsePositives[0].file} ${falsePositives[0].detail}`);
    failed = true;
  }
  if (failed) process.exit(1);
  console.log(`client-bundle gate self-test: all ${cases.length} seeded violations caught, ${clean.length} clean samples pass`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    selfTest();
    return;
  }
  const dirFlag = args.indexOf('--dir');
  const dir = dirFlag >= 0 ? resolve(args[dirFlag + 1]) : join(REPO, '.next/static/chunks');
  if (!existsSync(dir)) {
    console.error(`::error::no client chunks at ${relative(REPO, dir) || dir}; run \`next build\` first (in CI the E2E step builds)`);
    process.exit(1);
  }
  const chunks = readChunks(dir);
  if (chunks.length === 0) {
    console.error(`::error::${relative(REPO, dir)} holds no .js files; the build output is not what this gate expects`);
    process.exit(1);
  }
  const { markers, withoutProse } = corpusMarkers();
  const failures = checkChunks(chunks, markers);

  const sorted = [...chunks].sort((a, b) => b.bytes - a.bytes);
  const total = chunks.reduce((n, c) => n + c.bytes, 0);
  console.log(`client chunks: ${chunks.length} files, ${kb(total)} uncompressed; budget ${kb(CHUNK_BUDGET_BYTES)} per chunk`);
  for (const c of sorted.slice(0, 5)) {
    console.log(`  ${c.file}  ${kb(c.bytes)} (${kb(gzipSync(Buffer.from(c.text)).length)} gzip)`);
  }
  console.log(`corpus markers: ${markers.length} from data/*.json${withoutProse.length ? `; no prose to sample in ${withoutProse.join(', ')} (size budget only)` : ''}`);

  if (failures.length > 0) {
    for (const f of failures) console.error(`::error file=.next/static/chunks/${f.file}::[${f.rule}] ${f.file}: ${f.detail}`);
    console.error(
      `\n${failures.length} failure(s). If a chunk carries data/, find the import chain with \`node scripts/check-client-imports.mjs\`; the fix is to pass the data as props from a server component.`
    );
    process.exit(1);
  }
  console.log('client-bundle gate clean: no chunk carries data/ text, none exceeds the budget');
}

if (/(^|\/)check-client-bundle\.mjs$/.test(process.argv[1] ?? '')) {
  main();
}

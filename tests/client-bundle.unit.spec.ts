import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

import {
  diskHost,
  findViolations,
  isClientModule,
  memoryHost,
  valueImportSpecifiers,
} from '../scripts/check-client-imports.mjs';
import {
  CHUNK_BUDGET_BYTES,
  MARKER_LENGTH,
  MARKERS_PER_FILE,
  checkChunks,
  corpusMarkers,
  markersFromData,
} from '../scripts/check-client-bundle.mjs';
import { matchMoments as fromSearch } from '../lib/moments-search';
import { matchMoments as fromUi } from '../lib/moments-ui';

/*
 * THE CORPUS STAYS ON THE SERVER (2026-09-27 audit, card a6).
 *
 * components/BillsBrowser.tsx is a client component. It imported one pure
 * function, `matchMoments`, from lib/moments-ui.ts, which reads the bill,
 * nomination, Moments and moment-updates corpora at module scope, and the
 * bundler shipped all of it: one 23,279,372-byte chunk that /bills loaded and
 * every page prefetched through its /bills link. These specs pin the fix and
 * the two gates that keep it fixed:
 *
 *   scripts/check-client-imports.mjs  before the build: no 'use client'
 *                                     module may reach data/ by import
 *   scripts/check-client-bundle.mjs   after the build: no chunk carries
 *                                     data/ text or exceeds 300 KB
 *
 * Nothing here names a bill, a slug or an English sentence from the corpus.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const runGate = (script: string, ...args: string[]) =>
  spawnSync('node', [script, ...args], { cwd: process.cwd(), encoding: 'utf8' });

test.describe('the fix: the browser gets the matcher, never the corpus', () => {
  test('the bills browser is a client module and imports the matcher from the import-free module', () => {
    const src = read('components/BillsBrowser.tsx');
    expect(isClientModule('components/BillsBrowser.tsx', src)).toBe(true);
    const specs = valueImportSpecifiers('components/BillsBrowser.tsx', src);
    expect(specs).toContain('@/lib/moments-search');
    expect(specs).not.toContain('@/lib/moments-ui');
  });

  test('lib/moments-search.ts imports nothing at all', () => {
    const src = read('lib/moments-search.ts');
    expect(valueImportSpecifiers('lib/moments-search.ts', src)).toEqual([]);
    expect(src).not.toMatch(/^\s*import\s/m);
  });

  test('lib/moments-ui.ts re-exports the same matcher, so server callers see one function', () => {
    expect(fromUi).toBe(fromSearch);
  });
});

test.describe('client-import gate (pre-build)', () => {
  test('the shipped tree is clean and the scan actually found client modules', () => {
    const result = runGate('scripts/check-client-imports.mjs');
    expect(result.stderr, 'gate must report no violations').toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/client-import gate clean: \d+ 'use client' modules/);
    const { clientRoots, violations } = findViolations(diskHost());
    expect(clientRoots.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  test('the gate still has teeth: every seeded violation is caught, every clean sample passes', () => {
    const result = runGate('scripts/check-client-imports.mjs', '--self-test');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/all \d+ seeded violations caught, \d+ clean samples pass/);
  });

  test('the 2026-09-27 shape is caught with its whole import chain', () => {
    const { violations } = findViolations(
      memoryHost({
        'data/bills.json': '[]',
        'lib/corpus.ts': "import bills from '@/data/bills.json';\nexport const all = () => bills;\n",
        'lib/ui.ts': "import { all } from './corpus';\nexport const match = (q: string) => q.length > 1 && all().length > 0;\n",
        'components/Browser.tsx': "'use client';\nimport { match } from '@/lib/ui';\nexport const B = () => match('x');\n",
      })
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].chain).toEqual(['components/Browser.tsx', 'lib/ui.ts', 'lib/corpus.ts', 'data/bills.json']);
  });

  test('only the directive prologue makes a client module', () => {
    expect(isClientModule('a.tsx', "/* header */\n'use client';\nexport {};\n")).toBe(true);
    expect(isClientModule('a.tsx', '"use strict";\n"use client";\nexport {};\n')).toBe(true);
    expect(isClientModule('a.tsx', "import x from 'y';\n'use client';\n")).toBe(false);
    expect(isClientModule('a.tsx', "// 'use client'\nexport const x = 1;\n")).toBe(false);
  });

  test('type-only imports are erased; every value path is followed', () => {
    const src = [
      "import type { A } from './types-a';",
      "import { type B } from './types-b';",
      "import { c, type C } from './mixed';",
      "import './side-effect';",
      "export { d } from './reexport';",
      "export type { E } from './types-e';",
      "const lazy = () => import('./lazy');",
      "const req = require('./required');",
    ].join('\n');
    expect(valueImportSpecifiers('x.ts', src).sort()).toEqual(
      ['./lazy', './mixed', './reexport', './required', './side-effect'].sort()
    );
  });
});

test.describe('client-bundle gate (post-build)', () => {
  test('the gate still has teeth: seeded corpus chunks and an oversize chunk are caught', () => {
    const result = runGate('scripts/check-client-bundle.mjs', '--self-test');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/all \d+ seeded violations caught, \d+ clean samples pass/);
  });

  test('the budget is 300 KB uncompressed, and it is inclusive', () => {
    // Measured 2026-09-27: React DOM, the largest legitimate chunk, is
    // 232,557 bytes; the corpus chunk was 23,279,372.
    expect(CHUNK_BUDGET_BYTES).toBe(300 * 1024);
    const chunk = (bytes: number) => ({ file: `${bytes}.js`, bytes, text: '' });
    expect(checkChunks([chunk(CHUNK_BUDGET_BYTES)], [])).toEqual([]);
    const over = checkChunks([chunk(CHUNK_BUDGET_BYTES + 1)], []);
    expect(over.map((f) => f.rule)).toEqual(['budget']);
  });

  test('markers are 40-character prose runs from the middle of long strings, deterministic and capped', () => {
    const long = (n: number) =>
      `Opening words of a stock phrase here then ${'distinctive content word '.repeat(4)}number ${n} closes the passage.`;
    const data = { rows: Array.from({ length: 30 }, (_, i) => ({ text: long(i), short: 'Received in the Senate.' })) };
    const markers = markersFromData('data/x.json', data);
    expect(markers.length).toBeGreaterThan(0);
    expect(markers.length).toBeLessThanOrEqual(MARKERS_PER_FILE);
    for (const m of markers) {
      expect(m.text).toHaveLength(MARKER_LENGTH);
      expect(m.text).toMatch(/^[A-Za-z0-9 ]+$/);
      expect(m.text.startsWith('Opening words')).toBe(false);
    }
    expect(markersFromData('data/x.json', data)).toEqual(markers);
    // Short strings contribute nothing, however many there are.
    expect(markersFromData('data/y.json', { rows: Array(50).fill('Received in the Senate and referred to the Committee.') })).toEqual([]);
  });

  test('a chunk that inlines a data string is caught whatever escaping the bundler applied', () => {
    const summary =
      'Opening clause of the summary, then the part that matters: "quoted" words and an apostrophe\'s turn, followed by a long plain run of ordinary words that any bundler leaves alone';
    const markers = markersFromData('data/bills.json', [{ ai_summary: summary }]);
    expect(markers.length).toBeGreaterThan(0);
    const asJsonParse = `e.exports=JSON.parse('${JSON.stringify([{ ai_summary: summary }]).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')`;
    const failures = checkChunks([{ file: 'corpus.js', bytes: asJsonParse.length, text: asJsonParse }], markers);
    expect(failures.map((f) => f.rule)).toContain('corpus');
  });

  test('the real corpus yields markers, and none of them appears in first-party source', () => {
    const { markers } = corpusMarkers();
    const sources = new Set(markers.map((m) => m.source));
    expect(sources).toContain('data/bills.json');
    expect(sources).toContain('data/bills-es.json');
    const component = read('components/BillsBrowser.tsx') + read('lib/moments-ui.ts');
    for (const m of markers) {
      if (m.source.endsWith('(shape)')) continue;
      expect(component.includes(m.text), `${m.source}: "${m.text}"`).toBe(false);
    }
  });
});

test.describe('CI wiring', () => {
  const ci = read('.github/workflows/ci.yml');
  const stepAt = (name: string) => {
    const at = ci.indexOf(`- name: ${name}`);
    expect(at, `step "${name}" not found in ci.yml`).toBeGreaterThan(0);
    return at;
  };
  const stepBody = (name: string) => {
    const rest = ci.slice(stepAt(name));
    const next = rest.slice(1).search(/\n {6}- (name:|uses:)/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };

  test('the import gate runs self-test first, then the scan, before the build', () => {
    const body = stepBody("Client-import gate (no 'use client' module may reach data/)");
    const selfTestAt = body.search(/node scripts\/check-client-imports\.mjs --self-test$/m);
    const scanAt = body.search(/node scripts\/check-client-imports\.mjs$/m);
    expect(selfTestAt).toBeGreaterThan(0);
    expect(scanAt).toBeGreaterThan(selfTestAt);
    expect(stepAt("Client-import gate (no 'use client' module may reach data/)")).toBeLessThan(
      stepAt('E2E (builds the app via webServer)')
    );
  });

  test('the bundle gate runs after the step that builds, and still reports when an unrelated spec is red', () => {
    const name = 'Client bundle gate (no data/ text in client JS, no chunk over 300 KB)';
    expect(stepAt(name)).toBeGreaterThan(stepAt('E2E (builds the app via webServer)'));
    const body = stepBody(name);
    expect(body).toContain('!cancelled()');
    expect(body).toContain("steps.paths.outputs.docs_only != 'true'");
    const selfTestAt = body.search(/node scripts\/check-client-bundle\.mjs --self-test$/m);
    const scanAt = body.search(/node scripts\/check-client-bundle\.mjs$/m);
    expect(selfTestAt).toBeGreaterThan(0);
    expect(scanAt).toBeGreaterThan(selfTestAt);
  });
});

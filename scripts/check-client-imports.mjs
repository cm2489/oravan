/**
 * Client-import gate: no 'use client' module may reach data/ through its
 * imports (the 2026-09-27 audit, card a6).
 *
 * WHY. Everything a client component imports, and everything THOSE modules
 * import, ships to the browser as JavaScript. On 2026-09-27 the whole of
 * data/ did: components/BillsBrowser.tsx imported one pure function
 * (`matchMoments`) from lib/moments-ui.ts, which reads the bill, nomination,
 * Moments and moment-updates corpora at module scope. The bundler followed
 * the chain and emitted a single 23 MB client chunk that /bills loaded and
 * every other page prefetched through its /bills link. Nothing failed: the
 * page rendered, every test passed, and the homepage took 31.6 s to go idle
 * on a slow connection instead of 1.4 s.
 *
 * WHY NOT `import 'server-only'` in lib/core/bills.ts. That guard fails the
 * Next build when a client module reaches it, which is the right effect, but
 * the bare specifier resolves only inside Next's own bundler. The corpus
 * modules are deliberately plain (see lib/core/bills.ts's header): 23
 * Playwright spec files reach lib/core/bills.ts in plain Node, and the nightly
 * scripts/pregen-scripts.mjs reaches lib/core/bills.ts through tsx. Adding
 * the import fails both with "Cannot find module 'server-only'" (measured
 * 2026-09-27). This gate states the same rule at the boundary where it
 * actually matters, without touching any caller.
 *
 * WHAT IT DOES. Finds every module whose directive prologue says
 * 'use client' under app/, components/, lib/ and i18n/, walks the modules it
 * imports by VALUE (static imports, re-exports, side-effect imports, dynamic
 * `import()` and `require()`), and fails when the walk reaches any file under
 * data/. It prints the full import chain, so the fix is obvious: import the
 * pure piece from a module that does not read the corpus, and pass data in as
 * props from a server component.
 *
 * Type-only imports are skipped (`import type`, `export type`, and a named
 * import whose every binding says `type`), because TypeScript erases them.
 * An import written WITHOUT `type` that is only used as a type is also
 * erased by the compiler, but this gate cannot see usage and counts it; the
 * fix for that false positive is to write `import type`, which is correct
 * anyway. Bare package specifiers are not followed (node_modules is not
 * data/). The post-build half of this rule, which checks what actually
 * shipped, is scripts/check-client-bundle.mjs.
 *
 *   node scripts/check-client-imports.mjs              scan the repo
 *   node scripts/check-client-imports.mjs --self-test  prove the gate still
 *                                                      catches seeded cases
 */
import ts from 'typescript';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/* Run from the repository root, as CI does. No `import.meta` anywhere in this
   file: tests/client-bundle.unit.spec.ts imports it, and Playwright's
   transform turns an .mjs that uses `import.meta` into CJS that Node then
   loads as ESM (see scripts/merge-sync-state.mjs's closing comment). */
const REPO = process.cwd();

/** Where client modules can live. */
export const SCAN_DIRS = ['app', 'components', 'lib', 'i18n'];
/** The corpus directory no client module may reach. Repo-relative, posix. */
export const FORBIDDEN_PREFIX = 'data/';

const SOURCE_FILE = /\.(tsx?|mts|cts|mjs|cjs|jsx?)$/;
const RESOLVE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.mjs',
  '.js',
  '.jsx',
  '.json',
  '/index.ts',
  '/index.tsx',
  '/index.mjs',
  '/index.js',
];

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(mjs|cjs|js)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(file));
}

/**
 * True when the module's directive prologue contains 'use client' — the only
 * place React honors it. A 'use client' string anywhere else (a comment, a
 * later statement) does not make a client module and is not counted.
 */
export function isClientModule(file, text) {
  const sf = parse(file, text);
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) break;
    if (stmt.expression.text === 'use client') return true;
  }
  return false;
}

/** Every specifier this module imports by value (type-only imports skipped). */
export function valueImportSpecifiers(file, text) {
  const sf = parse(file, text);
  const out = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const clause = stmt.importClause;
      if (clause) {
        if (clause.isTypeOnly) continue;
        const named = clause.namedBindings;
        const allTypeNamed =
          !clause.name &&
          named &&
          ts.isNamedImports(named) &&
          named.elements.length > 0 &&
          named.elements.every((el) => el.isTypeOnly);
        if (allTypeNamed) continue;
      }
      out.push(stmt.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      if (stmt.isTypeOnly) continue;
      const clause = stmt.exportClause;
      const allTypeNamed =
        clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly);
      if (allTypeNamed) continue;
      out.push(stmt.moduleSpecifier.text);
    }
  }
  // Dynamic import() and require() anywhere in the file: a lazily loaded
  // chunk is still client JavaScript.
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isDynamicImport || isRequire) out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Resolve a specifier to a repo-relative posix path, or null for a bare
 * package specifier (not followed) or a path that does not exist.
 */
export function resolveSpecifier(fromRel, spec, host) {
  let base;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('./') || spec.startsWith('../')) base = join(dirname(fromRel), spec);
  else return null;
  base = base.split('\\').join('/');
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (host.isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Walk the value-import graph from every client module and return one
 * violation per (client module, data file) pair, each with the shortest
 * import chain that reaches it.
 */
export function findViolations(host) {
  const files = host.list().filter((f) => SOURCE_FILE.test(f));
  const clientRoots = files.filter((f) => isClientModule(f, host.read(f)));
  const violations = [];
  const reachable = new Set();
  for (const rootFile of clientRoots) {
    const parent = new Map([[rootFile, null]]);
    const queue = [rootFile];
    while (queue.length) {
      const current = queue.shift();
      reachable.add(current);
      if (!SOURCE_FILE.test(current)) continue;
      for (const spec of valueImportSpecifiers(current, host.read(current))) {
        const target = resolveSpecifier(current, spec, host);
        if (!target || parent.has(target)) continue;
        parent.set(target, current);
        if (target.startsWith(FORBIDDEN_PREFIX)) {
          const chain = [];
          for (let node = target; node; node = parent.get(node)) chain.unshift(node);
          violations.push({ client: rootFile, data: target, chain });
          continue;
        }
        queue.push(target);
      }
    }
  }
  return { clientRoots, reachable: reachable.size, violations };
}

/** The real repository, read from disk. */
export function diskHost(root = REPO) {
  const cache = new Map();
  const walk = (dirRel, acc) => {
    const abs = join(root, dirRel);
    if (!existsSync(abs)) return acc;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const rel = `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) walk(rel, acc);
      else acc.push(rel);
    }
    return acc;
  };
  return {
    list: () => SCAN_DIRS.flatMap((d) => walk(d, [])),
    read: (rel) => {
      if (!cache.has(rel)) cache.set(rel, readFileSync(join(root, rel), 'utf8'));
      return cache.get(rel);
    },
    isFile: (rel) => {
      const abs = join(root, rel);
      return existsSync(abs) && statSync(abs).isFile();
    },
  };
}

/** An in-memory repository for the self-test and the unit spec. */
export function memoryHost(filesByPath) {
  const map = new Map(Object.entries(filesByPath));
  return {
    list: () => [...map.keys()].filter((f) => SCAN_DIRS.some((d) => f.startsWith(`${d}/`))),
    read: (rel) => map.get(rel),
    isFile: (rel) => map.has(rel),
  };
}

/* ------------------------------------------------------------------------ */
/* Self-test: each seeded case must be caught, each clean case must pass.    */
/* ------------------------------------------------------------------------ */

const CORPUS = {
  'data/bills.json': '[]',
  'lib/corpus.ts': "import bills from '@/data/bills.json';\nexport type Bill = { id: string };\nexport const all = () => bills;\n",
  'lib/pure.ts': 'export const matches = (q: string) => q.length > 1;\n',
};

export const SELF_TEST_VIOLATIONS = [
  {
    name: 'client component imports a data file directly',
    files: { 'components/A.tsx': "'use client';\nimport bills from '@/data/bills.json';\nexport const A = () => bills.length;\n" },
  },
  {
    name: 'the 2026-09-27 shape: a pure function taken from a module that reads the corpus',
    files: {
      'lib/ui.ts': "import { all } from './corpus';\nexport const count = () => all().length;\nexport const match = (q: string) => q.length > 1;\n",
      'components/A.tsx': "'use client';\nimport { match } from '@/lib/ui';\nexport const A = () => match('x');\n",
    },
  },
  {
    name: 'a re-export chain through a barrel',
    files: {
      'lib/index.ts': "export { all } from './corpus';\n",
      'components/A.tsx': '"use client";\nimport { all } from "../lib/index";\nexport const A = () => all();\n',
    },
  },
  {
    name: 'a dynamic import() is still client JavaScript',
    files: { 'components/A.tsx': "'use client';\nexport async function load() { return (await import('@/lib/corpus')).all(); }\n" },
  },
  {
    name: "'use client' after a header comment",
    files: { 'components/A.tsx': "/* header */\n// more\n'use client';\nimport { all } from '@/lib/corpus';\nexport const A = () => all();\n" },
  },
  {
    name: 'a mixed named import (one value binding) is a value import',
    files: { 'components/A.tsx': "'use client';\nimport { all, type Bill } from '@/lib/corpus';\nexport const A = (): Bill[] => all() as Bill[];\n" },
  },
];

export const SELF_TEST_CLEAN = [
  {
    name: 'import type is erased',
    files: { 'components/A.tsx': "'use client';\nimport type { Bill } from '@/lib/corpus';\nexport const A = (b: Bill) => b.id;\n" },
  },
  {
    name: 'a named import whose every binding is a type is erased',
    files: { 'components/A.tsx': "'use client';\nimport { type Bill } from '@/lib/corpus';\nexport const A = (b: Bill) => b.id;\n" },
  },
  {
    name: 'a server component may read the corpus',
    files: { 'app/page.tsx': "import { all } from '@/lib/corpus';\nexport default function Page() { return all().length; }\n" },
  },
  {
    name: 'a client component importing a pure module',
    files: { 'components/A.tsx': "'use client';\nimport { matches } from '@/lib/pure';\nexport const A = () => matches('x');\n" },
  },
  {
    name: "'use client' outside the directive prologue does not make a client module",
    files: { 'components/A.tsx': "import { all } from '@/lib/corpus';\nexport const note = 'use client';\nexport const A = () => all();\n" },
  },
];

function selfTest() {
  let failed = false;
  for (const fixture of SELF_TEST_VIOLATIONS) {
    const { violations } = findViolations(memoryHost({ ...CORPUS, ...fixture.files }));
    if (violations.length === 0) {
      console.error(`::error::self-test: seeded violation NOT caught: ${fixture.name}`);
      failed = true;
    }
  }
  for (const sample of SELF_TEST_CLEAN) {
    const { violations } = findViolations(memoryHost({ ...CORPUS, ...sample.files }));
    if (violations.length > 0) {
      console.error(`::error::self-test: clean sample false-positived: ${sample.name} (${violations[0].chain.join(' -> ')})`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(
    `client-import gate self-test: all ${SELF_TEST_VIOLATIONS.length} seeded violations caught, ${SELF_TEST_CLEAN.length} clean samples pass`
  );
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const { clientRoots, reachable, violations } = findViolations(diskHost());
  // A gate that found no client modules checked nothing; say so loudly
  // rather than print a green line.
  if (clientRoots.length === 0) {
    console.error('::error::client-import gate found no \'use client\' modules; the scan is broken, not clean');
    process.exit(1);
  }
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(
        `::error file=${v.client}::client module reaches ${v.data}, so it ships to the browser: ${v.chain.join(' -> ')}`
      );
    }
    console.error(
      `\n${violations.length} violation(s). Import the pure piece from a module that does not read data/, and pass data in as props from a server component.`
    );
    process.exit(1);
  }
  console.log(
    `client-import gate clean: ${clientRoots.length} 'use client' modules, ${reachable} modules reachable from them, none reaches ${FORBIDDEN_PREFIX}`
  );
}

if (/(^|\/)check-client-imports\.mjs$/.test(process.argv[1] ?? '')) {
  main();
}

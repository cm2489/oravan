/**
 * Stdio MCP entrypoint shim (feat/mcp-stdio-entry).
 *
 *   npx tsx scripts/mcp-stdio.mjs
 *
 * MUST be run through `tsx`, not plain `node`: lib/mcp-stdio.ts's import
 * graph (via lib/core/mcp-tools.ts -> lib/core/mcp.ts) has extensionless
 * relative imports only tsx's esbuild-based resolver handles - same reason
 * scripts/pregen-scripts.mjs names for itself. This file is intentionally a
 * thin shim, same split as that one: Playwright's tests/mcp-stdio.unit.
 * spec.ts spawns THIS script as a subprocess (not `lib/mcp-stdio.ts`
 * directly) so it exercises the exact command a real MCP client config
 * would run.
 *
 * ONE deliberate deviation from pregen-scripts.mjs's own shim pattern
 * (disclosed, not silent): that file does a plain static
 * `import { main } from '../lib/pregen-runner'` at the top of the file.
 * This one can't. lib/core/mcp.ts - reused byte-for-byte, unmodified, by
 * lib/core/mcp-tools.ts per this branch's design - imports lib/freshness.ts,
 * which opens with `import 'server-only'`. That's Next's own bundler-only
 * marker package: Next aliases it to a real module
 * (next/dist/compiled/server-only) inside its webpack/turbopack build
 * graph, but there is no such package resolvable outside that graph
 * (verified directly: a bare `npx tsx` run against lib/core/mcp.ts throws
 * `Error: Cannot find module 'server-only'` via CJS `Module._load` - tsx
 * transpiles this repo's extensionless-import .ts files to CJS `require()`
 * calls under the hood, since package.json carries no `"type": "module"`).
 * A static top-level `import` at the top of THIS file would resolve - and
 * fail on - that whole chain before a single line of this file's own body
 * ever ran: ES module static imports are hoisted ahead of module-body code,
 * in the very same file too. So: patch the resolver first, dynamic-`import`
 * the app code second.
 *
 * The patch below (`Module._resolveFilename`, the same public-ish CJS hook
 * tsconfig-paths/ts-node/jest use for the identical class of "remap one
 * bare specifier for tooling that isn't the bundler" problem) redirects the
 * literal specifier "server-only" - and only that literal specifier, every
 * other request falls through unchanged - to
 * lib/mcp-stdio-server-only-shim.cjs, a real, tiny, committed file this
 * branch adds. Loading it in 'server-only'’s place is exactly what the real
 * `server-only` npm package already IS at runtime *on a server*: a no-op
 * (the package only ever throws when it resolves into a *client* bundle,
 * never the case in a local stdio process). No EXISTING file is modified to
 * make this work - lib/freshness.ts, lib/core/mcp.ts, and tsconfig.json are
 * all untouched, so Next's own production build (which never executes this
 * script) is byte-for-byte unaffected. Not a new npm dependency either: no
 * package.json edit, nothing published, nothing else in the repo ever
 * imports the shim file directly.
 */
import Module from 'node:module';
import { fileURLToPath } from 'node:url';

const shimPath = fileURLToPath(new URL('../lib/mcp-stdio-server-only-shim.cjs', import.meta.url));
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveFilenameWithServerOnlyShim(request, ...rest) {
  if (request === 'server-only') return shimPath;
  return originalResolveFilename.call(this, request, ...rest);
};

const { main } = await import('../lib/mcp-stdio');

main().catch((err) => {
  console.error('::error::mcp-stdio crashed:', err);
  process.exit(1);
});

/**
 * A zero-content stand-in for the 'server-only' bare specifier, used ONLY by
 * scripts/mcp-stdio.mjs's Module._resolveFilename patch — see that file's
 * header comment for the full why. Next.js aliases 'server-only' to a real
 * module (next/dist/compiled/server-only) inside its own webpack/turbopack
 * build graph; outside that graph (plain node, tsx, this stdio process)
 * there is no such package, and lib/core/mcp.ts's import chain reaches
 * lib/freshness.ts's `import 'server-only'` unconditionally. This file
 * being loaded in its place is exactly what the real 'server-only' package
 * already IS at runtime on a server: a no-op. (The real package only ever
 * throws when it resolves into a *client* bundle — never the case here.)
 *
 * Not a new npm dependency: nothing outside this one repo-local file, and
 * nothing outside scripts/mcp-stdio.mjs's own resolver patch, ever
 * references it. Next's production build never executes this file or that
 * patch, so this changes nothing about the real server-only enforcement
 * anywhere else in the app.
 */
module.exports = {};

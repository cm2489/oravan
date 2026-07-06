/*
 * lib/core — the shared data-access layer (S9). Every page AND every future
 * agent surface (the MCP route, later embeds) reads bill/rep data through
 * here, never through data/*.json directly. Pure functions over the baked
 * JSON; no 'server-only' coupling, so a route handler can import it too.
 *
 * This is a pure re-export barrel: it exists so callers who want "everything
 * lib/data.ts used to export" can `import { x } from '@/lib/core'` unchanged,
 * while callers who only need one half (e.g. an MCP tool that's rep-only)
 * can import 'lib/core/reps' or 'lib/core/bills' directly.
 */
export * from './bills';
export * from './reps';
export * from './portraits';

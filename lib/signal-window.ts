/*
 * TS access to the published signal-recency window.
 *
 * The rule itself lives in lib/urgency.mjs, which must stay .mjs because the
 * nightly sync scripts import it directly under node. Components cannot import
 * that file through the `@/` alias — Turbopack resolves the specifier but the
 * named binding comes back undefined at runtime — so this module re-exports it
 * using the relative form that lib/moments.ts already proves works.
 *
 * One rule, one source, two callers: node scripts read urgency.mjs, React reads
 * this.
 */
export { isSignalFresh, SIGNAL_WINDOW_DAYS } from './urgency.mjs';

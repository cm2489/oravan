/*
 * TS access to the published signal-recency window — and, since 2026-08-09,
 * to the read-time urgency score beside it.
 *
 * The rules themselves live in lib/urgency.mjs, which must stay .mjs because the
 * nightly sync scripts import it directly under node. Components cannot import
 * that file through the `@/` alias — Turbopack resolves the specifier but the
 * named binding comes back undefined at runtime — so this module re-exports it
 * using the relative form that lib/moments.ts already proves works.
 *
 * One rule, one source, two callers: node scripts read urgency.mjs, React reads
 * this.
 *
 * `effectiveUrgency` joined the re-export when selectFloorVoteFeature stopped
 * ranking on the STORED `urgency_score` (frozen at sync time — the
 * stale-urgency-freeze bug, docs/solutions/) and started recomputing at read
 * time like every other ranking on the site. lib/core/bills.ts re-exports the
 * same function for its own callers; that module reads the whole bill corpus
 * at module scope, which is exactly what a design primitive must not do — so
 * the component-side door is here.
 *
 * `TERMINAL_STATUSES` joined it on 2026-08-12, for `selectFloorVoteFeature`'s
 * announced branch: a signed or vetoed bill has no floor question left, so no
 * announcement may crown it. `docketRung` already checks terminal FIRST, and
 * that ordering is the rule this re-export lets the selector hold too.
 */
export {
  effectiveUrgency,
  isSignalFresh,
  SIGNAL_WINDOW_DAYS,
  TERMINAL_STATUSES,
} from './urgency.mjs';

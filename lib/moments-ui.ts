/*
 * Presentation-only helpers for the Moments UI. Deliberately separate from
 * lib/moments.ts (the data layer: pure lifecycle computation, gated by
 * scripts/check-moments.mjs and pinned by tests/moments.unit.spec.ts) — this
 * file has no CI gate and no pinned tests of its own, so it stays a thin
 * layer the pages can lean on without touching the tested surface.
 */
import { getBill } from './core/bills';
import type { MomentVehicle } from './moments';

/**
 * A short one-line teaser derived from the moment's full summary — the data
 * model (spec §4.1) has no separate one-liner "dek" field, so the dek is the
 * summary's first sentence. Falls back to the whole string when no sentence
 * boundary is found. Pure string logic; adds no new AI surface.
 */
export function momentDek(summary: string): string {
  const match = summary.match(/^.*?[.!?](?:\s|$)/);
  return (match ? match[0] : summary).trim();
}

/**
 * The most recent last_action_date across a moment's vehicle bills — the
 * "updated" date shown on the index card. Read-time, off the live corpus,
 * like every other freshness signal on the site (never stored). A vehicle
 * slug that doesn't resolve (should never happen past the CI gate)
 * contributes nothing rather than throwing.
 */
export function latestVehicleAction(vehicles: MomentVehicle[]): string | null {
  let latest: string | null = null;
  for (const v of vehicles) {
    const d = getBill(v.slug)?.last_action_date;
    if (d && (!latest || d > latest)) latest = d;
  }
  return latest;
}

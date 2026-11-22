'use client';

/*
 * THE CALL RAIL'S ANSWER, SHARED IN MEMORY — so the vote record's "your
 * members" strip (components/VoteDelegation.tsx) can name the visitor's
 * members without asking anyone for them.
 *
 * WHY THIS EXISTS INSTEAD OF A SECOND LOOKUP. Mapping a ZIP to a House district
 * needs data/zip-districts.json (1.7 MB), which is never shipped to the
 * browser; the only ZIP-to-member path in the product is /api/reps, which
 * components/ActionPanel.tsx already calls on every bill page when a ZIP is
 * saved (disclosed on /privacy, p2). The strip must add NO request of its own
 * — not a second /api/reps call, not a ZIP-prefixed shard fetch — so it reads
 * the rail's already-resolved answer from here instead.
 *
 * Nothing here persists: module memory only, gone on navigation. The ZIP the
 * answer was resolved for is kept beside it so a reader can refuse a stale
 * answer after the visitor changes or erases their ZIP.
 */

import { useSyncExternalStore } from 'react';
import { onErase } from './local';

export interface SharedRep {
  bioguide: string;
  name: string;
  state: string;
  type: 'sen' | 'rep';
}

export interface SharedRepLookup {
  zip: string;
  reps: SharedRep[];
  multiDistrict: boolean;
}

let current: SharedRepLookup | null = null;
const listeners = new Set<() => void>();

// AN ERASE EMPTIES IT (2026-11-19): this tab's, another tab's, or one seen on
// a return from the back/forward cache (lib/local.ts onErase). It was never
// shown for a ZIP no longer saved (readers check), but it stayed in memory
// until the next full load and would have come back for the same ZIP typed
// again.
onErase(() => shareRepLookup(null));

/** Called by the call rail when its /api/reps lookup resolves (or clears). */
export function shareRepLookup(next: SharedRepLookup | null) {
  current = next
    ? {
        zip: next.zip,
        multiDistrict: next.multiDistrict,
        // Only what the strip prints — never phones, offices or party.
        reps: next.reps.map(({ bioguide, name, state, type }) => ({ bioguide, name, state, type })),
      }
    : null;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** What is held now (tests/erase-signal.unit.spec.ts). */
export function sharedRepLookupNow(): SharedRepLookup | null {
  return current;
}

export function useSharedRepLookup(): SharedRepLookup | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  );
}

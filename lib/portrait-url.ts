/*
 * A member's portrait address, in a module of its own so a client component
 * can import it without pulling the whole baked roster (lib/core imports
 * data/*.json at the top). components/RepCard.tsx renders on the client on
 * /reps since the members there are looked up in the browser (2026-11-12,
 * components/RepsLookup.tsx). lib/core/reps.ts re-exports it unchanged.
 */
export function portraitUrl(bioguide: string): string {
  return `https://unitedstates.github.io/images/congress/450x550/${bioguide}.jpg`;
}

/*
 * THE HERO'S SAVED-ZIP BLOCK, as pure data (Home option B, v2 wireframe,
 * 2026-09-29: "Home with a saved ZIP: the same layout. … Only the hero's ZIP
 * block changes … one line naming the three members, then the saved ZIP with
 * Change ZIP code.").
 *
 * CLIENT-SAFE ON PURPOSE: no data import, no lib/core. The block runs in the
 * browser, and the corpus stays out of the browser's JavaScript (#313). The
 * members come from the same stateless /api/reps lookup the bill page's call
 * panel already makes for a saved ZIP; this file only shapes that answer.
 */

/** The fields of an /api/reps member this block reads. */
export interface LookupRep {
  bioguide: string;
  name: string;
  type: 'sen' | 'rep';
  state: string;
  district: number | null;
}

export interface LookupAnswer {
  reps: LookupRep[];
  multiDistrict: boolean;
  vacancies: { state: string; district: number }[];
}

/** Jurisdictions whose House member is a non-voting delegate (resident
 *  commissioner for PR) — the same set components/RepCard.tsx reads. */
const DELEGATE_JURISDICTIONS = new Set(['DC', 'PR', 'GU', 'VI', 'AS', 'MP']);

export type MemberRole = 'senator' | 'delegate' | 'representative';

export function memberRole(rep: Pick<LookupRep, 'type' | 'state'>): MemberRole {
  if (rep.type === 'sen') return 'senator';
  return DELEGATE_JURISDICTIONS.has(rep.state) ? 'delegate' : 'representative';
}

/**
 * Who the line names, in the wireframe's order: senators, then the House
 * member. On a ZIP that spans more than one House district the lookup lists
 * every district's member, and only one of them is the reader's — so the line
 * names the senators alone there and says why on its own line.
 *
 * A ZIP that crosses a STATE line (109 of 33,774 in data/zip-districts.json
 * on 2026-09-29, e.g. 19973, Delaware and Maryland) lists both states'
 * senators, and only two of them are the reader's. The line names nobody
 * there, so the block keeps the ZIP form, which /reps resolves by address.
 */
export function namedMembers(answer: LookupAnswer): LookupRep[] {
  const senators = answer.reps.filter((r) => r.type === 'sen');
  if (new Set(senators.map((r) => r.state)).size > 1) return [];
  if (answer.multiDistrict) return senators;
  return [...senators, ...answer.reps.filter((r) => r.type !== 'sen')];
}

/**
 * The district the saved ZIP resolves to, or null when it spans several (the
 * line then names no district rather than pick one). Read from the House
 * member, or from the vacancy when the seat is empty.
 */
export function savedZipDistrict(answer: LookupAnswer): { state: string; district: number } | null {
  if (answer.multiDistrict) return null;
  const house = answer.reps.find((r) => r.type === 'rep' && r.district !== null);
  if (house) return { state: house.state, district: house.district as number };
  return answer.vacancies[0] ?? null;
}

/** A well-formed /api/reps answer, or null. The block falls back to the ZIP
 *  form on anything else rather than name the wrong people. */
export function readLookup(body: unknown): LookupAnswer | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.reps)) return null;
  const reps = b.reps.filter(
    (r): r is LookupRep =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as LookupRep).bioguide === 'string' &&
      typeof (r as LookupRep).name === 'string' &&
      ((r as LookupRep).type === 'sen' || (r as LookupRep).type === 'rep') &&
      typeof (r as LookupRep).state === 'string'
  );
  const vacancies = Array.isArray(b.vacancies)
    ? b.vacancies.filter(
        (v): v is { state: string; district: number } =>
          typeof v === 'object' &&
          v !== null &&
          typeof (v as { state: unknown }).state === 'string' &&
          typeof (v as { district: unknown }).district === 'number'
      )
    : [];
  return { reps, multiDistrict: b.multiDistrict === true, vacancies };
}

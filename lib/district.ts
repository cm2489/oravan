/*
 * Street-address -> congressional district: parsing for the U.S. Census
 * Bureau geocoder response (geocoding.geo.census.gov). The network call
 * lives in app/api/district; this module is the pure, unit-testable half.
 *
 * Deliberately NOT 'server-only' (like lib/coverage.ts): the parser is
 * imported by tests/district.unit.spec.ts, which pins it against real
 * responses captured live from the geocoder (tests/fixtures/census-*.json).
 */
import type { District } from './types';

/** FIPS state codes -> USPS abbreviations, as used everywhere in data/. */
const FIPS_TO_STATE: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO',
  '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI',
  '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY',
  '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH',
  '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP',
  '72': 'PR', '78': 'VI',
};

export type GeocodeResult =
  /** The address matched and sits in exactly one district. */
  | { status: 'ok'; district: District }
  /** The geocoder found no such address (typo, PO box, new construction). */
  | { status: 'no_match' }
  /** The response wasn't the shape we know - treat as "service unavailable". */
  | { status: 'unrecognized' };

/**
 * Parse a geocoder `geographies/onelineaddress` response into a District.
 * The congressional-districts layer key carries the session number ("119th
 * Congressional Districts"), as does the district-code field (CD119), so
 * both are matched by pattern - a Census vintage bump must not break this.
 */
export function parseCensusResponse(payload: unknown): GeocodeResult {
  const matches = (payload as { result?: { addressMatches?: unknown } } | null)?.result
    ?.addressMatches;
  if (!Array.isArray(matches)) return { status: 'unrecognized' };
  if (matches.length === 0) return { status: 'no_match' };

  const geographies =
    (matches[0] as { geographies?: Record<string, unknown> }).geographies ?? {};
  const layerKey = Object.keys(geographies).find((k) => /congressional districts/i.test(k));
  const layer = layerKey ? geographies[layerKey] : undefined;
  const entry = Array.isArray(layer) ? (layer[0] as Record<string, unknown>) : undefined;
  if (!entry) return { status: 'unrecognized' };

  const state = FIPS_TO_STATE[String(entry.STATE ?? '')];
  const district = districtNumber(entry);
  if (!state || district === null) return { status: 'unrecognized' };
  return { status: 'ok', district: { state, district } };
}

/**
 * The district code lives in a session-suffixed field (CD119, CD120, ...).
 * "00" is an at-large district and "98" a non-voting delegate / resident
 * commissioner seat - both are district 0 in data/zip-districts.json.
 * "ZZ" (water/undefined area) and anything non-numeric parse to null.
 */
function districtNumber(entry: Record<string, unknown>): number | null {
  const key = Object.keys(entry).find((k) => /^CD\d+$/.test(k));
  const code = key ? String(entry[key]) : '';
  if (code === '00' || code === '98') return 0;
  return /^\d+$/.test(code) ? Number(code) : null;
}

/**
 * Parse the `district` query param on /reps ("NY-12"). The param carries
 * only the *derived* district - never the address - so a refined view can
 * be reloaded or shared without any privacy cost beyond the ZIP already
 * in the URL.
 */
export function parseDistrictParam(value: string | undefined | null): District | null {
  const m = /^([A-Z]{2})-(\d{1,2})$/.exec(value ?? '');
  return m ? { state: m[1], district: Number(m[2]) } : null;
}

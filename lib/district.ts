/*
 * Street-address -> congressional district: parsing for the U.S. Census
 * Bureau geocoder response (geocoding.geo.census.gov). The network call
 * lives in app/api/district; this module is the pure, unit-testable half.
 * It also owns the two constants that decide WHICH Congress's map the route
 * asks for, next to the parser that refuses any other Congress's map, so the
 * Jan 3, 2027 swap is one edit in one file.
 *
 * Deliberately NOT 'server-only' (like lib/coverage.ts): the parser is
 * imported by tests/district.unit.spec.ts, which pins it against real
 * responses captured live from the geocoder (tests/fixtures/census-*.json).
 */
import type { District } from './types';

/**
 * The Congress whose House map answers "who represents you now" (Clock 1 in
 * docs/solutions/two-clock-district-boundaries.md). House terms run Jan 3 to
 * Jan 3, so this stays 119 until the 120th Congress is sworn in on
 * Jan 3, 2027, and not a day earlier: before then the 120th map describes
 * the NEXT House, and an address answered from it names a member who does
 * not represent that address yet.
 *
 * The swap is tripwired (lib/rollover-tripwire.mjs, run weekly from
 * refresh-legislators.yml): on Jan 3, 2027 this becomes 120, and
 * CENSUS_VINTAGE below is re-verified live as a vintage whose reply carries
 * the 120th layer.
 */
export const SITTING_CONGRESS = 119;

/**
 * The Census geocoder vintage (benchmark Public_AR_Current) whose
 * congressional layer is SITTING_CONGRESS's map. Verified live 2026-09-28:
 * ACS2025_Current answers with "119th Congressional Districts" (fields
 * GEOID, CDSESSN, STATE, BASENAME; no CD119 field). Current_Current and
 * ACS2026_Current answer with only "120th Congressional Districts", whatever
 * `layers` asks for.
 */
export const CENSUS_VINTAGE = 'ACS2025_Current';

/** The geocoder's layer name for SITTING_CONGRESS's districts. */
export const SITTING_CONGRESS_LAYER = `${ordinal(SITTING_CONGRESS)} Congressional Districts`;

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
  /**
   * The response wasn't the shape we know, or it describes another
   * Congress's map - treat as "service unavailable".
   */
  | { status: 'unrecognized' };

const UNRECOGNIZED: GeocodeResult = { status: 'unrecognized' };

/**
 * Parse a geocoder `geographies/onelineaddress` response into a District.
 *
 * Only `session`'s map is accepted (default SITTING_CONGRESS). The session
 * is read from the layer name ("119th Congressional Districts") and from the
 * entry's CDSESSN field, which must agree where both are present. A reply
 * that carries any other Congress's layer is 'unrecognized': the route
 * answers 502 and the client keeps the all-candidate-districts view.
 * Degrading is fine; naming the wrong member is not. The geocoder ignores
 * `layers` when a vintage lacks the requested layer and answers with the
 * layers it has, so this check is what stands between a Census vintage
 * change and a wrong member.
 */
export function parseCensusResponse(
  payload: unknown,
  session: number = SITTING_CONGRESS
): GeocodeResult {
  const matches = (payload as { result?: { addressMatches?: unknown } } | null)?.result
    ?.addressMatches;
  if (!Array.isArray(matches)) return UNRECOGNIZED;
  if (matches.length === 0) return { status: 'no_match' };

  const geographies =
    (matches[0] as { geographies?: Record<string, unknown> } | null)?.geographies ?? {};
  const layers = Object.entries(geographies).filter(([key]) =>
    /congressional districts/i.test(key)
  );
  if (layers.length === 0) return UNRECOGNIZED;
  for (const [key, layer] of layers) {
    if (layerSession(key, firstEntry(layer)) !== session) return UNRECOGNIZED;
  }

  const entry = firstEntry(layers[0][1]);
  if (!entry) return UNRECOGNIZED;
  const stateFips = String(entry.STATE ?? '');
  const state = FIPS_TO_STATE[stateFips];
  const district = districtNumber(districtCode(entry, session, stateFips));
  if (!state || district === null) return UNRECOGNIZED;
  return { status: 'ok', district: { state, district } };
}

function firstEntry(layer: unknown): Record<string, unknown> | undefined {
  const entry: unknown = Array.isArray(layer) ? layer[0] : undefined;
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined;
}

/**
 * Which Congress a congressional-districts layer describes: from its name
 * ("119th Congressional Districts") and from CDSESSN ("119"). Null when
 * neither says, or when they disagree.
 */
function layerSession(key: string, entry: Record<string, unknown> | undefined): number | null {
  const fromName = /^\s*(\d+)(?:st|nd|rd|th)\s+congressional districts\s*$/i.exec(key)?.[1];
  const fromField = entry?.CDSESSN === undefined ? undefined : String(entry.CDSESSN);
  if (fromField !== undefined && !/^\d+$/.test(fromField)) return null;
  if (fromName !== undefined && fromField !== undefined && Number(fromName) !== Number(fromField)) {
    return null;
  }
  const found = fromName ?? fromField;
  return found === undefined ? null : Number(found);
}

/**
 * The district code, from the first of these that is present:
 *   1. the session-suffixed field (CD119), which Current_Current replies carry;
 *   2. GEOID's last two characters. GEOID is the 2-digit state FIPS plus the
 *      2-character district code ("4837" is TX-37), and its state half must
 *      match STATE. ACS-vintage replies carry GEOID and no CD field;
 *   3. BASENAME ("37"), which is text for at-large seats and so parses to null.
 * Where CD<session> and GEOID are both present they must agree. A reply that
 * contradicts itself returns null rather than a guess.
 */
function districtCode(
  entry: Record<string, unknown>,
  session: number,
  stateFips: string
): string | null {
  let fromGeoid: string | undefined;
  if (entry.GEOID !== undefined) {
    const m = /^(\d{2})([0-9A-Z]{2})$/.exec(String(entry.GEOID));
    if (!m || m[1] !== stateFips) return null;
    fromGeoid = m[2];
  }
  const cd = entry[`CD${session}`];
  if (cd !== undefined) {
    const code = String(cd);
    return fromGeoid === undefined || fromGeoid === code ? code : null;
  }
  if (fromGeoid !== undefined) return fromGeoid;
  return entry.BASENAME === undefined ? null : String(entry.BASENAME);
}

/**
 * "00" is an at-large district and "98" a non-voting delegate / resident
 * commissioner seat - both are district 0 in data/zip-districts.json.
 * "ZZ" (water/undefined area) and anything non-numeric parse to null.
 */
function districtNumber(code: string | null): number | null {
  if (code === '00' || code === '98') return 0;
  return code !== null && /^\d+$/.test(code) ? Number(code) : null;
}

/** 119 -> "119th", 121 -> "121st", 122 -> "122nd", 123 -> "123rd", 111 -> "111th". */
function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
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

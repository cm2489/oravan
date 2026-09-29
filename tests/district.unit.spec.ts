import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// Relative import (not '@/'): lib/district.ts is plain (no 'server-only'),
// so the parser resolves under the test runner - same pattern as coverage.
import {
  CENSUS_VINTAGE,
  SITTING_CONGRESS,
  SITTING_CONGRESS_LAYER,
  parseCensusResponse,
  parseDistrictParam,
} from '../lib/district';
import { POST as districtPost } from '../app/api/district/route';
// Every fixture here is a REAL response captured live from
// geocoding.geo.census.gov (benchmark Public_AR_Current) - the shape is
// pinned, not invented. Two generations of them:
//   - captured 2026-07 from vintage Current_Current, when it still carried
//     "119th Congressional Districts" with a CD119 field: ny12, atLarge,
//     delegate, noMatch;
//   - captured 2026-09-28 from public landmarks: the Texas Capitol (1100
//     Congress Ave, 78701) and the White House. From ACS2025_Current, the
//     vintage the route now asks for, the 119th layer carries GEOID /
//     CDSESSN / STATE / BASENAME and NO CD119 field (acs2025Tx37,
//     acs2025Delegate). From Current_Current, asked for the 119th layer, the
//     reply carries only "120th Congressional Districts" (current120thOnly).
import ny12 from './fixtures/census-district-ny12.json';
import atLarge from './fixtures/census-district-at-large.json';
import delegate from './fixtures/census-district-delegate.json';
import noMatch from './fixtures/census-no-match.json';
import acs2025Tx37 from './fixtures/census-district-acs2025-tx37.json';
import acs2025Delegate from './fixtures/census-district-acs2025-delegate.json';
import current120thOnly from './fixtures/census-district-current-120th-only.json';

type Entry = Record<string, unknown>;

/** A deep copy of a fixture with its (single) congressional-districts entry edited. */
function withEntry(fixture: unknown, edit: (entry: Entry) => void) {
  const copy = structuredClone(fixture) as {
    result: { addressMatches: { geographies: Record<string, Entry[]> }[] };
  };
  const geographies = copy.result.addressMatches[0].geographies;
  const key = Object.keys(geographies).find((k) => /congressional districts/i.test(k))!;
  edit(geographies[key][0]);
  return copy;
}

/** A matched-address reply carrying exactly the given geographies. */
function reply(geographies: Record<string, Entry[]>) {
  return { result: { addressMatches: [{ geographies }] } };
}

test.describe('parseCensusResponse (census geocoder -> district)', () => {
  test('parses a numbered district from a real response (421 8th Ave, 10001 -> NY-12)', () => {
    expect(parseCensusResponse(ny12)).toEqual({
      status: 'ok',
      district: { state: 'NY', district: 12 },
    });
  });

  test("at-large code '00' is district 0, matching data/zip-districts.json (Cheyenne, WY)", () => {
    expect(parseCensusResponse(atLarge)).toEqual({
      status: 'ok',
      district: { state: 'WY', district: 0 },
    });
  });

  test("delegate code '98' is district 0 too (1600 Pennsylvania Ave, DC)", () => {
    expect(parseCensusResponse(delegate)).toEqual({
      status: 'ok',
      district: { state: 'DC', district: 0 },
    });
  });

  test('empty addressMatches means the address does not exist -> no_match', () => {
    expect(parseCensusResponse(noMatch)).toEqual({ status: 'no_match' });
  });

  test('the ACS2025 reply has no CD119 field: the district comes from GEOID (Texas Capitol -> TX-37)', () => {
    // TX-37 is what data/zip-districts.json says for 78701.
    expect(parseCensusResponse(acs2025Tx37)).toEqual({
      status: 'ok',
      district: { state: 'TX', district: 37 },
    });
  });

  test("ACS2025 delegate seat: GEOID '1198' with a text BASENAME is DC district 0", () => {
    expect(parseCensusResponse(acs2025Delegate)).toEqual({
      status: 'ok',
      district: { state: 'DC', district: 0 },
    });
  });

  test("a reply with only the 120th Congress's layer is unrecognized, never the next Congress's member", () => {
    // The live bug: the old parser read this reply as TX-10.
    expect(parseCensusResponse(current120thOnly)).toEqual({ status: 'unrecognized' });
  });

  test('the Jan 3, 2027 swap is the session constant: the same 120th reply parses once the session is 120', () => {
    expect(parseCensusResponse(current120thOnly, 120)).toEqual({
      status: 'ok',
      district: { state: 'TX', district: 10 },
    });
    // ...and from then on the 119th map is the one refused.
    expect(parseCensusResponse(acs2025Tx37, 120)).toEqual({ status: 'unrecognized' });
  });

  test("a reply carrying the sitting layer AND another Congress's layer is unrecognized", () => {
    const both = structuredClone(acs2025Tx37) as {
      result: { addressMatches: { geographies: Record<string, unknown> }[] };
    };
    both.result.addressMatches[0].geographies['120th Congressional Districts'] =
      current120thOnly.result.addressMatches[0].geographies['120th Congressional Districts'];
    expect(parseCensusResponse(both)).toEqual({ status: 'unrecognized' });
  });

  test('the layer name and CDSESSN must agree; with neither, the session is unknown', () => {
    expect(parseCensusResponse(withEntry(ny12, (e) => (e.CDSESSN = '120')))).toEqual({
      status: 'unrecognized',
    });
    // A layer name without a session number falls back to CDSESSN.
    expect(
      parseCensusResponse(reply({ 'Congressional Districts': [{ STATE: '48', CDSESSN: '119', GEOID: '4837' }] }))
    ).toEqual({ status: 'ok', district: { state: 'TX', district: 37 } });
    expect(
      parseCensusResponse(reply({ 'Congressional Districts': [{ STATE: '48', GEOID: '4837' }] }))
    ).toEqual({ status: 'unrecognized' });
  });

  test('GEOID must agree with STATE, and with CD119 where both are present', () => {
    expect(parseCensusResponse(withEntry(ny12, (e) => (e.GEOID = '3412')))).toEqual({
      status: 'unrecognized',
    });
    expect(parseCensusResponse(withEntry(ny12, (e) => (e.GEOID = '3613')))).toEqual({
      status: 'unrecognized',
    });
    expect(parseCensusResponse(withEntry(acs2025Tx37, (e) => (e.GEOID = '4937')))).toEqual({
      status: 'unrecognized',
    });
  });

  test("at-large '00' also reads from GEOID when there is no CD field (Cheyenne, WY)", () => {
    expect(parseCensusResponse(withEntry(atLarge, (e) => delete e.CD119))).toEqual({
      status: 'ok',
      district: { state: 'WY', district: 0 },
    });
  });

  test('BASENAME is the last resort, and a text BASENAME is not a district', () => {
    expect(
      parseCensusResponse(
        reply({ '119th Congressional Districts': [{ STATE: '48', CDSESSN: '119', BASENAME: '37' }] })
      )
    ).toEqual({ status: 'ok', district: { state: 'TX', district: 37 } });
    expect(
      parseCensusResponse(
        reply({
          '119th Congressional Districts': [
            { STATE: '56', CDSESSN: '119', BASENAME: 'Congressional District (at Large)' },
          ],
        })
      )
    ).toEqual({ status: 'unrecognized' });
  });

  test('unknown shapes degrade to unrecognized, never throw', () => {
    expect(parseCensusResponse(null)).toEqual({ status: 'unrecognized' });
    expect(parseCensusResponse({})).toEqual({ status: 'unrecognized' });
    expect(parseCensusResponse({ result: {} })).toEqual({ status: 'unrecognized' });
    expect(parseCensusResponse({ result: { addressMatches: [null] } })).toEqual({
      status: 'unrecognized',
    });
    // matched address but no congressional-districts layer
    expect(
      parseCensusResponse({ result: { addressMatches: [{ geographies: { States: [{}] } }] } })
    ).toEqual({ status: 'unrecognized' });
    // CD code 'ZZ' (undefined area) is not a district
    expect(
      parseCensusResponse({
        result: {
          addressMatches: [
            { geographies: { '119th Congressional Districts': [{ STATE: '36', CD119: 'ZZ' }] } },
          ],
        },
      })
    ).toEqual({ status: 'unrecognized' });
  });
});

test.describe('the sitting Congress (Clock 1, docs/solutions/two-clock-district-boundaries.md)', () => {
  test('pinned to the 119th until Jan 3, 2027, asked of a vintage that carries it', () => {
    // Changing any of these is the rollover swap: land it on Jan 3, 2027,
    // re-verify the vintage live, and refresh the fixtures above
    // (lib/rollover-tripwire.mjs says the same when its window opens).
    expect(SITTING_CONGRESS).toBe(119);
    expect(SITTING_CONGRESS_LAYER).toBe('119th Congressional Districts');
    expect(CENSUS_VINTAGE).toBe('ACS2025_Current');
  });

  test('the route asks for exactly these, and no literal of its own', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/district/route.ts'), 'utf8');
    const query = /const CENSUS_QUERY = \{([\s\S]*?)\};/.exec(source)?.[1];
    expect(query, 'CENSUS_QUERY must still be findable').toBeTruthy();
    expect(query).toMatch(/vintage: CENSUS_VINTAGE,/);
    expect(query).toMatch(/layers: SITTING_CONGRESS_LAYER,/);
    expect(query).not.toMatch(/Congressional Districts|Current_Current/);
  });
});

test.describe('the route degrades instead of naming a wrong member', () => {
  // The real handler, with only the Census edge stubbed. No Upstash env is
  // set, so the limiter runs in memory; each test uses its own caller IP.
  async function callRoute(censusReply: unknown, ip: string) {
    const realFetch = globalThis.fetch;
    const sent: URLSearchParams[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://geocoding.geo.census.gov/')) {
        throw new Error(`unexpected fetch in unit test: ${url.split('?')[0]}`);
      }
      sent.push(new URLSearchParams(init?.body ? String(init.body) : new URL(url).search));
      return new Response(JSON.stringify(censusReply), { status: 200 });
    }) as typeof fetch;
    try {
      const res = await districtPost(
        new Request('http://localhost/api/district', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
          body: JSON.stringify({ address: '1100 Congress Ave', zip: '78701' }),
        }) as never
      );
      return { status: res.status, body: await res.json(), sent };
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  test("the sitting Congress's reply answers with its district", async () => {
    const { status, body, sent } = await callRoute(acs2025Tx37, '198.51.100.71');
    expect(status).toBe(200);
    expect(body).toEqual({ state: 'TX', district: 37 });
    expect(sent).toHaveLength(1);
    expect(sent[0].get('vintage')).toBe('ACS2025_Current');
    expect(sent[0].get('layers')).toBe('119th Congressional Districts');
  });

  test("a reply carrying only the next Congress's map is a 502, so the client keeps every candidate district", async () => {
    const { status, body } = await callRoute(current120thOnly, '198.51.100.72');
    expect(status).toBe(502);
    expect(body).toEqual({ error: 'unavailable' });
  });
});

test.describe('parseDistrictParam (?district=NY-12 on /reps)', () => {
  test('accepts STATE-NUMBER, including at-large 0', () => {
    expect(parseDistrictParam('NY-12')).toEqual({ state: 'NY', district: 12 });
    expect(parseDistrictParam('WY-0')).toEqual({ state: 'WY', district: 0 });
  });

  test('rejects anything else', () => {
    expect(parseDistrictParam(undefined)).toBeNull();
    expect(parseDistrictParam('')).toBeNull();
    expect(parseDistrictParam('ny-12')).toBeNull();
    expect(parseDistrictParam('NY-123')).toBeNull();
    expect(parseDistrictParam('NY12')).toBeNull();
    expect(parseDistrictParam('NEW-1')).toBeNull();
    expect(parseDistrictParam('NY-12-extra')).toBeNull();
  });
});

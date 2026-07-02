import { expect, test } from '@playwright/test';
// Relative import (not '@/'): lib/district.ts is plain (no 'server-only'),
// so the parser resolves under the test runner - same pattern as coverage.
import { parseCensusResponse, parseDistrictParam } from '../lib/district';
// All four fixtures are REAL responses captured live from
// geocoding.geo.census.gov (Public_AR_Current / Current_Current, layer
// "119th Congressional Districts") - the shape is pinned, not invented.
import ny12 from './fixtures/census-district-ny12.json';
import atLarge from './fixtures/census-district-at-large.json';
import delegate from './fixtures/census-district-delegate.json';
import noMatch from './fixtures/census-no-match.json';

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

  test('a future Congress vintage (layer + CD field renamed) still parses', () => {
    // When the Census bumps the vintage, "119th Congressional Districts"
    // becomes "120th ..." and CD119 becomes CD120. The parser matches both
    // by pattern, so only the request string in the API route needs a bump.
    const next = JSON.parse(
      JSON.stringify(ny12).replaceAll('119th Congressional Districts', '120th Congressional Districts').replaceAll('"CD119"', '"CD120"')
    );
    expect(parseCensusResponse(next)).toEqual({
      status: 'ok',
      district: { state: 'NY', district: 12 },
    });
  });

  test('unknown shapes degrade to unrecognized, never throw', () => {
    expect(parseCensusResponse(null)).toEqual({ status: 'unrecognized' });
    expect(parseCensusResponse({})).toEqual({ status: 'unrecognized' });
    expect(parseCensusResponse({ result: {} })).toEqual({ status: 'unrecognized' });
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

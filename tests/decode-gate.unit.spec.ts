import { expect, test } from '@playwright/test';
// Pure, I/O-free module (no CONGRESS_API_KEY/ANTHROPIC_API_KEY needed) - see
// scripts/decode-gate.mjs's header comment for the full status-distribution
// numbers and the reasoning behind the chosen gate line.
import { GATE_PASS_STATUSES, parseForceSlugs, passesGate } from '../scripts/decode-gate.mjs';

/*
 * These tests PIN the priority decode gate's status table. If a status here
 * surprises you, the gate line changed - retune deliberately and update the
 * distribution-numbers comment in decode-gate.mjs alongside the pin.
 */

test.describe('passesGate (status table)', () => {
  test('committee does NOT pass - mere referral dominates this bucket (92.2% sampled)', () => {
    expect(passesGate('committee')).toBe(false);
  });

  test('markup and later all pass - real legislative motion', () => {
    expect(passesGate('markup')).toBe(true);
    expect(passesGate('floor_vote')).toBe(true);
    expect(passesGate('passed_chamber')).toBe(true);
    expect(passesGate('conference')).toBe(true);
    expect(passesGate('signed')).toBe(true);
    expect(passesGate('vetoed')).toBe(true);
  });

  test('unknown/introduced status does not pass', () => {
    expect(passesGate('introduced')).toBe(false);
    expect(passesGate('some_future_status')).toBe(false);
    expect(passesGate('')).toBe(false);
    expect(passesGate(undefined)).toBe(false);
  });

  test('GATE_PASS_STATUSES is exactly the 6 real-motion statuses', () => {
    expect([...GATE_PASS_STATUSES].sort()).toEqual(
      ['conference', 'floor_vote', 'markup', 'passed_chamber', 'signed', 'vetoed']
    );
  });
});

test.describe('parseForceSlugs', () => {
  test('parses a comma-separated list, trims and lower-cases', () => {
    expect(parseForceSlugs('HR-1234-119, s-45-119 ,hjres-9-119')).toEqual(
      new Set(['hr-1234-119', 's-45-119', 'hjres-9-119'])
    );
  });

  test('empty/undefined/whitespace-only input yields an empty set', () => {
    expect(parseForceSlugs(undefined)).toEqual(new Set());
    expect(parseForceSlugs('')).toEqual(new Set());
    expect(parseForceSlugs('   ')).toEqual(new Set());
  });

  test('drops empty entries from stray commas', () => {
    expect(parseForceSlugs('hr-1-119,,s-2-119,')).toEqual(new Set(['hr-1-119', 's-2-119']));
  });
});

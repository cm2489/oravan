import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { momentDek } from '../lib/moments-ui';
import { isSignalFresh, SIGNAL_WINDOW_DAYS } from '../lib/urgency.mjs';

/*
 * lib/moments-ui.ts shipped with no tests of its own, and it cost us: the
 * first-sentence regex cut on the first abbreviation, so the Iran moment's dek
 * rendered as the bare string "U.S." on /moments, in the homepage strip, and —
 * worst — as the page's own <meta description> and og:description.
 *
 * These pin the two rules that fix stayed on: abbreviations do not end
 * sentences, and a dek is never a fragment.
 */

test.describe('momentDek', () => {
  test('does not cut on an abbreviation', () => {
    expect(momentDek('U.S. forces have been involved in hostilities with Iran.')).toBe(
      'U.S. forces have been involved in hostilities with Iran.'
    );
    expect(momentDek('H.R. 8800 would fund defense for 2027. It passed the House.')).toBe(
      'H.R. 8800 would fund defense for 2027.'
    );
    expect(momentDek('Sen. Smith introduced the measure on Tuesday. It has cosponsors.')).toBe(
      'Sen. Smith introduced the measure on Tuesday.'
    );
  });

  test('still stops at a real sentence boundary', () => {
    expect(momentDek('The House voted to pass it. The Senate has not acted.')).toBe(
      'The House voted to pass it.'
    );
    expect(momentDek('Is this authorized? The measures put that to a vote.')).toBe(
      'Is this authorized?'
    );
  });

  test('falls back to the whole string when there is no boundary', () => {
    expect(momentDek('No terminal punctuation here')).toBe('No terminal punctuation here');
  });

  test('every real moment summary yields more than a fragment, in both locales', () => {
    const moments = JSON.parse(
      readFileSync(join(__dirname, '..', 'data/moments.json'), 'utf8')
    ) as Record<string, { summary: { en: string; es: string } }>;
    const entries = Object.entries(moments.moments ?? moments);
    expect(entries.length).toBeGreaterThan(0);
    for (const [id, m] of entries) {
      for (const locale of ['en', 'es'] as const) {
        const dek = momentDek(m.summary[locale]);
        // The exact shape of the bug: a dek that is only an abbreviation.
        expect(dek, `${id}/${locale} dek is a fragment`).not.toMatch(/^[A-Z.]{2,6}$/);
        expect(dek.length, `${id}/${locale} dek too short`).toBeGreaterThan(20);
      }
    }
  });
});

test.describe('isSignalFresh', () => {
  const now = Date.parse('2026-07-25T00:00:00Z');

  test('accepts a date inside the published window', () => {
    expect(isSignalFresh('2026-07-23', now)).toBe(true);
    expect(isSignalFresh('2026-07-11', now)).toBe(true); // exactly 14 days
  });

  test('rejects a date past the published window', () => {
    // The two that were rendering amber on /moments/iran-war-powers.
    expect(isSignalFresh('2026-06-24', now)).toBe(false);
    expect(isSignalFresh('2026-06-16', now)).toBe(false);
  });

  test('rejects undated signals and accepts future ones', () => {
    expect(isSignalFresh(null, now)).toBe(false);
    expect(isSignalFresh('', now)).toBe(false);
    expect(isSignalFresh('not-a-date', now)).toBe(false);
    expect(isSignalFresh('2026-08-01', now)).toBe(true); // a genuinely scheduled vote
  });

  test('the window matches the number published to users', () => {
    expect(SIGNAL_WINDOW_DAYS).toBe(14);
  });
});

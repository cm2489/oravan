import { expect, test } from '@playwright/test';
import { escapeXml, rfc822 } from '../lib/core/feed-xml';

/*
 * Pins lib/core/feed-xml.ts — the one genuinely new piece of logic the S21
 * tenant feed adds (lib/core/feed.ts itself is a thin reshaping of
 * whatsMoving()'s existing output and can only be exercised as e2e; see
 * tests/tenant-feed.spec.ts's header comment for why: it transitively pulls
 * in `server-only` via lib/freshness.ts, which resolves only inside Next's
 * own bundler, not a direct unit-spec import — confirmed empirically, the
 * same class of gap S19's STATUS entry documented for /api/script).
 */

test.describe('escapeXml', () => {
  test('escapes all five XML-significant characters', () => {
    expect(escapeXml('&')).toBe('&amp;');
    expect(escapeXml('<')).toBe('&lt;');
    expect(escapeXml('>')).toBe('&gt;');
    expect(escapeXml('"')).toBe('&quot;');
    expect(escapeXml("'")).toBe('&apos;');
  });

  test('escapes a hostile combined string safely, no double-escaping, no injection', () => {
    const hostile = `Bill "H.R. 1" & <script>alert('x')</script>`;
    const escaped = escapeXml(hostile);
    expect(escaped).not.toContain('<script>');
    expect(escaped).not.toContain('"');
    expect(escaped).not.toContain("'");
    expect(escaped).toBe('Bill &quot;H.R. 1&quot; &amp; &lt;script&gt;alert(&apos;x&apos;)&lt;/script&gt;');
    // Ampersand escaping must happen first / not re-escape its own output —
    // a naive escaper that runs replacements in the wrong order can turn
    // "&" into "&amp;" and then re-escape that "&" into "&amp;amp;".
    expect(escaped).not.toContain('&amp;amp;');
    expect(escaped).not.toContain('&amp;lt;');
    expect(escaped).not.toContain('&amp;quot;');
  });

  test('plain text with no special characters is unchanged', () => {
    expect(escapeXml('A perfectly ordinary bill title')).toBe('A perfectly ordinary bill title');
  });

  test('empty string round-trips to empty string', () => {
    expect(escapeXml('')).toBe('');
  });
});

test.describe('rfc822', () => {
  test('a valid ISO date string formats as RFC 822', () => {
    const out = rfc822('2026-07-04', '2026-01-01T00:00:00.000Z');
    expect(out).toBe(new Date('2026-07-04').toUTCString());
    expect(out).toMatch(/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
  });

  test('null input falls back to the provided ISO fallback, never throws', () => {
    const fallback = '2026-03-15T12:00:00.000Z';
    expect(rfc822(null, fallback)).toBe(new Date(fallback).toUTCString());
  });

  test('an unparseable date string falls back rather than emitting "Invalid Date"', () => {
    const fallback = '2026-03-15T12:00:00.000Z';
    const out = rfc822('not-a-real-date', fallback);
    expect(out).not.toContain('Invalid Date');
    expect(out).toBe(new Date(fallback).toUTCString());
  });
});

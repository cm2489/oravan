import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from 'next-intl';
import enMessages from '../messages/en.json';
import esMessages from '../messages/es.json';
import { collapseQuietDays, momentDek, revisionReasons } from '../lib/moments-ui';
import type { UpdateDayGroup } from '../lib/moment-updates';
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
    // data/moments.json is keyed by moment id at the root — no wrapper. The
    // defensive `.moments ??` this replaced also broke the type: entries of
    // the union resolved `m` to the inner {en,es}, so `.summary` failed tsc.
    const entries = Object.entries(moments);
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

/*
 * The quiet-run collapse (2026-08 review): ten consecutive "Nothing
 * recorded." rows before the first real event is padding, not information, so
 * consecutive quiet non-today days fold into one spanned row. These pin the
 * rules the render leans on: today NEVER folds (its silence is a different
 * sentence — a structural promise of MomentTimeline), a singleton quiet day
 * renders exactly as before, and every emitted run has count >= 2 — the
 * guarantee both locales' bare-{count} copy ("across {count} days") depends
 * on for its grammar.
 */
test.describe('collapseQuietDays', () => {
  /** A synthetic frame day — input is always timelineDays output, newest
   *  first, so these arrays are written newest first too. */
  const day = (d: string, quiet: boolean, isToday = false): UpdateDayGroup => ({
    day: d,
    updates: [],
    rendered: [],
    overflow: 0,
    quiet,
    isToday,
  });

  test('a quiet today stays its own row; the run behind it collapses', () => {
    const today = day('2026-08-02', true, true);
    const active = day('2026-07-29', false);
    const rows = collapseQuietDays([
      today,
      day('2026-08-01', true),
      day('2026-07-31', true),
      day('2026-07-30', true),
      active,
    ]);
    expect(rows).toEqual([
      { kind: 'day', day: today },
      { kind: 'quietRun', from: '2026-07-30', to: '2026-08-01', count: 3 },
      { kind: 'day', day: active },
    ]);
  });

  test('a singleton quiet day between active days stays a plain day row', () => {
    const a = day('2026-08-01', false);
    const q = day('2026-07-31', true);
    const b = day('2026-07-30', false);
    expect(collapseQuietDays([a, q, b])).toEqual([
      { kind: 'day', day: a },
      { kind: 'day', day: q },
      { kind: 'day', day: b },
    ]);
  });

  test('a run of exactly two collapses, oldest first in the span', () => {
    const rows = collapseQuietDays([
      day('2026-08-01', true),
      day('2026-07-31', true),
      day('2026-07-30', false),
    ]);
    expect(rows[0]).toEqual({ kind: 'quietRun', from: '2026-07-31', to: '2026-08-01', count: 2 });
    const run = rows[0] as Extract<(typeof rows)[number], { kind: 'quietRun' }>;
    expect(run.from < run.to).toBe(true);
  });

  test('no quiet days means no folding — every day passes through in order', () => {
    const days = [day('2026-08-01', false), day('2026-07-31', false), day('2026-07-30', false)];
    expect(collapseQuietDays(days)).toEqual(days.map((d) => ({ kind: 'day', day: d })));
  });

  test('every emitted run has count >= 2 — the bare-{count} copy leans on it', () => {
    const rows = collapseQuietDays([
      day('2026-08-02', true, true),
      day('2026-08-01', true),
      day('2026-07-31', true),
      day('2026-07-30', false),
      day('2026-07-29', true), // singleton — must NOT become a run
      day('2026-07-28', false),
      day('2026-07-27', true),
      day('2026-07-26', true),
    ]);
    const runs = rows.filter((r) => r.kind === 'quietRun');
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(run.count).toBeGreaterThanOrEqual(2);
    // The singleton stayed a day row.
    expect(rows).toContainEqual({ kind: 'day', day: day('2026-07-29', true) });
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

/*
 * The revision-history reason line (pre-launch audit 2026-07-25,
 * constitution-07). It printed `changed_because` verbatim, so production read
 * "Rewritten because seed" in English and the identical, untranslated
 * "Se reescribió porque seed" in Spanish — and the status form would have put
 * 'status:sjres-185-119 committee→floor_vote', raw enum and all, in front of
 * readers.
 *
 * These tests are the reason that cannot come back: every token the collector
 * can write maps to a phrase that renders in the reader's own language, an
 * unknown token maps to nothing at all, and no token text survives into
 * either locale's output.
 */
test.describe('revisionReasons', () => {
  const MESSAGES: Record<'en' | 'es', Record<string, unknown>> = {
    en: enMessages,
    es: esMessages,
  };

  /** What the page actually prints after "Rewritten because" / "Se reescribió
   *  porque" — the real ICU formatter, in the real locale, off the real
   *  message files. The key is composed at runtime here exactly as
   *  app/[locale]/moments/[id]/page.tsx composes it; the cast is what the
   *  page's own untyped `getTranslations` gives it for free. */
  const render = (tokens: string[], locale: 'en' | 'es') => {
    const t = createTranslator({ locale, messages: MESSAGES[locale] }) as unknown as (
      key: string,
      values?: Record<string, number>
    ) => string;
    return revisionReasons(tokens)
      .map((r) => t(`moments.updates.reason.${r.key}`, r.values))
      .join(' · ');
  };

  test('every token the collector can write maps to a reason', () => {
    // scripts/moment-updates.mjs:597 changedBecause, plus the hand-authored
    // 'seed' the live layer shipped with.
    expect(revisionReasons(['first-summary'])).toEqual([{ key: 'first' }]);
    expect(revisionReasons(['seed'])).toEqual([{ key: 'first' }]);
    expect(revisionReasons(['updates:+3'])).toEqual([{ key: 'newActions', values: { count: 3 } }]);
    expect(revisionReasons(['reanchor:12d'])).toEqual([{ key: 'reanchor', values: { days: 12 } }]);
    expect(revisionReasons(['status:sjres-185-119 committee→floor_vote'])).toEqual([
      { key: 'statusMoved' },
    ]);
  });

  test('a known token renders a human phrase, in each locale', () => {
    expect(render(['seed'], 'en')).toBe('no summary of this question existed yet');
    expect(render(['seed'], 'es')).toBe('aún no existía ningún resumen de esta cuestión');

    expect(render(['updates:+1'], 'en')).toBe('1 new action was recorded since the last version');
    expect(render(['updates:+1'], 'es')).toBe('se registró 1 acción nueva desde la versión anterior');
    expect(render(['updates:+2'], 'en')).toBe('2 new actions were recorded since the last version');
    expect(render(['updates:+2'], 'es')).toBe(
      'se registraron 2 acciones nuevas desde la versión anterior'
    );

    expect(render(['reanchor:1d'], 'en')).toBe('1 day had passed since the last version');
    expect(render(['reanchor:12d'], 'es')).toBe('habían pasado 12 días desde la versión anterior');

    expect(render(['status:sjres-185-119 committee→floor_vote'], 'en')).toBe(
      'a bill on this question moved to a different stage'
    );
    expect(render(['status:sjres-185-119 committee→floor_vote'], 'es')).toBe(
      'un proyecto de ley de esta cuestión pasó a otra etapa'
    );
  });

  test('the two locales say it in their own words — never the same string twice', () => {
    for (const token of ['seed', 'updates:+2', 'reanchor:12d', 'status:hr-1-119 a→b']) {
      expect(render([token], 'en')).not.toBe(render([token], 'es'));
    }
  });

  test('an unknown token renders nothing rather than itself', () => {
    // A shape the collector has never emitted, and the shapes it emits with
    // one character wrong — the line disappears, the token never prints.
    for (const token of ['', 'seeded', 'updates:+', 'updates:2', 'reanchor:12', 'statuses:x y→z']) {
      expect(revisionReasons([token]), token).toEqual([]);
      expect(render([token], 'en'), token).toBe('');
      expect(render([token], 'es'), token).toBe('');
    }
    // And a revision that carries one known token beside an unknown one keeps
    // the known phrase and drops only the stranger.
    expect(render(['seed', 'quantum:7'], 'en')).toBe('no summary of this question existed yet');
  });

  test('one event said three times is printed once', () => {
    // The Iran moment's second revision: three vehicles, one stage change.
    expect(
      render(
        [
          'status:sjres-185-119 floor_vote→committee',
          'status:sjres-172-119 floor_vote→committee',
          'status:hr-9770-119 floor_vote→committee',
        ],
        'en'
      )
    ).toBe('a bill on this question moved to a different stage');
  });

  test('the shipped corpus maps completely, and leaks no token text', () => {
    const file = JSON.parse(
      readFileSync(join(__dirname, '..', 'data/moment-updates.json'), 'utf8')
    ) as Record<string, { summary_revisions?: { changed_because: string[] }[] }>;

    const tokens = Object.entries(file)
      .filter(([id]) => id !== '_meta')
      .flatMap(([, entry]) => entry.summary_revisions ?? [])
      .flatMap((rev) => rev.changed_because);
    expect(tokens.length, 'the seeded corpus must carry revision reasons').toBeGreaterThan(0);

    for (const token of tokens) {
      // A token the map has never met would silently cost the reader the
      // whole line — that is a code change owed, not a quiet degradation.
      expect(revisionReasons([token]), `unmapped changed_because token: ${token}`).not.toEqual([]);
      for (const locale of ['en', 'es'] as const) {
        const text = render([token], locale);
        expect(text.length, `${token}/${locale}`).toBeGreaterThan(0);
        expect(text, `${token}/${locale} leaks the token`).not.toContain(token);
        // The status enums the collector keeps out of reader-facing prose.
        expect(text).not.toMatch(/[:→]|floor_vote|committee|introduced|passed_house/);
      }
    }
  });
});

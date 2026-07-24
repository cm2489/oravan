import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Relative import of the import-free gate module (lib/moments-gate.mjs, the
// logic scripts/check-moments.mjs executes in CI) — the checks tested here
// are the checks that gate every moments PR.
import {
  CATEGORIES as GATE_CATEGORIES,
  TERMINAL_VEHICLE_STATUSES,
  checkMoments,
  lintForbidden,
} from '../lib/moments-gate.mjs';
import { CATEGORIES } from '../lib/taxonomy';
import { TERMINAL_STATUSES } from '../lib/urgency.mjs';
import { computeMomentState, getLiveMoments, getMoment, getMoments, isSettled } from '../lib/moments';

/** The exact real-data run the CI gate performs (scripts/check-moments.mjs). */
function checkRepoData() {
  const read = (p: string) => JSON.parse(readFileSync(join(__dirname, '..', p), 'utf8'));
  const moments = read('data/moments.json');
  const bills: { full_identifier: string; status: string }[] = read('data/bills.json');
  const billSlugs = new Set(bills.map((b) => b.full_identifier));
  const statusBySlug = new Map(bills.map((b) => [b.full_identifier, b.status]));
  return checkMoments(moments, billSlugs, (slug: string) => statusBySlug.get(slug));
}

/* ------------------------------------------------------------------ *
 * 1 · The real data/moments.json IS gated by this suite: a moment that
 *     violates the schema, parity, vocabulary, vehicle, or cap rules
 *     fails CI here, exactly like `node scripts/check-moments.mjs`.
 * ------------------------------------------------------------------ */
test.describe('real data/moments.json passes the CI gate', () => {
  test('zero violations against the live corpus', () => {
    const { violations } = checkRepoData();
    expect(violations).toEqual([]);
  });

  test('every curated moment resolves and computes a valid lifecycle state', () => {
    const moments = getMoments();
    expect(moments.length).toBeGreaterThan(0);
    expect(moments.length).toBeLessThanOrEqual(6);
    for (const m of moments) {
      expect(['live', 'settled', 'stale', 'retired']).toContain(m.state);
      expect(m.vehicles.length).toBeGreaterThan(0);
    }
    // Corpus-robust: while review_by has not elapsed, a stored-live moment
    // reads live or (if the corpus has since closed every vehicle) settled —
    // never anything else. Evaluate at the moment's own opened date so the
    // assertion doesn't rot as the real clock passes review_by.
    for (const m of moments.filter((x) => x.status === 'live')) {
      const atOpen = getMoment(m.id, new Date(m.opened).getTime() + 3_600_000);
      expect(atOpen, m.id).toBeDefined();
      expect(['live', 'settled'], m.id).toContain(atOpen!.state);
    }
  });

  test('getLiveMoments is the live-state subset of getMoments', () => {
    const now = Date.now();
    const live = getLiveMoments(now);
    const all = getMoments(now);
    expect(live.every((m) => m.state === 'live')).toBe(true);
    expect(live.length).toBe(all.filter((m) => m.state === 'live').length);
  });

  test('getMoment returns undefined for an unknown id; isSettled is false for it', () => {
    expect(getMoment('not-a-real-moment')).toBeUndefined();
    expect(isSettled('not-a-real-moment')).toBe(false);
  });

  test("the gate's category copy matches lib/taxonomy.ts exactly", () => {
    expect(GATE_CATEGORIES).toEqual([...CATEGORIES]);
  });

  test("the gate's terminal-status copy matches lib/urgency.mjs exactly", () => {
    expect([...TERMINAL_VEHICLE_STATUSES].sort()).toEqual([...TERMINAL_STATUSES].sort());
  });
});

/* ------------------------------------------------------------------ *
 * 2 · Forbidden-vocabulary lint — pinned with example violations in
 *     both languages (the versioned list from the spec §3.3).
 * ------------------------------------------------------------------ */
test.describe('forbidden-vocabulary lint', () => {
  test('flags imperative advocacy verbs in English', () => {
    expect(lintForbidden('Call now to stop this bill', 'en')).toContain('stop');
    expect(lintForbidden('Fight for the future', 'en')).toContain('fight');
    expect(lintForbidden('We must defend the program', 'en')).toContain('defend');
    expect(lintForbidden('Senators blocked the measure', 'en')).toContain('block');
    expect(lintForbidden('Act before it is too late to save it', 'en')).toContain('save');
    expect(lintForbidden('Resisting the rollback', 'en')).toContain('resist');
  });

  test('flags crisis/attack/scheme and adversary party framing in English', () => {
    expect(lintForbidden('a crisis for democracy', 'en')).toContain('crisis');
    expect(lintForbidden('an attack on voters', 'en')).toContain('attack');
    expect(lintForbidden('a scheme to rewrite the rules', 'en')).toContain('scheme');
    expect(lintForbidden('Republicans want to gut the rule', 'en')).toContain('party name');
    expect(lintForbidden('Democrats are trying to protect it', 'en')).toContain('party name');
  });

  test('flags the Spanish equivalents', () => {
    expect(lintForbidden('Hay que detener esta ley', 'es')).toContain('detener');
    expect(lintForbidden('Luchar por el futuro', 'es')).toContain('luchar');
    expect(lintForbidden('Debemos defender el programa', 'es')).toContain('defender');
    expect(lintForbidden('Van a bloquear la medida', 'es')).toContain('bloquear');
    expect(lintForbidden('Una crisis para la democracia', 'es')).toContain('crisis');
    expect(lintForbidden('Un ataque a los votantes', 'es')).toContain('ataque');
    expect(lintForbidden('Los republicanos quieren eliminarla', 'es')).toContain('nombre de partido');
  });

  test('quoted official titles are exempt, in both quote styles', () => {
    expect(lintForbidden('the "Stop Harmful Schemes Act" of 2026', 'en')).toEqual([]);
    expect(lintForbidden('la «Ley para Detener el Fraude» de 2026', 'es')).toEqual([]);
  });

  test('neutral compounds and near-words stay clean', () => {
    expect(lintForbidden('a stopgap funding measure', 'en')).toEqual([]);
    expect(lintForbidden('the defense budget for 2027', 'en')).toEqual([]);
    expect(lintForbidden('salvo que el Congreso apruebe otra medida', 'es')).toEqual([]);
    expect(lintForbidden('equipo defensivo para países socios', 'es')).toEqual([]);
    expect(lintForbidden('el bloque de votación', 'es')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 3 · checkMoments against fixtures — parity, vehicles, schema, cap.
 * ------------------------------------------------------------------ */
const NOW = new Date('2026-07-23T12:00:00Z').getTime();
const SLUGS = new Set(['test-bill-1', 'test-bill-2']);
const FIXTURE_STATUSES: Record<string, string> = {
  'test-bill-1': 'committee',
  'test-bill-2': 'signed',
};
const statusFor = (slug: string): string | undefined => FIXTURE_STATUSES[slug];

const validMoment = () => ({
  name: { en: 'The example question', es: 'La cuestión de ejemplo' },
  summary: {
    en: 'Congress is deciding whether to do the thing.',
    es: 'El Congreso decide si hace la cosa.',
  },
  aliases: { en: ['example'], es: ['ejemplo'] },
  category: 'national_security',
  vehicles: [
    {
      slug: 'test-bill-1',
      role: {
        en: 'A yes vote does one thing; a no vote leaves it unchanged.',
        es: 'Un voto a favor hace una cosa; un voto en contra la deja sin cambios.',
      },
    },
  ],
  qualifying_signal: { type: 'tier0_floor', refs: ['https://www.congress.gov/example'] },
  opened: '2026-07-23',
  review_by: '2026-08-22',
  status: 'live',
});

const run = (moments: Record<string, unknown>) =>
  checkMoments(moments, SLUGS, statusFor, { now: NOW });

test.describe('checkMoments (fixtures)', () => {
  test('a fully valid moment produces zero violations', () => {
    expect(run({ 'example-question': validMoment() }).violations).toEqual([]);
  });

  test('bilingual completeness: a missing ES sibling fails, field by field', () => {
    const noEsSummary = validMoment() as Record<string, unknown>;
    noEsSummary.summary = { en: 'Only English here.' };
    const v1 = run({ m: noEsSummary }).violations;
    expect(v1.some((v: string) => v.includes('m.summary.es'))).toBe(true);

    const noEsRole = validMoment();
    noEsRole.vehicles[0].role = { en: 'English only.' } as { en: string; es: string };
    const v2 = run({ m: noEsRole }).violations;
    expect(v2.some((v: string) => v.includes('m.vehicles[0].role.es'))).toBe(true);

    const emptyEsAliases = validMoment();
    emptyEsAliases.aliases = { en: ['x'], es: [] };
    const v3 = run({ m: emptyEsAliases }).violations;
    expect(v3.some((v: string) => v.includes('m.aliases.es'))).toBe(true);
  });

  test('forbidden vocabulary in moment prose fails, in either language', () => {
    const advocacyEn = validMoment();
    advocacyEn.summary = {
      en: 'Call now to stop this dangerous scheme.',
      es: 'El Congreso decide si hace la cosa.',
    };
    const v1 = run({ m: advocacyEn }).violations;
    expect(v1.some((v: string) => v.includes('m.summary.en') && v.includes('"stop"'))).toBe(true);
    expect(v1.some((v: string) => v.includes('m.summary.en') && v.includes('"scheme"'))).toBe(true);

    const advocacyEs = validMoment();
    advocacyEs.name = { en: 'The example question', es: 'La lucha para salvar el programa' };
    const v2 = run({ m: advocacyEs }).violations;
    expect(v2.some((v: string) => v.includes('m.name.es') && v.includes('"luchar"'))).toBe(true);
    expect(v2.some((v: string) => v.includes('m.name.es') && v.includes('"salvar"'))).toBe(true);
  });

  test('aliases are deliberately NOT vocabulary-linted (search-only, never rendered)', () => {
    const nicknamed = validMoment();
    nicknamed.aliases = { en: ['stop the war', 'death tax'], es: ['detener la guerra'] };
    expect(run({ m: nicknamed }).violations).toEqual([]);
  });

  test('a vehicle slug that does not exist in bills.json fails', () => {
    const ghost = validMoment();
    ghost.vehicles[0].slug = 'ghost-bill-99';
    const v = run({ m: ghost }).violations;
    expect(v.some((x: string) => x.includes('ghost-bill-99') && x.includes('does not exist'))).toBe(true);
  });

  test('an empty vehicles array fails — no moment without a real vehicle', () => {
    const hollow = validMoment() as Record<string, unknown>;
    hollow.vehicles = [];
    const v = run({ m: hollow }).violations;
    expect(v.some((x: string) => x.includes('m.vehicles'))).toBe(true);
  });

  test('schema: bad category, bad signal type, 1-ref press, non-https ref, bad dates, bad status', () => {
    const bad = validMoment() as Record<string, unknown>;
    bad.category = 'foreign_policy';
    bad.qualifying_signal = { type: 'vibes', refs: ['http://example.com'] };
    bad.review_by = 'soon';
    bad.status = 'settled';
    const v = run({ m: bad }).violations;
    expect(v.some((x: string) => x.includes('m.category'))).toBe(true);
    expect(v.some((x: string) => x.includes('qualifying_signal.type'))).toBe(true);
    expect(v.some((x: string) => x.includes('not an https URL'))).toBe(true);
    expect(v.some((x: string) => x.includes('m.review_by'))).toBe(true);
    expect(v.some((x: string) => x.includes('m.status') && x.includes('never stored'))).toBe(true);

    const thinPress = validMoment() as Record<string, unknown>;
    thinPress.qualifying_signal = { type: 'press', refs: ['https://example.com/one'] };
    const v2 = run({ m: thinPress }).violations;
    expect(v2.some((x: string) => x.includes('press signal needs'))).toBe(true);
  });

  test('the live cap is 6 — a seventh live moment fails', () => {
    const seven: Record<string, unknown> = {};
    for (let i = 1; i <= 7; i++) seven[`moment-${i}`] = validMoment();
    const v = run(seven).violations;
    expect(v.some((x: string) => x.includes('the cap is 6'))).toBe(true);

    const six: Record<string, unknown> = {};
    for (let i = 1; i <= 6; i++) six[`moment-${i}`] = validMoment();
    expect(run(six).violations).toEqual([]);
  });

  test('a terminal vehicle is a warning, not a violation (settled moments persist in the file)', () => {
    const settled = validMoment();
    settled.vehicles[0].slug = 'test-bill-2'; // signed
    const { violations, warnings } = run({ m: settled });
    expect(violations).toEqual([]);
    expect(warnings.some((w: string) => w.includes('test-bill-2') && w.includes('terminal'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 4 · Lifecycle computation — pinned with fixture moments. Settled is
 *     computed from TERMINAL_STATUSES at read time, never stored.
 * ------------------------------------------------------------------ */
test.describe('computeMomentState', () => {
  const fixture = (over: Partial<{ status: 'live' | 'retired'; review_by: string; slugs: string[] }> = {}) => ({
    status: over.status ?? ('live' as const),
    review_by: over.review_by ?? '2026-08-22',
    vehicles: (over.slugs ?? ['a']).map((slug) => ({ slug, role: { en: 'x', es: 'x' } })),
  });
  const statuses: Record<string, string> = {
    a: 'committee',
    b: 'floor_vote',
    signedBill: 'signed',
    vetoedBill: 'vetoed',
  };
  const lookup = (slug: string) => statuses[slug];

  test('sanity: the terminal set this file computes against is signed+vetoed', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['signed', 'vetoed']);
  });

  test('live: any non-terminal vehicle and an unexpired review_by', () => {
    expect(computeMomentState(fixture(), lookup, NOW)).toBe('live');
    expect(computeMomentState(fixture({ slugs: ['a', 'signedBill'] }), lookup, NOW)).toBe('live');
  });

  test('settled: EVERY vehicle terminal — signed, vetoed, or mixed', () => {
    expect(computeMomentState(fixture({ slugs: ['signedBill'] }), lookup, NOW)).toBe('settled');
    expect(computeMomentState(fixture({ slugs: ['signedBill', 'vetoedBill'] }), lookup, NOW)).toBe('settled');
  });

  test('settled beats stale: a finished fight reads settled even past review_by', () => {
    const m = fixture({ slugs: ['signedBill'], review_by: '2026-06-01' });
    expect(computeMomentState(m, lookup, NOW)).toBe('settled');
  });

  test('stale: review_by elapsed without renewal; the review_by day itself still counts', () => {
    const endOfReviewDay = new Date('2026-08-22T18:00:00Z').getTime();
    const dayAfter = new Date('2026-08-23T00:00:01Z').getTime();
    expect(computeMomentState(fixture(), lookup, endOfReviewDay)).toBe('live');
    expect(computeMomentState(fixture(), lookup, dayAfter)).toBe('stale');
  });

  test('an unparseable review_by fails toward stale, never toward a false live', () => {
    expect(computeMomentState(fixture({ review_by: 'not-a-date' }), lookup, NOW)).toBe('stale');
  });

  test('retired is the stored owner decision and wins over everything', () => {
    expect(computeMomentState(fixture({ status: 'retired' }), lookup, NOW)).toBe('retired');
    expect(
      computeMomentState(fixture({ status: 'retired', slugs: ['signedBill'] }), lookup, NOW),
    ).toBe('retired');
  });

  test('an unknown vehicle slug can never read as settled (fails toward live)', () => {
    expect(computeMomentState(fixture({ slugs: ['nope'] }), lookup, NOW)).toBe('live');
    expect(computeMomentState(fixture({ slugs: ['signedBill', 'nope'] }), lookup, NOW)).toBe('live');
  });
});

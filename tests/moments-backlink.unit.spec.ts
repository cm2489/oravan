import { expect, test } from '@playwright/test';
import {
  getMomentsForBill,
  getMoments,
  momentsForBill,
  type MomentState,
  type MomentWithState,
} from '../lib/moments';

/*
 * The bill → Moment backlink's visibility rule (repositioning spec §7.2).
 *
 * Same split as tests/moments.unit.spec.ts uses for computeMomentState: the
 * rule itself is pinned with fixtures (a state the corpus does not currently
 * hold — settled, retired — must still be provably invisible), and the
 * corpus binding is asserted separately and corpus-robustly, derived from
 * getMoments() rather than from any hardcoded moment id or bill slug.
 */

/** A moment fixture in a chosen read-time state, shaped like the real thing. */
const fixture = (id: string, state: MomentState, slugs: string[]): MomentWithState => ({
  id,
  name: { en: `The ${id} question`, es: `La cuestión ${id}` },
  summary: {
    en: 'Congress is deciding whether to do the thing.',
    es: 'El Congreso decide si hace la cosa.',
  },
  aliases: { en: ['example'], es: ['ejemplo'] },
  category: 'national_security',
  vehicles: slugs.map((slug) => ({ slug, role: { en: 'x', es: 'x' } })),
  qualifying_signal: { type: 'tier0_floor', refs: ['https://www.congress.gov/example'] },
  opened: '2026-07-23',
  review_by: '2026-08-22',
  // 'settled' is computed, never stored — the stored status behind it is 'live'.
  status: state === 'retired' ? 'retired' : 'live',
  state,
});

const ids = (list: MomentWithState[]) => list.map((m) => m.id);

test.describe('momentsForBill (fixtures): live + stale backlink, settled + retired do not', () => {
  const corpus = [
    fixture('live-one', 'live', ['test-bill-1']),
    fixture('stale-one', 'stale', ['test-bill-1']),
    fixture('settled-one', 'settled', ['test-bill-1']),
    fixture('retired-one', 'retired', ['test-bill-1']),
  ];

  test('a live moment is visible from its vehicle', () => {
    expect(ids(momentsForBill([fixture('m', 'live', ['test-bill-1'])], 'test-bill-1'))).toEqual(['m']);
  });

  test('a stale moment stays visible — the review tripwire caveats the page, it does not hide the route', () => {
    expect(ids(momentsForBill([fixture('m', 'stale', ['test-bill-1'])], 'test-bill-1'))).toEqual(['m']);
  });

  test('a settled moment is invisible — the question is over, the backlink is a live route', () => {
    expect(momentsForBill([fixture('m', 'settled', ['test-bill-1'])], 'test-bill-1')).toEqual([]);
  });

  test('a retired moment is invisible — the stored owner decision takes it off every surface', () => {
    expect(momentsForBill([fixture('m', 'retired', ['test-bill-1'])], 'test-bill-1')).toEqual([]);
  });

  test('mixed states filter down to the live and stale ones, in file order', () => {
    expect(ids(momentsForBill(corpus, 'test-bill-1'))).toEqual(['live-one', 'stale-one']);
  });

  test('a bill that is nobody’s vehicle backlinks to nothing', () => {
    expect(momentsForBill(corpus, 'test-bill-2')).toEqual([]);
  });

  test('slug matching is exact — a prefix or a superstring is a different bill', () => {
    const m = [fixture('m', 'live', ['hr-977-119'])];
    expect(momentsForBill(m, 'hr-97-119')).toEqual([]);
    expect(momentsForBill(m, 'hr-9770-119')).toEqual([]);
    expect(ids(momentsForBill(m, 'hr-977-119'))).toEqual(['m']);
  });

  test('a moment with several vehicles is reachable from each of them', () => {
    const m = [fixture('m', 'live', ['a', 'b', 'c'])];
    for (const slug of ['a', 'b', 'c']) expect(ids(momentsForBill(m, slug))).toEqual(['m']);
  });

  test('a bill carried by two questions backlinks to both', () => {
    const two = [fixture('one', 'live', ['shared']), fixture('two', 'stale', ['shared'])];
    expect(ids(momentsForBill(two, 'shared'))).toEqual(['one', 'two']);
  });
});

test.describe('getMomentsForBill (real corpus): read-time, clock-injectable', () => {
  test('every live or stale moment is reachable from each of its own vehicles', () => {
    const now = Date.now();
    const visible = getMoments(now).filter((m) => m.state === 'live' || m.state === 'stale');
    test.skip(visible.length === 0, 'no live or stale moment in the corpus right now');
    for (const m of visible) {
      for (const v of m.vehicles) {
        expect(ids(getMomentsForBill(v.slug, now)), `${m.id} ← ${v.slug}`).toContain(m.id);
      }
    }
  });

  test('no settled or retired moment leaks into any bill’s backlinks', () => {
    const now = Date.now();
    const hidden = getMoments(now).filter((m) => m.state === 'settled' || m.state === 'retired');
    test.skip(hidden.length === 0, 'no settled or retired moment in the corpus right now');
    for (const m of hidden) {
      for (const v of m.vehicles) {
        expect(ids(getMomentsForBill(v.slug, now)), `${m.id} ← ${v.slug}`).not.toContain(m.id);
      }
    }
  });

  test('a bill outside every moment gets an empty list, and an unknown slug never throws', () => {
    expect(getMomentsForBill('not-a-real-bill-99999')).toEqual([]);
  });

  test('the clock is threaded through: states are recomputed at the passed instant', () => {
    // Far past every review_by in the file: a moment that has not settled
    // reads stale there — and stale still backlinks, which is the rule.
    const far = new Date('2028-01-01T00:00:00Z').getTime();
    const visible = getMoments(far).filter((m) => m.state === 'live' || m.state === 'stale');
    test.skip(visible.length === 0, 'every moment reads settled or retired at that clock');
    const m = visible[0];
    expect(ids(getMomentsForBill(m.vehicles[0].slug, far))).toContain(m.id);
  });
});

import { expect, test } from '@playwright/test';
import {
  getMomentsForBill,
  getMomentsForNomination,
  getMoments,
  momentsForBill,
  momentsForVehicle,
  vehicleKind,
  type MomentState,
  type MomentVehicle,
  type MomentWithState,
  type VehicleKind,
} from '../lib/moments';

/*
 * The vehicle → Moment backlink's visibility rule (repositioning spec §7.2).
 *
 * Same split as tests/moments.unit.spec.ts uses for computeMomentState: the
 * rule itself is pinned with fixtures (a state the corpus does not currently
 * hold — settled, retired — must still be provably invisible), and the
 * corpus binding is asserted separately and corpus-robustly, derived from
 * getMoments() rather than from any hardcoded moment id or vehicle slug.
 *
 * KIND-AWARE THROUGHOUT since 2026-08-06. The corpus sweep below asked
 * `getMomentsForBill` of EVERY vehicle, which was correct only for as long as
 * every vehicle was a bill: the first nomination vehicle to land would have
 * turned this file red on a moment that was backlinking perfectly well,
 * through the other reader. What a vehicle must do is backlink through ITS OWN
 * kind's reader — and, added here rather than merely generalized, through no
 * other. A bill is still required to backlink as a bill.
 */

/** A vehicle in a fixture: a bare slug (an implicit bill, the wire format's
 *  own default) or an explicit { slug, kind }. */
type VehicleSpec = string | { slug: string; kind: VehicleKind };

const vehicleFor = (v: VehicleSpec): MomentVehicle =>
  typeof v === 'string'
    ? { slug: v, role: { en: 'x', es: 'x' } }
    : { slug: v.slug, kind: v.kind, role: { en: 'x', es: 'x' } };

/** A moment fixture in a chosen read-time state, shaped like the real thing. */
const fixture = (id: string, state: MomentState, vehicles: VehicleSpec[]): MomentWithState => ({
  id,
  name: { en: `The ${id} question`, es: `La cuestión ${id}` },
  summary: {
    en: 'Congress is deciding whether to do the thing.',
    es: 'El Congreso decide si hace la cosa.',
  },
  aliases: { en: ['example'], es: ['ejemplo'] },
  category: 'national_security',
  vehicles: vehicles.map(vehicleFor),
  qualifying_signal: { type: 'tier0_floor', refs: ['https://www.congress.gov/example'] },
  opened: '2026-07-23',
  review_by: '2026-08-22',
  // 'settled' is computed, never stored — the stored status behind it is 'live'.
  status: state === 'retired' ? 'retired' : 'live',
  state,
});

const ids = (list: MomentWithState[]) => list.map((m) => m.id);

/** The reader for a vehicle's OWN kind — the same dispatch lib/moments.ts's
 *  `corpusStatus` makes internally, made explicit here so a sweep over a mixed
 *  corpus asks each vehicle the only question that is true of it. */
const backlinksFor = (v: MomentVehicle, now: number) =>
  vehicleKind(v) === 'nomination'
    ? getMomentsForNomination(v.slug, now)
    : getMomentsForBill(v.slug, now);

/** …and the reader for the kind it is NOT. Used to assert the negative half:
 *  a backlink is a claim about which corpus a slug lives in, not a string
 *  match that would resolve in either. */
const crossKindBacklinksFor = (v: MomentVehicle, now: number) =>
  vehicleKind(v) === 'nomination'
    ? getMomentsForBill(v.slug, now)
    : getMomentsForNomination(v.slug, now);

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

/*
 * THE NOMINATION VEHICLE AS A FIRST-CLASS CASE (2026-08-06).
 *
 * `momentsForBill` is `momentsForVehicle(…, 'bill')` and the kind guard in it
 * was documented as "a no-op TODAY" — the two slug namespaces are
 * structurally disjoint, so no `pn-…` string can equal a bill's identifier.
 * That is an argument about today's slug shapes, not about the rule, and it is
 * exactly the kind of reasoning that stops being true quietly. These pin the
 * rule itself: the reader you ask decides the answer, and each kind is
 * reachable through its own and through no other.
 */
test.describe('momentsForVehicle (fixtures): the KIND decides, never the slug shape', () => {
  const NOM = { slug: 'pn-852-1-119', kind: 'nomination' } as const;

  test('a nomination vehicle backlinks through the nomination reader', () => {
    const m = [fixture('m', 'live', [NOM])];
    expect(ids(momentsForVehicle(m, NOM.slug, 'nomination'))).toEqual(['m']);
  });

  test('…and never through the bill one — momentsForBill is a claim about bills', () => {
    const m = [fixture('m', 'live', [NOM])];
    expect(momentsForBill(m, NOM.slug)).toEqual([]);
  });

  test('a bill vehicle is STILL required to backlink as a bill, and only as a bill', () => {
    const b = [fixture('b', 'live', ['hr-977-119'])];
    expect(ids(momentsForBill(b, 'hr-977-119'))).toEqual(['b']);
    expect(momentsForVehicle(b, 'hr-977-119', 'nomination')).toEqual([]);
  });

  test('a mixed moment is reachable from BOTH vehicles, each through its own kind', () => {
    const mixed = [fixture('mixed', 'live', ['hr-977-119', NOM])];
    expect(ids(momentsForBill(mixed, 'hr-977-119'))).toEqual(['mixed']);
    expect(ids(momentsForVehicle(mixed, NOM.slug, 'nomination'))).toEqual(['mixed']);
  });

  test('the visibility rule is one rule: settled and retired hide a nomination too', () => {
    for (const state of ['settled', 'retired'] as const) {
      expect(
        momentsForVehicle([fixture('m', state, [NOM])], NOM.slug, 'nomination'),
        state
      ).toEqual([]);
    }
    for (const state of ['live', 'stale'] as const) {
      expect(
        ids(momentsForVehicle([fixture('m', state, [NOM])], NOM.slug, 'nomination')),
        state
      ).toEqual(['m']);
    }
  });
});

test.describe('getMomentsForBill / getMomentsForNomination (real corpus): read-time, clock-injectable', () => {
  test('every live or stale moment is reachable from each of its own vehicles', () => {
    const now = Date.now();
    const visible = getMoments(now).filter((m) => m.state === 'live' || m.state === 'stale');
    test.skip(visible.length === 0, 'no live or stale moment in the corpus right now');
    for (const m of visible) {
      for (const v of m.vehicles) {
        const at = `${m.id} ← ${v.slug} (${vehicleKind(v)})`;
        expect(ids(backlinksFor(v, now)), at).toContain(m.id);
        // The negative half, and it is the one that keeps the bill claim from
        // being weakened by generalizing: a bill must backlink through the
        // BILL reader specifically, not through whichever reader answers.
        expect(ids(crossKindBacklinksFor(v, now)), `${at} — cross-kind`).not.toContain(m.id);
      }
    }
  });

  test('no settled or retired moment leaks into any vehicle’s backlinks', () => {
    const now = Date.now();
    const hidden = getMoments(now).filter((m) => m.state === 'settled' || m.state === 'retired');
    test.skip(hidden.length === 0, 'no settled or retired moment in the corpus right now');
    for (const m of hidden) {
      for (const v of m.vehicles) {
        const at = `${m.id} ← ${v.slug} (${vehicleKind(v)})`;
        // Asked of the vehicle's OWN reader. Left bill-only, this assertion
        // passed VACUOUSLY on a nomination vehicle — getMomentsForBill can
        // never return a moment for a `pn-…` slug, so "does not leak" was
        // proving nothing about the record it named.
        expect(ids(backlinksFor(v, now)), at).not.toContain(m.id);
      }
    }
  });

  test('a vehicle outside every moment gets an empty list, and an unknown slug never throws', () => {
    expect(getMomentsForBill('not-a-real-bill-99999')).toEqual([]);
    expect(getMomentsForNomination('pn-0-0-119')).toEqual([]);
  });

  test('the clock is threaded through: states are recomputed at the passed instant', () => {
    // Far past every review_by in the file: a moment that has not settled
    // reads stale there — and stale still backlinks, which is the rule.
    const far = new Date('2028-01-01T00:00:00Z').getTime();
    const visible = getMoments(far).filter((m) => m.state === 'live' || m.state === 'stale');
    test.skip(visible.length === 0, 'every moment reads settled or retired at that clock');
    const m = visible[0];
    expect(ids(backlinksFor(m.vehicles[0], far))).toContain(m.id);
  });
});

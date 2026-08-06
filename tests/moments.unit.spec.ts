import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../messages/en.json';
import es from '../messages/es.json';
// Relative import of the import-free gate module (lib/moments-gate.mjs, the
// logic scripts/check-moments.mjs executes in CI) — the checks tested here
// are the checks that gate every moments PR.
import {
  CATEGORIES as GATE_CATEGORIES,
  SIGNAL_TYPES as GATE_SIGNAL_TYPES,
  TERMINAL_NOMINATION_VEHICLE_STATUSES,
  TERMINAL_VEHICLE_STATUSES,
  VEHICLE_KINDS as GATE_VEHICLE_KINDS,
  checkMoments,
  lintForbidden,
  vehicleKind as gateVehicleKind,
} from '../lib/moments-gate.mjs';
import { TERMINAL_NOMINATION_STATUSES } from '../lib/nomination-status.mjs';
import {
  STORED_NOMINATION_STATUSES,
  getNomination,
  nominationSlug,
  type Nomination,
} from '../lib/core/nominations';
import { CATEGORIES } from '../lib/taxonomy';
import { TERMINAL_STATUSES } from '../lib/urgency.mjs';
import {
  QUALIFYING_SIGNAL_TYPES,
  VEHICLE_KINDS,
  computeMomentState,
  getLiveMoments,
  getMoment,
  getMoments,
  isSettled,
  vehicleKind,
} from '../lib/moments';

/** The exact real-data run the CI gate performs (scripts/check-moments.mjs) —
 *  both corpora, kind-dispatched, exactly as that script wires them. */
function checkRepoData() {
  const read = (p: string) => JSON.parse(readFileSync(join(__dirname, '..', p), 'utf8'));
  const moments = read('data/moments.json');
  const bills: { full_identifier: string; status: string }[] = read('data/bills.json');
  const nominations: Nomination[] = read('data/nominations.json');
  const slugsByKind = {
    bill: new Set(bills.map((b) => b.full_identifier)),
    nomination: new Set(nominations.map(nominationSlug)),
  };
  const statusByKind: Record<string, Map<string, string>> = {
    bill: new Map(bills.map((b) => [b.full_identifier, b.status])),
    nomination: new Map(nominations.map((n) => [nominationSlug(n), n.status])),
  };
  // The callable-record set, wired exactly as the CI script wires it.
  const describedNominationSlugs = new Set(
    nominations.filter((n) => n.nominee_description?.trim()).map(nominationSlug),
  );
  return checkMoments(
    moments,
    slugsByKind,
    (v: { slug: string; kind?: string }) => statusByKind[gateVehicleKind(v)]?.get(v.slug),
    { describedNominationSlugs },
  );
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

  /*
   * The signal-type set is the third hand-duplicated constant in this family,
   * and until 2026-08-06 it was the only one with no pin — while carrying the
   * quietest failure of the three: the gate would accept a type the UI has no
   * label for, and app/[locale]/questions/[id]/page.tsx falls through to
   * printing the raw slug rather than throwing. Order matters here (unlike
   * the terminal statuses, which are a Set): both copies are ordered lists
   * and the page renders nothing from the order, but keeping them identical
   * makes a diff between the two files readable line-for-line.
   */
  test("the gate's signal-type copy matches lib/moments.ts exactly", () => {
    expect(GATE_SIGNAL_TYPES).toEqual([...QUALIFYING_SIGNAL_TYPES]);
  });

  /*
   * The fourth constant in the family, landed 2026-08-06 with the vehicle
   * `kind` discriminator. Drift here is not silent but it IS destructive: the
   * gate looks a vehicle's slug up in the corpus its kind names, so a kind
   * the gate knows and lib/moments.ts does not (or the reverse) means one
   * side resolves a vehicle the other rejects.
   */
  test("the gate's vehicle-kind copy matches lib/moments.ts exactly", () => {
    expect(GATE_VEHICLE_KINDS).toEqual([...VEHICLE_KINDS]);
  });

  /*
   * The kinds are pinned above; the DEFAULT is pinned here, and separately,
   * because it is the whole no-migration guarantee. `kind` is optional on the
   * wire and its absence means 'bill' — the five vehicles in the two live
   * moments carry no `kind` at all and must keep resolving as bills. Both
   * copies of the normalizer are checked on the same inputs: a default that
   * disagrees across the gate/reader boundary would let the gate validate a
   * vehicle against one corpus while the page read it out of the other.
   */
  test("'kind' is optional and its absence means bill — in BOTH copies of the normalizer", () => {
    for (const v of [{}, { kind: undefined }] as { kind?: 'bill' | 'nomination' }[]) {
      expect(vehicleKind(v)).toBe('bill');
      expect(gateVehicleKind(v)).toBe('bill');
    }
    for (const kind of VEHICLE_KINDS) {
      expect(vehicleKind({ kind })).toBe(kind);
      expect(gateVehicleKind({ kind })).toBe(kind);
    }
  });

  /* The vehicles actually committed today carry no `kind` — which is what
     makes this change a zero-diff one on data/moments.json. If a nomination
     vehicle ever lands, this test is the place that says so out loud. */
  test('every vehicle in the shipped corpus is an implicit bill', () => {
    for (const m of getMoments()) {
      for (const v of m.vehicles) {
        expect(v.kind, `${m.id} ← ${v.slug}`).toBeUndefined();
        expect(vehicleKind(v)).toBe('bill');
      }
    }
  });

  /*
   * GATE AND READER MUST AGREE ON THE NAMESPACE.
   *
   * lib/moments.ts's corpusStatus resolves a nomination vehicle through
   * getNomination; scripts/check-moments.mjs admits one by looking its slug
   * up in a set built from the same file. Neither branch is REACHED today —
   * no moment carries a nomination — so what is pinned here is the property
   * that makes reaching it safe: a slug the gate would admit is a slug the
   * reader can resolve, to a status inside the stored vocabulary. If those
   * two ever disagreed, a vehicle would pass CI and then read as live
   * forever, which is the failure the whole discriminator exists to prevent.
   *
   * Sampled rather than swept — getNomination is a linear find and the sweep
   * over all 857 is quadratic for no extra coverage; scripts/check-nominations.mjs
   * already proves slug uniqueness across the whole file.
   */
  test('every sampled nomination slug resolves through the reader, with a stored status', () => {
    const corpus: Nomination[] = JSON.parse(
      readFileSync(join(__dirname, '..', 'data/nominations.json'), 'utf8'),
    );
    expect(corpus.length).toBeGreaterThan(500);
    let checked = 0;
    for (let i = 0; i < corpus.length; i += 23) {
      const slug = nominationSlug(corpus[i]);
      expect(slug, corpus[i].citation).toMatch(/^pn-\d+(-\d+)?-\d+$/);
      const resolved = getNomination(slug);
      expect(resolved, slug).toBeDefined();
      expect(resolved!.citation).toBe(corpus[i].citation);
      expect(STORED_NOMINATION_STATUSES, slug).toContain(resolved!.status);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  /* The nomination half of the terminal-status pin above. Same belt-and-
     braces: also asserted at runtime by scripts/check-moments.mjs. */
  test("the gate's terminal-nomination copy matches lib/nomination-status.mjs exactly", () => {
    expect([...TERMINAL_NOMINATION_VEHICLE_STATUSES].sort()).toEqual(
      [...TERMINAL_NOMINATION_STATUSES].sort(),
    );
  });

  /* The two terminal vocabularies must stay DISJOINT. If they ever share a
     word, "which set do I ask?" stops being answerable from the kind alone
     and every terminality decision in this file becomes ambiguous. */
  test('the bill and nomination terminal vocabularies share no word', () => {
    for (const s of TERMINAL_NOMINATION_STATUSES) {
      expect([...TERMINAL_STATUSES], s).not.toContain(s);
    }
  });

  /* A signal type with no label is a slug on the page, in both languages —
     so the labels are pinned to the set, not to whatever the corpus happens
     to use today (tests/moments.spec.ts only covers types in live data). */
  test('every signal type has an EN and ES label', () => {
    for (const type of QUALIFYING_SIGNAL_TYPES) {
      expect(en.moments.signalType, `en ${type}`).toHaveProperty(type);
      expect(es.moments.signalType, `es ${type}`).toHaveProperty(type);
      const enLabel = (en.moments.signalType as Record<string, string>)[type];
      const esLabel = (es.moments.signalType as Record<string, string>)[type];
      expect(enLabel.trim().length, `en ${type}`).toBeGreaterThan(0);
      expect(esLabel.trim().length, `es ${type}`).toBeGreaterThan(0);
    }
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
/* Two corpora, because the gate resolves a vehicle in the one its kind names.
   The nomination fixtures use the real `pn-…` shape so the disjointness the
   design leans on is visible in the fixture itself. */
const SLUGS_BY_KIND: Record<string, Set<string>> = {
  bill: new Set(['test-bill-1', 'test-bill-2']),
  nomination: new Set(['pn-730-18-119', 'pn-932-119']),
};
const FIXTURE_STATUSES: Record<string, Record<string, string>> = {
  bill: { 'test-bill-1': 'committee', 'test-bill-2': 'signed' },
  nomination: { 'pn-730-18-119': 'exec_calendar', 'pn-932-119': 'confirmed' },
};
const statusFor = (v: { slug: string; kind?: string }): string | undefined =>
  FIXTURE_STATUSES[gateVehicleKind(v)]?.[v.slug];
/* Both fixture nominations carry Congress.gov's description sentence — the
   callable-record rule's default answer is "yes", so every fixture written
   before that rule existed keeps meaning what it meant. The rule's own tests
   below hand in a narrower set. */
const DESCRIBED = new Set(['pn-730-18-119', 'pn-932-119']);

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

const run = (moments: Record<string, unknown>, described: Set<string> = DESCRIBED) =>
  checkMoments(moments, SLUGS_BY_KIND, statusFor, {
    now: NOW,
    describedNominationSlugs: described,
  });

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

  /* ---- the vehicle `kind` discriminator (2026-08-06) ---- */

  test('a vehicle with no kind is validated against data/bills.json — the no-migration default', () => {
    // The shipped shape: no `kind` key at all. It must keep passing, and a
    // nomination slug must NOT pass under it.
    expect(run({ m: validMoment() }).violations).toEqual([]);
    const wrongCorpus = validMoment();
    wrongCorpus.vehicles[0].slug = 'pn-932-119';
    expect(
      run({ m: wrongCorpus }).violations.some((x: string) => x.includes('data/bills.json')),
    ).toBe(true);
  });

  test("kind: 'nomination' resolves against data/nominations.json instead", () => {
    const nom = validMoment() as Record<string, unknown>;
    nom.vehicles = [{ ...validMoment().vehicles[0], slug: 'pn-730-18-119', kind: 'nomination' }];
    expect(run({ m: nom }).violations).toEqual([]);

    // ...and a BILL slug is not a nomination, which is the same test read backwards.
    const crossed = validMoment() as Record<string, unknown>;
    crossed.vehicles = [{ ...validMoment().vehicles[0], kind: 'nomination' }];
    expect(
      run({ m: crossed }).violations.some((x: string) => x.includes('data/nominations.json')),
    ).toBe(true);
  });

  test('an unknown kind fails, and never falls back to a corpus', () => {
    const typo = validMoment() as Record<string, unknown>;
    typo.vehicles = [{ ...validMoment().vehicles[0], kind: 'nominaton' }];
    const v = run({ m: typo }).violations;
    expect(v.some((x: string) => x.includes('.kind') && x.includes('nominaton'))).toBe(true);
    // The slug is a real bill, but the kind is unreadable — so the gate must
    // NOT quietly validate it as one. Exactly one violation, about the kind.
    expect(v.filter((x: string) => x.includes('does not exist'))).toEqual([]);
  });

  test('terminality is per-kind: confirmed warns on a nomination, not on a bill', () => {
    const nom = validMoment() as Record<string, unknown>;
    nom.vehicles = [{ ...validMoment().vehicles[0], slug: 'pn-932-119', kind: 'nomination' }];
    const { violations, warnings } = run({ m: nom });
    expect(violations).toEqual([]);
    expect(warnings.some((w: string) => w.includes('pn-932-119') && w.includes('confirmed'))).toBe(true);

    // A nomination on the Executive Calendar is live business, so no warning —
    // and `signed`/`vetoed` are not in its vocabulary at all.
    const live = validMoment() as Record<string, unknown>;
    live.vehicles = [{ ...validMoment().vehicles[0], slug: 'pn-730-18-119', kind: 'nomination' }];
    expect(run({ m: live }).warnings).toEqual([]);
  });

  /* ---- the callable-record rule (2026-08-06) ----------------------------
   *
   * `moments.howMadeRule3` tells every reader of /questions that by the time a
   * question opens its page and call script already work, and
   * `moments.vehiclesLedeNominations` promises support and oppose scripts one
   * tap away. Nothing enforced either one for a nomination: a record with no
   * `nominee_description` — 14 of the 857 civilian records, one of them live —
   * passed VEHICLE_KINDS and the terminal set and landed on a page with no
   * dial, no stance control and no script, because that sentence is the only
   * thing a nomination script is ever grounded in.
   *
   * The promise is now a rule. These are the tests that keep it one.
   * ---------------------------------------------------------------------- */

  test('a nomination vehicle whose record carries no description FAILS', () => {
    const nom = validMoment() as Record<string, unknown>;
    nom.vehicles = [{ ...validMoment().vehicles[0], slug: 'pn-730-18-119', kind: 'nomination' }];
    // Same fixture, same live status — only the description is missing.
    const v = run({ m: nom }, new Set(['pn-932-119'])).violations;
    expect(
      v.some((x: string) => x.includes('pn-730-18-119') && x.includes('nominee_description')),
      'the gate must name the slug and the field that is missing',
    ).toBe(true);
    // …and it must NOT be reported as an unknown slug: the record exists, and
    // sending the author to hunt for a typo would be the wrong instruction.
    expect(v.some((x: string) => x.includes('does not exist'))).toBe(false);
  });

  test('a described nomination vehicle still passes, and a bill is never asked', () => {
    const nom = validMoment() as Record<string, unknown>;
    nom.vehicles = [{ ...validMoment().vehicles[0], slug: 'pn-730-18-119', kind: 'nomination' }];
    expect(run({ m: nom }).violations).toEqual([]);
    // The rule is nominations-only. A bill's callability is structural (every
    // corpus bill has a page and a script), so an empty nomination set must
    // not touch it.
    expect(run({ m: validMoment() }, new Set()).violations).toEqual([]);
  });

  test('the rule FAILS CLOSED when the caller never wired the set', () => {
    const nom = validMoment() as Record<string, unknown>;
    nom.vehicles = [{ ...validMoment().vehicles[0], slug: 'pn-730-18-119', kind: 'nomination' }];
    // Not "passes because nobody asked" — a gate that quietly stops checking
    // is the failure mode this project writes tripwires for.
    const v = checkMoments({ m: nom }, SLUGS_BY_KIND, statusFor, { now: NOW }).violations;
    expect(v.some((x: string) => x.includes('describedNominationSlugs'))).toBe(true);
  });

  /* The rule against the REAL corpus, not a fixture: the one live
     description-less record is the trap this was armed for, and it must be
     refused by the same wiring scripts/check-moments.mjs runs in CI. */
  test('the real corpus’s live description-less record cannot be a vehicle', () => {
    const real = JSON.parse(
      readFileSync(join(__dirname, '..', 'data/nominations.json'), 'utf8'),
    ) as Nomination[];
    const orphan = real.find(
      (n) => !n.nominee_description && !TERMINAL_NOMINATION_STATUSES.has(n.status),
    );
    test.skip(!orphan, 'no live description-less nomination in the current corpus');
    const slug = nominationSlug(orphan!);

    const m = validMoment() as Record<string, unknown>;
    m.vehicles = [{ ...validMoment().vehicles[0], slug, kind: 'nomination' }];
    const v = checkMoments(
      { m },
      { ...SLUGS_BY_KIND, nomination: new Set(real.map(nominationSlug)) },
      () => orphan!.status,
      {
        now: NOW,
        describedNominationSlugs: new Set(
          real.filter((n) => n.nominee_description?.trim()).map(nominationSlug),
        ),
      },
    ).violations;
    expect(v.some((x: string) => x.includes(slug) && x.includes('nominee_description'))).toBe(true);
  });

  test('an unclassified nomination warns — no script can ever arrive there', () => {
    const nom = validMoment() as Record<string, unknown>;
    nom.vehicles = [{ ...validMoment().vehicles[0], slug: 'pn-unclassified-119', kind: 'nomination' }];
    const { violations, warnings } = checkMoments(
      { m: nom },
      { ...SLUGS_BY_KIND, nomination: new Set(['pn-unclassified-119']) },
      () => 'unclassified',
      { now: NOW, describedNominationSlugs: new Set(['pn-unclassified-119']) },
    );
    // A warning, not a violation: status is derived from the Senate's own
    // sentence and moves with every sync, so a hard rule would redden CI on
    // unrelated PRs — the same softening terminality already takes.
    expect(violations).toEqual([]);
    expect(warnings.some((w: string) => w.includes('unclassified'))).toBe(true);
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

  test('context_refs: valid CRS/CBO refs pass, with and without a bilingual title', () => {
    const m = {
      ...validMoment(),
      context_refs: [
        { kind: 'crs', url: 'https://crsreports.congress.gov/product/pdf/R/R48832' },
        {
          kind: 'cbo',
          url: 'https://www.cbo.gov/publication/61402',
          title: { en: 'CBO cost estimate', es: 'Estimación de costos de la CBO' },
        },
      ],
    };
    expect(run({ 'example-question': m }).violations).toEqual([]);
  });

  test('context_refs: a non-allowlisted host fails — grounding means the institutional record', () => {
    const m = {
      ...validMoment(),
      context_refs: [{ kind: 'crs', url: 'https://example.com/totally-a-crs-report' }],
    };
    const { violations } = run({ 'example-question': m });
    expect(violations.some((v) => v.includes('not an allowlisted institutional source'))).toBe(true);
  });

  test('context_refs: http (not https), an unknown kind, an empty array, and a title missing ES all fail', () => {
    const bad = (context_refs: unknown) =>
      run({ 'example-question': { ...validMoment(), context_refs } }).violations;
    expect(bad([{ kind: 'crs', url: 'http://www.cbo.gov/publication/61402' }]).some((v) => v.includes('https'))).toBe(true);
    expect(bad([{ kind: 'thinktank', url: 'https://www.cbo.gov/publication/61402' }]).some((v) => v.includes('.kind'))).toBe(true);
    expect(bad([]).some((v) => v.includes('non-empty array'))).toBe(true);
    expect(
      bad([
        { kind: 'gao', url: 'https://www.gao.gov/products/gao-26-107', title: { en: 'GAO finding' } },
      ]).some((v) => v.includes('title.es')),
    ).toBe(true);
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
  /* `slugs` are bill vehicles (no `kind`, the shipped shape); `pnSlugs` are
     nomination vehicles. Both go in the same `vehicles` array, because a
     moment may mix them and the every()-terminal rule has to hold across the
     mix. */
  const fixture = (
    over: Partial<{
      status: 'live' | 'retired';
      review_by: string;
      slugs: string[];
      pnSlugs: string[];
    }> = {},
  ) => ({
    status: over.status ?? ('live' as const),
    review_by: over.review_by ?? '2026-08-22',
    vehicles: [
      ...(over.slugs ?? (over.pnSlugs ? [] : ['a'])).map((slug) => ({
        slug,
        role: { en: 'x', es: 'x' },
      })),
      ...(over.pnSlugs ?? []).map((slug) => ({
        slug,
        role: { en: 'x', es: 'x' },
        kind: 'nomination' as const,
      })),
    ],
  });
  const statuses: Record<string, string> = {
    a: 'committee',
    b: 'floor_vote',
    signedBill: 'signed',
    vetoedBill: 'vetoed',
  };
  /* The nomination corpus is a SEPARATE table, keyed the same way, so the
     lookup can only answer for the kind it was asked about. `pnConfirmed`
     deliberately shares nothing with the bill table: reading a nomination out
     of the bill map is the bug this dispatch exists to make impossible. */
  const pnStatuses: Record<string, string> = {
    pnPending: 'exec_calendar',
    pnConfirmed: 'confirmed',
    pnWithdrawn: 'withdrawn',
  };
  const lookup = (v: { slug: string; kind?: string }) =>
    v.kind === 'nomination' ? pnStatuses[v.slug] : statuses[v.slug];

  test('sanity: the terminal set this file computes against is signed+vetoed', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['signed', 'vetoed']);
  });

  /* ---- the kind discriminator ---- */

  test('a nomination vehicle is terminal on its OWN vocabulary, never the bill one', () => {
    expect(computeMomentState(fixture({ pnSlugs: ['pnConfirmed'] }), lookup, NOW)).toBe('settled');
    expect(computeMomentState(fixture({ pnSlugs: ['pnWithdrawn'] }), lookup, NOW)).toBe('settled');
    expect(computeMomentState(fixture({ pnSlugs: ['pnPending'] }), lookup, NOW)).toBe('live');
  });

  test('a mixed moment settles only when BOTH kinds are terminal in their own vocabulary', () => {
    expect(
      computeMomentState(fixture({ slugs: ['signedBill'], pnSlugs: ['pnConfirmed'] }), lookup, NOW),
    ).toBe('settled');
    expect(
      computeMomentState(fixture({ slugs: ['signedBill'], pnSlugs: ['pnPending'] }), lookup, NOW),
    ).toBe('live');
    expect(
      computeMomentState(fixture({ slugs: ['a'], pnSlugs: ['pnConfirmed'] }), lookup, NOW),
    ).toBe('live');
  });

  test("a bill's status is never read out of the nomination corpus, or the reverse", () => {
    // 'confirmed' is not a bill status and 'signed' is not a nomination status.
    // Each slug exists ONLY in the other kind's table, so a dispatch that
    // ignored `kind` would find it and settle the moment. Both must read live.
    expect(computeMomentState(fixture({ slugs: ['pnConfirmed'] }), lookup, NOW)).toBe('live');
    expect(computeMomentState(fixture({ pnSlugs: ['signedBill'] }), lookup, NOW)).toBe('live');
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

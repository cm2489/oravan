import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from 'next-intl';
import enMessages from '../messages/en.json';
import esMessages from '../messages/es.json';
import {
  bothNoteKey,
  collapseQuietDays,
  momentDek,
  nominationCtaKey,
  revisionReasons,
} from '../lib/moments-ui';
import { getAllNominations, getNomination, nominationSlug, type Nomination } from '../lib/core/nominations';
import { getMoments, vehicleKind, type MomentVehicle } from '../lib/moments';
import { nominationHasCallScript } from '../lib/journey';
import type { UpdateDayGroup } from '../lib/moment-updates';
import { isSignalFresh, SIGNAL_WINDOW_DAYS } from '../lib/urgency.mjs';

/*
 * lib/moments-ui.ts shipped with no tests of its own, and it cost us: the
 * first-sentence regex cut on the first abbreviation, so the Iran moment's dek
 * rendered as the bare string "U.S." on /questions, in the homepage strip, and —
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
    // The two that were rendering amber on /questions/iran-war-powers.
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
/*
 * WHAT A NOMINATION CARD'S BUTTON PROMISES.
 *
 * /questions/[id] labeled every nomination card's green phone-icon CTA
 * `moments.readCall` — "Read + call" — for any moment that was not settled.
 * On a nomination the Senate has finished with, or one Congress.gov never
 * described, that button opens a page whose entire rail is the sentence "No
 * call to make". `moments.vehiclesLedeNominations`, printed directly above the
 * grid, made the same promise in prose.
 *
 * UNREACHABLE BY DOM TEST TODAY, on purpose: data/moments.json holds zero
 * nomination vehicles and must stay byte-identical to main (the no-migration
 * keystone). So the decision is a pure function and this is where it is pinned
 * — the first nomination Moment is the run where it stops being latent, and
 * that run must not be the one that discovers the bug.
 */
test.describe('nominationCtaKey', () => {
  const DESCRIBED = 'Jane Doe, of Ohio, to be United States District Judge.';

  test('a live, described nomination is the only case that may say "Read + call"', () => {
    for (const status of ['received', 'hearing', 'reported', 'exec_calendar', 'floor', 'scheduled'] as const) {
      expect(nominationCtaKey({ status, nominee_description: DESCRIBED }, false), status).toBe(
        'moments.readCall',
      );
    }
  });

  test('a finished nomination says "Read the record" — the page has no call on it', () => {
    for (const status of ['confirmed', 'returned', 'withdrawn'] as const) {
      expect(nominationCtaKey({ status, nominee_description: DESCRIBED }, false), status).toBe(
        'nominations.readRecord',
      );
    }
  });

  test('a record with no description says "Read the record" too', () => {
    expect(nominationCtaKey({ status: 'received', nominee_description: null }, false)).toBe(
      'nominations.readRecord',
    );
    // …and `unclassified`, whose page keeps a rail that can only ever refuse.
    expect(nominationCtaKey({ status: 'unclassified', nominee_description: DESCRIBED }, false)).toBe(
      'nominations.readRecord',
    );
  });

  test('a settled moment is a record in every card, whatever its vehicle can still do', () => {
    expect(nominationCtaKey({ status: 'exec_calendar', nominee_description: DESCRIBED }, true)).toBe(
      'nominations.readRecord',
    );
  });

  test('both keys resolve in both languages — no card ever prints a raw key', () => {
    const messagesFor: Record<'en' | 'es', Record<string, unknown>> = {
      en: enMessages as unknown as Record<string, unknown>,
      es: esMessages as unknown as Record<string, unknown>,
    };
    for (const locale of ['en', 'es'] as const) {
      const t = createTranslator({
        locale,
        messages: messagesFor[locale],
      }) as unknown as (key: string) => string;
      for (const key of ['moments.readCall', 'nominations.readRecord'] as const) {
        const text = t(key);
        expect(text.length, `${key}/${locale}`).toBeGreaterThan(0);
        expect(text, `${key}/${locale}`).not.toBe(key);
      }
    }
  });

  /* THE REAL CORPUS, swept: every nomination Congress.gov describes and the
     Senate can still act on may carry the call label; nothing else may. */
  test('the whole committed corpus agrees with the route’s own refusal rule', () => {
    const all = getAllNominations();
    expect(all.length).toBeGreaterThan(0);
    for (const n of all) {
      const expected = nominationHasCallScript(n) ? 'moments.readCall' : 'nominations.readRecord';
      expect(nominationCtaKey(n, false), n.citation).toBe(expected);
    }
    // The corpus really does contain both answers — a sweep that only ever
    // sees one of them proves nothing.
    expect(all.some((n) => nominationCtaKey(n, false) === 'moments.readCall')).toBe(true);
    expect(all.some((n) => nominationCtaKey(n, false) === 'nominations.readRecord')).toBe(true);
  });
});

/*
 * WHAT THE NOTE UNDER THE VEHICLES GRID PROMISES.
 *
 * /questions/[id] printed `moments.bothNote` unconditionally — "No side is
 * pre-selected. Every link above opens the same call flow, with support and
 * oppose scripts equally available." The second sentence quantifies over every
 * card in the grid. True of a bill (the bill page always mounts ActionPanel);
 * false of a nomination the Senate has finished with, or one its record never
 * described, whose page's whole rail is "No call to make".
 *
 * THE SHARED STRING IS NOT EDITED. It is the bill path's sentence too, and
 * there it is true — so the fix is an additive, kind-aware variant, and a
 * bill-only moment must keep printing the original byte for byte. Both halves
 * are asserted here; tests/moments.spec.ts asserts the same pair in the DOM.
 *
 * UNREACHABLE BY DOM TEST TODAY, for the reason `nominationCtaKey` above is:
 * data/moments.json holds zero nomination vehicles and must stay byte-
 * identical to main. The vehicle sets below are built in the test.
 */
test.describe('bothNoteKey', () => {
  const nominations = getAllNominations();
  const callable = nominations.find((n) => nominationHasCallScript(n));
  const notCallable = nominations.find((n) => !nominationHasCallScript(n));

  /** A vehicle as data/moments.json would carry one. `role` is required by the
   *  type and never read here — the note is about callability, not about what
   *  a yes vote does. */
  const nom = (n: Nomination): MomentVehicle => ({
    slug: nominationSlug(n),
    role: { en: 'role', es: 'papel' },
    kind: 'nomination',
  });

  /* A REAL bill-only vehicle set, off the shipped corpus — the exact input
     today's pages hand this function. */
  const bills: MomentVehicle[] = getMoments()[0]?.vehicles ?? [];

  test('the corpus really does contain both kinds of nomination record', () => {
    // Every test below is vacuous without them, so this failing is the honest
    // signal that the fixtures moved, not a silent green.
    expect(callable, 'no callable nomination in the corpus').toBeTruthy();
    expect(notCallable, 'no non-callable nomination in the corpus').toBeTruthy();
    expect(bills.length, 'no bill vehicles in data/moments.json').toBeGreaterThan(0);
  });

  test('every shipped moment is bill-only today, and keeps the sentence it ships with', () => {
    for (const m of getMoments()) {
      expect(bothNoteKey(m.vehicles), m.id).toBe('moments.bothNote');
    }
  });

  test('the shared string is untouched, in both languages', () => {
    // The bill path's sentence, byte for byte as origin/main ships it. A fix
    // for a nomination-only defect may not quietly rewrite shared copy.
    expect(enMessages.moments.bothNote).toBe(
      'No side is pre-selected. Every link above opens the same call flow, with support and oppose scripts equally available.',
    );
    expect(esMessages.moments.bothNote).toBe(
      'Ningún lado está preseleccionado. Cada enlace de arriba abre el mismo flujo de llamada, con guiones a favor y en contra igualmente disponibles.',
    );
  });

  test('a nomination with no call script drops the promise — alone, and beside bills', () => {
    test.skip(!notCallable, 'no non-callable nomination in the corpus');
    expect(bothNoteKey([nom(notCallable!)])).toBe('moments.bothNoteSomeNoCall');
    expect(bothNoteKey([...bills, nom(notCallable!)])).toBe('moments.bothNoteSomeNoCall');
  });

  test('one uncallable card is enough — the sentence quantifies over all of them', () => {
    test.skip(!callable || !notCallable, 'corpus lacks one of the two record kinds');
    expect(bothNoteKey([nom(callable!), nom(notCallable!)])).toBe('moments.bothNoteSomeNoCall');
    expect(bothNoteKey([nom(notCallable!), nom(callable!)])).toBe('moments.bothNoteSomeNoCall');
  });

  test('a set whose every card can be called keeps the promise', () => {
    test.skip(!callable, 'no callable nomination in the corpus');
    expect(bothNoteKey([nom(callable!)])).toBe('moments.bothNote');
    expect(bothNoteKey([...bills, nom(callable!)])).toBe('moments.bothNote');
  });

  test('the live description-less record is the trap this was armed for', () => {
    // PN897-2: still before the Senate, and Congress.gov never described it —
    // so /api/script refuses (422) and its page's rail is "No call to make",
    // while its status alone reads as live business.
    const orphan = getAllNominations().find(
      (n) => !n.nominee_description && nominationCtaKey(n, false) === 'nominations.readRecord',
    );
    test.skip(!orphan, 'no description-less record in the corpus');
    expect(bothNoteKey([nom(orphan!)])).toBe('moments.bothNoteSomeNoCall');
  });

  test('a slug that resolves to nothing claims nothing — the page renders no card for it', () => {
    const ghost: MomentVehicle = {
      slug: 'pn-0-119',
      role: { en: 'role', es: 'papel' },
      kind: 'nomination',
    };
    expect(getNomination(ghost.slug), 'fixture must be a slug the corpus really lacks').toBeUndefined();
    expect(bothNoteKey([ghost])).toBe('moments.bothNote');
  });

  test('the kind is read through the normalizer, never off the shape of the slug', () => {
    test.skip(!notCallable, 'no non-callable nomination in the corpus');
    // No `kind` means BILL everywhere in this codebase (lib/moments.ts's
    // vehicleKind) — the no-migration default. Such a vehicle misses
    // data/bills.json, renders no card, and so makes no claim here either.
    const untyped: MomentVehicle = { slug: nominationSlug(notCallable!), role: { en: 'r', es: 'p' } };
    expect(bothNoteKey([untyped])).toBe('moments.bothNote');
  });

  test('the whole committed corpus agrees with the route’s own refusal rule', () => {
    expect(nominations.length).toBeGreaterThan(0);
    for (const n of nominations) {
      const expected = nominationHasCallScript(n) ? 'moments.bothNote' : 'moments.bothNoteSomeNoCall';
      expect(bothNoteKey([nom(n)]), n.citation).toBe(expected);
    }
    // Both answers really occur — a sweep that only ever sees one proves nothing.
    expect(nominations.some((n) => bothNoteKey([nom(n)]) === 'moments.bothNote')).toBe(true);
    expect(nominations.some((n) => bothNoteKey([nom(n)]) === 'moments.bothNoteSomeNoCall')).toBe(true);
  });

  test('both keys resolve in both languages, and they are not the same sentence', () => {
    const messagesFor: Record<'en' | 'es', Record<string, unknown>> = {
      en: enMessages as unknown as Record<string, unknown>,
      es: esMessages as unknown as Record<string, unknown>,
    };
    for (const locale of ['en', 'es'] as const) {
      const t = createTranslator({ locale, messages: messagesFor[locale] }) as unknown as (
        key: string,
      ) => string;
      const shared = t('moments.bothNote');
      const variant = t('moments.bothNoteSomeNoCall');
      for (const [key, text] of [
        ['moments.bothNote', shared],
        ['moments.bothNoteSomeNoCall', variant],
      ] as const) {
        expect(text.length, `${key}/${locale}`).toBeGreaterThan(0);
        expect(text, `${key}/${locale}`).not.toBe(key);
      }
      expect(variant, locale).not.toBe(shared);
      // The half that was false is gone from the variant, in both languages.
      expect(variant, locale).not.toContain('Every link above');
      expect(variant, locale).not.toContain('Cada enlace de arriba');
      // …and the half that is the whole point of the sentence is still there.
      expect(variant.startsWith(shared.split('.')[0]), locale).toBe(true);
    }
  });
});

/*
 * WHAT THE LEDE OVER A MIXED GRID PROMISES.
 *
 * `moments.vehiclesLedeMixed` printed "Each opens the record and the call
 * flow — support and oppose scripts are equally one tap away." "Each"
 * quantifies over every card in that grid. True of a bill (the bill page
 * always mounts ActionPanel, settled or not) and false of a nomination the
 * Senate has finished with, or one its record never described: that page's
 * whole rail is "No call to make", with no stance control and no script. The
 * seventh string of this defect class, and the one the sixth fix named and
 * left behind.
 *
 * CORRECTED IN PLACE, no variant — the one difference from `moments.bothNote`.
 * app/[locale]/questions/[id]/page.tsx prints this key only when
 * `kinds.has('bill') && kinds.has('nomination')`, so every set that reaches it
 * carries a nomination and there is no bill-only render to keep byte-
 * identical. `moments.vehiclesLede` is the bill path's own sentence, and it is
 * asserted untouched below.
 *
 * DERIVED FROM THE RECORD. The premise — that a mixed grid can really hold a
 * card with no call flow behind it — is computed from data/nominations.json
 * through `nominationHasCallScript`, app/api/script's own 422 refusal
 * conjunction, never from the message this block is about. The routing is
 * computed through `vehicleKind`, the same normalizer the page reads, so a set
 * this block calls mixed is one the page would call mixed too.
 *
 * UNREACHABLE BY DOM TEST TODAY, for the reason the two blocks above are:
 * data/moments.json holds zero nomination vehicles and must stay byte-
 * identical to main, so no shipped moment is mixed. The sets below are built
 * in the test, from real corpus slugs.
 */
test.describe('moments.vehiclesLedeMixed', () => {
  const nominations = getAllNominations();
  const callable = nominations.find((n) => nominationHasCallScript(n));
  const notCallable = nominations.find((n) => !nominationHasCallScript(n));

  /* A REAL bill-only vehicle set, off the shipped corpus — the bill half of
     every mixed set below is the exact input today's pages carry. */
  const bills: MomentVehicle[] = getMoments()[0]?.vehicles ?? [];

  /** A vehicle as data/moments.json would carry one. `role` is required by the
   *  type and never read here — the lede is about what a card opens. */
  const nom = (n: Nomination): MomentVehicle => ({
    slug: nominationSlug(n),
    role: { en: 'role', es: 'papel' },
    kind: 'nomination',
  });

  /* app/[locale]/questions/[id]/page.tsx's own three-way choice, restated from
     `vehicleKind` rather than imported: the page's version is an inline
     ternary, and a test that reached for the page's own helper would only be
     watching it agree with itself. */
  const ledeKeyFor = (vehicles: MomentVehicle[]): string => {
    const kinds = new Set(vehicles.map(vehicleKind));
    if (kinds.has('bill') && kinds.has('nomination')) return 'moments.vehiclesLedeMixed';
    return kinds.has('nomination') ? 'moments.vehiclesLedeNominations' : 'moments.vehiclesLede';
  };

  /** The universal this fix removed, and the condition that replaced it — the
   *  same clause `moments.bothNoteSomeNoCall` established one commit earlier. */
  const FALSE_UNIVERSAL = {
    en: 'Each opens the record and the call flow',
    es: 'Cada uno abre el registro y el flujo de llamada',
  } as const;
  const CONDITION = {
    en: 'where that record still has a call to make',
    es: 'cuando en ese registro todavía queda una llamada que hacer',
  } as const;
  /** The half that is true of every card of either kind, and so the half the
   *  sentence is still allowed to state flat. */
  const ALWAYS_TRUE = { en: 'Each opens the record', es: 'Cada uno abre el registro' } as const;

  const lede = (locale: 'en' | 'es', key: string): string => {
    const t = createTranslator({
      locale,
      messages: (locale === 'en' ? enMessages : esMessages) as unknown as Record<string, unknown>,
    }) as unknown as (k: string) => string;
    return t(key);
  };

  test('a mixed grid can really hold a card with no call flow behind it', () => {
    // The premise, taken from the record. Without it every assertion below is
    // vacuous, so this failing is the honest signal that the corpus moved
    // rather than a silent green.
    expect(notCallable, 'no non-callable nomination in the corpus').toBeTruthy();
    expect(callable, 'no callable nomination in the corpus').toBeTruthy();
    expect(bills.length, 'no bill vehicles in data/moments.json').toBeGreaterThan(0);
    expect(ledeKeyFor([...bills, nom(notCallable!)])).toBe('moments.vehiclesLedeMixed');
  });

  test('one sentence has to cover both kinds of nomination record', () => {
    test.skip(!callable || !notCallable, 'corpus lacks one of the two record kinds');
    // The page holds ONE mixed lede and no callability branch, so the same
    // sentence prints over a grid whose nomination can be called and over a
    // grid whose nomination cannot. That is why it may not quantify.
    expect(ledeKeyFor([...bills, nom(callable!)])).toBe('moments.vehiclesLedeMixed');
    expect(ledeKeyFor([...bills, nom(notCallable!)])).toBe('moments.vehiclesLedeMixed');
  });

  test('the mixed lede does not promise a call flow behind every card', () => {
    test.skip(!notCallable, 'no non-callable nomination in the corpus');
    const key = ledeKeyFor([...bills, nom(notCallable!)]);
    for (const locale of ['en', 'es'] as const) {
      const text = lede(locale, key);
      expect(text.length, `${key}/${locale}`).toBeGreaterThan(0);
      expect(text, `${key}/${locale}`).not.toBe(key);
      expect(text, `${locale}: a call flow is promised behind every card`).not.toContain(
        FALSE_UNIVERSAL[locale],
      );
      expect(text, `${locale}: the call flow carries no condition`).toContain(CONDITION[locale]);
    }
  });

  test('the half that is true of every card survives', () => {
    for (const locale of ['en', 'es'] as const) {
      // A bill's page and a nomination's page each open a record, always.
      // Only the call flow was ever the conditional half, and precision about
      // one half is not licence to hedge the other into uselessness.
      expect(lede(locale, 'moments.vehiclesLedeMixed'), locale).toContain(ALWAYS_TRUE[locale]);
    }
  });

  test('the bill path’s own lede is untouched, and nothing that renders today moved', () => {
    // `moments.vehiclesLede` prints over a bill-only grid, where a call flow
    // behind every card is true. A nomination-only defect does not get to
    // rewrite it — byte for byte as origin/main ships it.
    expect(enMessages.moments.vehiclesLede).toBe(
      'The bills this question actually runs through. Each opens the full plain-language decode and the call flow — support and oppose scripts are equally one tap away.',
    );
    expect(esMessages.moments.vehiclesLede).toBe(
      'Los proyectos de ley por los que realmente pasa esta cuestión. Cada uno abre la explicación completa en lenguaje claro y el flujo de llamada — los guiones a favor y en contra están igual de disponibles.',
    );
    for (const m of getMoments()) {
      expect(ledeKeyFor(m.vehicles), m.id).toBe('moments.vehiclesLede');
    }
  });

  test('the three sentences that can face an uncallable card condition it the same way', () => {
    // The nominations lede was corrected first and the note under the grid
    // second; a third vocabulary here would read to a translator as a third
    // rule. The bill-only lede is not in this set and needs no condition.
    for (const locale of ['en', 'es'] as const) {
      const conditional = locale === 'en' ? /\bwhere\b/i : /\bcuando\b/i;
      for (const key of [
        'moments.vehiclesLedeMixed',
        'moments.vehiclesLedeNominations',
        'moments.bothNoteSomeNoCall',
      ] as const) {
        expect(lede(locale, key), `${key}/${locale}`).toMatch(conditional);
      }
      expect(lede(locale, 'moments.vehiclesLedeMixed'), locale).not.toBe(
        lede(locale, 'moments.vehiclesLedeNominations'),
      );
    }
  });

  /* THE WHOLE COMMITTED CORPUS, swept: every record the route would refuse is
     a record that reaches this sentence through a mixed set, so there is no
     nomination anywhere in data/nominations.json that would have made the
     removed universal true again. */
  test('every record the route refuses reaches this sentence', () => {
    expect(nominations.length).toBeGreaterThan(0);
    const refused = nominations.filter((n) => !nominationHasCallScript(n));
    expect(refused.length, 'the corpus contains records the route refuses').toBeGreaterThan(0);
    for (const n of refused) {
      expect(ledeKeyFor([...bills, nom(n)]), n.citation).toBe('moments.vehiclesLedeMixed');
    }
    // Both answers really occur — a sweep that only ever sees one proves nothing.
    expect(nominations.some((n) => nominationHasCallScript(n))).toBe(true);
  });
});

test.describe('revisionReasons', () => {
  const MESSAGES: Record<'en' | 'es', Record<string, unknown>> = {
    en: enMessages,
    es: esMessages,
  };

  /** What the page actually prints after "Rewritten because" / "Se reescribió
   *  porque" — the real ICU formatter, in the real locale, off the real
   *  message files. The key is composed at runtime here exactly as
   *  app/[locale]/questions/[id]/page.tsx composes it; the cast is what the
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

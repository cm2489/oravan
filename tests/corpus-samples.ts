/*
 * CORPUS SAMPLES — where the sweep specs and tests/routes.ts ask the
 * committed data for "a record like this" instead of naming one.
 *
 * Why this file exists (2026-09-27 audit, trap-analysis §4 "Corpus fixtures
 * and registries"): twenty-odd specs drove named bills — hr-5582-119,
 * sjres-99-119, hr-8553-119 — and one pinned a decoded headline word for
 * word. A named bill is a fact about one night's corpus, not about the
 * product. It turns red when the bill is re-decoded, settles, or is purged,
 * and worse, it can quietly stop being the KIND of bill the spec needs
 * (S.J.Res. 99 was the "stable" call-flow bill long after its motion to
 * proceed was rejected). Each helper below states the property the spec
 * depends on and picks a bill that has it, so the spec keeps testing the
 * promise while the corpus turns over.
 *
 * Rules every helper follows:
 *  - DATA-ONLY predicates. Nothing here reads the clock, so the pick at
 *    assertion time is the pick `next build` baked from the same committed
 *    JSON — no build-to-assert skew is possible. (Clock-dependent pools live
 *    in tests/corpus.ts, with its stability guard.)
 *  - DETERMINISTIC order (by slug, or the data file's own order), so a failure
 *    names the same bill on every rerun against the same corpus.
 *  - LOUD when empty. A helper whose pool is empty throws with the property it
 *    looked for, rather than returning a value that would make a spec pass
 *    vacuously or 404 into the right-looking header.
 *
 * tests/corpus.ts (the clock-parameterized mirror of lib/core's pools) is a
 * separate file on purpose; this one never mirrors production logic, it only
 * selects inputs. The bill-page and call-flow specs pick their bills by page
 * STATE (stepper sentence, journey ending, roll calls) in their own fixture
 * file, tests/corpus-fixtures.ts; this one serves the route sweeps and the
 * specs that only need "a decoded bill", and the two can be folded into one.
 */
import { billSlug, getAllBills, getAllLegislators } from '../lib/core';
import { districtsForZip, repsForDistrict } from '../lib/core/reps';
import { getAllNominations, nominationSlug } from '../lib/core/nominations';
import { getMoments } from '../lib/moments';
import { briefWindow } from '../lib/today';
import billsEsJson from '../data/bills-es.json';
import floorSignalsJson from '../data/floor-signals.json';
import zipDistricts from '../data/zip-districts.json';
import type { Bill, DecodedSections } from '../lib/types';

/** The raw Spanish overlay, read directly: lib/core's localizeBill falls back
 *  to English field by field, so its output cannot tell a translated bill
 *  from an untranslated one. */
const ES = billsEsJson as Record<
  string,
  { headline: string | null; summary: string | null; sections?: DecodedSections | null }
>;

function pick<T>(pool: T[], what: string): T {
  const first = pool[0];
  if (first === undefined) {
    throw new Error(`tests/corpus-samples.ts: the committed corpus has no ${what}.`);
  }
  return first;
}

const bySlug = (a: Bill, b: Bill) => billSlug(a).localeCompare(billSlug(b));

/** The what/who/why decode sections a bill page and its FAQ graph read. */
function sectionsComplete(s: DecodedSections | null | undefined): boolean {
  return Boolean(s && s.what && s.who && s.why);
}

/**
 * Bills decoded in BOTH languages: an English headline, summary and
 * what/who/why sections, a Spanish overlay carrying all three too, and both
 * record dates (introduced + last action) — everything the decoded bill page,
 * its JSON-LD Article + FAQPage graph and its social card render from.
 * Sorted by slug.
 */
export function decodedBills(): Bill[] {
  return getAllBills()
    .filter((b) => b.ai_headline && b.ai_summary && sectionsComplete(b.ai_sections))
    .filter((b) => b.introduced_date && b.last_action_date)
    .filter((b) => {
      const es = ES[billSlug(b)];
      return Boolean(es && es.headline && es.summary && sectionsComplete(es.sections));
    })
    .sort(bySlug);
}

/** The `n`th decoded bill (see decodedBills) — for the specs that need its
 *  number or headline as well as its slug. */
export function decodedBill(n = 0): Bill {
  return pick(decodedBills().slice(n), `decoded bill #${n} (bilingual, with both record dates)`);
}

/** The slug of the `n`th decoded bill. */
export function decodedBillSlug(n = 0): string {
  return billSlug(decodedBill(n));
}

/**
 * A bill with NO AI content in either language: no headline, summary or
 * sections, and no Spanish overlay. The page must fall back to the official
 * title and claim no AI provenance.
 */
export function undecodedBillSlug(): string {
  const undecoded = getAllBills()
    .filter((b) => !b.ai_headline && !b.ai_summary && !b.ai_sections && !ES[billSlug(b)])
    .sort(bySlug);
  return billSlug(pick(undecoded, 'undecoded bill (every bill is decoded — the undecoded path has no fixture)'));
}

const FLOOR_SIGNAL_SLUGS = new Set(
  Object.keys((floorSignalsJson as { signals?: Record<string, unknown> }).signals ?? {})
);

/**
 * A decoded bill in the call panel's PLAIN state: a regular bill (H.R. or S.,
 * so both chambers vote on it), still in committee, not terminal, carrying no
 * chamber floor announcement. That is the state where the full stance → script
 * → dial → outcome flow renders with no floor band, no chamber routing
 * sentence and no settled-record treatment in front of it — the fixture the
 * call-flow specs mean when they say "a bill page".
 */
export function callableBillSlug(): string {
  const pool = decodedBills()
    .filter((b) => b.bill_type === 'hr' || b.bill_type === 's')
    .filter((b) => b.status === 'committee')
    .filter((b) => !FLOOR_SIGNAL_SLUGS.has(billSlug(b)));
  return billSlug(pick(pool, 'decoded H.R./S. bill in committee with no floor announcement'));
}

/**
 * A Big Question whose page renders: the first non-retired moment in
 * data/moments.json order. `retired` is a STORED status (lib/moments.ts), so
 * this pick cannot drift with the clock; live, stale and settled all render.
 */
export function questionId(): string {
  return pick(
    getMoments().filter((m) => m.state !== 'retired'),
    'non-retired Big Question'
  ).id;
}

/** A sitting member's bioguide id — the first in the committed roster. */
export function memberBioguide(): string {
  return pick(getAllLegislators(), 'sitting member').bioguide;
}

/** A nomination with a reachable page (any record in data/nominations.json). */
export function nominationSlugSample(): string {
  return nominationSlug(pick(getAllNominations(), 'nomination'));
}

/**
 * A date the daily brief prerenders. The window is computed from committed
 * data, not the clock (lib/today.ts), so the newest day is as safe as any.
 */
export function briefDate(): string {
  return pick(briefWindow(), 'daily-brief date');
}

/**
 * A ZIP that spans two or more House districts, each with a sitting member —
 * the one input on the site that renders the street-address refinement form
 * (AddressForm) on /reps. First in the Census table's own key order.
 */
export function splitZip(): string {
  const zips = Object.keys(zipDistricts as Record<string, unknown>);
  return pick(
    zips.filter((zip) => {
      const districts = districtsForZip(zip);
      return districts.length > 1 && districts.every((d) => repsForDistrict(d).some((r) => r.type === 'rep'));
    }),
    'split ZIP'
  );
}

/** The House member of `zip`'s first district, by the name the page prints. */
export function firstHouseRepName(zip: string): string {
  const [district] = districtsForZip(zip);
  const rep = district ? repsForDistrict(district).find((r) => r.type === 'rep') : undefined;
  return pick(rep ? [rep.name] : [], `House member for ZIP ${zip}`);
}

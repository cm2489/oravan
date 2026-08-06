import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The import-free mapper (lib/nomination-status.mjs) — the SAME module the
// node sync script, the CI gate, and lib/core/nominations.ts all import.
import {
  NOMINATION_STATUSES,
  STORED_NOMINATION_STATUSES,
  TERMINAL_NOMINATION_STATUSES,
  UNCLASSIFIED_NOMINATION_STATUS,
  execCalendarNumber,
  isTerminalNominationStatus,
  mapNominationStatus,
} from '../lib/nomination-status.mjs';
// The bill mapper — imported ONLY to pin the bug that forced a separate one.
import { mapStatus } from '../scripts/congress-fetch.mjs';
import { nominationSlug as scriptNominationSlug } from '../scripts/nominations-fetch.mjs';
import { nominationSlug, type Nomination, type NominationStatus } from '../lib/core/nominations';

/*
 * SENATE NOMINATION STATUS — fixtures, the drift pins, and the corpus
 * consistency sweep.
 *
 * Every fixture string below is VERBATIM from a live Congress.gov record,
 * read 2026-08-06 across all 2,039 nominations of the 119th Congress. The
 * table covers all 33 distinct civilian action shapes plus the 10 distinct
 * military ones (military nominations are not ingested — see
 * scripts/nominations-fetch.mjs — but their sentences are the Senate's own
 * vocabulary and a civilian nomination can acquire any of them, most
 * importantly "Calendar No. DESK").
 *
 * WHAT IS NOT HERE, AND WHERE IT LIVES INSTEAD: there is no assertion that
 * the committed corpus contains ZERO unclassified records. That sweep tests
 * DATA, and data changes nightly — owner ruling 2026-08-04 moved exactly
 * this shape of check out of the PR-blocking suite (see
 * tests/journey.unit.spec.ts suite 4 and scripts/check-journey-corpus.mjs),
 * because a novel Senate sentence landed by the sync would otherwise red the
 * CI of unrelated PRs. It fires where the data changes instead:
 * scripts/check-nominations.mjs --strict, wired into sync-bills.yml. The
 * corpus sweep that DOES live here (suite 5) is the one immune to novel
 * vocabulary — it asserts the stored status is whatever the mapper derives
 * from the stored sentence, which holds whether or not a rule matched.
 */

/* ------------------------------------------------------------------ *
 * 1 · THE FIXTURE TABLE — one row per distinct live action shape.
 * ------------------------------------------------------------------ */
const LIVE_ACTIONS: [text: string, status: string][] = [
  // ---- terminal ----
  ['Confirmed by the Senate by Voice Vote.', 'confirmed'],
  ['Confirmed by the Senate by Yea-Nay Vote. 51 - 44. Record Vote Number: 220.', 'confirmed'],
  ['Confirmed by the Senate by Yea-Nay Vote. 60 - 25. Record Vote Number: 213.', 'confirmed'],
  ['Returned to the President under the provisions of Senate Rule XXXI, paragraph 6 of the Standing Rules of the Senate.', 'returned'],
  ['Received message of withdrawal of nomination from the President.', 'withdrawn'],
  // ---- scheduled: the only shape carrying a FUTURE date ----
  ['By unanimous consent agreement, debate 8/6/2026.', 'scheduled'],
  // ---- live floor proceedings ----
  ['Cloture motion presented in Senate.', 'floor'],
  ['Motion by Senator Thune to reconsider tabled in Senate by Yea-Nay Vote. 52 - 47. Record Vote Number: 38.', 'floor'],
  // ---- Executive Calendar (three shapes: numbered, numbered + commitment
  //      rider, and the Privileged-Nomination section with NO number) ----
  ['Placed on Senate Executive Calendar. Calendar No. 901.', 'exec_calendar'],
  ['Placed on Senate Executive Calendar. Calendar No. 913.', 'exec_calendar'],
  ["Placed on Senate Executive Calendar. Calendar No. 911. Subject to nominee's commitment to respond to requests to appear and testify before any duly constituted committee of the Senate.", 'exec_calendar'],
  ["Placed on Senate Executive Calendar. Calendar No. 876. Subject to nominee's commitment to respond to requests to appear and testify before any duly constituted committee of the Senate.", 'exec_calendar'],
  ['Placed on Senate Executive Calendar in the Privileged Nomination section with nominee information requested by the Committee on Agriculture, Nutrition, and Forestry, pursuant to S.Res. 116, 112th Congress.', 'exec_calendar'],
  ['Placed on Senate Executive Calendar. Calendar No. DESK.', 'exec_calendar'],
  ["Placed on Senate Executive Calendar. Calendar No. DESK. Subject to nominee's commitment to respond to requests to appear and testify before any duly constituted committee of the Senate.", 'exec_calendar'],
  // ---- committee ----
  ['Committee on Finance. Ordered to be reported favorably.', 'reported'],
  ['Committee on Armed Services. Hearings held.', 'hearing'],
  ['Committee on Banking, Housing, and Urban Affairs. Hearings held.', 'hearing'],
  ['Committee on Foreign Relations. Hearings held.', 'hearing'],
  ['Committee on the Judiciary. Hearings held.', 'hearing'],
  ["Committee on Veterans' Affairs. Hearings held.", 'hearing'],
  // ---- receipt / referral ----
  ['Received in the Senate and referred to the Committee on Agriculture, Nutrition, and Forestry.', 'received'],
  ['Received in the Senate and referred to the Committee on Armed Services.', 'received'],
  ['Received in the Senate and referred to the Committee on Banking, Housing, and Urban Affairs.', 'received'],
  ['Received in the Senate and referred to the Committee on Commerce, Science, and Transportation.', 'received'],
  ['Received in the Senate and referred to the Committee on Environment and Public Works.', 'received'],
  ['Received in the Senate and referred to the Committee on Finance.', 'received'],
  ['Received in the Senate and referred to the Committee on Foreign Relations.', 'received'],
  ['Received in the Senate and referred to the Committee on Health, Education, Labor, and Pensions.', 'received'],
  ['Received in the Senate and referred to the Committee on Homeland Security and Governmental Affairs.', 'received'],
  ['Received in the Senate and referred to the Committee on Rules and Administration.', 'received'],
  ['Received in the Senate and referred to the Committee on the Judiciary.', 'received'],
  ["Received in the Senate and referred to the Committee on Veterans' Affairs.", 'received'],
  // Referral WITHOUT the "Received in the Senate" prefix — three live rows.
  ['Referred to the Committee on Foreign Relations as requested by Senator Booker.', 'received'],
  ['Referred to the Committee on Foreign Relations as requested by Senator Kaine.', 'received'],
  ['Referred to the Committee on Foreign Relations as requested by Senator Murphy.', 'received'],
  // Sequential referrals. These contain "when reported by the Committee on
  // ..." while describing a REFERRAL, which is why the `reported` rule
  // carries a negative lookahead. The first also reproduces Congress.gov's
  // own typo ("squentially") verbatim — do not correct it, it is the record.
  ['Received in the Senate and referred sequentially to the Committee on Foreign Relations; when reported by the Committee on Foreign Relations, pursuant to an order of January 7, 2009, to be squentially referred to the Committee on Homeland Security and Governmental Affairs for 20 calendar days.', 'received'],
  ['Received in the Senate and referred to the Committee on Health, Education, Labor, and Pensions; when reported by the Committee on Health, Education, Labor, and Pensions, pursuant to an order of January 7, 2009, to be sequentially referred to the Committee on Homeland Security and Governmental Affairs for 20 calendar days.', 'received'],
];

test.describe('mapNominationStatus fixtures (verbatim live Congress.gov text)', () => {
  // The index prefixes the title because several live sentences are
  // identical for their first 64 characters (the referral rows differ only
  // in the senator's name), and Playwright refuses duplicate test titles.
  LIVE_ACTIONS.forEach(([text, expected], i) => {
    test(`#${i} ${expected} <- ${text.slice(0, 64)}${text.length > 64 ? '…' : ''}`, () => {
      expect(mapNominationStatus(text)).toBe(expected);
    });
  });

  test('the table covers every shape the mapper has a rule for', () => {
    const covered = new Set(LIVE_ACTIONS.map(([, s]) => s));
    expect([...covered].sort()).toEqual([...NOMINATION_STATUSES].sort());
  });

  test('an unknown sentence is unclassified, never a guess', () => {
    expect(mapNominationStatus('Something the Senate has never said before.')).toBe(
      UNCLASSIFIED_NOMINATION_STATUS
    );
    expect(mapNominationStatus('')).toBe(UNCLASSIFIED_NOMINATION_STATUS);
    expect(mapNominationStatus(null)).toBe(UNCLASSIFIED_NOMINATION_STATUS);
    expect(mapNominationStatus(undefined)).toBe(UNCLASSIFIED_NOMINATION_STATUS);
  });
});

/* ------------------------------------------------------------------ *
 * 2 · THE SINGLE MOST IMPORTANT CORRECTNESS PROPERTY.
 *
 *     A CONFIRMED nomination must NEVER map to a live-vote status. This
 *     is the reason nominations have their own mapper at all: the bill
 *     mapper (scripts/congress-fetch.mjs mapStatus) matches `yea-nay
 *     vote` at line 103 and returns `floor_vote` for the sentence
 *     announcing a completed confirmation — a claim that a vote is
 *     PENDING on a nomination the Senate finished, on 511 of the 857
 *     civilian records committed today.
 * ------------------------------------------------------------------ */
test.describe('a confirmed nomination is never a live vote', () => {
  const CONFIRMATIONS = LIVE_ACTIONS.filter(([, s]) => s === 'confirmed').map(([t]) => t);
  const LIVE_STATUSES = ['floor', 'scheduled', 'exec_calendar', 'hearing', 'reported', 'received'];

  test('every live confirmation sentence maps to `confirmed` and to nothing else', () => {
    expect(CONFIRMATIONS.length).toBeGreaterThan(0);
    for (const text of CONFIRMATIONS) {
      const status = mapNominationStatus(text);
      expect(status, text).toBe('confirmed');
      expect(LIVE_STATUSES, text).not.toContain(status);
      expect(isTerminalNominationStatus(status), text).toBe(true);
    }
  });

  /* The pin on WHY this module exists. If someone ever "simplifies" the two
     mappers back into one, this test states the exact damage: it asserts the
     bill mapper is still wrong here, so deleting mapNominationStatus cannot
     look harmless. If Congress.gov changes its wording such that mapStatus
     stops returning floor_vote, this test failing is the signal to re-derive
     the whole vocabulary — not to relax the assertion. */
  test('the bill mapper would call these completed confirmations `floor_vote`', () => {
    const yeaNay = CONFIRMATIONS.filter((t) => /yea-nay vote/i.test(t));
    expect(yeaNay.length).toBeGreaterThan(0);
    for (const text of yeaNay) expect(mapStatus(text), text).toBe('floor_vote');
  });

  test('and it would call an Executive Calendar placement `floor_vote` too', () => {
    expect(mapStatus('Placed on Senate Executive Calendar. Calendar No. 901.')).toBe('floor_vote');
    expect(mapNominationStatus('Placed on Senate Executive Calendar. Calendar No. 901.')).toBe(
      'exec_calendar'
    );
  });

  test('a recorded vote that is NOT a confirmation is never read as one', () => {
    // A reconsideration motion carries a yea-nay vote and a record vote
    // number, and is emphatically not a confirmation.
    expect(
      mapNominationStatus('Motion by Senator Thune to reconsider tabled in Senate by Yea-Nay Vote. 52 - 47. Record Vote Number: 38.')
    ).toBe('floor');
  });
});

/* ------------------------------------------------------------------ *
 * 3 · execCalendarNumber — a printed fact, or nothing.
 * ------------------------------------------------------------------ */
test.describe('execCalendarNumber', () => {
  test('reads the number out of a numbered placement', () => {
    expect(execCalendarNumber('Placed on Senate Executive Calendar. Calendar No. 901.')).toBe(901);
    expect(
      execCalendarNumber("Placed on Senate Executive Calendar. Calendar No. 911. Subject to nominee's commitment to respond to requests to appear and testify before any duly constituted committee of the Senate.")
    ).toBe(911);
  });

  /* THE DESK CASE. "Calendar No. DESK" is the Senate's own placeholder for a
     placement not yet assigned a number (19 live records on 2026-08-06). A
     naive Number() parse yields NaN, and a NaN reaching a surface prints
     "Calendar No. NaN" beside a real Senate claim. */
  test('DESK is not a number — it is the absence of one', () => {
    expect(execCalendarNumber('Placed on Senate Executive Calendar. Calendar No. DESK.')).toBeNull();
    expect(
      execCalendarNumber("Placed on Senate Executive Calendar. Calendar No. DESK. Subject to nominee's commitment to respond to requests to appear and testify before any duly constituted committee of the Senate.")
    ).toBeNull();
  });

  test('the Privileged-Nomination placement carries no number at all', () => {
    expect(
      execCalendarNumber('Placed on Senate Executive Calendar in the Privileged Nomination section with nominee information requested by the Committee on Agriculture, Nutrition, and Forestry, pursuant to S.Res. 116, 112th Congress.')
    ).toBeNull();
  });

  test('a non-placement sentence yields nothing', () => {
    expect(execCalendarNumber('Confirmed by the Senate by Voice Vote.')).toBeNull();
    expect(execCalendarNumber(null)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 4 · DRIFT PINS — the constants, and the TS union that mirrors them.
 * ------------------------------------------------------------------ */
test.describe('the status vocabulary is pinned', () => {
  test('nine classified statuses, three of them terminal', () => {
    expect([...NOMINATION_STATUSES].sort()).toEqual(
      ['confirmed', 'exec_calendar', 'floor', 'hearing', 'received', 'reported', 'returned', 'scheduled', 'withdrawn']
    );
    expect([...TERMINAL_NOMINATION_STATUSES].sort()).toEqual(['confirmed', 'returned', 'withdrawn']);
  });

  test('every terminal status is a real status', () => {
    for (const s of TERMINAL_NOMINATION_STATUSES) expect(NOMINATION_STATUSES).toContain(s);
  });

  test('the stored set is the classified nine plus `unclassified`', () => {
    expect([...STORED_NOMINATION_STATUSES].sort()).toEqual(
      [...NOMINATION_STATUSES, UNCLASSIFIED_NOMINATION_STATUS].sort()
    );
  });

  /* A two-way pin between the .mjs constant and lib/core/nominations.ts's TS
     union. The `Record<NominationStatus, true>` annotation makes TypeScript
     fail at COMPILE time if the union gains or loses a member without this
     table changing; the runtime assertion catches the .mjs side drifting. A
     union has no runtime value, so this table is the only way to compare
     them — the same problem, and the same fix, as lib/moments.ts's
     QUALIFYING_SIGNAL_TYPES. */
  const UNION_MEMBERS: Record<NominationStatus, true> = {
    received: true,
    hearing: true,
    reported: true,
    exec_calendar: true,
    floor: true,
    scheduled: true,
    confirmed: true,
    returned: true,
    withdrawn: true,
    unclassified: true,
  };

  test("lib/core/nominations.ts's NominationStatus union matches the .mjs set", () => {
    expect(Object.keys(UNION_MEMBERS).sort()).toEqual([...STORED_NOMINATION_STATUSES].sort());
  });
});

/* ------------------------------------------------------------------ *
 * 5 · CORPUS SWEEP — over the committed data/nominations.json.
 *
 *     Deliberately scoped to properties that novel Senate vocabulary
 *     CANNOT break (see this file's header): a sentence no rule matches
 *     maps to `unclassified` on both sides of every comparison below, so
 *     these stay green through a novel legislative week while still
 *     catching a real code/data divergence.
 * ------------------------------------------------------------------ */
const corpus: Nomination[] = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'nominations.json'), 'utf8')
);

test.describe('the committed nomination corpus', () => {
  test('is large enough for the sweeps below to prove something', () => {
    expect(corpus.length).toBeGreaterThan(500);
  });

  test('every stored status is what the mapper derives from that record’s own sentence', () => {
    for (const n of corpus) {
      expect(n.status, n.citation).toBe(mapNominationStatus(n.last_action_text));
    }
  });

  /* The suite-2 property, asserted against the DATA rather than the mapper —
     so the file itself can never publish a pending-vote claim over a
     finished nomination, whatever the mapper does. */
  test('no record whose sentence announces a confirmation carries a live status', () => {
    const confirmations = corpus.filter((n) => /\bconfirmed by the senate\b/i.test(n.last_action_text ?? ''));
    expect(confirmations.length).toBeGreaterThan(0);
    for (const n of confirmations) {
      expect(n.status, n.citation).toBe('confirmed');
      expect(isTerminalNominationStatus(n.status), n.citation).toBe(true);
    }
  });

  test('every stored calendar number is the one printed in the record, and only on a placement', () => {
    for (const n of corpus) {
      expect(n.exec_calendar_number, n.citation).toBe(execCalendarNumber(n.last_action_text));
      if (n.exec_calendar_number !== null) expect(n.status, n.citation).toBe('exec_calendar');
    }
  });

  /* Identity. A single presidential message is split into PARTS sharing one
     PN number, so keying on the number alone would collapse distinct people
     into one record. */
  test('slugs are unique and reproduce the citation', () => {
    const slugs = new Set<string>();
    for (const n of corpus) {
      const slug = nominationSlug(n);
      expect(slug, n.citation).toMatch(/^pn-\d+(-\d+)?-\d+$/);
      expect(slugs.has(slug), `duplicate slug ${slug}`).toBe(false);
      slugs.add(slug);
      const part = Number(n.part_number);
      expect(n.citation).toBe(`PN${n.pn_number}${part > 0 ? `-${part}` : ''}`);
    }
    expect(slugs.size).toBe(corpus.length);
  });

  /* The TS copy in lib/core/nominations.ts and the .mjs copy in
     scripts/nominations-fetch.mjs must answer identically — the same
     corpus-wide parity pin tests/journey.unit.spec.ts suite 6 applies to
     floorCalendarChamber's two copies. Two copies exist because the sync
     script runs on bare node (no TS loader) and the data layer is TS. */
  test('the script and lib slug builders agree on every record', () => {
    for (const n of corpus) {
      expect(
        scriptNominationSlug({
          number: n.pn_number,
          partNumber: n.part_number,
          congress: n.congress_number,
        }),
        n.citation
      ).toBe(nominationSlug(n));
    }
  });

  /* Nomination slugs must never be confusable with bill slugs: they share
     maps in the Moments pipeline's vehicle handling downstream. */
  test('the pn- namespace is disjoint from every bill slug prefix', () => {
    for (const n of corpus) expect(nominationSlug(n).startsWith('pn-'), n.citation).toBe(true);
  });
});

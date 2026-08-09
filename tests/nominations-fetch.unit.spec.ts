import { expect, test } from '@playwright/test';
import {
  isCivilianNomination as isCivilianRaw,
  nominationScanVerdict,
  nominationTypeOf as nominationTypeOfRaw,
  readableNominationAction as readableRaw,
  refreshNominationFields as refreshRaw,
  toNominationRecord as toNominationRecordRaw,
} from '../scripts/nominations-fetch.mjs';

/*
 * THE NOMINATION INGEST'S FAIL-CLOSED GUARDS.
 *
 * Everything here is pure: no network, no CONGRESS_API_KEY, no corpus. The
 * module's `cg()` import is never reached, which is the contract
 * scripts/nominations-fetch.mjs's header states.
 *
 * What these tests are FOR, stated plainly, because the guards look like
 * defensive noise until you know what they cost:
 *
 * refreshNominationFields used to write every action-derived field from
 * `item.latestAction?.text ?? null` unconditionally. A single degraded
 * Congress.gov reply — a 200 with the record mid-update, which is a thing
 * that happens — therefore took a CONFIRMED nomination, blanked the official
 * sentence Oravan quotes as its evidence, nulled the date, and re-derived the
 * status as `unclassified`. That is a settled fact about a named private
 * citizen, erased, and then re-reported by the nightly sweep as though the
 * Senate had said something new.
 *
 * The mirror hazard is toNominationRecord, which is strictly worse: on the
 * mint path there is no prior value for the nulls to contradict, so the
 * damaged record simply enters the corpus and looks like a nomination
 * Congress.gov has nothing to say about.
 */

/*
 * TYPES, AND WHY THEY ARE LOOSE HERE.
 *
 * scripts/nominations-fetch.mjs carries JSDoc describing the payloads
 * Congress.gov actually sends, and TypeScript reads it — correctly rejecting
 * a `null`, a missing `latestAction`, or a renamed `isCivilian` at these call
 * sites. Those are exactly the payloads these guards exist to survive: the
 * whole point is that the shape has stopped being what the JSDoc says.
 *
 * So the malformed inputs go through these thin wrappers, declared once and
 * named, rather than a cast scattered through every assertion — and the
 * production JSDoc keeps documenting the real contract instead of being
 * widened to `any` to make a test file compile.
 */
type Loose = Record<string, unknown>;
const nominationTypeOf = nominationTypeOfRaw as (item: unknown) => 'civilian' | 'military' | 'unrecognized';
const isCivilianNomination = isCivilianRaw as (item: unknown) => boolean;
const readableNominationAction = readableRaw as (
  item: unknown
) => { text?: string; actionDate?: string } | null;
const refreshNominationFields = refreshRaw as (
  existing: Loose,
  item: unknown
) => 'refreshed' | 'skipped_partial';
const toNominationRecord = toNominationRecordRaw as (item: unknown) => Loose | null;

/** A complete, readable list item — the shape every assertion below varies. */
const ITEM = {
  citation: 'PN852-1',
  congress: 119,
  number: 852,
  partNumber: '01',
  description: 'Jeffrey Brodsky, of Florida, to be a Governor of the United States Postal Service.',
  organization: 'United States Postal Service',
  receivedDate: '2025-06-02',
  updateDate: '2026-08-08T11:00:21Z',
  nominationType: { isCivilian: true },
  latestAction: {
    actionDate: '2026-07-30',
    text: 'Placed on Senate Executive Calendar. Calendar No. 838.',
  },
};

/** A stored corpus record for the same nomination, one action behind. */
const stored = (): Loose => ({
  citation: 'PN852-1',
  congress_number: 119,
  pn_number: 852,
  part_number: '01',
  nominee_description: 'Jeffrey Brodsky, of Florida, to be a Governor of the United States Postal Service.',
  organization: 'United States Postal Service',
  received_date: '2025-06-02',
  last_action_date: '2026-02-06',
  last_action_text: 'Confirmed by the Senate by Yea-Nay Vote. 53 - 47. Record Vote Number: 37.',
  status: 'confirmed',
  exec_calendar_number: null,
  update_date: '2026-02-07T11:00:21Z',
  congress_gov_url: 'https://www.congress.gov/nomination/119th-congress/852/1',
});

/* ------------------------------------------------------------------ *
 * 1 · readableNominationAction — the one definition of "we can read it".
 * ------------------------------------------------------------------ */
test.describe('readableNominationAction', () => {
  test('a payload carrying action text is readable', () => {
    expect(readableNominationAction(ITEM)).toBe(ITEM.latestAction);
  });

  test('every way the text can be absent is unreadable', () => {
    expect(readableNominationAction({})).toBeNull();
    expect(readableNominationAction({ latestAction: null })).toBeNull();
    expect(readableNominationAction({ latestAction: {} })).toBeNull();
    expect(readableNominationAction({ latestAction: { text: '' } })).toBeNull();
    expect(readableNominationAction(null)).toBeNull();
    expect(readableNominationAction(undefined)).toBeNull();
  });

  /* A DATE WITH NO TEXT IS NOT READABLE, and this is the asymmetry worth
     pinning. It cannot produce a status — every rule in
     lib/nomination-status.mjs reads the sentence — and pinning a newer date
     onto the older stored text would overstate how fresh the record is, the
     one direction this pipeline must never err in. */
  test('a bare actionDate with no text is not readable', () => {
    expect(readableNominationAction({ latestAction: { actionDate: '2026-08-01' } })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 2 · refreshNominationFields — writes everything, or writes nothing.
 * ------------------------------------------------------------------ */
test.describe('refreshNominationFields', () => {
  test('a readable payload updates the record and signals `refreshed`', () => {
    const record = stored();
    expect(refreshNominationFields(record, ITEM)).toBe('refreshed');
    expect(record.last_action_text).toBe('Placed on Senate Executive Calendar. Calendar No. 838.');
    expect(record.last_action_date).toBe('2026-07-30');
    expect(record.status).toBe('exec_calendar');
    expect(record.exec_calendar_number).toBe(838);
    expect(record.update_date).toBe('2026-08-08T11:00:21Z');
  });

  /*
   * THE BUG, AS A TEST. Every field is compared, not just the ones the old
   * code got wrong, because "nothing was touched" is the whole promise —
   * a guard that preserved the status but blanked the sentence would be no
   * guard at all.
   */
  test('an unreadable payload changes NOTHING and signals `skipped_partial`', () => {
    const record = stored();
    const before = JSON.parse(JSON.stringify(record));
    const degraded = { ...ITEM, latestAction: undefined };
    expect(refreshNominationFields(record, degraded)).toBe('skipped_partial');
    expect(record).toEqual(before);
  });

  /* The specific damage, named. Without the guard this record came out of a
     degraded reply as status `unclassified` with a null sentence and a null
     date — a confirmed nomination reopened. */
  test('a degraded reply cannot un-confirm a confirmed nomination', () => {
    const record = stored();
    refreshNominationFields(record, { ...ITEM, latestAction: {} });
    expect(record.status).toBe('confirmed');
    expect(record.last_action_text).toContain('Confirmed by the Senate');
    expect(record.last_action_date).toBe('2026-02-06');
  });

  /* Not even the non-action fields are written. A reply we have decided not
     to trust is not half-trustworthy, and nothing is lost by waiting:
     Congress.gov's own updateDate keeps the record in the next run's window. */
  test('an unreadable payload does not even apply a description backfill', () => {
    const record = stored();
    record.nominee_description = null;
    refreshNominationFields(record, {
      ...ITEM,
      latestAction: undefined,
      description: 'A description that arrived with an unreadable action.',
    });
    expect(record.nominee_description).toBeNull();
  });

  /*
   * THE ONE PARTIAL PAYLOAD STILL WRITTEN: text without an actionDate. The
   * text is the record and maps to a status on its own, and the stored date
   * is PRESERVED rather than nulled — it is the date of an action that really
   * happened, so keeping it can only understate this record's freshness,
   * never overstate it, while null erases the signal outright.
   */
  test('text without a date is written, and the stored date is preserved', () => {
    const record = stored();
    const result = refreshNominationFields(record, {
      ...ITEM,
      latestAction: { text: 'Committee on Finance. Ordered to be reported favorably.' },
    });
    expect(result).toBe('refreshed');
    expect(record.status).toBe('reported');
    expect(record.last_action_date).toBe('2026-02-06');
  });

  test('the congress.gov URL self-heals on every readable refresh', () => {
    const record = stored();
    record.congress_gov_url = 'https://www.congress.gov/nomination/119th-congress/852/01';
    refreshNominationFields(record, ITEM);
    expect(record.congress_gov_url).toBe('https://www.congress.gov/nomination/119th-congress/852/1');
  });
});

/* ------------------------------------------------------------------ *
 * 3 · toNominationRecord — mints a whole record, or mints nothing.
 * ------------------------------------------------------------------ */
test.describe('toNominationRecord', () => {
  test('a readable item becomes a complete record', () => {
    const record = toNominationRecord(ITEM);
    // Narrowed rather than asserted-then-dereferenced: the return type is
    // `record | null` now, and that is the whole point of this suite.
    if (record === null) throw new Error('a readable item must mint a record');
    expect(record.citation).toBe('PN852-1');
    expect(record.status).toBe('exec_calendar');
    expect(record.exec_calendar_number).toBe(838);
    expect(record.last_action_text).toBe('Placed on Senate Executive Calendar. Calendar No. 838.');
  });

  /*
   * Nothing is minted from a reply we cannot read. The alternative — storing
   * it with explicit nulls — has no honest value for `status`: every reader
   * (lib/journey.ts's liveCallTargetForNomination, the nomination page's
   * status line, scripts/check-nominations.mjs) expects one of the mapped
   * strings, and any placeholder would be a claim about the official record
   * that was never read.
   */
  test('an unreadable item mints nothing at all', () => {
    expect(toNominationRecord({ ...ITEM, latestAction: undefined })).toBeNull();
    expect(toNominationRecord({ ...ITEM, latestAction: { actionDate: '2026-08-01' } })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 4 · nominationTypeOf — the upstream-shape tripwire.
 *
 *     The civilian filter is only an exact test while every record declares
 *     isCivilian XOR isMilitary. If Congress.gov renames or restructures
 *     that field, the filter goes false across the board, the sync ingests
 *     nothing, and — before 2026-08-09 — the cursor advanced anyway and the
 *     corpus froze permanently while every night logged a clean success.
 *     'unrecognized' is what makes that visible instead of silent.
 * ------------------------------------------------------------------ */
test.describe('nominationTypeOf', () => {
  test('classifies the two shapes Congress.gov actually sends', () => {
    expect(nominationTypeOf({ nominationType: { isCivilian: true } })).toBe('civilian');
    expect(nominationTypeOf({ nominationType: { isMilitary: true } })).toBe('military');
  });

  test('anything that declares neither is `unrecognized`, never quietly military', () => {
    // The rename case — the exact failure this exists to catch.
    expect(nominationTypeOf({ nominationType: { civilian: true } })).toBe('unrecognized');
    expect(nominationTypeOf({ nominationType: {} })).toBe('unrecognized');
    expect(nominationTypeOf({ nominationType: null })).toBe('unrecognized');
    expect(nominationTypeOf({})).toBe('unrecognized');
    expect(nominationTypeOf(null)).toBe('unrecognized');
    // A string "true" is not true — the filter is an exact test, not a truthy one.
    expect(nominationTypeOf({ nominationType: { isCivilian: 'true' } })).toBe('unrecognized');
  });

  test('isCivilianNomination is that classification and nothing else', () => {
    expect(isCivilianNomination({ nominationType: { isCivilian: true } })).toBe(true);
    expect(isCivilianNomination({ nominationType: { isMilitary: true } })).toBe(false);
    expect(isCivilianNomination({ nominationType: { civilian: true } })).toBe(false);
    expect(isCivilianNomination(null)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 5 · nominationScanVerdict — may the cursor advance through this scan?
 *
 *     The cursor decides which window the NEXT run reads, so advancing it
 *     is a claim that everything before it is handled. Advancing through a
 *     scan that wrote nothing is the one failure this pipeline has that is
 *     both permanent and completely silent: the corpus freezes, and every
 *     night afterwards reads a window starting past records it never
 *     ingested, finds nothing, advances again, and logs a clean success.
 * ------------------------------------------------------------------ */
test.describe('nominationScanVerdict', () => {
  test('a scan that wrote something may advance', () => {
    expect(nominationScanVerdict({ rawSeen: 95, added: 3, refreshed: 40, unrecognized: 0 })).toBe('ok');
    expect(nominationScanVerdict({ rawSeen: 95, added: 1, refreshed: 0, unrecognized: 0 })).toBe('ok');
    expect(nominationScanVerdict({ rawSeen: 95, added: 0, refreshed: 1, unrecognized: 0 })).toBe('ok');
  });

  /* An EMPTY window is not a stall. Congress.gov simply had nothing new, and
     the cursor must advance or the sync never moves forward at all. */
  test('a scan that read nothing at all may advance', () => {
    expect(nominationScanVerdict({ rawSeen: 0, added: 0, refreshed: 0, unrecognized: 0 })).toBe('ok');
  });

  /* Read records, wrote none. Ordinary on a military-only night, which is why
     it is a warning rather than an error — but the cursor still holds, because
     "wrote none" cannot support the claim that the window is handled. */
  test('reading records and writing none holds the cursor', () => {
    expect(nominationScanVerdict({ rawSeen: 95, added: 0, refreshed: 0, unrecognized: 0 })).toBe('stalled');
  });

  /*
   * THE EXACT TRIPWIRE. An unrecognized record means Congress.gov changed the
   * field this pipeline filters on, and it outranks everything: it is fatal
   * even on a scan that wrote plenty, because the records it silently dropped
   * are the ones nobody would ever notice were missing.
   */
  test('an unrecognized record is fatal, even when the scan wrote plenty', () => {
    expect(nominationScanVerdict({ rawSeen: 250, added: 10, refreshed: 200, unrecognized: 1 })).toBe(
      'shape_changed'
    );
    expect(nominationScanVerdict({ rawSeen: 250, added: 0, refreshed: 0, unrecognized: 250 })).toBe(
      'shape_changed'
    );
  });
});

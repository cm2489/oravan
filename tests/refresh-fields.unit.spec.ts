import { expect, test } from '@playwright/test';
// Pure, I/O-free module (no CONGRESS_API_KEY needed) — refreshBillFields only
// maps an already-fetched bill-detail payload onto a corpus record.
import { mapStatus, readableAction, refreshBillFields } from '../scripts/congress-fetch.mjs';
import { passesGate } from '../scripts/decode-gate.mjs';
import { anyDataChanged } from '../scripts/newsdesk-match.mjs';

/*
 * PINS the partial-payload guard. Before it, a 200 whose `latestAction` was
 * absent (a mid-update record, or a degraded Congress.gov reply) silently
 * REWROTE the bill: mapStatus(undefined) fell through to 'committee' and
 * last_action_date was assigned null unconditionally, while last_action_text
 * alone had a `?? existing` fallback and kept its old value. A bill on the
 * Senate calendar came out as 'committee', dated null, still carrying
 * "Placed on Senate Legislative Calendar" — internally inconsistent, below
 * every urgency floor, gone from the homepage "Act now" band, and read by
 * visitors as a quiet week. hot-bills.yml has no verify step to catch it.
 *
 * If one of these fails, the guard moved: re-derive it deliberately (and
 * update refreshBillFields' own comment) rather than loosening the pin.
 */

/** A floor_vote bill exactly as data/bills.json stores one. */
function floorBill() {
  return {
    full_identifier: 's-3752-119',
    congress_number: 119,
    bill_type: 's',
    bill_number: 3752,
    title: 'A bill to do a thing',
    last_action_date: '2026-08-05',
    last_action_text: 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 412.',
    status: 'floor_vote',
    issue_tags: ['health'],
    policy_area: 'Health',
    urgency_score: 0.85,
    congress_gov_url: 'https://www.congress.gov/bill/119th-congress/senate-bill/3752',
  };
}

test.describe('refreshBillFields — partial payloads never downgrade a bill', () => {
  test('no latestAction at all: status, date AND text all survive untouched', () => {
    const bill = floorBill();
    const before = structuredClone(bill);

    const outcome = refreshBillFields(bill, { policyArea: { name: 'Health' } });

    expect(outcome).toBe('skipped_partial'); // the skip is signaled, not silent
    expect(bill).toEqual(before); // byte-identical: NOTHING was written
    // Spelled out individually — these three are the ones that used to drift
    // apart from each other, which is what made the damage invisible.
    expect(bill.status).toBe('floor_vote');
    expect(bill.last_action_date).toBe('2026-08-05');
    expect(bill.last_action_text).toBe(before.last_action_text);
    expect(bill.urgency_score).toBe(0.85);
  });

  test('an empty latestAction object is the same skip', () => {
    const bill = floorBill();
    const before = structuredClone(bill);
    expect(refreshBillFields(bill, { latestAction: {} })).toBe('skipped_partial');
    expect(bill).toEqual(before);
  });

  test('a date with no text also skips — a bare date cannot produce a status, and pinning it to the older stored text would overstate freshness', () => {
    const bill = floorBill();
    const before = structuredClone(bill);
    expect(refreshBillFields(bill, { latestAction: { actionDate: '2026-08-07' } })).toBe('skipped_partial');
    expect(bill).toEqual(before);
  });

  test('text with no actionDate: the text is applied, the stored date is PRESERVED rather than nulled', () => {
    const bill = floorBill();

    const outcome = refreshBillFields(bill, {
      latestAction: { text: 'Passed Senate without amendment by Unanimous Consent.' },
      policyArea: { name: 'Health' },
    });

    expect(outcome).toBe('refreshed');
    expect(bill.status).toBe('passed_chamber');
    expect(bill.last_action_text).toBe('Passed Senate without amendment by Unanimous Consent.');
    // Never null: the stored date is the date of an action that really
    // happened, so keeping it can only understate this bill's freshness
    // (urgencyScore's recency bonus, lib/freshness.ts's newestAction) —
    // nulling erases the signal outright.
    expect(bill.last_action_date).toBe('2026-08-05');
    expect(bill.urgency_score).toBeGreaterThan(0);
  });

  test('a bill with no stored date and a date-less payload lands on null, not undefined', () => {
    const bill = { ...floorBill(), last_action_date: null };
    expect(refreshBillFields(bill, { latestAction: { text: 'Referred to the Committee on Finance.' } })).toBe('refreshed');
    expect(bill.last_action_date).toBeNull();
    expect(bill.status).toBe('committee');
  });

  test('a complete payload still updates every refreshable field exactly as before', () => {
    const bill = floorBill();

    const outcome = refreshBillFields(bill, {
      latestAction: { text: 'Became Public Law No: 119-42.', actionDate: '2026-08-08' },
      policyArea: { name: 'Energy' },
    });

    expect(outcome).toBe('refreshed');
    expect(bill.status).toBe('signed');
    expect(bill.last_action_date).toBe('2026-08-08');
    expect(bill.last_action_text).toBe('Became Public Law No: 119-42.');
    expect(bill.policy_area).toBe('Energy');
    expect(bill.issue_tags).toEqual(['environment_energy']);
    expect(bill.congress_gov_url).toBe('https://www.congress.gov/bill/119th-congress/senate-bill/3752');
    expect(bill.urgency_score).toBeGreaterThan(0);
  });

  test('a genuine committee referral still downgrades — the guard blocks unreadable payloads, not real news', () => {
    const bill = floorBill();
    expect(refreshBillFields(bill, {
      latestAction: { text: 'Referred to the Committee on Finance.', actionDate: '2026-08-08' },
    })).toBe('refreshed');
    expect(bill.status).toBe('committee');
    expect(bill.last_action_date).toBe('2026-08-08');
  });
});

/*
 * The NEW-BILL half of the same guard (scripts/bill-decode.mjs's syncOneBill).
 * Before it, `last_action_text: d.latestAction?.text ?? null` wrote straight
 * through: a forced slug whose payload had no latestAction MINTED a published
 * record with an invented 'committee' status, a null date and null text — and
 * spent a decode doing it. That is how hr-2-119, hr-5-119 and hr-10-119 got
 * into the corpus with null text AND null date.
 *
 * syncOneBill itself is network-bound (cg + Anthropic), so what is pinned here
 * is the shared predicate BOTH paths now branch on — readableAction is one
 * function with two call sites, so these pins govern the new-bill branch and
 * the refresh branch alike.
 */
test.describe('readableAction — the one definition of a payload worth writing', () => {
  test('a payload with action text is readable and hands back the action itself', () => {
    const action = { text: 'Passed House by recorded vote.', actionDate: '2026-08-08' };
    expect(readableAction({ latestAction: action })).toBe(action);
  });

  test('text without a date is still readable — the text is the record', () => {
    expect(readableAction({ latestAction: { text: 'Passed House.' } })).toEqual({ text: 'Passed House.' });
  });

  test('every unreadable shape returns null, so neither path writes anything', () => {
    expect(readableAction(undefined)).toBeNull(); // a reply with no .bill at all
    expect(readableAction({})).toBeNull(); // no latestAction key
    expect(readableAction({ latestAction: null })).toBeNull();
    expect(readableAction({ latestAction: {} })).toBeNull();
    expect(readableAction({ latestAction: { actionDate: '2026-08-08' } })).toBeNull(); // date only
    expect(readableAction({ latestAction: { text: '' } })).toBeNull(); // empty text maps to 'committee'
  });
});

test.describe('a new bill is never minted from an unreadable payload', () => {
  test('the status such a record would have carried was invented, never read', () => {
    // This is precisely what the old code stored: mapStatus of nothing is a
    // real, gate-relevant status string with no official record behind it.
    expect(mapStatus(undefined)).toBe('committee');
    expect(mapStatus('')).toBe('committee');
    // There is no honest null to store instead — the read side expects one of
    // the mapped strings — so the record is not created at all.
    expect(readableAction({ latestAction: {} })).toBeNull();
  });

  test('the guard runs BEFORE the priority gate, because "gated" is a claim the payload cannot support', () => {
    // A non-forced new bill used to reach 'gated' only via that invented
    // 'committee' — accidentally harmless, for a reason that was not true.
    // 'gated' asserts the bill shows no real legislative motion; an
    // unreadable payload asserts nothing about the bill at all.
    expect(passesGate(mapStatus(undefined))).toBe(false); // the old accidental path
    expect(readableAction({ latestAction: { actionDate: '2026-08-08' } })).toBeNull(); // the deliberate one
  });

  test('a readable payload still decides the gate on its real status — forced slugs decode as before', () => {
    const floor = readableAction({ latestAction: { text: 'Placed on Senate Legislative Calendar under General Orders.' } });
    expect(floor).not.toBeNull();
    expect(passesGate(mapStatus(floor!.text))).toBe(true);
    const referral = readableAction({ latestAction: { text: 'Referred to the Committee on Finance.' } });
    expect(referral).not.toBeNull();
    expect(passesGate(mapStatus(referral!.text))).toBe(false); // still gated, on a status we actually read
  });
});

test.describe('the skip sentinel travels to the callers', () => {
  test('newsdesk treats skipped_partial as no data change — nothing written, nothing committed', () => {
    // syncOneBill returns the sentinel verbatim as its outcome, so this is
    // the string newsdesk.mjs's no-change-no-commit guard actually sees.
    expect(anyDataChanged(['skipped_partial'])).toBe(false);
    expect(anyDataChanged(['skipped_partial', 'failed', 'budget'])).toBe(false);
    expect(anyDataChanged(['skipped_partial', 'refreshed'])).toBe(true);
  });
});

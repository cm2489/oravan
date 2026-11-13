import type { CongressPolicy } from '../../lib/congress.mjs';
import { getAllBills } from '../../lib/core/bills';
import type { Bill } from '../../lib/types';

/*
 * FIXTURES FOR THE ENDED STATE (stage 3 of the new-Congress work, 2026-11-13).
 * Each is a real committed record with only the fields under test replaced, so
 * no nightly sync can turn a spec red: a bill both chambers passed can be
 * signed any night, and a quiet week has no live floor fact to stand on.
 */

/** The policy every ended spec runs under: 119 ended, 120 tracked. */
export const ENDED_119: CongressPolicy = Object.freeze({
  tracked: 120,
  ended: Object.freeze([Object.freeze({ number: 119, ended: '2027-01-03' })]),
});

/** A decoded House bill of the committed corpus, the base of every fixture. */
export const BASE: Bill = getAllBills().find((b) => b.bill_type === 'hr' && b.ai_headline)!;

/** Still in committee: the ended note's case. */
export const COMMITTEE_FIXTURE: Bill = {
  ...BASE,
  bill_number: 99_000,
  full_identifier: 'hr-99000-119',
  congress_number: 119,
  status: 'committee',
  last_action_text: 'Referred to the Committee on Ways and Means.',
  last_action_date: '2026-10-01',
  status_basis_text: null,
  status_basis_date: null,
} as Bill;

/** A House bill the Senate passed without amendment: passageState 'both'. */
export const PRESENTED_FIXTURE: Bill = {
  ...BASE,
  bill_number: 99_001,
  full_identifier: 'hr-99001-119',
  congress_number: 119,
  status: 'passed_chamber',
  last_action_text: 'Passed Senate without amendment by Unanimous Consent.',
  last_action_date: '2026-11-10',
  status_basis_text: null,
  status_basis_date: null,
  text_version_type: null,
} as Bill;

/** A Senate concurrent resolution the House agreed to in the form
 *  concurrentAdoptedBy declines to read, with its enrolled text on the record
 *  (the shape of S.Con.Res. 29 and S.Con.Res. 2 on 2026-11-13). */
export const ENROLLED_CONCURRENT_FIXTURE: Bill = {
  ...BASE,
  bill_type: 'sconres',
  bill_number: 99_002,
  full_identifier: 'sconres-99002-119',
  congress_number: 119,
  status: 'passed_chamber',
  last_action_text: 'Motion to reconsider laid on the table Agreed to without objection.',
  last_action_date: '2026-04-20',
  status_basis_text: 'Passed/agreed to in House: On agreeing to the resolution Agreed to without objection.',
  status_basis_date: '2026-04-20',
  text_version_type: 'Enrolled Bill',
} as Bill;

/** A law: Public Law 119-21 for good. */
export const LAW: Bill = getAllBills().find((b) => b.full_identifier === 'hr-1-119')!;

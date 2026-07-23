/**
 * The priority decode gate (2026-07-16, owner directive: reduce spend right
 * now by focusing the AI decode pass on a priority set of legislation —
 * "what's up for a vote, what's in the news… the majority of the 2,147
 * bills is junk with high odds of never going anywhere"). Split into its
 * own tiny, I/O-free module so the gate decision itself is directly
 * unit-testable without mocking Congress.gov or Anthropic — see
 * tests/decode-gate.unit.spec.ts.
 *
 * ---- Status distribution across the full 2,147-bill corpus, sampled
 * 2026-07-16 (data/bills.json, mapStatus's output field — see
 * scripts/congress-fetch.mjs) ----
 *   committee:       1,706  (79.5%)
 *   floor_vote:        152  ( 7.1%)
 *   passed_chamber:    147  ( 6.8%)
 *   markup:            115  ( 5.4%)
 *   signed:             27  ( 1.3%)
 *   (conference, vetoed: 0 today — mapStatus supports both, neither is
 *   currently mapped onto any bill in the corpus)
 *
 * ---- The CRITICAL NUANCE: does 'committee' mean mere day-1 referral, or
 * real committee action? ----
 * Sampled the 1,706 'committee'-status bills' last_action_text directly:
 * 1,573/1,706 (92.2%) literally start with "Referred to the … Committee
 * on …" — the automatic first action every single bill gets on
 * introduction, zero legislative motion. The remaining 133 (7.8%) are
 * genuine sub-committee activity (e.g. "Committee on Veterans' Affairs.
 * Hearings held.", "Subcommittee Hearings Held", "Committee Consideration
 * and Mark-up Session Held") that `mapStatus` happens to miscategorize as
 * 'committee' instead of 'markup' — e.g. "Committee Consideration and
 * Mark-up Session Held" doesn't match `text.includes('markup')` because of
 * the hyphen in "Mark-up". `mapStatus` itself (scripts/congress-fetch.mjs)
 * is out of scope for this change — this gate treats its 'committee'
 * output as untrustworthy en masse rather than adding a second classifier
 * here.
 *
 * ---- Chosen gate line ----
 * A bill passes ONLY if mapStatus returned something OTHER than
 * 'committee' — markup / floor_vote / passed_chamber / conference /
 * signed / vetoed all count as "real legislative motion" per the owner's
 * directive; 'committee' does not, because it is dominated (92%) by mere
 * referral. (Historical note: this comment once cited ~133 real-action
 * bills miscategorized by mapStatus's "Mark-up" hyphen gap; that gap was
 * closed in PR #90 — mapStatus now matches both spellings — so the gate's
 * recall loss today is referral-stage bills only. Those get their page the
 * moment they show real motion, or sooner via a newsdesk/tier-0 signal
 * fire, which force-bypasses this gate.)
 *
 * At today's distribution, roughly 20.5% of bills (441/2,147) would clear
 * this line — matching the owner's own framing that "the majority… is
 * junk with high odds of never going anywhere."
 */

export const GATE_PASS_STATUSES = new Set([
  'markup',
  'floor_vote',
  'passed_chamber',
  'conference',
  'signed',
  'vetoed',
]);

/** True if `status` (mapStatus's output) shows real legislative motion and
 *  should be allowed through the decode gate. */
export function passesGate(status) {
  return GATE_PASS_STATUSES.has(status);
}

/** Parse a comma-separated slug list (FORCE_DECODE_SLUGS env, or a
 *  programmatically-built set) into a lower-cased Set. Bypasses the gate
 *  for exactly these slugs — used by workflow_dispatch manual runs and by
 *  scripts/newsdesk.mjs, which builds its own force set in-process from
 *  headline-matched bills rather than round-tripping through the env var. */
export function parseForceSlugs(raw) {
  return new Set(
    String(raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

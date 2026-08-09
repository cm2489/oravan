// The journey-corpus tripwire, at the layer where the corpus changes.
//
// Owner ruling 2026-08-04: this sweep used to live in the PR-blocking unit
// suite, where a novel floor-action text landed by the NIGHTLY SYNC could
// red the CI of unrelated PRs. It belongs here instead — run by
// sync-bills.yml right after the corpus updates — so an unclassifiable
// shape fails the sync run (loud, attributable, actionable: extend
// floorActionChamber in lib/journey.ts) while the site, until that rule
// lands, renders the chamber-free neutral copy rather than a guess
// (deriveJourney's null branch — the render can no longer lie either way).
//
// Runs lib/journey.ts via tsx (a devDependency; sync-bills.yml does a full
// npm ci). Exit 1 = at least one floor_vote action text neither matcher
// classifies. The fixtures + the .mjs-copy parity pin stay in
// tests/journey.unit.spec.ts — they test CODE and belong with PRs; this
// file tests DATA and belongs with the sync.
import { spawnSync } from 'node:child_process';

const driver = `
import { readFileSync } from 'node:fs';
import { floorCalendarChamber, floorActionChamber, floorPendingChamber, floorSettledChamber } from './lib/journey';
const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
const floorVote = bills.filter((b) => b.status === 'floor_vote');
if (floorVote.length < 50) {
  console.error(\`::error::journey-corpus: only \${floorVote.length} floor_vote bills — the sweep would prove nothing; check the sync output\`);
  process.exit(1);
}
const unclassified = floorVote.filter(
  (b) => floorCalendarChamber(b.last_action_text) === null && floorActionChamber(b.last_action_text) === null
);
for (const b of unclassified) {
  console.error(\`::error::journey-corpus: unclassified floor text on \${b.bill_type}-\${b.bill_number} — extend floorActionChamber (lib/journey.ts); until then this bill renders the neutral no-chamber copy: \${b.last_action_text}\`);
}

/*
 * THE TENSE SWEEP (2026-08-09), the second half of the same tripwire.
 *
 * Knowing WHICH chamber a floor sentence belongs to is not knowing what that
 * chamber DID, and conflating the two is what printed "the Senate is deciding
 * whether to bring it to a vote" over 18 motions the Senate had already voted
 * down. deriveJourney now splits those texts with floorPendingChamber (a vote
 * is ahead) and floorSettledChamber (the vote happened and failed).
 *
 * A text that is chamber-classifiable but matches NEITHER is not a lie — it
 * falls to the residual live-deliberation copy — but it IS a shape nobody has
 * read, wearing the loudest of the three sentences. That is worth a sync
 * failure and a human look, which is exactly what this file is for. It sweeps
 * DATA, so it belongs here rather than in the PR-blocking unit suite (owner
 * ruling 2026-08-04): a novel sentence must fail the run that introduced it,
 * never the CI of an unrelated PR.
 */
const untensed = floorVote.filter(
  (b) =>
    floorCalendarChamber(b.last_action_text) === null &&
    floorActionChamber(b.last_action_text) !== null &&
    floorPendingChamber(b.last_action_text) === null &&
    floorSettledChamber(b.last_action_text) === null
);
for (const b of untensed) {
  console.error(\`::error::journey-corpus: floor text on \${b.bill_type}-\${b.bill_number} names a chamber but says neither "a vote is coming" nor "the motion failed" — extend floorPendingChamber or FLOOR_SETTLED (lib/journey.ts); until then it renders the live-deliberation copy: \${b.last_action_text}\`);
}

if (unclassified.length || untensed.length) process.exit(1);
console.log(\`journey-corpus clean: \${floorVote.length} floor_vote texts, all classified and all tensed\`);
`;

const res = spawnSync('npx', ['tsx', '--eval', driver], { stdio: 'inherit', cwd: process.cwd() });
process.exit(res.status ?? 1);

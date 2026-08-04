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
import { floorCalendarChamber, floorActionChamber } from './lib/journey';
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
if (unclassified.length) process.exit(1);
console.log(\`journey-corpus clean: \${floorVote.length} floor_vote texts, all classified\`);
`;

const res = spawnSync('npx', ['tsx', '--eval', driver], { stdio: 'inherit', cwd: process.cwd() });
process.exit(res.status ?? 1);

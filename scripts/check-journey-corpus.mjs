// The journey-corpus tripwire, at the layer where the corpus changes.
//
// Owner ruling 2026-08-04, unchanged: this sweep used to live in the
// PR-blocking unit suite, where a novel floor-action text landed by the
// NIGHTLY SYNC could red the CI of unrelated PRs. It belongs here instead —
// run by sync-bills.yml right after the corpus updates — so an unreadable
// shape is discovered by the run that introduced it. The fixtures + the
// .mjs-copy parity pin stay in tests/journey.unit.spec.ts: they test CODE and
// belong with PRs; this file tests DATA and belongs with the sync.
//
// WHAT CHANGED 2026-08-12 (owner ruling N9-A2): the CONSEQUENCE, not the
// sweep. Finding a novel sentence used to exit 1 as the FIRST step of the
// nightly, which skipped every step below it — nominations, coverage, Moment
// updates, portraits, the commit — and left up to MAX_NEW_DECODES of paid
// decodes in a salvage artifact for somebody to cherry-pick by hand. The
// justification was real at the time: deriveJourney's residual branch asserted
// "the {chamber} is deciding whether to bring it to a vote" over a text nobody
// had read, and blocking the commit was the only thing keeping that sentence
// off the site. It no longer is. That branch now routes through
// floorPendingChamber, so an unmatched text renders the chamber-free neutral
// sentence and no surface can lie about a shape we have not read. With nothing
// left to protect, the whole-night blast radius stopped being justified: this
// script now REPORTS, and sync-bills.yml opens a labeled `journey-corpus`
// issue carrying the sentence.
//
// EXIT CODES — the workflow reads `verdict` from $GITHUB_OUTPUT, a human
// reads these:
//   0  clean
//   1  at least one novel floor text (soft: issue filed, the night commits)
//   2  the corpus is too small for the sweep to prove anything (HARD: the
//      night fails, because a green tripwire over an empty corpus reads as an
//      all-clear and is worse than no tripwire at all)
//
// Runs lib/journey.ts via tsx (a devDependency; sync-bills.yml does a full
// npm ci).
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const OUT_DIR = process.env.RUNNER_TEMP || process.cwd();
const JSON_PATH = join(OUT_DIR, 'journey-corpus-report.json');
const MD_PATH = join(OUT_DIR, 'journey-corpus-report.md');

// The driver MEASURES and writes JSON; every verdict, annotation and exit code
// is decided out here in plain node. Keeping the judgement outside the --eval
// string is what lets the two sweeps have different consequences without
// duplicating the corpus read.
const driver = `
import { readFileSync, writeFileSync } from 'node:fs';
import { floorCalendarChamber, floorActionChamber, floorPendingChamber, floorSettledChamber } from './lib/journey';
const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
const floorVote = bills.filter((b) => b.status === 'floor_vote');
const row = (b) => ({ slug: \`\${b.bill_type}-\${b.bill_number}-\${b.congress_number}\`, text: b.last_action_text });

/*
 * SWEEP 1 — UNCLASSIFIED: no matcher can even place the sentence in a chamber.
 * Renders nowFloorActivityNeutral (chamber-free) today.
 */
const unclassified = floorVote.filter(
  (b) => floorCalendarChamber(b.last_action_text) === null && floorActionChamber(b.last_action_text) === null
).map(row);

/*
 * SWEEP 2 — UNTENSED: the chamber IS readable, but the sentence says neither
 * "a vote is coming" (floorPendingChamber) nor "the motion failed"
 * (FLOOR_SETTLED). Knowing WHICH chamber a floor sentence belongs to is not
 * knowing what that chamber DID, and conflating the two is what printed "the
 * Senate is deciding whether to bring it to a vote" over 18 motions the Senate
 * had already voted down (#198). Since 2026-08-12 this class renders the
 * chamber-free neutral sentence too — it is a shape nobody has read, no longer
 * a shape wearing a claim.
 */
const untensed = floorVote.filter(
  (b) =>
    floorCalendarChamber(b.last_action_text) === null &&
    floorActionChamber(b.last_action_text) !== null &&
    floorPendingChamber(b.last_action_text) === null &&
    floorSettledChamber(b.last_action_text) === null
).map(row);

writeFileSync(process.env.JOURNEY_CORPUS_JSON, JSON.stringify({ total: floorVote.length, unclassified, untensed }, null, 2));
`;

// Never let a stale report from a previous run be mistaken for this one's.
rmSync(JSON_PATH, { force: true });
rmSync(MD_PATH, { force: true });

const res = spawnSync('npx', ['tsx', '--eval', driver], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: { ...process.env, JOURNEY_CORPUS_JSON: JSON_PATH },
});

const setOutput = (verdict) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${verdict}\n`);
};

if (res.status !== 0) {
  // The sweep itself could not run (tsx missing, lib/journey.ts throwing, a
  // corpus that does not parse). That is not "no novel shapes found" and must
  // never be reported as clean.
  console.error('::error::journey-corpus: the sweep could not run — see the tsx output above');
  setOutput('error');
  process.exit(2);
}

const report = JSON.parse(readFileSync(JSON_PATH, 'utf8'));

// THE NON-VACUITY FLOOR, kept hard on purpose (see the exit codes above).
if (report.total < 50) {
  console.error(
    `::error::journey-corpus: only ${report.total} floor_vote bills — the sweep would prove nothing; check the sync output`
  );
  setOutput('vacuous');
  process.exit(2);
}

const lines = [];
for (const b of report.unclassified) {
  console.error(
    `::error::journey-corpus: unclassified floor text on ${b.slug} — extend floorActionChamber (lib/floor-text.mjs); this bill renders the neutral no-chamber copy meanwhile: ${b.text}`
  );
  lines.push(`- **${b.slug}** — no matcher places this sentence in a chamber (\`floorActionChamber\`):\n  > ${b.text}`);
}
for (const b of report.untensed) {
  console.error(
    `::error::journey-corpus: floor text on ${b.slug} names a chamber but says neither "a vote is coming" nor "the motion failed" — extend floorPendingChamber or FLOOR_SETTLED (lib/floor-text.mjs); this bill renders the neutral no-chamber copy meanwhile: ${b.text}`
  );
  lines.push(
    `- **${b.slug}** — chamber is readable, tense is not (\`floorPendingChamber\` / \`FLOOR_SETTLED\`):\n  > ${b.text}`
  );
}

if (!lines.length) {
  console.log(`journey-corpus clean: ${report.total} floor_vote texts, all classified and all tensed`);
  setOutput('clean');
  process.exit(0);
}

writeFileSync(
  MD_PATH,
  [
    `The nightly sync of ${new Date().toISOString().slice(0, 10)} read ${lines.length} floor sentence(s) that no matcher in \`lib/floor-text.mjs\` understands yet.`,
    '',
    '**Nothing on the site is claiming anything about these bills.** `deriveJourney`\'s residual branch',
    'routes through `floorPendingChamber`, so each of them renders the chamber-free neutral sentence',
    '("it\'s moving on the floor — the official record hasn\'t said yet which chamber acts next") until a',
    'matcher rule lands. That is why this is an issue and not a failed night.',
    '',
    ...lines,
    '',
    `Corpus: ${report.total} \`floor_vote\` records swept.`,
    '',
    'Fix by extending the matcher the line names, in `lib/floor-text.mjs`, with a fixture in',
    '`tests/journey.unit.spec.ts`. Close this issue when the sweep comes back clean.',
  ].join('\n')
);

console.error(`::error::journey-corpus: ${lines.length} unread floor sentence(s) — an issue is being filed; the night's data still commits`);
setOutput('novel');
process.exit(1);

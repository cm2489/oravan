import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/*
 * The claim-truth gate (scripts/check-claim-truth.mjs), in the shape of
 * tests/key-namespaces.spec.ts: the CI gate must (a) pass on the shipped
 * tree and (b) prove it still catches violations, because a gate that can't
 * fail is decoration.
 *
 * Plus a constitution self-consistency check, which is the part that has
 * actually bitten this repo. CLAUDE.md corrected the AI-publish rule on
 * 2026-07-25; README.md kept the retired wording, PRODUCT.md was corrected a
 * week later, DESIGN.md a fortnight after that, and four shipped strings
 * inherited the false claim from whichever document their author happened to
 * read. Four documents describing the same rule is fine. Four documents
 * describing it DIFFERENTLY is how a false claim ships.
 */

const ROOT = process.cwd();
const CONSTITUTION = ['README.md', 'CLAUDE.md', 'PRODUCT.md', 'DESIGN.md'] as const;

function runGate(...args: string[]) {
  return spawnSync('node', ['scripts/check-claim-truth.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

test.describe('the CI gate', () => {
  test('the tree is clean: every enumerated provenance surface says what actually runs', () => {
    const result = runGate();
    expect(result.stderr, 'gate must report no violations').toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('check-claim-truth passed');
    expect(result.stdout).toContain('enumerated provenance surfaces verified');
    // The gate exempts exactly one file from its own scan: itself. R2 bans a
    // CONJUNCTION rather than a proper noun, so unlike check-naming.mjs this
    // file cannot fragment-assemble its way out of matching its own error
    // strings and its own seeded fixtures. One is the whole budget — if this
    // ever reads "2 self-exemptions", something that ships to a reader has
    // been quietly excused.
    expect(result.stdout).toContain('1 self-exemption (this file)');
    expect(result.stdout).not.toMatch(/\d+ self-exemptions/);
  });

  test('the gate still has teeth: every seeded violation fixture is caught, real shipped copy passes', () => {
    const result = runGate('--self-test');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/all \d+ seeded violations caught/);
    // The seeded set must cover all three rule paths plus the two cases a
    // plain phrase-ban cannot reach (a reworded claim with no banned phrase,
    // and a claim straddling a `+` concatenation boundary).
    const caught = Number(result.stdout.match(/all (\d+) seeded violations caught/)![1]);
    expect(caught).toBeGreaterThanOrEqual(9);
  });
});

/*
 * The retired review claim, in every wording this repo has used for it. Kept
 * as a literal here on purpose: this file is excluded from the gate's own
 * scan set (tests/ builds hostile fixtures by design), so it can spell out
 * what the gate may only assemble from fragments.
 */
const RETIRED = /human[\s-]?review|reviewed by (a|the) (human|person)|revisad[oa]s? por (una? )?persona|revisión humana/gi;

/**
 * A retired-claim mention is legitimate in a constitution document only when
 * its surrounding paragraph marks it as an AMENDMENT RECORD (the file
 * quoting what it used to say), a DENIAL ("the decode path is not
 * human-reviewed"), or an EXPLICIT SCOPE — Moments and call scripts, the two
 * places human review genuinely happens.
 */
const AMENDMENT = /amended|previously|corrected|used to|no longer|inherited the false claim|never did/i;
const DENIAL = /\bis not\b|\bnever\b|\bno human step\b|\bwithout\b/i;
const SCOPE = /moment|big question|call script|caller|guion|gran pregunta/i;

test.describe('the four constitution documents agree on what guards a publish', () => {
  test('every human-review mention is an amendment record, a denial, or explicitly scoped', () => {
    let mentions = 0;
    for (const file of CONSTITUTION) {
      const lines = read(file).split('\n');
      lines.forEach((line, i) => {
        if (!new RegExp(RETIRED.source, 'i').test(line)) return;
        mentions++;
        const context = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
        const ok = AMENDMENT.test(context) || DENIAL.test(context) || SCOPE.test(context);
        expect(
          ok,
          `${file}:${i + 1} makes a bare human-review claim. It must read as an amendment record, ` +
            `a denial, or be explicitly scoped to Moments or call scripts:\n  ${line.trim().slice(0, 200)}`
        ).toBe(true);
      });
    }
    // A zero here would mean the amendment records themselves were deleted,
    // which is how the history of a correction gets lost.
    expect(mentions, 'the amendment records must still be in the files').toBeGreaterThan(0);
  });

  test('README, CLAUDE and PRODUCT name the SAME three gates, and never the vocabulary lint', () => {
    for (const file of ['README.md', 'CLAUDE.md', 'PRODUCT.md'] as const) {
      const text = read(file);
      const ruleLines = text.split('\n').filter((l) => /publishes unless the automated gates pass/i.test(l));
      expect(ruleLines, `${file} must state the AI publish rule exactly once`).toHaveLength(1);

      // Only the part BEFORE the first dated amendment is a live claim; the
      // rest is the record of what the file used to say.
      const rule = ruleLines[0];
      const amendedAt = rule.search(/\(?Amended\s+\d{4}-\d{2}-\d{2}/);
      const live = amendedAt === -1 ? rule : rule.slice(0, amendedAt);

      const from = live.search(/gates pass/i);
      const gateList = live.slice(from).split(/(?<=\.)\s/)[0];

      expect(gateList, `${file}: bilingual parity is a gate`).toMatch(/both languages|bilingual parity/i);
      expect(gateList, `${file}: the official record is a gate`).toMatch(/official record attached/i);
      expect(gateList, `${file}: the schema check is a gate`).toMatch(/schema/i);

      // The two things that are NOT gates on the decode path. The vocabulary
      // lint runs on Big Questions only (lib/moments-gate.mjs); it was listed
      // here until 2026-08-06, and it cannot be widened — over the committed
      // corpus it rejects better than a quarter of correct, neutral
      // legislative description, a third of that in one language only.
      expect(gateList, `${file}: the vocabulary lint is not a decode gate`).not.toMatch(/vocabulary/i);
      expect(gateList, `${file}: advocacy is not a decode gate`).not.toMatch(/advocacy/i);
      expect(gateList, `${file}: no human step on the decode path`).not.toMatch(RETIRED);
    }
  });

  test('DESIGN.md scopes its review clause to the call script rather than all AI content', () => {
    const design = read('DESIGN.md');
    const labelLine = design.split('\n').find((l) => /labeled at first contact/i.test(l));
    expect(labelLine, 'DESIGN.md must still state the labeling rule').toBeTruthy();
    expect(labelLine!, 'the review clause names the caller and the script').toMatch(
      /call script is read .*by the caller|caller before it drives a call/i
    );
    expect(labelLine!, 'no blanket human-review claim over all AI content').not.toMatch(RETIRED);
  });
});

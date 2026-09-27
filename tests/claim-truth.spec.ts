import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
 *
 * Constitution v2 (2026-09-27) retired DESIGN.md to docs/history/ (no force,
 * not scanned) and moved its one provenance sentence into README principle
 * 5, so three documents state the rule now. It also moved CLAUDE.md's dated
 * amendment markers into docs/constitution-log.md, so that is where the
 * amendment records must survive (see LOG below).
 */

const ROOT = process.cwd();
const CONSTITUTION = ['README.md', 'CLAUDE.md', 'PRODUCT.md'] as const;
const LOG = 'docs/constitution-log.md';

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
    // The seeded set must cover all five rule paths plus the cases a plain
    // phrase-ban cannot reach: a reworded claim with no banned phrase, a
    // claim straddling a `+` concatenation boundary, and — added 2026-08-09
    // — a NEW human-oversight step bolted onto an otherwise-true automated
    // claim (R1b) and the retired forbidden-vocabulary lint returning as a
    // named decode gate (R4). Four R1b rewrites walked through this gate
    // untouched on 2026-08-09; they are seeded fixtures now.
    const caught = Number(result.stdout.match(/all (\d+) seeded violations caught/)![1]);
    expect(caught).toBeGreaterThanOrEqual(16);
  });
});

/*
 * The retired review claim, in every wording this repo has used for it. Kept
 * as a literal here on purpose: this file is excluded from the gate's own
 * scan set (tests/ builds hostile fixtures by design), so it can spell out
 * what the gate may only assemble from fragments.
 *
 * NOT global. It was declared /gi until 2026-08-06 and then reused in
 * .not.toMatch() inside a three-iteration loop below, where a global
 * regex's lastIndex survives between calls and can silently skip a match —
 * a latent false green in the one file whose entire job is not to be one.
 *
 * The hand-review wordings joined on 2026-09-27, with the gate's RETIRED
 * list: PRODUCT.md said Big Question entries were "hand-reviewed" for two
 * days after the owner made Big Questions fully automatic.
 */
const RETIRED =
  /human[\s-]?review|reviewed by (a|the) (human|person)|revisad[oa]s? por (una? )?persona|revisión humana|hand[\s-]?review|reviewed by hand|revisad[oa]s? a mano/i;

/**
 * A retired-claim mention is legitimate in a constitution document only when
 * ITS OWN SENTENCE marks it as an AMENDMENT RECORD (the file quoting what it
 * used to say), a DENIAL ("the decode path is not human-reviewed"), or an
 * EXPLICIT SCOPE — call scripts, the one place human review genuinely
 * happens.
 *
 * Moments were the second scope until 2026-09-27. Big Question entries were
 * owner-merged then; since the owner's 2026-09-25 ruling they publish on the
 * automated gates with no person in the path, so a review claim scoped to
 * Moments is no longer true, and naming Moments no longer excuses one (the
 * gate dropped the same category from R3 in the same change).
 *
 * "Its own sentence" is the 2026-08-06 correction, and it is the whole test.
 * This used to test a ±2-line window, which meant that in a markdown
 * principles list — where consecutive lines are consecutive principles —
 * any principle could borrow its neighbour's amendment parenthetical. It
 * also meant DENIAL's bare `\bnever\b` matched DESIGN.md's own trailing
 * "never in a footnote" and excused the live claim in front of it. Run
 * against the four pre-fix documents this test reported ZERO violations:
 * it would not have caught a single claim it was written for. PRE_FIX below
 * is that proof, kept as a fixture so it cannot quietly stop being one.
 */
const AMENDMENT = /amended|corrected|reworded|retired|previously|inherited the false claim|no longer|never did|\bused to\b|\bit (said|claimed|read)\b/i;
const DENIAL = /\b(is|are|was|were|has|have|had)\s+not\b|\bnever\s+(been\s+)?(human|review|claim|did|does|do)/i;
const SCOPE = /call script|\bcaller\b|guion/i;

/*
 * The claim unit: reassemble wrapped lines into a paragraph, then take the
 * one sentence the mention sits in. Markdown block starts (list items,
 * numbered items, headings) end a paragraph — that boundary is what stops
 * principle 4 speaking for principle 5. Mirrors paragraphsOf/splitSentences
 * in scripts/check-claim-truth.mjs; duplicated rather than imported for the
 * same reason RETIRED is duplicated — this file is outside the gate's scan
 * set and states its expectations in the open, and importing the gate would
 * execute its tree scan on import.
 */
const MD_BLOCK_START = /^\s{0,3}([-*+]\s|\d+[.)]\s|#{1,6}\s|>|\|)/;

/** Every sentence of a markdown document, with the line its paragraph starts on. */
function sentencesOf(text: string): { line: number; sentence: string }[] {
  const lines = text.split('\n');
  const out: { line: number; sentence: string }[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    let end = i;
    while (end + 1 < lines.length && lines[end + 1].trim() && !MD_BLOCK_START.test(lines[end + 1])) end++;
    const paragraph = lines
      .slice(i, end + 1)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      out.push({ line: i + 1, sentence: sentence.trim() });
    }
    i = end + 1;
  }
  return out;
}

const claimSentences = (text: string) => sentencesOf(text).filter(({ sentence }) => RETIRED.test(sentence));

const legitimate = (sentence: string) =>
  AMENDMENT.test(sentence) || DENIAL.test(sentence) || SCOPE.test(sentence);

test.describe('the constitution documents agree on what guards a publish', () => {
  test('every human-review mention is an amendment record, a denial, or scoped to the call script', () => {
    for (const file of [...CONSTITUTION, LOG]) {
      for (const { line, sentence } of claimSentences(read(file))) {
        expect(
          legitimate(sentence),
          `${file}:${line} makes a bare human-review claim. It must read as an amendment record, ` +
            `a denial, or be explicitly scoped to call scripts:\n  ${sentence.slice(0, 200)}`
        ).toBe(true);
      }
    }
  });

  test('the amendment records are still in the constitution log', () => {
    // Since 2026-09-27 the dated amendment markers, and the retired wordings
    // they quote, live in the log rather than inline in CLAUDE.md. A zero
    // here would mean they were deleted, which is how the history of a
    // correction gets lost. Each must also be marked as a record in its own
    // sentence — a Moments scope no longer excuses one (see SCOPE).
    const records = claimSentences(read(LOG));
    expect(records.length, 'the amendment records must still be in docs/constitution-log.md').toBeGreaterThan(0);
    for (const { line, sentence } of records) {
      expect(AMENDMENT.test(sentence), `${LOG}:${line} quotes a retired wording without marking it:\n  ${sentence}`).toBe(
        true
      );
    }
  });

  /*
   * The pre-fix documents, verbatim, as a standing proof that the test above
   * has teeth. Held as literals rather than read from `git show origin/main:`
   * on purpose: origin/main will one day carry the CORRECTED text, and a
   * regression fixture that quietly turns into a copy of the fix proves
   * nothing. Each entry is exactly what shipped before 2026-08-06.
   */
  const PRE_FIX = [
    {
      what: 'README.md principle 5, under principle 4 and its amendment parenthetical',
      text: [
        '4. **Truth first; the call is the natural next step.** Oravan leads as an unbiased, plain-words account of what Congress is actually doing. *(Amended 2026-07-26; previously "The call moment is the product.")*',
        '5. **Honest about AI.** Every generated summary and script is labeled, editable, and reviewed by the human before any call.',
      ].join('\n'),
    },
    {
      what: 'DESIGN.md\'s labeling rule, whose own trailing "never in a footnote" excused it',
      text: 'AI content is **labeled at first contact** and human-reviewed before it drives a call. The label sits with the content, above the fold — never in a footnote.',
    },
  ];

  for (const { what, text } of PRE_FIX) {
    test(`the check is RED against the pre-fix wording: ${what}`, () => {
      const found = claimSentences(text);
      expect(found, 'the pre-fix claim must still be found at all').toHaveLength(1);
      expect(
        legitimate(found[0].sentence),
        `this shipped as a live false claim and must be rejected, not excused:\n  ${found[0].sentence}`
      ).toBe(false);
    });
  }

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

  /*
   * Retargeted 2026-09-27. This clause lived in DESIGN.md until that file was
   * retired to docs/history/ (no force, not scanned); its sentence moved to
   * README principle 5 in the same change. Read by SENTENCE rather than by
   * line: principle 5's first line is one long list item that also carries
   * the 2026-08-06 amendment record, and that record quotes the retired
   * wording on purpose.
   */
  test('README principle 5 scopes its review clause to the call script rather than all AI content', () => {
    const labelSentences = sentencesOf(read('README.md'))
      .map(({ sentence }) => sentence)
      .filter((s) => /labeled at first contact/i.test(s));
    expect(labelSentences.length, 'README must still state the labeling rule').toBeGreaterThan(0);
    expect(
      labelSentences.some((s) => /call script is read .*by the caller|caller before it drives a call/i.test(s)),
      'the review clause names the caller and the script'
    ).toBe(true);
    for (const s of labelSentences) {
      expect(s, 'no blanket human-review claim over all AI content').not.toMatch(RETIRED);
    }
    // The sentence that scopes the clause — decodes and Moment summaries
    // publish with no human step, so the label is the whole disclosure there.
    expect(read('README.md')).toMatch(/scoped to call scripts on purpose/);
  });
});

/*
 * PAGE 1 NAMES ONLY GATES THAT EXIST (added 2026-09-27, Constitution v2).
 * Each hard rule in CLAUDE.md names the gate that enforces it, and a rule
 * whose gate does not exist is decoration — the draft v2 was adopted from
 * named one script that checks something else, and put a gate on the wrong
 * rule. So every repo path CLAUDE.md names in backticks must exist, every
 * constitution-log anchor the constitution documents link must resolve, and
 * the one gate named by a non-path (the 320px Playwright project) must be
 * configured. Globs (`scripts/*.mjs`) are scope descriptions, not paths, and
 * are skipped. Runs on the docs-only fast path with the rest of this file,
 * which is where a CLAUDE.md-only edit lands.
 */
test.describe('page 1 names only gates that exist', () => {
  const PATH_PREFIX = /^(tests|scripts|lib|components|app|docs|data|messages|\.github)\//;

  test('every repo path CLAUDE.md names in backticks exists', () => {
    const claude = read('CLAUDE.md');
    const named = [...claude.matchAll(/`([^`\s]+)`/g)]
      .map((m) => m[1].split('#')[0])
      .filter((p) => PATH_PREFIX.test(p) && !p.includes('*'));
    expect(named.length, 'CLAUDE.md should name its gates by path').toBeGreaterThan(20);
    const missing = named.filter((p) => !existsSync(join(ROOT, p)));
    expect(missing, 'CLAUDE.md names a path that does not exist').toEqual([]);
  });

  test('every constitution-log anchor linked from the constitution documents resolves', () => {
    const anchors = new Set([...read(LOG).matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]));
    const linked = ['CLAUDE.md', 'README.md', 'PRODUCT.md'].flatMap((f) =>
      [...read(f).matchAll(/docs\/constitution-log\.md#([\w-]+)/g)].map((m) => ({ f, id: m[1] }))
    );
    expect(linked.length).toBeGreaterThan(0);
    for (const { f, id } of linked) {
      expect(anchors.has(id), `${f} links docs/constitution-log.md#${id}, which has no anchor`).toBe(true);
    }
  });

  test('the reflow gate rule 7 names is a configured Playwright project', () => {
    expect(read('CLAUDE.md')).toMatch(/`webkit-320` Playwright project/);
    expect(read('playwright.config.ts')).toMatch(/name:\s*'webkit-320'[\s\S]{0,200}grep:\s*\/@reflow\//);
  });
});

/*
 * GATE-COVERAGE: everything above polices markdown-only edits to the
 * constitution documents — and it lived in the Playwright job, which ci.yml's
 * docs-only fast path skips precisely because a PR touched nothing but
 * markdown. The exact change class these tests exist for was the one class
 * that never gated: re-adding "human-reviewed" to README principle 5 in a
 * docs-only PR would have shipped green, which is the original 2026-07-25
 * failure with the correction now written down as well.
 *
 * ci.yml runs this file on that path now. This test is what keeps it there —
 * same wiring-by-source-read posture as tests/rollover-tripwire.unit.spec.ts,
 * for the same reason: workflow YAML is not executable from here, and a
 * deleted step is indistinguishable from a step that has not fired yet.
 */
test.describe('the docs-only fast path still runs this file', () => {
  const CI = join(ROOT, '.github/workflows/ci.yml');

  test('ci.yml runs tests/claim-truth.spec.ts on the docs-only path', () => {
    const yml = readFileSync(CI, 'utf8');
    const at = yml.indexOf('npx playwright test tests/claim-truth.spec.ts');
    expect(at, 'the docs-only constitution step must exist').toBeGreaterThan(-1);

    // And it must be gated ON docs_only rather than off it — an `!=` here
    // would restore the gap while looking like the fix.
    const step = yml.slice(0, at);
    const conditionAt = step.lastIndexOf('steps.paths.outputs.docs_only');
    expect(conditionAt).toBeGreaterThan(-1);
    expect(step.slice(conditionAt), 'the step runs WHEN the diff is docs-only').toMatch(
      /steps\.paths\.outputs\.docs_only == 'true'/
    );
  });

  test('the cheap invocation is the one that was measured: no webServer, one project', () => {
    // This spec takes no `page` fixture, so it launches no browser and needs
    // no build. If a future edit adds a page-driven test here it will fail on
    // connection-refused rather than silently pass — but the honest fix then
    // is to move that test, not to drag a `next build` onto the fast path.
    const yml = readFileSync(CI, 'utf8');
    const at = yml.indexOf('npx playwright test tests/claim-truth.spec.ts');
    const window = yml.slice(Math.max(0, at - 400), at + 200);
    expect(window).toMatch(/PW_NO_WEBSERVER: '1'/);
    expect(yml.slice(at, at + 200)).toMatch(/--project=webkit-desktop/);
  });

  test('no test in this file takes a browser fixture, which is what makes that invocation honest', () => {
    const self = readFileSync(join(ROOT, 'tests/claim-truth.spec.ts'), 'utf8');
    const fixtured = [...self.matchAll(/\(\s*\{\s*(page|browser|context|request|browserName)\b/g)];
    expect(
      fixtured.map((m) => m[1]),
      'a destructured Playwright fixture here means the docs-only run needs a built server after ' +
        'all, and the fast path would be running a test that cannot pass. Move that test instead.'
    ).toEqual([]);
  });
});

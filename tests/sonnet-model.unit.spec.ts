import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DECODE_MODEL } from '../scripts/bill-decode.mjs';
import { DRAFT_MODEL } from '../scripts/moment-draft.mjs';
import { CANDIDATE_MODEL, INCUMBENT_MODEL, thinkingOffFor } from '../scripts/eval-translation.mjs';
import { SCRIPT_MODEL } from '../lib/scriptprompt';
import { BRAND_MODEL } from '../lib/brandprompt';

/*
 * THE SONNET 5.5 SWITCH (owner, 2026-09-28: "Sonnet 5.5 came out today so
 * switch anything running Sonnet 5 to Sonnet 5.5").
 *
 * The model id is the small half of it. The half that breaks things is the
 * thinking setting: every Sonnet call here turned up-front thinking off with
 * `thinking: { type: 'disabled' }`, and Sonnet 5.5 answers that with a 400 —
 * "thinking.type.disabled is not supported for this model. Use
 * thinking.type.between_tools …" (Anthropic's Sonnet 5.5 migration guide,
 * read 2026-09-28). A call site that kept the old spelling would pass the
 * build and every other test and then fail its first paid request, at night,
 * in production. These tests are what catch it here instead.
 */

const SONNET = 'claude-sonnet-5-5';

/** Every file that sends a request to the Sonnet model. */
const SONNET_CALLERS = [
  'scripts/bill-decode.mjs', // nightly fallback + newsdesk decodes
  'lib/decode-batch.mjs', // nightly batched decodes
  'scripts/moment-updates.mjs', // Big Questions "Where it stands"
  'scripts/moment-draft.mjs', // moment-watch drafts
  'lib/pregen.ts', // nightly call-script pregeneration
  'app/api/script/route.ts', // live call scripts
  'app/api/brand/route.ts', // partner brand preview
  'scripts/generate-cost-chips.mjs', // one-off, run by hand
  'scripts/translate-summaries.mjs', // one-off, run by hand
  'scripts/regenerate-headlines.mjs', // one-off, run by hand
  'scripts/restructure-decoded.mjs', // one-off, run by hand
];

test('every Sonnet model constant names Sonnet 5.5', () => {
  expect(DECODE_MODEL).toBe(SONNET);
  expect(DRAFT_MODEL).toBe(SONNET);
  expect(SCRIPT_MODEL).toBe(SONNET);
  expect(BRAND_MODEL).toBe(SONNET);
  expect(INCUMBENT_MODEL).toBe(SONNET);
});

test('no Sonnet caller sends the thinking setting Sonnet 5.5 rejects', () => {
  for (const file of SONNET_CALLERS) {
    const src = readFileSync(file, 'utf8');
    expect(src, `${file} turns up-front thinking off with between_tools`).toContain("type: 'between_tools'");
    expect(src, `${file} still sends thinking disabled, a 400 on Sonnet 5.5`).not.toContain("type: 'disabled'");
  }
});

test('the translation eval spells "no thinking" the way each of its two models accepts it', () => {
  // Haiku 4.5 takes `disabled` and knows nothing of `between_tools`;
  // Sonnet 5.5 is the other way round.
  expect(thinkingOffFor(INCUMBENT_MODEL)).toEqual({ type: 'between_tools' });
  expect(thinkingOffFor(CANDIDATE_MODEL)).toEqual({ type: 'disabled' });
});

function codeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...codeFiles(path));
    else if (/\.(mjs|js|ts|tsx|ya?ml)$/.test(name)) out.push(path);
  }
  return out;
}

test('no runnable code still names claude-sonnet-5 as a model to call', () => {
  // Quoted ids only: stored history (data/moment-updates.json, test
  // fixtures) keeps the id that really wrote it, and comments may name it.
  const offenders = ['scripts', 'lib', 'app', '.github/workflows']
    .flatMap(codeFiles)
    .filter((file) => /['"]claude-sonnet-5['"]/.test(readFileSync(file, 'utf8')));
  expect(offenders).toEqual([]);
});

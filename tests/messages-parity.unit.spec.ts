import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
// The tokenizer itself, imported the same way tests/rollover-tripwire.unit.spec.ts
// imports lib/rollover-tripwire.mjs: the function tested here is exactly the
// one the CI gate runs.
import { checkParity, icuArguments } from '../lib/messages-parity.mjs';

/*
 * GATE-COVERAGE: the bilingual hard rule ("every user-facing string goes
 * through messages/en.json + messages/es.json — both, in the same change")
 * was enforced by a gate that compared flattened key SETS and nothing else.
 * Nothing looked inside a value. So a Spanish translation that dropped
 * `{count}` was full parity by the gate and a silently degraded string in
 * production — the number simply stops being said, in the language with no
 * second reviewer. The reverse is louder and worse: an argument only ES names
 * has no caller passing it, and next-intl throws on the ES render.
 *
 * Same shape as tests/key-namespaces.spec.ts: the gate must (a) pass on the
 * shipped tree and (b) prove it still catches violations, because a gate that
 * can't fail is decoration. The unit tests below exist on top of that because
 * the ICU half is a hand-written tokenizer, and a tokenizer that has quietly
 * stopped parsing finds nothing and reports parity.
 */

function runGate(...args: string[]) {
  return spawnSync('node', ['scripts/check-messages-parity.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

test.describe('the CI gate', () => {
  test('the tree is clean: EN and ES take the same ICU arguments in every shared message', () => {
    const result = runGate();
    expect(result.stderr, 'gate must report no violations').toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('EN/ES message parity holds');
    // A zero here would mean the tokenizer stopped finding arguments at all,
    // which is precisely the failure that reports parity while checking
    // nothing. The real corpus carried 72 such messages when this was written.
    const withArgs = Number(result.stdout.match(/the (\d+) message\(s\) carrying ICU arguments/)![1]);
    expect(withArgs, 'the tokenizer must still be finding ICU arguments in the real corpus').toBeGreaterThan(20);
  });

  test('the gate still has teeth: every seeded divergence is caught, correct copy passes', () => {
    const result = runGate('--self-test');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/all \d+ seeded violations caught/);
    const caught = Number(result.stdout.match(/all (\d+) seeded violations caught/)![1]);
    expect(caught, 'the seeded set must still cover every divergence shape').toBeGreaterThanOrEqual(8);
    // The clean half matters just as much: a gate that reds on correct
    // Spanish gets weakened by whoever hits it next.
    expect(result.stdout).toMatch(/\d+ clean pairs pass/);
  });
});

test.describe('the tokenizer', () => {
  const args = (m: string) => [...icuArguments(m)].sort();

  test('finds plain placeholders, including several in one message', () => {
    expect(args('Step {n} of {total}: {title}')).toEqual(['n', 'title', 'total']);
  });

  test('finds arguments a /\\{(\\w+)\\}/ scan cannot see: inside plural and select submessages', () => {
    expect(args('{count, plural, one {# bill from {state}} other {# bills from {state}}}')).toEqual([
      'count',
      'state',
    ]);
    expect(args('{chamber, select, house {House} senate {Senate} other {Congress}} — {bill}')).toEqual([
      'bill',
      'chamber',
    ]);
  });

  test('does NOT invent arguments out of ICU syntax: option keywords, `#`, or a typed style', () => {
    // `one`/`other`/`=2` are selectors, `#` is the enclosing argument, and
    // `::percent` is a skeleton — none of them is a value a caller passes.
    expect(args('{count, plural, =2 {two} other {#}} districts')).toEqual(['count']);
    expect(args('{share, number, ::percent} of {total}')).toEqual(['share', 'total']);
  });

  test('honors ICU quoting: an escaped brace is a literal, a lone apostrophe is a character', () => {
    expect(args("Use '{'name'}' in the template, {who}")).toEqual(['who']);
    // The strict-direction failure mode: mishandling this apostrophe swallows
    // the rest of the message and {bill} silently stops being an argument.
    expect(args("Congress isn't done with {bill}")).toEqual(['bill']);
  });

  test('recurses into nested plurals and selectordinals', () => {
    expect(args('{congress, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} Congress')).toEqual([
      'congress',
    ]);
    expect(args('{a, plural, other {{b, select, x {{c}} other {}}}}')).toEqual(['a', 'b', 'c']);
  });
});

test.describe('the rule', () => {
  test('a dropped argument is a violation, and the message names the key', () => {
    const v = checkParity({ home: { seeAll: 'Browse all {count} active bills' } }, { home: { seeAll: 'Explorar proyectos activos' } });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('home.seeAll');
    expect(v[0]).toContain('{count}');
  });

  test('an argument only ES names is a violation too — that one throws at render', () => {
    const v = checkParity({ a: 'Last action' }, { a: 'Última acción: {date}' });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/next-intl throws/);
  });

  test('a reordered argument list is NOT a violation — Spanish syntax reorders freely', () => {
    expect(checkParity({ a: '{state} district {district}' }, { a: 'Distrito {district} de {state}' })).toEqual([]);
  });

  test('English ordinal vs Spanish cardinal is NOT a violation: same argument, different grammar', () => {
    // bill.congressLabel ships exactly this pair. "119th Congress" needs a
    // selectordinal; "Congreso 119" does not, and forcing one would be wrong
    // Spanish. The gate compares the argument NAMES a caller must pass, which
    // is the thing that has to match, and stays out of the grammar.
    expect(
      checkParity(
        { a: '{congress, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} Congress' },
        { a: 'Congreso {congress}' }
      )
    ).toEqual([]);
  });

  test('the key half of the gate still runs', () => {
    // Guards against the ICU work having quietly replaced the original rule
    // rather than extended it.
    expect(checkParity({ a: 'x', b: 'y' }, { a: 'x' })).toEqual([
      'messages key "b" exists in en.json but not es.json',
    ]);
  });
});

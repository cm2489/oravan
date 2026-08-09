import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/*
 * GATE-COVERAGE: "A street address must never land in any log - ours or a
 * host's" (app/api/district/route.ts's header, CLAUDE.md's no-server-side-
 * user-data rule) was enforced by that source comment and nothing else. The
 * realistic regression is one line long and looks helpful: somebody debugging
 * a flaky Census call adds `console.error('census failed', address, err)` to
 * the catch. It ships green, and every visitor who refines a split ZIP has
 * their street address written to the platform's log retention.
 *
 * Source-scan, in the wiring-by-source-read style of
 * tests/rollover-tripwire.unit.spec.ts and tests/pregen-route-posture.unit.spec.ts:
 * the strongest honest form of a "this code never does X" guarantee is
 * asserted against the source text.
 *
 * Two rules, because they fail differently:
 *
 *   A. NO LOG ANYWHERE IN THE SCAN SET MAY REFERENCE THE ADDRESS. This is the
 *      durable rule. It survives someone legitimately adding logging, and it
 *      names the identifiers rather than banning the word `console`.
 *
 *   B. THE CENSUS CALL'S CATCH LOGS NOTHING AT ALL — not even the error
 *      object. This is narrower and is the route's own documented reasoning:
 *      an upstream fetch error can embed the request URL, and the request URL
 *      is where `address, zip` is. `console.error('census failed', err)` looks
 *      like textbook error-only logging and leaks the address anyway, so rule
 *      A alone would wave it through.
 *
 * lib/district.ts is in the scan set too: the Census response body echoes the
 * submitted address back under `result.input`, so a `console.log(payload)`
 * added to the parser is the same leak one file over.
 */

const SCAN_SET = ['app/api/district/route.ts', 'lib/district.ts'] as const;
const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

/**
 * Identifiers that are, or can carry, the visitor's address. `payload`/`data`
 * are here because the Census response echoes the input address; `params`,
 * `url` and `req` because the address travels inside them.
 */
const SENSITIVE = /\b(address|zip|body|params|payload|req|request|url|input)\b/i;

/** `console.x(...)`, `logger.x(...)`, `log(...)`, `process.stdout.write(...)`. */
// The bare-`log(` alternative uses a lookbehind rather than \b so that a
// member call like `Math.log(x)` is not read as logging.
const LOG_CALL = /\b(?:console|logger|log)\s*\.\s*\w+\s*\(|(?<![.\w])log\s*\(|\bprocess\s*\.\s*std(?:out|err)\s*\.\s*write\s*\(/g;

/**
 * Source with comments stripped, so prose about logging isn't mistaken for
 * logging. Block comments are replaced by their own newlines rather than
 * deleted: this file reports the LINE a violation is on, and collapsing the
 * route's long header comment would make every reported line number wrong.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Every log call site in `source`, as `{ index, text }` where text is the full call. */
function logCallSites(source: string): { index: number; text: string }[] {
  const sites: { index: number; text: string }[] = [];
  LOG_CALL.lastIndex = 0;
  for (const m of source.matchAll(LOG_CALL)) {
    const open = source.indexOf('(', m.index!);
    let level = 0;
    let i = open;
    for (; i < source.length; i++) {
      if (source[i] === '(') level++;
      else if (source[i] === ')' && --level === 0) break;
    }
    sites.push({ index: m.index!, text: source.slice(m.index!, i + 1) });
  }
  return sites;
}

test.describe('rule A: no log in the district path can reference the address', () => {
  for (const file of SCAN_SET) {
    test(`${file}: every log call site is address-free`, () => {
      const source = stripComments(read(file));
      for (const site of logCallSites(source)) {
        const line = source.slice(0, site.index).split('\n').length;
        expect(
          SENSITIVE.test(site.text),
          `${file}:${line} logs something that can carry the visitor's street address. ` +
            `A street address must never land in any log — ours or a host's. Log a constant, not the input:\n  ${site.text.slice(0, 200)}`
        ).toBe(false);
        // A template literal or a `+` concatenation can interpolate anything,
        // including a variable this test has no name for.
        expect(
          /`|\+/.test(site.text),
          `${file}:${line} builds its log message by interpolation, which this scan cannot follow. ` +
            `Log a plain string literal:\n  ${site.text.slice(0, 200)}`
        ).toBe(false);
      }
    });
  }

  test('the scan itself has teeth: the regression line is caught, an address-free log is not', () => {
    // Guards against the tests above passing because logCallSites() silently
    // stopped finding call sites — the failure mode where a scan reports
    // clean by scanning nothing.
    const regression = stripComments(`
      } catch {
        console.error('census failed', address, err);
        return NextResponse.json({ error: 'unavailable' }, { status: 502 });
      }
    `);
    const sites = logCallSites(regression);
    expect(sites, 'the scanner must find the call at all').toHaveLength(1);
    expect(SENSITIVE.test(sites[0].text)).toBe(true);

    const interpolated = logCallSites(`console.warn(\`district lookup for \${zip} failed\`);`);
    expect(interpolated).toHaveLength(1);
    expect(/`|\+/.test(interpolated[0].text)).toBe(true);

    const benign = logCallSites(`console.warn('district rate limiter is degraded');`);
    expect(benign).toHaveLength(1);
    expect(SENSITIVE.test(benign[0].text), 'a constant-only log must NOT trip rule A').toBe(false);
    expect(/`|\+/.test(benign[0].text)).toBe(false);
  });
});

test.describe('rule B: the Census call logs nothing, not even the error', () => {
  test('the route still makes the call this rule is about', () => {
    // Guards against rule B passing because the fetch was deleted or moved
    // rather than because its catch is clean.
    const source = read('app/api/district/route.ts');
    expect(source).toMatch(/await fetch\(`\$\{CENSUS_URL\}\?\$\{params\}`/);
    expect(source, 'the address must still travel in the POST body, never a GET query string').toMatch(
      /export async function POST\(/
    );
    expect(source).not.toMatch(/export async function GET\(/);
  });

  test('nothing between the Census fetch and its catch writes to a log', () => {
    const source = stripComments(read('app/api/district/route.ts'));
    const start = source.indexOf('let payload');
    expect(start, 'the Census call block must still be findable').toBeGreaterThan(-1);
    const end = source.indexOf('const parsed', start);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    const sites = logCallSites(block);
    expect(
      sites.map((s) => s.text),
      'the catch around the Census call must log NOTHING — an upstream fetch error can embed the ' +
        'request URL, and the request URL carries `${address}, ${zip}`. Even `console.error(err)` ' +
        'leaks the address here, which is why this block is held to a stricter rule than the file.'
    ).toEqual([]);
  });

  test('the reasoning stays written down next to the code', () => {
    // The comment is not the enforcement any more — these tests are. But the
    // next person to add logging reads the comment, not the spec, so losing
    // it loses the "why" behind a rule that otherwise looks over-strict.
    const source = read('app/api/district/route.ts');
    expect(source).toMatch(/must never land in any log/i);
    expect(source).toMatch(/log NOTHING, not\s+\* even the error object|log NOTHING/i);
  });
});

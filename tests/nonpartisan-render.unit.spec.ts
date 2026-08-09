import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/*
 * GATE-COVERAGE: "Nonpartisan by construction. No party-coded colors" is a
 * CLAUDE.md hard rule, and until this file it had zero automated enforcement.
 * The two surfaces that render political affiliation defended it with prose:
 *
 *   components/RepCard.tsx        "PARTY IS PLAIN INK TEXT and always will be
 *                                  [...] there is no branch in this file that
 *                                  can reach a party-keyed color."
 *   components/CoverageSection.tsx "NONPARTISAN BY CONSTRUCTION: lean is
 *                                  conveyed by a text label plus a neutral
 *                                  3-segment position glyph [...] Never
 *                                  red/blue, never `go`."
 *
 * Both sentences are true today and neither is a gate. The realistic
 * regression is somebody making the lean glyph "easier to read at a glance"
 * with `i === position ? 'bg-blue-600' : 'bg-line'`, or tinting the party
 * label — a one-line diff that reads as a UX improvement in review and turns
 * a nonpartisan surface into a scoreboard.
 *
 * Source-scan, same posture as tests/pregen-route-posture.unit.spec.ts: the
 * strongest honest form of "this component cannot reach a party-keyed color"
 * is asserted against the source text. Calibrated against the current clean
 * sources — every rule below passes on them today.
 */

const SURFACES = ['components/CoverageSection.tsx', 'components/RepCard.tsx'] as const;
const GLOBALS = 'app/globals.css';
const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

/*
 * Tailwind's default palette families that read as political affiliation.
 * This project ships NO default-palette color at all (its palette is
 * ink/paper/wash/line/go, defined in app/globals.css), so any of these in
 * these two files is off-system as well as party-coded. Greens are absent
 * from the list on purpose: `go` is green, and green is the action color
 * here, not a party.
 */
const PARTISAN_FAMILIES =
  /(?:^|[\s:"'`{])(?:hover:|focus:|active:|group-hover:|dark:|md:|sm:|lg:)*(?:bg|text|border|decoration|ring|fill|stroke|from|via|to|outline|shadow|accent|caret|divide|placeholder)-(red|rose|pink|orange|blue|sky|indigo|cyan|violet|purple|fuchsia)(?:-\d{2,3})?\b/;

/** An arbitrary color value smuggled past the palette: bg-[#1d4ed8], text-[rgb(...)]. */
const ARBITRARY_COLOR = /-\[\s*(?:#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\()/i;

/**
 * #rgb / #rrggbb anywhere in a file. Only ever run over comment-stripped
 * source: "#158" in a prose reference to a PR number is three valid hex
 * digits, and reading it as a color made this scan red on a clean file the
 * first time it ran.
 */
const HEX_LITERAL = /#([0-9a-f]{3}|[0-9a-f]{6})\b/gi;

/**
 * Source with comments removed, so prose is never scanned as code. Block
 * comments are replaced by their own newlines rather than deleted, so the
 * line numbers these tests report stay the line numbers in the file.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Hue in degrees + saturation 0..1 for a hex color. */
function hsl(hex: string): { hue: number; sat: number } {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d !== 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return { hue, sat };
}

/**
 * A color reads as party-coded when it is saturated enough to be seen as a
 * hue at all AND that hue is red or blue. The 0.2 floor is what keeps the
 * project's own near-neutrals (#16191b ink, #4a544e ink-2, #d7ded9 line) out
 * of it — they are grays that happen to lean a few degrees.
 */
function isPartisanHue(hex: string): boolean {
  const { hue, sat } = hsl(hex);
  if (sat < 0.2) return false;
  return hue >= 330 || hue <= 25 || (hue >= 195 && hue <= 275);
}

/** Every `className=` / `style=` expression in a TSX source, brace-balanced. */
function styleExpressions(source: string): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = [];
  for (const m of source.matchAll(/\b(className|style)\s*=\s*/g)) {
    let i = m.index! + m[0].length;
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      const end = source.indexOf(quote, i + 1);
      out.push({ index: m.index!, text: source.slice(i, end + 1) });
    } else if (source[i] === '{') {
      let level = 0;
      const start = i;
      for (; i < source.length; i++) {
        if (source[i] === '{') level++;
        else if (source[i] === '}' && --level === 0) break;
      }
      out.push({ index: m.index!, text: source.slice(start, i + 1) });
    }
  }
  return out;
}

test.describe('no party-coded color can be reached from either affiliation surface', () => {
  for (const file of SURFACES) {
    test(`${file}: no partisan Tailwind family, no arbitrary color value`, () => {
      // Comment-stripped: both files explain in prose what they must never
      // do, and a comment naming `bg-red-600` as the counter-example is
      // documentation, not a violation.
      const source = stripComments(read(file));
      const offenders = source
        .split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => PARTISAN_FAMILIES.test(line) || ARBITRARY_COLOR.test(line));
      expect(
        offenders.map((o) => `${file}:${o.n}: ${o.line.trim()}`),
        'CLAUDE.md hard rule: no party-coded colors. This file renders political affiliation, ' +
          'so a red or blue on it is a party color no matter what it is nominally for.'
      ).toEqual([]);
    });

    test(`${file}: no red or blue color literal`, () => {
      const source = stripComments(read(file));
      const partisan = [...source.matchAll(HEX_LITERAL)].map((m) => m[0]).filter(isPartisanHue);
      expect(partisan, 'a saturated red or blue on an affiliation surface is a party color').toEqual([]);
    });

    test(`${file}: nothing styles anything on party`, () => {
      // The realistic regression is conditional, not literal: a ternary keyed
      // on the member's party that picks a class. Party may be READ (RepCard
      // prints it as text) — it may never reach a className or a style.
      const source = read(file);
      for (const expr of styleExpressions(source)) {
        const line = source.slice(0, expr.index).split('\n').length;
        expect(
          /\bparty\b/i.test(expr.text),
          `${file}:${line} lets the member's party decide how something is drawn. Party is plain ` +
            `ink text and always will be — no fill, no edge, no glyph:\n  ${expr.text.slice(0, 200)}`
        ).toBe(false);
      }
    });
  }
});

test.describe('the lean glyph stays neutral', () => {
  /**
   * The body of a named function declaration, brace-balanced.
   *
   * The parameter list has to be stepped over first: LeanChip destructures
   * (`function LeanChip({ lean }: { lean: Lean | null })`), so "the first `{`
   * after the name" is the destructuring pattern, not the body — which is
   * how the first version of this test scanned a two-word string, found no
   * ternary, and reported the glyph missing rather than clean.
   */
  function functionBody(source: string, name: string): string {
    const at = source.indexOf(`function ${name}(`);
    expect(at, `${name} must still exist in the source`).toBeGreaterThan(-1);
    let i = source.indexOf('(', at);
    let level = 0;
    for (; i < source.length; i++) {
      if (source[i] === '(') level++;
      else if (source[i] === ')' && --level === 0) break;
    }
    const start = source.indexOf('{', i);
    level = 0;
    for (i = start; i < source.length; i++) {
      if (source[i] === '{') level++;
      else if (source[i] === '}' && --level === 0) break;
    }
    const body = source.slice(start, i + 1);
    expect(body, `${name}'s body must be what was extracted, not its parameter list`).toContain('return');
    return body;
  }

  test('LeanChip picks its active segment from neutral tokens only — never `go`, never a hue', () => {
    const body = functionBody(read('components/CoverageSection.tsx'), 'LeanChip');

    // Every ternary in the glyph whose branches are class strings. Today
    // there is exactly one: `i === position ? 'bg-ink' : 'bg-line'`.
    const ternaries = [...body.matchAll(/\?\s*'([^']*)'\s*:\s*'([^']*)'/g)];
    expect(ternaries.length, 'the position ternary must still be findable').toBeGreaterThan(0);

    // `go` is the action green — the one saturated color in this system. The
    // component's own header says the glyph must never reach it, because a
    // filled green segment would read as Oravan endorsing a lean rather than
    // reporting a third-party rating.
    const NEUTRAL_FILL = /^bg-(ink|ink-2|line|line-strong|wash)$/;
    for (const [, consequent, alternate] of ternaries) {
      for (const branch of [consequent, alternate]) {
        for (const token of branch.split(/\s+/).filter(Boolean)) {
          expect(
            NEUTRAL_FILL.test(token),
            `the lean glyph's conditional fill resolved to "${token}". It may only choose between ` +
              `neutral ink/line tokens: never red/blue, never \`go\`, never a party-coded hue.`
          ).toBe(true);
        }
      }
    }

    expect(body, 'no `go` token anywhere in the glyph').not.toMatch(/\b(?:bg|text|border|fill|stroke|ring)-go\b/);
  });

  test('lean is still carried by a text label, not by color alone (WCAG 1.4.1 as well as the hard rule)', () => {
    const source = read('components/CoverageSection.tsx');
    // Guards against the glyph test passing because the glyph — or the label
    // that makes it non-color-dependent — was deleted.
    expect(source).toMatch(/t\(`lean\.\$\{lean\}`\)/);
    expect(source).toMatch(/t\('lean\.unrated'\)/);
    expect(source, 'the segments are decorative; the label is the information').toMatch(/aria-hidden/);
  });
});

test.describe('the shared palette these surfaces draw from', () => {
  /** Every `--color-<name>: <hex>` in globals.css. */
  function paletteHexes(): [string, string][] {
    const css = read(GLOBALS);
    return [...css.matchAll(/--color-([a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8})/gi)].map(
      (m) => [m[1], m[2]] as [string, string]
    );
  }

  const COLOR_UTILITY = '(?:bg|text|border|decoration|fill|stroke|ring|outline|from|via|to)';

  /** The palette tokens the two affiliation surfaces actually reference. */
  function tokensUsedBySurfaces(): string[] {
    const sources = SURFACES.map((f) => stripComments(read(f)));
    // Exact suffix match: `bg-go-deep` counts as `go-deep` and not also as
    // `go`, so a failure names the token that is really on the page.
    return paletteHexes()
      .map(([name]) => name)
      .filter((name) =>
        sources.some((s) => new RegExp(`${COLOR_UTILITY}-${name}(?![a-z0-9-])`).test(s))
      );
  }

  test('every palette token these two surfaces draw from is a neutral or the action green — never a party hue', () => {
    // The other way a party color lands: not in the component, but under it.
    // Redefining --color-ink to a blue would repaint the lean glyph's active
    // segment party-blue without either component changing a character.
    //
    // Scoped to the tokens these surfaces actually use rather than the whole
    // palette, because the whole palette legitimately contains a red:
    // `--color-alert` ("failure, and only failure"). A red that exists is
    // fine; a red REACHABLE FROM AN AFFILIATION SURFACE is the rule. If
    // `text-alert` ever lands on the party line, this test is what catches it.
    const palette = new Map(paletteHexes());
    expect(palette.size, 'the palette must still be parseable from globals.css').toBeGreaterThan(5);

    const used = tokensUsedBySurfaces();
    expect(used.length, 'the two surfaces must still be drawing from the palette at all').toBeGreaterThan(4);

    const partisan = used.filter((n) => isPartisanHue(palette.get(n)!)).map((n) => `--color-${n}: ${palette.get(n)}`);
    expect(partisan, 'CLAUDE.md hard rule: no party-coded colors on a surface that renders affiliation').toEqual([]);
  });

  test('the hue test itself has teeth: it calls a party red and a party blue what they are', () => {
    // Guards against every assertion above passing because isPartisanHue()
    // quietly stopped classifying anything — the failure where a scan reports
    // clean by measuring nothing.
    expect(isPartisanHue('#d22730'), 'a party red').toBe(true);
    expect(isPartisanHue('#1d4ed8'), 'a party blue').toBe(true);
    expect(isPartisanHue('#0f6c4a'), 'the action green is not a party color').toBe(false);
    expect(isPartisanHue('#16191b'), 'near-black ink is not a party color').toBe(false);
    expect(isPartisanHue('#d7ded9'), 'the hairline gray is not a party color').toBe(false);
  });
});

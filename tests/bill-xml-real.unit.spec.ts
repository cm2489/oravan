import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanBillMarkup,
  extractBillStructure,
  isStruckTag,
  prepareBillForDecode,
} from '../lib/bill-text-clean.mjs';
import { decodeBill } from '../scripts/bill-decode.mjs';

/*
 * PR #581's cleaner and splitter, against REAL GPO bill XML (2026-11-28).
 *
 * The independent check scored #581 55/100 because, on real files, struck
 * text survived (44% of S. 1409 RS's "cleaned" text was the struck original)
 * and divisions were never split (every chunk of H.R. 4366 was labelled as
 * covering all seven divisions). The unit tests then used plain text and
 * hand-made HTML only. These use small cuts of real files instead —
 * public-domain bill text from govinfo.gov, cut with their markup verbatim:
 *
 *   tests/fixtures/bill-xml/BILLS-118s1409rs.cut.xml  S. 1409 as reported in
 *     the Senate (an amendment in the nature of a substitute): sections 1, 8
 *     and 13 of the struck original (`changed="deleted"`,
 *     `reported-display-style="strikethrough"`, with a struck <toc> inside),
 *     then sections 1, 8 and 14 of the substitute (`changed="added"`).
 *   tests/fixtures/bill-xml/BILLS-118s479rs.xml  S. 479 as reported, whole
 *     (6 KB): amendments in specific places — <deleted-phrase>, <added-phrase>,
 *     a deleted and an added <quoted-block>.
 *   tests/fixtures/bill-xml/BILLS-118hr4366enr.cut.xml  H.R. 4366 as enrolled:
 *     sections 1 and 2 (the bill's own table of contents) and the opening of
 *     every one of its seven divisions.
 */

const fixture = (name: string) => readFileSync(join(process.cwd(), 'tests/fixtures/bill-xml', name), 'utf8');

test.beforeAll(() => {
  process.env.CONGRESS_API_KEY ??= 'test-key-never-sent-anywhere';
});

test.describe('struck text, as real bill XML marks it', () => {
  test('S. 1409 RS: the struck original is gone, the substitute is whole', () => {
    const clean = cleanBillMarkup(fixture('BILLS-118s1409rs.cut.xml'), 'xml');
    // The substitute (changed="added") is kept, word for word.
    expect(clean).toContain('SEC. 1. Short title; table of contents');
    expect(clean).toContain('SEC. 8. Market research');
    expect(clean).toContain('SEC. 14. Effective date');
    expect(clean).toContain('provides an opportunity for informed consent in the language in which the parent uses the covered platform');
    expect(clean).toContain('disaggregated by the age ranges of 0-5, 6-9, 10-12, and 13-16');
    // The struck original (changed="deleted") is not: its section 13 (now
    // 14), its wording of section 8, and its struck table of contents.
    expect(clean).not.toContain('SEC. 13.');
    expect(clean).not.toContain('informed consent; and');
    expect(clean).not.toContain('0–5, 6–9');
    expect(clean).not.toContain('Sec. 15. Severability.');
    // Each heading once: the struck SEC. 1 and SEC. 8 are not printed beside the live ones.
    expect(clean.match(/^SEC\. 1\. /gm)).toHaveLength(1);
    expect(clean.match(/^SEC\. 8\. /gm)).toHaveLength(1);
  });

  test('S. 479 RS: <deleted-phrase> is dropped, <added-phrase> and the added quoted block are kept', () => {
    const raw = fixture('BILLS-118s479rs.xml');
    expect(raw).toContain('<deleted-phrase reported-display-style="strikethrough">and eligible activities</deleted-phrase>');
    const clean = cleanBillMarkup(raw, 'xml');
    expect(clean).toContain('SEC. 2. Fire management assistance cost share\n');
    expect(clean).not.toContain('and eligible activities');
    expect(clean).not.toContain('Eligible expense');
    expect(clean).toContain('The Federal share of assistance under this section shall be not less than 75 percent');
    expect(clean).toContain('SEC. 4. Policy update');
  });

  test('which start tags count as struck — and that live markers never do', () => {
    expect(isStruckTag('section', ' changed="deleted" id="x"')).toBe(true);
    expect(isStruckTag('quoted-block', ' reported-display-style="strikethrough"')).toBe(true);
    expect(isStruckTag('deleted-phrase', '')).toBe(true);
    expect(isStruckTag('section', ' changed="added" reported-display-style="italic"')).toBe(false);
    expect(isStruckTag('paragraph', ' changed="not-changed"')).toBe(false);
    expect(isStruckTag('legis-body', ' changed="added"')).toBe(false); // an amendment in the nature of a substitute
    expect(isStruckTag('added-phrase', ' reported-display-style="italic"')).toBe(false);
    expect(isStruckTag('span', ' style="text-decoration: line-through"', 'html')).toBe(true);
  });

  test('same-name nesting: a struck section holding a quoted section is dropped whole, nothing after it is', () => {
    const xml = '<legis-body><section changed="deleted"><enum>2.</enum><text>OLD <quoted-block><section><enum>5.</enum><text>QUOTED OLD</text></section></quoted-block> TAIL OLD</text></section>'
      + '<section changed="added"><enum>2.</enum><header>New</header><text>NEW TEXT</text></section></legis-body>';
    expect(cleanBillMarkup(xml, 'xml')).toBe('SEC. 2. New\nNEW TEXT');
  });

  test('a struck tag that never closes cannot swallow the rest of the bill', () => {
    const xml = '<legis-body><section><text>Before <deleted-phrase>this text has no closing tag</text></section><section><text>LATER LIVE TEXT</text></section></legis-body>';
    const clean = cleanBillMarkup(xml, 'xml');
    expect(clean).toContain('LATER LIVE TEXT');
    expect(clean).toContain('Before');
  });

  test('HTML fallback: nested <strike> and line-through spans are dropped', () => {
    const html = '<p>Live <strike>dead <strike>deeper</strike> dead2</strike> live2</p><p>A<span style="text-decoration: line-through">B</span>C</p>';
    expect(cleanBillMarkup(html, 'html')).toBe('Live live2\nA C');
  });
});

test.describe('divisions and titles, as real bill XML carries them', () => {
  const clean = cleanBillMarkup(fixture('BILLS-118hr4366enr.cut.xml'), 'xml');

  test('every division is found at its BODY heading, never from the bill\'s own table of contents', () => {
    const s = extractBillStructure(clean);
    expect(s.divisions.map((d) => d.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    expect(s.divisions[0].title).toBe('Military Construction, Veterans Affairs, and Related Agencies Appropriations Act, 2024');
    expect(s.divisions[6].title).toBe('Other Matters');
    // The XML's own <toc> is dropped, so no "Division A—" entry precedes the body.
    expect(clean).not.toMatch(/^Division A—/m);
    expect(clean.indexOf('DIVISION A—')).toBe(s.divisions[0].charOffset);
    // Titles restart in every division and are attributed to theirs.
    expect(s.titles.filter((t) => t.id === 'I').map((t) => t.division)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  });

  test('headings inside quoted law are not this bill\'s headings', () => {
    const xml = '<legis-body><section><enum>101.</enum><header>Amendment</header><text>Insert:</text><quoted-block><title><enum>V</enum><header>Quoted title</header></title><division><enum>Z</enum><header>Quoted division</header></division></quoted-block></section></legis-body>';
    const s = extractBillStructure(cleanBillMarkup(xml, 'xml'));
    expect(s.divisions).toHaveLength(0);
    expect(s.titles).toHaveLength(0);
  });

  test('chunks are cut at division boundaries and labelled with exactly the divisions each holds', () => {
    const p = prepareBillForDecode(clean, { singleCallMaxChars: 3_000, chunkMaxChars: 4_000 });
    expect(p.mode).toBe('chunked');
    expect(p.chunks.map((c) => c.divisions)).toEqual([['A'], ['B'], ['C', 'D'], ['E', 'F'], ['G']]);
    expect(p.chunks[2].label).toBe(
      'DIVISION C — COMMERCE, JUSTICE, SCIENCE, AND RELATED AGENCIES APPROPRIATIONS ACT, 2024; DIVISION D — ENERGY AND WATER DEVELOPMENT AND RELATED AGENCIES APPROPRIATIONS ACT, 2024'
    );
    for (const c of p.chunks) {
      // Each chunk's own heading lines are exactly the divisions its label names.
      const inText = [...c.text.matchAll(/^DIVISION ([A-Z])—/gm)].map((m) => m[1]);
      expect(inText).toEqual(c.divisions);
      expect(c.text.length).toBeLessThanOrEqual(4_000);
    }
  });

  test('a division too long for one chunk is split at its titles, then lines, and says which part', () => {
    const p = prepareBillForDecode(clean, { singleCallMaxChars: 1_000, chunkMaxChars: 1_500 });
    // Division titles shortened for reading: "DIVISION A — Military …" -> "DIVISION A".
    const labels = p.chunks.map((c) => c.label.replace(/ — [^;(]*?(?= \(|;|$)/g, ''));
    expect(labels).toContain('DIVISION A (TITLE I, part 1 of 2)');
    expect(labels).toContain('DIVISION A (TITLE I, part 2 of 2); DIVISION B (opening provisions)');
    expect(labels[labels.length - 1]).toBe('DIVISION G');
    for (const c of p.chunks) expect(c.text.length).toBeLessThanOrEqual(1_500);
  });

  test('no loss, no double counting: the chunks partition the text exactly', () => {
    for (const chunkMaxChars of [1_500, 2_500, 4_000]) {
      const p = prepareBillForDecode(clean, { singleCallMaxChars: 1_000, chunkMaxChars });
      expect(p.chunks.map((c) => c.text).join('')).toBe(clean);
      for (let i = 1; i < p.chunks.length; i++) expect(p.chunks[i].start).toBe(p.chunks[i - 1].end);
      // Every division is named by at least one chunk, and a division held
      // whole is named by exactly one.
      for (const d of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
        expect(p.chunks.filter((c) => c.divisions.includes(d)).length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test('a split decode sends every character once and synthesizes one summary from every labelled part', async () => {
    // Pad each real division past the single-call ceiling so the default
    // (production) thresholds split it, keeping the real heading lines.
    const s = extractBillStructure(clean);
    const starts = [0, ...s.divisions.map((d) => d.charOffset), clean.length];
    let big = '';
    for (let i = 0; i + 1 < starts.length; i++) {
      big += clean.slice(starts[i], starts[i + 1]);
      if (i > 0) big += `${'Provided further, that amounts are available until expended. '.repeat(1_400)}\n`;
    }
    expect(big.length).toBeGreaterThan(400_000);
    const prepared = prepareBillForDecode(big);
    expect(prepared.mode).toBe('chunked');

    const chunkTexts: string[] = [];
    const synth: string[] = [];
    const api = {
      messages: {
        create: async (params: { messages: { content: string }[] }) => {
          const p = params.messages[0].content;
          if (p.startsWith('Summarize this section')) {
            chunkTexts.push(p.slice(p.indexOf('):\n', p.indexOf('Part covered now (')) + 3));
            return { content: [{ text: `summary ${chunkTexts.length}` }] };
          }
          if (p.startsWith('Combine these section summaries')) {
            synth.push(p);
            return { content: [{ text: 'Division A, Division B, Division C, Division D, Division E, Division F and Division G.' }] };
          }
          return {
            content: [{
              text: ['[HEADLINE_EN]', 'Spending package funds seven areas', '[HEADLINE_ES]', 'Paquete financia siete áreas', '[TLDR]', 'T.', '[WHAT]', 'W.', '[WHO]', 'W.', '[WHY]', 'W.',
                '[COST]', 'NONE', '[COST_CHIPS]', 'NONE', '[ES_TLDR]', 'T.', '[ES_WHAT]', 'Q.', '[ES_WHO]', 'Q.', '[ES_WHY]', 'P.', '[ES_COST]', 'NONE', '[ES_COST_CHIPS]', 'NONE', '[ES_SUMMARY]', 'R.'].join('\n'),
            }],
          };
        },
      },
    };
    const dec = await decodeBill(api as never, { bill_type: 'hr', bill_number: 4366, title: 'Consolidated Appropriations Act, 2024' }, big);
    expect(dec.ai_summary).toContain('Division G');
    // Every character of the bill went to exactly one chunk call.
    expect(chunkTexts.join('')).toBe(big);
    expect(chunkTexts).toHaveLength(prepared.chunks.length);
    // One synthesis, carrying every chunk's label once and telling the model the parts do not overlap.
    expect(synth).toHaveLength(1);
    for (const c of prepared.chunks) expect(synth[0].split(`[${c.label}]`).length - 1).toBe(1);
    expect(synth[0]).toContain('non-overlapping');
  });
});

import { expect, test } from '@playwright/test';
import {
  cleanBillMarkup,
  clipAtWordBoundary,
  preferredTextUrl,
  prepareBillForDecode,
} from '../lib/bill-text-clean.mjs';
import { checkDivisionCoverage, checkHeadlineWordBoundary } from '../lib/decode-quality-gate.mjs';
import {
  DECODE_LONG_SUMMARY_MAX_TOKENS,
  DECODE_SUMMARY_MAX_TOKENS,
  assembleDecode,
  buildStructurePrompt,
  buildSummaryPrompt,
  decodeBill,
  prepareDecodePlan,
  summaryMaxTokensFor,
  textFingerprint,
} from '../scripts/bill-decode.mjs';
import { buildSummaryRequests, decodeBatched, jobPromptSha } from '../lib/decode-batch.mjs';
import { estimateDaySpend } from '../lib/pipeline-health.mjs';
import { pickTextVersion } from '../scripts/text-version.mjs';

test.beforeAll(() => {
  process.env.CONGRESS_API_KEY ??= 'test-key-never-sent-anywhere';
});

test.describe('preferredTextUrl & pickTextVersion', () => {
  test('prefers Formatted XML over Formatted Text HTML', () => {
    const version = {
      type: 'Engrossed in House',
      date: '2026-10-01T04:00:00Z',
      formats: [
        { type: 'Formatted Text', url: 'https://congress.gov/bill.htm' },
        { type: 'Formatted XML', url: 'https://congress.gov/bill.xml' },
      ],
    };
    expect(preferredTextUrl(version)).toEqual({ url: 'https://congress.gov/bill.xml', format: 'xml' });
    expect(pickTextVersion([version])?.type).toBe('Engrossed in House');
  });

  test('falls back cleanly to Formatted Text when XML is absent and skips PDF-only', () => {
    const versions = [
      { type: 'Enrolled Bill', date: null, formats: [{ type: 'PDF', url: 'https://congress.gov/x.pdf' }] },
      { type: 'Reported in Senate', date: '2026-09-10T04:00:00Z', formats: [{ type: 'Formatted Text', url: 'https://congress.gov/x.htm' }] },
    ];
    expect(pickTextVersion(versions)?.type).toBe('Reported in Senate');
    expect(preferredTextUrl(versions[1])).toEqual({ url: 'https://congress.gov/x.htm', format: 'html' });
  });
});

test.describe('cleanBillMarkup', () => {
  test('strips struck-through, deleted, editorial, and metadata markup', () => {
    const xml = `<?xml version="1.0"?>
      <bill>
        <metadata><dc:title>Ignored Header</dc:title></metadata>
        <legis-body>
          <section><enum>1.</enum><header>Short title</header>
            <text>Allocates <struck-through>$50,000,000 from repealed account</struck-through> $120,000,000 for rural transit.</text>
          </section>
          <section><enum>2.</enum><text>Removes <deleted-phrase>legacy exemption</deleted-phrase><del>old clause</del> new cap applies.</text></section>
        </legis-body>
      </bill>`;
    const clean = cleanBillMarkup(xml, 'xml');
    expect(clean).toContain('$120,000,000 for rural transit');
    expect(clean).toContain('new cap applies');
    expect(clean).not.toContain('repealed account');
    expect(clean).not.toContain('legacy exemption');
    expect(clean).not.toContain('old clause');
    expect(clean).not.toContain('Ignored Header');
  });

  test('strips <strike> and <s> in HTML bill text while preserving line breaks', () => {
    const html = '<html><body><style>.x{}</style><p>DIVISION A—APPROPRIATIONS</p><p>Provides <strike>$10B old figure</strike> $25B new figure.</p></body></html>';
    const clean = cleanBillMarkup(html, 'html');
    expect(clean).toContain('DIVISION A—APPROPRIATIONS\nProvides $25B new figure.');
    expect(clean).not.toContain('$10B old figure');
  });
});

test.describe('long bills, division structure, and mega-bill splitting', () => {
  test('extracts multi-division TOC and keeps 150k char bill intact without 60k truncation', () => {
    const bodyA = 'A '.repeat(40_000);
    const bodyB = 'B '.repeat(40_000);
    const text = `DIVISION A — DEFENSE APPROPRIATIONS\nTITLE I — PROCUREMENT\n${bodyA}\nDIVISION B — HEALTH GRANTS\nTITLE II — CLINICS\n${bodyB} TAIL_MARKER`;
    expect(text.length).toBeGreaterThan(150_000);

    const prepared = prepareBillForDecode(text);
    expect(prepared.mode).toBe('single');
    expect(prepared.isMultiDivision).toBe(true);
    expect(prepared.text).toContain('TAIL_MARKER');
    expect(prepared.divisions.map((d) => d.id)).toEqual(['A', 'B']);
    expect(prepared.toc).toContain('DIVISION A: DEFENSE APPROPRIATIONS');
    expect(prepared.toc).toContain('DIVISION B: HEALTH GRANTS');
    expect(summaryMaxTokensFor({ isMultiDivision: prepared.isMultiDivision, textLength: prepared.text.length })).toBe(
      DECODE_LONG_SUMMARY_MAX_TOKENS
    );
  });

  test('splits 500k mega-bill deterministically along division boundaries and synthesizes all divisions', async () => {
    const divA = `DIVISION A — BORDER OPERATIONS\n${'Sec. 101 Border text. '.repeat(12_000)}\n`;
    const divB = `DIVISION B — VETERANS HOUSING\n${'Sec. 201 Housing text. '.repeat(12_000)}\n`;
    const mega = divA + divB;
    expect(mega.length).toBeGreaterThan(450_000);

    const prepared = prepareBillForDecode(mega);
    expect(prepared.mode).toBe('chunked');
    expect(prepared.chunks.length).toBeGreaterThanOrEqual(2);

    const prompts: string[] = [];
    const maxTokens: number[] = [];
    const mockAnthropic = {
      messages: {
        create: async (params: { max_tokens: number; messages: { content: string }[] }) => {
          const content = params.messages[0].content;
          prompts.push(content);
          maxTokens.push(params.max_tokens);
          if (content.startsWith('From this plain-language bill summary')) {
            return {
              content: [{
                text: [
                  '[HEADLINE_EN]\nFunding package would set border and veterans housing budgets',
                  '[HEADLINE_ES]\nPaquete fijaría presupuestos fronterizos y de vivienda para veteranos',
                  '[TLDR]\nWould fund border and veterans housing programs.',
                  '[WHAT]\nWould set spending across Divisions A and B.',
                  '[WHO]\nFederal agencies and veterans.',
                  '[WHY]\nWould allocate annual funds.',
                  '[COST]\nNONE',
                  '[COST_CHIPS]\nNONE',
                  '[ES_TLDR]\nFinanciaría programas fronterizos y de vivienda para veteranos.',
                  '[ES_WHAT]\nFijaría gastos en las Divisiones A y B.',
                  '[ES_WHO]\nAgencias federales y veteranos.',
                  '[ES_WHY]\nAsignaría fondos anuales.',
                  '[ES_COST]\nNONE',
                  '[ES_COST_CHIPS]\nNONE',
                  '[ES_SUMMARY]\nResumen completo.',
                ].join('\n'),
              }],
            };
          }
          if (content.startsWith('Combine these section summaries')) {
            return { content: [{ text: 'Division A would fund border operations. Division B would fund veterans housing.' }] };
          }
          return { content: [{ text: content.includes('DIVISION A') ? 'Border summary.' : 'Veterans housing summary.' }] };
        },
      },
    };

    const bill = { bill_type: 'hr', bill_number: 8800, title: 'Omnibus Package', status: 'floor_vote' };
    const decoded = await decodeBill(mockAnthropic as never, bill, mega);
    expect(decoded.ai_summary).toContain('Division A');
    expect(decoded.ai_summary).toContain('Division B');
    // Chunk summaries + 1 synthesis + 1 structure
    expect(prompts.length).toBe(prepared.chunks.length + 2);
    expect(maxTokens[prepared.chunks.length]).toBe(DECODE_LONG_SUMMARY_MAX_TOKENS);
  });
});

test.describe('word-boundary clipping, division gate, and tense rules', () => {
  test('clips EN and ES headlines at word boundaries without cutting mid-word', () => {
    const enLong =
      'Federal defense authorization package would set fiscal 2027 procurement ceilings and military benefit compensation schedules';
    const clippedEn = clipAtWordBoundary(enLong, 110);
    expect(clippedEn.length).toBeLessThanOrEqual(110);
    expect(clippedEn).toBe(
      'Federal defense authorization package would set fiscal 2027 procurement ceilings and military benefit'
    );
    expect(checkHeadlineWordBoundary(clippedEn, 110).ok).toBe(true);

    const esLong =
      'El proyecto de autorización de defensa fijaría los límites de adquisiciones militares y las reglas de compensación salarial';
    const clippedEs = clipAtWordBoundary(esLong, 110);
    expect(clippedEs.length).toBeLessThanOrEqual(110);
    expect(clippedEs.endsWith('compensa')).toBe(false);
    expect(checkHeadlineWordBoundary(clippedEs, 110).ok).toBe(true);
  });

  test('checkHeadlineWordBoundary flags exact 110-char mid-word slice', () => {
    const sliced = 'a'.repeat(110);
    expect(checkHeadlineWordBoundary(sliced, 110).ok).toBe(false);
  });

  test('checkDivisionCoverage catches dropped Division B and passes complete summary', () => {
    const divisions = [
      { id: 'A', title: 'Defense Appropriations' },
      { id: 'B', title: 'Rural Healthcare Grants' },
    ];
    expect(checkDivisionCoverage('Funds Defense Appropriations across services.', divisions)).toMatchObject({
      ok: false,
      missing: ['Division B (Rural Healthcare Grants)'],
    });
    expect(checkDivisionCoverage('Covers Defense Appropriations and Division B rural healthcare programs.', divisions)).toMatchObject({
      ok: true,
      missing: [],
    });
  });

  test('assembleDecode uses word-boundary clipping and preserves conditional tense rule in structure prompt', () => {
    const structurePrompt = buildStructurePrompt({ bill_type: 'hr', bill_number: 10 }, 'Summary');
    expect(structurePrompt).toContain('conditional tense ("would fund", "would bar"');

    const longEn =
      'Nationwide infrastructure funding measure would expand state highway maintenance and modernize municipal water pipe systems';
    const longEs =
      'Medida nacional de infraestructura ampliaría el mantenimiento vial estatal y modernizaría los sistemas de agua municipal';
    const structureReply = [
      `[HEADLINE_EN]\n${longEn}`,
      `[HEADLINE_ES]\n${longEs}`,
      '[TLDR]\nTldr.',
      '[WHAT]\nWhat.',
      '[WHO]\nWho.',
      '[WHY]\nWhy.',
      '[COST]\nNONE',
      '[COST_CHIPS]\nNONE',
      '[ES_TLDR]\nTldr.',
      '[ES_WHAT]\nQue.',
      '[ES_WHO]\nQuien.',
      '[ES_WHY]\nPor que.',
      '[ES_COST]\nNONE',
      '[ES_COST_CHIPS]\nNONE',
      '[ES_SUMMARY]\nResumen.',
    ].join('\n');

    const dec = assembleDecode('Summary.', structureReply);
    expect(dec.ai_headline.length).toBeLessThanOrEqual(110);
    expect(dec.ai_headline).not.toMatch(/syste$/);
    expect(dec.es_headline.length).toBeLessThanOrEqual(110);
  });

  test('2-arg buildSummaryPrompt preserves existing fingerprint and batch default token limit', () => {
    const bill = { bill_type: 'hr', bill_number: 10167, title: 'A fixture title' };
    expect(textFingerprint(buildSummaryPrompt(bill, 'SEC. 1. SHORT TITLE.'))).toBe('323eb7e24a5fbd01');
    const [row] = buildSummaryRequests([{ slug: 'hr-10167-119', bill, text: 'Short text' }]);
    expect(row.params.max_tokens).toBe(DECODE_SUMMARY_MAX_TOKENS);
  });

  test('batch requests and jobPromptSha share prepareDecodePlan parity on multi-division bills', () => {
    const bill = { bill_type: 'hr', bill_number: 8800, title: 'NDAA', status: 'passed_chamber' };
    const text = `DIVISION A — PROCUREMENT\n${'Sec. 101 '.repeat(8_000)}\nDIVISION B — MILITARY PAY\n${'Sec. 201 '.repeat(8_000)}`;
    const plan = prepareDecodePlan(bill, text);
    const [row] = buildSummaryRequests([{ slug: 'hr-8800-119', bill, text }]);
    expect(row.params.max_tokens).toBe(DECODE_LONG_SUMMARY_MAX_TOKENS);
    expect(row.params.messages[0].content).toBe(plan.summaryPrompt);
    expect(row.params.messages[0].content).toContain('DIVISION A: PROCUREMENT');
    expect(row.params.messages[0].content).toContain('DIVISION B: MILITARY PAY');
    expect(row.params.messages[0].content).toContain('conditional tense ("would ...")');
    expect(jobPromptSha({ slug: 'hr-8800-119', bill, text })).toBe(plan.fingerprint);
  });

  test('decodeBatched routes >400k chunked mega-bills to decodeBill instead of stuffing them whole into a batch', async () => {
    const mega = `DIVISION A — ONE\n${'Sec. 1 '.repeat(35_000)}\nDIVISION B — TWO\n${'Sec. 2 '.repeat(35_000)}`;
    expect(mega.length).toBeGreaterThan(400_000);
    const bill = { bill_type: 'hr', bill_number: 9999, title: 'Mega Bill', status: 'floor_vote' };
    const created: unknown[] = [];
    const mockAnthropic = {
      messages: {
        batches: {
          async create({ requests }: { requests: unknown[] }) {
            created.push(...requests);
            return { id: 'b1', processing_status: 'ended' };
          },
          async retrieve() { return { id: 'b1', processing_status: 'ended' }; },
          async *results() {},
        },
      },
    };
    const results = await decodeBatched([{ slug: 'hr-9999-119', bill, text: mega }], {
      anthropic: mockAnthropic,
      log: () => {},
    });
    expect(created).toHaveLength(0);
    expect(results.get('hr-9999-119')).toEqual({ ok: false, reason: 'chunked-mega-bill' });
  });

  test('estimateDaySpend tracks longDecodes separately while staying compatible at zero', () => {
    const base = estimateDaySpend({ decodes: 2 });
    const withLong = estimateDaySpend({ decodes: 2, longDecodes: 1 });
    expect(base.longDecodeUsd).toBe(0);
    expect(withLong.longDecodeUsd).toBeGreaterThan(base.decodeUsd);
    expect(withLong.totalLow).toBeCloseTo(base.totalLow + withLong.longDecodeUsd, 5);
  });
});

import { readFileSync } from 'node:fs';
import Module from 'node:module';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { billRail } from '../lib/bill-rail';
import { actionPanelEndedLines } from '../lib/embed-ended';
import { withSitePolicyForTest } from '../lib/ended-state.mjs';
import { COMMITTEE_FIXTURE, ENDED_119, ENROLLED_CONCURRENT_FIXTURE, LAW, PRESENTED_FIXTURE } from './fixtures/ended-bills';

/*
 * THE ENDED PAGE IN CI (stage 3 of the new-Congress work, 2026-11-13).
 *
 * The review build that shows the ended state is refused in CI by design
 * (lib/ended-state.mjs), so tests/ended-panel.spec.ts skips there. This spec
 * is the half CI runs: with an ended Congress set through
 * `withSitePolicyForTest` and fixtures built on real records, it runs the
 * functions that decide what the bill page, the action-panel embed and the MCP
 * tool metadata render, and it pins that the bill page and the embed render
 * call apparatus ONLY through those functions. Remove any one behaviour (the
 * page's gate on the floating call button, the call panel's branch, the
 * embed's no-panel frame, TOOL_INFO's reading of the ended list) and a test
 * here fails.
 */

const ended119 = <T>(fn: () => T): T => withSitePolicyForTest(ENDED_119, fn);
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const count = (s: string, needle: string) => s.split(needle).length - 1;

test.describe('the bill page rail (lib/bill-rail.ts)', () => {
  test('an open bill of an ended Congress: the ended panel with the note, and no call apparatus', () => {
    const rail = ended119(() => billRail(COMMITTEE_FIXTURE));
    expect(rail.panel).toBe('ended');
    expect(rail.endedKey).toBe('bill.ended.note');
    expect(rail.floatingCall).toBe(false);
    expect(rail.walkthrough).toBe(false);
    expect(rail.callTabTarget).toBe(false);
  });

  test('a bill both chambers passed: the ended panel with the president line, and no call apparatus', () => {
    const rail = ended119(() => billRail(PRESENTED_FIXTURE));
    expect(rail.panel).toBe('ended');
    expect(rail.endedKey).toBe('bill.ended.presented');
    expect([rail.floatingCall, rail.walkthrough, rail.callTabTarget]).toEqual([false, false, false]);
  });

  test('a law and an enrolled concurrent resolution: the record-only panel, and no call apparatus', () => {
    for (const bill of [LAW, ENROLLED_CONCURRENT_FIXTURE]) {
      const rail = ended119(() => billRail(bill));
      expect(rail.panel, bill.full_identifier).toBe('settled');
      expect([rail.floatingCall, rail.walkthrough, rail.callTabTarget]).toEqual([false, false, false]);
    }
    expect(ended119(() => billRail(LAW)).ended?.kind).toBe('law');
    expect(ended119(() => billRail(ENROLLED_CONCURRENT_FIXTURE)).settled).toEqual({ kind: 'adopted', chamber: 'house' });
  });

  test('today (no Congress ended): the open bills keep the call panel and every call affordance', () => {
    for (const bill of [COMMITTEE_FIXTURE, PRESENTED_FIXTURE, ENROLLED_CONCURRENT_FIXTURE]) {
      const rail = billRail(bill);
      expect(rail.panel, bill.full_identifier).toBe('call');
      expect([rail.floatingCall, rail.walkthrough, rail.callTabTarget]).toEqual([true, true, true]);
      expect(rail.ended).toBeNull();
    }
    expect(billRail(LAW).panel).toBe('settled');
  });
});

test.describe('the bill page renders call apparatus only through the rail', () => {
  const page = read('app/[locale]/bills/[id]/page.tsx');

  test('the floating call button, the call demo and the Call-tab target are each gated on the rail, once', () => {
    expect(page).toContain('{rail.floatingCall && <FloatingCallButton />}');
    expect(count(page, '<FloatingCallButton')).toBe(1);
    expect(page).toMatch(/\{rail\.walkthrough && \(\s*<div className="min-\[62rem\]:col-start-1">\s*<WalkthroughDisclosure \/>/);
    expect(count(page, '<WalkthroughDisclosure')).toBe(1);
    expect(page).toContain('{rail.callTabTarget && <CallTabTarget href="#act" />}');
    expect(count(page, '<CallTabTarget')).toBe(1);
  });

  test('the call panel renders only in the branch after the record-only and ended panels', () => {
    const settledAt = page.indexOf("{rail.panel === 'settled' && settled && settledOutcome ? (");
    const endedAt = page.indexOf(") : rail.panel === 'ended' && ended && endedText ? (");
    const callAt = page.indexOf('<ActionPanel');
    expect(settledAt).toBeGreaterThan(0);
    expect(endedAt).toBeGreaterThan(settledAt);
    expect(callAt).toBeGreaterThan(endedAt);
    expect(count(page, '<ActionPanel')).toBe(1);
    expect(count(page, '<EndedPanel')).toBe(1);
    // The rail is the page's one reading: no second, inline one.
    expect(page).toContain('const rail = billRail(raw);');
    expect(page).not.toMatch(/\bsettledDecision\(|\bendedDecision\(|\bnoCall\b/);
  });
});

test.describe('the paid action-panel embed (lib/embed-ended.ts)', () => {
  test('an ended bill gets the no-panel lines, in both languages; a law gets "This is law." and its line', () => {
    expect(ended119(() => actionPanelEndedLines(COMMITTEE_FIXTURE, en))).toEqual({ kind: 'ended', lines: [en.bill.ended.note] });
    expect(ended119(() => actionPanelEndedLines(COMMITTEE_FIXTURE, es as typeof en))).toEqual({
      kind: 'ended',
      lines: [es.bill.ended.note],
    });
    expect(ended119(() => actionPanelEndedLines(LAW, en))).toEqual({
      kind: 'law',
      lines: [en.bill.settled.law, en.bill.ended.lawLine],
    });
    expect(ended119(() => actionPanelEndedLines(PRESENTED_FIXTURE, en))?.lines).toEqual([en.bill.ended.presented]);
    expect(ended119(() => actionPanelEndedLines(ENROLLED_CONCURRENT_FIXTURE, en))?.lines).toEqual([
      en.bills.status.adopted,
      en.bill.ended.statusLong,
    ]);
    // Today: no lines, so the widget mounts.
    expect(actionPanelEndedLines(COMMITTEE_FIXTURE, en)).toBeNull();
  });

  test('the embed page returns the no-panel frame whenever the lines exist, before the widget', () => {
    const src = read('app/embed/action-panel/page.tsx');
    const linesAt = src.indexOf('const ended = actionPanelEndedLines(bill, t);\n  if (ended) {');
    const widgetAt = src.indexOf('<ActionPanelWidget');
    expect(linesAt).toBeGreaterThan(0);
    expect(widgetAt).toBeGreaterThan(linesAt);
    expect(count(src, '<ActionPanelWidget')).toBe(1);
  });
});

test.describe('MCP tool metadata reads the ended list (lib/core/mcp.ts TOOL_INFO)', () => {
  /* lib/core/mcp.ts reaches lib/freshness.ts's `import 'server-only'`, which
     only Next's bundler resolves; the repo's empty stand-in is used here, as
     scripts/mcp-stdio.mjs does. The module is loaded FRESH under the policy,
     because TOOL_INFO is computed when the module loads. */
  const ResolvingModule = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const realResolve = ResolvingModule._resolveFilename;
  test.beforeAll(() => {
    ResolvingModule._resolveFilename = function (request: string, ...rest: unknown[]) {
      if (request === 'server-only') return join(process.cwd(), 'lib', 'mcp-stdio-server-only-shim.cjs');
      return realResolve.call(this, request, ...rest);
    };
  });
  test.afterAll(() => {
    ResolvingModule._resolveFilename = realResolve;
  });

  const freshMcp = () => {
    const path = require.resolve('../lib/core/mcp');
    delete require.cache[path];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../lib/core/mcp') as typeof import('../lib/core/mcp');
  };

  test('loaded while a Congress has ended, get_bill and search_bills name "ended"; loaded today, they do not', () => {
    const withEnded = ended119(() => freshMcp());
    expect(withEnded.TOOL_INFO.get_bill.description).toContain(withEnded.ENDED_STATE_DESCRIPTION);
    expect(withEnded.TOOL_INFO.search_bills.description).toContain(withEnded.ENDED_STATE_DESCRIPTION);
    const today = freshMcp();
    expect(today.TOOL_INFO.get_bill.description).not.toContain('ended');
    expect(today.TOOL_INFO.search_bills.description).not.toContain('ended');
  });
});

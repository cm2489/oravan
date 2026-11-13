import { readdirSync, readFileSync, statSync } from 'node:fs';
import Module from 'node:module';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { expect, test } from '@playwright/test';
import { NextRequest } from 'next/server';
import en from '../messages/en.json';
import es from '../messages/es.json';
// Relative imports, as in tests/script-settled.unit.spec.ts: the route loads
// in a unit spec (the SDK's CommonJS build does not throw without a key).
import { POST } from '../app/api/script/route';
import { CONGRESS_POLICY, type CongressPolicy } from '../lib/congress.mjs';
import {
  billSlug,
  getActNowInWindow,
  getAllBills,
  getBill,
  getFloorFeatureCandidates,
  getNewsBills,
  getTeasers,
  getTopActions,
  hasActNow,
  hasDecidingNow,
} from '../lib/core/bills';
import { announcementFor, rungFor } from '../lib/docket';
import {
  REVIEW_ENDED_ENV,
  SITE_CONGRESS_POLICY,
  isSiteEndedBill,
  reviewEndedCongressFrom,
  sitePolicy,
  sitePolicyFrom,
  withSitePolicyForTest,
} from '../lib/ended-state.mjs';
import { billFloorBand, endedDecision, liveCallTarget, passageState, settledDecision, statusKeyFor } from '../lib/journey';
import { statusWord } from '../lib/status-word';
import type { Bill, StatusLabelKey } from '../lib/types';
import { verifyFloorSignals, FLOOR_SIGNALS_SCHEMA } from '../scripts/floor-signals-parse.mjs';

/*
 * THE ENDED STATE (stage 3 of the new-Congress work, 2026-11-13).
 *
 * The owner decided on Nov 12, 2026 to keep the 119th Congress's bills as an
 * archive marked "ended" and approved the wording the same evening. This spec
 * pins three things:
 *
 *   1. DORMANT. With lib/congress.mjs's ended list empty (today) and no review
 *      setting, nothing reads as ended, and the MCP tool descriptions are the
 *      exact strings they were before this stage.
 *   2. THE GUARD on the review setting (ORAVAN_REVIEW_ENDED_CONGRESS): refused
 *      in any Vercel or CI build, and for any number but the tracked one.
 *   3. THE ENDED READING, with a test policy (119 ended, 120 tracked) set
 *      through lib/ended-state.mjs `withSitePolicyForTest`, over the committed
 *      corpus and never by editing a data file: the bill page's reading, the
 *      labels, the "moving" lists, the script route, the MCP envelope, the
 *      floor-signals gate and llms.txt. Each test here fails if its piece of
 *      the stage is removed.
 */

/*
 * lib/core/mcp.ts and app/llms.txt reach lib/freshness.ts's `import
 * 'server-only'`, which only Next's bundler resolves. Outside it, the
 * specifier is pointed at the repo's own empty stand-in
 * (lib/mcp-stdio-server-only-shim.cjs, the same patch scripts/mcp-stdio.mjs
 * makes for the same reason) and the two modules load afterwards.
 */
type Mcp = typeof import('../lib/core/mcp');
let mcp: Mcp;
let llmsTxt: () => Response;
const ResolvingModule = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const realResolve = ResolvingModule._resolveFilename;
test.beforeAll(() => {
  ResolvingModule._resolveFilename = function (request: string, ...rest: unknown[]) {
    if (request === 'server-only') return join(process.cwd(), 'lib', 'mcp-stdio-server-only-shim.cjs');
    return realResolve.call(this, request, ...rest);
  };
  // require, not import(): Playwright's TypeScript hook is a require hook.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  mcp = require('../lib/core/mcp') as Mcp;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  llmsTxt = (require('../app/llms.txt/route') as typeof import('../app/llms.txt/route')).GET;
});
test.afterAll(() => {
  ResolvingModule._resolveFilename = realResolve;
});

const ENDED_119: CongressPolicy = Object.freeze({
  tracked: 120,
  ended: Object.freeze([Object.freeze({ number: 119, ended: '2027-01-03' })]),
});

const ended119 = <T>(fn: () => T): T => withSitePolicyForTest(ENDED_119, fn);

/** The keys that describe a stage a decision could still move from. */
const LIVE_KEYS: ReadonlySet<StatusLabelKey> = new Set<StatusLabelKey>([
  'introduced',
  'committee',
  'markup',
  'floor_vote',
  'floor_vote_stale',
  'floor_activity',
  'passed_chamber',
  'conference',
]);

function bill(slug: string): Bill {
  const b = getBill(slug);
  expect(b, `${slug} is in the committed corpus`).toBeTruthy();
  return b!;
}

/* ------------------------------------------------------------------ *
 * 1. DORMANT
 * ------------------------------------------------------------------ */

test('dormant: no review setting here, and the site reads exactly the pipeline\'s (empty) ended list', () => {
  expect(process.env[REVIEW_ENDED_ENV] ?? '', 'the unit run never sets the review setting').toBe('');
  expect(CONGRESS_POLICY.ended, 'stage 3 never fills the list').toEqual([]);
  expect(SITE_CONGRESS_POLICY).toBe(CONGRESS_POLICY);
  expect(sitePolicy()).toBe(CONGRESS_POLICY);
});

test('dormant: no bill in the committed corpus reads as ended on any reader', () => {
  const all = getAllBills();
  expect(all.length).toBeGreaterThan(1000);
  for (const b of all) {
    expect(isSiteEndedBill(b), billSlug(b)).toBe(false);
    expect(endedDecision(b), billSlug(b)).toBeNull();
    expect(statusKeyFor(b), billSlug(b)).not.toBe('ended');
    expect(statusWord(b), billSlug(b)).not.toBe('ended');
    expect(mcp.billDecision(b).state, billSlug(b)).not.toBe('ended');
  }
});

test('dormant: the MCP tool descriptions are the exact strings they were before this stage', () => {
  expect(mcp.toolInfoFor(false)).toEqual(mcp.TOOL_INFO);
  // Main's get_bill description at a6f1fb1d, verbatim.
  expect(mcp.TOOL_INFO.get_bill.description).toBe(
    'Get the full plain-language decode of a federal bill by slug (e.g. "hr-2701-119") or ' +
      'citation (e.g. "H.R. 2701" - resolves to the most recent Congress on a match). Returns the ' +
      'AI-generated summary (headline, tl;dr, what/who/why/cost - automatically checked before ' +
      'publish and clearly labeled when present), the official status in plain language, a ' +
      "decision_state (pending, settled or enacted, with the official record's own sentence in " +
      'settled_reason once the decision is settled or enacted), an urgency band and an urgency_score (the ' +
      'score is ranked from status and recency alone; decision_state, not the score, says whether a ' +
      'decision is still ahead), sponsor, key dates, the ' +
      "official Congress.gov page, and - while the decision is still pending - an act_url to Oravan's " +
      'on-site call flow. This tool never drafts a phone script - script generation happens only on-site, ' +
      'where the caller reads and can edit the script before dialing; that is not available over ' +
      'this API.'
  );
  expect(mcp.TOOL_INFO.search_bills.description).toBe(
    "Search Oravan's bilingual federal bill corpus by free-text query, issue topic, status, or " +
      'active-only. Returns short teasers (headline, status, decision_state, urgency) for matching ' +
      'bills, most urgent first. The urgency_score is ranked from status and recency alone; ' +
      'decision_state says whether a decision is still ahead.'
  );
});

/* ------------------------------------------------------------------ *
 * 2. THE REVIEW SETTING'S GUARD
 * ------------------------------------------------------------------ */

test('the review setting: off by default, 119 accepted on a local build only', () => {
  for (const off of [undefined, '', '0', 'off', 'OFF', 'false']) {
    expect(reviewEndedCongressFrom({ [REVIEW_ENDED_ENV]: off }, 119), String(off)).toBeNull();
  }
  expect(reviewEndedCongressFrom({ [REVIEW_ENDED_ENV]: '119' }, 119)).toBe(119);
  // Refused wherever a deploy or CI could carry it.
  for (const where of ['VERCEL', 'VERCEL_ENV', 'CI', 'GITHUB_ACTIONS']) {
    expect(
      () => reviewEndedCongressFrom({ [REVIEW_ENDED_ENV]: '119', [where]: where === 'VERCEL_ENV' ? 'production' : '1' }, 119),
      where
    ).toThrow(/refused here/);
  }
  expect(() => reviewEndedCongressFrom({ [REVIEW_ENDED_ENV]: '119', CI: 'true' }, 119)).toThrow(/CI set/);
  // Only the tracked Congress: the approved wording names it.
  for (const bad of ['118', '120', 'abc', '119.5']) {
    expect(() => reviewEndedCongressFrom({ [REVIEW_ENDED_ENV]: bad }, 119), bad).toThrow(/not accepted/);
  }
  // Off stays off even in CI: an unset setting never throws.
  expect(reviewEndedCongressFrom({ CI: 'true', VERCEL: '1' }, 119)).toBeNull();
});

test('the review setting adds the reviewed Congress with its term\'s last day, and nothing else', () => {
  expect(sitePolicyFrom(CONGRESS_POLICY, null)).toBe(CONGRESS_POLICY);
  expect(sitePolicyFrom(CONGRESS_POLICY, 119)).toEqual({ tracked: 119, ended: [{ number: 119, ended: '2027-01-03' }] });
});

test('the review setting is read in next.config.ts, so a refused one stops the build before it compiles', () => {
  const config = readFileSync(join(process.cwd(), 'next.config.ts'), 'utf8');
  expect(config).toMatch(/reviewEndedCongressFrom\(process\.env\)/);
});

test('the test setting is named by no file outside tests/', () => {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(name)) {
        const text = readFileSync(path, 'utf8');
        if (/withSitePolicyForTest/.test(text) && path !== join('lib', 'ended-state.mjs')) hits.push(path);
      }
    }
  };
  for (const root of ['app', 'components', 'lib', 'scripts', 'i18n']) walk(root);
  expect(hits).toEqual([]);
});

test('withSitePolicyForTest restores the site policy after a sync or async body, and after a throw', async () => {
  expect(ended119(() => isSiteEndedBill('hr-1-119'))).toBe(true);
  expect(isSiteEndedBill('hr-1-119')).toBe(false);
  expect(await withSitePolicyForTest(ENDED_119, async () => isSiteEndedBill('hr-1-119'))).toBe(true);
  expect(isSiteEndedBill('hr-1-119')).toBe(false);
  expect(() =>
    ended119(() => {
      throw new Error('boom');
    })
  ).toThrow('boom');
  expect(sitePolicy()).toBe(CONGRESS_POLICY);
});

/* ------------------------------------------------------------------ *
 * 3. THE ENDED READING (119 ended, 120 tracked)
 * ------------------------------------------------------------------ */

test('item 1: every 119th bill gets one ended kind, read off the record', () => {
  ended119(() => {
    const counts: Record<string, number> = {};
    for (const b of getAllBills()) {
      const ended = endedDecision(b);
      expect(ended, billSlug(b)).not.toBeNull();
      expect(ended!.congress).toBe(119);
      expect(ended!.ended).toBe('2027-01-03');
      const settled = settledDecision(b);
      const expected =
        settled?.kind === 'law'
          ? 'law'
          : settled
            ? 'decided'
            : b.status === 'passed_chamber' && passageState(b).stage === 'both'
              ? 'presented'
              : 'ended';
      expect(ended!.kind, billSlug(b)).toBe(expected);
      counts[expected] = (counts[expected] ?? 0) + 1;
    }
    // Non-vacuity, as ranges (the corpus moves): on 2026-11-13, 3,176 ended,
    // 119 laws, 13 decided, 10 presented.
    expect(counts.ended).toBeGreaterThan(1000);
    expect(counts.law).toBeGreaterThan(10);
    expect(counts.decided).toBeGreaterThan(0);
    expect(counts.presented).toBeGreaterThan(0);
  });
});

test('item 1: named examples, one per kind', () => {
  ended119(() => {
    expect(endedDecision(bill('hr-1-119'))?.kind, 'H.R. 1, Public Law 119-21').toBe('law');
    expect(endedDecision(bill('hconres-89-119'))?.kind, 'H.Con.Res. 89, rejected 49-50').toBe('decided');
    expect(endedDecision(bill('hconres-86-119'))?.kind, 'H.Con.Res. 86, adopted').toBe('decided');
    expect(endedDecision(bill('hr-4930-119'))?.kind, 'H.R. 4930, passed both chambers').toBe('presented');
    const committee = getAllBills().find((b) => b.status === 'committee')!;
    expect(endedDecision(committee)?.kind).toBe('ended');
  });
  // And a bill of the tracked Congress (a slug, as the 120th's would be) is not ended.
  ended119(() => expect(isSiteEndedBill('hr-1-120')).toBe(false));
});

test('item 1: no call target and no floor band on any ended bill, even with an announcement in hand', () => {
  ended119(() => {
    for (const b of getAllBills()) {
      expect(liveCallTarget(b), billSlug(b)).toBeNull();
      expect(
        billFloorBand(b, { chamber: 'senate', published: b.last_action_date ?? '2026-11-01' }, Date.now(), () => 'in_session'),
        billSlug(b)
      ).toBeNull();
    }
  });
  // The control: without the policy, an announcement still makes a band.
  const any = getAllBills()[0];
  expect(billFloorBand(any, { chamber: 'senate', published: '2026-11-01' })).not.toBeNull();
});

test('item 2: the status label never says a live stage of an ended bill; the record\'s outcomes stay', () => {
  ended119(() => {
    const seen = new Set<StatusLabelKey>();
    for (const b of getAllBills()) {
      const key = statusKeyFor(b);
      seen.add(key);
      expect(LIVE_KEYS.has(key), `${billSlug(b)} reads ${key}`).toBe(false);
      // "Open" survives only where a decision IS still ahead: both chambers
      // passed it, and the President's answer is not on the record yet (the
      // MCP envelope reads that `pending`, without an act_url).
      if (endedDecision(b)?.kind !== 'presented') expect(statusWord(b), billSlug(b)).not.toBe('open');
    }
    expect(seen.has('ended')).toBe(true);
    expect(statusKeyFor(bill('hr-1-119'))).toBe('signed');
    expect(statusKeyFor(bill('hconres-89-119'))).toBe('rejected');
    expect(statusKeyFor(bill('hconres-86-119'))).toBe('adopted');
    expect(statusKeyFor(bill('hr-4930-119'))).toBe('passed_both');
    // The MCP label reads the same gate, in both languages.
    const committee = getAllBills().find((b) => b.status === 'committee')!;
    expect(mcp.statusLabel(committee, 'en')).toBe('Ended');
    expect(mcp.statusLabel(committee, 'es')).toBe('Terminado');
  });
});

test('item 2: the approved wording, exactly, in both languages', () => {
  expect(en.bills.status.ended).toBe('Ended');
  expect(es.bills.status.ended).toBe('Terminado');
  expect(en.bills.statusWord.ended).toBe('Ended');
  expect(es.bills.statusWord.ended).toBe('Terminado');
  expect(en.bill.ended).toEqual({
    statusLong: 'Ended with the 119th Congress',
    note: 'This bill ended with the 119th Congress on January 3, 2027, before Congress finished it. A bill that ends this way can only move again if it is introduced in a new Congress, with a new number.',
    lawLine: 'Became law during the 119th Congress.',
    presented:
      'Both chambers passed it before the 119th Congress ended. The record does not yet show what the president did.',
  });
  expect(es.bill.ended).toEqual({
    statusLong: 'Terminó con el Congreso 119',
    note: 'Este proyecto de ley terminó con el Congreso 119 el 3 de enero de 2027, antes de que el Congreso lo terminara. Un proyecto que termina así solo puede avanzar de nuevo si se presenta en un nuevo Congreso, con un número nuevo.',
    lawLine: 'Se convirtió en ley durante el Congreso 119.',
    presented:
      'Ambas cámaras lo aprobaron antes de que terminara el Congreso 119. El registro todavía no muestra qué hizo el presidente.',
  });
});

test('item 2: an ended bill is never moving: terminal rung, no announcement, empty act-now pool, no news card', () => {
  ended119(() => {
    for (const b of getAllBills()) {
      const slug = billSlug(b);
      const rung = rungFor(b, slug);
      expect(rung.tier, slug).toBe('t4');
      expect(rung.terminal, slug).toBe(true);
      expect(rung.announced, slug).toBeNull();
      expect(rung.annotation, slug).toBeNull();
      expect(announcementFor(b, slug), slug).toBeNull();
    }
    expect(hasActNow()).toBe(false);
    expect(hasDecidingNow()).toBe(false);
    expect(getTopActions(5)).toEqual([]);
    expect(getFloorFeatureCandidates()).toEqual([]);
    expect(getActNowInWindow(30)).toEqual([]);
    expect(getNewsBills('en', 6)).toEqual([]);
    expect(new Set(getTeasers('en').map((t) => t.band))).toEqual(new Set(['radar']));
  });
  // The control: the committed corpus does have bills moving off the
  // ladder's own rungs today (or the assertions above prove nothing).
  expect(getTeasers('en').some((t) => t.band !== 'radar')).toBe(true);
});

test('item 5: the MCP envelope says ended, offers no act_url, scores 0, and keeps laws and decided bills', () => {
  ended119(() => {
    const committee = getAllBills().find((b) => b.status === 'committee' && b.ai_headline)!;
    const detail = mcp.getBillDetail({ slug: billSlug(committee) }, 'en')!;
    expect(detail.bill.decision_state).toBe('ended');
    expect(detail.bill.settled_reason).toBeNull();
    expect(detail.bill.act_url).toBeNull();
    expect(detail.bill.urgency_score).toBe(0);
    expect(detail.bill.urgency_band).toBe('radar');
    expect(detail.bill.status_label).toBe('Ended');

    const law = mcp.getBillDetail({ slug: 'hr-1-119' }, 'en')!;
    expect(law.bill.decision_state).toBe('enacted');
    expect(law.bill.act_url).toBeNull();

    const rejected = mcp.getBillDetail({ slug: 'hconres-89-119' }, 'en')!;
    expect(rejected.bill.decision_state).toBe('settled');
    expect(rejected.bill.settled_reason).toBeTruthy();

    const presented = mcp.getBillDetail({ slug: 'hr-4930-119' }, 'en')!;
    expect(presented.bill.decision_state, 'a decision is still ahead: the President\'s').toBe('pending');
    expect(presented.bill.act_url, 'but no call to Congress').toBeNull();

    expect(mcp.whatsMoving({ days: 30 }, 'en').bills).toEqual([]);
    const active = mcp.searchBills({ activeOnly: true, limit: 50 }, 'en');
    expect(active.total_matches).toBe(0);
    const all = mcp.searchBills({ limit: 50 }, 'en');
    expect(all.results.every((r) => r.urgency_score === 0)).toBe(true);
    expect(all.results.some((r) => r.decision_state === 'ended')).toBe(true);
  });
  // The control: today the same committee bill is pending with an act_url.
  const committee = getAllBills().find((b) => b.status === 'committee' && b.ai_headline)!;
  const today = mcp.getBillDetail({ slug: billSlug(committee) }, 'en')!;
  expect(today.bill.decision_state).toBe('pending');
  expect(today.bill.act_url).toBeTruthy();
});

test('item 5: the tool descriptions name the ended value, with the approved description, only when a Congress has ended', () => {
  expect(mcp.ENDED_STATE_DESCRIPTION).toBe(
    'The Congress this bill belonged to has ended, and the bill can no longer move. A new bill would have to be introduced.'
  );
  const withEnded = mcp.toolInfoFor(true);
  expect(withEnded.get_bill.description).toContain('decision_state (pending, settled, enacted or ended');
  expect(withEnded.get_bill.description).toContain(mcp.ENDED_STATE_DESCRIPTION);
  expect(withEnded.get_bill.description).toContain('never for a bill of a Congress that has ended');
  expect(withEnded.search_bills.description).toContain(mcp.ENDED_STATE_DESCRIPTION);
  // The 60-character prefix tests/mcp-docs.spec.ts pins is the same either way.
  expect(withEnded.get_bill.description.slice(0, 60)).toBe(mcp.TOOL_INFO.get_bill.description.slice(0, 60));
  for (const name of ['lookup_representatives', 'whats_moving', 'get_representative'] as const) {
    expect(withEnded[name]).toEqual(mcp.TOOL_INFO[name]);
  }
});

test('item 6: llms.txt counts the ended bills as a record, and says nothing new while none has ended', async () => {
  const today = await llmsTxt().text();
  expect(today).not.toMatch(/has ended|which ended|marked ended/);
  const reviewed = await ended119(() => llmsTxt().text());
  const total = getAllBills().length;
  expect(reviewed).toContain(
    ` ${total} of them are bills of the 119th Congress, which ended on January 3, 2027; they are kept as a record, marked ended, and offer no call.`
  );
  // Everything else in the file is unchanged.
  expect(reviewed.replace(/ \d+ of them are bills of the 119th Congress[^\n]*?offer no call\./, '')).toBe(today);
});

test('item 9: the floor-signals gate fails a live signal on an ended bill, and only warns on a stale one', () => {
  const entry = (stale: boolean) => ({
    tier0: { source: 'daily-digest', quote: 'Senate will vote.', quote_lang: 'en', url: 'https://x/y', published: '2026-08-04' },
    fetched_at: new Date().toISOString(),
    ...(stale ? { stale: true } : {}),
  });
  const file = (stale: boolean) => ({
    _meta: { schema: FLOOR_SIGNALS_SCHEMA, fetched_at: new Date().toISOString() },
    signals: { 'hr-1-119': entry(stale) },
  });
  const live = verifyFloorSignals({ data: file(false), fileBytes: 100, policy: ENDED_119 });
  expect(live.failures.join('\n')).toMatch(/hr-1-119, a bill of Congress 119, which has ended/);
  const stale = verifyFloorSignals({ data: file(true), fileBytes: 100, policy: ENDED_119 });
  expect(stale.failures).toEqual([]);
  expect(stale.warnings.join('\n')).toMatch(/which has ended/);
  // Today (the pipeline's empty list) the same file passes.
  expect(verifyFloorSignals({ data: file(false), fileBytes: 100 }).failures).toEqual([]);
});

/* ------------------------------------------------------------------ *
 * item 3: the script route refuses an ended bill, before any cache read
 * or model call (the harness of tests/script-settled.unit.spec.ts)
 * ------------------------------------------------------------------ */

test.describe('item 3: app/api/script', () => {
  const realCreate = Anthropic.Messages.prototype.create;
  const realFetch = globalThis.fetch;
  let savedEnv: Record<string, string | undefined> = {};
  let modelCalls = 0;
  let fetchCalls: string[] = [];
  let ipSeq = 0;

  test.beforeAll(() => {
    savedEnv = {};
    for (const name of Object.keys(process.env)) {
      if (name === 'ANTHROPIC_API_KEY' || name.startsWith('UPSTASH_')) {
        savedEnv[name] = process.env[name];
        delete process.env[name];
      }
    }
  });
  test.afterAll(() => {
    for (const [name, value] of Object.entries(savedEnv)) if (value !== undefined) process.env[name] = value;
  });
  test.beforeEach(() => {
    modelCalls = 0;
    Anthropic.Messages.prototype.create = function blockedCreate() {
      modelCalls += 1;
      throw new Error('blocked in unit test');
    } as typeof realCreate;
    fetchCalls = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input instanceof Request ? input.url : input));
      throw new Error('blocked in unit test');
    }) as typeof fetch;
  });
  test.afterEach(() => {
    Anthropic.Messages.prototype.create = realCreate;
    globalThis.fetch = realFetch;
  });

  const post = (slug: string, stance = 'support', locale: 'en' | 'es' = 'en') => {
    ipSeq += 1;
    return POST(
      new NextRequest('http://localhost/api/script', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.114.${ipSeq}` },
        body: JSON.stringify({ slug, stance, locale }),
      })
    );
  };

  test('an ended, open bill → 409 ended, every stance, both languages, no model call, no network', async () => {
    const open = getAllBills().find((b) => b.status === 'committee' && b.ai_summary && settledDecision(b) === null)!;
    for (const stance of ['support', 'oppose', 'undecided']) {
      for (const locale of ['en', 'es'] as const) {
        const res = await withSitePolicyForTest(ENDED_119, () => post(billSlug(open), stance, locale));
        expect(res.status, `${stance}/${locale}`).toBe(409);
        expect(await res.json()).toEqual({ error: 'ended' });
      }
    }
    expect(modelCalls).toBe(0);
    expect(fetchCalls).toEqual([]);
  });

  test('a passed-both-chambers bill of the ended Congress is refused the same way', async () => {
    const res = await withSitePolicyForTest(ENDED_119, () => post('hr-4930-119'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'ended' });
    expect(modelCalls).toBe(0);
  });

  test('the control: today the same bill reaches the model (502 only because the stub throws)', async () => {
    const open = getAllBills().find((b) => b.status === 'committee' && b.ai_summary && settledDecision(b) === null)!;
    const res = await post(billSlug(open));
    expect(res.status).toBe(502);
    expect(modelCalls).toBe(1);
  });
});

import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_NEEDS,
  NOTE_ASSIGNEE,
  NOTE_LABEL,
  candidatesLine,
  mondayOf,
  needsBlock,
  needsColbyLines,
  nightlyLine,
  noteBody,
  noteTitle,
  pickNeeds,
  spendLine,
  visitorsLine,
} from '../lib/weekly-note.mjs';

/*
 * lib/weekly-note.mjs — the one note a week written for the owner (his answer
 * of 2026-11-23, card `emails`, option a: "One plain note every Monday at
 * 9 AM ET, and the robot threads go quiet"). Every source here is a fixture;
 * the shapes are copied from #242 as it stood on 2026-11-23.
 */

const MON = new Date('2026-11-30T14:00:00Z'); // 9:00 AM ET, Monday

const DOCTOR_REPORT = [
  '## 2. Fixed today',
  'Nothing.',
  '',
  '## 3. Needs Colby',
  '- **Anthropic credit:** still open since 11-11. There have been no credit refusals in any log.',
  '- **Pregen cache TTL (decision, small money):** see Watching.',
  '  - a nested detail that is not a need of its own',
  '',
  '## 4. Spend',
  '- **11-22 estimate:** about $0.75–0.85.',
].join('\n');

const HEALTH_BODY = [
  '🩺 Pipeline health',
  '_Rewritten every run. Last update: 2026-11-29T13:04:20.353Z (trailing 24h)._',
  '```',
  'nightly             success in 43.4m (23.7h ago)',
  'spend (estimate)    ~$0.617-$0.659 today (decodes $0.044, re-decodes $0.440, t3 $0.049, pregen $0.084-$0.126)',
  '```',
].join('\n');

test.describe('the title and the day', () => {
  test('Monday\'s date on the owner\'s clock', () => {
    expect(noteTitle(MON)).toBe('📬 Oravan this week — Nov 30');
  });

  test('a run on another day (a manual dispatch) still names that week\'s Monday', () => {
    expect(mondayOf(new Date('2026-12-03T18:00:00Z'))).toBe('2026-11-30');
    // Sunday 11 PM ET is still the week that began the Monday before.
    expect(mondayOf(new Date('2026-12-07T03:30:00Z'))).toBe('2026-11-30');
  });
});

test.describe('Needs you — the first line is always the answer', () => {
  test('the top-level bullets under "Needs Colby", markdown off, nested lines and the next section left out', () => {
    expect(needsColbyLines(DOCTOR_REPORT)).toEqual([
      'Anthropic credit: still open since 11-11. There have been no credit refusals in any log.',
      'Pregen cache TTL (decision, small money): see Watching.',
    ]);
  });

  test('no heading is null (not "nothing"); "Nothing new." is not a need', () => {
    expect(needsColbyLines(HEALTH_BODY)).toBeNull();
    expect(needsColbyLines('## 3. Needs Colby\n- Nothing new.\n\n## 4. Spend')).toEqual([]);
    expect(needsColbyLines('**Needs Colby**\n- Re-run job 44331609421.\n**Spend**\n- x')).toEqual(['Re-run job 44331609421.']);
  });

  test('the body wins when it carries the heading; else the doctor\'s newest report under 8 days old', () => {
    const comments = [
      { body: '## 3. Needs Colby\n- an old need', createdAt: '2026-11-25T15:00:00Z', url: 'u-old' },
      { body: DOCTOR_REPORT, createdAt: '2026-11-30T15:00:00Z', url: 'u-new' },
      { body: 'a bot comment with no heading', createdAt: '2026-11-30T20:00:00Z', url: 'u-bot' },
    ];
    const picked = pickNeeds({ body: HEALTH_BODY, comments, now: new Date('2026-12-01T14:00:00Z') });
    expect(picked).toMatchObject({ status: 'ok', url: 'u-new' });
    expect(pickNeeds({ body: '## Needs Colby\n- from the body', comments, now: MON })).toEqual({
      status: 'ok',
      lines: ['from the body'],
      url: null,
    });
  });

  test('an old report says it cannot tell; an unreadable source says so — never "nothing needs you"', () => {
    const stale = pickNeeds({
      body: HEALTH_BODY,
      comments: [{ body: DOCTOR_REPORT, createdAt: '2026-11-10T15:00:00Z', url: 'u' }],
      now: MON,
    });
    expect(stale).toEqual({ status: 'stale' });
    expect(needsBlock(stale)[0]).toMatch(/^Needs you: can't tell this week/);
    const unread = pickNeeds({ body: null, comments: null, now: MON });
    expect(needsBlock(unread)[0]).toMatch(/^Needs you: couldn't be read/);
  });

  test('none: one line; some: "Needs you:" then the lines, capped, with the report linked', () => {
    expect(needsBlock({ status: 'ok', lines: [], url: null })).toEqual(['Nothing needs you this week.']);
    const many = Array.from({ length: MAX_NEEDS + 2 }, (_, i) => `need ${i + 1}`);
    const block = needsBlock({ status: 'ok', lines: many, url: 'https://example.test/c' });
    expect(block[0]).toBe('Needs you:');
    expect(block.slice(1, MAX_NEEDS + 1)).toEqual(many.slice(0, MAX_NEEDS).map((l) => `- ${l}`));
    expect(block).toContain("- …and 2 more in the doctor's report.");
    expect(block.at(-1)).toContain('https://example.test/c');
  });
});

test.describe('the other lines — aggregate counts, or a plain "couldn\'t be read"', () => {
  const days = ['2026-11-29', '2026-11-28', '2026-11-27', '2026-11-26', '2026-11-25', '2026-11-24', '2026-11-23'];

  test('visitors: a week of page loads and the days whose estimate still exists, labeled bots-included', () => {
    const line = visitorsLine({
      pageviews: { ok: true, total: 31240 },
      distinct: days.map((day, i) => ({ day, ok: true, count: i === 0 ? 1737 : i === 1 ? 1802 : null })),
    });
    expect(line).toBe(
      'Visitors, last 7 days (bots included; a real-people count is coming): 31,240 page loads. Different addresses a day: Sun 1,737 · Sat 1,802 (older days are not kept).'
    );
  });

  test('visitors: nothing readable is said once, plainly, with no number', () => {
    const line = visitorsLine({ pageviews: { ok: false }, distinct: days.map((day) => ({ day, ok: false })) });
    expect(line).toContain("couldn't be read this week");
    expect(line.slice(line.indexOf('):'))).not.toMatch(/\d/);
  });

  test('visitors: one source down, the other still speaks', () => {
    const line = visitorsLine({ pageviews: { ok: true, total: 5 }, distinct: days.map((day) => ({ day, ok: false })) });
    expect(line).toContain('5 page loads.');
    expect(line).toContain("Different addresses a day couldn't be read.");
  });

  test('nightly: of the last 7 finished scheduled runs, how many worked, naming the days that did not', () => {
    const runs = [
      ...Array.from({ length: 5 }, () => ({ conclusion: 'success', createdAt: '2026-11-28T03:00:00Z' })),
      { conclusion: 'failure', createdAt: '2026-11-22T03:00:00Z' },
      { conclusion: 'success', createdAt: '2026-11-21T03:00:00Z' },
      { conclusion: 'failure', createdAt: '2026-11-20T03:00:00Z' },
    ];
    expect(nightlyLine(runs)).toBe("Nightly data: 6 of the last 7 nightly runs worked (didn't: Nov 22).");
    expect(nightlyLine(null)).toContain("couldn't be read");
  });

  test('candidates: the count and the newest three, by bill name when one was found', () => {
    const line = candidatesLine([
      { number: 410, title: 'Big Question candidate: hr-1-119', createdAt: '2026-10-01T00:00:00Z' },
      { number: 537, title: 'Big Question candidate: hr-2347-119', createdAt: '2026-11-23T00:00:00Z', billTitle: 'Bipartisan American Affordability and Jobs Act of 2026' },
      { number: 530, title: 'Big Question candidate: s-4035-119', createdAt: '2026-11-22T00:00:00Z' },
      { number: 528, title: 'Big Question candidate: hr-2478-119', createdAt: '2026-11-21T00:00:00Z', billTitle: null },
    ]);
    expect(line).toBe(
      'Big Question candidates waiting: 4. Newest: #537 Bipartisan American Affordability and Jobs Act of 2026 · #530 s-4035-119 · #528 hr-2478-119'
    );
    expect(candidatesLine([])).toBe('Big Question candidates waiting: none.');
    expect(candidatesLine(null)).toContain("couldn't be read");
  });

  test('AI spend: quoted from #242\'s body exactly; no row, no line — never an invented figure', () => {
    expect(spendLine(HEALTH_BODY)).toBe(
      "AI spend: ~$0.617-$0.659 in the 24 hours to Nov 29 (the pipeline report's estimate; it leaves some calls out, so it is a floor, not the bill)."
    );
    expect(spendLine('spend (estimate)    not computed')).toBeNull();
    expect(spendLine(null)).toBeNull();
  });
});

test.describe('the whole note', () => {
  const parts = {
    needs: { status: 'ok' as const, lines: [] as string[], url: null },
    visitors: 'Visitors: v.',
    people: null as string | null,
    nightly: 'Nightly data: n.',
    candidates: 'Big Question candidates waiting: c.',
    spend: null as string | null,
  };

  test('plain, short, the answer first; the people hook adds a line only when it has one', () => {
    const body = noteBody(parts);
    expect(body.split('\n')[0]).toBe('Nothing needs you this week.');
    expect(body.split('\n').length).toBeLessThanOrEqual(12);
    expect(body).not.toContain('Spend');
    expect(noteBody({ ...parts, people: 'People: p.' })).toContain('Visitors: v.\nPeople: p.\nNightly data: n.');
  });

  test('it never @-mentions anyone: the assignment is what emails the owner', () => {
    expect(noteBody(parts)).not.toContain('@');
    expect(NOTE_ASSIGNEE).toBe('cm2489');
    expect(NOTE_LABEL).toBe('weekly-note');
  });
});

test.describe('.github/workflows/weekly-note.yml and the script it runs', () => {
  const yml = readFileSync(join(process.cwd(), '.github/workflows/weekly-note.yml'), 'utf8');
  const script = readFileSync(join(process.cwd(), 'scripts/weekly-note.mjs'), 'utf8');

  test('Mondays at 14:00 UTC, with both clocks written beside it, and a manual run', () => {
    expect(yml).toContain("- cron: '0 14 * * 1'");
    expect(yml).toMatch(/9:00 AM ET[\s\S]*10:00 AM ET/);
    expect(yml).toContain('workflow_dispatch:');
  });

  test('it reads the same counters secrets as the daily digest, in the live keyspace, and only what it needs', () => {
    expect(yml).toContain('UPSTASH_COUNTERS_REST_URL: ${{ secrets.UPSTASH_COUNTERS_REST_URL }}');
    expect(yml).toContain('VERCEL_ENV: production');
    expect(yml).not.toMatch(/ANTHROPIC_API_KEY|CONGRESS_API_KEY|UPSTASH_CACHE|UPSTASH_TENANCY/);
    expect(yml).toContain('run: npx tsx scripts/weekly-note.mjs');
  });

  test('the script opens an assigned, labeled issue, closes the others, and has a --dry-run that writes nothing', () => {
    expect(script).toContain("'--assignee', NOTE_ASSIGNEE");
    expect(script).toContain("'--label', NOTE_LABEL");
    expect(script).toContain("'issue', 'close'");
    expect(script).toContain('if (old === number) continue;');
    const dry = script.slice(script.indexOf('if (dryRun) {'), script.indexOf('const file = join('));
    expect(dry).toContain('return;');
    expect(dry).not.toMatch(/gh\(/);
  });

  test('it only READS the counters, and leaves a named hook for the real-people count', () => {
    expect(script).toContain("import { PAGEVIEW_SURFACES, readPageviewWindow } from '../lib/usage';");
    expect(script).toContain("import { readDistinctAddressCount } from '../lib/ratelimit';");
    expect(script).not.toMatch(/\b(?:incrPageview|recordDistinct|PFADD|INCR)\b/);
    expect(script).toContain('export async function peopleLine(');
  });
});

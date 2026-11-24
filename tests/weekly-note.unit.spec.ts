import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIGEST_ISSUE,
  MAX_NEEDS,
  NOTE_ASSIGNEE,
  NOTE_LABEL,
  candidatesLine,
  digestBrowserCounts,
  formatPeopleWeek,
  mondayOf,
  needsBlock,
  needsColbyLines,
  nightlyLine,
  noteBody,
  noteTitle,
  peopleWeeks,
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
      'Visitors, last 7 days (bots included): 31,240 page loads. Different addresses a day: Sun 1,737 · Sat 1,802 (older days are not kept).'
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

  test('it only READS the counters, and fills the real-people line from them', () => {
    expect(script).toContain("import { PAGEVIEW_SURFACES, readPageviewWindow, readPeopleSignalsWindow } from '../lib/usage';");
    expect(script).toContain("import { readBrowserAddressCount, readDistinctAddressCount } from '../lib/ratelimit';");
    expect(script).not.toMatch(/\b(?:incrPageview|recordDistinct|recordBrowser|PFADD|INCR)\b/);
    expect(script).toContain('export async function peopleLine(');
  });
});

test.describe('the real-people line (#547\'s counts)', () => {
  // 14 UTC days, yesterday first, as trailingWindowDays(now, 14) gives them.
  const daysBack = (from: string, count = 14) =>
    Array.from({ length: count }, (_, i) => {
      const d = new Date(`${from}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - i);
      return d.toISOString().slice(0, 10);
    });
  // Day i's value from a 7-day pattern for this week (i 0–6) and last week (i 7–13).
  const series = (thisWeek: number[], lastWeek: number[]) => [...thisWeek, ...lastWeek];
  const pageviews = (home: number[], bill: number[], short: number[]) => ({
    ok: true as const,
    surfaces: { home, bill, short },
  });
  const signals = (home: number[], bill: number[], short: number[], repLookups: number[], scriptsServed: number[]) => ({
    ok: true as const,
    browserSurfaces: { home, bill, short },
    repLookups,
    scriptsServed,
  });

  // Two whole weeks: Dec 14's note reads Dec 13 back to Nov 30.
  const WHOLE = daysBack('2026-12-13');
  const sevens = (x: number) => Array(7).fill(x);
  const fullFixture = {
    days: WHOLE,
    // Page loads: this week 100 + 60 a day (short left out), last week 90 + 50.
    pageviews: pageviews(series(sevens(100), sevens(90)), series(sevens(60), sevens(50)), series(sevens(999), sevens(999))),
    // Browser loads: this week 40 + 20 a day (bots 100 of 160 = 63%), last week 40 + 19 (81 of 140 = 58%).
    signals: signals(
      series(sevens(40), sevens(40)),
      series(sevens(20), sevens(19)),
      series(sevens(999), sevens(999)),
      series([20, 20, 20, 20, 20, 10, 10], sevens(14)), // 120 vs 98
      series([6, 6, 6, 5, 5, 5, 5], [5, 5, 4, 4, 4, 4, 4]), // 38 vs 30
    ),
    browsers: series([41, 45, 38, 40, 42, 39, 42], [35, 35, 34, 36, 35, 35, 35]) as Array<number | null>,
    browsersRead: true,
  };

  test('a whole week beside a whole week: averages a day for browsers, sums for actions, bots by share', () => {
    const line = formatPeopleWeek(peopleWeeks(fullFixture));
    expect(line).toBe(
      'Real people, last 7 days (estimate): On an average day about 41 different browser addresses opened a page ' +
        '(last week 35, up 17%); a home or office network counts once. ' +
        '120 ZIP lookups found a district (last week 98, up 22%) and 38 call scripts were shown (last week 30, up 27%); those are actions, not people. ' +
        'Bots made 63% of page loads (last week 58%).'
    );
  });

  test('browser addresses are never summed into a weekly count', () => {
    const line = formatPeopleWeek(peopleWeeks(fullFixture));
    const weekSum = fullFixture.browsers.slice(0, 7).reduce((a, b) => a! + b!, 0);
    expect(line).not.toContain(String(weekSum)); // 287
    expect(line).toContain('average day');
  });

  test('the first whole week has no comparison, and says when the first one arrives', () => {
    // Dec 7's note reads Dec 6 back to Nov 23: this week whole, last week mostly before counting.
    const w = peopleWeeks({ ...fullFixture, days: daysBack('2026-12-06') });
    expect(w.status).toBe('ok');
    const line = formatPeopleWeek(w);
    expect(line).toMatch(/^Real people, last 7 days \(estimate; the first week-on-week comparison is in the Dec 14 note\):/);
    expect(line).not.toContain('last week');
  });

  test('a part week names its days and the Monday the first whole week arrives; nothing before Nov 25 is counted', () => {
    // Nov 30's note reads Nov 29 back to Nov 16; only Nov 25–29 are whole counted days.
    const days = daysBack('2026-11-29');
    const w = peopleWeeks({ ...fullFixture, days });
    if (w.status !== 'ok') throw new Error('expected ok');
    expect(w.thisWeek.days).toEqual(['2026-11-29', '2026-11-28', '2026-11-27', '2026-11-26', '2026-11-25']);
    expect(w.lastWeek).toBeNull();
    const line = formatPeopleWeek(w);
    expect(line).toMatch(/^Real people, Nov 25–Nov 29 only \(estimate; counting began Nov 24, the first full week is in the Dec 7 note\):/);
    // Five days: lookups 20×5 = 100, scripts 6+6+6+5+5 = 28, browsers mean of 41,45,38,40,42 = 41.
    expect(line).toContain('about 41 different browser');
    expect(line).toContain('100 ZIP lookups found a district and 28 call scripts were shown');
  });

  test('before any whole day: counting began, and when the first full week arrives', () => {
    const w = peopleWeeks({ ...fullFixture, days: daysBack('2026-11-24') });
    expect(formatPeopleWeek(w)).toBe('Real people (estimate): counting began Nov 24; the first full week is in the Dec 7 note.');
  });

  test('missing days for browsers say how many days the average is from; an unread source says so, never a zero', () => {
    const gappy = [null, 50, 40, null, null, null, 30, ...fullFixture.browsers.slice(7)];
    expect(formatPeopleWeek(peopleWeeks({ ...fullFixture, browsers: gappy }))).toContain(
      'about 40 different browser addresses opened a page (last week 35, up 14%), from the 3 of 7 days on record;'
    );
    const none = Array(14).fill(null);
    expect(formatPeopleWeek(peopleWeeks({ ...fullFixture, browsers: none, browsersRead: false }))).toContain(
      "Browser addresses a day couldn't be read."
    );
    expect(formatPeopleWeek(peopleWeeks({ ...fullFixture, browsers: none, browsersRead: true }))).toContain(
      'Browser addresses a day: none on record yet.'
    );
  });

  test('counters down: one plain line, no number; page loads down: bots\' share says so', () => {
    const unread = formatPeopleWeek(peopleWeeks({ ...fullFixture, signals: { ok: false } }));
    expect(unread).toBe("Real people (estimate): couldn't be read this week (the counters database couldn't be reached).");
    expect(unread).not.toMatch(/\d/);
    const noLoads = formatPeopleWeek(peopleWeeks({ ...fullFixture, pageviews: { ok: false } }));
    expect(noLoads).toContain("Bots' share of page loads couldn't be read.");
    expect(noLoads).toContain('120 ZIP lookups');
  });

  test('flat and from-zero comparisons read plainly', () => {
    const flat = {
      ...fullFixture,
      signals: { ...fullFixture.signals, repLookups: series(sevens(2), sevens(2)), scriptsServed: series(sevens(1), sevens(0)) },
    };
    const line = formatPeopleWeek(peopleWeeks(flat));
    expect(line).toContain('14 ZIP lookups found a district (last week 14, the same)');
    expect(line).toContain('7 call scripts were shown (last week 0)');
  });

  test("each day's browser figure is read from the digest's People row; \"not read\" rows have none; later comments win", () => {
    const comment = (day: string, browsers: string) =>
      [
        `<!-- daily-metrics:${day} -->`,
        `📊 Daily metrics — ${day}`,
        '```',
        'Distinct network addresses (bots included): 1802 (one site-wide estimate for the UTC day, ±~1%)',
        '',
        'People (estimate)',
        '  actions   12 / 3  ZIP lookups that found a district / call scripts shown (actions, not people)',
        `  browsers  ${browsers.padEnd(8)}distinct browser addresses (addresses that opened a page the way a browser does; not an upper bound)`,
        '  bots      62% of page loads (620 of 1000 did not look like a browser opening a page)',
        '```',
      ].join('\n');
    const got = digestBrowserCounts([
      { body: comment('2026-11-25', '30') },
      { body: comment('2026-11-26', 'not read') },
      { body: comment('2026-11-27', 'not recorded') },
      { body: comment('2026-11-25', '41') },
      { body: '<!-- daily-metrics:2026-11-22 -->\nan older digest with no People block' },
    ]);
    expect([...got.entries()]).toEqual([['2026-11-25', 41]]);
    expect(digestBrowserCounts(null).size).toBe(0);
    expect(DIGEST_ISSUE).toBe(81);
  });

  test('the script reads the digest as the workflow\'s own comments only, and the live sketch only for the days it still exists', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/weekly-note.mjs'), 'utf8');
    expect(script).toContain('select(.user.login == "github-actions[bot]")');
    expect(script).toContain('const SKETCH_READABLE_DAYS = 2;');
    expect(script).toContain('trailingWindowDays(now, 14)');
  });

  test('the whole note stays short with the people line in it', () => {
    const body = noteBody({
      needs: { status: 'ok', lines: [], url: null },
      visitors: 'Visitors: v.',
      people: formatPeopleWeek(peopleWeeks(fullFixture)),
      nightly: 'Nightly data: n.',
      candidates: 'Big Question candidates waiting: c.',
      spend: null,
    });
    expect(body.split('\n').length).toBeLessThanOrEqual(12);
    expect(body).not.toContain('@');
  });
});

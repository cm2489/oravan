import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// The rebuilt nickname search (owner's card 120, answered 2026-11-15): pure
// functions, no network, no key. NOTHING in the live newsdesk calls them yet;
// the last describe block pins that.
import {
  acronymRun,
  actNameForms,
  buildActNameIndex,
  matchActNames,
} from '../scripts/newsdesk-match.mjs';
import { runOffline } from '../scripts/act-name-offline.mjs';

const BILLS = [
  { slug: 'hr-29-119', title: 'Laken Riley Act', press_names: ['Laken Riley Act'] },
  { slug: 's-5-119', title: 'Laken Riley Act', press_names: ['Laken Riley Act'] },
  { slug: 's-4784-119', title: 'National Defense Authorization Act for Fiscal Year 2027', press_names: ['National Defense Authorization Act', 'NDAA'] },
  { slug: 'hr-3633-119', title: 'Digital Asset Market Clarity Act', press_names: ['Digital Asset Market Clarity Act', 'DAMC Act'], names: ['CLARITY Act'] },
  { slug: 's-3098-119', title: 'Presumptive CLARITY Act of 2025', press_names: ['Presumptive CLARITY Act'] },
  { slug: 'hr-22-119', title: 'SAVE Act', press_names: ['SAVE Act'] },
  { slug: 'hr-7296-119', title: 'SAVE America Act', press_names: ['SAVE America Act'] },
  { slug: 'hr-7757-119', title: 'KIDS Act', press_names: ['KIDS Act'] },
  { slug: 'hr-1702-119', title: 'JUDGES Act of 2025', press_names: ['JUDGES Act'] },
  { slug: 's-5653-119', title: 'Bipartisan American Affordability and Jobs Act of 2026', press_names: ['Bipartisan American Affordability and Jobs Act', 'BAAJ Act'] },
  { slug: 'hr-3838-119', title: 'Streamlining Procurement for Effective Execution and Delivery and National Defense Authorization Act for Fiscal Year 2026', press_names: ['National Defense Authorization Act for Fiscal Year 2026', 'NDAA', 'SPEED Act'] },
  { slug: 's-4472-119', title: 'Accelerating Access to Critical Therapies for ALS Reauthorization Act of 2026', press_names: ['ALS Reauthorization Act'] },
  { slug: 'hr-8205-119', title: 'Accelerating Access to Critical Therapies for ALS Reauthorization Act of 2026', press_names: null },
  { slug: 'hr-6020-119', title: 'To designate the facility of the United States Postal Service located at 14855 South Van Dyke Road in Plainfield, Illinois', press_names: null },
  { slug: 's-2976-119', title: 'HIRE Act', press_names: ['HIRE Act'] },
];
const INDEX = buildActNameIndex(BILLS);
const credited = (h: string) => matchActNames(h, INDEX).credited.map((c: { slug: string }) => c.slug);
const shared = (h: string) => matchActNames(h, INDEX).shared.map((s: { slugs: string[] }) => s.slugs);

test.describe('actNameForms: which titles are names', () => {
  test('a short title is a name, with and without its year', () => {
    expect(actNameForms('Laken Riley Act')).toEqual(['Laken Riley Act']);
    expect(actNameForms('PRO Veterans Act of 2025')).toEqual(['PRO Veterans Act', 'PRO Veterans Act of 2025']);
    expect(actNameForms('National Defense Authorization Act for Fiscal Year 2027')).toEqual([
      'National Defense Authorization Act',
      'National Defense Authorization Act for Fiscal Year 2027',
    ]);
    expect(actNameForms('Continuing Appropriations Act, 2027')).toEqual(['Continuing Appropriations Act', 'Continuing Appropriations Act, 2027']);
  });

  test('a long title is not a name', () => {
    expect(actNameForms('To amend title 10, United States Code, to extend the Act')).toEqual([]);
    expect(actNameForms('A joint resolution providing for congressional disapproval of the rule')).toEqual([]);
    expect(actNameForms('Reserved for the Speaker.')).toEqual([]);
    expect(actNameForms('Authorizing the use of Emancipation Hall for a ceremony under the Act')).toEqual([]);
  });

  test('acronymRun reads initials, skipping connectors', () => {
    expect(acronymRun('NDAA', 'National Defense Authorization Act')).toEqual({ start: 0, end: 4 });
    expect(acronymRun('SAVE', 'Safeguard American Voter Eligibility Act')).toEqual({ start: 0, end: 4 });
    expect(acronymRun('BAAJ', 'Bipartisan American Affordability and Jobs Act')).toEqual({ start: 0, end: 5 });
    expect(acronymRun('XYZ', 'National Defense Authorization Act')).toBeNull();
  });
});

test.describe('allowed forms', () => {
  test('the title, word for word, used as a name', () => {
    expect(credited('Senate passes the Major Richard Star Act')).toEqual([]); // not in this index
    expect(credited('Florida senator backs the SAVE Act')).toEqual(['hr-22-119']);
    expect(credited('Senate Fails to Advance Digital Asset Market Clarity Act in 49-50 Vote')).toEqual(['hr-3633-119']);
  });

  test('an owner-merged press name (data/press-names.json) is a name', () => {
    expect(credited('Crypto’s CLARITY Act Faces Its Last Shot in a Lame-Duck Push')).toEqual(['hr-3633-119']);
    expect(credited('Morning Minute: Democrat Sweep Pumps Crypto as Clarity Act Resurfaces')).toEqual(['hr-3633-119']);
  });

  test('a well-formed acronym the press names list: "SPEED Act", and "BAAJA" from a listed "BAAJ Act"', () => {
    expect(credited('House passes the SPEED Act')).toEqual(['hr-3838-119']);
    expect(credited('BAAJA permitting reform bill puts Trump at odds with his energy team')).toEqual(['s-5653-119']);
    expect(credited('Senators weigh the BAAJ Act')).toEqual(['s-5653-119']);
  });

  test('the longest name wins: "Presumptive CLARITY Act" is not the CLARITY Act', () => {
    expect(credited('Senator files the Presumptive CLARITY Act')).toEqual(['s-3098-119']);
    expect(credited('Trump pushes the SAVE America Act')).toEqual(['hr-7296-119']);
  });
});

test.describe('refused forms', () => {
  test('a single distinctive token, a topic word, a sponsor name', () => {
    expect(credited('Crypto spent $55 million defending a senator who already backed CLARITY')).toEqual([]);
    expect(credited('Riley family speaks at the Capitol about immigration')).toEqual([]);
    expect(credited('Defense bill talks stall in the Senate')).toEqual([]);
    expect(credited('Moreno bill on outsourcing worries India')).toEqual([]);
  });

  test('a long title is never a name, and a stored press name cut from inside a title is not either', () => {
    expect(credited('Plainfield post office renamed')).toEqual([]);
    expect(credited('President Signs ALS Reauthorization Act into Law')).toEqual([]);
    expect(INDEX.refused).toContainEqual(expect.objectContaining({ slug: 's-4472-119', press_name: 'ALS Reauthorization Act' }));
  });

  test('"act" as a verb or noun is not a name', () => {
    expect(credited('lawmakers say they must save act of Congress')).toEqual([]);
    expect(credited('Retired Judges Act to Protect the Rule of Law')).toEqual([]);
  });

  test('the tail of a longer name is not the name: "PROTECT Kids Act" is not the KIDS Act', () => {
    expect(credited('Only Eight House Democrats Voted for the ‘PROTECT Kids Act’')).toEqual([]);
    expect(credited('The House Passed The KIDS Act—The Senate Should Reject It')).toEqual(['hr-7757-119']);
  });

  test('a translated name is not the record’s name', () => {
    expect(credited('El Senado aprueba la Ley Laken Riley')).toEqual([]);
    expect(shared('El Senado aprueba la Ley Laken Riley')).toEqual([]);
  });
});

test.describe('an acronym that is also an ordinary word', () => {
  test('"SAVE" counts only with "Act" after it', () => {
    expect(credited('Voters want to SAVE the filibuster')).toEqual([]);
    expect(credited('Latino voters want the SAVE Act')).toEqual(['hr-22-119']);
  });

  test('a two-word name in title case right after another capital is refused unless quoted', () => {
    expect(credited('Senate Debates Save Act Again')).toEqual([]);
    expect(credited('Senators debate the Save Act again')).toEqual(['hr-22-119']);
    expect(credited('Senate Debates ‘Save Act’ Again')).toEqual(['hr-22-119']);
    expect(credited('US Hire Act A Big Concern For Indian Outsourcing Industry')).toEqual([]);
    expect(credited('Raghuram Rajan Sees US HIRE Act As India’s Big Worry')).toEqual(['s-2976-119']);
  });

  test('a bare acronym needs four capitals and must stand for "Act" too', () => {
    // NDAA = National Defense Authorization Act: four letters, the last is "Act".
    expect(shared('Twelve Senators Call For US-Israel Military Integration To Be Removed From NDAA')).toEqual([
      ['hr-3838-119', 's-4784-119'],
    ]);
    // HIRE stands for the words before "Act", so bare HIRE is not a name.
    expect(credited('If HIRE Bill In US Becomes Reality')).toEqual([]);
    expect(credited('Lawmakers back ndaa changes')).toEqual([]);
  });
});

test.describe('shared names are credited to no bill', () => {
  test('a House bill and its Senate twin share "Laken Riley Act"', () => {
    const r = matchActNames('BREAKING: Laken Riley Act Signed by Speaker Johnson', INDEX);
    expect(r.credited).toEqual([]);
    expect(r.shared).toEqual([{ name: 'Laken Riley Act', form: 'name', slugs: ['hr-29-119', 's-5-119'] }]);
  });

  test('two bills with the same title share every name, even a press name only one lists', () => {
    const idx = buildActNameIndex([
      { slug: 'hr-1-119', title: 'Fix Our Forests Act', press_names: ['FOFA'] },
      { slug: 's-1-119', title: 'Fix Our Forests Act', press_names: [] },
    ]);
    expect(matchActNames('Congress Must Pass Fix Our Forests Act', idx).shared[0].slugs).toEqual(['hr-1-119', 's-1-119']);
    expect(matchActNames('Wildfire groups back FOFA', idx).shared[0].slugs).toEqual(['hr-1-119', 's-1-119']);
  });

  test('a record short title passed as `names` is a name like the title, and can make a name shared', () => {
    const idx = buildActNameIndex([
      { slug: 'hr-2-119', title: 'One Big Beautiful Bill Act', names: ['One Big Beautiful Bill Act'] },
      { slug: 'hr-9-119', title: 'To provide for reconciliation pursuant to title II', names: ['One Big Beautiful Bill Act'] },
    ]);
    expect(matchActNames('Senate passes One Big Beautiful Bill Act', idx)).toEqual({
      credited: [],
      shared: [{ name: 'One Big Beautiful Bill Act', form: 'name', slugs: ['hr-2-119', 'hr-9-119'] }],
    });
  });
});

test.describe('punctuation and capitals', () => {
  test('curly quotes, possessives, colons and all-caps headlines', () => {
    expect(credited('“SAVE Act” heads to the Senate')).toEqual(['hr-22-119']);
    expect(credited("The SAVE Act's math problem")).toEqual(['hr-22-119']);
    expect(credited("USA's SAVE America Act explained")).toEqual(['hr-7296-119']);
    expect(credited('SENATE PASSES DIGITAL ASSET MARKET CLARITY ACT')).toEqual(['hr-3633-119']);
  });

  test('a Spanish headline that prints the record’s name or acronym matches it', () => {
    expect(credited('La Cámara aprueba la SAVE Act sobre el voto')).toEqual(['hr-22-119']);
    expect(shared('Senadores piden cambios en la NDAA')).toEqual([['hr-3838-119', 's-4784-119']]);
  });
});

test.describe('the offline two-week run (tests/fixtures/nickname-search)', () => {
  const dir = join(process.cwd(), 'tests', 'fixtures', 'nickname-search');
  const load = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const run = runOffline({ headlines: load('headlines.json'), bills: load('bills.json'), pressNames: load('press-names.json') });

  test('90 headlines published Nov 3 to Nov 16, 2026', () => {
    expect(run.headlines).toBe(90);
    const dates = run.rows.map((r: { date: string }) => r.date).sort();
    expect([dates[0], dates[dates.length - 1]]).toEqual(['2026-11-03', '2026-11-16']);
  });

  test('the current bridge, resolved against the corpus, matches one headline', () => {
    const old = run.rows.flatMap((r) => (r.old ? [[r.title, r.old.slug]] : []));
    expect(old).toEqual([
      ['Major Richard Star Act Passes House', 'hr-2102-119'],
    ]);
  });

  test('the rebuilt matcher credits ten headlines and holds four as shared', () => {
    const got = run.rows
      .filter((r: { rebuilt: { credited: unknown[] } }) => r.rebuilt.credited.length)
      .map((r: { title: string; rebuilt: { credited: { slug: string; name: string }[] } }) => [r.title, r.rebuilt.credited.map((c) => `${c.slug} ${c.name}`)]);
    expect(got).toEqual([
      ['Crypto’s CLARITY Act Faces Its Last Shot in a Lame-Duck Push', ['hr-3633-119 CLARITY Act']],
      ['Democrats reportedly seek greater SEC control over crypto after CLARITY Act collapse', ['hr-3633-119 CLARITY Act']],
      ['Morning Minute: Democrat Sweep Pumps Crypto as Clarity Act Resurfaces', ['hr-3633-119 Clarity Act']],
      ['Scaramucci Blames Trump’s Memecoins for CLARITY Act Setback', ['hr-3633-119 CLARITY Act']],
      ['Jamie Dimon said on CLARITY Act allowing yield-paying stablecoins that JP Morgan will fight it, if we lose, we lose; here\'s how Democrat win means end of ...', ['hr-3633-119 CLARITY Act']],
      ['What the 2026 US Midterms Mean for the CLARITY Act', ['hr-3633-119 CLARITY Act']],
      ['Clarity Act Faces Rewrite but Retains Bipartisan Opening', ['hr-3633-119 Clarity Act']],
      ['BAAJA permitting reform bill puts Trump at odds with his energy team', ['s-5653-119 BAAJA']],
      ['Florida Passes Its Own SAVE Act', ['hr-22-119 SAVE Act']],
      ['Major Richard Star Act Passes House', ['hr-2102-119 Major Richard Star Act']],
    ]);
    expect(run.rebuilt_shared_only).toBe(4);
  });
});

test.describe('the live newsdesk is unchanged', () => {
  test('scripts/newsdesk.mjs still runs the old bridge and never the rebuilt matcher', () => {
    const src = readFileSync(join(process.cwd(), 'scripts', 'newsdesk.mjs'), 'utf8');
    expect(src).toMatch(/matchNickname\(extractNicknameTokens\(headlineForMatching\(it\.title, it\.link\)\), listIndex\)/);
    expect(src).not.toMatch(/matchActNames|buildActNameIndex|act-name-offline/);
  });
});

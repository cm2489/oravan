"""End-to-end tests for scripts/process-data.py: the real script, run as a
subprocess on fixture files in a temporary directory, offline (no
--download). Covers the wiring the unit tests of member_turnover.py and
vacancy_diff.py cannot: that nothing is written when a check fails, that the
historical member file is read for departures, that --today and
--accept-departures reach the checks, and that a refusal writes its report.

Stdlib-only, like the other two - run with:
    cd scripts && python3 -m unittest test_process_data -v

Every roster is synthetic; nothing under data/ is read or written.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
ORDINARY_DAY = '2026-11-16'
SWITCH_DAY = '2027-01-04'
TERM_END = date(2027, 1, 3).isoformat()
STATES = [
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY',
    'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND',
    'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]


def raw_member(bioguide, mtype, state, district=None, start=date(2025, 1, 3).isoformat()):
    term = {'type': mtype, 'state': state, 'party': 'Independent', 'phone': '202-225-0000',
            'url': 'https://example.gov', 'start': start, 'end': TERM_END}
    if mtype == 'rep':
        term['district'] = district
    rec = {'id': {'bioguide': bioguide}, 'name': {'first': 'F', 'last': bioguide, 'official_full': f'Member {bioguide}'},
           'terms': [term]}
    if mtype == 'sen':
        rec['id']['lis'] = 'S' + bioguide[-3:]
    return rec


def roster():
    """A complete file: 100 senators and 435 House seats (the refresh refuses
    a file of fewer than 500 members as broken, so a fixture must be whole)."""
    out, n = [], 0
    for s in STATES:
        for _ in range(2):
            n += 1
            out.append(raw_member(f'S{n:06d}', 'sen', s))
    for i in range(435):
        n += 1
        out.append(raw_member(f'H{n:06d}', 'rep', STATES[i % 50], i // 50 + 1))
    return out


def as_committed(raw):
    """data/legislators.json as process-data.py itself writes it."""
    out = []
    for l in raw:
        t = l['terms'][-1]
        e = {'bioguide': l['id']['bioguide'], 'name': l['name']['official_full'], 'first': l['name']['first'],
             'last': l['name']['last'], 'type': t['type'], 'state': t['state'], 'district': t.get('district'),
             'party': t['party'], 'phone': t['phone'], 'url': t['url'], 'offices': []}
        if t['type'] == 'sen':
            e['lis'] = l['id']['lis']
        out.append(e)
    return out


class Run:
    def __init__(self, prev_raw, new_raw, historical=None, departed=None, vacancies=None, official=None):
        self.dir = tempfile.mkdtemp(prefix='oravan-process-data-')
        os.makedirs(f'{self.dir}/data')
        os.makedirs(f'{self.dir}/scripts')
        for f in ('process-data.py', 'vacancy_diff.py', 'member_turnover.py', 'member_entry.py'):
            shutil.copy(os.path.join(HERE, f), f'{self.dir}/scripts/{f}')
        self.write('legislators.json', as_committed(prev_raw), compact=True)
        self.write('vacancies.json', vacancies or [])
        self.write('departed-members.json', departed or [])
        if official is not None:
            self.write('departure-dates.json', official)
        self.write('legislators-raw.json', new_raw)
        self.write('district-offices-raw.json', [])
        if historical is not None:
            self.write('legislators-historical-raw.json', historical)
        with open(f'{self.dir}/data/zccd.csv', 'w') as f:
            f.write('state_fips,state_abbr,zcta,cd\n01,AL,35004,1\n')
        self.before = {n: self.read_bytes(n) for n in ('legislators.json', 'vacancies.json', 'departed-members.json')}

    def write(self, name, obj, compact=False):
        with open(f'{self.dir}/data/{name}', 'w') as f:
            json.dump(obj, f, ensure_ascii=False, **({} if compact else {'indent': 2}))

    def read_bytes(self, name):
        p = f'{self.dir}/data/{name}'
        if not os.path.exists(p):
            return None
        with open(p, 'rb') as f:
            return f.read()

    def read(self, name):
        with open(f'{self.dir}/data/{name}') as f:
            return json.load(f)

    def go(self, *args):
        env = {k: v for k, v in os.environ.items()
               if k not in ('GITHUB_OUTPUT', 'REFUSAL_REPORT', 'UNCONFIRMED_REPORT', 'GITHUB_STEP_SUMMARY')}
        env['REFUSAL_REPORT'] = f'{self.dir}/refusal.md'
        env['UNCONFIRMED_REPORT'] = f'{self.dir}/unconfirmed.md'
        env['GITHUB_STEP_SUMMARY'] = f'{self.dir}/summary.md'
        p = subprocess.run([sys.executable, 'scripts/process-data.py', *args], cwd=self.dir, env=env,
                           capture_output=True, text=True, timeout=60)
        self.code, self.out = p.returncode, p.stdout + p.stderr
        return self

    def untouched(self):
        return all(self.read_bytes(n) == b for n, b in self.before.items()) and self.read_bytes('zip-districts.json') is None

    def report(self, name='refusal.md'):
        p = f'{self.dir}/{name}'
        if not os.path.exists(p):
            return None
        with open(p) as f:
            return f.read()

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)


def replace(raw, count, prefix='N'):
    """`count` House members replaced by new people on the same seats."""
    out, gone = [], []
    for l in raw:
        if l['terms'][-1]['type'] == 'rep' and len(gone) < count:
            gone.append(l)
            n = json.loads(json.dumps(l))
            n['id'] = {'bioguide': f'{prefix}{len(gone):06d}'}
            out.append(n)
        else:
            out.append(l)
    return out, gone


class ProcessDataEndToEnd(unittest.TestCase):
    def setUp(self):
        self.runs = []

    def tearDown(self):
        for r in self.runs:
            r.close()

    def run_(self, *a, **k):
        r = Run(*a, **k)
        self.runs.append(r)
        return r

    def test_an_ordinary_week_writes_the_same_roster_and_no_departed_record(self):
        raw = roster()
        r = self.run_(raw, raw).go('--today', ORDINARY_DAY)
        self.assertEqual(r.code, 0, r.out)
        self.assertEqual(r.read_bytes('legislators.json'), r.before['legislators.json'])
        self.assertEqual(r.read('departed-members.json'), [])
        self.assertIsNone(r.report())
        self.assertNotIn('departed-members.json', r.out)

    def test_the_switch_week_keeps_records_with_the_historical_end_date(self):
        prev = roster()
        new, gone = replace(prev, 8)
        r = self.run_(prev, new, historical=gone).go('--today', SWITCH_DAY)
        self.assertEqual(r.code, 0, r.out)
        departed = r.read('departed-members.json')
        self.assertEqual(sorted(d['bioguide'] for d in departed), sorted(g['id']['bioguide'] for g in gone))
        self.assertEqual({d['served_until'] for d in departed}, {TERM_END})
        self.assertEqual({d['left_file'] for d in departed}, {SWITCH_DAY})
        for d in departed:
            for k in ('phone', 'url', 'offices', 'lis'):
                self.assertNotIn(k, d)
        self.assertEqual(r.read('vacancies.json'), [])
        self.assertIn('departed-members.json: 8 member(s) kept as a record, 8 left the file this run', r.out)

    def test_without_the_historical_file_the_date_stays_null_and_says_so(self):
        prev = roster()
        new, _ = replace(prev, 2)
        r = self.run_(prev, new).go('--today', ORDINARY_DAY)
        self.assertEqual(r.code, 0, r.out)
        self.assertEqual({d['served_until'] for d in r.read('departed-members.json')}, {None})
        # The week they leave, the new line (and the issue report) says so.
        self.assertIn('gives no last day for them yet', r.out)
        self.assertNotIn('legislators-historical gives no end date yet', r.out)

    def test_a_refused_week_writes_nothing_and_writes_the_report(self):
        prev = roster()
        new, gone = replace(prev, 7)
        r = self.run_(prev, new, historical=gone).go('--today', ORDINARY_DAY)
        self.assertEqual(r.code, 1, r.out)
        self.assertTrue(r.untouched(), 'a refused run must leave every data/ file as committed')
        self.assertIn('7 member(s) left the file', r.out)
        self.assertIn('accept_departures=7', r.report())

    def test_the_exact_accept_count_passes_once_and_a_wrong_one_does_not(self):
        prev = roster()
        new, gone = replace(prev, 7)
        wrong = self.run_(prev, new, historical=gone).go('--today', ORDINARY_DAY, '--accept-departures', '6')
        self.assertEqual(wrong.code, 1, wrong.out)
        self.assertTrue(wrong.untouched())
        ok = self.run_(prev, new, historical=gone).go('--today', ORDINARY_DAY, '--accept-departures', '7')
        self.assertEqual(ok.code, 0, ok.out)
        self.assertEqual(len(ok.read('departed-members.json')), 7)
        self.assertIn('accept_departures=7: accepted', ok.out)

    def test_accepted_departures_that_empty_their_seats_are_recorded_as_vacancies(self):
        prev = roster()
        gone = [l for l in prev if l['terms'][-1]['type'] == 'rep'][:6]
        new = [l for l in prev if l not in gone]
        refused = self.run_(prev, new, historical=gone).go('--today', ORDINARY_DAY)
        self.assertEqual(refused.code, 1, refused.out)
        self.assertTrue(refused.untouched())
        ok = self.run_(prev, new, historical=gone).go('--today', ORDINARY_DAY, '--accept-departures', '6')
        self.assertEqual(ok.code, 0, ok.out)
        self.assertEqual(len(ok.read('vacancies.json')), 6)
        self.assertEqual({v['since'] for v in ok.read('vacancies.json')}, {ORDINARY_DAY})

    def test_a_duplicate_member_is_refused_and_no_number_accepts_it(self):
        prev = roster()
        new = prev + [prev[3]]
        for extra in ((), ('--accept-departures', '1')):
            r = self.run_(prev, new).go('--today', ORDINARY_DAY, *extra)
            self.assertEqual(r.code, 1, r.out)
            self.assertTrue(r.untouched())
            self.assertIn('listed more than once', r.out)

    def test_a_bad_accept_value_stops_with_one_line_before_anything(self):
        raw = roster()
        for bad in ('all', '0', 'abc', '-1'):
            r = self.run_(raw, raw).go('--today', ORDINARY_DAY, '--accept-departures', bad)
            self.assertEqual(r.code, 2, (bad, r.out))
            self.assertTrue(r.untouched(), bad)
            self.assertNotIn('Traceback', r.out, bad)
            self.assertEqual(r.out.strip().count('\n'), 0, (bad, r.out))
            self.assertTrue(r.out.startswith('::error::'), (bad, r.out))
        r = self.run_(raw, raw).go('--today', ORDINARY_DAY, '--accept-departures')
        self.assertEqual(r.code, 2, r.out)
        self.assertNotIn('Traceback', r.out)

    def test_an_empty_upstream_file_is_refused_and_its_accept_number_is_refused_too(self):
        # The re-check's case: the report must not offer accept_departures=535,
        # and running with it must not write an empty member file.
        prev = roster()
        r = self.run_(prev, []).go('--today', ORDINARY_DAY)
        self.assertEqual(r.code, 1, r.out)
        self.assertTrue(r.untouched())
        self.assertIn('Accept nothing', r.report())
        self.assertNotIn('accept_departures=', r.report())
        forced = self.run_(prev, []).go('--today', ORDINARY_DAY, '--accept-departures', str(len(prev)))
        self.assertEqual(forced.code, 1, forced.out)
        self.assertTrue(forced.untouched())
        jan = self.run_(prev, []).go('--today', SWITCH_DAY, '--accept-departures', str(len(prev)))
        self.assertEqual(jan.code, 1, jan.out)
        self.assertTrue(jan.untouched())

    def test_a_badly_short_file_is_refused_in_january_too(self):
        prev = roster()
        short = prev[:300]
        r = self.run_(prev, short).go('--today', SWITCH_DAY)
        self.assertEqual(r.code, 1, r.out)
        self.assertTrue(r.untouched())
        self.assertIn('looks broken', r.out)
        # The House-seat error says nothing about accepting a broken file.
        self.assertIn('House seat(s) vanished', r.out)
        self.assertNotIn('re-run with the accept_departures', r.out)

    def test_a_499_member_file_is_refused_with_any_number(self):
        prev = roster()
        short = prev[:499]
        for day in (SWITCH_DAY, ORDINARY_DAY):
            for extra in ((), ('--accept-departures', str(len(prev) - 499)), ('--accept-departures', '1')):
                r = self.run_(prev, short).go('--today', day, *extra)
                self.assertEqual(r.code, 1, (day, extra, r.out))
                self.assertTrue(r.untouched(), (day, extra))
                self.assertIn('Accept nothing', r.report())

    def test_eighty_departures_after_the_window_or_in_november_are_accepted_with_exactly_eighty(self):
        # Second review (2026-11-13): a change of Congress committed late, after
        # Feb 13, must stay acceptable with the exact number, as on main.
        prev = roster()
        new, gone = replace(prev, 80)
        for day in ('2027-02-14', ORDINARY_DAY):
            refused = self.run_(prev, new, historical=gone).go('--today', day)
            self.assertEqual(refused.code, 1, (day, refused.out))
            self.assertTrue(refused.untouched())
            self.assertIn('accept_departures=80', refused.report())
            for wrong in ('79', '81'):
                r = self.run_(prev, new, historical=gone).go('--today', day, '--accept-departures', wrong)
                self.assertEqual(r.code, 1, (day, wrong, r.out))
                self.assertTrue(r.untouched())
            ok = self.run_(prev, new, historical=gone).go('--today', day, '--accept-departures', '80')
            self.assertEqual(ok.code, 0, (day, ok.out))
            self.assertEqual(len(ok.read('departed-members.json')), 80)
            self.assertEqual(len(ok.read('legislators.json')), len(prev))


CLERK = 'https://clerk.house.gov/Members/ViewVacancies'


def official_entry(bioguide, day, kind='house-clerk'):
    url = CLERK if kind == 'house-clerk' else f'https://bioguide.congress.gov/search/bio/{bioguide}'
    return {'bioguide': bioguide, 'served_until': day, 'source': {'kind': kind, 'url': url, 'read': '2026-11-13'}}


class UnconfirmedDeparture(unittest.TestCase):
    """A NEW mid-term departure is recorded with the volunteer file's date and
    no source, so it gets no record page until a person confirms the date
    (hard rule 6). The change of Congress is told apart by its date."""

    def setUp(self):
        self.runs = []

    def tearDown(self):
        for r in self.runs:
            r.close()

    def run_(self, *a, **k):
        r = Run(*a, **k)
        self.runs.append(r)
        return r

    def left_one(self, end):
        prev = roster()
        new, gone = replace(prev, 1)
        gone = [json.loads(json.dumps(g)) for g in gone]
        gone[0]['terms'][-1]['end'] = end
        return prev, new, gone

    def test_a_new_mid_term_departure_is_unconfirmed_logged_and_reported(self):
        prev, new, gone = self.left_one('2026-11-10')
        b = gone[0]['id']['bioguide']
        r = self.run_(prev, new, historical=gone, official=[]).go('--today', ORDINARY_DAY)
        self.assertEqual(r.code, 0, r.out)
        rec = r.read('departed-members.json')[0]
        self.assertEqual((rec['bioguide'], rec['served_until'], rec['served_until_source']), (b, '2026-11-10', None))
        lines = [l for l in r.out.splitlines() if 'not yet confirmed' in l]
        self.assertEqual(len(lines), 1, r.out)
        self.assertIn(b, lines[0])
        self.assertIn('2026-11-10', lines[0])
        self.assertIn(b, r.report('summary.md'))
        body = r.report('unconfirmed.md')
        for want in (b, '2026-11-10', CLERK, 'https://bioguide.congress.gov/search/bio/'):
            self.assertIn(want, body)

    def test_an_official_date_makes_it_confirmed_with_no_issue(self):
        prev, new, gone = self.left_one('2026-11-10')
        b = gone[0]['id']['bioguide']
        r = self.run_(prev, new, historical=gone, official=[official_entry(b, '2026-11-11')]).go('--today', ORDINARY_DAY)
        self.assertEqual(r.code, 0, r.out)
        rec = r.read('departed-members.json')[0]
        self.assertEqual(rec['served_until'], '2026-11-11')
        self.assertEqual(rec['served_until_source']['kind'], 'house-clerk')
        self.assertNotIn('not yet confirmed', r.out)
        self.assertIsNone(r.report('unconfirmed.md'))

    def test_a_pull_request_that_adds_the_date_confirms_a_kept_record(self):
        prev, new, gone = self.left_one('2026-11-10')
        b = gone[0]['id']['bioguide']
        first = self.run_(prev, new, historical=gone, official=[]).go('--today', ORDINARY_DAY)
        kept = first.read('departed-members.json')
        # The refresh reads the historical file to check the entry fits.
        later = self.run_(new, new, historical=gone, departed=kept, official=[official_entry(b, '2026-11-11')]).go('--today', '2026-11-23')
        self.assertEqual(later.code, 0, later.out)
        rec = later.read('departed-members.json')[0]
        self.assertEqual((rec['served_until'], rec['served_until_source']['kind'], rec['left_file']),
                         ('2026-11-11', 'house-clerk', ORDINARY_DAY))
        self.assertNotIn('not yet confirmed', later.out)

    def test_the_change_of_congress_is_never_reported_unconfirmed(self):
        prev = roster()
        new, gone = replace(prev, 8)
        r = self.run_(prev, new, historical=gone, official=[]).go('--today', SWITCH_DAY)
        self.assertEqual(r.code, 0, r.out)
        recs = r.read('departed-members.json')
        self.assertEqual({x['served_until'] for x in recs}, {TERM_END})
        self.assertEqual({x['served_until_source'] for x in recs}, {None})
        self.assertNotIn('not yet confirmed', r.out)
        self.assertIsNone(r.report('unconfirmed.md'))

    def test_a_malformed_table_entry_never_fails_the_week_and_is_reported(self):
        # 3rd review: a bad entry in our own table must not stop the weekly
        # refresh (it used to raise, or refuse with advice to wait for upstream).
        prev, new, gone = self.left_one('2026-11-10')
        b = gone[0]['id']['bioguide']
        for bad in (
            [{'bioguide': b, 'served_until': '2026-11-10', 'source': {'kind': 'news', 'url': 'x', 'read': 'x'}}],
            [official_entry(b, '2026-02-30')],
            [{'bioguide': b}],
            [official_entry(b, '2026-11-10'), official_entry(b, '2026-11-11')],
            ['oops'],
            {'not': 'a list'},
        ):
            r = self.run_(prev, new, historical=gone, official=bad).go('--today', ORDINARY_DAY)
            self.assertEqual(r.code, 0, (bad, r.out))
            self.assertNotIn('Traceback', r.out)
            rec = r.read('departed-members.json')[0]
            self.assertIsNone(rec['served_until_source'], bad)  # not applied: no page
            body = r.report('unconfirmed.md')
            self.assertIn('A malformed entry in data/departure-dates.json', body, bad)
            self.assertIn('Fix `data/departure-dates.json`', body)
            self.assertNotIn('wait for it to be fixed', body)
            self.assertIsNone(r.report('refusal.md'))

    def test_a_table_that_is_not_json_never_fails_the_week(self):
        prev, new, gone = self.left_one('2026-11-10')
        r = Run(prev, new, historical=gone, official=[])
        self.runs.append(r)
        with open(f'{r.dir}/data/departure-dates.json', 'w') as f:
            f.write('[{"bioguide": ')
        r.go('--today', ORDINARY_DAY)
        self.assertEqual(r.code, 0, r.out)
        self.assertIn('could not be read as JSON', r.report('unconfirmed.md'))

    def test_a_member_who_left_on_dec_7_with_the_scheduled_jan_3_end_is_reported(self):
        # 3rd review: the historical file still shows the scheduled term end
        # for someone who left the member file on Dec 7, 2026. That is a
        # mid-term departure with an unconfirmed day, not the changeover.
        prev, new, gone = self.left_one(TERM_END)
        b = gone[0]['id']['bioguide']
        r = self.run_(prev, new, historical=gone, official=[]).go('--today', '2026-12-07')
        self.assertEqual(r.code, 0, r.out)
        rec = r.read('departed-members.json')[0]
        self.assertEqual((rec['served_until'], rec['served_until_source'], rec['left_file']), (TERM_END, None, '2026-12-07'))
        self.assertIn(b, r.report('unconfirmed.md'))
        self.assertIn('Date known from the historical file only', r.report('unconfirmed.md'))

    def test_the_override_applies_a_deliberately_recorded_official_day(self):
        prev, new, gone = self.left_one(TERM_END)
        b = gone[0]['id']['bioguide']
        plain = self.run_(prev, new, historical=gone, official=[official_entry(b, '2026-12-05')]).go('--today', '2026-12-07')
        self.assertIsNone(plain.read('departed-members.json')[0]['served_until_source'])
        body = plain.report('unconfirmed.md')
        self.assertIn('deliberate override', body)
        self.assertNotIn('overrides_file_day', body)
        entry = dict(official_entry(b, '2026-12-05'), overrides_file_day=TERM_END)
        r = self.run_(prev, new, historical=gone, official=[entry]).go('--today', '2026-12-07')
        self.assertEqual(r.code, 0, r.out)
        rec = r.read('departed-members.json')[0]
        self.assertEqual((rec['served_until'], rec['served_until_source']['kind']), ('2026-12-05', 'house-clerk'))
        self.assertIsNone(r.report('unconfirmed.md'))


class WhatReachesAPerson(unittest.TestCase):
    """Second review of #495 (2026-11-13): every mid-term departure whose day
    is not official reaches a person, at most one issue (the workflow comments
    on the one open issue each time a report is written)."""

    def setUp(self):
        self.runs = []

    def tearDown(self):
        for r in self.runs:
            r.close()

    def run_(self, *a, **k):
        r = Run(*a, **k)
        self.runs.append(r)
        return r

    def two_leave(self):
        prev = roster()
        new, gone = replace(prev, 2)
        return prev, new, [json.loads(json.dumps(g)) for g in gone]

    def test_the_date_arrives_a_week_late(self):
        prev, new, gone = self.two_leave()
        b = gone[0]['id']['bioguide']
        gone[0]['terms'][-1]['end'] = '2026-11-10'
        # Week 1: the historical file does not list them yet.
        w1 = self.run_(prev, new[:], historical=[gone[1]], official=[]).go('--today', ORDINARY_DAY)
        self.assertEqual(w1.code, 0, w1.out)
        rec1 = next(x for x in w1.read('departed-members.json') if x['bioguide'] == b)
        self.assertIsNone(rec1['served_until'])
        self.assertIn('Left, and no date known yet', w1.report('unconfirmed.md'))
        self.assertIn(b, w1.report('unconfirmed.md'))
        # Week 2: it lists them now. The day is filled, unconfirmed, and reported.
        w2 = self.run_(new, new, historical=gone, departed=w1.read('departed-members.json'), official=[]).go('--today', '2026-11-23')
        self.assertEqual(w2.code, 0, w2.out)
        rec2 = next(x for x in w2.read('departed-members.json') if x['bioguide'] == b)
        self.assertEqual((rec2['served_until'], rec2['served_until_source'], rec2['left_file']), ('2026-11-10', None, ORDINARY_DAY))
        body = w2.report('unconfirmed.md')
        self.assertIn('Date known from the historical file only', body)
        self.assertIn(b, body)
        self.assertIn('2026-11-10', body)
        self.assertEqual(sum('not yet confirmed' in l for l in w2.out.splitlines()), 1, w2.out)

    def test_the_date_never_arrives_for_three_weeks_one_report_not_three(self):
        prev, new, gone = self.two_leave()
        b = gone[0]['id']['bioguide']
        hist = [gone[1]]  # never lists b
        gone[1]['terms'][-1]['end'] = '2026-11-12'
        w1 = self.run_(prev, new, historical=hist, official=[]).go('--today', ORDINARY_DAY)
        self.assertEqual(w1.code, 0, w1.out)
        self.assertIn(b, w1.report('unconfirmed.md'))  # week 1: the issue is opened (or commented)
        kept = w1.read('departed-members.json')
        for week in ('2026-11-23', '2026-11-30'):
            w = self.run_(new, new, historical=hist, departed=kept, official=[]).go('--today', week)
            self.assertEqual(w.code, 0, w.out)
            self.assertIsNone(w.report('unconfirmed.md'), week)  # weeks 2 and 3: no issue comment
            self.assertIn(f'{b} left the member file but legislators-historical gives no end date yet', w.out)
            self.assertNotIn('gives no last day for them yet', w.out)
            self.assertEqual(w.read('departed-members.json'), kept)
            kept = w.read('departed-members.json')

    def test_two_members_one_dated_one_not(self):
        prev, new, gone = self.two_leave()
        dated, undated = gone[1]['id']['bioguide'], gone[0]['id']['bioguide']
        gone[1]['terms'][-1]['end'] = '2026-11-12'
        r = self.run_(prev, new, historical=[gone[1]], official=[]).go('--today', ORDINARY_DAY)
        self.assertEqual(r.code, 0, r.out)
        body = r.report('unconfirmed.md')
        self.assertIn('Left, and no date known yet', body)
        self.assertIn('Date known from the historical file only', body)
        self.assertIn(dated, body.split('## Date known')[1])
        self.assertIn(undated, body.split('## Date known')[0])
        self.assertEqual(len([l for l in r.out.splitlines() if l.startswith('::warning::') and (dated in l or undated in l)]), 2)

    def test_an_entry_more_than_a_day_off_is_not_applied_and_is_reported(self):
        prev, new, gone = self.two_leave()
        b = gone[0]['id']['bioguide']
        gone[0]['terms'][-1]['end'] = '2026-11-10'
        gone[1]['terms'][-1]['end'] = '2026-11-12'
        r = self.run_(prev, new, historical=gone, official=[official_entry(b, '2026-11-13')]).go('--today', ORDINARY_DAY)
        self.assertEqual(r.code, 0, r.out)
        rec = next(x for x in r.read('departed-members.json') if x['bioguide'] == b)
        self.assertEqual((rec['served_until'], rec['served_until_source']), ('2026-11-10', None))  # no page
        body = r.report('unconfirmed.md')
        self.assertIn('A table entry that does not fit', body)
        self.assertIn('3 days apart', body)

    def test_an_old_entry_is_not_reused_when_a_returning_member_leaves_again(self):
        prev, new, gone = self.two_leave()
        b = gone[0]['id']['bioguide']
        gone[0]['terms'][-1]['start'] = '2026-06-02'  # returned in a special election
        gone[0]['terms'][-1]['end'] = '2026-11-10'
        gone[1]['terms'][-1]['end'] = '2026-11-12'
        old = official_entry(b, '2025-03-05')  # written for their earlier departure
        r = self.run_(prev, new, historical=gone, official=[old]).go('--today', ORDINARY_DAY)
        self.assertEqual(r.code, 0, r.out)
        rec = next(x for x in r.read('departed-members.json') if x['bioguide'] == b)
        self.assertEqual((rec['served_until'], rec['served_until_source']), ('2026-11-10', None))
        self.assertIn('belongs to an earlier departure', r.report('unconfirmed.md'))

    def test_an_entry_for_a_sitting_member_is_reported_not_applied(self):
        prev = roster()
        sitting = as_committed(prev)[3]['bioguide']
        r = self.run_(prev, prev, official=[official_entry(sitting, '2026-04-21')]).go('--today', ORDINARY_DAY)
        self.assertEqual(r.code, 0, r.out)
        self.assertEqual(r.read('departed-members.json'), [])
        self.assertIn(f'entry for {sitting}, who is in the member file now', r.out)
        body = r.report('unconfirmed.md')
        self.assertNotIn('who left mid-term', body)
        self.assertNotIn('again', body)
        self.assertIn('A table entry for a sitting member', r.report('unconfirmed.md'))


class SeedDepartedMembers(unittest.TestCase):
    """scripts/seed-departed-members.py: the one-time record of members who
    left during the tracked Congress, through the refresh's own code, with
    the official date as its input."""

    def setUp(self):
        self.current = roster()
        mid = raw_member('M000001', 'rep', 'OH', 3)
        mid['terms'][-1]['end'] = '2026-04-21'  # the volunteer file, a day early
        sen = raw_member('M000002', 'sen', 'SC')
        sen['terms'][-1]['end'] = '2025-01-20'
        before = raw_member('M000003', 'rep', 'OH', 4)  # left at the previous switch
        before['terms'][-1]['end'] = date(2025, 1, 3).isoformat()
        later = raw_member('M000004', 'rep', 'OH', 5)  # after --today
        later['terms'][-1]['end'] = '2026-12-01'
        self.hist = [mid, sen, before, later]
        self.official = [official_entry('M000001', '2026-04-22'), official_entry('M000002', '2025-01-20', 'bioguide')]
        self.d = tempfile.mkdtemp(prefix='oravan-seed-')
        os.makedirs(f'{self.d}/data')
        os.makedirs(f'{self.d}/scripts')
        for f in ('seed-departed-members.py', 'member_entry.py', 'member_turnover.py'):
            shutil.copy(os.path.join(HERE, f), f'{self.d}/scripts/{f}')

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def run_seed(self, official, departed='[]'):
        with open(f'{self.d}/data/legislators.json', 'w') as f:
            json.dump(as_committed(self.current), f)
        with open(f'{self.d}/data/departed-members.json', 'w') as f:
            f.write(departed)
        with open(f'{self.d}/data/departure-dates.json', 'w') as f:
            json.dump(official, f)
        with open(f'{self.d}/hist.json', 'w') as f:
            json.dump(self.hist, f)
        return self.again()

    def again(self):
        cmd = [sys.executable, 'scripts/seed-departed-members.py', '--since', date(2025, 1, 3).isoformat(),
               '--today', '2026-11-13', '--historical', f'{self.d}/hist.json']
        return subprocess.run(cmd, cwd=self.d, capture_output=True, text=True, timeout=60)

    def written(self):
        with open(f'{self.d}/data/departed-members.json', 'rb') as f:
            return f.read()

    def test_records_the_official_dates_and_a_second_run_writes_nothing(self):
        p = self.run_seed(self.official)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        first = self.written()
        rows = json.loads(first)
        self.assertEqual([(r['bioguide'], r['served_until'], r['served_until_source']['kind'], r['left_file']) for r in rows],
                         [('M000001', '2026-04-22', 'house-clerk', '2026-11-13'), ('M000002', '2025-01-20', 'bioguide', '2026-11-13')])
        for r in rows:
            for k in ('phone', 'url', 'offices', 'lis'):
                self.assertNotIn(k, r)
        self.assertEqual(rows[0]['district'], 3)
        p = self.again()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(self.written(), first)
        with open(f'{self.d}/data/legislators.json') as f:
            self.assertEqual(json.load(f), as_committed(self.current))

    def test_refuses_a_member_with_no_official_date(self):
        p = self.run_seed(self.official[:1])
        self.assertEqual(p.returncode, 1, p.stdout)
        self.assertIn('M000002 has no official last day', p.stdout)
        self.assertEqual(self.written(), b'[]')

    def test_refuses_dates_more_than_a_day_apart(self):
        p = self.run_seed([official_entry('M000001', '2026-04-24'), self.official[1]])
        self.assertEqual(p.returncode, 1, p.stdout)
        self.assertIn('3 days apart', p.stdout)
        self.assertEqual(self.written(), b'[]')

    def test_refuses_an_entry_from_before_the_last_term_began(self):
        self.hist[0]['terms'][-1]['start'] = '2026-01-06'
        p = self.run_seed([official_entry('M000001', '2025-12-30'), self.official[1]])
        self.assertEqual(p.returncode, 1, p.stdout)
        self.assertIn('belongs to an earlier departure', p.stdout)
        self.assertEqual(self.written(), b'[]')

    def test_refuses_an_entry_for_a_sitting_member(self):
        sitting = as_committed(self.current)[0]['bioguide']
        p = self.run_seed(self.official + [official_entry(sitting, '2026-04-21')])
        self.assertEqual(p.returncode, 1, p.stdout)
        self.assertIn(f'entry for {sitting}, who is in the member file now', p.stdout)
        self.assertEqual(self.written(), b'[]')

    def test_confirms_a_kept_record_that_had_no_source(self):
        kept = [{'bioguide': 'M000001', 'name': 'Member M000001', 'first': 'F', 'last': 'M000001', 'type': 'rep',
                 'state': 'OH', 'district': 3, 'party': 'Independent', 'served_until': '2026-04-21',
                 'served_until_source': None, 'left_file': '2026-04-27'}]
        p = self.run_seed(self.official, json.dumps(kept))
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        rec = json.loads(self.written())[0]
        self.assertEqual((rec['served_until'], rec['served_until_source']['kind'], rec['left_file']),
                         ('2026-04-22', 'house-clerk', '2026-04-27'))


if __name__ == '__main__':
    unittest.main()

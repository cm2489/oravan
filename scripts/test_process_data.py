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
    def __init__(self, prev_raw, new_raw, historical=None, departed=None, vacancies=None):
        self.dir = tempfile.mkdtemp(prefix='oravan-process-data-')
        os.makedirs(f'{self.dir}/data')
        os.makedirs(f'{self.dir}/scripts')
        for f in ('process-data.py', 'vacancy_diff.py', 'member_turnover.py', 'member_entry.py'):
            shutil.copy(os.path.join(HERE, f), f'{self.dir}/scripts/{f}')
        self.write('legislators.json', as_committed(prev_raw), compact=True)
        self.write('vacancies.json', vacancies or [])
        self.write('departed-members.json', departed or [])
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
        env = {k: v for k, v in os.environ.items() if k not in ('GITHUB_OUTPUT', 'REFUSAL_REPORT')}
        env['REFUSAL_REPORT'] = f'{self.dir}/refusal.md'
        p = subprocess.run([sys.executable, 'scripts/process-data.py', *args], cwd=self.dir, env=env,
                           capture_output=True, text=True, timeout=60)
        self.code, self.out = p.returncode, p.stdout + p.stderr
        return self

    def untouched(self):
        return all(self.read_bytes(n) == b for n, b in self.before.items()) and self.read_bytes('zip-districts.json') is None

    def report(self):
        p = f'{self.dir}/refusal.md'
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
        self.assertIn('legislators-historical gives no end date yet', r.out)

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


class SeedDepartedMembers(unittest.TestCase):
    """scripts/seed-departed-members.py: the one-time record of members who
    left during the tracked Congress, through the refresh's own code."""

    def test_records_exactly_the_mid_term_departures_and_is_idempotent(self):
        current = roster()
        left_mid = raw_member('M000001', 'rep', 'OH', 3)
        left_mid['terms'][-1]['end'] = '2026-04-21'
        left_sen = raw_member('M000002', 'sen', 'SC')
        left_sen['terms'][-1]['end'] = '2025-01-20'
        before = raw_member('M000003', 'rep', 'OH', 4)  # left at the previous switch
        before['terms'][-1]['end'] = date(2025, 1, 3).isoformat()
        later = raw_member('M000004', 'rep', 'OH', 5)  # after --today
        later['terms'][-1]['end'] = '2026-12-01'
        d = tempfile.mkdtemp(prefix='oravan-seed-')
        try:
            os.makedirs(f'{d}/data')
            os.makedirs(f'{d}/scripts')
            for f in ('seed-departed-members.py', 'member_entry.py', 'member_turnover.py'):
                shutil.copy(os.path.join(HERE, f), f'{d}/scripts/{f}')
            with open(f'{d}/data/legislators.json', 'w') as f:
                json.dump(as_committed(current), f)
            with open(f'{d}/data/departed-members.json', 'w') as f:
                f.write('[]')
            with open(f'{d}/hist.json', 'w') as f:
                json.dump([left_mid, left_sen, before, later], f)
            cmd = [sys.executable, 'scripts/seed-departed-members.py', '--since', date(2025, 1, 3).isoformat(),
                   '--today', '2026-11-13', '--historical', f'{d}/hist.json']
            p = subprocess.run(cmd, cwd=d, capture_output=True, text=True, timeout=60)
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            with open(f'{d}/data/departed-members.json', 'rb') as f:
                first = f.read()
            rows = json.loads(first)
            self.assertEqual([(r['bioguide'], r['served_until'], r['left_file']) for r in rows],
                             [('M000001', '2026-04-21', '2026-11-13'), ('M000002', '2025-01-20', '2026-11-13')])
            for r in rows:
                for k in ('phone', 'url', 'offices', 'lis'):
                    self.assertNotIn(k, r)
            self.assertEqual(rows[0]['district'], 3)
            p = subprocess.run(cmd, cwd=d, capture_output=True, text=True, timeout=60)
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            with open(f'{d}/data/departed-members.json', 'rb') as f:
                self.assertEqual(f.read(), first)
            with open(f'{d}/data/legislators.json') as f:
                self.assertEqual(json.load(f), as_committed(current))
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()

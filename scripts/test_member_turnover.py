"""Unit tests for scripts/member_turnover.py.

Stdlib-only (unittest), like scripts/test_vacancy_diff.py - run with:
    cd scripts && python3 -m unittest test_member_turnover -v

Every roster here is synthetic (a full 100-senator, 435-seat House built in
code), never read from data/: the checks must hold for the shape of a
turnover, not for whoever happens to be in the file this week.
"""
import unittest
from datetime import date

from member_turnover import (
    DEPARTED_FIELDS,
    FORBIDDEN_FIELDS,
    MEMBER_DROP_THRESHOLD,
    TURNOVER_WINDOW_DAYS,
    departed_problems,
    departed_records,
    in_turnover_window,
    roster_problems,
)
from vacancy_diff import compute_vacancies

STATES = [
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY',
    'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND',
    'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]

ORDINARY_DAY = '2026-11-16'  # a Monday, outside any window
SWITCH_DAY = '2027-01-04'  # the Monday after the 120th Congress's terms begin
# The day the 119th Congress's terms end (written as a date, not a literal:
# tests/congress-source.unit.spec.ts keeps Jan 3 term dates in lib/congress.mjs).
TERM_END = date(2027, 1, 3).isoformat()


def full_roster(prefix='A'):
    """100 senators and 435 House seats, every one filled, with phones."""
    out = []
    n = 0
    for s in STATES:
        for _ in range(2):
            n += 1
            out.append({'bioguide': f'{prefix}{n:06d}', 'name': f'Senator {n}', 'first': 'S', 'last': str(n),
                        'type': 'sen', 'state': s, 'district': None, 'party': 'Independent',
                        'phone': '202-224-0000', 'url': 'https://example.senate.gov', 'offices': [], 'lis': f'S{n:03d}'})
    for i in range(435):
        n += 1
        out.append({'bioguide': f'{prefix}{n:06d}', 'name': f'Member {n}', 'first': 'M', 'last': str(n),
                    'type': 'rep', 'state': STATES[i % 50], 'district': i // 50 + 1, 'party': 'Independent',
                    'phone': '202-225-0000', 'url': 'https://example.house.gov', 'offices': [{'city': 'X', 'state': 'Y', 'phone': '1'}]})
    return out


def turnover(prev, count, new_prefix='N'):
    """The same seats, `count` of them (House and Senate) held by new people."""
    out = [dict(m) for m in prev]
    for i in range(count):
        # Every 6th member, so both chambers turn over.
        j = (i * 6) % len(out)
        out[j] = dict(out[j], bioguide=f'{new_prefix}{i:06d}', name=f'New {i}')
    return out


def hist(records):
    return {b: {'id': {'bioguide': b}, 'terms': [{'end': end}]} for b, end in records.items()}


class WindowTest(unittest.TestCase):
    def test_opens_on_jan_3_of_an_odd_year_and_closes_by_itself(self):
        self.assertFalse(in_turnover_window('2027-01-02'))
        self.assertTrue(in_turnover_window(TERM_END))
        self.assertTrue(in_turnover_window(SWITCH_DAY))
        self.assertTrue(in_turnover_window('2027-02-13'))  # day 42
        self.assertFalse(in_turnover_window('2027-02-14'))
        self.assertEqual(TURNOVER_WINDOW_DAYS, 42)

    def test_never_open_in_an_even_year(self):
        for d in (date(2026, 1, 3).isoformat(), '2026-01-10', '2028-01-04'):
            self.assertFalse(in_turnover_window(d))


class LargeTurnoverTest(unittest.TestCase):
    """~80 members change at once; every seat stays filled."""

    def setUp(self):
        self.prev = full_roster()
        self.new = turnover(self.prev, 80)

    def test_passes_on_the_switch_week(self):
        self.assertEqual(roster_problems(self.new, self.prev, SWITCH_DAY), [])
        vacancies, newly, anomalous = compute_vacancies(self.new, self.prev, [], SWITCH_DAY)
        self.assertEqual((vacancies, newly, anomalous), ([], [], False))

    def test_the_same_swap_fails_on_an_ordinary_week(self):
        # A file that keeps every seat but swaps 80 people in a November week
        # is a wrong file (an old snapshot), not churn.
        problems = roster_problems(self.new, self.prev, ORDINARY_DAY)
        self.assertEqual(len(problems), 1)
        self.assertIn('80 member(s) left the file', problems[0])

    def test_a_seat_whose_member_changes_is_never_vacant(self):
        # FL-20-class: a seat vacant in the old Congress gets a member in the
        # new one; the vacancy heals and nothing new is flagged.
        prev = [m for m in self.prev if not (m['type'] == 'rep' and m['state'] == 'FL' and m['district'] == 1)]
        prev_vacancies = [{'state': 'FL', 'district': 1, 'since': '2026-04-21'}]
        vacancies, newly, anomalous = compute_vacancies(self.new, prev, prev_vacancies, SWITCH_DAY)
        self.assertEqual((vacancies, newly, anomalous), ([], [], False))

    def test_ordinary_churn_still_passes_outside_the_window(self):
        new = turnover(self.prev, MEMBER_DROP_THRESHOLD)
        self.assertEqual(roster_problems(new, self.prev, ORDINARY_DAY), [])


class DamagedFileTest(unittest.TestCase):
    """The allowance never covers a file that loses seats."""

    def setUp(self):
        self.prev = full_roster()

    def test_a_truncated_house_still_fails_inside_the_window(self):
        new = [m for m in self.prev if not (m['type'] == 'rep' and m['district'] >= 8)]
        _, newly, anomalous = compute_vacancies(new, self.prev, [], SWITCH_DAY)
        self.assertTrue(anomalous)
        self.assertGreater(len(newly), 5)

    def test_a_truncated_senate_fails_inside_the_window_and_outside(self):
        new = [m for m in self.prev if not (m['type'] == 'sen' and m['state'] in STATES[:6])]
        for day in (SWITCH_DAY, ORDINARY_DAY):
            problems = roster_problems(new, self.prev, day)
            self.assertTrue(any('Senate seat(s) emptied' in p for p in problems), day)

    def test_an_empty_file_fails_both_checks(self):
        problems = roster_problems([], self.prev, SWITCH_DAY)
        self.assertTrue(any('Senate' in p for p in problems))
        self.assertTrue(compute_vacancies([], self.prev, [], SWITCH_DAY)[2])

    def test_one_senate_vacancy_is_ordinary(self):
        new = [m for m in self.prev if m['bioguide'] != self.prev[0]['bioguide']]
        self.assertEqual(roster_problems(new, self.prev, ORDINARY_DAY), [])


class DepartedRecordTest(unittest.TestCase):
    def setUp(self):
        self.prev = full_roster()
        self.new = turnover(self.prev, 3)
        self.gone = [m['bioguide'] for m in self.prev if m['bioguide'] not in {n['bioguide'] for n in self.new}]

    def test_a_member_who_leaves_keeps_a_record_without_any_way_to_call(self):
        h = hist({b: TERM_END for b in self.gone})
        departed, undated = departed_records(self.new, self.prev, [], h, SWITCH_DAY)
        self.assertEqual([r['bioguide'] for r in departed], sorted(self.gone))
        self.assertEqual(undated, [])
        for r in departed:
            self.assertEqual(r['served_until'], TERM_END)
            self.assertEqual(r['left_file'], SWITCH_DAY)
            for k in FORBIDDEN_FIELDS:
                self.assertNotIn(k, r)
            self.assertEqual(set(r) - {'served_until', 'left_file'}, set(DEPARTED_FIELDS))
        self.assertEqual(departed_problems(departed, self.new), [])

    def test_the_seat_comes_from_the_committed_file_not_the_historical_one(self):
        b = self.gone[0]
        before = next(m for m in self.prev if m['bioguide'] == b)
        h = {b: {'id': {'bioguide': b}, 'terms': [{'end': TERM_END, 'state': 'ZZ', 'district': 99}]}}
        departed, _ = departed_records(self.new, self.prev, [], h, SWITCH_DAY)
        r = next(r for r in departed if r['bioguide'] == b)
        self.assertEqual((r['state'], r['district'], r['type']), (before['state'], before['district'], before['type']))

    def test_a_mid_term_departure_keeps_its_own_date(self):
        departed, _ = departed_records(self.new, self.prev, [], hist({b: '2026-04-21' for b in self.gone}), ORDINARY_DAY)
        self.assertEqual({r['served_until'] for r in departed}, {'2026-04-21'})

    def test_no_historical_file_leaves_the_date_null_and_a_later_run_fills_it(self):
        departed, undated = departed_records(self.new, self.prev, [], None, SWITCH_DAY)
        self.assertEqual(sorted(undated), sorted(self.gone))
        self.assertEqual(departed_problems(departed, self.new), [])
        later, undated2 = departed_records(self.new, self.new, departed, hist({b: TERM_END for b in self.gone}), '2027-01-11')
        self.assertEqual(undated2, [])
        self.assertEqual({r['left_file'] for r in later}, {SWITCH_DAY})  # first sighting kept

    def test_a_member_who_returns_leaves_the_list(self):
        departed, _ = departed_records(self.new, self.prev, [], hist({}), SWITCH_DAY)
        back = departed_records(self.prev, self.prev, departed, None, '2027-01-11')[0]
        self.assertEqual(back, [])

    def test_an_ordinary_week_with_no_departure_rewrites_nothing(self):
        departed, undated = departed_records(self.prev, self.prev, [], None, ORDINARY_DAY)
        self.assertEqual((departed, undated), ([], []))

    def test_the_structural_check_refuses_a_record_with_a_phone(self):
        bad = [{'bioguide': 'A000001', 'name': 'X', 'type': 'rep', 'state': 'AL', 'phone': '1', 'left_file': SWITCH_DAY}]
        self.assertTrue(any('never keeps' in p for p in departed_problems(bad, [])))
        self.assertTrue(any('at once' in p for p in departed_problems(bad, [{'bioguide': 'A000001'}])))


if __name__ == '__main__':
    unittest.main()

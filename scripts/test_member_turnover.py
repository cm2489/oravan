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
    accepts_seats,
    duplicate_ids,
    parse_accept_departures,
    refusal_report,
    FORBIDDEN_FIELDS,
    MEMBER_DROP_THRESHOLD,
    MIN_PLAUSIBLE_MEMBERS,
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
        self.assertIn('Jan 3 through Feb 13 of an odd year', problems[0])

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


class DuplicateTest(unittest.TestCase):
    def test_a_member_listed_twice_refuses_the_run_in_any_week(self):
        prev = full_roster()
        new = prev + [dict(prev[150])]
        self.assertEqual(duplicate_ids(new), [prev[150]['bioguide']])
        for day in (ORDINARY_DAY, SWITCH_DAY):
            self.assertTrue(any('more than once' in p for p in roster_problems(new, prev, day)), day)
        # and no accept_departures number lets it through
        self.assertTrue(roster_problems(new, prev, ORDINARY_DAY, accept_departures=1))

    def test_a_clean_file_has_none(self):
        self.assertEqual(duplicate_ids(full_roster()), [])


class AcceptedWeekTest(unittest.TestCase):
    """Six or more real departures outside the window (Jan 3 to Feb 13 of an
    odd year): refused until a person names the exact count; then exactly
    that count passes, once."""

    def setUp(self):
        self.prev = full_roster()
        self.new = turnover(self.prev, 7)

    def test_refused_without_the_input(self):
        self.assertTrue(roster_problems(self.new, self.prev, ORDINARY_DAY))

    def test_the_exact_count_passes(self):
        self.assertEqual(roster_problems(self.new, self.prev, ORDINARY_DAY, accept_departures=7), [])

    def test_any_other_count_is_refused_and_says_so(self):
        for n in (6, 8, 70):
            problems = roster_problems(self.new, self.prev, ORDINARY_DAY, accept_departures=n)
            self.assertEqual(len(problems), 1, n)
            self.assertIn(f'accept_departures was {n}, not 7', problems[0])

    def test_seats_pass_only_when_the_departures_explain_them(self):
        gone_house = [m for m in self.prev if m['type'] == 'rep'][:7]
        new = [m for m in self.prev if m not in gone_house]  # 7 leave, 7 House seats empty
        self.assertTrue(accepts_seats(new, self.prev, 7, 7))
        self.assertFalse(accepts_seats(new, self.prev, None, 7))
        self.assertFalse(accepts_seats(new, self.prev, 6, 7))
        self.assertFalse(accepts_seats(new, self.prev, 7, 8))
        # A truncated Senate: accepted only when the count matches and covers it.
        sen_gone = [m for m in self.prev if m['type'] == 'sen'][:7]
        new_s = [m for m in self.prev if m not in sen_gone]
        self.assertTrue(roster_problems(new_s, self.prev, ORDINARY_DAY))
        self.assertEqual(roster_problems(new_s, self.prev, ORDINARY_DAY, accept_departures=7), [])

    def test_the_input_is_a_whole_number_or_nothing(self):
        self.assertIsNone(parse_accept_departures(None))
        self.assertIsNone(parse_accept_departures(''))
        self.assertEqual(parse_accept_departures('7'), 7)
        for bad in ('0', '-3', 'all', '7.5', ' 7'):
            with self.assertRaises(ValueError):
                parse_accept_departures(bad)


class BrokenFileTest(unittest.TestCase):
    """An empty or badly short upstream file is refused in every week, and no
    accept_departures number lets it through (re-check of stage 5: the report
    used to say accept_departures=539, which wrote an empty member file)."""

    def setUp(self):
        self.prev = full_roster()

    def test_the_floor_comes_from_the_record(self):
        self.assertEqual(MIN_PLAUSIBLE_MEMBERS, 500)

    def test_an_empty_file_is_broken_and_never_accepted(self):
        for day in (ORDINARY_DAY, SWITCH_DAY):
            for accept in (None, 1, 80, len(self.prev)):
                problems = roster_problems([], self.prev, day, accept_departures=accept)
                self.assertTrue(any('looks broken' in p for p in problems), (day, accept))
            self.assertFalse(accepts_seats([], self.prev, len(self.prev), 435))

    def test_a_short_file_is_broken_even_in_january_and_no_number_accepts_it(self):
        short = self.prev[:MIN_PLAUSIBLE_MEMBERS - 1]  # 499 members
        gone = len(self.prev) - len(short)
        for day in (SWITCH_DAY, ORDINARY_DAY):
            for accept in (None, gone, 1):
                problems = roster_problems(short, self.prev, day, accept_departures=accept)
                self.assertTrue(any('looks broken' in p for p in problems), (day, accept))
            self.assertFalse(accepts_seats(short, self.prev, gone, gone))
        whole_enough = self.prev[:MIN_PLAUSIBLE_MEMBERS]
        self.assertFalse(any('looks broken' in p for p in roster_problems(whole_enough, self.prev, SWITCH_DAY)))

    def test_the_report_for_a_broken_file_offers_no_accept_command(self):
        from member_turnover import dropped_members
        body = refusal_report(roster_problems([], self.prev, ORDINARY_DAY), dropped_members([], self.prev), ORDINARY_DAY)
        self.assertNotIn('accept_departures=', body)
        self.assertIn('Accept nothing', body)
        self.assertIn('looks broken', body)



class LateChangeoverTest(unittest.TestCase):
    """Second review of the broken-file guard (2026-11-13): if the change of
    Congress is still uncommitted after the window closes (Feb 13 of an odd
    year), its ~80 real departures must stay acceptable with exactly 80, as
    on main; the same on any ordinary week. Only the size floor is "broken"."""

    def setUp(self):
        self.prev = full_roster()
        self.new = turnover(self.prev, 80)

    def test_eighty_departures_after_the_window_and_in_november(self):
        from member_turnover import dropped_members
        for day in ('2027-02-14', ORDINARY_DAY):
            refused = roster_problems(self.new, self.prev, day)
            self.assertEqual(len(refused), 1, day)
            self.assertIn('80 member(s) left the file', refused[0])
            self.assertFalse(any('looks broken' in p for p in refused), day)
            self.assertEqual(roster_problems(self.new, self.prev, day, accept_departures=80), [], day)
            for wrong in (79, 81):
                problems = roster_problems(self.new, self.prev, day, accept_departures=wrong)
                self.assertTrue(any(f'accept_departures was {wrong}, not 80' in p for p in problems), (day, wrong))
            body = refusal_report(refused, dropped_members(self.new, self.prev), day)
            self.assertIn('accept_departures=80', body)
            self.assertNotIn('Accept nothing', body)

    def test_the_window_still_closes_on_feb_13(self):
        self.assertEqual(roster_problems(self.new, self.prev, '2027-02-13'), [])
        self.assertTrue(roster_problems(self.new, self.prev, '2027-02-14'))


class RefusalReportTest(unittest.TestCase):
    def test_says_what_was_refused_and_the_exact_command(self):
        prev = full_roster()
        new = turnover(prev, 7)
        from member_turnover import dropped_members
        problems = roster_problems(new, prev, ORDINARY_DAY)
        body = refusal_report(problems, dropped_members(new, prev), ORDINARY_DAY)
        self.assertIn('was **refused**', body)
        self.assertIn('7 member(s) left the file', body)
        self.assertIn('gh workflow run refresh-legislators.yml --ref main -f accept_departures=7', body)
        self.assertIn('A refused week', body)

    def test_a_duplicate_gets_no_accept_command(self):
        prev = full_roster()
        body = refusal_report(roster_problems(prev + [prev[0]], prev, ORDINARY_DAY), [], ORDINARY_DAY)
        self.assertNotIn('accept_departures=', body)
        self.assertIn('upstream file is damaged', body)


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
            self.assertEqual(set(r) - {'served_until', 'served_until_source', 'left_file'}, set(DEPARTED_FIELDS))
            self.assertIsNone(r['served_until_source'])  # the historical file's date alone
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


class OfficialDatesTest(unittest.TestCase):
    """Which dates a record page may print (hard rule 6)."""

    def test_the_change_of_congress_is_jan_3_of_an_odd_year(self):
        from member_turnover import is_term_change_day
        self.assertTrue(is_term_change_day(TERM_END))
        for d in (date(2026, 1, 3).isoformat(), '2026-04-21', None, '', 'nope'):
            self.assertFalse(is_term_change_day(d), d)

    def test_only_a_mid_term_date_without_a_source_is_unconfirmed(self):
        from member_turnover import unconfirmed
        src = {'kind': 'house-clerk', 'url': 'https://clerk.house.gov/Members/ViewVacancies', 'read': '2026-11-13'}
        recs = [
            {'bioguide': 'A000001', 'served_until': '2026-04-21', 'served_until_source': None},
            {'bioguide': 'A000002', 'served_until': '2026-04-21', 'served_until_source': src},
            {'bioguide': 'A000003', 'served_until': TERM_END, 'served_until_source': None, 'left_file': '2027-01-04'},
            {'bioguide': 'A000004', 'served_until': None, 'served_until_source': None},
            {'bioguide': 'A000005', 'served_until': '2026-04-21', 'served_until_source': None},
        ]
        got = [r['bioguide'] for r in unconfirmed(recs, ['A000001', 'A000002', 'A000003', 'A000004'])]
        self.assertEqual(got, ['A000001'])  # A000005 is not new this run

    def test_the_official_table_and_its_sources_are_checked(self):
        from member_turnover import official_problems
        good = {'bioguide': 'A000001', 'served_until': '2026-04-22',
                'source': {'kind': 'bioguide', 'url': 'https://bioguide.congress.gov/search/bio/A000001', 'read': '2026-11-13'}}
        self.assertEqual(official_problems([good]), [])
        bad = [
            dict(good, source={'kind': 'news', 'url': 'https://example.com', 'read': '2026-11-13'}),
            dict(good, bioguide='A000002', source={'kind': 'house-clerk', 'url': 'https://example.com', 'read': '2026-11-13'}),
            dict(good, bioguide='A000003', served_until='April 22'),
            dict(good, bioguide='A000004', source=None),
        ]
        self.assertEqual(len(official_problems(bad)), 4)
        self.assertTrue(official_problems([good, good]))


class OfficialMismatchTest(unittest.TestCase):
    """A table entry applies only to the departure it was written for."""

    def hist(self, end, start=date(2025, 1, 3).isoformat()):
        return {'A000001': {'id': {'bioguide': 'A000001'}, 'terms': [{'start': start, 'end': end}]}}

    def entry(self, day):
        return {'bioguide': 'A000001', 'served_until': day,
                'source': {'kind': 'house-clerk', 'url': 'https://clerk.house.gov/Members/ViewVacancies', 'read': '2026-11-13'}}

    def test_within_a_day_fits(self):
        from member_turnover import official_mismatch
        for day in ('2026-04-20', '2026-04-21', '2026-04-22'):
            self.assertIsNone(official_mismatch(self.entry(day), self.hist('2026-04-21')), day)

    def test_more_than_a_day_or_no_file_day_or_an_earlier_term_does_not(self):
        from member_turnover import official_mismatch
        self.assertIn('2 days apart', official_mismatch(self.entry('2026-04-23'), self.hist('2026-04-21')))
        self.assertIn('no last day', official_mismatch(self.entry('2026-04-21'), {}))
        self.assertIn('no last day', official_mismatch(self.entry('2026-04-21'), None))
        self.assertIn('earlier departure', official_mismatch(self.entry('2025-03-05'), self.hist('2026-11-10', start='2026-06-02')))

    def test_departed_records_never_applies_an_entry_that_does_not_fit(self):
        prev = full_roster()
        new = turnover(prev, 1)
        b = next(m['bioguide'] for m in prev if m['bioguide'] not in {n['bioguide'] for n in new})
        h = {b: {'id': {'bioguide': b}, 'terms': [{'start': date(2025, 1, 3).isoformat(), 'end': '2026-04-21'}]}}
        off = {b: dict(self.entry('2026-04-25'), bioguide=b)}
        departed, _ = departed_records(new, prev, [], h, ORDINARY_DAY, off)
        self.assertEqual((departed[0]['served_until'], departed[0]['served_until_source']), ('2026-04-21', None))
        off = {b: dict(self.entry('2026-04-22'), bioguide=b)}
        departed, _ = departed_records(new, prev, [], h, ORDINARY_DAY, off)
        self.assertEqual(departed[0]['served_until'], '2026-04-22')
        self.assertEqual(departed[0]['served_until_source']['kind'], 'house-clerk')


class TableValidationTest(unittest.TestCase):
    """data/departure-dates.json is checked entry by entry, with real dates."""

    def good(self, b='A000001', day='2026-04-22'):
        return {'bioguide': b, 'served_until': day,
                'source': {'kind': 'house-clerk', 'url': 'https://clerk.house.gov/Members/ViewVacancies', 'read': '2026-11-13'}}

    def test_an_impossible_date_is_caught(self):
        from member_turnover import real_day, split_official
        self.assertFalse(real_day('2026-02-30'))
        self.assertFalse(real_day('2026-2-3'))
        self.assertTrue(real_day('2028-02-29'))
        usable, bad = split_official([self.good(day='2026-02-30')])
        self.assertEqual(usable, {})
        self.assertTrue(any('2026-02-30' in b for b in bad))
        bad_read = self.good()
        bad_read['source'] = dict(bad_read['source'], read='2026-11-31')
        self.assertTrue(split_official([bad_read])[1])

    def test_good_entries_survive_bad_ones(self):
        from member_turnover import split_official
        usable, bad = split_official([
            self.good('A000001'),
            {'bioguide': 'A000002', 'served_until': '2026-04-22'},  # no source
            'not an object',
            self.good('A000003'), self.good('A000003', '2026-04-23'),  # listed twice
            dict(self.good('A000004'), extra=1),
        ])
        self.assertEqual(sorted(usable), ['A000001'])
        for named in ('A000002', 'not an object', 'A000003 is listed 2 times', 'A000004'):
            self.assertTrue(any(named in b for b in bad), named)
        self.assertFalse(any('A000001' in b for b in bad))

    def test_not_a_list(self):
        from member_turnover import split_official
        self.assertEqual(split_official({'A000001': {}}), ({}, ['data/departure-dates.json is not a JSON list (dict)']))


class ChangeoverTest(unittest.TestCase):
    """Jan 3 counts as the change of Congress only for a member still in the
    member file that day or later."""

    def test_a_member_who_left_on_dec_7_with_a_jan_3_file_date_is_mid_term(self):
        from member_turnover import changeover, unconfirmed
        early = {'bioguide': 'A000001', 'served_until': TERM_END, 'served_until_source': None, 'left_file': '2026-12-07'}
        on_time = dict(early, bioguide='A000002', left_file='2027-01-04')
        self.assertFalse(changeover(early))
        self.assertTrue(changeover(on_time))
        self.assertEqual([r['bioguide'] for r in unconfirmed([early, on_time], ['A000001', 'A000002'])], ['A000001'])


class OverrideTest(unittest.TestCase):
    """overrides_file_day: a deliberate, recorded way past a wrong volunteer
    file. It applies only while the file shows exactly that day."""

    def hist(self, end, start=date(2025, 1, 3).isoformat()):
        return {'A000001': {'id': {'bioguide': 'A000001'}, 'terms': [{'start': start, 'end': end}]}}

    def entry(self, day, **extra):
        return dict({'bioguide': 'A000001', 'served_until': day,
                     'source': {'kind': 'house-clerk', 'url': 'https://clerk.house.gov/Members/ViewVacancies', 'read': '2026-11-13'}}, **extra)

    def test_it_applies_only_to_the_exact_file_day(self):
        from member_turnover import official_mismatch
        self.assertIn('overrides_file_day', official_mismatch(self.entry('2026-12-07'), self.hist(TERM_END)))
        self.assertIsNone(official_mismatch(self.entry('2026-12-07', overrides_file_day=TERM_END), self.hist(TERM_END)))
        # The file changes: the override no longer applies and it is reported again.
        self.assertIsNotNone(official_mismatch(self.entry('2026-12-07', overrides_file_day=TERM_END), self.hist('2026-12-05')))

    def test_it_never_passes_the_term_start_check(self):
        from member_turnover import official_mismatch
        why = official_mismatch(self.entry('2025-03-05', overrides_file_day='2026-11-10'), self.hist('2026-11-10', start='2026-06-02'))
        self.assertIn('earlier departure', why)

    def test_a_malformed_override_makes_the_entry_unusable(self):
        from member_turnover import split_official
        usable, bad = split_official([self.entry('2026-12-07', overrides_file_day='Jan 3')])
        self.assertEqual(usable, {})
        self.assertTrue(any('overrides_file_day' in b for b in bad))


class ReportWordingTest(unittest.TestCase):
    def test_a_report_about_the_table_only_does_not_speak_of_departures(self):
        from member_turnover import attention_report
        body = attention_report({'undated': [], 'unconfirmed': [], 'mismatched': [], 'sitting': ['A000001'], 'bad_entries': []}, ORDINARY_DAY)
        self.assertNotIn('who left mid-term', body.split('\n')[0])
        self.assertNotIn('They get no record page yet', body)
        self.assertNotIn('again', body)
        self.assertIn('A000001 is in the member file now', body)


if __name__ == '__main__':
    unittest.main()

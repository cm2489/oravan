"""Unit tests for scripts/vacancy_diff.py.

Stdlib-only (unittest), no pytest dependency needed - run with:
    cd scripts && python3 -m unittest test_vacancy_diff -v
or directly:
    python3 scripts/test_vacancy_diff.py

Fixtures match the three named in the sprint spec
(docs/ideation/2026-07-05-build-gtm-strategy.md §9.1(f)): a departed member
with no successor, a chronic vacant-no-successor seat spanning multiple
runs, and an anomalous shrink that should fail loud rather than commit.
"""
import unittest

from vacancy_diff import ANOMALOUS_SHRINK_THRESHOLD, compute_vacancies, rep_seats

TODAY = '2026-07-06'


def member(state, district, bioguide='X000001', mtype='rep'):
    return {'bioguide': bioguide, 'state': state, 'district': district, 'type': mtype}


class RepSeatsTest(unittest.TestCase):
    def test_senators_excluded(self):
        members = [member('CA', None, mtype='sen'), member('CA', 12)]
        self.assertEqual(rep_seats(members), {('CA', 12)})


class DepartedMemberTest(unittest.TestCase):
    """A member who held a seat last run is simply absent from this run's
    fresh pull, with no prior tracking - the base case the whole feature
    exists for."""

    def test_new_vacancy_detected_and_dated_today(self):
        prev_members = [member('NY', 5, bioguide='D000123')]
        new_members = []  # NY-5's member is gone; no successor in this pull
        prev_vacancies = []

        vacancies, newly_detected, anomalous = compute_vacancies(
            new_members, prev_members, prev_vacancies, TODAY
        )

        self.assertEqual(vacancies, [{'state': 'NY', 'district': 5, 'since': TODAY}])
        self.assertEqual(newly_detected, vacancies)
        self.assertFalse(anomalous)

    def test_vacancy_record_never_carries_the_departed_members_identity(self):
        # Structural guarantee, not just a behavioral one: a Seat is
        # (state, district) only, so the departed member's bioguide/name
        # cannot leak into data/vacancies.json even by accident.
        prev_members = [member('NY', 5, bioguide='D000123')]
        vacancies, _, _ = compute_vacancies([], prev_members, [], TODAY)
        self.assertEqual(set(vacancies[0].keys()), {'state', 'district', 'since'})


class VacantNoSuccessorTest(unittest.TestCase):
    """FL-20-class: a seat that's been vacant across several runs already
    with no successor sworn in. It must survive every subsequent run
    unchanged (same `since`), not get re-flagged as newly detected, and
    must never fall back to re-showing the old member."""

    def test_chronic_vacancy_survives_and_keeps_its_original_since_date(self):
        prev_members = []  # FL-20's old member already dropped out of a prior run
        prev_vacancies = [{'state': 'FL', 'district': 20, 'since': '2026-04-21'}]
        new_members = []  # still no successor this run either

        vacancies, newly_detected, anomalous = compute_vacancies(
            new_members, prev_members, prev_vacancies, TODAY
        )

        self.assertEqual(vacancies, [{'state': 'FL', 'district': 20, 'since': '2026-04-21'}])
        self.assertEqual(newly_detected, [])  # already known - not "new" this run
        self.assertFalse(anomalous)

    def test_successor_sworn_in_heals_the_vacancy(self):
        prev_members = []
        prev_vacancies = [{'state': 'FL', 'district': 20, 'since': '2026-04-21'}]
        new_members = [member('FL', 20, bioguide='S000999')]  # successor now present

        vacancies, newly_detected, anomalous = compute_vacancies(
            new_members, prev_members, prev_vacancies, TODAY
        )

        self.assertEqual(vacancies, [])
        self.assertEqual(newly_detected, [])
        self.assertFalse(anomalous)


class AnomalousShrinkTest(unittest.TestCase):
    """More than ANOMALOUS_SHRINK_THRESHOLD seats vanishing in one run is
    treated as likely upstream breakage (a truncated/broken fetch), not
    reality - the caller must refuse to commit."""

    def test_six_simultaneous_new_vacancies_is_anomalous(self):
        prev_members = [member(s, 1) for s in ['AK', 'DE', 'MT', 'ND', 'SD', 'VT']]
        new_members = []  # all six vanish in the same run
        prev_vacancies = []

        vacancies, newly_detected, anomalous = compute_vacancies(
            new_members, prev_members, prev_vacancies, TODAY
        )

        self.assertEqual(len(newly_detected), 6)
        self.assertGreater(len(newly_detected), ANOMALOUS_SHRINK_THRESHOLD)
        self.assertTrue(anomalous)

    def test_exactly_at_threshold_is_not_anomalous(self):
        prev_members = [member(s, 1) for s in ['AK', 'DE', 'MT', 'ND', 'SD']]
        new_members = []
        vacancies, newly_detected, anomalous = compute_vacancies(
            new_members, prev_members, [], TODAY
        )
        self.assertEqual(len(newly_detected), ANOMALOUS_SHRINK_THRESHOLD)
        self.assertFalse(anomalous)

    def test_chronic_vacancies_dont_count_toward_the_anomaly_threshold(self):
        # 6 seats already tracked as vacant across prior runs, still vacant
        # this run: none of these are "newly detected," so this must NOT
        # trip the anomalous-shrink guard even though 6 > threshold.
        prev_vacancies = [
            {'state': s, 'district': 1, 'since': '2026-01-01'}
            for s in ['AK', 'DE', 'MT', 'ND', 'SD', 'VT']
        ]
        vacancies, newly_detected, anomalous = compute_vacancies(
            [], [], prev_vacancies, TODAY
        )
        self.assertEqual(len(vacancies), 6)
        self.assertEqual(newly_detected, [])
        self.assertFalse(anomalous)


if __name__ == '__main__':
    unittest.main()

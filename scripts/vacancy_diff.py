"""Vacancy derivation for the weekly legislators refresh.

Spec: docs/ideation/2026-07-05-build-gtm-strategy.md §9.1(f), sprint items 1
and 4; docs/plans/2026-07-03-001-feat-oravan-launch-buildout-plan.md's
"specific data-model footgun" note.

The upstream unitedstates/congress-legislators feed has no explicit "vacant"
placeholder: a departed member's record just moves out of
legislators-current.json into legislators-historical.json with a
terms[].end date, and nothing about the current-file pull itself says "a
seat disappeared here." The naive per-legislator approach process-data.py
used before this module existed (`t = l['terms'][-1]` for whoever's left in
the file) had no way to notice that - it would just silently rebuild
legislators.json one member short, with nothing flagging why, and would
silently backfill a departed member's stale term data if that member's old
record were ever carried forward by mistake.

This module fixes the footgun by comparing *seat sets*, never member
records: whether a (state, district) House seat is expected to be occupied
is derived from what the currently-committed data already treats as a real
seat (data/legislators.json's occupied seats, unioned with
data/vacancies.json's already-tracked vacant seats) - never from any single
legislator's own term data. A seat missing from the fresh pull is vacant,
full stop; a seat that reappears has a successor and heals off the list
automatically.

Dependency-free (no file I/O, no network) on purpose: process-data.py owns
reading/writing the JSON files and wires the result into GitHub Actions
annotations / outputs, so this module is a pure function over in-memory
fixtures and is unit-tested directly in scripts/test_vacancy_diff.py.
"""
from typing import Dict, Iterable, List, Tuple

Seat = Tuple[str, int]

# ">5 seats vanish at once" heuristic named in docs/ideation/2026-07-05-
# build-gtm-strategy.md §9.1(f): that's not five members independently
# resigning in the same week, it's almost certainly a truncated or broken
# upstream fetch. Fail loud instead of committing a corrupted roster.
ANOMALOUS_SHRINK_THRESHOLD = 5


def rep_seats(members: Iterable[dict]) -> set:
    """(state, district) pairs the roster currently reports a House member for.

    Senate seats are out of scope by construction (type != 'rep' is never
    included): a Senate vacancy is almost always filled within days by
    gubernatorial appointment, so the multi-day upstream-lag problem this
    module exists for doesn't apply the same way there.
    """
    return {(m['state'], m['district']) for m in members if m.get('type') == 'rep'}


def compute_vacancies(
    new_members: List[dict],
    prev_members: List[dict],
    prev_vacancies: List[dict],
    today: str,
) -> Tuple[List[dict], List[dict], bool]:
    """Derive this run's vacant-seat list from seat sets only.

    Args:
        new_members: freshly-parsed roster this run is about to write out
            (the same list process-data.py writes to data/legislators.json).
        prev_members: data/legislators.json's content as committed BEFORE
            this run (read before it gets overwritten).
        prev_vacancies: data/vacancies.json's content as committed before
            this run.
        today: ISO date stamped on a vacancy the first time it's observed.

    A seat counts as "expected occupied" if the currently-committed data
    already treats it as real - either because it had a member last run, or
    because it was already tracked as vacant last run. Anything in that
    union missing from this week's fresh roster is vacant; this is what
    makes a chronic vacancy (no successor for weeks) survive every run
    without being "forgotten," while a seat that gets a successor drops off
    the list the moment it reappears in new_members - no separate
    "un-vacate" step needed.

    Returns (vacancies, newly_detected, anomalous):
        vacancies: the full list to write to data/vacancies.json this run.
        newly_detected: the subset first observed vacant THIS run - drives
            the loud-but-non-blocking issue path. A chronic vacancy carried
            forward from a prior run is not "newly detected" again.
        anomalous: True when len(newly_detected) exceeds
            ANOMALOUS_SHRINK_THRESHOLD - likely upstream breakage, not real
            churn. The caller should fail the workflow before committing
            anything when this is True.
    """
    occupied_now = rep_seats(new_members)
    occupied_before = rep_seats(prev_members)
    known_vacant_before: Dict[Seat, str] = {
        (v['state'], v['district']): v['since'] for v in prev_vacancies
    }

    expected = occupied_before | set(known_vacant_before)
    currently_vacant = sorted(expected - occupied_now)

    vacancies = [
        {'state': s, 'district': d, 'since': known_vacant_before.get((s, d), today)}
        for (s, d) in currently_vacant
    ]
    newly_detected = [
        v for v in vacancies if (v['state'], v['district']) not in known_vacant_before
    ]
    anomalous = len(newly_detected) > ANOMALOUS_SHRINK_THRESHOLD
    return vacancies, newly_detected, anomalous

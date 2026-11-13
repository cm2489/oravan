"""Build data/legislators.json, data/zip-districts.json, and data/vacancies.json.

With --download, fetches the public-domain sources first (CI mode);
otherwise expects the raw files already present in data/.

Vacancy handling (the project records §9.1(f)):
see scripts/vacancy_diff.py for why this exists and how it's derived. The
short version - a departed member just disappears from
legislators-current.json with no "vacant" marker, so this script diffs seat
sets (never a member's own stale term data) against the currently-committed
data/legislators.json + data/vacancies.json to notice, and refuses to commit
(exit 1) if more seats vanish at once than looks like real churn.

Member turnover (stage 5 of the new-Congress work, 2026-11-13): see
scripts/member_turnover.py. Before anything is written, the run also fails
when more than five Senate seats empty at once, and when more than five
members leave the file in one run outside the six weeks that open on Jan 3 of
an odd year (a new Congress, when ~80 members change at once and only the
seat checks apply). A member who leaves is kept, without any way to contact
them, in data/departed-members.json, so their page can stay a record page.
Nothing is written when a check fails: every data/ file stays as committed.

A refused week (2026-11-13, review of stage 5): every later run compares
against the same committed file, so a real week with six or more departures
would refuse forever. --accept-departures N, passed only by a person through
the workflow's `accept_departures` input, accepts exactly N departures for
that one run (never the seat checks or a duplicate member). On any refusal,
when REFUSAL_REPORT names a path, the plain-words report for the GitHub issue
is written there (scripts/member_turnover.py refusal_report).
"""
import json, csv, sys, os, urllib.request
from collections import defaultdict
from datetime import datetime, timezone

from vacancy_diff import ANOMALOUS_SHRINK_THRESHOLD, compute_vacancies
from member_entry import member_entry
from member_turnover import (
    accepts_seats,
    departed_problems,
    official_problems,
    unconfirmed,
    unconfirmed_line,
    unconfirmed_report,
    departed_records,
    dropped_members,
    parse_accept_departures,
    refusal_report,
    roster_problems,
)

DOWNLOAD = '--download' in sys.argv
# --today YYYY-MM-DD: the date the checks and the vacancy/departed stamps use,
# for a rehearsal on a COPY of data/ (docs/runbooks/new-congress-switch.md).
# The workflow never passes it.
TODAY_ARG = sys.argv[sys.argv.index('--today') + 1] if '--today' in sys.argv else None
# --accept-departures N: see the header. Exactly N, refused if not a number.
try:
    ACCEPT = parse_accept_departures(
        sys.argv[sys.argv.index('--accept-departures') + 1] if '--accept-departures' in sys.argv else None
    )
except (ValueError, IndexError) as e:
    # One plain line, before anything is read or written (0, abc and -1 used
    # to stop here with a traceback).
    print(f'::error::{e if isinstance(e, ValueError) else "--accept-departures needs a number after it"}; nothing was read or written.')
    sys.exit(2)
SOURCES = {
    'data/legislators-raw.json': 'https://unitedstates.github.io/congress-legislators/legislators-current.json',
    'data/district-offices-raw.json': 'https://unitedstates.github.io/congress-legislators/legislators-district-offices.json',
    'data/zccd.csv': 'https://raw.githubusercontent.com/OpenSourceActivismTech/us_zipcodes_congress/master/zccd.csv',
}
# Read only in a run where a member left the file (or a kept record still
# lacks its end date): the last term's end date for data/departed-members.json.
# ~13 MB, so never on an ordinary week. Offline, it is read from this path if
# present and otherwise skipped (the end date stays null; a later run fills it).
HISTORICAL = (
    'data/legislators-historical-raw.json',
    'https://unitedstates.github.io/congress-legislators/legislators-historical.json',
)

if DOWNLOAD:
    for path, url in SOURCES.items():
        print(f'downloading {url}')
        urllib.request.urlretrieve(url, path)

legs = json.load(open('data/legislators-raw.json'))
offices_raw = json.load(open('data/district-offices-raw.json'))
office_map = {o['id']['bioguide']: o['offices'] for o in offices_raw}


def _load_json(path, default):
    try:
        return json.load(open(path))
    except FileNotFoundError:
        return default


# Captured BEFORE this run overwrites either file - the vacancy diff below
# compares against exactly what's currently committed, per the sprint spec.
prev_legislators = _load_json('data/legislators.json', [])
prev_vacancies = _load_json('data/vacancies.json', [])
prev_departed = _load_json('data/departed-members.json', [])
# Official last days (Clerk of the House, Biographical Directory), added by a
# person in a pull request: the only dates a mid-term record page may print
# (scripts/member_turnover.py, "WHICH DATES A PAGE MAY PRINT").
official_dates = _load_json('data/departure-dates.json', [])

out = [member_entry(l, office_map.get(l['id']['bioguide'], [])) for l in legs]

# Vacancy-diff step. Never infers occupancy from any one legislator's own
# term data (the footgun this replaces) - purely a seat-set comparison
# against what the currently-committed data already expects. See
# scripts/vacancy_diff.py for the derivation and scripts/test_vacancy_diff.py
# for the departed-member / vacant-no-successor / anomalous-shrink fixtures.
today = TODAY_ARG or datetime.now(timezone.utc).date().isoformat()
vacancies, newly_detected, anomalous = compute_vacancies(out, prev_legislators, prev_vacancies, today)
problems = roster_problems(out, prev_legislators, today, ACCEPT)
# The House seat check yields only to an accept_departures count that matches
# exactly and explains every emptied seat (scripts/member_turnover.py).
house_accepted = anomalous and accepts_seats(out, prev_legislators, ACCEPT, len(newly_detected))
if house_accepted:
    anomalous = False
if ACCEPT is not None and not problems and not anomalous:
    left = len(dropped_members(out, prev_legislators))
    print(
        f'accept_departures={ACCEPT}: accepted; {left} member(s) left, {len(newly_detected)} newly vacant House seat(s) recorded as usual'
        if left == ACCEPT
        else f'accept_departures={ACCEPT}: not used ({left} member(s) left, which the checks pass without it)'
    )

# The record of members who left. The historical file is read only when it
# can add something: a member left this run, or a kept record lacks its date.
leaving = {m['bioguide'] for m in prev_legislators} - {m['bioguide'] for m in out}
historical_by_id = None
if not anomalous and not problems and (leaving or any(r.get('served_until') is None for r in prev_departed)):
    hist_path, hist_url = HISTORICAL
    try:
        if DOWNLOAD:
            print(f'downloading {hist_url}')
            urllib.request.urlretrieve(hist_url, hist_path)
        if os.path.exists(hist_path):
            historical_by_id = {h['id']['bioguide']: h for h in json.load(open(hist_path)) if h.get('id', {}).get('bioguide')}
    except Exception as e:  # a failed read leaves the end date null, never fails the roster
        print(f'::warning::legislators-historical not read ({e}); departed end dates stay null until a later run')
    finally:
        if DOWNLOAD and os.path.exists(hist_path):
            os.remove(hist_path)
departed, undated = departed_records(
    out, prev_legislators, prev_departed, historical_by_id, today, {e['bioguide']: e for e in official_dates}
)
problems += official_problems(official_dates)
problems += departed_problems(departed, out)

if not anomalous and not problems:
    json.dump(out, open('data/legislators.json', 'w'), ensure_ascii=False)
    print('legislators.json:', len(out), 'members,', sum(1 for m in out if m['offices']), 'with district offices')
    json.dump(vacancies, open('data/vacancies.json', 'w'), ensure_ascii=False, indent=2)
    print(
        f'vacancies.json: {len(vacancies)} currently vacant seat(s),',
        f'{len(newly_detected)} newly detected this run',
    )
    if departed != prev_departed:
        json.dump(departed, open('data/departed-members.json', 'w'), ensure_ascii=False, indent=2)
    if leaving or departed != prev_departed:
        print(f'departed-members.json: {len(departed)} member(s) kept as a record, {len(leaving)} left the file this run')
    for b in undated:
        print(f'::warning::{b} left the member file but legislators-historical gives no end date yet; no page until it does')
    # A NEW mid-term departure whose date is the volunteer file's alone: no
    # record page until a person confirms it. One line each in the log and the
    # step summary, and the report the workflow files as an issue.
    fresh = unconfirmed(departed, leaving)
    for r in fresh:
        print(f'::warning::{unconfirmed_line(r)}')
    summary_path = os.environ.get('GITHUB_STEP_SUMMARY')
    if fresh and summary_path:
        with open(summary_path, 'a') as f:
            f.write(''.join(f'- {unconfirmed_line(r)}\n' for r in fresh))
    report_path = os.environ.get('UNCONFIRMED_REPORT')
    if fresh and report_path:
        with open(report_path, 'w') as f:
            f.write(unconfirmed_report(fresh, today))

for v in newly_detected:
    print(
        f"::warning::Newly detected vacant seat: {v['state']}-{v['district']} "
        "(no representative in this week's pull - never backfilled from a "
        "departed member's stale term record; see data/vacancies.json)"
    )

github_output = os.environ.get('GITHUB_OUTPUT')
if github_output:
    with open(github_output, 'a') as f:
        f.write(f"anomalous_vacancy_shrink={'true' if (anomalous or problems) else 'false'}\n")
        f.write('newly_detected_vacancies<<VACANCY_EOF\n')
        f.write(json.dumps(newly_detected))
        f.write('\nVACANCY_EOF\n')

house_problem = (
    f'{len(newly_detected)} House seat(s) vanished in a single run '
    f'(> {ANOMALOUS_SHRINK_THRESHOLD}): '
    + ', '.join(f"{v['state']}-{v['district']}" for v in newly_detected)
)
if anomalous:
    print(f'::error::{house_problem}')
    # No accept hint when the file looks broken: the report says "Accept
    # nothing" then, and the line here must not say otherwise.
    broken = any('looks broken' in p for p in problems)
    print(
        '::error::This looks like a truncated or broken upstream fetch, not '
        f'{len(newly_detected)} simultaneous real vacancies - refusing to commit.'
        + (
            ''
            if broken
            else ' If this is genuinely correct, re-run with the accept_departures '
            'input (docs/runbooks/new-congress-switch.md, "A refused week").'
        )
    )
if problems:
    for p in problems:
        print(f'::error::{p}')
    print(
        '::error::The member file looks damaged or wrong, not like real churn - refusing '
        'to write or commit anything. Wait for the upstream file to settle and re-run; '
        'see docs/runbooks/new-congress-switch.md.'
    )
if anomalous or problems:
    report_path = os.environ.get('REFUSAL_REPORT')
    if report_path:
        with open(report_path, 'w') as f:
            f.write(refusal_report(([house_problem] if anomalous else []) + problems, dropped_members(out, prev_legislators), today))
    sys.exit(1)

zips = defaultdict(list)
with open('data/zccd.csv') as f:
    for row in csv.DictReader(f):
        pair = {'state': row['state_abbr'], 'district': int(row['cd'])}
        if pair not in zips[row['zcta']]:
            zips[row['zcta']].append(pair)
json.dump(dict(zips), open('data/zip-districts.json', 'w'))
print('zip-districts.json:', len(zips), 'ZIPs')

if DOWNLOAD:
    for path in SOURCES:
        os.remove(path)

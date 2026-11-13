"""One-time: record the members who left during the tracked Congress before
data/departed-members.json existed, through the weekly refresh's own code.

The weekly refresh (scripts/process-data.py) records a member the run it
first finds them gone from the member file. The file began on 2026-11-13, so
the members who left earlier in the 119th Congress were never recorded. On
2026-11-13 the owner chose to give them record pages ("Served in the House
until April 21, 2026."). This script records them exactly as the refresh
would have if they had left this week:

  1. it reads the congress-legislators historical file and picks each member
     whose last term ended after --since (the tracked Congress's first day)
     and on or before --today, and who is not in data/legislators.json;
  2. it rebuilds each one's member-file entry with scripts/member_entry.py
     (the code process-data.py uses for every member), from the same
     historical record;
  3. it hands the committed member file plus those entries to
     member_turnover.departed_records as "last week's file", and the
     committed member file as "this week's", so departed_records keeps the
     same fields, reads served_until from the same historical file, and
     stamps left_file = --today, as a refresh run on that day would;
  4. it refuses to write unless member_turnover.departed_problems passes,
     and writes with the refresh's own json.dump arguments.

It never changes data/legislators.json, data/vacancies.json or anything else,
and a second run with the same inputs writes the same bytes.

Usage (from the repo root):
    python3 scripts/seed-departed-members.py --since 2025-01-03 --today 2026-11-13 \
        [--historical PATH]   # default: download the public file
"""
import json
import os
import sys
import tempfile
import urllib.request
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from member_entry import member_entry  # noqa: E402
from member_turnover import departed_problems, departed_records  # noqa: E402

HISTORICAL_URL = 'https://unitedstates.github.io/congress-legislators/legislators-historical.json'


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def main():
    since, today = arg('--since'), arg('--today')
    if not since or not today:
        print('::error::--since YYYY-MM-DD and --today YYYY-MM-DD are both required; nothing was written.')
        return 2
    date.fromisoformat(since), date.fromisoformat(today)
    path = arg('--historical')
    if not path:
        path = os.path.join(tempfile.mkdtemp(), 'legislators-historical.json')
        print(f'downloading {HISTORICAL_URL}')
        urllib.request.urlretrieve(HISTORICAL_URL, path)
    historical = json.load(open(path))
    historical_by_id = {h['id']['bioguide']: h for h in historical if h.get('id', {}).get('bioguide')}

    current = json.load(open('data/legislators.json'))
    prev_departed = json.load(open('data/departed-members.json'))
    sitting = {m['bioguide'] for m in current}
    left = [
        h for h in historical
        if since < h['terms'][-1]['end'] <= today and h['id']['bioguide'] not in sitting
    ]
    entries = [member_entry(h, []) for h in left]

    departed, undated = departed_records(current, current + entries, prev_departed, historical_by_id, today)
    problems = departed_problems(departed, current)
    if problems or undated:
        for p in problems:
            print(f'::error::{p}')
        for b in undated:
            print(f'::error::{b} has no end date in the historical file')
        print('::error::nothing was written.')
        return 1
    if departed != prev_departed:
        json.dump(departed, open('data/departed-members.json', 'w'), ensure_ascii=False, indent=2)
    print(f'departed-members.json: {len(departed)} member(s) kept as a record ({len(left)} found in the historical file)')
    for r in departed:
        print(f"  {r['bioguide']}  {r['type']}  {r['state']}{'' if r['district'] is None else '-' + str(r['district'])}  served_until {r['served_until']}  {r['name']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())

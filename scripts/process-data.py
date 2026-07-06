"""Build data/legislators.json, data/zip-districts.json, and data/vacancies.json.

With --download, fetches the public-domain sources first (CI mode);
otherwise expects the raw files already present in data/.

Vacancy handling (docs/ideation/2026-07-05-build-gtm-strategy.md §9.1(f)):
see scripts/vacancy_diff.py for why this exists and how it's derived. The
short version - a departed member just disappears from
legislators-current.json with no "vacant" marker, so this script diffs seat
sets (never a member's own stale term data) against the currently-committed
data/legislators.json + data/vacancies.json to notice, and refuses to commit
(exit 1) if more seats vanish at once than looks like real churn.
"""
import json, csv, sys, os, urllib.request
from collections import defaultdict
from datetime import datetime, timezone

from vacancy_diff import ANOMALOUS_SHRINK_THRESHOLD, compute_vacancies

DOWNLOAD = '--download' in sys.argv
SOURCES = {
    'data/legislators-raw.json': 'https://unitedstates.github.io/congress-legislators/legislators-current.json',
    'data/district-offices-raw.json': 'https://unitedstates.github.io/congress-legislators/legislators-district-offices.json',
    'data/zccd.csv': 'https://raw.githubusercontent.com/OpenSourceActivismTech/us_zipcodes_congress/master/zccd.csv',
}

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

out = []
for l in legs:
    t = l['terms'][-1]
    bid = l['id']['bioguide']
    offs = [
        {'city': o.get('city'), 'state': o.get('state'), 'phone': o.get('phone')}
        for o in office_map.get(bid, []) if o.get('phone')
    ]
    out.append({
        'bioguide': bid,
        'name': l['name'].get('official_full') or (l['name']['first'] + ' ' + l['name']['last']),
        'first': l['name']['first'],
        'last': l['name']['last'],
        'type': t['type'],  # sen | rep
        'state': t['state'],
        'district': t.get('district'),
        'party': t.get('party'),
        'phone': t.get('phone'),
        'url': t.get('url'),
        'offices': offs,
    })
json.dump(out, open('data/legislators.json', 'w'), ensure_ascii=False)
print('legislators.json:', len(out), 'members,', sum(1 for m in out if m['offices']), 'with district offices')

# Vacancy-diff step. Never infers occupancy from any one legislator's own
# term data (the footgun this replaces) - purely a seat-set comparison
# against what the currently-committed data already expects. See
# scripts/vacancy_diff.py for the derivation and scripts/test_vacancy_diff.py
# for the departed-member / vacant-no-successor / anomalous-shrink fixtures.
today = datetime.now(timezone.utc).date().isoformat()
vacancies, newly_detected, anomalous = compute_vacancies(out, prev_legislators, prev_vacancies, today)
json.dump(vacancies, open('data/vacancies.json', 'w'), ensure_ascii=False, indent=2)
print(
    f'vacancies.json: {len(vacancies)} currently vacant seat(s),',
    f'{len(newly_detected)} newly detected this run',
)

for v in newly_detected:
    print(
        f"::warning::Newly detected vacant seat: {v['state']}-{v['district']} "
        "(no representative in this week's pull - never backfilled from a "
        "departed member's stale term record; see data/vacancies.json)"
    )

github_output = os.environ.get('GITHUB_OUTPUT')
if github_output:
    with open(github_output, 'a') as f:
        f.write(f"anomalous_vacancy_shrink={'true' if anomalous else 'false'}\n")
        f.write('newly_detected_vacancies<<VACANCY_EOF\n')
        f.write(json.dumps(newly_detected))
        f.write('\nVACANCY_EOF\n')

if anomalous:
    print(
        f'::error::{len(newly_detected)} House seat(s) vanished in a single run '
        f'(> {ANOMALOUS_SHRINK_THRESHOLD}): '
        + ', '.join(f"{v['state']}-{v['district']}" for v in newly_detected)
    )
    print(
        '::error::This looks like a truncated or broken upstream fetch, not '
        f'{len(newly_detected)} simultaneous real vacancies - refusing to '
        'commit. If this is genuinely correct, review data/vacancies.json '
        'manually and re-run.'
    )
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

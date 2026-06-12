"""Build data/legislators.json and data/zip-districts.json.

With --download, fetches the public-domain sources first (CI mode);
otherwise expects the raw files already present in data/.
"""
import json, csv, sys, urllib.request
from collections import defaultdict

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

zips = defaultdict(list)
with open('data/zccd.csv') as f:
    for row in csv.DictReader(f):
        pair = {'state': row['state_abbr'], 'district': int(row['cd'])}
        if pair not in zips[row['zcta']]:
            zips[row['zcta']].append(pair)
json.dump(dict(zips), open('data/zip-districts.json', 'w'))
print('zip-districts.json:', len(zips), 'ZIPs')

if DOWNLOAD:
    import os
    for path in SOURCES:
        os.remove(path)

import json, csv
from collections import defaultdict

legs = json.load(open('data/legislators-raw.json'))
offices_raw = json.load(open('data/district-offices-raw.json'))
office_map = {o['id']['bioguide']: o['offices'] for o in offices_raw}

out = []
for l in legs:
    t = l['terms'][-1]
    if t.get('end', '9999') < '2026-06-12':
        continue
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
        'district': t.get('district'),  # None for senators
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
multi = sum(1 for v in zips.values() if len(v) > 1)
print('zip-districts.json:', len(zips), 'ZIPs,', multi, 'span multiple districts')

"""One member's entry in data/legislators.json, from one congress-legislators
record. Moved out of scripts/process-data.py unchanged (2026-11-13) so that
scripts/seed-departed-members.py builds the members who left this Congress
with exactly the code the weekly refresh uses, never a second copy of it.

Pure: no file I/O, no network.
"""


def member_entry(l: dict, offices: list) -> dict:
    """`l` is a congress-legislators record (current or historical file);
    `offices` its entries from the district-offices file ([] when none)."""
    t = l['terms'][-1]
    bid = l['id']['bioguide']
    offs = [
        {'city': o.get('city'), 'state': o.get('state'), 'phone': o.get('phone')}
        for o in offices if o.get('phone')
    ]
    entry = {
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
    }
    # The Senate's roll-call XML identifies senators by LIS member id only,
    # never bioguide, so scripts/sync-votes.mjs joins on this. Senators only:
    # a House member has no LIS id to carry.
    if t['type'] == 'sen' and l['id'].get('lis'):
        entry['lis'] = l['id']['lis']
    return entry

"""Member turnover for the weekly legislators refresh: the drop check and the
record kept for members who leave.

Stage 5 of the new-Congress work (2026-11-13). Two jobs, both pure (no file
I/O, no network) so scripts/test_member_turnover.py drives them with
fixtures, the same split scripts/vacancy_diff.py keeps with process-data.py.

1. THE DROP CHECK. scripts/vacancy_diff.py fails the run when more than five
   House SEATS empty at once. It never looked at members: a file that kept
   every seat but swapped many of the people in them (a wrong snapshot, an
   old roster republished) would have committed, and the Senate is outside
   it by construction. So this module adds two checks, and the first one
   carries the turnover allowance:

     - more than MEMBER_DROP_THRESHOLD members leave the file in one run:
       a damaged or wrong file on an ordinary week, so the run fails. EXCEPT
       inside the turnover window (the first TURNOVER_WINDOW_DAYS days from
       Jan 3 of an odd year, when every House term and a third of the Senate
       end at once and around 80 members change in one run). Inside the
       window the drop count alone is allowed, because the two seat checks
       still run: no more than five House seats may newly empty (vacancy_diff)
       and no more than five Senate seats may (below). Members may change;
       seats may not quietly vanish.
     - more than SEAT_SHRINK_THRESHOLD Senate seats empty at once (a state's
       count of senators falls): fails in every week, window or not.

   The window is a date rule, not a switch anyone flips: the Twentieth
   Amendment ends every House term at noon on Jan 3 of an odd year, so the
   allowance opens on that day and closes by itself. It names no Congress.

2. THE RECORD OF MEMBERS WHO LEFT (data/departed-members.json). When a
   member leaves the file, the page at /reps/<bioguide> has nothing to read
   (CLAUDE.md's plan pin P35). This keeps the minimum a record page needs,
   taken from the member file as it stood before the run (never from a
   stale term): who they were, the chamber, state and district they held,
   the party the record listed, and `served_until`, the end date of their
   last term from the congress-legislators project's legislators-historical
   file (the same project and file scripts/sync-votes.mjs already reads for
   names). Never a phone number, an office, a website or a contact form: a
   departed member's page must not read as a live call (hard rule 6).

   `served_until` is null when the historical file does not list the member
   yet (the volunteers who keep it can lag); a later run fills it. The site
   builds a page only for a record whose `served_until` is the last day of a
   Congress on lib/congress.mjs's ended list, because that is the only date
   the approved wording states ("Served in the {chamber} until January 3,
   2027."). A member who left mid-term keeps a record here and no page.
"""
from datetime import date, timedelta
from typing import Dict, Iterable, List, Optional, Tuple

# Same number, same reasoning as vacancy_diff.ANOMALOUS_SHRINK_THRESHOLD: five
# members leaving the file in one ordinary week is not churn, it is a broken
# or wrong download.
MEMBER_DROP_THRESHOLD = 5
SEAT_SHRINK_THRESHOLD = 5

# Six weeks from Jan 3 of an odd year. Long enough for a member file that
# updates days late and for a re-run or two on the switch week; short enough
# that the allowance is closed again by mid-February.
TURNOVER_WINDOW_DAYS = 42

# Only these leave the member file when a member leaves; everything that
# could reach a visitor as a way to contact them is left behind.
DEPARTED_FIELDS = ('bioguide', 'name', 'first', 'last', 'type', 'state', 'district', 'party')
FORBIDDEN_FIELDS = ('phone', 'url', 'offices', 'address', 'contact_form', 'lis')


def term_change_day(year: int) -> Optional[date]:
    """Jan 3 of an odd year (the day every House term ends and begins), or
    None for an even year."""
    return date(year, 1, 3) if year % 2 == 1 else None


def in_turnover_window(today: str) -> bool:
    """True from Jan 3 of an odd year through the next TURNOVER_WINDOW_DAYS - 1
    days, the only weeks a large member drop is expected."""
    d = date.fromisoformat(today)
    start = term_change_day(d.year)
    return start is not None and start <= d < start + timedelta(days=TURNOVER_WINDOW_DAYS)


def senate_seat_counts(members: Iterable[dict]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for m in members:
        if m.get('type') == 'sen':
            counts[m['state']] = counts.get(m['state'], 0) + 1
    return counts


def senate_seats_lost(new_members: List[dict], prev_members: List[dict]) -> List[Tuple[str, int]]:
    """(state, seats lost) for every state whose count of senators fell."""
    before = senate_seat_counts(prev_members)
    now = senate_seat_counts(new_members)
    return sorted((s, n - now.get(s, 0)) for s, n in before.items() if now.get(s, 0) < n)


def dropped_members(new_members: List[dict], prev_members: List[dict]) -> List[dict]:
    """Members the committed file listed and this run's file does not."""
    now = {m['bioguide'] for m in new_members}
    return [m for m in prev_members if m['bioguide'] not in now]


def duplicate_ids(members: Iterable[dict]) -> List[str]:
    """Bioguide ids listed more than once in one member file."""
    seen, dup = set(), []
    for m in members:
        b = m.get('bioguide')
        if b in seen and b not in dup:
            dup.append(b)
        seen.add(b)
    return dup


def parse_accept_departures(value: Optional[str]) -> Optional[int]:
    """The --accept-departures value: a whole number above zero, or None when
    it was not given. Anything else is refused, so a typo never reads as
    'accept everything'."""
    if value is None or value == '':
        return None
    if not value.isdigit() or int(value) < 1:
        raise ValueError(f'--accept-departures must be a whole number above zero, got {value!r}')
    return int(value)


def roster_problems(
    new_members: List[dict],
    prev_members: List[dict],
    today: str,
    accept_departures: Optional[int] = None,
) -> List[str]:
    """Why this run's member file looks damaged, or [] when it does not.

    The House seat check stays in vacancy_diff.compute_vacancies; process-data.py
    fails on either.

    `accept_departures` is the one deliberate way past a refusal: a person who
    has checked that exactly N named members really left this week re-runs
    the workflow with that number (docs/runbooks/new-congress-switch.md, "A
    refused week"). It applies only when exactly N members left the file -
    never "up to N" - and then lets through what those N departures can
    explain: the member drop, and no more than N emptied seats (the Senate
    here, the House in process-data.py with accepts_seats). A duplicate
    member is never accepted. The scheduled run never passes it, and once the
    accepted file is committed the next run compares against it, so the
    allowance does not carry over."""
    problems = []
    dropped = dropped_members(new_members, prev_members)
    accepted = accept_departures is not None and len(dropped) == accept_departures
    dup = duplicate_ids(new_members)
    if dup:
        problems.append(f'{len(dup)} member(s) listed more than once in the member file: ' + ', '.join(dup[:20]))
    lost = senate_seats_lost(new_members, prev_members)
    lost_total = sum(n for _, n in lost)
    if lost_total > SEAT_SHRINK_THRESHOLD and not (accepted and lost_total <= accept_departures):
        problems.append(
            f'{lost_total} Senate seat(s) emptied in a single run (> {SEAT_SHRINK_THRESHOLD}): '
            + ', '.join(f'{s} -{n}' for s, n in lost)
        )
    if len(dropped) > MEMBER_DROP_THRESHOLD and not in_turnover_window(today) and not accepted:
        names = ', '.join(m['bioguide'] for m in dropped[:20]) + (' ...' if len(dropped) > 20 else '')
        problems.append(
            f'{len(dropped)} member(s) left the file in a single run (> {MEMBER_DROP_THRESHOLD}) outside the '
            f'{TURNOVER_WINDOW_DAYS}-day window that opens on Jan 3 of an odd year: {names}'
            + (f' (accept_departures was {accept_departures}, not {len(dropped)})' if accept_departures is not None else '')
        )
    return problems


def accepts_seats(new_members: List[dict], prev_members: List[dict], accept_departures: Optional[int], seats: int) -> bool:
    """Does accept_departures let `seats` newly emptied seats through? Only
    when exactly that many members left and the seats are no more than them."""
    n = len(dropped_members(new_members, prev_members))
    return accept_departures is not None and n == accept_departures and seats <= n


def refusal_report(problems: List[str], dropped: List[dict], today: str) -> str:
    """The body of the GitHub issue a refused refresh opens or comments on:
    what was refused, in plain words, and the one way to accept it when there
    is one. Rendered here (pure, tested), written by process-data.py."""
    n = len(dropped)
    lines = [
        f'The weekly members refresh of {today} (UTC) was **refused**. Nothing in `data/` was written or committed; '
        'the site keeps last week\'s members until a run passes.',
        '',
        '## What was refused',
        '',
        *[f'- {p}' for p in problems],
        '',
        '## What to do',
        '',
    ]
    acceptable = n > 0 and not any('more than once' in p for p in problems)
    if acceptable:
        lines += [
            f'{n} members left the member file at once. On an ordinary week that looks like a damaged or wrong file, '
            'so the run stops. Every later run compares against the same committed file, so **it will keep refusing '
            'until someone decides**:',
            '',
            '1. Check that these members really left (the House Clerk and Senate pages, or the news): '
            + ', '.join(f"{m['name']} ({m['bioguide']})" for m in dropped[:30]) + ('...' if n > 30 else '') + '.',
            f'2. If they did, accept exactly this week: `gh workflow run refresh-legislators.yml --ref main -f accept_departures={n}`. '
            f'It passes only if exactly {n} members left and no more than {n} seats emptied; their empty seats are then '
            'recorded as vacant as usual.',
            '3. If they did not, do nothing: the upstream file is wrong, and a later run passes once it is fixed.',
        ]
    else:
        lines += [
            'Either no member left (seats emptied without anyone leaving the file) or a member is listed twice. '
            'Neither is accepted by any input: the upstream file is damaged. Wait for it to be fixed; the next run '
            'passes on its own once it is.',
        ]
    lines += ['', 'Steps and commands: `docs/runbooks/new-congress-switch.md`, "A refused week".', '']
    return '\n'.join(lines)


def last_term_end(historical_by_id: Dict[str, dict], bioguide: str) -> Optional[str]:
    """The end date of the member's last term in the historical file, or None."""
    rec = historical_by_id.get(bioguide)
    terms = (rec or {}).get('terms') or []
    end = terms[-1].get('end') if terms else None
    try:
        return date.fromisoformat(end).isoformat() if isinstance(end, str) else None
    except ValueError:
        return None


def departed_records(
    new_members: List[dict],
    prev_members: List[dict],
    prev_departed: List[dict],
    historical_by_id: Optional[Dict[str, dict]],
    today: str,
) -> Tuple[List[dict], List[str]]:
    """The next data/departed-members.json, and the bioguides still missing a
    `served_until` (for a ::warning).

    - a member who left the file this run is added, from their record in the
      committed member file, with `left_file` = today;
    - a record already kept stays as it is, except that a missing
      `served_until` is filled when the historical file now has it;
    - a member who is back in the file (re-elected after a gap, appointed)
      leaves this list: the member file is the one source for a sitting
      member.
    Sorted by bioguide, so a run with nothing to add rewrites the same bytes.
    `historical_by_id` is None when the historical file was not read.
    """
    now = {m['bioguide'] for m in new_members}
    hist = historical_by_id or {}
    kept: Dict[str, dict] = {}
    for r in prev_departed:
        if r['bioguide'] in now:
            continue
        r = dict(r)
        if r.get('served_until') is None:
            r['served_until'] = last_term_end(hist, r['bioguide'])
        kept[r['bioguide']] = r
    for m in dropped_members(new_members, prev_members):
        if m['bioguide'] in kept:
            continue
        rec = {k: m.get(k) for k in DEPARTED_FIELDS}
        rec['served_until'] = last_term_end(hist, m['bioguide'])
        rec['left_file'] = today
        kept[m['bioguide']] = rec
    out = [kept[b] for b in sorted(kept)]
    return out, [r['bioguide'] for r in out if r['served_until'] is None]


def departed_problems(departed: List[dict], new_members: List[dict]) -> List[str]:
    """Structural check of the departed list before it is written. The same
    rules tests/departed-members.unit.spec.ts applies to the committed file."""
    import re

    problems = []
    now = {m['bioguide'] for m in new_members}
    seen = set()
    allowed = set(DEPARTED_FIELDS) | {'served_until', 'left_file'}
    for r in departed:
        b = r.get('bioguide')
        if not isinstance(b, str) or not re.fullmatch(r'[A-Z]\d{6}', b):
            problems.append(f'departed record with a malformed bioguide: {r!r}')
            continue
        if b in seen:
            problems.append(f'{b} is listed twice')
        seen.add(b)
        if b in now:
            problems.append(f'{b} is in the member file and the departed list at once')
        extra = set(r) - allowed
        if extra:
            problems.append(f'{b} carries fields a departed record never keeps: {sorted(extra)}')
        if r.get('type') not in ('rep', 'sen'):
            problems.append(f'{b} has no chamber')
        if not isinstance(r.get('state'), str) or not re.fullmatch(r'[A-Z]{2}', r.get('state') or ''):
            problems.append(f'{b} has no two-letter state')
        if not r.get('name'):
            problems.append(f'{b} has no name')
        for k in ('served_until', 'left_file'):
            v = r.get(k)
            if v is not None and not (isinstance(v, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', v)):
                problems.append(f'{b} {k} {v!r} is not YYYY-MM-DD')
        if not r.get('left_file'):
            problems.append(f'{b} has no left_file date')
    return problems

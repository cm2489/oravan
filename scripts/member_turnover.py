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
   yet (the volunteers who keep it can lag); a later run fills it.

3. WHICH DATES A PAGE MAY PRINT (hard rule 6: no date the record does not
   hold). The historical file is kept by volunteers, and on 2026-11-13 it was
   a day off for five of the sixteen members who left the 119th Congress
   mid-term. So a record carries `served_until_source`:

     - an official source ({"kind": "house-clerk" | "bioguide", "url",
       "read"}) when the date was set from the Clerk of the House's vacancy
       list or the Biographical Directory of the United States Congress. The
       dates come from the committed table data/departure-dates.json, which
       a person fills from those two places in a pull request (runbook: "A
       member left mid-term: confirm the date");
     - null when the date is still the historical file's alone.

   The site (lib/departed-members.ts) gives a mid-term departure a record
   page ("Served in the House until April 21, 2026.") only with an official
   source. A NEW mid-term departure is recorded with the file's date and a
   null source, so it gets no page (the not-found page, as before) until the
   table confirms it; the refresh says so in its log and opens an issue
   (attention_report).

   A table entry is applied only to the departure it was written for
   (official_mismatch): its day must be within a day of the historical
   file's, and not before the start of the member's last term (so an entry
   left over from an earlier departure is never reused when a member who
   returned leaves again). An entry that does not fit, or one for a member
   who is sitting again, is not applied and is reported.

   WHAT REACHES A PERSON (attention, attention_report), in the run where it
   happens, through one open issue labeled departure-date-unconfirmed:
     - a member left this run and the historical file has no day for them
       yet (they wait; the next runs print only the "undated" warning);
     - a mid-term day became known this run without an official source:
       the member left this run with a day, or a record stored without a
       day got one (the historical file listed them late);
     - a table entry that does not fit its departure, and a table entry for
       a sitting member: reported on every run until the table is fixed.

   The change of Congress is told apart by its date: Jan 3 of an odd year
   (is_term_change_day) is fixed by the Twentieth Amendment and has its own
   approved sentence, so a record ending that day needs no table entry and
   is never reported as unconfirmed.
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

# A FILE THAT IS BROKEN, NOT CHURNING (re-check of stage 5, 2026-11-13). An
# empty or badly short upstream file once produced a refusal report telling
# the reader to accept every member as departed (accept_departures=539),
# which would have written a member file with nobody in it. Below this floor
# the run is refused and NOTHING accepts it: the file is broken, and the
# first run after it is fixed passes on its own.
#
# A large drop outside the window is NOT treated as broken (second review,
# 2026-11-13): if the change of Congress is still uncommitted after Feb 13 of
# an odd year (say, after weeks of refusals for another reason), its ~80 real
# departures must stay acceptable with accept_departures=80, as they are on
# main. The floor alone closes the empty-file hole.
#
# MIN_PLAUSIBLE_MEMBERS: the full roster is 541 (100 senators, 435
# representatives, 6 delegates and the resident commissioner's seat among
# them). Counted from the congress-legislators historical and current files
# on 2026-11-13, the fewest members serving on any ordinary Monday since 1995
# was 534 (Feb 2008). 500 leaves room for some thirty vacancies more than
# that record and still refuses a truncated file, in any week, January
# included (a file caught between one Congress's members leaving and the
# next one's arriving is exactly what this should refuse).
MIN_PLAUSIBLE_MEMBERS = 500

# The window in words, for messages: Jan 3 through its last day.
_WINDOW_LAST = date(2001, 1, 3) + timedelta(days=TURNOVER_WINDOW_DAYS - 1)
WINDOW_WORDS = (
    f'the {TURNOVER_WINDOW_DAYS}-day window from Jan 3 through {_WINDOW_LAST.strftime("%b")} {_WINDOW_LAST.day} '
    "of an odd year (by the run's UTC date)"
)

# Only these leave the member file when a member leaves; everything that
# could reach a visitor as a way to contact them is left behind.
DEPARTED_FIELDS = ('bioguide', 'name', 'first', 'last', 'type', 'state', 'district', 'party')
# The order every record is written in (a stable file diff).
RECORD_ORDER = DEPARTED_FIELDS + ('served_until', 'served_until_source', 'left_file')
SOURCE_KINDS = {
    'house-clerk': 'https://clerk.house.gov/Members/ViewVacancies',
    'bioguide': 'https://bioguide.congress.gov/search/bio/',
}
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


def broken_file(new_members: List[dict]) -> Optional[str]:
    """Why this run's member file looks broken rather than churning, or None.
    A broken file is refused in every week and is never acceptable."""
    if len(new_members) < MIN_PLAUSIBLE_MEMBERS:
        return (
            f'the upstream member file looks broken: it lists {len(new_members)} member(s), and a complete one '
            f'lists about 540 (refused below {MIN_PLAUSIBLE_MEMBERS})'
        )
    return None


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
    broken = broken_file(new_members)
    if broken:
        problems.append(broken)
    accepted = (
        accept_departures is not None
        and len(dropped) == accept_departures
        and not broken
    )
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
            f'{len(dropped)} member(s) left the file in a single run (> {MEMBER_DROP_THRESHOLD}) outside '
            f'{WINDOW_WORDS}: {names}'
            + (f' (accept_departures was {accept_departures}, not {len(dropped)})' if accept_departures is not None else '')
        )
    return problems


def accepts_seats(new_members: List[dict], prev_members: List[dict], accept_departures: Optional[int], seats: int) -> bool:
    """Does accept_departures let `seats` newly emptied seats through? Only
    when exactly that many members left, the seats are no more than them, and
    the file is not broken (at least MIN_PLAUSIBLE_MEMBERS members)."""
    n = len(dropped_members(new_members, prev_members))
    return accept_departures is not None and n == accept_departures and seats <= n and broken_file(new_members) is None


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
    broken = any('looks broken' in p for p in problems)
    acceptable = n > 0 and not broken and not any('more than once' in p for p in problems)
    if broken:
        lines += [
            'The upstream member file looks broken, not like members leaving. **Accept nothing**: no '
            '`accept_departures` number lets this file through. Wait for the congress-legislators project to fix it; '
            'the first run after that passes on its own.',
        ]
    elif acceptable:
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
            'No `accept_departures` number accepts this file: either no member left (seats emptied without anyone '
            'leaving the file) or a member is listed twice. The upstream file is damaged: wait for it to be fixed; '
            'the next run passes on its own once it is.',
        ]
    lines += ['', 'Steps and commands: `docs/runbooks/new-congress-switch.md`, "A refused week".', '']
    return '\n'.join(lines)


def is_term_change_day(day: Optional[str]) -> bool:
    """Jan 3 of an odd year: the day every House term ends (Twentieth
    Amendment). A departure that day is the change of Congress, not a
    mid-term departure."""
    if not day:
        return False
    try:
        d = date.fromisoformat(day)
    except ValueError:
        return False
    return term_change_day(d.year) == d


def real_day(v) -> bool:
    """A real calendar day written YYYY-MM-DD (2026-02-30 is not one)."""
    import re

    if not (isinstance(v, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', v)):
        return False
    try:
        date.fromisoformat(v)
    except ValueError:
        return False
    return True


# The fields a data/departure-dates.json entry may carry. `overrides_file_day`
# is optional and deliberate: see official_mismatch.
ENTRY_FIELDS = {'bioguide', 'served_until', 'source'}
ENTRY_OPTIONAL = {'overrides_file_day'}


def entry_problems(e) -> List[str]:
    """Why one table entry cannot be used, or []."""
    import re

    if not isinstance(e, dict):
        return [f'an entry is not an object: {e!r}']
    b = e.get('bioguide')
    who = b if isinstance(b, str) else repr(b)
    if not isinstance(b, str) or not re.fullmatch(r'[A-Z]\d{6}', b):
        return [f'an entry has a malformed bioguide id: {e!r}']
    out = []
    if not ENTRY_FIELDS <= set(e) or set(e) - ENTRY_FIELDS - ENTRY_OPTIONAL:
        out.append(f'{who} has fields {sorted(e)} (expected bioguide, served_until, source and, if deliberately set, overrides_file_day)')
    if not real_day(e.get('served_until')):
        out.append(f'{who} served_until {e.get("served_until")!r} is not a real day written YYYY-MM-DD')
    if 'overrides_file_day' in e and not real_day(e['overrides_file_day']):
        out.append(f'{who} overrides_file_day {e["overrides_file_day"]!r} is not a real day written YYYY-MM-DD')
    out += [f'{who} {p}' for p in source_problems(e.get('source'))]
    return out


def split_official(table) -> Tuple[Dict[str, dict], List[str]]:
    """data/departure-dates.json, checked entry by entry: the usable entries
    by bioguide, and one line per entry that cannot be used (never applied;
    the weekly refresh reports them and runs on). A bioguide listed twice is
    unusable in both entries."""
    if not isinstance(table, list):
        return {}, [f'data/departure-dates.json is not a JSON list ({type(table).__name__})']
    bad, by_id, counts = [], {}, {}
    for e in table:
        if isinstance(e, dict) and isinstance(e.get('bioguide'), str):
            counts[e['bioguide']] = counts.get(e['bioguide'], 0) + 1
    for e in table:
        problems = entry_problems(e)
        if problems:
            bad += problems
            continue
        if counts[e['bioguide']] > 1:
            if e['bioguide'] not in by_id:
                bad.append(f"{e['bioguide']} is listed {counts[e['bioguide']]} times")
            by_id[e['bioguide']] = None
            continue
        by_id[e['bioguide']] = e
    return {b: e for b, e in by_id.items() if e is not None}, bad


def official_problems(table) -> List[str]:
    """Every line split_official reports: the seed script refuses on any."""
    return [f'departure-dates: {p}' for p in split_official(table)[1]]


def source_problems(src) -> List[str]:
    """An official source: its kind, the address read, the day it was read."""
    if not isinstance(src, dict) or set(src) != {'kind', 'url', 'read'}:
        return [f'source {src!r} is not {{kind, url, read}}']
    out = []
    prefix = SOURCE_KINDS.get(src['kind'])
    if prefix is None:
        out.append(f'source kind {src["kind"]!r} is not one of {sorted(SOURCE_KINDS)}')
    elif not str(src['url']).startswith(prefix):
        out.append(f'source url {src["url"]!r} is not on {prefix}')
    if not real_day(src['read']):
        out.append(f'source read {src["read"]!r} is not a real day written YYYY-MM-DD')
    return out


def changeover(r: dict) -> bool:
    """A departure at the change of Congress: the last day is Jan 3 of an
    odd year AND the member was still in the member file that day or later.
    A member who left the file earlier keeps a scheduled term end of Jan 3
    in the historical file until a volunteer corrects it: that is a mid-term
    departure with an unconfirmed day, never the changeover (3rd review)."""
    su, left = r.get('served_until'), r.get('left_file')
    return is_term_change_day(su) and isinstance(left, str) and left >= su


def _ordered(r: dict) -> dict:
    return {k: r.get(k) for k in RECORD_ORDER}


def unconfirmed(departed: List[dict], bioguides: Iterable[str]) -> List[dict]:
    """Of the given members, the records whose mid-term date is the
    historical file's alone (no official source): no record page yet."""
    ids = set(bioguides)
    return [
        r for r in departed
        if r['bioguide'] in ids and r.get('served_until') and r.get('served_until_source') is None
        and not changeover(r)
    ]


def unconfirmed_line(r: dict) -> str:
    """The one log line for a new mid-term departure whose date is unconfirmed."""
    return (
        f"{r['name']} ({r['bioguide']}) left the member file; the volunteer historical file dates their last day "
        f"{r['served_until']}, not yet confirmed against the Clerk of the House or the Biographical Directory, "
        'so they get no record page until a pull request confirms it '
        '(docs/runbooks/new-congress-switch.md, "A member left mid-term: confirm the date")'
    )


def _seat(r: dict) -> str:
    return f"{r['state']}{'' if r.get('district') is None else '-' + str(r['district'])} {'Senate' if r['type'] == 'sen' else 'House'}"


def attention_report(found: Dict[str, list], today: str) -> str:
    """The issue body (label departure-date-unconfirmed) for what this run
    found: members whose last day still needs an official source, and table
    entries a person must fix. Every case leaves the member without a record
    page: their address shows "not found", as it did before."""
    about_members = found['undated'] or found['unconfirmed'] or found['mismatched']
    lines = [
        f'The weekly members refresh of {today} (UTC) found member(s) who left mid-term whose last day is not '
        'confirmed by an official source. **They get no record page yet**: their address shows "not found", as it '
        'did before, until a person confirms the date.'
        if about_members
        else f'The weekly members refresh of {today} (UTC) found entries in `data/departure-dates.json` that a person '
        'must fix. They are not applied to anyone; no page changes because of them.',
        '',
    ]
    if found['undated']:
        lines += ['## Left, and no date known yet', '',
                  'The volunteer historical file does not give their last day yet. Look it up in an official place '
                  'below; the next runs repeat only a warning line in the log, not this issue.', '',
                  '| Member | Seat |', '| --- | --- |',
                  *[f"| {r['name']} ({r['bioguide']}) | {_seat(r)} |" for r in found['undated']], '']
    if found['unconfirmed']:
        lines += ['## Date known from the historical file only', '',
                  '| Member | Seat | Last day in the historical file |', '| --- | --- | --- |',
                  *[f"| {r['name']} ({r['bioguide']}) | {_seat(r)} | {r['served_until']} |" for r in found['unconfirmed']], '']
    if found['mismatched']:
        lines += ['## A table entry that does not fit (not applied)', '',
                  *[f"- {r['name']} ({r['bioguide']}): {why}." for r, why in found['mismatched']],
                  '', 'Look again at the official source and correct `data/departure-dates.json`.', '']
    if found['sitting']:
        lines += ['## A table entry for a sitting member (not applied)', '',
                  *[f'- {b} is in the member file now. Remove their entry from `data/departure-dates.json`.'
                    for b in found['sitting']], '']
    if found.get('bad_entries'):
        lines += ['## A malformed entry in data/departure-dates.json (not applied)', '',
                  *[f'- {line}. Fix `data/departure-dates.json` in a pull request.' for line in found['bad_entries']], '']
    if not about_members:
        lines += ['Steps: `docs/runbooks/new-congress-switch.md`, "A member left mid-term: confirm the date".', '']
        return '\n'.join(lines)
    lines += [
        '## Confirm each date in one of the two official places',
        '',
        f"- House members: the Clerk of the House's vacancy list, {SOURCE_KINDS['house-clerk']}",
        f"- Senators (and any member): the Biographical Directory of the United States Congress, {SOURCE_KINDS['bioguide']}<bioguide id>",
        '',
        'Then add the date and the source to `data/departure-dates.json` in a pull request and run '
        '`scripts/seed-departed-members.py` (steps: `docs/runbooks/new-congress-switch.md`, '
        '"A member left mid-term: confirm the date"). The page goes live when that merges.',
        '',
    ]
    return '\n'.join(lines)


def official_mismatch(entry: dict, historical_by_id: Optional[Dict[str, dict]]) -> Optional[str]:
    """Why a data/departure-dates.json entry may NOT be applied to the
    member's departure as the historical file records it, or None when it
    fits: the historical file lists them, the entry's day is within one day
    of the file's last day, and not before the start of their last term.
    Shared by the weekly refresh and scripts/seed-departed-members.py."""
    rec = (historical_by_id or {}).get(entry['bioguide'])
    terms = (rec or {}).get('terms') or []
    file_day = last_term_end(historical_by_id or {}, entry['bioguide'])
    if not terms or file_day is None:
        return 'the historical file gives no last day for them yet, so the entry cannot be matched to this departure'
    start = terms[-1].get('start')
    if isinstance(start, str) and entry['served_until'] < start:
        return (
            f"the entry's day {entry['served_until']} is before the start of their last term ({start}): "
            'it belongs to an earlier departure'
        )
    gap = abs((date.fromisoformat(entry['served_until']) - date.fromisoformat(file_day)).days)
    if gap > 1:
        # THE OVERRIDE (3rd review, 2026-11-13). When the official day is
        # right and the volunteer file is wrong by more than a day, a person
        # may record that they looked: `overrides_file_day` set to the exact
        # day the historical file shows. It applies only while the file
        # still shows exactly that day (if the file changes, the entry is
        # reported again), never past the term-start check above, and never
        # by default: nothing writes it but a person in a pull request.
        if entry.get('overrides_file_day') == file_day:
            return None
        return (
            f"the entry says {entry['served_until']} and the historical file says {file_day}, {gap} days apart "
            '(if the official day is right and the historical file is wrong, see the runbook section '
            '"A member left mid-term: confirm the date" for the deliberate override)'
        )
    return None


def official_sitting(table: List[dict], members: List[dict]) -> List[str]:
    """Table entries for members who are in the member file now: never
    applied to anyone, reported until a person removes them."""
    now = {m['bioguide'] for m in members}
    return [e['bioguide'] for e in table if e.get('bioguide') in now]


def attention(
    departed: List[dict],
    prev_departed: List[dict],
    leaving: Iterable[str],
    official: Dict[str, dict],
    historical_by_id: Optional[Dict[str, dict]],
    members: List[dict],
    bad_entries: Optional[List[str]] = None,
) -> Dict[str, list]:
    """What this run must bring to a person (see the module header):
    `undated` (left this run, no day yet), `unconfirmed` (a mid-term day
    known this run, no official source), `mismatched` ([record, reason]),
    `sitting` (bioguide ids with a table entry who sit again)."""
    left = set(leaving)
    was_undated = {r['bioguide'] for r in prev_departed if r.get('served_until') is None}
    undated = [r for r in departed if r['bioguide'] in left and r.get('served_until') is None]
    unconfirmed_now = [
        r for r in unconfirmed(departed, left | was_undated)
        if r['bioguide'] not in official or official_mismatch(official[r['bioguide']], historical_by_id) is None
    ]
    mismatched = []
    for r in departed:
        if r.get('served_until_source') is None and r['bioguide'] in official and r.get('served_until'):
            why = official_mismatch(official[r['bioguide']], historical_by_id)
            if why:
                mismatched.append([r, why])
    return {
        'undated': undated,
        'unconfirmed': unconfirmed_now,
        'mismatched': mismatched,
        'sitting': official_sitting(list(official.values()), members),
        'bad_entries': list(bad_entries or []),
    }


def attention_lines(found: Dict[str, list]) -> List[str]:
    """One log line per item."""
    out = [
        f"{r['name']} ({r['bioguide']}) left the member file; the volunteer historical file gives no last day for "
        'them yet, so they get no record page; the issue asks a person to find the official date'
        for r in found['undated']
    ]
    out += [unconfirmed_line(r) for r in found['unconfirmed']]
    out += [
        f"{r['name']} ({r['bioguide']}): data/departure-dates.json was not applied because {why}; no record page "
        'until a person corrects the table'
        for r, why in found['mismatched']
    ]
    out += [
        f'data/departure-dates.json has an entry for {b}, who is in the member file now; it is not applied to '
        'anyone; remove it in a pull request'
        for b in found['sitting']
    ]
    out += [
        f'data/departure-dates.json: {line}; not applied to anyone; fix data/departure-dates.json in a pull request'
        for line in found.get('bad_entries', [])
    ]
    return out


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
    official: Optional[Dict[str, dict]] = None,
) -> Tuple[List[dict], List[str]]:
    """The next data/departed-members.json, and the bioguides still missing a
    `served_until` (for a ::warning).

    - a member who left the file this run is added, from their record in the
      committed member file, with `left_file` = today;
    - a record already kept stays as it is, except that a missing
      `served_until` is filled when the historical file now has it, and a
      record with no official source takes its date and source from
      `official` (data/departure-dates.json, by bioguide) once that has it;
    - a new record's date is the official one when `official` has an entry
      that fits this departure (official_mismatch), else the historical
      file's with `served_until_source` null;
    - `left_file` is the run's day: the day the refresh first found them
      gone, or, for the sixteen recorded by scripts/seed-departed-members.py
      on 2026-11-13, the day they were recorded (they had left before the
      file existed);
    - a member who is back in the file (re-elected after a gap, appointed)
      leaves this list: the member file is the one source for a sitting
      member.
    Sorted by bioguide, so a run with nothing to add rewrites the same bytes.
    `historical_by_id` is None when the historical file was not read.
    """
    now = {m['bioguide'] for m in new_members}
    hist = historical_by_id or {}
    off = official or {}
    kept: Dict[str, dict] = {}
    for r in prev_departed:
        if r['bioguide'] in now:
            continue
        r = dict(r)
        r.setdefault('served_until_source', None)
        if r.get('served_until') is None:
            r['served_until'] = last_term_end(hist, r['bioguide'])
        if (
            r['served_until_source'] is None
            and r['bioguide'] in off
            and official_mismatch(off[r['bioguide']], historical_by_id) is None
        ):
            r['served_until'] = off[r['bioguide']]['served_until']
            r['served_until_source'] = off[r['bioguide']]['source']
        kept[r['bioguide']] = _ordered(r)
    for m in dropped_members(new_members, prev_members):
        if m['bioguide'] in kept:
            continue
        rec = {k: m.get(k) for k in DEPARTED_FIELDS}
        if m['bioguide'] in off and official_mismatch(off[m['bioguide']], historical_by_id) is None:
            rec['served_until'] = off[m['bioguide']]['served_until']
            rec['served_until_source'] = off[m['bioguide']]['source']
        else:
            rec['served_until'] = last_term_end(hist, m['bioguide'])
            rec['served_until_source'] = None
        rec['left_file'] = today
        kept[m['bioguide']] = _ordered(rec)
    out = [kept[b] for b in sorted(kept)]
    return out, [r['bioguide'] for r in out if r['served_until'] is None]


def departed_problems(departed: List[dict], new_members: List[dict]) -> List[str]:
    """Structural check of the departed list before it is written. The same
    rules tests/departed-members.unit.spec.ts applies to the committed file."""
    import re

    problems = []
    now = {m['bioguide'] for m in new_members}
    seen = set()
    allowed = set(RECORD_ORDER)
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
            if v is not None and not real_day(v):
                problems.append(f'{b} {k} {v!r} is not a real day written YYYY-MM-DD')
        if not r.get('left_file'):
            problems.append(f'{b} has no left_file date')
        if r.get('served_until_source') is not None:
            problems += [f'{b} served_until_source: {p}' for p in source_problems(r['served_until_source'])]
    return problems

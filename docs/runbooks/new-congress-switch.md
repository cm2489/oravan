# New Congress switch week: members, seats and districts

The 119th Congress ends at noon on Sunday, Jan 3, 2027, and the members elected on Nov 3, 2026 are sworn in. The owner set the switch for **Monday, Jan 4, 2027, before the nightly** (decision of 2026-11-12). This page is the member half of that switch: the member file, the empty-seat check, the pages of members who left, and what has to change in the district lookup. The bill half (ended bills, the tracked-Congress number) is stage 8 of the new-Congress plan and has its own steps.

Written 2026-11-13 with stage 5. Every command below was run, or dry-run on a copy, on 2026-11-13 from the repo root on macOS, unless it says **Not run**, with the reason. Times are US Eastern (ET); GitHub runs on UTC.

## What changes by itself, and what does not

- **Pages of members who left** appear when two things are both true: `lib/congress.mjs` lists the 119th as ended (stage 8 does this), and `data/departed-members.json` holds their record with `served_until` = `2027-01-03` (the weekly refresh writes it when they leave the member file). Each page shows the seat they held, "Served in the House until January 3, 2027." (or Senate) and how they voted, with no phone, office, website or call. Rules: `lib/departed-members.ts`.
- **New members with no recorded vote** show "No recorded votes yet in the 120th Congress." once the 119th is on the ended list. Delegates and the resident commissioner keep today's line.
- **Nothing in the ZIP lookup, the address lookup or the Census settings changes by itself.** Those are steps 6 and 7.
- **The refresh's checks**: around 80 members change at once. More than 5 members leaving the file in one run fails the run on an ordinary week; from Jan 3 of an odd year through the next 42 days it is allowed, because two seat checks still run every week: no more than 5 House seats may newly empty, and no more than 5 Senate seats may. A member listed twice always fails. If any check fails, the run writes nothing, commits nothing, and opens or comments on one GitHub issue labeled `legislators-refused` (see "A refused week" below). Code: `scripts/member_turnover.py`, `scripts/vacancy_diff.py`.

## The steps

### 1. Check the public member file has switched to the 120th

The members come from the congress-legislators project's file, kept by volunteers. It may update hours or days after Jan 3. Until it does, the site keeps showing last week's members. That is the honest fallback.

```sh
curl -s https://unitedstates.github.io/congress-legislators/legislators-current.json | python3 -c "import json,sys,collections; d=json.load(sys.stdin); print(len(d), 'members;', dict(collections.Counter((l['terms'][-1]['type'], l['terms'][-1]['start'][:4]) for l in d)))"
```

**Proves it worked:** about 540 members, and nearly every `('rep', …)` entry starts in `2027` (one entry per House seat and delegate, about 441). On 2026-11-13 it printed `539 members; … ('rep', '2025'): 433 … ('rep', '2026'): 6 …`: no 2027 yet, as expected. If the House is still mostly 2025, the file has not switched: stop here and check again later. Do not go on to step 2 on a half-updated file.

**Undo:** nothing to undo; this only reads.

### 2. Rehearse the refresh on a copy (writes nothing in the repo)

The copy must be today's `main`: a stale `data/` compares against an old member file and gives a misleading result. So the command fetches first and copies `data/` and `scripts/` from `origin/main`, whatever your own checkout holds:

```sh
git fetch origin && D=$(mktemp -d) && git archive origin/main data scripts | tar -x -C "$D" && (cd "$D" && python3 scripts/process-data.py --download); echo "exit $?"
```

**Proves it worked:** `exit 0`, and lines like `legislators.json: 5xx members`, `vacancies.json: N currently vacant seat(s), M newly detected this run` and, on the switch week, `departed-members.json: K member(s) kept as a record, K left the file this run` (on a week when nobody leaves, that line is not printed). Then look at what it would commit:

```sh
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d), 'kept;', sum(r['served_until']=='2027-01-03' for r in d), 'served until 2027-01-03;', [r['bioguide'] for r in d if not r['served_until']] or 'none undated')" "$D/data/departed-members.json"
```

Run on 2026-11-13 exactly as written, the first command used `main` before stage 5 was merged (so the old script ran and the second command found no `departed-members.json`); both were then run with `origin/main` replaced by this change's commit. On that run (an ordinary week) the rehearsal printed `legislators.json: 539 members, 532 with district offices`, `vacancies.json: 2 currently vacant seat(s), 0 newly detected this run`, `zip-districts.json: 33774 ZIPs` and `exit 0`, and wrote `legislators.json`, `vacancies.json`, `zip-districts.json` and `departed-members.json` byte-identical to the committed ones; the second command printed `0 kept; 0 served until 2027-01-03; none undated`. The same rehearsal on a synthetic 120th file (80 members replaced on the same seats, `--today 2027-01-04`) printed `departed-members.json: 80 member(s) kept as a record` and exited 0; the same file with `--today 2026-11-16` was refused.

**If it fails** (`::error::` lines and `exit 1`): read the error.
- `N House seat(s) vanished` or `N Senate seat(s) emptied`: the upstream file is half-updated. Wait and repeat from step 1. **Do not loosen the check** (plan pin P34).
- `N member(s) left the file … outside the 42-day window`: the date is not in the switch window. On Jan 4, 2027 this cannot happen; on any other day see "A refused week" below.
- `listed more than once`: the upstream file is damaged. Wait for it to be fixed.

`--today YYYY-MM-DD` makes the rehearsal use another date (only for rehearsals on a copy; the workflow never passes it).

**Undo:** `rm -rf "$D"` (it is a temporary copy).

### 3. Run the real refresh

```sh
gh workflow run refresh-legislators.yml --ref main
gh run list --workflow=refresh-legislators.yml --limit 1
```

**Not run** on 2026-11-13: it runs the live weekly job on `main` and commits to it. `gh run list --workflow=refresh-legislators.yml --limit 3` was run and showed the last three Monday runs green, started at 2026-11-09 18:37 UTC (1:37 PM ET), 2026-11-02 18:06 UTC and 2026-10-26 15:03 UTC: the 08:00 UTC schedule fires hours late, so on Jan 4 run it by hand rather than wait for it.

**Proves it worked:** the run is green, and it pushed a commit named `chore(data): weekly legislators refresh 2027-01-04`. Then, after `git pull`:

```sh
node -e "const d=require('./data/departed-members.json');console.log(d.length,'kept;',d.filter(r=>r.served_until==='2027-01-03').length,'served until 2027-01-03;',d.filter(r=>!r.served_until).map(r=>r.bioguide).join(' ')||'none undated')"
```

On 2026-11-13 it printed `0 kept; 0 served until 2027-01-03; none undated`; once the 16 members who left mid-term were recorded the same day (see the end of this page), it prints `16 kept; 0 served until 2027-01-03; none undated`. After the switch it should print about 96 kept and about 80 served until 2027-01-03. A member listed as undated has no page yet; the next run fills the date once the historical file lists them (re-run step 3 a day later).

**Undo:** revert the data commit through a pull request, never a push to `main`:

```sh
git switch -c revert-legislators-refresh origin/main && git revert --no-edit <refresh-commit-sha>
git push -u origin HEAD && gh pr create --fill
```

**A revert does not stick by itself.** The next Monday run downloads the same upstream file and commits the same change again, unless the upstream file has been fixed by then. If you revert because the upstream file is wrong, check step 1 before the next Monday, or disable the workflow until it is fixed (`gh workflow disable refresh-legislators.yml`, **not run**: it changes the live repository; `gh workflow enable` undoes it).

**The commit's date is UTC.** The commit is named `chore(data): weekly legislators refresh <UTC date>`: a run started after 7 PM ET on Monday, Jan 4 is named `2027-01-05`. Look for both dates.

The first line was dry-run on 2026-11-13 in a throwaway worktree against the last refresh commit (`f41f0a48`, 2026-11-09), with `--no-commit` added so nothing was recorded: the revert applied cleanly (it staged `data/special-elections.json`), then it was aborted and the branch deleted. The second line was **not run**: it would publish a branch and a pull request.

### 4. Check the empty seats and special elections

```sh
cat data/vacancies.json
node -e "console.log(Object.keys(require('./data/special-elections.json')).join(' '))"
node -e "const l=require('./data/legislators.json');console.log(l.filter(m=>m.state==='FL'&&m.type==='rep').map(m=>m.district).sort((a,b)=>a-b).join(','))"
```

On 2026-11-13 these printed FL-20 and TX-23 (both `"since": "2026-07-05"`); `fl-20 tx-23`; and `1,2,…,19,21,…,28` (27 Florida districts, no 20).

**Proves it worked:** a seat whose 120th member is in the file is no longer listed (the vacancy heals on its own, and its special-election entry goes with it). A seat listed as newly vacant on Jan 4 has no member in the 120th file; check the House Clerk's vacancy list before believing it. **FL-20**: `data/redistricting-watch.json` says Florida's map signed 2026-05-04 "eliminates FL-20 outright". Florida still has 28 House seats, so the 120th file will name a member for a district numbered 20 unless the state renumbered (**not checked**). If the third command shows a member in district 20, the old vacancy is gone; if it shows 28 districts without a 20, FL-20 would stay listed as vacant forever and must be removed by hand in a pull request.

**Undo:** the step 3 revert.

### 5. Look at the live site

Replace `<left>` with a bioguide id from `data/departed-members.json`, `<new>` with a member from `data/legislators.json` who has no vote yet, and `<roll>` with a roll-call id from `data/votes.json` that lists `<left>`.

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://oravan.org/reps/<left>
curl -s https://oravan.org/reps/<left> | grep -c 'data-departed-served'
curl -s https://oravan.org/reps/<left> | grep -c 'href="tel:'
curl -s https://oravan.org/reps/<new> | grep -c 'data-member-votes-none-yet'
curl -s https://oravan.org/votes/<roll>.json | grep -c '"<left>"'
```

**Proves it worked:** `200`, `1`, `0`, `1`, `1`. Then open one departed page and one new member's page in both languages and read them, and look up a ZIP that one departed House member served: the lookup must name the new member, never the one who left.

On 2026-11-13 (before the switch) they were run with `<left>` = `C001078` (a member who left mid-Congress), `<new>` = `N000147` and `<roll>` = `h-119-1-6`, and printed `404`, `0`, `0`, `0`, `1`: no record page yet, and the roll-call list already names the member. As a control, the `tel:` count for a sitting member (`D000594`) printed `1`. The pages only change once both conditions at the top of this page are true.

**Undo:** a wrong page comes from the data (step 3 revert) or from stage 8 (revert that pull request).

### 6. The ZIP-to-district map (`data/zip-districts.json`)

Built every Monday by `scripts/process-data.py` from `zccd.csv` in the `OpenSourceActivismTech/us_zipcodes_congress` repository. It must describe the 120th districts from the switch on (plan pin P36). **Not changed by stage 5.**

```sh
gh api "repos/OpenSourceActivismTech/us_zipcodes_congress/commits?per_page=3" --jq '.[] | [.commit.committer.date, .commit.message[0:80]] | @tsv'
```

On 2026-11-13 the newest commit was 2026-06-30 ("update testing against MCDC Geocorr 2022"); the file's columns are `state_fips,state_abbr,zcta,cd`, with no Congress label. **Whether it already carries the 120th maps of the redrawn states was not checked.** Choosing the 120th source is stage 8; if this repository has not moved to the 120th by Jan 4, that is a decision for the owner.

**Proves it worked** (once a 120th source is in): for each state in `data/redistricting-watch.json`, pick one public landmark address (a state capitol), and check that (a) the Census geocoder's 120th layer, (b) the ZIP map for that ZIP, and (c) the member file all name the same district:

```sh
curl -s -G "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress" --data-urlencode "address=1100 Congress Ave, Austin, TX 78701" --data-urlencode "benchmark=Public_AR_Current" --data-urlencode "vintage=Current_Current" --data-urlencode "layers=120th Congressional Districts" --data-urlencode "format=json"
node -e "console.log(JSON.stringify(require('./data/zip-districts.json')['78701']))"
node -e "const l=require('./data/legislators.json');console.log(l.filter(m=>m.type==='rep'&&m.state==='TX'&&m.district===<district from the geocoder>).map(m=>m.name))"
```

The first command was **run on 2026-11-13 and refused**: the Census geocoder answered every request from this machine with a "Request Rejected" page (also for its plain benchmark list), so its reply shape for the 120th layer was not seen today. The second printed `[{"state":"TX","district":37}]`. The third was run with `37` in place of the placeholder and printed `[ 'Lloyd Doggett' ]`, today's member for TX-37.

**Undo:** revert the pull request that changed the source.

### 7. The Census vintage and the address lookup (`lib/district.ts`)

`SITTING_CONGRESS` follows `lib/congress.mjs` and moves with stage 8. `CENSUS_VINTAGE` (`'ACS2025_Current'`) must move in the same change to a vintage whose reply carries "120th Congressional Districts" (plan pins P05, P06), re-checked live that day, with the fixtures `tests/district.unit.spec.ts` pins. **Not changed by stage 5.** The check is the geocoder command in step 6 with `vintage=` set to the candidate; on 2026-09-28 an earlier session saw `Current_Current` and `ACS2026_Current` carry only the 120th layer. **Not run today** for the reason in step 6.

**Proves it worked:** on the live site, the "use my street address" refinement for a split ZIP in a redrawn state names the 120th member; `PW_NO_WEBSERVER=1 npx playwright test tests/district.unit.spec.ts --project=unit` passes with the new fixtures (run on 2026-11-13 against today's settings: 20 passed).

**Undo:** revert that pull request.

## A refused week

**What happens.** When a run is refused (any `::error::` in step 2's list), nothing is written or committed and the workflow opens one GitHub issue labeled `legislators-refused`, titled "Weekly members refresh refused: nothing committed", or comments on it if it is already open. The issue says what was refused, names the members who left, and, when it applies, gives the exact command to accept the week. **A refused week never clears by itself**: every later run compares against the same committed member file, so it refuses again until the upstream file changes or someone accepts the week.

**When six or more members really left in one ordinary week** (several resignations and swearing-ins at once):

1. Read the issue. Check every named member really left (the House Clerk's and the Senate's own pages, or the news).
2. Rehearse the acceptance on a copy, with the number of members who left:

   ```sh
   git fetch origin && D=$(mktemp -d) && git archive origin/main data scripts | tar -x -C "$D" && (cd "$D" && python3 scripts/process-data.py --download --accept-departures <N>); echo "exit $?"
   ```

   **Proves it worked:** `accept_departures=<N>: accepted; …` and `exit 0`. Run on 2026-11-13 against this change's commit with `<N>` = `7` on an ordinary week where nobody left: it printed `accept_departures=7: not used (0 member(s) left, which the checks pass without it)` and `exit 0`. The accepted case itself (7 members left, 7 accepted; 6 accepted refused) is tested end to end in `scripts/test_process_data.py`.
3. Accept it for real:

   ```sh
   gh workflow run refresh-legislators.yml --ref main -f accept_departures=<N>
   ```

   **Not run** on 2026-11-13: it runs the live job. It passes only when **exactly** `<N>` members left and no more than `<N>` seats emptied; their empty seats are recorded as vacant as usual. A member listed twice is never accepted. The scheduled run never passes the number, and once the accepted file is committed the next run compares against it, so nothing carries over.
4. Close the issue once a run is green.

**When the members did not really leave**, do nothing: the upstream file is wrong, and the first run after it is fixed passes and can be followed by closing the issue.

To see whether one is open:

```sh
gh issue list --repo cm2489/oravan --label legislators-refused --state open
```

Run on 2026-11-13: it printed nothing (none open; the label does not exist until the first refusal creates it).

**Undo:** an accepted week is a normal refresh commit; undo it as in step 3.

## What stage 5 does not cover

- **Members who left during the 119th now have record pages** (owner, 2026-11-13): "Served in the House until April 21, 2026.", with the last day from the congress-legislators historical file. The 16 who left before `data/departed-members.json` existed were recorded on 2026-11-13 by `scripts/seed-departed-members.py --since 2025-01-03 --today 2026-11-13`, through the refresh's own code; later ones are recorded by the weekly refresh. So in step 5, `<left>` must be a member whose record says `2027-01-03`: `C001078`, used there on 2026-11-13, has had a record page since.
- The MCP `get_representative` tool answers "not found" for a member who left, as today.
- If the historical file never lists a member who left, their record keeps `served_until: null` and they get no page; step 3's check names them.

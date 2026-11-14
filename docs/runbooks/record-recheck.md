# Runbook: the nightly record re-check

Each night the Moment-updates collector (`scripts/moment-updates.mjs`, nightly mode, in `sync-bills.yml`) re-reads Congress.gov's action list for every bill on a Big Question and checks every stored timeline line that quotes it. The rules live in `lib/moment-updates-recheck.mjs` (its header comment); this page is what a person does when the re-check stops.

Owner's decision behind it: answer 92 a, 2026-11-14 — *"A nightly re-check of every stored update text against the record: a line the record no longer holds is corrected to the record's words or marked withdrawn, and the run says so."*

## What a normal night looks like

The step "Collect Moment updates (Moments v2 live layer, nightly)" logs one line, `record re-check: N stored row(s) checked …, 0 change(s)`. On a night with a change, the log and the step summary name every row: corrected (old words, new words, old and new id), withdrawn, held, or reinstated. Each changed row keeps a `rechecks` log in `data/moment-updates.json`, so the change can be read back later.

## When the step goes red

The re-check never costs the night its other work: collection and "Where it stands" summaries are written either way. The step is `continue-on-error`, so the nightly carries on; the red step is the signal.

1. **"record re-check failed and changed nothing"** — the re-check threw. It wrote nothing. Read the stack in the log. Nothing to undo.
2. **"record re-check refused"** — a guard stopped the night. Nothing was changed. The guards:
   - more than 4 rows would change in one night, across every question;
   - every checked row of one bill would change (however few);
   - more than half of one bill's checked rows would change (from 3 rows up).

   These look like the source being wrong (a list for the wrong bill, a stale or short list). The refusal repeats every night until the rows age out of retention (60 days) or a person accepts them.

## Letting a real batch through for one night

Only after reading the held-back rows in the step summary and checking each against the bill's page on congress.gov ("All Actions"):

1. Create or edit `data/record-recheck-accept.json` in a pull request:

   ```json
   {
     "accept": [
       {
         "night": "2026-11-16",
         "ids": ["u_682cca41", "u_d5eaf6d9"],
         "why": "Read both against congress.gov All Actions on 2026-11-16: the record really did change these lines."
       }
     ]
   }
   ```

   - `night` is the **US Eastern** date on which that nightly run starts (read it off the run's log line `moment-updates: mode=nightly, ET day …`). It applies to that night only.
   - `ids` are the row ids exactly as the refused run printed them (the id before any correction).
   - `why` is one sentence saying what was checked.
2. Merge it before that night's run. CI's `check-moment-updates` refuses a malformed file, and a malformed file accepts nothing.
3. Accepted rows are left out of the guard counts on that night only. The run still applies the same rules to them and logs them as "accepted for tonight".
4. Remove the entry afterwards (it does nothing on any other night).

The override cannot be set by accident: it takes a reviewed commit naming one night and the exact rows.

## Lines left as they are

A warning `record re-check: … left as it is — …` means the re-check saw a difference it would not resolve by itself: two possible matches, a change that would alter an outcome, a number or a chamber, an action that moved to another date, a list missing that day, or a line naming an amendment whose own record could not be read. The stored line stays as it is. If the record really changed it, correct it by hand in a reviewed pull request that edits nothing else.

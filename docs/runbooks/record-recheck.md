# Runbook: the nightly record re-check

Each night the Moment-updates collector (`scripts/moment-updates.mjs`, nightly mode, in `sync-bills.yml`) re-reads Congress.gov's action list for every bill on a Big Question and checks every stored timeline line that quotes it. The rules live in `lib/moment-updates-recheck.mjs` (its header comment); this page is what a person does when the re-check stops.

Owner's decision behind it: answer 92 a, 2026-11-14 — *"A nightly re-check of every stored update text against the record: a line the record no longer holds is corrected to the record's words or marked withdrawn, and the run says so."*

## The switch: report only, or apply

`RECHECK_MODE` in `lib/moment-updates-recheck.mjs` is one committed line.

- **`'report'` (as shipped, 2026-11-14): report only.** The nightly comparison runs in full and writes nothing to `data/moment-updates.json`. It lists every stored line it would change and every line it would leave, with what the record holds now, in the log, in the step summary's table, and in `data/record-recheck-report.json`. Pipeline-health raises them as alarms (below).
- **`'apply'`: automatic correction.** The comparison corrects, withdraws or holds lines as its rules say, and still reports what it leaves.

Turning correction on is a one-line pull request changing `'report'` to `'apply'`, merged only after an independent check has passed the automatic correction.

## What a normal night looks like

The step "Collect Moment updates (Moments v2 live layer, nightly)" logs one line, `record re-check (REPORT ONLY …)` or `record re-check (apply)`, with how many stored lines it checked, how many would change or changed, and how many it left. On a night with a change, the log and the step summary name every row: corrected (old words, new words, old and new id), withdrawn, held, or reinstated. Each changed row keeps a `rechecks` log in `data/moment-updates.json`, so the change can be read back later.

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

## Held rows

A **held** row is one whose record words changed to a sentence Oravan may not print as it stands: quoted, the record's new words fail the update lint (a forecast phrase such as "expected to" or "set to" is refused even inside a quote, the same rule that keeps a freshly collected action with those words out of the file). The row stores the record's new words and is hidden. Every night the collector asks for a plain-language line of those words; the first one that passes the lint is printed and the row shows again by itself.

While a row is held, every nightly run prints a warning naming it (`… is HELD since …`), and the pipeline-health report raises it on its standing issue every morning.

**The fix, when a row stays held for more than a night or two:**

1. Check the nightly log for `ANTHROPIC_API_KEY unset` or decode errors. If decodes are not running, fix that; the next nightly releases the row by itself.
2. If decodes run but keep failing the lint, write the line by hand in a pull request that edits nothing else in `data/moment-updates.json`. On that row:
   - set `text.en` and `text.es` to one plain sentence each stating what the record's words (`record.action_text`) say, with no forecast words;
   - set `"ai": false`;
   - delete `withdrawn_on`;
   - append `{ "on": "<today, US Eastern, YYYY-MM-DD>", "at": "<now, ISO>", "outcome": "reinstated" }` to `rechecks`.
3. Run `node scripts/check-moment-updates.mjs` (it must pass) and merge.

## How trouble reaches a person

The collector's step is `continue-on-error`, so the nightly run stays green whatever the comparison finds. The daily pipeline-health report (`daily-metrics.yml`, 13:00 UTC, before that day's nightly at 14:15 UTC) reads the nightly's log, `data/moment-updates.json` and `data/record-recheck-report.json`. It rewrites the standing `pipeline-health` issue's body every day and posts **one ⛔ comment a day only when there is an alarm**. For the comparison:

| What | Comment on the issue | Issue body (`record re-check` row) |
| --- | --- | --- |
| A line newly found to differ, or left for a person | **once**, the morning after the night that found it: named with its page, the stored words and what the record holds now | counted every day while it lasts |
| Lines still open | **one reminder a week** (8, 15, 22 … days after the oldest was first found) | counted every day |
| A night a guard refused or would refuse | that morning: "the source looks wrong"; **no line is named as differing** from such a night | noted |
| A bill not checked (its list failed, was rejected, or does not look like that bill's) | daily from the **3rd night running** | counted |
| A line dated after the newest action on its bill's list (the record may have deleted it) | daily from the **3rd night running** | counted |
| Nothing checked at all while there are lines to check | daily from the **2nd night running** | counted |
| Apply mode: a refused night, a re-check or follow-up that threw, a malformed accept list, a held line | that morning (held lines: daily while held) | — |

**Out of scope, never an alarm:** lines of an ended Congress's bills. After the change of Congress the collector stops reading those bills, and the comparison counts their lines as out of scope (logged), not as unchecked.

**"The source looks wrong"** means a list that names the right bill but does not hold that bill's latest action from `data/bills.json`, and on which fewer than half the stored lines it reaches stand word for word. A list whose actions carry no words in `text` (a renamed field) is not checked either.

## A line left as it is, or reported while correction is off

The alarm names the line: its question (`/questions/<id>`), its row id, the stored words, and what the record holds now. To correct it by hand:

1. Open the bill's "All Actions" on congress.gov and confirm what the record says on that date.
2. In a pull request that edits nothing else in `data/moment-updates.json`, on that row:
   - **reworded:** set `record.action_text` to the record's words exactly; set `text.en` and `text.es` to one plain sentence each stating them (or the record's words, quoted, with the Spanish frame `Registro oficial, en inglés: "…"`), `"ai": false`. The row's `id` must then be the one its content hashes to: run `node scripts/check-moment-updates.mjs`, and if it names the expected id, use that id and change every `grounded_in.update_ids` entry that named the old one;
   - **gone from the record:** add `"withdrawn_on": "<today, ET>"` and `"rechecks": [{ "on": "<today, ET>", "at": "<now, ISO>", "outcome": "withdrawn" }]`.
3. Run `node scripts/check-moment-updates.mjs` (it must pass) and merge. The line drops out of the report the next night.

## Lines left as they are (detail)

A warning `record re-check: … left as it is — …` means the re-check saw a difference it would not resolve by itself: two possible matches, a change that would alter an outcome, a number or a chamber, an action that moved to another date, a list missing that day, or a line naming an amendment whose own record could not be read. The stored line stays as it is. If the record really changed it, correct it by hand in a reviewed pull request that edits nothing else.

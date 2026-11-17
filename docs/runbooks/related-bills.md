# Runbook: the nightly read of identical bills

The nightly bill sync has a step called **"Read identical bills from the record"** (`scripts/sync-related.mjs`). It reads Congress.gov's related-bills list and keeps only the bills the record calls an **"Identical bill"**. The result goes into `data/related-bills.json`. A bill page's "How it's being covered" box uses that file to list, unchanged, the articles stored under the bill's identical twin (owner, 2026-11-13: "Yes, show it under the bill as it is.").

If this step goes wrong, nothing breaks on the site: the boxes keep showing what they showed the night before. What stops is the updating.

## The five alarms on the health issue

| Alarm code | What it means | Look at first |
|---|---|---|
| `related-bills-stopped` | The step ended early and left the file exactly as it was. The alarm quotes the step's own reason. | Read the reason. **"CONGRESS_API_KEY is not set"**: the repository secret is missing from the workflow. **"N lookups in a row failed"**, **"all N lookups failed"** or **"time budget"**: Congress.gov was down, refusing or very slow. If it lasts more than a night, check the key at api.congress.gov. **"not in the documented shape"** (in the FAIL lines above it): Congress.gov changed its answer; the code in `lib/related-bills.mjs` (`recordAnswerProblem`) needs a person. **"failed its own gate"**: a code change broke the rule in `lib/related-bills.mjs`; the finding is printed just above the STOPPED line. |
| `related-bills-crashed` | The step started but never said it finished or stopped. It crashed, or the step's 8-minute limit killed it. | The last lines of that step in the nightly run's log. |
| `related-bills-lookups-failed` | The step finished, but half or more of its Congress.gov lookups failed. | The `FAIL` lines in that step's log. Those bills keep what they had and go first the next night, so one bad night usually clears itself. |
| `related-bills-stale` | `data/related-bills.json` says it was last filled more than 3 days ago, has no date, or has a date in the future (only a hand edit can write that). This covers a step that was skipped, removed or silently did nothing. | Whether the step still exists in `.github/workflows/sync-bills.yml`, and whether recent nightly runs reached it. |
| `related-bills-twins-fell` | The number of bills with an identical twin fell by more than 5 bills, or more than 10%, between the last two fills, or fell to 0. A normal night changes it by one or two. | The `no longer listed as identical` lines in that step's log. If they are many, Congress.gov's answers have probably changed. |

## How long things take, at most

- An ordinary night: about a minute (200 lookups).
- One lookup waits at most 15 seconds. A request that gets no answer is not retried. A 5xx or 429 error is retried once, after 3 seconds.
- Five failed lookups in a row stop the run. No new lookup starts after 5 minutes.
- The step runs under `timeout 8m`, with a 10-minute limit as a backstop.
- So the step can add at most 10 minutes to a night, and in practice stops itself within about 6.

## What a reader may see that is out of date

- **A relation the record has dropped can still show for up to about 8 days.** Each bill is re-read at most once a week, and the nightly may run a day late.
- During that time, a box that lists the twin's articles still says the record lists the twin as identical. That sentence is out of date until the next read removes the twin.
- **A bill that leaves `data/bills.json`** is pruned from the file on the next run (the DONE line says how many). Until then the checks only warn about it; they never block the night or CI.

## Where things are

- The step's lines in a nightly log: `RELATED START:`, then either `RELATED DONE: …` or `RELATED STOPPED: …`.
- The file's last-filled day: `_meta.filled_at` in `data/related-bills.json`. The count before the last fill: `_meta.previous_carrying`.
- The rule for what counts as a twin, and the checks: `lib/related-bills.mjs`.
- The step reads bills that have stored coverage, plus bills already in the file. It reads at most 200 a night, using free Congress.gov requests ($0).

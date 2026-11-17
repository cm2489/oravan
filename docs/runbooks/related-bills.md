# Runbook: the nightly read of identical bills

The nightly bill sync has a step called **"Read identical bills from the record"** (`scripts/sync-related.mjs`). It reads Congress.gov's related-bills list and keeps only the bills the record calls an **"Identical bill"**. The result goes into `data/related-bills.json`. A bill page's "How it's being covered" box uses that file to list, unchanged, the articles stored under its identical twin (owner, 2026-11-13: "Yes, show it under the bill as it is.").

If this step goes wrong, nothing breaks on the site: the boxes keep showing what they showed the night before. What stops is the update, so new twins don't appear.

## The four alarms on the health issue

| Alarm code | What it means | Look at first |
|---|---|---|
| `related-bills-stopped` | The step ended early and left the file as it was. The alarm quotes the step's own reason. | Read the reason. "CONGRESS_API_KEY is not set": the repository secret is missing from the workflow. "all N lookups failed": Congress.gov was down or refusing; if it lasts more than a night, check the key at api.congress.gov. "failed its own gate": a code change broke the rule in `lib/related-bills.mjs`; the gate's finding is printed just above the STOPPED line. |
| `related-bills-crashed` | The step started but never said it finished or stopped. | The last lines of that step in the nightly run's log (the error is there). |
| `related-bills-lookups-failed` | The step finished, but half or more of its Congress.gov lookups failed. | The `FAIL` lines in that step's log. Those bills go first the next night, so one bad night usually clears itself. |
| `related-bills-stale` | `data/related-bills.json` says it was last filled more than 3 days ago, or has no date. This covers a step that was skipped, removed or silently did nothing. | Whether the step still exists in `.github/workflows/sync-bills.yml`, and whether recent nightly runs reached it. |

## Where things are

- The step's lines in a nightly log: `RELATED START:`, then either `RELATED DONE: …` or `RELATED STOPPED: …`.
- The file's last-filled day: `_meta.filled_at` in `data/related-bills.json`.
- The rule for what counts as a twin: `lib/related-bills.mjs`.
- The step runs only on bills that have stored coverage, at most 200 a night, using free Congress.gov requests ($0).

# The no-vehicle rejection log

`docs/moment-rejections.json` is the record of topics that had real public
attention and **no legislative vehicle to call about** — the questions this
platform looked at and declined to open as a Moment, with the reason written
down at the time.

It exists because the boundary is only credible if the refusals are visible.
"No Moment without a real bill" is easy to say and impossible to audit from
the outside; a dated list of the topics that failed the test is the audit. A
year of this file is also the honest evidence for the February 2027 re-scope
decision: if the log is long and the reasons are consistently "Congress simply
has not written one," that is a finding about the scope, not about the week.

## Where it lives, and why

`docs/`, deliberately. Nothing in `app/`, `lib/`, or `components/` can import
from `docs/`, so this file can never leak into a bundle or become a data
source for a rendered page. It is a record for the owner and for anyone
reading the repository — not site content.

## Shape

A JSON array, append-only, one object per rejected topic:

```json
{
  "date": "2026-08-04",
  "topic": "Short name for the question, as a person would say it",
  "why_no_vehicle": "One or two sentences: what was searched, and what was not found.",
  "evidence": [
    "https://www.congress.gov/search?q=... (0 results, 2026-08-04)",
    "https://example.com/coverage-of-the-topic"
  ],
  "revisit_when": "A falsifiable trigger — 'a bill is introduced', 'the committee schedules a markup'."
}
```

Every field is required. `evidence` must be non-empty: a rejection is a
finding, and a finding cites something. `date` is `YYYY-MM-DD`.

## How entries are added

By the owner, in a pull request, appended to the end of the array. Never
edited or deleted in place — a rejection that later gets a vehicle is answered
by opening the Moment, not by rewriting the log. `scripts/moment-candidates.mjs`
prints the log on every run and warn-lints its shape; a malformed entry
produces a warning on stderr and never fails the report.

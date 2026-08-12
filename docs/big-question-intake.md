# How a Big Question goes live

The whole loop, from a bill crossing the bar to a question on `/questions`.
Two things are yours: reading the draft, and deciding. Everything else is
mechanism.

## The loop

1. **The watcher notices.** `moment-watch.yml` runs nightly (11:20 UTC, after
   the bill sync) and opens **one issue per candidate** that clears the
   notification floor — a chamber has scheduled it or acted on it on the floor,
   coverage is real, the action is recent, and there is somewhere to put it.
   Nothing crossing the floor means no issue. Silence is the signal.
2. **You read the draft.** The issue carries the record it was written from and
   a paste-ready scaffold whose prose — name, summary, and each vehicle's role,
   both languages — is an **unreviewed AI first draft** (`moment-draft.mjs`),
   lint-checked before it was shown. The mechanical fields around it
   (`category`, `aliases`, `qualifying_signal`, the dates, the id) are derived
   from the same record by `moment-scaffold.mjs`.
3. **You decide.** Add the **`approve-moment`** label to publish it. Close the
   issue to decline it, and append the reason to `docs/moment-rejections.json`
   (see `docs/moment-rejections.md` — a refusal is a finding, and the log is
   what makes "no Big Question without a real vehicle" auditable).
4. **If all six slots are full**, also comment `/replace <moment-id>` naming the
   question that retires. Without one the workflow comes back with the six ids
   and asks. Retiring writes `status: "retired"` on that entry — it stays in the
   file as the record that it existed, and stops appearing anywhere.
5. **The gates re-run**, on the entry as you approved it: schema, EN/ES parity,
   the vehicle resolving in the real corpus, qualifying-signal shape, the dates,
   the six-live cap, the forbidden-vocabulary lint in both languages, and the
   new-vehicle terminality rule against `main`. Plus two questions only the
   approve step can ask: has the record moved since the draft was written, and
   is the signal still inside the 45-day window the site publishes as its
   criterion.
6. **A PR opens, carrying the byte-fidelity attestation and the gate
   transcript.** The workflow branches, commits, opens the PR, and *attempts*
   auto-merge. **As this repository is configured today that attempt fails and
   the PR waits for your one click** — see "Making it merge itself" below.
   Merging closes the issue either way.

## Editing before you approve

**Edit the scaffold in the issue body.** That is the supported path, not a
workaround: the approve step reads the issue body, so your edit *is* the draft
that publishes. Change a sentence, fix the id, pick a different category, shorten
`review_by` — then add the label.

Editing in place is safe because of the one rule the approve path obeys:

> **The copy that publishes is the copy you read.** Parsed out of the issue,
> written through unchanged, then re-read from disk and compared field for
> field. Any difference at all and the file is restored and nothing publishes.

Nothing trims, normalises, re-flows, or improves your text on the way past. That
is what keeps `moments.howMadeBody`'s promise — an automated check first, then a
person's judgement, before anything goes live — true of the entry rather than
only of a draft.

## When it says no

Every refusal comes back as a comment on the issue, names the exact delta, and
takes the label off. Nothing is written. **Re-applying the label is the retry.**

| It says | It means | What to do |
|---|---|---|
| no scaffold, or two | the body is not one approvable block | edit the body down to one, or use the per-candidate issue |
| the id is still `REPLACE-WITH-MOMENT-ID` | nothing was derivable to name it | edit the id — it becomes `/questions/<id>` permanently |
| the id already exists | a second entry under one key silently replaces the first | rename it in the body |
| all six slots are full | the cap is the scarcity claim | comment `/replace <moment-id>`, then re-label |
| the record has moved | Congress acted after the draft was written, so the approved sentences describe a state that is gone | wait for tonight's re-draft, or edit the body yourself |
| the signal aged out | the newest action is over 45 days old, and `moments.whyCriteria` tells readers a question opens inside that window | wait for the next real signal |
| `review_by` has already passed | it would read as `stale` the moment it published | edit `opened`/`review_by` in the body |
| a gate violation | the entry does not satisfy the curation rules | fix it in the body, or let the next draft try |
| the branch already exists | a PR for this question is open, or an earlier attempt left one behind | merge or delete it, then re-label |

Most refusals leave a **green** run — you asked a question and got an answer on
the issue. Three go **red**, because each means something is actually wrong
rather than merely unready:

- a label applied by anyone other than the owner (label removed, comment posted);
- a byte-fidelity failure, which would be a bug in `moment-approve.mjs` rather
  than anything about your copy (the file is restored, and the label stays on so
  the state is obvious);
- `check-moments.mjs` failing on the working tree after the in-process gate
  passed, which means one of the checks only the CLI runs is unhappy (comment
  posted, file restored, label removed).

## Making it merge itself

The workflow runs `gh pr merge --auto --squash` on every PR it opens. **That
command fails today, and the failure is the expected path**, because auto-merge
needs two repository settings that are off (verified against the API,
2026-08-12: `allow_auto_merge: false`, `main` unprotected, no rulesets, no
required status checks). When it fails, the workflow says so on the issue and
the PR sits waiting for you — correct, complete, one click from landing.

Both of these have to be on, and turning them on is your explicit opt-in
because together they are what converts a label into a merge:

1. **Settings → General → Pull Requests → "Allow auto-merge".** Without it
   `gh pr merge --auto` errors outright.
2. **A required status check on `main`** naming CI's `test` job (Settings →
   Rules → Rulesets, or classic branch protection). Without it, auto-merge has
   nothing to wait for — **"on green" has no enforcement mechanism at all**, and
   a PR would land the moment it was armed rather than when CI passed.

Setting (1) without (2) is the dangerous half-configuration: it makes merging
automatic *and* unguarded. Do both or neither.

Until then the loop still removes the whole copy-paste ritual — the reading,
the deciding, and the one click are what remain.

## Who can approve

Only `cm2489`. The check is the first step of `moment-approve.yml`, before the
repository is even checked out, and it tests both the labeler and the run's
actor. Anyone else's label is removed with a comment saying why, and the run
fails loudly.

## The files

| | |
|---|---|
| `.github/workflows/moment-watch.yml` | opens the candidate issues, nightly; owns both labels |
| `scripts/moment-candidates.mjs` | the ranked report — never proposes or drafts anything |
| `scripts/moment-watch.mjs` | the notification floor, the seen-set, the issue body |
| `scripts/moment-draft.mjs` | the AI first draft of the prose, lint-gated before it is shown |
| `scripts/moment-scaffold.mjs` | every field that is not a sentence, derived from the record |
| `.github/workflows/moment-approve.yml` | the label trigger, the owner check, the branch/PR/auto-merge |
| `scripts/moment-approve.mjs` | the parse, the gates, the slot decision, the byte-fidelity write |
| `scripts/check-moments.mjs` · `lib/moments-gate.mjs` | the curation gate, in CI and here |
| `docs/moment-rejections.md` | the other outcome: what was declined, and why |

## What is not automated, on purpose

- **The writing is drafted, never authored.** A model writes the first draft and
  a lint checks it; neither of those is a judgement about whether a question
  belongs on the site.
- **Which question goes up, and which comes down.** Both are label-and-comment
  decisions with a person behind them. The workflow will refuse and ask rather
  than pick.
- **Rewriting your copy to satisfy a gate.** It reports the delta instead. A
  workflow that fixed the sentence would be publishing a sentence nobody read.

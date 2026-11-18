# shellcheck shell=bash
# The news desk commit step exactly as on main at 5bfd2b9d (.github/workflows/newsdesk.yml), kept so
# tests/short-titles-stalls.unit.spec.ts can run old and new side by side on throwaway repositories.
git config user.name "oravan-sync"
git config user.email "223600121+cm2489@users.noreply.github.com"
git add data/
if git diff --cached --quiet; then
  echo "no changes"
  echo "changed=false" >> "$GITHUB_OUTPUT"
  exit 0
fi
git commit -m "chore(data): newsdesk trigger $(date -u +%FT%HZ)"
# This job touches data/bills.json/data/bills-es.json and
# data/conversation.json (the conversation lamp's committed
# evidence - no sync-state.json, no coverage.json; see
# scripts/newsdesk.mjs's Boundaries section) plus
# data/moment-updates.json from the collector step above,
# data/votes.json from the intraday vote sync (only when a new
# roll call was stored) and
# data/floor-signals.json from the announcement collector;
# `git add data/` already stages all of them
# - disjoint from refresh-legislators.yml's
# files but overlapping sync-bills.yml's/hot-bills.yml's, all of
# which share this concurrency group. Rebase onto the latest main
# and retry, same pattern as those workflows.
for i in 1 2 3 4 5; do
  if git push; then
    echo "changed=true" >> "$GITHUB_OUTPUT"
    echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  echo "push rejected, rebasing onto latest main (attempt $i)"
  # NEVER MERGE THE SHORT-TITLES FILES (2026-11-18). They are one line
  # per bill, so a rebase could merge them line by line into a file no
  # gate has checked. If this run changed them and its push was
  # rejected, it drops its own copies first: the bill it read stays
  # unread and is read again next hour or by the nightly, and nothing
  # the other push wrote is touched. Nothing left: no push at all.
  if [ "$i" = 1 ]; then
    dropped=false
    for f in data/short-titles.json data/short-titles-retry.json; do
      if git diff --quiet HEAD~1 HEAD -- "$f"; then continue; fi
      dropped=true
      if git cat-file -e "HEAD~1:$f" 2>/dev/null; then git checkout HEAD~1 -- "$f"; else git rm -q -f -- "$f"; fi
    done
    if [ "$dropped" = true ]; then
      if git diff --cached --quiet HEAD~1; then
        echo "only this run's short titles had changed; dropped rather than merged, so nothing is left to push"
        echo "changed=false" >> "$GITHUB_OUTPUT"
        exit 0
      fi
      git commit -q --amend --no-edit
      echo "this run's short titles were dropped rather than merged; the bill is read again next hour or by the nightly"
    fi
  fi
  # Guarded: a bare `git fetch` under `bash -e` kills the step on the
  # spot, which would make these five attempts as decorative as
  # sync-bills.yml's were on 2026-08-07.
  if ! git fetch origin main; then
    echo "fetch failed (attempt $i) - retrying"
    continue
  fi
  if git rebase origin/main; then
    continue
  fi
  # A stopped rebase is NOT retryable: every later iteration fails
  # identically until the attempts run out, which is how run
  # 31194836148 burned all five in sync-bills.yml and left a
  # misleading "push rejected" as its last word. Fail here instead,
  # naming the files. Nothing is auto-resolvable in this job - it
  # never writes data/sync-state.json, the one flat key-value file
  # with a deterministic union (scripts/merge-sync-state.mjs, wired
  # into sync-bills.yml only).
  conflicted="$(git diff --name-only --diff-filter=U | sort | tr '\n' ' ' | sed 's/ $//')"
  git rebase --abort || true
  echo "::error::rebase conflict in: ${conflicted:-<unknown>} - a human must resolve it. The headlines and Moment updates this run collected are NOT committed."
  exit 1
done
exit 1

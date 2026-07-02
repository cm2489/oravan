---
title: Bare-date sync cursor 400-looped every nightly run for 6 nights
date: 2026-07-01
tags: [pipeline, sync-bills, congress-gov, silent-failure]
---

# Bare-date sync cursor 400-looped the nightly sync

**What happened.** Every nightly bill sync from 2026-06-25 through 2026-07-01
failed in about a minute (vs. the normal ~25) without processing a single
bill. The corpus quietly stopped updating for six nights.

**Root cause.** Congress.gov's bill-list `updateDate` field is date-only
(`"2026-06-04"`), not a full timestamp. The 2026-06-25 run persisted that bare
date as the high-water-mark cursor, and Congress.gov rejects a `fromDateTime`
query without a time component with a 400 — so every subsequent run died on
its first request, poisoned by its own state file.

**Fix (PR #16).** `scripts/sync-bills.mjs` normalizes the cursor to a full
ISO-8601 datetime (`toISODateTime`) before persisting, so a bare date from the
API can never poison `lastSync` again. `data/sync-state.json` was repaired to
the same high-water mark, correctly formatted, and the missed window was
caught up with a local run (99 refreshed, 40 decoded, 361 queued for the
nightly decode budget to drain — which is why the cursor deliberately sits
weeks behind while that backlog clears).

**Prevention.** `scripts/verify-sync.mjs` hard-fails any run whose `lastSync`
is not a parseable full ISO-8601 datetime, and fails when `lastRun` doesn't
advance — a 400-loop that processes nothing can no longer end in a green
checkmark.

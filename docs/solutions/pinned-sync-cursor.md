---
title: Nightly sync cursor pinned for 24 days (all-or-nothing advance)
date: 2026-06-24
tags: [pipeline, sync-bills, congress-gov, silent-failure]
---

# Nightly sync cursor pinned for 24 days

**What happened.** From 2026-06-01 to 2026-06-24 the nightly bill sync's cursor
(`data/sync-state.json` → `lastSync`) never advanced. Every night re-scanned the
entire growing window — up to 500 sequential Congress.gov detail fetches — so
runs swung from ~22 minutes to 2–5 hours, and on 2026-06-13 one crashed
outright. All of it behind green checkmarks.

**Root cause.** The cursor advanced only on a *perfectly clean* run
(`state.lastSync = queued || failed ? state.lastSync : runStart`). Across
hundreds of serial network calls, at least one transient failure is
near-certain, so the cursor froze; the frozen cursor grew the window, which
grew the call count, which raised the failure odds. A self-reinforcing stall.
Separately, the fetch helper retried on bad HTTP *statuses* but not on
`fetch()` *throwing*, so one hung socket killed the whole run (the 06-13
crash).

**Fix (PR #9).** The cursor became a high-water mark: it advances over every
fully-handled bill and freezes only at the first bill that still needs work
(new bill whose decode failed, or decode budget exhausted). A transient
*refresh* failure of an already-known bill is idempotent and self-heals on the
bill's next update, so it no longer freezes anything. Fetches got a 30s
`AbortSignal.timeout` inside the retry loop's try/catch.

**Prevention.** `scripts/verify-sync.mjs` (run after every sync, before the
commit step) fails the workflow if `sync-state.json`'s `lastRun` didn't advance
past the run's start, and emits a `::warning` whenever the `lastSync` cursor is
more than a week old — a pinned cursor now surfaces the first night, not
24 nights later.

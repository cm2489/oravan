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
past the run's start — a pinned cursor now surfaces the first night, not
24 nights later.

*Amended 2026-08-12.* This paragraph used to end "and emits a `::warning`
whenever the `lastSync` cursor is more than a week old", which had been untrue
since 2026-07-16: the warning was promoted to a hard failure at
`CURSOR_MAX_AGE_DAYS = 10` because nobody ever acted on it. The ceiling has now
moved out of `verify-sync.mjs` altogether, into `scripts/check-cursor-age.mjs`,
which runs as the **last** step of `sync-bills.yml` — *after* the commit. A
stalled cursor is a statement about PROGRESS, not about corpus integrity, and
failing it before the commit made a stalled night discard its own already-paid
decodes, coverage and nominations, which made the backlog it was complaining
about strictly worse. The run still goes red; the data still lands.

*Amended 2026-09-18 — the second freeze, caused by the first fix's own
mechanism.* The high-water mark above is `toISODateTime(u.updateDate)`, and the
bill-list `updateDate` is a bare DATE, so the mark is the MIDNIGHT of the last
finished bill's day. When the cursor already sits INSIDE that day, midnight is
*behind* it; the monotonic clamp (added 2026-08-12) holds it where it was, and
the night makes zero progress. From 2026-09-08 to 2026-09-18 that is exactly
what happened: 1,340 tracked bills carry the 2026-09-08 `updateDate`, so the
oldest-500 slice could never reach a later day, `lastSync` sat at
2026-09-08T17:54:31Z for ten nights, and the 09-18 nightly went red on
`check-cursor-age.mjs` with no self-healing path — raising `max_updates` by hand
was the only exit.

**Fix.** A calendar day is the finest grain the list offers, so the run now
*finishes the day*: the page loop keeps paging past `MAX_UPDATES` while
everything fetched still sits on one day (bounded by `MAX_DAY_COMPLETION`), the
processing slice is extended to the end of that day (`planAscendingWindow`), and
once a day is provably finished the mark becomes the **end** of it
(`endOfDayCursor`) rather than its own midnight. The extension is affordable
because it is made of refreshes and gate verdicts — free Congress.gov calls;
the only paid work, a new-bill decode, is still capped by `MAX_NEW_DECODES`, and
a bill past that budget still freezes the cursor exactly as before.

**What the freeze was hiding.** Measured with the new `SYNC_DRY_RUN` sizing mode
on 2026-09-18: of the 962 new bills dated 2026-09-08, the 334 inside the
current cap contain **0** that clear the priority decode gate — which is why
every nightly reported "0 added, 0 queued" and looked healthy. The 628 beyond
the cap contain roughly **105** that do, and they are `passed_chamber` records
("Received in the Senate", "Held at the desk"). The stall was not just late; it
was invisible *because* the part of the day it could reach was the boring part.

---
title: Stored urgency scores froze the freshness bonus (stale bill stuck on top)
date: 2026-06-12
tags: [feed-ranking, urgency, data-model]
---

# Stored urgency scores froze the freshness bonus

**What happened.** The feed's top slot got stuck: a CFPB-related bill that had
been placed on the calendar weeks earlier kept outranking bills in active
committee fights, because "urgent six weeks ago" was indistinguishable from
"urgent today."

**Root cause.** `urgency_score` was computed at *sync* time and stored in
`data/bills.json`, freezing the freshness bonus (+0.1 within 3 days of action,
+0.05 within 7) at whatever it was the night the bill last changed. Nothing
ever decayed, so a stale floor placement held its peak score forever.

**Fix (PR #7).** Urgency is recomputed at *read* time
(`effectiveUrgency(status, last_action_date)`): a base score per status, the
short freshness bonus, and a staleness decay — no penalty for two weeks, then
a linear slide (0.015/day, capped at 0.45) that drops a stale floor placement
below an active committee fight. The stored `urgency_score` remains as
sync-time metadata but the feed never ranks by it.

**Prevention.** The urgency curve now lives in one shared module
(`lib/urgency.mjs`) used by both the site and the coverage sync, and
`tests/urgency.unit.spec.ts` pins the curve — base, bonus, decay, clamps, and
rounding — per status, so any future tuning (or an accidental revert to stored
scores) breaks tests loudly instead of silently reordering the feed.

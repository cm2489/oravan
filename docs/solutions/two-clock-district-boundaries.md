---
title: The two-clock model for federal district boundaries
date: 2026-07-06
tags: [pipeline, district-lookup, redistricting, data-resilience]
---

# The two-clock model for federal district boundaries

**Why this exists.** The 2025–26 mid-decade redistricting wave (TX, CA, MO,
NC, OH, UT, FL, TN with new maps locked in for Nov 2026; LA and AL mid-fight)
makes it tempting to treat "the boundaries changed" and "who represents a ZIP
code changed" as the same event. They are not. Conflating them is the
concrete risk this doc closes off, in code and in writing, per
`docs/ideation/2026-07-05-build-gtm-strategy.md` §9.1(f) and S24.

## The structural fact

House terms run Jan 3 → Jan 3. A mid-decade map change does not unseat a
sitting member — it governs the **next** ballot and who's sworn in **after**
that term boundary, never who represents a ZIP code today. California's own
Secretary of State states this explicitly for Prop 50. Alabama is the
sharpest live proof of why a static snapshot is dangerous in the other
direction: a 3-judge panel blocked the state's 2023 map on 2026-05-26, SCOTUS
reinstated it on 2026-06-02, and the Aug 11, 2026 special primary runs under
that reinstated map — a pipeline that snapshotted boundaries once, mid-fight,
would have shipped the wrong districts across that reversal.

## Two datasets, two clocks

**Clock 1 — "who represents you now."** The current federal boundary/roster
pipeline:
- `app/api/district/route.ts`'s `CENSUS_QUERY.layers` literal,
  `'119th Congressional Districts'`
- `data/zip-districts.json` (built weekly from `zccd.csv` by
  `scripts/process-data.py`)
- `data/legislators.json` / `data/vacancies.json`

This is **valid through Jan 3, 2027, regardless of the redistricting wave.**
No swap is needed before then, no matter how many states pass new maps or how
litigation resolves — that's the structural fact above, not a judgment call.
`app/api/district/route.ts`'s existing comment on the literal now states this
explicitly.

**Clock 2 — "your Nov 2026 ballot / Jan 2027 rep."** A separate next-term
dataset, keyed to the new maps states are adopting for the Nov 2026 election.
**Not built.** Per §9.1(f): *"a separate Nov-2026-ballot/Jan-2027-term dataset
would only be needed if Rostra ever surfaces ballot-facing district content —
not currently a stated Rostra feature."* This doc makes that non-goal
explicit: if ballot-facing/next-term district content ever becomes a Rostra
feature, Clock 2's dataset is the prerequisite, and it does not exist today.
Building it is out of scope for S24, which is monitoring-plus-guards, not a
data migration.

## The mandatory rollover — dated tripwire, not tribal knowledge

Clock 1's literal and boundary dataset **must** be bumped to the 120th
Congress's vintage before Jan 3, 2027, the one point where Clock 1 itself
turns over. This is a real, calendar-dated action item, not something to
notice after the fact — so it's now enforced by a tripwire instead of resting
on memory:

- `lib/rollover-tripwire.mjs` — pure `rolloverWarning(today)`, silent before
  `WARNING_START` (2026-12-01, ~1 month of lead time), returns a loud message
  naming the literal and `data/zip-districts.json` once on/after that date,
  and reframes as "N days PAST the deadline" if the bump is missed entirely.
- `scripts/check-rollover-tripwire.mjs` — CLI wrapper, runs weekly from
  `refresh-legislators.yml`, prints a `::warning` GitHub Actions annotation.
  **Never fails the workflow** — the edit isn't due for months after the
  warning window opens, so gating the pipeline on it before then would be
  noise, not signal. This is the same "never let a mandatory human edit be
  forgotten" posture as `ci.yml`'s noindex launch-gate reminder.
- Unit-pinned in `tests/rollover-tripwire.unit.spec.ts` with fixture dates:
  silent before Dec 1, 2026; a countdown message on/after it; an "overdue"
  framing past Jan 3, 2027.

## RDH monitoring — what's real, what's a tripwire, and why

The Redistricting Data Hub (RDH) is the fastest verified tracker for new
state maps (days-scale turnaround vs. Census TIGER's weeks-to-months, and
TIGER is confirmed still on the prior cycle's vintage for this wave). §9.1(f)
calls for polling RDH's "What's New" feed. Verified live, 2026-07-06, before
building anything:

- **RDH exposes no RSS/Atom/JSON feed and no API.** Its "What's New" page
  (`https://redistrictingdatahub.org/data/whats-new/`) has no
  `<link rel="alternate">` feed tag, no `/feed` or `/rss` endpoint, and no
  `wp-json` reference anywhere in its HTML — confirmed by direct fetch. It's
  a reverse-chronological, human-readable list; RDH's own suggested
  alternative is their email newsletter, not a machine feed.
- **What RDH does publish: a standard WordPress-SEO-plugin XML sitemap**,
  `https://redistrictingdatahub.org/state-sitemap.xml`, with a `<lastmod>`
  timestamp for every `/state/{slug}/` page — confirmed by direct `curl`
  (`http_code=200`, 51 `<url>` entries, exact `<loc>`/`<lastmod>` pairs
  verified for all 10 tracked states). This is real, machine-parseable XML,
  not a fake integration.

**Design decision: poll the state-sitemap's per-state `<lastmod>`, not a
whole-page hash-diff of "What's New."** A raw hash of the listing page was
the fallback the strategy doc explicitly allowed ("acceptable as a tripwire,
label it as such") if no better signal existed — but one does: the
per-state sitemap `<lastmod>` is scoped to exactly the states this file
tracks, so it doesn't fire on unrelated page churn elsewhere on the listing,
and it's structured data instead of an opaque hash. It is still a **tripwire,
not a status feed** — a lastmod change means "something on RDH's page for
this state changed since we last looked," never an automated determination
of *what* changed. A human always reads the page and updates
`data/redistricting-watch.json`'s `status`/`note` by hand.

**Mechanics** (`lib/redistricting-watch.mjs`, `scripts/check-redistricting-watch.mjs`,
wired into `refresh-legislators.yml`):
1. Fetch `state-sitemap.xml`, parse `{slug -> lastmod}`.
2. Diff against `data/redistricting-watch.json`'s committed `rdh_lastmod` per
   tracked state.
3. Unchanged → silent. Changed → a `::warning` annotation, the committed
   `rdh_lastmod`/`checked` fields advance (so the same already-flagged
   change doesn't re-fire every week — mirrors `vacancy_diff.py`'s
   chronic-vs-newly-detected split), and the next workflow step opens one
   GitHub issue per changed state, labeled `redistricting-watch`, for manual
   review. `status`/`note` are never touched by the automation.
4. **Loud failure**, matching the KTD-10 convention: if *every* tracked state
   comes back missing from the fetch (RDH restructured the sitemap, or the
   fetch itself broke), the script exits 1 rather than silently treating
   "couldn't find anything" as "nothing changed." A *partial* miss (one
   state's page moved, the rest resolved fine) is treated as real news, not
   a structural failure, and still gets flagged.

## Seeded state list (§9.1(f), source-checked 2026-07-06)

TX, CA, MO, NC, OH, UT, FL, TN, LA, AL — the ten states in `data/redistricting-watch.json`.
Verifying against primary sources at seed time caught one place the strategy
doc had already gone stale: **Louisiana** was recorded there as "likely,
litigation delayed," but by the seed date the legislature had already passed
a *replacement* map (2026-05-29) after SCOTUS struck the prior one
(*Louisiana v. Callais*, 2026-04-29) — and that replacement map is itself
under fresh litigation from multiple sides. `data/redistricting-watch.json`
records the corrected, dated account. Alabama's "settled per the June 2
SCOTUS ruling" framing was independently re-verified against contemporaneous
reporting and confirmed still accurate.

## Explicit non-goals

- This is monitoring plus guards, **not a boundary-source migration.**
  `zip-districts.json` keeps building from `zccd.csv` exactly as before;
  nothing about *how* Clock 1's data is sourced changes in S24.
- Ballot-facing/next-term district content is **not a current Rostra
  feature.** If that changes, Clock 2's dataset is a hard prerequisite, and
  building it is separate, larger scope than this doc or S24 cover.

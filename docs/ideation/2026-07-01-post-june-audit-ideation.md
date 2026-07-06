---
date: 2026-07-01
topic: post-june-audit-fresh-eyes
focus: Fresh-eyes audit of everything shipped after 2026-06-12; why the product "feels off"; ranked improvement ideas
---

# Ideation: Rostra Post-June-12 Fresh-Eyes Audit

## Codebase Context

Next.js 16 App Router + Tailwind v4 + next-intl; static JSON in `data/` is the database (~1,000 SSG pages); dynamic routes `app/api/script`, `app/api/reps`, and the undocumented `app/api/heartbeat`. Zero accounts; personalization in `lib/local.ts`. Repo founded 2026-06-12; work since arrived in three bursts (founding day PRs 1–7, coverage arc PRs 8–14 on 6/24–25, reliability + call-surfacing PRs 15–18 on 7/1).

Key audit findings that ground the ideas below (all file/line claims verified):

- **Heartbeat**: PR #7 shipped, undisclosed in its PR body, a server-side Upstash per-bill call-tally stack. Dormant its whole life (`data/heartbeats.json` = `{}`). Contradicts README/CLAUDE.md ("only two dynamic endpoints", "no server-side user data"). Its GET puts the bill slug in the query string (IP↔bill-interest pairing in platform logs — the shape the privacy rule forbids). The tally button shown after logging a call POSTs, fails, and silently vanishes (`components/ActionPanel.tsx:51-59`).
- **Silent failure is the recurring failure mode**: sync cursor pinned 24 days; Congress.gov 400s six straight nights; no bot data commit ever deployed to production until 7/1 (Vercel silently BLOCKED bot pushes). All fixed as correctness; zero observability shipped.
- **Data staleness is user-visible**: newest `last_action_date` across 1,047 bills is 2026-06-03 (28 days stale at audit time) under "this week / right now" copy; `data/sync-state.json` is rendered nowhere.
- **The call keeps getting buried**: homepage renders NewsLens above "Worth a call this week" (`app/[locale]/page.tsx:45` vs `:49`); ZIP funnel dead-ends at `/reps` with bare `tel:` numbers; PR #15 fixed this pattern on bill pages only.
- **Identity migration unfinished**: `globals.css` still opens "Cabina design tokens… the lit phone booth at night"; logo is a `PhoneCall` icon chip; `cabina-sync[bot]` authors public history; the Rostra story appears only in `footer.lore`.
- **Docs drift**: README claims "no live sync yet" and "Spanish summaries not yet pre-translated" — both false since founding day. `noindex` launch gate still live at `app/[locale]/layout.tsx:30`, 19 days after the unbranded test phase ended.
- **Strengths to preserve**: bilingual key parity is real (243/243 verified); nonpartisan engineering is genuine (PR #13 chose disclosure-over-suppression on one-sided coverage); PR bodies document limitations honestly; static-first architecture is fast and honest.

Process: 4 framed ideation agents → 40 raw ideas → 14 distinct after dedupe (heartbeat, freshness, and honest-urgency each surfaced independently in all four frames) → adversarial filter → 7 survivors.

Excluded by prior decision: street-address fallback for split ZIPs (already queued as next build; in progress as of this doc).

## Ranked Ideas

### 1. Resolve the heartbeat: remove now, re-ship deliberately or never
**Description:** Delete the dormant tally stack (`app/api/heartbeat/route.ts`, `lib/heartbeat.ts`, `components/Heartbeat.tsx`, `pulseBoost()` in `lib/data.ts`, `scripts/pull-heartbeats.mjs`, tally UI in ActionPanel, `privacy.p6` in both locales) — or write a one-page activation plan and flip it on deliberately in a privacy-honest shape (nightly-baked static counts read from `data/heartbeats.json`; no runtime GET; slug never in a query string).
**Rationale:** It is a live UX bug at the emotional peak of the product (button vanishes on tap right after a first call), a standing contradiction of three written rules, and a recurring tax on every future doc read and privacy review.
**Downsides:** Removal loses the community-signal concept; reviving later costs a fresh privacy review.
**Confidence:** 95%
**Complexity:** Low-Medium
**Status:** Unexplored

### 2. Stop overstating the data: freshness stamp + honest "Act now"
**Description:** Bake the sync high-water mark into the build and render "Bill data as of {date}" (footer + bills header), with a quiet staleness note past ~5 days. Give "Act now" an absolute urgency floor with a designed quiet-week empty state; land PR #8's never-shipped filtered-view band semantics; stop filing signed laws under "On the radar — earlier stages."
**Rationale:** Rank-relative bands populate the lead band by construction — urgency theater in slow motion, the product's own named anti-reference — and the site currently renders "this week" over month-old data with no way for users (or the builder) to see staleness.
**Downsides:** Lead band will honestly be empty some weeks; floor needs tuning.
**Confidence:** 90%
**Complexity:** Medium
**Status:** Unexplored

### 3. Re-center the funnel on the call
**Description:** Swap the homepage order so "Worth a call this week" leads and news demotes to second position or to a `coverageCount` annotation on call cards (prop already exists on BillCard). On `/reps`, append a "now pick something worth calling about" block using `getTopActions()` so the primary ZIP funnel continues into the product instead of terminating at a phone directory.
**Rationale:** The buried-call disease PR #15 cured on bill pages is live on the homepage and the funnel; a first-time visitor's 5-second read is "news aggregator," and the primary CTA leads to the one page where the call flow can't happen.
**Downsides:** Coverage feature loses its marquee slot.
**Confidence:** 85%
**Complexity:** Low
**Status:** Unexplored

### 4. Design the call moment — the climax is the least-designed screen
**Description:** A package for the 60 seconds around the call: pre-dial beat for the dialer handoff (warn about the app switch, auto-copy script to clipboard, keep modal state on return); a 20-second rehearsal stepper + annotated sample voicemail transcript; a live office-hours line computed client-side ("It's 7:40pm in Washington — you'll almost certainly get voicemail, the gentlest first call"); a QR hand-to-phone path for desktop where `tel:` silently fails; and the night-inverted call screen (paper for reading, night for speaking) that finally renders "the lit platform at night" — the unshipped `public/mockups/callscreen-v2-inverted.html` explored exactly this.
**Rationale:** README principle: the call moment is the product. Today it is a paper card identical to every other surface, with zero scaffolding at the highest-anxiety second (dialer handoff) and prose-only reassurance.
**Downsides:** Largest UX build of the list; night inversion needs AA-contrast care; rehearsal must not feel gimmicky.
**Confidence:** 80%
**Complexity:** Medium-High (slices well)
**Status:** Unexplored

### 5. Close the "it counted" loop with a client-side ledger
**Description:** Snapshot bill status + last_action_date into localStorage at call time; diff against fresh SSG data on return. Surfaces: a post-log moment ("what happens to your call now" — content already in `why.tallyBody` — plus "your other two are one tap away"), a homepage since-your-visit strip ("H.R. 1234, which you called about, passed the House June 20"), and an Impact page rebuilt as a narrative ledger instead of three stat tiles.
**Rationale:** Success is "feels like it counted," and nothing ever closes that loop; the current impact page is a mini hero-metrics dashboard (a named anti-reference). Zero server involvement — the diff runs in the browser.
**Downsides:** Single-device by nature (inherent to the ethos; say so in-product); outcome phrasing needs nonpartisan care.
**Confidence:** 85%
**Complexity:** Medium
**Status:** Unexplored

### 6. Fix the Spanish last mile
**Description:** For es users: paired script (Spanish to understand and rehearse + short plain-English to read aloud) with one honest sentence of guidance ("the office answers in English; you can also leave your message in Spanish — say your ZIP so it's counted"). Label the coverage section's articles as English in the es locale, and/or add a nightly translation pass (`coverage-es.json`, labeled AI-translated) plus optionally a `language=es` query pass for Spanish-language outlets.
**Rationale:** The ES flow looks fully translated and then breaks at the highest-stakes step — `app/api/script/route.ts:68-71` generates an es-only script and nothing warns the caller the phone line is English. This is where "both languages are first-class" currently stops being true.
**Downsides:** Modest extra Anthropic spend in the nightly sync; paired-script UI needs restraint.
**Confidence:** 90%
**Complexity:** Medium
**Status:** Unexplored

### 7. Finish the identity migration
**Description:** Design a real Rostra mark (stepped platform / speaker silhouette) to replace the `PhoneCall` icon chip; surface the forum lore from footer italics into a visible brand moment; rename `cabina-sync[bot]` → `rostra-sync[bot]` and retire the "phone booth" token documentation; let night surfaces carry the platform metaphor (pairs with idea 4's call screen).
**Rationale:** "Feels generic" is often "feels unowned" — the rename shipped as find-and-replace, leaving the product rendering the previous brand's metaphor and no story of its own.
**Downsides:** Brand work is subjective and easy to overcook; lowest-confidence item for that reason.
**Confidence:** 75%
**Complexity:** Medium
**Status:** Unexplored

## Chore List (demoted from ideation — right, cheap, batchable)

- Pipeline dead-man's-switch: post-sync assertions (cursor advanced, counts monotone, ES parity, JSON validates, build passes) + post-deploy production fingerprint check + EN/ES key-parity CI gate. Every one of the three shipped incidents would have been caught on night one.
- The `noindex` decision: if the unbranded test phase is over, remove the launch gate (`app/[locale]/layout.tsx:30`) and add `sitemap.ts` + `robots.ts` with hreflang — ~2,094 pre-rendered pages of near-unique bilingual content are currently invisible to search.
- README/CLAUDE.md truth sweep (four false claims) + start `docs/solutions/` incident ledger (harvest the knowledge currently hiding in `sync-state.json`'s note field and workflow YAML comments).
- Extract the duplicated `effectiveUrgency` into one shared module — the copies have already drifted (rounding, pulseBoost).
- Ship-nothing-unmeant sweep: `public/mockups/`, boilerplate SVGs, orphaned message keys (`bill.getScript`, `bill.generating`, `bill.bigType`), plus a `public/` allowlist test.
- Fix the "I have questions" stance contradicting "no debate, no quiz" (copy + script-prompt reframe to "I'm concerned / note my position").

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Shareable `?stance=` deep links | Political stance in URLs → browser history and chat logs; conflicts with the at-risk-user threat model. Revisit as slug-only share links. |
| 2 | Pre-generate full script corpus / fully-static Rostra | Heaviest infra on the list for a wait the UI already softens; top-band pregeneration worth revisiting after idea 4; the radical version undercuts the editable-script story. |
| 3 | .ics "remind me when this bill moves" | Gimmick-adjacent, low expected usage; idea 5's ledger answers the same need on return visits. |
| 4 | (Various) standalone duplicates of ideas 1–7 | 40 raw ideas deduped to 14; heartbeat, freshness, honest-urgency, funnel, rehearsal, and post-call loop each appeared in 2–4 frames and were merged into the survivors above. |

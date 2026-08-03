---
target: / (homepage, EN+ES) — anchored sweep, brand register
total_score: 33
p0_count: 0
p1_count: 1
score: 33
p0: 0
p1: 1
timestamp: 2026-08-03T00-08-02Z
slug: app-locale-page-tsx
---
Method: single-agent anchored unit (pre-launch sweep Phase 1A; the blind pass ran separately by campaign design). Browser evidence: Playwright headless, 8 viewport×locale combos (1280×900, 390×844, 768, 800, 320 — EN+ES), computed styles, keyboard-focus tests, ZIP error state walked, screencast driven. Detector: `detect.mjs` on 13 homepage source files — 0 findings. Perf numbers are from `next dev` (Turbopack) and flagged as such below.

# Design Health Score — 33/40 (Good, high end — the July P0s are verifiably gone)

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Stamp certifies the week; screencast announces steps via aria-live; play/pause states clean; nothing hides state |
| 2 | Match System / Real World | 3 | Three listed rows print "On the floor calendar" against records saying cloture motion / motion REJECTED 47-52 / rejected 49-50 |
| 3 | User Control and Freedom | 3 | Screencast never autoplays and is fully steppable, but has no scrub and the paused Play overlay hides the chosen frame |
| 4 | Consistency and Standards | 3 | "On the floor calendar" means a verified fact on the crown and a loose status bucket two rows down; specimen bill duplicates listing row #1 |
| 5 | Error Prevention | 3 | ZIP input inputmode=numeric + maxLength 5; short input still reaches validation rather than being prevented |
| 6 | Recognition Rather Than Recall | 3 | The same H.R. 6500 headline runs the page twice (hero specimen card + first week row), unmarked |
| 7 | Flexibility and Efficiency | 3 | Two front doors, thumb locale switch, RSS/embeds/MCP; keyboard users pay 13 chrome stops before content on mobile |
| 8 | Aesthetic and Minimalist Design | 3 | Disciplined document; residual: 6-card news grid restates the listing idiom, and its only printed dates are 2025 actions under a "right now" claim |
| 9 | Error Recovery | 4 | ZIP error re-verified in both locales: 3px ink rule + bold "Check this" label + plain recovery + aria-invalid/describedby — still best-in-class |
| 10 | Help and Documentation | 4 | Why-call teaser at the act moment, voicemail reassurance under the player, privacy terms at the close — right info at the right moment |
| **Total** | | **33/40** | **Good — trend 28 → 33 since 2026-08-01** |

# Anti-Patterns Verdict

**Not slop — and now the front door holds up to the two-second desktop look that broke it in July.** The system's spine (one green spent by law, data-earned loudness, the 3px/8px shape law, a non-interpolated ladder, no shadows) reads as a designed civic document, not a template. Deterministic scan: **0 findings across 13 source files** (July had 1 confident false positive). Verified in-browser: exactly **5 green-filled elements** — hero CTA, ZIP submit, the crown+panel (one data-earned ground, extended), feedback button — all actions or the earned slab; exactly **one amber**, with its date printed beside it; the only off-token radius on the page is the locale switch's 1.5px **concentric inner radius** (outer 3px − 1.5px border — correct math, false positive in my own audit). One residual ban-echo: the 6-card "In the news" grid (see P2). The act zone's 1–4 numbering is a real sequence and earns its numbers.

**Killed false positive worth recording:** the `ring-gap` focus border-swap looked dead under programmatic focus — it was the 150ms border transition mid-flight. Under settled keyboard focus the border swaps to paper exactly as DESIGN.md documents (`go fill | paper border | paper gap | ink ring`, computed).

# Overall Impression

The truth-first flip landed. Both July P0s are fixed and verified: the hero h1 no longer intersects the specimen at any tested width in either locale (EN 733px/ES 772px against a 992px measure at 1280; clause-clean two-line break holds at 800; 26px downstep verified at 320), and the crown's amber claim is now backed by the record's own sentence — S.J.Res 187's last action IS "Placed on Senate Legislative Calendar under General Orders," because `selectFloorVoteFeature()` now gates on `floorCalendarChamber()`. What remains is the same disease one tier down, at whisper volume: the **status bucket label** still prints "On the floor calendar" on three rows whose records say a cloture motion and two *rejected* motions. The loud apparatus is honest now; the quiet text isn't yet.

# What's Working

1. **The green crown.** Masthead fused onto the earned panel over a bright-green seam rule — the page's one ground change now carries the section title, the Stamp, and the featured bill as a single data-earned slab, and it degrades to ruled paper by the same condition that gates the panel. Verified: one green ground, five green elements, all lawful.
2. **The screencast act zone.** Real product frames (bilingual — ES pages get ES captures, verified loading), no autoplay, 44px step markers with `aria-current`, honest "about 30 seconds" claim, aria-live captions, lazy-loaded frames fetched per step. It answers "show me" without a single false frame.
3. **The honesty machinery under measurement.** All sampled text contrast computed AAA (7.87–17.66; go-pale on go-deep 6.86; ink on amber 11.44 by ledger); zero horizontal overflow at 320/390/768/800/1280 in both locales; zero console errors; the reduced-motion rule kills transitions while the Stamp's tilt (static geometry) survives.

# Priority Issues

**[P1] Three homepage rows and the specimen kicker claim "On the floor calendar" against records that say otherwise — in both locales.**
Where: `app/[locale]/page.tsx:654` (listing status: `tShared('bills.status.' + b.status)`) and `:149` (specimen kicker); label defined at `messages/en.json` `bills.status.floor_vote` ("On the floor calendar") / `messages/es.json` ("En el calendario del pleno").
Why: on the 2026-08-02 corpus, H.R. 6500's last action is a cloture motion, S.J.Res 199's is "Motion to proceed … rejected 47-52," S.J.Res 181's is "Motion to discharge … rejected 49-50" — the Senate declined to take two of these up, and the truth-first front door labels all three as standing on the calendar, directly under a weekNote that says the green panel "marks one fact." July's P0 fix landed at the panel; its second half ("rows that fail the sentence print the last action verbatim") did not. A visitor who clicks S.J.Res 199 meets a bill page that tells the truer story — the homepage loses that comparison.
Fix: rows failing `floorCalendarChamber()` print a procedural status ("In floor procedure" / the last action verbatim) instead of the bucket label. The string is shared (bill pages, /bills, embeds render the same key), so relabeling the bucket vs. adding a row-level override is an owner call. decisionNeeded.
Suggested command: $impeccable clarify (label) + $impeccable harden (gate)

**[P2] The specimen bill is the first listed row — the same headline runs the page twice, unmarked.**
Where: `app/[locale]/page.tsx:252-253` — `specimenBill` prefers a decoded non-feature from `top`, and every member of `top` except the feature renders in the listing below.
Why: the 2026-08-02 teardown fixed the hero/crown/news triple; this pair survived it. H.R. 6500's decode headline appears in the hero card and again ~1,500px down as the week's first row ("the site looks like it has one story," half-fixed).
Fix: exclude listed bills from specimen candidacy (draw from the wider decoded corpus), or mark the listing row as "shown above." Candidate-pool choice is a taste/owner call. decisionNeeded.
Suggested command: $impeccable distill

**[P2] "In the news" says "right now" while its only printed dates are Sep 16, 2025 and Dec 1, 2025.**
Where: `components/NewsLens.tsx:69` subhead ("Bills drawing real coverage across the press right now") over `BillCard`s whose sole date is `last action`. The coverage recency that would justify the claim is never printed — only the outlet count.
Why: on a product whose brand is checkable claims, the one uncheckable claim on the page is this one. July P2, persists.
Fix: print the coverage window ("covered this week by 5 outlets") or soften the subhead.
Suggested command: $impeccable clarify

**[P2] Mobile keyboard/SR focus order still detours through the bottom tab bar before any content.**
Where: shared shell (header + fixed bottom nav) — at 390px, stops 0-12 are skip link, logo, 4 header links, 2 locale buttons, then the tab bar's 5 links (rendered at y=795) before stop 13 reaches the hero CTA.
Why: sighted keyboard users bounce top → bottom → top; 4 of the 5 tab-bar stops duplicate header destinations. Skip link mitigates (2.4.3 pass, not a failure). July flag, persists. Shared-shell surface — outside this unit's edit scope, flagged for the shell's owner.
Fix: move the fixed nav later in the DOM (position:fixed makes DOM order free).
Suggested command: $impeccable adapt

**[P3] DESIGN.md still carries the retired "human-reviewed" claim.**
Where: `DESIGN.md:236` — "AI content is labeled at first contact and **human-reviewed before it drives a call**." CLAUDE.md amended this exact claim away 2026-07-25; PRODUCT.md was re-amended 2026-08-02; the user-facing strings are correct (verified: `heroAiMeta` says automated checks). The constitution contradicting itself is how the false claim leaked into strings the first time.
Fix: one-line doc amendment.
Suggested command: $impeccable document

**[P3] The paused screencast's Play overlay covers the frame the step markers just selected.**
Where: `components/HomeScreencast.tsx:88-100` — `!playing` centers the Play button over the image; stepping to a frame pauses, so studying any chosen frame happens under the button.
Fix: park the paused affordance in the caption row or a corner.
Suggested command: $impeccable polish

# Persona Red Flags

**Jordan (desktop first-timer):** July's "this site is broken" first render is gone — clean two-line hero, stroke under the promise, an honest specimen. New flag: reads "On the floor calendar" on S.J.Res 199, clicks, and the bill page says the motion was rejected 47-52 — the site corrects itself one click too late.

**Casey (one-handed mobile):** tab bar 49px + no homepage FAB — chrome is lighter than July; amber chip wraps to two lines at 390 ES but stays legible; 9.2 screens of scroll (EN) against the 9.0 baseline, 9.6 ES. Verified 44px floors on everything she taps.

**Sam (screen reader / keyboard):** the 13-stop chrome detour persists (P2 above); everything else verified strong — aria-live step announcements, labeled markers, wired ZIP error, ring-gap focus stack computing legal at every adjacency.

**María (ES-dominant, mobile):** her July worst-case is fixed — the ES hero renders intact at every width, and the claim she most needs to believe is no longer painted over. The screencast walks her through the *Spanish* UI (verified `/walkthrough/es/step-1.png`). Residual: the specimen's official text ("AGOA Extension Act") is still untranslated with no English-only note; the BQ band's AI note is now two quiet sentence-case lines instead of five shouting ones.

# Minor Observations

- The identical AI sentence ("Decoded by AI, checked against the record") appears 3× visible (specimen, panel, listing) — each labels distinct AI content on its own ground per the constitution, and all three are now unboxed and small. July's loudest instance (the caps wall) is gone. Acceptable; watch it doesn't grow.
- Footer "About"/"Terms" measure 41-42px wide (44 tall) — passes WCAG 2.5.8 comfortably, just short of the square-44 ideal. EN only (ES words are longer).
- Perf: measured on `next dev` — 3.9MB of dev JS is not a production number and was not scored. Verifiable signals are all clean: 29 requests, zero third-party, 64KB self-hosted preloaded fonts, one lazy sized `next/image`, zero console errors.
- Quiet-week and empty states are unreachable on the hot 2026-08-02 corpus; verified in source only (`weekNoteQuiet` in both locales, `UrgencyEmptyState` gated on `top.length === 0`).
- ES runs ~4-13% longer (1,459 vs 1,253 words at 1280); layouts absorb it everywhere tested.

# Audit — 18/20

| # | Dimension | Score | Key Finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 4 | Computed AAA across sampled pairs; focus stack verified legal; 44px floors held; one advisory: the mobile focus-order detour |
| 2 | Performance | 3 | Dev server — prod bundle unmeasurable (flagged); all verifiable signals clean: zero third-party, lazy sized images, preloaded self-hosted fonts |
| 3 | Theming | 4 | Both laws hold under browser measurement: 5 greens all lawful, 1 amber with printed date, radii on-token (1.5px = concentric math), no pills, no shadows |
| 4 | Responsive | 4 | Zero overflow 320–1280 both locales; h1 downstep + clause-lock verified at 320/390/768/800/1280 |
| 5 | Anti-Patterns | 3 | Detector 0 findings; residual: the 6-card news grid (identical-card echo) with stale "right now" framing |

# Questions to Consider

1. Should a status *bucket* ever print as a fact claim? "Floor calendar" could be reserved for records that say it, with everything else in the bucket reading as procedure ("In floor maneuvering") — the same split the panel already enforces.
2. The specimen exists to prove the decode. Does it have to prove it with a bill the visitor is about to see again 1,500px down — or should the front door carry two stories?
3. `NewsLens` already ships a `compact` ruled-row variant (used on /bills). What does the homepage lose if the 6-card grid becomes those rows?

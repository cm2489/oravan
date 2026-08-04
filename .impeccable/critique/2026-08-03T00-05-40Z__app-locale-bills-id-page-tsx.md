---
target: /bills/[id]
total_score: 35
p0_count: 0
p1_count: 3
score: 35
p0: 0
p1: 3
timestamp: 2026-08-03T00-05-40Z
slug: app-locale-bills-id-page-tsx
---
# Critique + audit — /bills/[id] (product register, anchored sweep, 8-bill sample)

Method: single-context unit of the pre-launch sweep (no sub-agent tool exposed to this unit). Playwright headless Chromium at 1280x900 AND 390x844 (+320/768 spot checks), EN 8-bill sample + ES 4-page subset, interaction walk (disclosure, stance -> loading -> generic error, focus walk, undecoded bill, 404), `detect.mjs` on 17 surface source files (0 findings), contrast computed from rendered hexes, journey stepper verified against all 8 records.

Sample: s-3988-119 (committee) · hr-8225-119 (markup) · sjres-141-119 (floor_vote, calendar-placed) · sjres-99-119 (floor_vote, activity-only) · s-2280-119 (passed_chamber) · hr-7147-119 (signed) · s-4511-119 (long ES headline) · hr-6500-119 (the fixed contradiction).

**Not verified (flagged):** script-success path — /api/script returns a generic error on this dev server (no key), so the drafted-script UI, call modal, ZIP/reps and switchboard states were verified by code read only, not in-browser. Production bundle weight unmeasurable from the dev server (4.3MB observed is dev overhead, not shipping weight).

## Nielsen heuristics — 35/40 (Good)

| # | Heuristic | Score | Key evidence |
|---|-----------|-------|-----------|
| 1 | Visibility of system status | 4 | Rotating drafting lines + shimmer, copy confirmations via aria-live, "You are here · date" stepper, "Data as of" stamp + client-side StalenessNote |
| 2 | Match system / real world | 4 | Decode leads in question form; journey in plain civics ("President's desk"); rejected motion printed verbatim with vote count |
| 3 | User control and freedom | 3 | Per-stance drafts survive switching; Esc closes dialog, focus returns; BUT no way to regenerate a mangled script (draft-exists early return, ActionPanel.tsx:241) |
| 4 | Consistency and standards | 3 | System is highly consistent (verified computed), but the floating CTA violates its own stand-down contract on green-band bills, and the two failure registers use different rule directions |
| 5 | Error prevention | 3 | Stances constrained, buttons disabled while loading, native dialog; generic API failure has no prevention/fallback path |
| 6 | Recognition rather than recall | 4 | Everything labeled (floating button carries text), "Three steps" roadmap, no icon-only controls, ZIP persisted |
| 7 | Flexibility and efficiency | 3 | Arrow-key radiogroup, copy script/number, tel: links; no accelerators beyond that (acceptable at this product's scale) |
| 8 | Aesthetic and minimalist design | 4 | Data-gated loudness verified live: quiet bills are unbroken paper; exactly one green band, only when calendar-placed; amber never without a printed date |
| 9 | Error recovery | 3 | 429 path is exemplary (honest fallback + countdown); generic failure names the problem + retry but dead-ends the call (see P1) |
| 10 | Help and documentation | 4 | "See how a call works" in context, why-call links at the anxiety moments, voicemail-parity + staffer reassurance |
| **Total** | | **35/40** | |

## Audit — 18/20 (Excellent band)

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 4 | Focus = visible 3px ink outline at every stop (computed); nav 44px, stance 48px, coverage preview 44x44; every contrast pair recomputed and passing (ink-2/paper 7.87, go-pale/go-deep 6.86, ink/urgent 11.44, line-strong edge 3.24); clean h-outline, real radiogroup, native dialog. Gap: 404 path serves lang="en" to ES users |
| 2 | Performance | 3 | SSG, zero images on surface, two self-hosted fonts, no layout-property animation, IO-driven floating button; production weight unverifiable from dev server — flagged, not scored down further |
| 3 | Theming / two laws | 4 | Computed styles match tokens exactly; green only on actions + stepper marks; amber only beside a printed date (live-verified in both locales); 3px marks / 8px controls verified; nothing is a pill; Besley only on decode + script |
| 4 | Responsive | 3 | Zero horizontal overflow at 320/390/768/1280 incl. 110-char ES headline; the one flaw: floating CTA collides with the green panel's CTA at 320 |
| 5 | Anti-patterns | 4 | detect.mjs: 0 findings on 17 files; no gradient text/glass/hero-metric/eyebrow scaffolding; one borderline side-stripe (Failure register border-l-[3px]) that the sibling register renders as border-t |

## Findings

### P1 — fix before launch

1. **Generic script failure dead-ends the call.** When /api/script fails non-429, no fallback script is seeded (only the 429 branch seeds one — ActionPanel.tsx:270 vs :275), and the ENTIRE call apparatus — phone numbers, ZIP form, switchboard — is gated behind `script &&` (ActionPanel.tsx:516, :742, :765). Walked live: stance click -> "Couldn't draft a script right now" -> zero phone numbers anywhere on the page. An Anthropic outage takes the product's core action down with it, against funnel invariant I2. Fix: seed the same honestly-labeled fallback template on generic failure. Effort S.
2. **Unknown bill slugs bypass the localized 404.** `/es/bills/<gone>` renders the ROOT not-found: English copy, `lang="en"`, no header/footer, system font — despite app/not-found.tsx:3-6 claiming in-app slugs are caught by app/[locale]/not-found.tsx (they are not; `dynamicParams = false` at page.tsx:56 404s above the locale boundary). Bilingual-parity hard rule broken on the exact path a re-synced/dropped bill link produces. Fix needs care: the dynamicParams=false soft-404 rationale (page.tsx:50-55) must survive — e.g. dynamicParams=true + the existing `getBill` notFound() guard. Effort M.
3. **Floating call button collides with the green panel's CTA.** FloorVotePanel's "Make your call" carries no `data-call-cta` (FloorVotePanel.tsx:161), so FloatingCallButton never stands down — at 390 both CTAs are visible; at 320 the floating button OVERLAPS the panel button (screenshots spot-320/en-floorCal-390). Violates the component's own contract (FloatingCallButton.tsx:9-12: "two identical buttons are never visible at once"). Fix: mark the bill page's panel CTA (or its section) `data-call-cta`. Effort S.

### P2

4. **Two freshness gates, one claim.** The homepage refuses the green band past the 14-day signal window (FloorVotePanel.tsx:191, with its own doc: past the window "that assertion stops being true"); the bill page renders it on any calendar placement (page.tsx:181-184) — sjres-141-119 shows "queued for a vote… can be called up with little notice" over a placement 97 days old. The printed date keeps it honest-ish; the tense doesn't. DECISION NEEDED: is the bill-page band a record-of-fact or a now-claim? Effort S either way.
5. **TL;DR meta overcounts.** "{count} questions answered below" uses `s.cost ? 5 : 4` (TldrStrip.tsx:31), which counts the TL;DR itself — pages show "4 questions answered below" over exactly 3 question sections (screenshot en-floorAct-1280-full). Both locales, shared code. Fix: `s.cost ? 4 : 3`. Effort S.
6. **No script do-over.** `if (drafts[s]) return` (ActionPanel.tsx:241) means a user who deletes or mangles their edited draft can never get a fresh AI draft for that stance. Deliberate philosophy ("your edit IS the script") — but there is no recovery affordance at all. DECISION NEEDED. Effort M (new string pair).

### P3

7. **Failure-register geometry split.** ActionPanel's Failure = `border-l-[3px] border-alert` (ActionPanel.tsx:89); the ZIP-not-found register = `border-t-[3px] border-ink` (:588, :898). Same semantic, two directions + two hues; the left-stripe variant is also the classic side-stripe anti-pattern. Pick the top-rule register. Effort S.
8. **Present tense over a dead motion.** nowFloorActivity says "the Senate is deciding whether to bring it to a vote" for sjres-99-119, whose motion to proceed was REJECTED 47-50 on Apr 29 — three months prior. The verbatim record line directly below keeps it honest; the sentence reads fresher than the fact. DECISION NEEDED (copy nuance, new keys). Effort M.

## Strengths

- **The stepper never lies.** All 8 records verified: committee/markup at the right chamber, calendar placement = green band + step agreement, cloture (hr-6500-119) correctly yields NO band + Senate step on a House bill — the July self-contradiction is confirmed fixed, in both languages.
- **The two laws hold under measurement.** Every computed color/radius/font on the surface matches the token ledger; every contrast pair recomputed passes; amber never appeared without a printed date in any state observed.
- **State craft is real.** Honest rate-limit fallback with countdown, ZIP-not-found with in-place correction, undecoded bills say so plainly while still offering the call, per-stance draft preservation, live-region confirmations.
- **Data-gated loudness works in the wild:** 6 of 8 sample pages are unbroken paper; the one green band appeared exactly where the record earned it.

## Persona notes

- **Casey (mobile):** bottom tab bar + floating CTA keep the call in the thumb zone; the 320 CTA collision (P1-3) is the one failure. ZIP persists across bills.
- **Sam (a11y):** keyboard-complete radiogroup, visible focus everywhere, native dialog focus trap, sr-only stamp sentence. The English 404 with `lang="en"` is the one failure for a Spanish screen-reader user.
- **Jordan (first-timer):** "Three steps" roadmap, hear-first + voicemail reassurance, walkthrough disclosure — best-in-class hand-holding. The generic-error dead end (P1-1) is the moment Jordan gives up.

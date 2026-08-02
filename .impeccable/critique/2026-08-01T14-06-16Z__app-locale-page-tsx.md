---
target: the shipped truth-first repositioning — homepage and key surfaces
total_score: 28
p0_count: 2
p1_count: 2
score: 28
p0: 2
p1: 2
timestamp: 2026-08-01T14-06-16Z
slug: app-locale-page-tsx
---
Method: dual-agent (A: design-review sub-agent · B: detector/browser-evidence sub-agent, isolated until synthesis)

# Design Health Score — 28/40 (Good: solid foundation, address weak areas)

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Script generation feedback is excellent; but "Three steps" never shows which step you're on, and your chosen stance takes the *disabled* treatment during the ~10s wait |
| 2 | Match System / Real World | 2 | EN front door says "4 vehicles" / "The vehicles" — insider jargon on the flagship surface; ES correctly says "proyectos de ley" |
| 3 | User Control and Freedom | 3 | Stance re-selectable, script editable, erase-all confirmed; no undo after erase, no restore-original-draft |
| 4 | Consistency and Standards | 2 | /impact sits on max-w-3xl with a text-h2 title while every other route is max-w-5xl + 56px h1 — a 128px rail disagreement with its own header; AI sentence styled 2 ways; sync date in 2 idioms; → means both "navigate" and "expand" |
| 5 | Error Prevention | 3 | ZIP input constraints good; nothing stops dialing with [YOUR NAME] unfilled, and 40% of the script hides below an inner scroll |
| 6 | Recognition Rather Than Recall | 3 | Hero specimen and green panel are the same bill under two different CTA labels, 1,500px apart, unmarked |
| 7 | Flexibility and Efficiency | 3 | Two front doors, RSS, embeds, MCP; mobile focus order detours through the bottom tab bar (stops 5–9) before content |
| 8 | Aesthetic and Minimalist Design | 2 | Five AI disclosures on one homepage (three identical); "In the news" re-presents the listing above as 6 cards; 19 interactive elements before the act zone |
| 9 | Error Recovery | 4 | The ZIP error state is best-in-class: 3px rule + "CHECK THIS" + plain recovery text + aria-invalid + live region — color the third signal, exactly as the system's own contrast law demands |
| 10 | Help and Documentation | 3 | Why-call, how-made rules, voicemail note all good; the two homepage disclosures are visually identical rows whose labels don't say what's inside |
| **Total** | | **28/40** | **Good — the spine is real; the flagship surface has two P0s** |

# Anti-Patterns Verdict

**LLM assessment: not slop — but a category-fluent visitor stops cold in the first two seconds on a laptop.** The system has a real spine: no shadows, one radius law held, one green, a non-interpolated type ladder, a gauge that measures true. Where it fails, it fails from over-adherence, not filler. Two absolute bans are violated: **identical card grids** ("In the news": six same-shape cards restating the object type the ruled listing above already presented, with internally disagreeing layouts) and **text overflow — the headline finding** (see P0 below). Eyebrow-caps register is heavy but coherent; passes.

**Deterministic scan:** 1 CLI finding across app/ + components/ — a `broken-image` warning at `app/embed/portrait/[bioguide]/route.ts:15` that is a **confident false positive** (the `<img>` is prose inside a block comment; the file emits no HTML). In-page detector (headless, all 5 surfaces): `all-caps-body` on the 188/211-char uppercase AI note (EN/ES) — **agrees with the design review's P2**; ES-only `cramped-padding` (0px vertical padding) on the "Comentarios de la beta" button — a real geometric fact the review missed; `tight-leading` 1.10–1.25 on headline links — false positive against the type ladder's own display leading; `nested-cards`/`cramped-padding` on the language toggle and `single-font` — false positives against the system's structural ink borders and deliberate single-family voice.

**Visual overlays:** headless evidence only — injection succeeded in a headless browser, and there is **no user-visible overlay tab**; screenshots archived in the session tmp directory.

**Notably:** the detector, which runs at 390px, could not see either P0 — one manifests only at desktop widths, the other lives in data semantics. The two assessments overlap on exactly one finding (the all-caps wall) and complement on everything else, which is the point of running them blind.

# Overall Impression

A shipped system with genuine integrity — the honesty machinery (data-gated loudness, measured density, tri-signal errors) is the best of its class — undermined at the front door by two self-refuting failures: the headline paints over the product's own core claim at every desktop width (worst in Spanish), and the homepage's amber "on the floor calendar" claim is contradicted by the very record it cites while the bill page, one click later, already applies the honest gate. The single biggest opportunity: make the homepage as honest as the bill page it links to.

# What's Working

1. **The ZIP error state** — 3px ink rule + bold alert label + plain recovery copy + full ARIA wiring. The system's own contrast ledger says color can never be the first signal; the implementation actually obeys.
2. **"Your five minutes, drawn to scale"** — the gauge bars and the printed durations come from the same constant, so the drawing cannot lie; the honest shape (three tiny marks, one long one) persuades better than any copy.
3. **The script moment** — progress feedback, the reading voice at 18px, and the unprompted after-hours voicemail reassurance land the product's emotional peak exactly where the nervous first-timer needs it.

# Priority Issues

**[P0] The hero h1 overlaps the specimen card at every desktop width, in both locales.**
Why: first render on a laptop is broken type on the flagship surface of a trust product; in Spanish the collision erases "EN PALABRAS CLARAS" — the page's own claim, deleted by its headline. Measured +47px EN / +128px ES at 1280–1024; +144px ES at 900.
Fix: the `whitespace-nowrap` keeping the go-stroke continuous is incompatible with the fixed 1.1fr column at 68px. Either draw the stroke as a bottom-anchored background band with `box-decoration-break: clone` so the beat can wrap, or cap the h1 against the **Spanish** string width (the system's own bilingual rule). Add a Playwright non-intersection assertion at 768–1280 both locales — the existing overflow test checks the viewport edge only, which is why this shipped.
Suggested command: $impeccable adapt

**[P0] The homepage's amber floor-calendar claim is falsified by the record it cites — and the bill page already knows.**
Why: the featured bill's last action is a cloture motion, not a calendar placement; the bill page's strict `floorCalendarChamber()` gate correctly refuses the band, but the homepage uses the loose `status === 'floor_vote'` gate and prints "ON THE FLOOR CALENDAR · JUL 30, 2026" in amber on the page's one earned green ground — directly above `weekNote`'s promise that "the green panel marks one fact." Two listed bills whose motions were *rejected* carry the same label, while the one bill genuinely placed on a calendar sits in a plain row. The loudness mechanism is inverted against its own data, and the design doc names this exact failure mode.
Fix: promote `floorCalendarChamber()` to `lib/` and gate both `selectFloorVoteFeature()` and row labels with it; when nothing passes, ship the quiet paper column the system already declares honest; rows that fail the sentence print the last action verbatim.
Suggested command: $impeccable harden

**[P1] "My record" is on a different rail at a different scale from the entire site.**
Why: max-w-3xl + text-h2 title vs. max-w-5xl + 56px everywhere else (h1 at x=272 against a header at x=144); centre-aligned empty state in a left-aligned document system. The one page a returning user has feelings about looks like a different product.
Fix: max-w-5xl, text-h1-bill, left-aligned empty state opened by the standard 3px ink rule.
Suggested command: $impeccable layout

**[P1] On a phone, the script is read through a 60% window under a button that covers the page.**
Why: 262px textarea holding 435px of content — an inner scroll inside a page scroll for the words a nervous person is about to say aloud; the floating call button permanently overlaps the reading column; nothing gates "Start the call" on `[YOUR NAME]` still being unfilled.
Fix: auto-grow the textarea on mobile; reserve bottom padding equal to the FAB; a `role="status"` "two blanks left to fill" nudge reusing the proven ZIP-error pattern.
Suggested command: $impeccable adapt

**[P2] Five AI disclosures on one homepage — and "In the news" re-presents the week's listing as cards.**
Why: three of the five are the identical sentence; the Big Questions note is 30 words of 12px letterspaced caps (five lines in Spanish — the loudest thing in the band, louder than the questions it introduces; the detector independently flagged it). Repetition turns a trust signal into wallpaper. The news cards duplicate the object type above with no stated ordering, and two entries claim "right now" over Sep/Dec 2025 actions. Also: the ES-only feedback button renders with 0px vertical padding (detector).
Fix: one AI chip per ground; sentence-case the band note at text-sm; convert news cards to the ruled-row idiom or give the section a genuinely different job and a freshness floor; pad the ES feedback button.
Suggested command: $impeccable distill

# Persona Red Flags

**Jordan (first-timer, desktop):** lands on a headline printed over another element's label — "this site is broken." The decoding demo shows three official words becoming eleven plain ones — the trick backfiring (specimen gates only on decode existing, not on the gap being persuasive). Clicks the urgent green slab; arrives at a page with no band, no amber, no date — the reason he clicked evaporates. Two identical disclosure rows both end in →, which elsewhere means navigate.

**Casey (one-handed mobile):** thumb zone contested by a 5-tab bar + floating button + top-corner language toggle (~18% of the viewport is chrome); stance greys out for 10s inviting a second tap; the script's inner scroll is a classic mis-scroll trap.

**Sam (screen reader / keyboard):** mobile focus order runs header → bottom tab bar (y=796) → back up to content (y=469) — a WCAG 2.4.3 concern the skip link mitigates but doesn't fix; disclosure arrows are aria-hidden and never flip, and `list-none` suppresses the native triangle, so sighted keyboard users get no open/closed affordance. Verified strengths: clean heading structure, landmarks, labeled logo, wired error states, 44px floors held.

**María (Spanish-dominant first-time caller, at-risk, mobile):** her hero is the worst collision instance — the destroyed words are the claim she most needs to believe. Her specimen's "official text" is three untranslated English words with no note that official titles are English-only, so the decode's persuasive contrast never fires. The band's AI note is five lines of shouting caps. Verified strengths: the thumb-reachable "View in English" link and the calm, adversary-free privacy story — the thing that matters most to her — hold up.

# Minor Observations

- ES runs 4–14% longer on every surface; layouts absorb it; zero console errors, zero horizontal overflow across 8 combos.
- Big Questions rows: `flex-wrap items-baseline` lands the date at different x per row — reads broken, not ragged-on-purpose.
- /moments prints the sync date as plain text while / uses the Stamp — the doc says the Stamp is the sole printed sync date.
- The green panel at 1280 leaves ~40% empty enamel.
- /moments desktop: prose at ~660px against a 1136px card grid — stepped right edge.
- DESIGN.md cites 2,373 bills; the corpus is 2,566 — doc staleness, not code.
- Uncertainty flags (from A, honest): the ES "verificada" agreement in howMadeBody needs a native-speaker read; the post-call outcome-log state and /moments/[id] were not exercised.

# Questions to Consider

1. **What does the homepage look like on a week when no bill earns the strict gate — and is that the product you keep saying you want?** The quiet paper column is the system's own stated honest outcome; ship the strict gate and let the corpus decide how often green appears.
2. **Why is the specimen gated on the decode existing rather than on the gap being persuasive?** Data-gated loudness applied to your best proof: only perform the trick on days it's devastating.
3. **What would My Record look like designed as the emotional payoff of the funnel rather than local-storage administration** — the ruled ledger with rows waiting, visible before the first call is ever made?

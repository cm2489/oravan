# Truth-first repositioning + rename — the spec

**Status: for owner review.** Decided 2026-07-26 (HANDOFF.md §8): this is a **repositioning, not a re-scope** — the platform leads as the unbiased source of truth on an issue; calling your rep becomes the natural next step after engagement. A rename precedes launch. Every hard boundary survives: no Moment without a real legislative vehicle, absence is a finding, news stays instrumental. The re-scope question is pinned to the Feb 2027 gate (HANDOFF.md §9).

This document is the complete implementation spec plus the decisions that need the owner's pick. **Mockups are live at `http://localhost:3500/preview/home`** (worktree dev server, three hero variants × EN/ES). Section 9 lists every decision; nothing lands until those picks are made.

## 0. Decisions of record — Colby, 2026-07-31

1. **Hero variant C** ("Minimal move"): two-beat h1 keeping the go-stroke — "Understand it in plain words. / Then make it count." · "Entiéndelo en palabras claras. / Luego haz que cuente." — jump-to-week promoted to the filled control, ZIP demoted below it. Variants A/B retired. **The consolidated act zone ships** (it was the shared body of every reviewed mockup).
2. **The feature formerly called "Moments" becomes "Big Questions" / "Grandes preguntas."** Label-only in this train: nav, band title, page titles, and copy change in both locales; the `/moments` route, internal code names, and data files keep the `moment` identity until the company-rename migration, whose sweep and redirect machinery is the right place to move an indexed URL. (Recorded so the two-name state reads as a decision, not drift.)
3. **Moment ranking: legislative-proximity first** (floor calendar → effectiveUrgency → cross-spectrum breadth; article volume strictly tiebreak). Eviction stays lifecycle-only, never news-decay.
4. **The 6-live cap stays**, with the falsifiable revisit trigger (§9 decision 5).
5. **/impact retitles to "My record" / "Mi historial"** (nav) with the page as "Your civic record" / "Tu historial cívico" (§4).
6. **The visual-design layer (green header systems, the three Round-2 directions) is parked** until the creative-director skill's issues are resolved; this train ships the repositioning in today's colors. The mobile-density pass (type floors h1 40→32, h1-bill 32→28, h2-loud 26→24; copy diet; act-zone disclosures) rides the flip PR, and DESIGN.md gains a mobile-density law: audit at 390×844 with measured numbers before and after any surface change.
7. Still on their own clocks, not blocking this train: the company name (Actario vs Rasero + the human ES spot-check; lock target Aug 15) and the pledge wording (before the ~Sep 22 post).

---

## 1. Why, and why this shape

Colby, 2026-07-26: *"The whole platform needs to be geared towards being the unbiased source of truth on any issue. The call your rep feature should be a secondary add once people are engaged in the topic… Right now it feels like an assignment."* And: *"I can't push this live without a good name change."*

The strategic reason the scope stops at repositioning: it keeps the product in a lane with no incumbent — legislation-first, free, private, ending in an action. Re-scoping would move it onto Ground News / Tangle's turf while demoting the one differentiator neither has.

Two facts found during this exploration sharpen the case:

- **The rename is also defensively necessary.** `docs/migration/trademark-prep.md` records an identical mark in active US commerce: Oravan™ / Oravan™ Herbst (OravanOSA LLC, an FDA-cleared Class-10 medical device, with third-party spread and a litigation docket). Identical marks cut hardest even cross-class. The rename converts a legal exposure into a strategic move.
- **The product already does the truth-first job.** Moments, the live layer, decoded bills, lean-as-word-never-color coverage, freshness honesty — all shipped. What signals "assignment" is a short, concrete list of surfaces (§2–§5). This is a framing-and-funnel change, not an architecture change.

## 2. The homepage, reframed

New narrative arc: **UNDERSTAND → ACT → TRUST → SUPPORT.** Today's arc opens with an assignment (ZIP form under "Five minutes. One call.") before the visitor has learned anything.

### 2.1 Hero

The h1 stops being an assignment and becomes the truth promise. Three candidates (both locales; pick on the mockups):

| Variant | H1 (EN / ES) | Go-stroke | Primary affordance |
|---|---|---|---|
| **A — "Plain answer"** (recommended) | "What Congress is doing, in plain words." / "Lo que hace el Congreso, en palabras claras." | **dropped** in hero | Issue search → `/bills?q=…` |
| **B — "Featured decode"** | same as A (or the two-beat below) | dropped | The week's top bill decoded inline, "Read the full decode" CTA |
| **C — "Minimal move"** | "Understand it in plain words. Then make it count." / "Entiéndelo en palabras claras. Luego haz que cuente." | **kept**, under "make it count" | Existing `#top-actions` jump promoted to the filled button |

**The go-stroke fork, made explicit:** DESIGN.md's rationale is that the stroke sits under *the thing being measured* — the 5-minute route measures the call. A pure truth h1 (A/B) has no measured promise in it, so the hero stroke is dropped and the go-mark appears once per page (the route gauge); that is a one-line DESIGN.md amendment. Variant C's second beat keeps the stroke legitimately.

**ZipForm** leaves the hero (variants A) or demotes to a quiet outlined secondary (B/C — a variant axis on the mockups). Mechanical fact, verified: `tests/funnel.spec.ts:93` and `tests/landing.spec.ts` locate the ZIP field page-wide via `getByLabel`, and Playwright auto-scrolls — moving ZipForm down the page changes **nothing** in the ZIP-first invariant or its click count.

**The phone-transcript aside** is replaced in the hero by a **decoded specimen** — the product's core move shown, not told: one sentence of the featured bill's official text, then its plain-words decode with the AI chip. Real data, never fiction. The transcript aside relocates intact (same keys) to the act zone, where "the fear, named and answered" belongs — right before the ask, not before the reading.

### 2.2 Page order

1. **Hero** — truth promise + truth affordance + decoded specimen. Paper.
2. **Moments band** — promoted above the week (see §7.1). Stays ink: the color law governs how many grounds a page has and what earns green, not their order. Gains the scarcity line — at the front door, "never more than 6" *is* the credibility claim.
3. **The week** — `section[aria-labelledby="top-actions"]`, **id frozen** (test boundary). Title `home.topTitle` "Worth a call this week" → direction "Moving in Congress this week" / "Esta semana en el Congreso". `topSub` and `floorCta` ("Read it in plain words") are already truth-first — kept verbatim. **FloorVotePanel stays here and stays the page's only green slab.**
4. **NewsLens** — unchanged; now reads as evidence for the truth claim.
5. **Act zone (new, consolidated)** — "Ready to make it count?" / "¿Va a hacer que cuente?": ZipForm, the 5-minute route gauge, CallWalkthrough, the relocated transcript, the why-call teaser. One strong act zone instead of four scattered call sections — "natural next step" made literal in page structure. Ruled paper; no third ground.
6. **Privacy band** — unchanged. 7. **Donate band** — unchanged, last.

Two comment blocks in `app/[locale]/page.tsx` (the hero rationale at :157-161 and the "discovery sits UNDER the week" owner ruling at :407-417) are rewritten in the same PR to cite the 2026-07-26 decision — otherwise the file lies about itself.

## 3. The funnel invariant, consciously rewritten

`tests/funnel.spec.ts` enforces "≤3 clicks to a completed call script" as the governing invariant. Calls becoming secondary means this is **rewritten deliberately, never quietly broken**. Three named invariants replace it:

- **I1 — Truth (new, primary).** Every truth surface on the homepage is ≤1 click from a decoded, AI-labeled answer, in both locales. Boundaries: bill links in `section[aria-labelledby="top-actions"]`; Moment links in the promoted band. Proof at destination: the `bill.sec.what` heading + the `bill.aiChip` label visible (bill), the "Where it stands" region (Moment).
- **I2 — Call path (preserved).** From any decoded answer, a completed editable script is ≤2 interactions away (stance radio → visible `bill.scriptTitle` textbox); ZIP-first stays ≤3 clicks end-to-end via `section[aria-labelledby="reps-next"]`. The bill page's sticky two-column rail (DESIGN.md structural constraint 1 — untouched) is what makes I2 true: **demote, never bury, enforced structurally.**
- **I3 — Quiet-week honesty (unchanged).** Empty truth surfaces show `role=status` honest empty states; neither entry point dead-ends.

**Frozen identifiers:** `top-actions`, `reps-next`, `moments-strip-title`. Heading copy may change freely; ids may not — the specs read them.

## 4. `/impact` → the civic record

Keep the URL. Retitle: `impact.title` "Your impact" → **"Your civic record" / "Tu historial cívico"**; nav `common.nav.impact` "My impact" → "My record" / "Mi historial" (+ `navShort`).

- **New store `oravan.reads`** in `lib/local.ts`: `{ billSlug, billLabel, at }`, upsert per slug (newest wins), cap ~100, validated with the existing snapshot pattern. Writer: a tiny `<ReadReceipt>` client component mounted in the bill page's reading column. Device-only — and *said*: a `readsNote` string mirroring `bills.interestsNote`.
- **Erase completeness (hard requirement):** `eraseAll()` gains the reads key; `impact.eraseConfirm` re-enumerated in both locales ("your ZIP, interests, reading history, and call history"); the privacy page's enumeration audited in the same change.
- **Page order:** What you follow (chips from `prefs.interests` → filtered `/bills`) → What you've read → **Your calls** (existing stat trio + history, kept intact, third position — the calls remain the celebrated outcome). Empty-state CTA → "Find a bill that affects you".
- **Recorded non-choice:** an explicit "Follow this bill" button (`oravan.follows`) is the cleaner consent posture but is feature scope, not copy/IA scope — deferred, noted as the natural v2.

## 5. Copy pass inventory (EN+ES lockstep, ordered)

1. `home` hero cluster + new specimen/act-zone keys (per chosen variant). `tests/landing.spec.ts` hard-asserts the current h1 — same-PR test edit.
2. `home.topTitle` (de-assignment); `topSub`/`floorCta`/`aiReviewed` kept.
3. `impact.*` (17) + nav labels + new reads keys (§4).
4. `bills.band.now` "Calling now" → "Deciding now" / "Decidiéndose ahora"; its sub keeps "a call lands hardest here" as the next-step line.
5. `reps.nextTitle`/`nextSub` — reviewed, likely kept near-verbatim: a visitor who just typed a ZIP is engaged; call-forward copy is *earned* there.
6. `common.tagline` "Your line to Congress" + `footer.mission` + `manifest.description` + the **hardcoded** OG strings (`app/[locale]/opengraph-image.tsx:8-11`, both locales' `tag`+`sub`) — **final wording lands with the rename** (name and tagline are one identity decision); the mechanics are done in the copy PR with an approved name-agnostic placeholder.
7. **Deliberately NOT rewritten:** `bill.*` (105 keys), `why.*`, `walkthrough.*` — the bill page is where the call *is* the point. This line exists so the non-change is recorded as a decision.
8. **Frozen:** every `home.zip*` key (label, cta, help, placeholder, invalid, errorLabel) — shared by the bill-page dialog ZIP fallback and seven `embed-*.spec` files; the embed widget ships this copy to partner sites. Neither names nor values change in this pass.

## 6. Constitution amendments (draft text, lands with the flip PR)

**README.md, design principle 4** (replaces "The call moment is the product."):

> **4. Truth first; the call is the natural next step.** Oravan leads as an unbiased, plain-words account of what Congress is actually doing — understanding is the front door, never an assignment. The call apparatus stays the differentiator (voicemail legitimized, after-hours encouraged, district offices listed, outcomes logged locally), and every decoded answer keeps a completed call script within two interactions. Demoted, never buried. *(Amended 2026-07-26; previously "The call moment is the product.")*

**CLAUDE.md, hard rules** (one deliberate amendment, in the 2026-07-25 style):

> - **Truth-first, call-next.** Amended 2026-07-26: the product leads as the unbiased plain-words source on any issue; calling is the natural next step after engagement, not the price of admission. Enforced by named invariants in `tests/funnel.spec.ts`: every homepage truth surface is ≤1 click from a decoded, AI-labeled answer (I1), and every decoded answer keeps a completed call script within 2 interactions, ZIP-first ≤3 clicks (I2). Demote the call apparatus, never bury it. Unchanged: no Moment without a legislative vehicle, absence is a finding, news stays instrumental.

**DESIGN.md, structural constraint 2** (constraint 1 untouched):

> 2. **The funnel has two halves, and the specs read fixed boundaries.** Truth half: every bill link inside `section[aria-labelledby="top-actions"]` (and every Moment link in the promoted band) reaches a decoded, AI-labeled answer in ≤1 click. Call half: from any bill page, stance → script is ≤2 interactions (the sticky rail), and the homepage ZipForm keeps ZIP-first at ≤3 clicks. Every top-action bill link stays inside `top-actions` — the funnel and freshness specs read that boundary — and the section stays full-width with the max-width wrapper inside it. The ids `top-actions`, `reps-next`, `moments-strip-title` are frozen: heading copy may change, ids may not. *(Consciously rewritten 2026-07-26 from "≤3 clicks to a completed call script" — see this spec.)*

If a stroke-dropping hero wins (§2.1 A/B), the go-mark paragraph in DESIGN.md ("used exactly two ways") is amended to one way in the same PR.

## 7. Moments becomes the front door

### 7.1 Architecture: promote the band, keep the route

`/moments`-as-homepage was considered and **rejected**: with 2 live Moments and honest quiet weeks, the empty state would become the site's first sentence; the homepage carries five other jobs with no other home at that prominence; and `/` holds the site JSON-LD, RSS alternates, and the hreflang set. Instead the existing ink band moves **above** `top-actions` as the dominant truth band, upgraded to front-door register: name, first sentence of "What Congress is deciding", vehicle count, latest-update day, and the scarcity line. When zero Moments are live the band vanishes and the truth claim survives in the hero — carried by copy, not by a band faking fullness. `tests/moments.spec.ts:166-173` (band-after-week DOM order) flips its expected value in the same commit, citing this decision.

### 7.2 Bill → Moment backlink (gap: a bill doesn't know it's a vehicle)

`getMomentsForBill(slug)` — a read-time filter in `lib/moments.ts` over `getMoments()` (no build-time reverse index; freezing state is what that file's header forbids). Visibility: **live + stale only**. Rendered as a quiet ruled line in the bill header after the chips row, ink link, never green: `moments.partOf` — "Part of a bigger question: {name}" / "Parte de una pregunta más amplia: {name}".

### 7.3 Alias search (the never-built v1 §4.2 promise)

`lib/moments-ui.ts`: `getMomentSearchTeasers(locale)` (live Moments only, per the standing search-pinning rule) + pure `matchMoments(query, teasers)` (≥2 chars; bidirectional containment — "ukr" → "ukraine", "war with iran today" → alias). `BillsBrowser` gains an optional `moments` prop; on a match, a pinned ink row renders above the count line — "Moment" chip, name, dek, link. Aliases are never displayed; the `aria-live` bill count stays bills-only. This also fixes the dead end: "ukraine" with zero bill matches now surfaces the Moment.

### 7.4 The candidates report + the Feb 2027 instrument

`scripts/moment-candidates.mjs` — zero network, zero AI. Press bar: coverage tier `cross`|`neutral` ∧ never a vehicle in any Moment ∧ non-terminal status. Ranking (the concrete embodiment of §9 decision 3): floor-calendar match, then `effectiveUrgency`, then tier/leans/outlets breadth, article count strictly as tiebreaker and printed as *"a floor, not a measurement"* (capped at `COVERAGE_PER_BILL=5`). Carries an import-free copy of `coverageTier` with a drift-pin unit test (the `check-moments.mjs` discipline). Output: ranked markdown (+`--json`), and this standing line on every run:

> *This report never creates, proposes, or drafts a Moment. A Moment is hand-authored in both languages and exists only when the owner merges it.*

Optional second step: append the markdown to `$GITHUB_STEP_SUMMARY` in the nightly sync — a read-only CI artifact, no commit, no PR. That boundary is the difference between this and the proposal system v1 deliberately never built.

**The rejection log** — `docs/moment-rejections.json` (in `docs/`, never bundle-importable): append-only, owner-edited by PR — `{date, topic, why_no_vehicle, evidence[], revisit_when}`. The report prints it on every run. A year of this file is the honest evidence for the Feb 2027 re-scope decision. Current data, for calibration: **40 bills clear the press bar today; 7 also had action within 14 days** (the 2027 NDAA leads on outlet count).

## 8. Post-approval PR train

Positioning-neutral work first; the flip lands last, alone, after mockup sign-off:

1. **constitution-07 fix** — raw machine tokens rendered to readers ("Rewritten because seed" / "Se reescribió porque seed") — a live bilingual-parity violation, independent of positioning.
2. **Candidates report + rejection log** (§7.4).
3. **Bill→Moment backlink** (§7.2).
4. **Alias search** (§7.3).
5. **constitution-05 + 08 riders** — the AI chip on the moment vehicles grid (unlabeled AI beside the "Read + call" CTA) and provenance-gating the "Where it stands" chip — plus **constitution-02** (CoverageSection renders third-party advocacy headlines unquoted): a truth-first homepage funneling into unquoted advocacy snippets is the repositioning's most attackable seam. These land **before** the flip, which multiplies traffic into exactly these surfaces.
6. **The flip** — chosen hero + page reorder + act zone + comment-block rewrites + `moments.spec`/`freshness.spec` order flips + `landing.spec` h1 update + the missing `/moments` nav test (test-honesty-010).
7. **Civic record page** (§4).
8. **Copy inventory + constitution amendments + funnel.spec restructure** (§5, §6, §3).

PRs 1–4 are v1's own unshipped promises — worth landing even if the flip is rejected. Estimated total: ~1 week, matching the decision record.

## 9. Decisions for the owner

| # | Decision | Recommendation | Where to look |
|---|---|---|---|
| 1 | Hero variant A/B/C | **A** ("Plain answer") | `localhost:3500/preview/home` — check `/es` and 320px |
| 2 | Go-stroke in hero | Drop (follows from A; C keeps it) | mockups + §2.1 |
| 3 | Act-zone consolidation | **Yes** | mockups (shared body) |
| 4 | Moment ranking | **Proximity-first** (see below) | §7.4 + table below |
| 5 | 6-live cap | **Keep**, with a falsifiable revisit trigger | below |
| 6 | The pledge | Genuinely yours; options below | below |
| 7 | `/impact` retitle | "Your civic record" / "Tu historial cívico" | §4 |
| 8 | Name finalists + migration timing | §10 (evidence table + calendar) | §10 |

**Decision 4 — ranking.** Volume-first (your proposal): tracks public attention in real time, but volume is the one input an adversary controls (v1's own "asymmetric selection drift" abuse case), news-decay eviction pulls a bill from the front door exactly as its vote arrives, and volume is **not measurable today** — `COVERAGE_PER_BILL=5` truncates counts, `COVERAGE_TOP_N=150` halves the candidate set, `publishedAt` is day-granular; making it measurable ≈ 6× TheNewsAPI request volume and a paid-tier bump. Proximity-first: floor action → `effectiveUrgency`, cross-spectrum breadth second, volume as tiebreaker — fully measurable now, $0, ungameable by amplification. With the 6-cap and hand approval, ranking only *orders your shortlist* — an ordering error costs one scroll of your attention, so the tie breaks toward the input nobody can buy. Ratified regardless of the pick: **eviction is lifecycle-only, never news-decay.**

**Decision 5 — the cap.** At the front door, scarcity is the proof someone said no: "never more than 6" is the credibility claim, and 40 qualifying bills against a cap of 6 means the cap is doing real work — the candidates report, not a higher cap, is the valve for the surplus. Revisit trigger so this stays falsifiable: if the report shows >6 proximity-qualified candidates you genuinely want live for ~3 consecutive weeks, reopen it with the report history as evidence.

**Decision 6 — the pledge** ("1,000 calls logged by Nov 3," posting ~Sep 22; `docs/press/launch-pledge.md`, docs-only, zero code surface). A truth-source positioning with a call-count scoreboard is a visible contradiction — your call, resolved deliberately now rather than discovered in October. Options: **(a) keep as-is** — the forcing function intact, the contradiction absorbed ("we measure the action our truth produces"); **(b) reframe** — keep the date and a number, lead with the record ("every active bill, decoded in two languages, checked nightly against the official record — and 1,000 informed calls by Nov 3"), the scoreboard becomes the *output* of understanding; **(c) drop the number, keep the date** — a dated launch commitment without a scoreboard. **Flagged fact either way:** the public tracker is unbuilt, and with no server-side user data by constitution, the counting mechanism for ANY call-count pledge is undesigned — calls are logged in each visitor's localStorage only. That constraint deserves a decision before the pledge posts, whichever option wins.

## 10. The rename

*(Naming funnel results — evidence table, cold-read panel, finalists — land in §10.4 below when the runs complete.)*

### 10.1 What the name must do

Encode truth-first: record/ledger, evidence/verification, plain-language, primary-source semantics. Excluded outright: call-to-action semantics (that's the demoted framing — encoding it means renaming twice), news-brand morphology (-wire/-post/-press/-times/-herald/-desk/-report), partisan or movement coding, and anything colliding with the retired-name patterns or containing "oravan". Generated by the house method (Latin/Romance roots — the reason Oravan worked unmodified in Spanish sentences), **with the real etymology logged at generation time** — `common.footer.lore` and the README origin line must be writable truthfully from the log. The standing exhibit for why: `README.md:7` still carries the *rostra* etymology find-replaced onto "Oravan," contradicting the shipped footer lore. Name-meaning prose gets a hand pass; the gate can't catch a wrong claim about the new name.

**Hard gates (any failure kills):** G1 Spanish pronounceability (pass/fail — the house standard); G2 cold-read spelling accuracy (rank against anchors; Oravan scored 85.7%, Civistry died at 16%); G3 zero toxic guesses + political cleanliness two-pass (FEC/OpenSecrets/Ballotpedia/InfluenceWatch); G4 `.org` available or cheaply acquirable; G5 no identical-mark commercial use in adjacent classes (the OravanOSA lesson); G6 `check-naming.mjs` compatibility (present and future patterns); G7 LinkedIn company page claimable; G8 npm/PyPI/GitHub free.

**Soft preferences:** strong standalone first glyph in Instrument Serif (the lone-initial lockup conceit: A C G Q R S V strong; I J L weak); ≤3 syllables/≤8 letters; unmodified in Spanish sentences; no category-priming tail (the "-van" tail cost Oravan 54% travel/vehicle priming); matching EN/ES stress; a true etymology worth telling.

### 10.2 The funnel as run this session

Longlist 30 → mechanical triage → 11 → web vetting (identical-mark, news adjacency, political two-pass, RDAP domains, npm/PyPI/GitHub, LinkedIn best-effort) → shortlist → blind cold-read panel → 2–3 finalists.

**Triage kills worth recording** (each is a reusable screen example): *Candara* and *Verdana* are Microsoft fonts; *Cabal* is toxic in EN politics; *Censo* reads as "censor"; *Asiento/Asienta* carry the Asiento de Negros history; *Dafé* → auto-da-fé; *Averio* → avería (breakdown); *Cotejo* fails EN pronunciation (the j); *Vigente* splits EN/ES on the g; *Actavo* ≈ Actavis (pharma); *Origo* is a Hungarian news site; *Verbatim* is a storage brand; *Fuentia* muddies source/font; *Anota* is an imperative — an instruction, the exact register being retired.

**The cold-read stand-in:** 35 isolated, fully blind subagent reads per candidate (25 EN, 10 ES — ES deliberately oversampled vs. its ~5–7% audience share, as in the human run), four axes: spelling from an IPA stimulus (heard→written), pronunciation from the written form (separate instances — never shared), free-association toxicity, category priming. **Calibration anchors: Oravan and Civistry run through the identical protocol.** If the panel does not directionally reproduce the known human ordering — Civistry flunks, Oravan passes, the -van priming visible — the panel is broken and its scores are not used. Selection is by rank against anchors, never absolute score (LLM readers spell better than humans and share priors). This approximates and does not replace the human panel; a human spot-check on the finalists (you + 2–3 Spanish speakers, informal) is recommended before name-lock.

### 10.3 Executing the rename (deltas from rostra→oravan; machinery otherwise reused wholesale)

1. **The gate grows to two retired generations:** add the `ora`+`van` fragment pattern; move `'Oravan'` from `FIXTURES_GOOD` (line 53) to `FIXTURES_BAD`; add the new name to `FIXTURES_GOOD`.
2. **13 tracked filenames `git mv`'d** (8 `assets/brand/` SVGs, 3 `components/brand/` TSX, 2 docs) — filenames are never allowlistable; precedent exists from S0.
3. **`lib/local.ts` shim goes to generation 3** — `oravan.prefs`/`oravan.calls` join the legacy map; allowlist max 4→6. The 8 R1 dated-doc exemptions re-affirmed in `decisions.md` as now holding two retired names.
4. **New master drawing — the longest creative lead.** The lockup's geometry (crop at 655, scale, offsets) derives from the literal letterforms of "Oravan"; a new name means a new Instrument Serif drawing, a decision on whether the lone-initial conceit survives (grade the new initial), and regeneration of the five derived artifacts (favicon, two app icons, apple-touch, OG lockups). `scripts/gen-app-icons.mjs` still hardcodes retired Field Notebook hexes — fix in passing.
5. **Name-meaning prose hand-pass:** footer lore EN+ES from the logged etymology; **fix README.md:7's rostra-etymology defect**; manifest; About.
6. **The embed-theming API needs a deprecation shim — new requirement.** `--oravan-*` CSS custom properties, `data-oravan-*` attributes, and the `'oravan-embed'` postMessage source are tenant-facing public API. Dual-accept (old mapped→new) for a documented window with a stated sunset; re-verify the "no external embedders yet" claim first — the site has been soft-public since 2026-07-09.
7. **MCP is a re-publish, not a rename:** new `org.<name>/mcp` registry entry, old one deprecated; Glama re-claim; follow-up PR amending awesome-mcp-servers #9939.
8. **Stripe (owner):** product names behind 4 live payment links + donation link + portal display name + **the statement descriptor**; verify whether any payment-link URLs encode the name.
9. **SEO track — entirely new; the last rename happened behind noindex, this one doesn't.** oravan.org is indexed (3,596 sitemap URLs). Permanent 301 map at the Vercel domain level; oravan.org stays registered and redirecting indefinitely (a defensive asset); Search Console Change of Address; `lib/site.ts:10` `SITE_ORIGIN` remains the single-constant code change by design.
10. **R6 extends:** after `cm2489/oravan → cm2489/<name>`, neither `cm2489/rostra` **nor `cm2489/oravan`** may ever be recreated. New written R-decision.
11. Sundries: `hello@` cutover with forwarding; workflows' `user.name` (email never touched — Vercel blocks unlinked authors); `verify-deploy.mjs` meta marker; Vercel project/hooks/PROD_URL.

**Timing (recommendation): one combined migration, mechanical rename first, copy second.** Both workstreams rewrite the same message namespaces; sequencing them means touching every renamed-and-repositioned string twice and running the persona gate twice (it took three rounds last time). The S3/S4 split keeps the diffs reviewable: the grep-verifiable rename PR merges before the judgment-heavy copy PR, so the copy pass works in a tree where the old name cannot reappear.

**Calendar against Sep 22** (today 2026-07-27): spec approved ~Aug 1 → funnel/human spot-check Aug 1–14 → **name locks Aug 15 (hard), attorney engaged at lock** (clearance is the one multi-week external dependency; filing itself waits for the domain per the standing rule) → master drawing + sweep + copy Aug 15–29 → persona gate + zero-survivor audit ~Sep 5 → cutover week of Sep 8 → buffer to Sep 22.

### 10.4 Funnel results — evidence table and finalists

Run 2026-07-27: longlist 30 → mechanical triage killed 19 (§10.2) → **15 web-vetted in two waves** (11 + 4, one research agent per name: identical-mark, news adjacency, FEC/political, RDAP domains, npm/PyPI/GitHub, LinkedIn, foreign meaning) → **3 survivors** → blind cold-read panel (5 names × 35 isolated reads = 175, including both calibration anchors) → **2 finalists**.

**Vetting kills, one line each (full evidence preserved in the session workflow journals):** Aplomo (live USPTO filing, Aplomo Tequila, GA — which already sells the identical "poise/plumb" etymology — plus aplomo.app, a Spanish-language SaaS); Verista (Verista Inc., ~$148M US software-services firm, owns the .com); Contraste (contrasteapp.com, a shipping accessibility contrast checker — identical goods — plus two IT firms); Veridia (VERIDIA USPTO registration + ~6 active users incl. two Play-Store apps); Constata (constata.eu, a document time-stamping/verifiable-credential platform — the exact job); Certeza (Certeza Group + Certeza LLC IT-assurance + certeza.app + two mobile apps; also a news-adjacent kill); Clareza (getclareza.com workflow SaaS + CLAREZA USPTO filing; descriptive PT noun); Compulsa (legally clean but heard as "compulsion/compulsory" in EN — a coercion echo on a civic product); Refrendo (in Mexican Spanish the dominant meaning is the annual **vehicle-registration tax** — state portals, bank apps, and TikTok how-tos own the term; ES search unwinnable); Acervo (acervo.org is a live archival-description SaaS using the identical name *and* the identical etymology pitch); Glosa (Monotype typeface trademark + glosa.ai + a language app + more); Certero (Certero, ~20-year UK ITAM software vendor with a Chicago office).

**The three survivors, vetted:**

| Gate | **Rasero** | **Acrisol** | **Actario** |
|---|---|---|---|
| Identical mark (G5) | flag — only Rasero Industries (WA cabinetry, distant goods) | flag — Spanish foundry, textile line, Italian paint (all distant) | flag — "Actario", a French notarial legaltech: adjacent space, but its site does not resolve (possibly defunct); no US use |
| News adjacency | clean | clean | clean |
| Political (G3) | clean — FEC API direct query, zero committees/candidates; flag only for the *idiom* "doble rasero" in political rhetoric (arguably on-brand: the product answers the double standard) | clean — FEC API direct, zero | clean — FEC API direct, zero |
| .org (G4) | **available** (RDAP 404) | **available** | **available** |
| .com | registered since 2000, dark | registered | registered (Hetzner-parked) |
| npm / PyPI / GitHub org (G8) | free / free / free | free / free / free | free / free / free |
| LinkedIn (G7) | claimed — an Italian office-equipment retailer holds /company/rasero | **UNVERIFIED** (404 to logged-out fetch; weakly suggests unclaimed) | claimed — the French legaltech holds /company/actario |
| Foreign meaning | flag — one consonant from "trasero" (backside); "razor/raze" echo in EN | flag — FAO soil classification ("a poor, leached, acidic soil"); "acri-" → acrid/acrimony | flag — ES readers may parse it as "actuario" (actuary — but in Spanish legal usage also *the court clerk who records proceedings*, which is half on-thesis) |

**The cold-read panel — results with calibration anchors:**

| Axis | Rasero | Acrisol | Actario | *Oravan (anchor)* | *Civistry (anchor)* |
|---|---|---|---|---|---|
| Spell EN, heard→written (8 reads) | **0/8** — "Rocero"/"Rossero" | 6/8 (misses: "Acrisole") | 6/8 (misses: "Actuario" ×2) | 8/8 *(humans: 85.7%)* | 8/8 *(humans: 16%)* |
| Spell ES (4 reads) | 4/4 | 4/4 | 4/4 | 4/4 | **0/4** ("Sivistri", "Sebistri"…) |
| Pronunciation modal, EN | ra-SEH-ro (8/8 on stress) | scattered, 3/8 modal; stress **a-KRIS-ol** | **ac-TAR-ee-oh, 8/8 identical** | OR-uh-van 6/8 | SIV-uh-stree |
| Pronunciation ES + EN/ES stress match (S5) | ra-SE-ro — **match** | a-cri-SOL — **MISMATCH** with EN | ac-TA-rio — **match** | mismatch (EN initial, ES final) | mixed |
| Negatives beyond "none" (11 reads) | 0/11 (trasero noted as near-miss inside clean reads) | 2/11 (acrid/acrimony stem; Lysol/-sol family) | **0/11** | 1/11 — see below | 0/11 |
| Category priming | fintech/benchmarking/measurement (several reads spontaneously retrieved *"medir con el mismo rasero"* — the meaning is legible) | **11/11 chemical/agricultural/pharma, both languages** — the "-van tail" failure reproduced at 100% | **B2B records software / "gestión documental" / "legaltech serio"** — lands nearly on the product itself | tech/SaaS/pharma *(humans: 54% travel — NOT reproduced)* | civic-tech (transparent morphology) |

**Calibration verdict, disclosed per protocol:** the panel **failed to reproduce the human anchors on two axes** — Civistry did not flunk EN spelling (8/8 vs 16% human) and Oravan's travel priming did not appear. LLM readers reconstruct spellings from morphology and don't share audio-salience priors. Per the pre-registered rule, **absolute scores are not used; ranks are.** The rank signal is unambiguous: Rasero's 0/8 EN spelling, on an axis where LLM readers *over*-perform humans, is the worst result in the table by a wide margin; Acrisol's 100% off-category priming exceeds the -van failure that was Oravan's recorded weakness. The ES axes discriminated correctly throughout (Civistry 0/4) and are trusted as-is: **all three candidates pass G1.**

**Anchor bonus finding:** one ES association read of *Oravan* surfaced **"oraban" — "they were praying"** — "could read as a prayer app… indirectly conservative/religious in several Hispanic countries." A previously unrecorded defect of the current name (single LLM read; weigh accordingly), and one more reason the rename is right.

**Finalists:**

1. **Actario — recommended.** Coined from *acta* (the official record) + *-ario* (as in *notario*) — the etymology is the product, and the lore string writes itself truthfully. Perfect EN/ES pronunciation agreement, zero negative associations, and blind readers in both languages filed it as serious records/document software — category priming landing on the product is the inverse of the -van failure. Its two EN spelling misses went to "Actuario," a real word whose Spanish legal sense (the recording clerk of a court) is half on-thesis. Strong first glyph (A) for the lockup conceit. Open items: the dormant French notarial legaltech (identical mark, adjacent space, dead site — the attorney's first question), the claimed LinkedIn slug, and the actuary pull in EN.
2. **Rasero — conditional.** The best story in the funnel: the leveling stick that measures everyone by the same standard — nonpartisanship as a physical object, and readers retrieve the idiom unprompted. Perfect ES, perfect stress agreement, cleanest legal field of the three (.org and every namespace free, only distant-goods collisions). Condition: the **0/8 EN heard→written spelling** must be confirmed or refuted by the human spot-check before this name can lock — if humans reproduce it, word-of-mouth spells this name wrong more often than right, and it dies on G2. The "trasero" one-letter adjacency rides as a watch item.

Dropped after the panel: **Acrisol** — uniform chemical/agricultural priming in both languages plus an EN/ES stress mismatch; it would have shipped the -van failure twice over.

**UNVERIFIED / owner-and-attorney items (per the no-guessing rule):** no direct USPTO register query was run for any candidate (tmsearch.uspto.gov rejects automation; the wave-2 agent got 403/405 from mirrors) — the attorney's knock-out search at name-lock is the real clearance, for the French Actario mark especially. LinkedIn slug states rest on logged-out fetches. Domain *prices* were not quoted (both .orgs showed RDAP-available; standard registration pricing expected). The panel approximates a human panel and failed calibration on two axes as disclosed — the **human spot-check (Colby + 2–3 Spanish speakers, §10.2) is required before name-lock**, and for Rasero it is decisive.

## 11. What must not regress (restated)

The two design laws; exactly one data-earned green slab per page; the bill page's two-column desk; the live layer's editorial law; the privacy posture; bilingual parity; the MCP citation envelope; nonpartisan-by-construction in both languages. All positioning-neutral and already correct — this spec touches none of them.

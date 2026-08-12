# Design

Oravan's visual system. Tokens live in `app/globals.css` under `@theme` (Tailwind v4). Use them; never a raw hex, never a raw px radius, never a font stack in a component.

Shared primitives live in `components/system/`. If you are about to hand-build a chip, a 6px bar, a dated stamp, or the green floor-vote panel — don't. Import it.

---

## The two laws

These were settled by the owner over multiple rounds. **Do not re-derive them, do not soften them, and do not "improve" them in a PR.**

### 1. Color law

| Token | Value | Means | Spent on |
|---|---|---|---|
| `go` | `#0f6c4a` | **GO** | Actions (buttons, the dial, content links) and the 6px gauge. **Nothing else.** Not a heading, not a rule, not a hover tint on a topic. |
| `tint` | `#e7f2ec` | **YOURS** | What the user picked, typed, or was handed — a chosen stance, an editable script, a filled slot. **Never a topic tag, never a status, never decoration.** |
| `urgent` | `#ffc845` | **one dated fact** | One dated FLOOR fact — a calendar placement, or a pending floor vote. Always with **ink** text. The date is always **printed** beside it. No date, no amber. |
| `alert` | `#8c3a1f` | **failure** | Failure, and only failure. Never a warning, never an emphasis. |
| `ink` | `#16191b` | everything else | All other text, every component edge, every dark ground — **including every topic tag in every state** (rest, hover, active, visited). |

Corollaries that get broken most often:

- A topic tag is **ink**. It does not turn green on hover, it does not take a green border, and it is not a category color. There are no party-coded colors anywhere, in either language.
- Visited is spent on **bills and articles only** — the things you read once. Never on navigation you use every visit. It is a shift in ink weight (`go` → `go-deep`), **not a second hue**, so it stays inside the law.
- The focus ring is **never** drawn in `go`. `go` is what buttons are filled with, and a green ring on a green button is 1.00:1. See "Focus" below.
- `line` (`#d7ded9`, 1.37:1) is a **decorative separator only**. It may never be a component edge and may never be the only thing that makes a control findable. Component edges are `line-strong` — or `ink` where the edge is doing work.

### 2. Shape law

**Radius is assigned by SCALE, not by interactivity.**

| Token | Value | Applies to |
|---|---|---|
| `rounded-stamp` | 3px | Small marks: chips, tags, the 6px gauge, the dated stamp, the language switch, topic pills, portraits. |
| `rounded-control` | 8px | Anything hand-sized: panels, cards, buttons, inputs, disclosures. |
| `rounded-hair` | 2px | The focus indicator's own rounding, and hairline inner rules. **Not a component radius.** Never put it on a box. |

A chip and a card do not share a corner, because they are not the same size of thing. A topic pill and a submit button do not share one either — the pill is a mark, the button is hand-sized.

> ⚠️ **The inverted phrasing — "panels 3px / controls 8px" — is WRONG.** It appeared in an earlier draft, it inverts the law, and it must never be reintroduced. If you find it in a comment, a prompt, or a PR description, correct it.

There is **no third radius**, and `rounded-full` is not part of the system: nothing in Oravan is a circle or a pill-capsule. Portraits are squared at `rounded-stamp`.

---

## Type

Two voices, both self-hosted at build by `next/font` in `app/[locale]/layout.tsx`. **Never add a third-party font link** — not in a page, not in the embed.

| Voice | Font | Token | Used for |
|---|---|---|---|
| Oravan's own voice | **Libre Franklin** | `font-sans` (the default) | Every heading, label, control, button, chip, nav item, and line of UI. Both languages. |
| The reading voice | **Besley** | `font-reading` | Exactly two things: a bill's AI-decoded prose, and the words a caller says aloud (the script, the transcript). Both languages — the Spanish decoding takes the same voice as the English. |

**Besley is deliberately NOT mapped to a display token.** There is no `font-display` in this system. A heading set in the reading voice is a bug: headings are Oravan talking, and Oravan talks in Franklin.

A serif reads a size small at Franklin's metrics, so the reading voice is set one rung up the same ladder — `font-reading text-lg` (18px). That is the only adjustment it gets. **Leading is unchanged**: the reading voice takes `leading-body` like everything else.

### The ladder

`12 · 13 · 14 · 16 · 18 · 21`, then five display steps. Nothing is authored off it.

| Utility | Size | Leading | Tracking |
|---|---|---|---|
| `text-2xs` | 12 | body | — |
| `text-xs` | 13 | body | — |
| `text-sm` | 14 | body | — |
| `text-md` | 16 | body | — |
| `text-lg` | 18 | body | — |
| `text-xl` | 21 | tight | — |
| `text-lede` | 18 → **21 at 62rem** | body | — |
| `text-h3` | 21 → 26 | 1.25 | — |
| `text-h2` | 24 → 34 | 1.15 | −0.01em |
| `text-h2-loud` | 26 → 40 | 1.1 | −0.01em |
| `text-h1-bill` | 32 → 56 | 1.06 | −0.02em |
| `text-h1` | 40 → 68 | 1.04 | −0.02em |

Each rung carries its own leading, and the display steps carry their own tracking, because that **is** the ladder — it is not drift.

`text-lede` **steps**, it does not slide: it is 18px below 62rem and 21px at or above, and it never interpolates. That is on purpose — a sliding lede rendered at 20.16px next to a 21px sibling, which is the kind of near-miss that makes a page look unset.

Weights: 400 body · 600 labels, links, meta emphasis · 700 buttons, chips, small headings · 800 h1/h2/h3 and key numerals.

Set numerals that are read as data — durations, dates, bill numbers, phone numbers, counts — with `tabular-nums`.

### Leading

Three named ratios and no others. The `--leading-*` namespace is cleared, so `leading-relaxed` (1.625) and `leading-normal` (1.5) cannot come back.

- `leading-tight` **1.35** — headings at or below 21px, and dense marks.
- `leading-body` **1.6** — every run of body copy on paper. This is the `<body>` default.
- `leading-dark` **1.7** + `tracking-dark` (0.01em) — the same copy on an ink or green ground. This is the **only** stated reason a size renders at a different ratio: light type on a dark ground needs the air. Apply both together, always.

### Measure

- `max-w-read` (`--measure-read`, 33rem) — the reading column. ~71 characters at 16px. **One cap on the column, not one per block**: every block inside the reading column inherits the same width, so their left and right edges agree at every viewport. Per-block caps produce a staggered right edge, which is what this token exists to prevent.
- `max-w-note` (`--measure-note`, 27rem) — notes, captions, rail copy. ~66 characters at 14px.

Set in rem, not `ch`, so the same token means the same column on every screen and in both fonts.

### Space

Tailwind's default 0.25rem step already **is** the scale, so there is nothing to declare — but only these steps are legal:

`0.5`=2 · `1`=4 · `2`=8 · `3`=12 · `4`=16 · `5`=20 · `6`=24 · `8`=32 · `12`=48 · `16`=64 · `24`=96

`p-7` / `p-9` / `p-10` / `p-11` (28/36/40/44) are **off** the scale. Every fluid `clamp()` must land on a step at **both** bounds — `clamp(2rem, 6vw, 4rem)`, never `clamp(2.5rem, 6vw, 3.5rem)`.

Two **sizes** are exempt because they are floors, not spacing choices: `min-h-11` (44px, the WCAG 2.5.8 touch target) and `min-h-12` (48px, the button and input height). The gauge's `h-[6px]` is likewise a law, written as an arbitrary value so it reads as one.

---

## Data-gated loudness

**The signature move, and the easiest thing in this system to get wrong.**

Exactly **one** bill per page takes the full-bleed green enamel panel (`components/system/FloorVotePanel.tsx`), and only a bill carrying one of the record's dated floor facts **and a printed date** can — `status === "floor_vote"` for the two corpus facts, or the chamber's own published floor schedule naming the bill (ruling V1 below, the one kind exempt from the status gate and the only one that quotes). Never two. A quiet week has **no** green panel at all, and the page is an unbroken paper column.

This is not a stylistic preference — it is the entire mechanism. The corpus is **hot**: **319 of the 2,567 bills** in `data/bills.json` carry `status: "floor_vote"` (as of the 2026-08-01 sync — the corpus moves nightly, so recompute rather than trust these figures). Stack two panels and both read as wallpaper; stack ten and the page has no signal left. Capping at one is what makes the one mean something.

At a squint, a page changes shape for its **content** exactly once, and the green panel is that change. Everything else — privacy, specimens, the ledger, the coverage table — is ruled paper. The footer is a dark mass but reads as the back cover, because nothing follows it.

**One sanctioned exception, and it is INK, not green** (owner ruling, 2026-07-25): the homepage Moments band. Moments read as an afterthought as ruled paper and needed real weight, and ink buys weight without spending a colour the data gate governs. So the homepage carries three full-bleed grounds — green panel, ink Moments band, ink footer — and still exactly **one green** one, which is the only one that has to be earned. Green remains the page's only *data-gated* shape change: on a quiet week it does not render and no green ground exists anywhere.

The rule that still binds: **if you are adding a second GREEN band, you are taking meaning away from the first one.** A new full-bleed ground of any colour needs an owner ruling; a new green one needs the data to have earned it.

Build against **live data in `data/`**, never against the mockups' fiction.

> ### ⚠️ OPEN OWNER RULING — the printed date
>
> The color law says amber carries a floor-calendar fact *with the date printed*. **`data/bills.json` has no forward-looking scheduled-vote date for any of its 2,567 bills.** `status: "floor_vote"` is derived from action text like *"Placed on Senate Legislative Calendar under General Orders"*, and `last_action_date` is always in the past — 0 of the 319 are future-dated (recomputed 2026-08-02), and 0 mention "scheduled" or "set for".
>
> So *"House floor vote scheduled Thu, Jul 24"* **cannot be built from live data.** The strongest derivable claim is *"On the House floor calendar · Jul 20, 2026"* (`last_action_date`), which keeps the amber chip, the printed date, and the one-panel cap intact but states a weaker fact.
>
> `FloorVotePanel` therefore takes a caller-supplied, already-localized `dateLabel` and **refuses to render without one**. Until the owner rules, pass the date of the action itself — do **not** synthesize or imply a scheduled vote date. The alternative is adding a scheduled-date field to the sync pipeline.
>
> **RULED 2026-08-09 — WHICH FACT, not which date.** The date question above is still open; *what the amber may assert* is now settled. The gate was calendar placements alone, and that made the crown structurally backward-looking: Congress overwrites `last_action_text`, so the moment a bill drew real floor action — a cloture motion filed, a motion to proceed made — its placement sentence vanished and the panel dropped it, running one to two days behind the week's actual floor fights. Amber may now carry **either** of two dated floor facts: *on the floor calendar*, or *a floor vote is pending*. `lib/journey.ts`'s `floorPendingChamber` is the second gate — an ordered **allow-list** with a settled-guard first, so a rejected motion to proceed or a cloture motion that was not invoked can never wear the crown, and a phrasing we have never seen fails closed to a quiet week rather than open to a false claim. Everything else in this ruling stands: still one dated fact, still printed, still capped at one panel per page, still no claim about *when* the vote happens.
>
> **Applied on BOTH surfaces 2026-08-11.** The ruling shipped on the homepage crown only, and the bill page kept the calendar-only gate — so a bill crowned *"Floor vote pending in the Senate"* lost the band, the amber and the claim one click later and printed the weaker *"Floor activity"* over the identical record. The bill page now reads the same allow-list under the same `isSignalFresh` clock and prints the pending sentence when that is the fact it found.
>
> **RULED 2026-08-11 (N3) — the shared status label is clocked too, and gets its OWN key.** The paragraph above recorded one surface still lagging on purpose: `statusKeyFor`, the label gate behind `/bills`, `/reps`, the homepage, the OG cards, the embeds and MCP, took no clock. That carve-out is withdrawn. It printed the present-tense *"On the floor calendar"* over **305 of the corpus's 322 dated placements** whose own record had shown nothing for a median of 140 days (max 553 — s-347-119, placed 2025-02-05). Measured 2026-08-12T02:46Z by calling the gate over all 2,700 records: the 348 `floor_vote` bills split 17 fresh / 305 stale / 26 activity, so 11.3% of the whole corpus changes label. The counts move nightly — recompute, and note the fresh bucket may legitimately hit zero on a quiet fortnight. The carve-out's own defence was that the only available demotion was the vaguer `floor_activity` — less information, not more truth. That was a false choice. `statusKeyFor` now answers a **third key**, `floor_vote_stale` → EN *"Placed on the calendar"* / ES *"Incluido en el calendario"*: every word of the specific fact kept, only the tense moved to the one the printed date supports. `floor_activity` is still **not** clocked — an aged pending motion keeps today's label, because "floor activity" is already tenseless and there is nothing present-tense in it to demote; #208 gave those records their tense in the rail instead.
>
> **The new key is INK, never amber — no exceptions.** `urgent` is spent on one dated floor fact that is *still live*, and `floor_vote_stale` is by construction the case where it is not. `MomentVehicleCard`'s chip gate reads `statusKey === 'floor_vote'` and so excludes it structurally; the embed card carries no amber at all. A future surface that lights amber off this key is breaking the colour law, not extending it.
>
> **N4, same change:** the embed bill card now carries and prints `last_action_date` (`bills.updated`, "Last action {date}", UTC-formatted) with its status line, above the "Data as of" stamp. It was the one surface printing a status label with no date beside it — half the old carve-out's argument — and the order matters: the record's clock qualifies the label, the sync's clock must never read as corroboration of it.
>
> **RULED 2026-08-12 (V1) — a THIRD fact, `announced`, and it is a QUOTE rather than a claim of ours.** Both facts above are read out of `data/bills.json`, and that corpus is structurally backward-looking in a way no gate can fix: `last_action_date` is always in the past, and the moment a measure actually reaches the floor Congress OVERWRITES `last_action_text` — so on 2026-08-07 the continuing resolution and the SEED Act, the two hottest vehicles in the country, both carried *"Message on Senate action sent to the House."* and a derived status of `committee`. The crown could not see either of them, and the whole shortlist under it was ranked by a score that had already promoted a cloture vote that FAILED 52–46 to rank 2 for four days.
>
> A second record now exists beside the corpus: `data/floor-signals.json`, rewritten hourly from the House's own weekly floor schedule (`docs.house.gov/billsthisweek`) and the Senate's "Program for" block in the Daily Digest. Amber may now carry a **third** dated floor fact — *the chamber has named this bill on its own published floor schedule* — under four conditions, all enforced in code:
>
> 1. **The panel QUOTES; it never paraphrases and never asserts.** The chamber's own sentence is printed verbatim as a `<blockquote>`, with the document named, its publication date printed, the meeting it covers printed, and its URL linked. If we cannot quote it, it does not render (`scripts/check-floor-signals.mjs` fails the build on a signal with no quote, no URL, or a future date).
> 2. **The quote stays ENGLISH VERBATIM on `/es`,** under a Spanish framing sentence that says so. A translated quote is a paraphrase wearing quotation marks — a different honesty class from a quotation — so the framing is localized and the sentence inside it is not.
> 3. **It is revalidated hourly, and the chip prints the ANNOUNCEMENT's own date,** not the bill's last-action date. A bill pulled from a chamber's schedule mid-week stops wearing the crown on the next run (`lib/docket.mjs`'s `signalIsLive`: re-observed on the latest fetch, file refreshed inside 48 hours, and the announcement's own horizon not yet past), and the panel prints the instant the schedule was last checked beside the quote.
> 4. **It still says nothing about WHEN a vote happens.** The schedule names measures for a session; it does not schedule votes, and neither do we. This is the one clause of the original ruling that no new source changes.
>
> `announced` is also the ONLY kind that may render over a bill whose `status` is not `floor_vote` — that exemption *is* the ruling, because the status is precisely what goes stale when a measure reaches the floor. Everything else stands: one dated fact, printed, capped at one panel per page, and a quiet week has no panel at all. `home.weekNoteAnnounced` (EN+ES) is the note that describes this fact, and it is a separate string from `home.weekNote` so the page can never describe a fact it is not showing.
>
> **Applied on BOTH surfaces 2026-08-12**, the same way ruling 2026-08-09 had to be. V1 shipped on the homepage crown only, and the bill page kept its `status === 'floor_vote'` gate — so a T0-announced bill whose derived status had fallen back to `committee` (the normal state of a measure mid-passage, and the exact case this ruling exists for) wore the crown on the homepage and showed **no band at all** on its own page one click later. The page now runs one gate, `billFloorBand` in `lib/journey.ts`, which puts `announced` above both record facts and leaves both of them untouched below it; the announcement reaches it through `rungFor`, so the terminal-first rung order and `signalIsLive` govern the page exactly as they govern the ladder. The quote, its attribution row and the checked-at stamp are one shared block (`components/FloorEvidence.tsx`) rendered by both surfaces, because two hand-kept copies of one attribution is how two surfaces start disagreeing about one record. The band's chip is the crown's own string (`bill.floor.announced*`); its headline, status label and meta line are page-scoped and new in EN+ES, because a chip and a full sentence are not the same claim.
>
> **Where a surface prints COVERAGE it prints the source's own printed label** (`covers_label`, e.g. *"8 a.m., Thursday, August 13"*), not our ISO derivation of it — English verbatim, unformatted, marked `lang="en"`, exactly like the quote above it. `covers` keeps its other job (the horizon `signalIsLive` computes on) and is the fallback when the document printed no label. The evidence row had been printing the derivation while the label sat stored beside it unread.
>
> **The printed-date ruling above is still open.** N3 changes what the label may *assert* about age; V1 adds a second document whose OWN dates may be printed and quoted. Neither settles which date the amber prints for a corpus fact, and `FloorVotePanel` still takes a caller-supplied `dateLabel` and still refuses to render without one.

---

## Focus

Two-tone by construction, and that is the only reason it passes 1.4.11.

A 3px `ink` ring alone on a `go`-filled button is **2.75:1** — a fail. So the ring is never adjacent to the fill. A filled control swaps its **own** border to the gap tone on focus. Add `ring-gap` to any solid button and the stack reads outward:

```
go fill │ paper border 6.43 │ paper gap │ ink ring 17.66 │ paper page 17.66
```

Every adjacency clears 3:1. Ground contexts retune the two tones:

- `.on-dark` — any ink enamel ground (footer, voicemail, transcript title bar). Ring = paper (17.66 on ink), gap = ink.
- `.on-go` — the green enamel panel. Ring = paper (9.75 on go-deep), gap = go-deep. Stack: `white fill │ go-deep border 9.75 │ go-deep gap │ white ring 9.75 │ go-deep panel 9.75`.

Focus is **never** removed, and it is never drawn in `go`.

---

## Contrast

Every enforced pair is computed with `lib/contrast.ts` (WCAG 2.x) against the rendered hex — not eyeballed, not inherited from a mockup comment. **The full ledger is the comment block at the top of `app/globals.css`.** Recompute it if any value changes.

Three results you must know before you build:

1. **`line-strong` on `wash` is 2.97:1 — 1% short of 3:1.** It clears on paper (3.24). An *enabled* component's `line-strong` edge must therefore have `paper` on at least one side; a component whose own ground is `wash` takes an `ink-2` edge (7.23) instead. The one place the reference puts a `line-strong` edge on a `wash` fill is a **disabled** control, and 1.4.11 exempts inactive components. Do not "fix" this by lightening `wash` or by promoting `line` to an edge.

2. **`go` and `alert` sit 1.19:1 apart in luminance** — to a deuteranope they are near-identical. `alert` is therefore never the sole carrier of meaning: a failure always also carries a 3px rule, a bold text label, and the right ARIA (`aria-invalid`, `role="alert"`). Color is the third signal, never the first.

3. **Fill colors are not boundaries.** `urgent` on paper is 1.54:1 and `tint` on paper is 1.15:1, and both are fine — the amber chip is found by its ink text (11.44) and the printed date, not by being yellow, and `tint` is always carrying ink text. But any *control* on a tinted ground still takes a `line-strong` or `ink` edge.

Accessibility floor, non-negotiable: semantic HTML, visible focus, AA contrast, 44px touch targets. A link sitting inline inside a sentence is exempt from the 44px floor (WCAG 2.5.8) — inflating it breaks the line. Everything else uses `min-h-11` (44px) or better.

---

## Motion

`prefers-reduced-motion: reduce` collapses every transition and animation globally, in `app/globals.css`.

**Transforms survive on purpose.** The stamp's tilt is *static geometry*, not motion, so it must still be there when motion is off. Never express a permanent shape as an animation.

State changes (background, border, color, text-decoration-color) ease at 150ms. Nothing else moves.

**The motion contract** (2026-08). Any future reveal animation — the script-generation wait, decode loading, anything — ships under all four clauses or not at all:

1. **Content readable ≤400ms.** The information arrives first; ornament may finish around it.
2. **Ornament ends by ~1.2s.** Nothing decorative outlives a breath.
3. **State commits to the URL before the animation ends.** A reload mid-animation lands on the destination, never the departure.
4. **Reduced-motion is a first-class path**, not a disabled one: crossfade or instant, same information, same order.

The clauses exist because the most admired transitions in the wild routinely ship with a blank no-JS page and an invisible focus ring — both direct violations of this file's accessibility floor. Polish is never a reason to lower it.

---

## No

No shadows — the `--shadow-*` namespace is cleared, so `shadow-md` renders nothing. Depth is carried by rules, edges, and grounds.
No painted gradients. (A `mask-image` alpha ramp on a scrolling panel is fine: it fades the content, it does not paint a band.)
No icon libraries beyond what already ships.
No purple, no indigo — the default Tailwind palette is cleared, so they are not reachable by accident.
No nested cards: inside a card use hairline rules, not bordered boxes.
No party-coded colors, in either language. **Outlet lean is never color-coded** — the "Read" section conveys lean by text label plus a neutral 3-segment position glyph (`ink` for the active segment, `line` for the rest). Never red/blue, never `go`.

---

## Structural constraints

Three constraints exist because breaking them has already killed a build or a spec:

1. **The bill page is two columns** — a reading column plus a "Make your call" rail. A single-column bill page got a previous build rejected. The rail is sticky across `grid-row: 1 / -1` so it holds to the page foot, and the dial sits at the panel's foot *outside* the scrolling body, so it can never be scrolled away from.
2. **The funnel has two halves, and the specs read fixed boundaries.** *Truth half (invariant I1):* every bill link inside `section[aria-labelledby="top-actions"]` — and every Big Questions link in the promoted band, `section[aria-labelledby="moments-strip-title"]` — reaches a decoded, AI-labeled answer in **≤1 click**. *Call half (invariant I2):* from any bill page, stance → completed script is **≤2 interactions** (the sticky rail of constraint 1 is what makes that true), and the homepage ZipForm keeps ZIP-first at **≤3 clicks** end-to-end via `section[aria-labelledby="reps-next"]`. *Invariant I3* pins the quiet week: when a truth surface is empty it says so in a `role=status` empty state, and neither entry point dead-ends. Every callable bill link stays inside `top-actions` — the funnel and freshness specs both read that boundary — and `FloorVotePanel` carries a bill link, so it lives inside that section, which must be **full-width with the max-width wrapper inside it** because the panel is full-bleed; see the primitive's doc comment. The ids `top-actions`, `reps-next`, `moments-strip-title` are **frozen**: heading copy may change freely, ids may not. The three invariants are named and enforced in `tests/funnel.spec.ts` (I1 Truth · I2 Call path · I3 Quiet-week honesty); **the click budgets in this paragraph and the budgets that spec asserts must always read the same number.** *(Consciously rewritten 2026-07-26 from "≤3 clicks to a completed call script" — the truth-first repositioning demoted the call, so the invariant was rewritten deliberately rather than quietly broken. Spec: the project records §3.)*
3. **Mobile density is measured, never eyeballed.** Every surface change is audited at **390×844** with the numbers written down **before and after**: screens of scroll, words on the page, and the px sizes that moved. "Feels tighter" is not an audit result and does not land. Precedent and calibration — the mobile-density pass (commit `c150b58`, 2026-07-29): homepage **11.3 → 9.0 screens of scroll**, **1164 → 902 words**, h1 **40 → 32px**, measured in Playwright at that viewport; the type floors (h1 40→32, h1-bill 32→28, h2-loud 26→24 — desktop clamps unchanged, see `app/globals.css`) were chosen against measured reflow, not taste. A number that got *worse* is a finding to report, never a number to omit.

---

## Primitives — `components/system/`

| Component | What it is | Hard rule |
|---|---|---|
| `Gauge` | The 6px bar. Proportional segment widths. | Only where it **measures** something true. Never a decorative rule, never a card topper, never a link underline. |
| `Stamp` | The dated stamp, pressed across a real border. | **Once per page**, and it is the sole printed sync date. Static geometry — survives reduced motion. |
| `Chip` | `ai` · `urgent` · `stale` · `tag` | `urgent` requires a printed date (enforced by the type). `stale` is ink, never amber. `tag` is ink in every state. |
| `FloorVotePanel` | The full-bleed green enamel panel. | `status === "floor_vote"` **and** a `dateLabel`, or it returns `null`. One per page — use `selectFloorVoteFeature()`. |

The go-mark is one 6px green bar used exactly two ways: as a **segment** of a gauge, drawn to scale, measuring something true; and as a **stroke** under the hero's promise, at the same weight and the same 3px cap, because the promise is the thing being measured. It never tops a card, never underlines a link, and never decorates anything else.

---

## Embed lockstep

`app/embed/embed.css` is **not** Tailwind and **not** `globals.css` — an iframe payload stays small and self-contained, so it **hand-copies** the palette. That copy is a standing lockstep obligation: **any change to the `@theme` color block in `app/globals.css` must land in `app/embed/embed.css` in the same PR.**

> The re-key landed in #104 (`b74430f`) — `embed.css` carries the variant-B tokens. A stale ⚠ here claimed otherwise from its birth: `b74430f` itself added the warning in the same commit that performed the re-key, so it was false from day one and stood 8 days before removal (2026-08-02 — the constitution must never cry wolf). The embed's own architecture rules stand: every color flows through the private `--_*` tokens, component rules never use `@media (prefers-color-scheme)`, and the focus ring falls back to **ink**, not accent.

The embed also uses **system fonts, not `next/font`** — it does not get Franklin or Besley, and it must not add a webfont link.

---

## Bilingual parity

Every user-facing string goes through `messages/en.json` **and** `messages/es.json`, in the same change. That includes strings inside primitives: `Chip`'s `marker` (the "AI" mark is **"IA"** in Spanish — it is not locale-invariant), `FloorVotePanel`'s `dateLabel`, `ctaLabel`, and `urgentLabel`. Primitives take pre-localized strings as props and never call `useTranslations` themselves, so the same primitive serves both locales and neither locale can drift.

Spanish runs longer than English — size controls for the longer label (the language switch is sized for the Spanish word, not the English one), and never let a fixed width decide.

AI content is **labeled at first contact**, and a call script is read — and editable — by the caller before it drives a call. That last clause is scoped to call scripts on purpose: decodes and Moment update summaries publish behind automated gates with no human step, so the label is the whole disclosure there. The label sits with the content, above the fold — never in a footnote.

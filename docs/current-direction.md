# Current direction

Page 2 of the constitution (page 1 is `CLAUDE.md`). Adopted 2026-09-27 with Constitution v2; it replaces the retired `DESIGN.md` (now `docs/history/DESIGN-2026-07-24.md`, a dated record with no force).

This page is how the product should look and read, as the owner has most recently said it. Every line carries a date and a source. **Nothing here is a hard rule, and nothing here is enforced by a test or a hook**; if a line ever needs a gate, it belongs on page 1 instead. A newer owner word replaces a line: strike the old line with its date, add the new one, and append one line to the log at the bottom. No other ceremony.

**What is shipped today is not this page.** The live site still carries the July 2026 visual system (the tokens in `app/globals.css`) until the rebuild replaces it, and the rebuild does the skin last (see *Order of work*). Where the two differ, new work follows this page, and the old look is not a bug to fix in passing.

## Order of work

Owner, 2026-09-27 02:35: features (keep, cut, later) → core flows → grayscale wireframes → colour and type last, as a skin. Visual decision cards are parked until the flows are settled.

## Colour

Owner, 2026-09-26 03:58 and 2026-09-27 02:35: green is the brand — the masthead band and the wordmark; yellow (`#ffc933`, "lamp") marks only what you can act on; each has one light, flat tint used once or twice per main page — tints, not gradients. Status and date tags are plain text. Links are ink, underlined. The Call tab in the island bar is not yellow (2026-09-27 00:43; this reversed 2026-09-26 13:50, which reversed the card l5 note — only the last stands). Alert stays an orange-brown, never a flag red. On Today, a yellow tag marks a floor notice (owner, 2026-09-29, typed: "if there is a vote this week scheduled it needs to have a yellow tag or something that explicitly draws attention to it"); for that one tag this replaces "Status and date tags are plain text". Contrast pairs are recomputed for these tokens before anything ships (page 1, rule 7; method in `docs/accessibility.md`).

**A hue change is a copy change.** ~~Shipped copy names the colour of the floor panel in both languages: `home.weekNote` and `home.weekNoteAnnounced` begin "The green panel…" / "El panel verde…". Change the panel's colour and those two strings change in the same PR, in `messages/en.json` and `messages/es.json`.~~ (Struck 2026-09-28: the owner cut the homepage's green-panel explainer, UX inventory H13 "cut", and those were its two strings.) Since that cut no string in `messages/en.json` or `messages/es.json` names a colour (searched 2026-09-28). If one ever does again, it changes in the same PR as the hue, in both languages.

## Shape

Default from 2026-07-24; owner picks 2026-09-26/27: two radii — a small one for marks and chips, a larger one for controls and cards — as a default. Pills and capsules are allowed where the owner picked them: the floating island tab bar (owner, 2026-09-27 00:43, from a reference he supplied; the reference product is named in the design record kept out of this repo). Flat by default; one floating element per screen may earn depth.

## Type

Default from 2026-07-24: Libre Franklin for UI, Besley for decoded prose and the spoken script; a body ladder of 12–21px; display sizes free on the hero (owner, 2026-09-27 00:48: the hero "should break some of those rules"). No third-party font link — that half is page 1, rule 1.

## Loudness

Default from 2026-07-24, re-aimed 2026-09-25 (plan card q18): one earned loud thing per page. ~~The homepage leads with a Big Question — the one on the floor today if there is one, otherwise one from the last 30 days.~~ (Struck 2026-09-29: the owner ruled, typed, "Home Page - Option B, This week first, then Big Questions.") The homepage leads with This week, then Big Questions (owner, 2026-09-29). Quiet weeks look quiet.

## Layout

The bill page keeps a reading column and a call rail on desktop (owner kept the "D desktop rail", 2026-09-26); the fold/expand control belongs on the vote list only (2026-09-27 00:44); the Call tab and the "Call your senators" button share one token set (2026-09-27 00:38); choice controls are outlined at rest, half-lamp on hover, full lamp when picked (2026-09-27 00:40). The desktop header row is Today in Congress · Bills · Big Questions · My reps, with no Call item; the phone's bottom bar keeps its five tabs, Call included, and says Big Questions (owner, 2026-09-29, typed: "The 'Call' button in the header needs to be removed and 'Today in Congress' needs to come first on the header"; picker: "Desktop only"; typed: "I'd like the phone to say Big Questions instead of just questions if possible").

## Copy

Owner, 2026-07-28: verbiage is a design failure; the 10-screen, 1,072-word homepage was the failure state — measure screens and words at 390×844 before and after, and write the numbers down. AI disclosure is one quiet label per block with a link to "How this is made" (2026-08-01, 2026-09-26). Tone: welcoming, plain-spoken, steady; not super serious, never cutesy (2026-07-03).

## Motion

The 2026-08-04 contract: content readable within 400ms; ornament done by 1.2s; state commits to the URL before the animation ends; reduced motion is a first-class path. Tactile motion is welcome inside that (owner, 2026-09-26, asked for a glassy, tactile feel — paraphrased here because his words name another product's visual style).

## What to avoid

Defaults, not laws: gradient heroes and hero-metric templates, icon-card grids, nested cards, purple/indigo, icon libraries beyond lucide, drawings that need a caption to be read (the 2026-08-01 route gauge is the example, not a ban on data drawings — the owner kept a vote bar on 2026-09-26).

## How design is reviewed

Owner, 2026-07-09 → 2026-08-09, 2026-09-26: every UI change is seen on a running localhost in a new Chrome window, one tab per stop, with a summary artifact (the review window in `docs/process.md`); the review page for the rebuild is the pinned looks review page (kept out of this repo), and it stays accessible for later passes; variants go on one comparison page; fresh-eyes work is a blind run (sterile agents, browser only, never read the repo); at least one option risks something (2026-07-29, "too safe is a miss"); a design question is asked with full context, never as a bare chip.

## Tooling

The impeccable design hook is **off since 2026-09-27** (audit card a2). Do not re-arm it until a new token file exists for the rebuilt system, and then re-arm it from that file only — it was enforcing the retired `DESIGN.md` on every edit.

The impeccable skill is a lint and a rubric, not an explorer (audit card a8, 2026-09-27: "Update to 4.4.0; use it as lint and rubric only, not during exploration"). Do not invoke it while exploring a new direction; its setup treats committed tokens as the identity to preserve, which is the opposite of a rebuild brief. Use it to check finished work.

## Log

Newest first. One line per change: date · who · the words or the card · what line changed.

- `2026-09-30 · owner · "31 a but add floor first" and "29 a" (typed, his reply to the Run 1 Report) → on /today the floor band comes before "The chambers", and the phone tab reads "Big Questions" / "Grandes preguntas" on two lines`
- `2026-09-29 · owner · "if there is a vote this week scheduled it needs to have a yellow tag or something that explicitly draws attention to it" (typed) → colour: on Today, a yellow tag marks a floor notice; "Status and date tags are plain text" no longer covers that one tag`
- `2026-09-29 · owner · "The 'Call' button in the header needs to be removed and 'Today in Congress' needs to come first on the header" (typed), "Desktop only" (picker), "I'd like the phone to say Big Questions instead of just questions if possible" (typed) → layout: the desktop row is Today in Congress · Bills · Big Questions · My reps; the phone bar keeps five tabs and says Big Questions`

- `2026-09-29 · owner · "Home Page - Option B, This week first, then Big Questions." (typed) → loudness: the homepage leads with This week, then Big Questions; the Big-Question-first line struck`
- `2026-09-28 · owner · UX inventory H13 marked "cut" (the homepage's green-panel explainer) → colour: "a hue change is a copy change" struck; no shipped string names the panel's colour`
- `2026-09-27 · owner · audit card a8 answered "a" (10:17:35Z) → tooling: impeccable is lint and rubric only, never during exploration`
- `2026-09-27 · owner · audit cards a1 + a2 answered "a" (10:15:55Z, 10:16:07Z) → Constitution v2 adopted; this page created from the audit draft; DESIGN.md moved to docs/history/`
- `2026-09-27 · owner · "nail down features and flow before we add back in color" → order of work`
- `2026-09-27 · owner · "I meant a lighter complementary color not a gradient shift" → colour: tints`
- `2026-09-26 · owner · "Yes green is brand and yellow is action." → colour`
- `2026-09-25 · owner · scrap DESIGN.md + rebuild UI → this page replaces DESIGN.md`

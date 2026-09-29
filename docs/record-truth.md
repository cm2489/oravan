# Record truth — the rules behind page 1, rule 6

`CLAUDE.md` rule 6 is the promise: the record is quoted, never narrated. This page holds its detail — the dated rulings that decide what Oravan may say about Congress's own record, and the gates that hold each one.

**Where these came from.** Until 2026-09-27 these rulings lived in `DESIGN.md` under a colour's name ("the amber law"), so changing a colour looked like breaking them and keeping them looked like keeping a colour. They are truth rules, and they move here without the colour: which colour a live floor fact wears is direction (`docs/current-direction.md`), and it can change freely. What a floor fact may *claim* is below, and changing it is a page-1 amendment. The original wording, colours included, is in `docs/history/DESIGN-2026-07-24.md` (section "Data-gated loudness").

**Who ruled.** `DESIGN.md` recorded the 2026-08-09, 2026-08-11, 2026-08-12 and 2026-08-15 rulings as "RULED" or "the owner's ruling". The 2026-09-27 audit looked for the owner's own sentence behind each and **found no verbatim owner sentence for any of the four**; the commit identities in this repo cannot settle it either, because Claude sessions commit under the owner's accounts. They are kept because each is a narrowing of what may be claimed and each has a gate that has caught real defects — not because an owner quote was found. The 2026-09-26 rulings further down are recorded as owner rulings in the change that wrote them (#300); the owner's words behind them were not re-checked for this move.

---

## 1. No vote date the record does not hold

*Raised 2026-07-24 (#104); restated 2026-08-02, 2026-08-09 and 2026-08-15. The printed-date question below is still OPEN.*

`data/bills.json` has no forward-looking scheduled-vote date for any bill. A floor status is derived from action text such as *"Placed on Senate Legislative Calendar under General Orders"*, and `last_action_date` is always in the past. So a sentence like *"House floor vote scheduled Thu"* cannot be built from the corpus, and it is never synthesized or implied.

- A floor claim prints a date the record holds: the date of the action itself, or — for an announcement (§4) — the announcement's own printed dates.
- `components/system/FloorVotePanel.tsx` takes a caller-supplied, already-localized `dateLabel` and refuses to render without one; `components/system/Chip.tsx`'s dated-fact tone will not type-check without a `dateLabel`.
- **Open owner question:** which date a *corpus* floor fact prints (the date of the action, or a scheduled-date field the sync pipeline does not have). §2–§5 narrowed what may be claimed; none of them settles this.

Gates: the types above; `tests/glossary.unit.spec.ts` pins the glossary entries written against this rule.

## 2. Which floor facts may be claimed

*2026-08-09 (#187, commit 5f030ea); applied on the bill page too on 2026-08-11 (commit 4beebbc).*

A live floor claim may assert either of two dated record facts: **on the floor calendar**, or **a floor vote is pending**. `floorPendingChamber` (`lib/journey.ts`) is an ordered allow-list with a settled-guard first, so a rejected motion to proceed, or a cloture motion that was not invoked, can never be presented as pending — and a phrasing never seen before fails closed to a quiet week, never open to a false claim. The homepage and the bill page read the same allow-list under the same `isSignalFresh` clock, so a bill cannot be "pending" on one and "floor activity" one click later. Still one dated fact, still printed, still at most one such feature per page, and still no claim about *when* a vote happens.

Gates: `tests/journey.unit.spec.ts`.

## 3. A label's tense matches its date

*2026-08-11 (N3/N4, #211, commit 8c2ef66).*

The shared status label (`statusKeyFor`, behind `/bills`, `/reps`, the homepage, the OG cards, the embeds and MCP) is clocked. A calendar placement whose own record has gone quiet answers a third key, `floor_vote_stale` → EN *"Placed on the calendar"* / ES *"Incluido en el calendario"*: every word of the specific fact kept, only the tense moved to the one the printed date supports. `floor_activity` is not clocked, because "floor activity" is already tenseless. **The stale key never takes a live floor fact's treatment** — whatever colour or weight marks a live fact, a stale one does not wear it.

N4, same change: the embed bill card prints `last_action_date` ("Last action {date}") with its status line, above the "Data as of" stamp. The record's clock qualifies the label; the sync's clock must never read as corroboration of it.

Gates: `tests/journey.unit.spec.ts`, `tests/embed-bill-card.spec.ts`, `tests/mcp-tools.spec.ts`.

## 4. "Announced" quotes; it never paraphrases

*2026-08-12 (V1, #218, commit ca131bc); applied on the bill page too the same day (#225, commit fb39d38).*

A third dated floor fact: **the chamber has named this bill on its own published floor schedule** (`data/floor-signals.json`, rewritten hourly from the House's weekly floor schedule and the Senate's "Program for" block in the Daily Digest). Four conditions, all in code:

1. **It quotes; it never paraphrases and never asserts.** The chamber's own sentence is printed verbatim in a `<blockquote>`, with the document named, its publication date printed, the meeting it covers printed, and its URL linked. If it cannot be quoted, it does not render.
2. **The quote stays English, verbatim, on `/es`**, marked `lang="en"`, under a Spanish framing sentence that says so. A translated quote is a paraphrase wearing quotation marks.
3. **It is revalidated hourly and prints the announcement's own date**, not the bill's last-action date. A bill a chamber drops mid-week stops being featured on the next run: `signalIsLive` (`lib/docket.mjs`) requires the signal re-observed on the latest fetch, the file refreshed inside 48 hours, and the announcement's own horizon not yet past. The checked-at instant is printed beside the quote.
4. **It still says nothing about WHEN a vote happens.** A schedule names measures for a session; it does not schedule votes, and neither does Oravan.

`announced` is the only kind that may render over a bill whose derived `status` is not `floor_vote` — that exemption *is* the ruling, because the status is exactly what goes stale when a measure reaches the floor. Both surfaces run one gate (`billFloorBand`, `lib/journey.ts`) and render the quote through one shared block (`components/FloorEvidence.tsx`). Where a surface prints the meeting a schedule covers, it prints the source's own label (`covers_label`) verbatim, marked `lang="en"`. The homepage used to explain the panel in a note under it, with a separate string for the announced kind (`home.weekNoteAnnounced`, beside `home.weekNote`) so the note could never describe a fact the panel was not showing; the owner cut that explainer on 2026-09-28 (UX inventory H13), and a crowned week now prints no note at all.

Gates: `scripts/check-floor-signals.mjs` (fails the build on a signal with no quote, no URL, or a future date), `tests/floor-signals.unit.spec.ts`, `tests/docket.unit.spec.ts`.

## 5. A record fact is live only while its chamber is meeting

*2026-08-15 (R1, commit e0a1165).*

The two record facts (§2) may be presented as live **only while the chamber they name is meeting**. When that chamber's own Daily Digest gives its next meeting as a pro forma session (`chamberSession`, `lib/docket.ts`), the homepage passes the bill over — a full recess is a quiet week — and the bill page prints a quiet note (`components/FloorRecessNote.tsx`, not a new full-bleed band) in its place: the Digest's own next-meeting sentence verbatim (`lang="en"`), its publication date, its URL, the checked-at stamp, and the fact that a bill cannot be called up at a pro forma session (glossary term #12).

- **The status label is untouched** — a suspended band still returns, carrying a `suspended` flag, so "Floor vote pending" never regresses to "Floor activity".
- **`announced` is exempt by construction** — a chamber naming a bill on its own published schedule is meeting; the exemption lives in `floorFactSuspended`'s kind clause (`lib/journey.ts`), not in caller discipline.
- **Unknown fails safe to live** — a dead pipeline must never suppress a true claim, so a Digest older than the 48-hour ceiling reads as in session.
- **The copy never says "recess" and never claims a duration** — the record carries one session verdict and one next-meeting label, and those are the only facts the sentence states.
- The window is unchanged (`SIGNAL_WINDOW_DAYS` = 14, `lib/urgency.mjs`). It self-heals when a chamber returns: the session verdict is part of the hourly write fingerprint (#230), so the flip forces a data commit and a rebuild.

Gates: `tests/journey.unit.spec.ts` ("the session gate"), and the session-aware cases in `tests/freshness.spec.ts`.

## 6. Counted claims about the press use stored evidence only

*Raised 2026-08-12 (#228, commit 712cb6b). The core question is still OPEN; two owner rulings of 2026-09-26 are below.*

The "In the news" band is selected from `data/conversation.json` — committed, day-granular evidence of which AllSides-rated outlets published about a bill inside a seven-day window, and what congress.gov's own weekly most-viewed list said — and every card prints one sentence saying why it is there. That is a counted claim of Oravan's own about the press. **Open owner question:** whether a counted claim about the press may be printed in Oravan's own voice at all, and if so whether these constraints are the right fence. Until then it ships under these constraints:

1. **Only counted facts, and only ones already stored.** Outlet counts, their leans, the consecutive-week count and the rank are each read straight from the committed file, and an outlet with no AllSides rating never counts toward one. Nothing inferred, rounded or adjectival: no "widely", no "major", no "growing".
2. **It never borrows a floor fact's weight.** Who published what is not a floor fact: the band never takes a live floor fact's treatment, and never changes docket order anywhere.
3. **It never claims a spread it does not hold, and it never counts to one.** One-sided rated coverage is dropped from the band, not reworded. Center-only coverage says "rated center". "Across the spectrum" renders only when both partisan leans are present. A card admitted by the most-viewed list prints that listing and nothing else. Two outlets is the smallest number the band says out loud.
4. **It says nothing about what happens next** — no claim about a vote, a schedule or an outcome.
5. **It disappears rather than degrades.** When the evidence file is absent, unreadable, or unrefreshed past `CONVERSATION_STALE_HOURS`, the band falls back to the stored-coverage selection and prints no caption at all; when the file is live but thin, the band is simply short. No backfilling from the archive.
6. **At most two of the six cards may owe their place to the most-viewed list**, by either admission route — view counts are the cheapest input here for an outsider to move, so they may season the band and never fill it.

**Owner rulings of 2026-09-26**, written into `DESIGN.md` by #300 (commit ff209a6, 2026-09-26 00:58 UTC — after the 2026-09-25 scrap, which is why they are carried here with their dates rather than left in the history file). Quoted as that change wrote them:

- On constraint 1: *"every outlet entry now stores the link to the story that made it count — `conversation/v2` — and the gate fails any entry seen after `_meta.links_since` without one, so "every count comes from stored evidence you can check" is checkable down to the article, not only the domain."*
- On constraint 6: *"those two slots go to the list's own top ranks, newest list first — before this they fell to alphabetical slug order, which kept H.R. 1 in the band 25 of 32 days while the rank-1 bill never appeared — and a bill that is already law takes no most-viewed slot; it renders only when the press corroborates it, as any two-outlet card does."*

Gates: `scripts/check-conversation.mjs` (only rated outlets may corroborate; every entry after `_meta.links_since` carries its link), `tests/conversation.unit.spec.ts`, `tests/news-band.unit.spec.ts`. Per-question press counts have their own gate, `scripts/check-question-press.mjs` (rated outlets only; every count a stored link; never tone or text).

## 7. A settled decision shows the record, not the call

*Owner, 2026-09-28 (UX question Q9, answered "a" at 18:20:11 UTC).* The option he picked, verbatim: *"A record-only block with no numbers: 'This is law' or 'This was rejected, 49–50', and how your members voted. No stance, no script."*

*Owner, 2026-09-29, reviewing the follow-up (artifact 7BuRDMkWu9zigDE1u2XPLJ):* *"For the options, go with your pick (a) but we need to update the MCP server too if possible."* Pick (a), verbatim: *"Only a law or a failed final vote counts as finished. Procedural failures keep the call panel, with a line saying the last attempt failed."*

- **Which bills.** `settledDecision` (`lib/journey.ts`), read off the stepper's own derivation so the panel and "Where does it stand?" agree, returns exactly two things: a signed law, or a rejected vote to pass the measure (or to agree to it), with the record's own tally, printed only when yeas are no more than nays. On 2026-09-29 that is 91 laws and 9 rejections. (A concurrent resolution's own ending is the one addition; see below.)
- **Everything else keeps the call panel.** That covers four cases:
  - A failed motion to proceed.
  - Cloture not invoked.
  - A rejected motion to discharge a committee.
  - A failed two-thirds vote to pass it under suspension of the House's rules.

  None of these is the chamber's final answer on the measure. On 2026-09-29, 25 bills moved back to the call panel: 22 failed motions and 3 failed suspension votes. The full list is in PR #350.
- **The last-attempt line.** On those pages the call panel prints one sentence above the stances (`bill.lastAttempt`, read by `lastFailedVote` in `lib/journey.ts`). It names what failed, with the record's tally and the record's date for that action. For example: "The last attempt failed: the Senate voted against taking it up, 47–50, on June 24, 2026." (S.J.Res. 185), and "The last attempt failed: a House vote to pass it fell short of the two-thirds this fast-track vote needs, 264–133, on February 24, 2026." (S. 2503).
  - **It never says what comes next.** For some of these procedures the measure certainly remains available: a failed cloture or motion-to-proceed vote leaves it on the calendar, and a failed suspension vote leaves it eligible under the regular rules. For others that is not certain. A discharge motion under a statute's expedited procedure (50 U.S.C. 1546a, which borrows section 601(b) of the International Security Assistance and Arms Export Control Act of 1976) runs on the statute's own clock. So no procedure gets a "can come back" clause.
  - **It fails closed.** Only procedures somebody has read get the line: proceed, cloture on proceeding, cloture on the measure, discharge and suspension. A reconsider motion that merely mentions a failed vote, a withdrawn motion, or an unread shape prints no line. The stepper's own sentence still stands below.
- **The stepper, for a failed two-thirds vote.** It used to print the failed-motion sentence, "has not agreed to take it up — the last motion to do so failed". That was false for H.J.Res. 1, H.J.Res. 139 and S. 2503: the House did take each one up, on a vote to pass it that needed two-thirds, and a majority voted yes. It now says "a House vote to pass it fell short of the two-thirds this fast-track vote needs, 264–133" (`nowFloorSuspensionFailed`), with the record's tally.
- **A veto keeps the call.** Congress can still vote to override a veto, with two-thirds of both chambers, and the stepper's veto sentence says so. A veto is neither a law nor a failed final vote, so pick (a) does not count it as finished. No bill in the corpus was vetoed on 2026-09-29.
- **A reconsider motion keeps the call.** A failed vote with a motion to reconsider *entered* keeps the call, because the same question can come back.
- **What stands in the call panel's place, in this order** (owner, 2026-09-28, reviewing /bills/hconres-89-119: *"It's talking about the Senate but in the 'no call to make' box it talks about the House vote and then says the senators underneath this. That doesn't make sense and is confusing."*):
  1. **The outcome, in one sentence.** It names the deciding chamber, with the record's tally and the action's date ("The Senate rejected it, 49–50, on September 24, 2026."). The date is the record's own for that action: `status_basis_date` when the pipeline wrote a basis, else `last_action_date`. It is left out when the record holds none.
  2. **"How your members voted", once a ZIP is saved.** There is one group per vote (`lib/settled-votes.ts`): the deciding vote first, then the other chamber's newest roll call on the bill. Each group is headed by its chamber, date and tally. A member is listed only under a vote their own chamber held, never two chambers in one list.
     - The deciding vote is matched by the roll number in the record's own sentence.
     - When the roll-call file does not hold it, the group still prints the record's date and tally, and says positions are not shown and why. H.R. 2262's House vote of 2026-01-13 is older than the file's floor.
     - A voice vote says no position was recorded.
     - A member the roll call does not list reads "No recorded vote".
  3. **With no ZIP,** one line and the ZIP form.

  The vote record's own "your members" strip is left off the page, so nothing is printed twice. There is no stance control, no script and no phone number. A member's name links to their page, which carries the numbers.
- **What else goes.** The floating call button and the "see how a call works" demo, both of which only ever pointed at a call.
- **The MCP envelope reads the same rule** (`decisionState`, `lib/docket.mjs`):
  - **Values.** `enacted` for a law, `settled` for a failed passage vote (and, since #360, a concurrent resolution both chambers adopted), `pending` for everything else. A failed motion, a failed suspension vote and a veto are all `pending`.
  - **The call link.** `get_bill` offers `act_url` on every `pending` record, and withholds it on `settled` and `enacted`.
  - **Schema unchanged.** `settled_reason` stays null while pending, and no field was added for "the last vote failed". The failed vote still reaches an agent verbatim through `get_bill`'s `last_action_text`.
- **Never wider than the MCP envelope.** Everything the panel calls settled, `decisionState` calls settled or enacted. The converse has one stated gap:
  - **A failed passage vote whose chamber the record does not name.** `decisionState` reads the words alone and calls it settled. The stepper prints its chamber-free sentence, and the panel keeps the call with it. No record had that shape on 2026-09-29.
- **A concurrent resolution both chambers agreed to in one form is finished too** (2026-09-29, `concurrentAdoptedBy` in `lib/floor-text.mjs`; H.Con.Res. 86, the House 215–208 on June 3 and the Senate "without amendment" 50–48 on June 23, 2026, the one case): it goes to no president, so its page shows the record-only panel as `adopted` ("Both chambers agreed to it in the same form, the second on June 23, 2026."), never as law, with the same per-chamber vote groups as a rejection; the stepper says its path ends here, its status label reads "Adopted by both chambers", and the envelope's `settled` agrees.
- **Not yet covered:** the paid action-panel embed (`app/embed/action-panel`) does not read the settled state; rule 6 says so. The Big Questions status line (`lib/moment-status.mjs`) still marks a failed vote as terminal, so a vehicle card for a failed motion reads "Read the bill" rather than "Read + call", although its page now has the call panel.

Gates:
- `tests/settled-panel.unit.spec.ts`: the reader, both directions over the committed corpus, pick (a) over the whole corpus, and the words in both languages.
- `tests/settled-panel.spec.ts`: the page, including S.J.Res. 185 and S. 2503 with the call panel and the line.
- `tests/settled-state.unit.spec.ts` and `tests/mcp-tools.spec.ts`: the MCP classification.
- Funnel invariant I2, scoped to a decision still open (`tests/funnel.spec.ts`).

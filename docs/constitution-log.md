# Constitution log

The history behind `CLAUDE.md`'s hard rules: every dated amendment and the wording it retired, the measurements, the file-and-line tracing, the owner rulings, and the inventories of what each amendment had to go fix. Newest first, append-only — an entry is never edited or deleted once written, because the point of it is what was true on the day it was written.

**What is NOT here, deliberately.** Every live rule, and every instruction an agent must act on, stays in `CLAUDE.md`, short, next to its gate — including the one this repo has already broken once ("the list is not widened", now in rule 3). A link is only load-bearing if it gets followed, so nothing that changes what you should DO lives behind one. Since Constitution v2 (2026-09-27) the dated amendment markers live here instead of inline: this file is where you learn how a rule got its shape, and where you check the arithmetic. Amending a hard rule is one PR that changes the rule, its gate and the public copy that states it, plus one entry appended here. The preamble this replaced is quoted in the 2026-09-27 entry.

**Gate coverage:** this file is in `scripts/check-claim-truth.mjs`'s `SCAN_FILES`, added in the same change that created it. Moving text out of a scanned document into an unscanned one is how a gate quietly stops covering what it was written for; it was covered from its first line. Since 2026-09-27 it also carries an R3 allowlist entry: the retired review wordings quoted below are amendment records, each in a sentence that says so, and `tests/claim-truth.spec.ts` requires at least one to remain here.

---

<a id="settled-panel-2026-09-28"></a>

## 2026-09-28 — Rules 6 and 8: a settled decision shows the record, and the call budget counts open decisions

Rules touched: page 1, rule 6 (the record, quoted, never narrated) and rule 8 (truth first; the call is never buried). README design principle 4 is the public copy that states rule 8, and it changed with it.

- The owner's ruling, on the 2026-09-28 UX inventory page (kept out of this repo): question Q9, "What does the call panel show when there's no decision left?", answered **a** at 2026-09-28T18:20:11Z. Option a, verbatim: *"A record-only block with no numbers: 'This is law' or 'This was rejected, 49–50', and how your members voted. No stance, no script."*
- Rule 6 said "a settled decision shows no call apparatus (not yet true on bill pages — the 2026-09-27 audit, SY-02)". The bill page now makes it true: `settledDecision` (`lib/journey.ts`) picks the record-only panel for a law, a veto, a rejected passage vote or a failed motion to take the measure up, and the page drops the stance control, the script, the dials, the floating call button and the call demo. The parenthetical is replaced by a narrower one, because one surface still does not read the settled state: the paid action-panel embed (`app/embed/action-panel`). Removing the caveat outright would have made rule 6 claim something that surface does not do. The detail is `docs/record-truth.md` §7.
- Rule 8 said "from any decoded answer a completed call script is within two interactions, and on a bill page a way to call is on screen at every scroll depth". Read literally, that asks for a call script on a law's page, which is exactly what Q9 "a" removes. The clause now reads "from any decoded answer, for a decision still open, a completed call script is within two interactions, and on that bill page a way to call is on screen at every scroll depth". Nothing about an open decision's page changed, and no budget moved (`BUDGET` in `tests/funnel.spec.ts`: 1, 2, 3).
- What the tests measure now: I2 from the week and from the /reps continuation still takes the FIRST link, because both read the act-now pool, which never holds a settled bill; the member-page I2 path picks a member whose newest sponsored bill is still open (the Q9 card's own test note asked for this); the quiet-week escape hatch picks the first open bill on /bills; `tests/bill-call-rail.spec.ts` walks an open bill. `tests/settled-panel.spec.ts` pins the settled side in both languages, and `tests/settled-panel.unit.spec.ts` pins that the reader is never wider than the MCP envelope's `decisionState`.
- Same change, rule 4 (shipped claims kept true): `moments.bothNote` ("Every link above opens the same call flow…") and `moments.vehiclesLede` ("Each opens … the call flow") were true of every bill card only because every bill page mounted the call panel. A Big Question holding a settled bill now prints `moments.bothNoteSomeNoCall` and the new `moments.vehiclesLedeSomeSettled`, and a settled bill's card button reads "Read the bill" even where its status line has not caught up.

---

<a id="call-reach-2026-09-27"></a>

## 2026-09-27 — Rule 8: the floating call button stands down over the decoded answer on phones

Rule touched: page 1, rule 8 (truth first; the call is never buried).

- The conflict: the audit (SY-07) measured the floating "Make the call" button covering about three lines of the decoded answer on every phone screen (16 of 19 scroll positions; three personas of three). The owner approved hiding it while the decode is on screen (audit card a5, answered **a** at 2026-09-27T10:16:56Z, whose PR list read "the floating button hidden while the decode is on screen"). The same day's Constitution v2 draft carried rule 8's older clause, "on a bill page a way to call is on screen at every scroll depth", which the change (#314) breaks by design.
- The owner's ruling, typed in session on 2026-09-27, answering the build report's card "Rule 8 clashes with the floating-button change (#314 vs #315)" with **"1. a"**. Option a, verbatim from the report: *"Amend rule 8's clause: '…at every scroll depth, except on a phone while the decode itself is on screen, where the call panel follows it directly.' Cost: one line in #315 and one log entry. The rebuild's Call tab replaces the button anyway."*
- What the amended clause keeps: never two call surfaces at once; the button never sits over the decoded answer; the call panel is the next thing after the answer in the page; past the panel the button carries the rest of the page back to it; funnel invariant I2 (a completed script within two interactions) is unchanged, because it counts interactions and never read the button.
- Gate: `tests/bill-call-rail.spec.ts` as amended by #314 (11 scroll positions on webkit-mobile: the button shows exactly when neither a call surface nor the answer is on screen, never over the answer, and the panel follows the answer). Until #314 merges, main still shows the button during the read, which satisfies both wordings.

---

<a id="constitution-v2-2026-09-27"></a>

## 2026-09-27 — Constitution v2: hard rules on page 1, direction on page 2, DESIGN.md retired

The owner's ruling, on the decision cards of the 2026-09-27 audit (collection `audit-decisions`, kept out of this repo): card a1, "Adopt Constitution v2?", answered **a** at 2026-09-27T10:15:55Z; card a2, "Disarm the impeccable hook and retire DESIGN.md?", answered **a** at 2026-09-27T10:16:07Z. The scrap itself is the owner's ruling of 2026-09-25 ("scrap DESIGN.md + rebuild UI"), which until this change had no home in the repo. The text adopted is the draft in §3 of the audit's trap analysis (kept out of this repo), with the deviations listed below.

What moved where:

| From | To |
|---|---|
| `CLAUDE.md` line 3: "its **Design principles** section is the product constitution" | `CLAUDE.md` is page 1; README's principles are the public statement of it |
| `CLAUDE.md` "Hard rules": seven bullets, one of them a 726-word paragraph | `CLAUDE.md`, twelve numbered rules, each naming its gate |
| `CLAUDE.md` "Constitutional conflicts" | `CLAUDE.md` "When something conflicts", narrowed to page 1 |
| `CLAUDE.md` "How work is handed back" and "How big work is delegated" | `docs/process.md` |
| `CLAUDE.md` secrets inventory | `docs/runbooks/secrets.md` |
| `CLAUDE.md` "Architecture in one breath": page counts, the dynamic-route list, the `proxy.ts` paragraph | one paragraph without counts; the page-view count moved into rule 1 |
| `CLAUDE.md` dated amendment markers | this log — the parts it did not already hold are below |
| `DESIGN.md` record-truth rulings ("the amber law", and the news band's counted caption) | `docs/record-truth.md` |
| `DESIGN.md` Focus, Contrast, accessibility floor, reduced motion | `docs/accessibility.md` |
| `DESIGN.md` "AI content is **labeled at first contact**…" | README design principle 5 |
| `DESIGN.md` "Embed lockstep" | `docs/process.md`, rebuild checklist |
| the rest of `DESIGN.md` | `docs/history/DESIGN-2026-07-24.md` — verbatim but for the removed token front matter; no force |
| the owner's current look-and-feel rulings, which had no home | `docs/current-direction.md` (page 2) |

Why the conflict duty stayed, narrowed. It caught three real conflicts in September, all page-1 matters: a research agent would not build a page counter against "no analytics trackers" without a ruling (raised 2026-09-10; shipped with the owner's approval as #247 on 2026-09-24); a Big Questions agent held computed party counts against the nonpartisan lint and asked (card l12, below); and an agent pulled a Moment-qualification vocabulary widening out of a spend-reduction PR for its own ruling. It also turned colours, radii and layouts into constitutional questions — the audit counted about fifty decision cards in three days. v2 keeps the duty for page 1 and takes taste out of its reach.

Deviations from the draft, each made for accuracy against the code on `origin/main`:

- Rule 1 states what the server really counts: short-lived rate-limit counters (a salted hash of the caller) and aggregate daily counts, including the page-shape count since #247, all fixed by `scripts/check-key-namespaces.mjs`. "The only server-side counts are aggregate" would have been false, because rate-limit counters are keyed per caller. `tests/upstash-privacy.spec.ts` added to its gates; no gate exists for third-party requests from main-site pages, and the rule says so.
- Rule 2: the draft said the only dynamic routes are APIs listed in `tests/static-rendering.spec.ts`. That spec lists the pages that must prerender and names the two that do not (`/reps`, `/nominations/[slug]`); the rule now says that. `tests/frame-posture.spec.ts` moved to rule 12, where the frame split it pins is stated.
- Rule 3 keeps the 2026-08-06 instruction that the lint is not widened to decodes, with its measurement link.
- Rule 4 names Big Questions (owner, 2026-09-25) so the 2026-09-25 amendment survives the move.
- Rule 6 carries "absence is a finding, and news stays instrumental" (from the 2026-07-26 rule), and marks "a settled decision shows no call apparatus" as not yet true on bill pages (audit SY-02).
- Rule 7: the reflow gate is the `webkit-320` Playwright project; `tests/bill-a11y.spec.ts` covers the bill page only (audit SY-56), and the rule says so.
- Rule 8 names `tests/bill-call-rail.spec.ts` for "a way to call at every scroll depth", and does not claim the funnel spec reads `data-testid`s (it reads section ids today).
- Rule 9: `scripts/check-public-allowlist.mjs` keeps `public/` to allowlisted files; it does not check competitor names, so that clause and "git history is never rewritten" say they have no automated gate yet.
- Rule 10 names the one partial gate (`scripts/check-key-namespaces.mjs` confines the Upstash env vars).
- Rule 12 names the palette mirrors the code names (`lib/embed-theme.ts` lists four for the embed's default pair).
- Merging keeps the grant's scope path list, which the unattended pipeline-doctor routine reads; only its history is here (`#merging-2026-09-24`).
- Page 2 (`docs/current-direction.md`) says plainly that the live site still carries the July 2026 system until the rebuild, names the two message keys that print the word "green" in both languages, records that the impeccable hook is off and why, and replaces two product names with a note that they are kept out of this repo.

Gate changes in the same change:

- `scripts/check-claim-truth.mjs`: `CLAUDE.md`'s R3 allowlist entry removed (its last retired-wording quotation moved here), an entry for this file added, `DESIGN.md` dropped from `SCAN_FILES`, the new living documents added to it, and `docs/history/` listed as not scanned, with the reason.
- `tests/claim-truth.spec.ts`: the labeling-clause test now reads README principle 5; "the amendment records must still be in the files" now requires them in this log.

The preamble of this file until this entry, verbatim:

> **What is NOT here, deliberately.** Every live rule, every dated `Amended YYYY-MM-DD:` marker sentence, and every instruction an agent must act on stays inline in `CLAUDE.md` — including the two that this repo has already broken once ("the list is not widened" and "nothing on this path writes `data/moments.json` and nothing publishes"). A link is only load-bearing if it gets followed, so nothing that changes what you should DO lives behind one. This file is where you check the arithmetic, not where you learn the rule.
>
> Each `CLAUDE.md` amendment points here with `(evidence: docs/constitution-log.md#anchor)` at the spot its paragraph used to sit.

### Moved from CLAUDE.md: the amendment history this log did not yet hold

Each item is what `CLAUDE.md` said, dated, as it stood on 2026-09-27. Where an older entry below already held the evidence, the item links to it rather than repeat it.

<a id="ai-content-2026-07-25-marker"></a>

**2026-07-25 — AI content: the founding correction** (evidence: [#ai-content-2026-07-25](#ai-content-2026-07-25)). The rule was "AI content is always labeled, and never publishes unless the automated gates pass", and its marker read that this line previously read "human-reviewed", which the decode path never did — the nightly sync commits decodes straight to `main`, and the Moments live layer publishes its summaries the same way.

<a id="truth-first-2026-07-26"></a>

**2026-07-26 — Truth-first, call-next.** The hard rule, as amended that day: *"the product leads as the unbiased plain-words source on any issue; calling is the natural next step after engagement, not the price of admission. Enforced by named invariants in `tests/funnel.spec.ts`: every homepage truth surface is ≤1 click from a decoded, AI-labeled answer (I1), and every decoded answer keeps a completed call script within 2 interactions, ZIP-first ≤3 clicks (I2). Demote the call apparatus, never bury it. Unchanged: no Moment without a legislative vehicle, absence is a finding, news stays instrumental."* The single invariant it replaced was "≤3 clicks to a completed call script" (the header of `tests/funnel.spec.ts` records the rewrite). Now page 1, rules 6 and 8; the budgets live in the spec only.

<a id="conflicts-2026-08-05"></a>

**2026-08-05 — The conflict duty reaches shipped claims.** The sentence added to the "Constitutional conflicts" section: *"The same duty covers **shipped claims that have quietly stopped being true.** A rule that the code no longer honors is a conflict, not a detail — surface it the same way. Added 2026-08-05 after three went unflagged in one session: the `/citations` "no advocacy language" gate (a prompt instruction, never a gate), the House-has-no-vote problem in any non-bill vehicle, and coverage staleness (88.5% of `data/coverage.json` entries older than 30 days behind a page that reads as nightly-fresh)."* The section's scope line was *"Applies to: the hard rules above, README Design principles 1–6, and the named invariants in `tests/funnel.spec.ts`."* v2 narrows the scope to page 1 and keeps the shipped-claims duty as a rule-4 conflict.

<a id="ai-content-2026-08-06-vocab-marker"></a>

**2026-08-06 — AI content: the vocabulary lint dropped from the gate list** (evidence: [#ai-content-2026-08-06-vocab](#ai-content-2026-08-06-vocab)). The marker: *"Amended 2026-08-06: the gate list above also named a "forbidden-vocabulary lint", which has never run on the decode path — `lintForbidden` (`lib/moments-gate.mjs`) is wired into `scripts/check-moments.mjs` and `scripts/check-moment-updates.mjs` only."* Its instruction, *"The list is not widened; the claim is corrected"*, is now in page 1, rule 3.

<a id="ai-content-2026-08-06-schema-marker"></a>

**2026-08-06 (second pass) — AI content: the schema mechanism named correctly** (evidence: [#ai-content-2026-08-06-schema](#ai-content-2026-08-06-schema)). The marker: *"Amended 2026-08-06, second pass: the gate parenthetical at the top of this rule said a schema failure "fails the whole sync rather than shipping a partial record", which named the wrong mechanism. The promise held — nothing partial ships, the bill is simply not added — so the parenthetical now names the two mechanisms that actually run, including the pre-commit corpus check in `scripts/verify-sync.mjs` that really does fail the whole nightly run."* Now page 1, rule 11.

<a id="ai-content-2026-08-07-marker"></a>

**2026-08-07 — AI content: Moment first drafts by `scripts/moment-draft.mjs`** (evidence: [#ai-content-2026-08-07](#ai-content-2026-08-07)). Written on the owner's directive *"I want to review and edit the writing and the choice of what goes up. I don't actually want to write them"*. The marker recorded that the carve-out's *hand-authored and merged by Colby* was no longer accurate in its first half: `scripts/moment-draft.mjs` wrote the FIRST DRAFT of a candidate's `name`, `summary`, and each vehicle's `role` — both languages — from the record printed in the same `moment-watch` issue and nothing else, labelled there as an unreviewed AI draft, and lint-checked (`lintForbidden` via `lintRevisionText`, plus the speculation lint and an asserted-vote-date check) before it was ever offered. Its instruction, in bold: **the owner edits that draft and merges it; nothing on this path writes `data/moments.json` and nothing publishes**. Until #280 retired that wording on 2026-09-25, the marker quoted `moments.howMadeBody` — *"checked by an automated gate, then reviewed by a person before it publishes"* — as the string the instruction kept true. The draft-then-merge flow was retired on 2026-09-25 (below). The marker's last guarantee is still pinned: delivery never depends on the model — with no key, an API error, an unparseable reply, or a lint-rejected field the scaffold falls back to the blank form and the issue still opens (`tests/moment-draft.unit.spec.ts`).

<a id="cursor-age-2026-08-12"></a>

**2026-08-12 — Corpus integrity: the cursor-age alarm moved after the commit (owner's N8-A2 ruling).** The marker, in substance and mostly verbatim: `scripts/verify-sync.mjs` still fails the whole nightly run before anything is committed rather than commit a damaged corpus — with ONE check subtracted from it. The cursor-age ceiling (`CURSOR_MAX_AGE_DAYS = 10`) moved out to `scripts/check-cursor-age.mjs`, which runs as the LAST step of `sync-bills.yml`, **after** the commit. It was never a corpus claim: a stalled cursor says *we are behind*, not *the corpus is damaged*, and failing it before the commit made a stalled night discard its own already-paid decodes, coverage, nominations and Moment updates — which made the backlog it was complaining about strictly worse, with no self-healing path (the same stall recurs the next night, so `main` simply stops advancing). It was also the less honest option: the site's freshness math reads that same `lastSync` (`lib/freshness-state.ts`), so refusing the commit froze the staleness signal at an older value than the truth. **Every integrity gate stayed pre-commit** — bilingual parity, corpus uniformity, the count-drop floor, the floor-signals evidence check, the moment-updates retention caps, and the cursor's FORMAT (a bare-date cursor is damage, not lateness: it 400s Congress.gov). The run still goes red when the alarm fires; the night's data lands anyway. No user-facing string needed a correction: `citations.aiBody` claims in both languages that "the whole corpus is re-checked before the nightly sync is allowed to publish anything", and the corpus re-check is precisely what stayed. Pinned by `tests/nightly-pipeline.unit.spec.ts`, which asserts which check lives in which file AND the step order in the workflow. Now page 1, rule 11.

<a id="architecture-2026-09-24"></a>

**2026-09-24 — Architecture counts and the page-view count.** The architecture paragraph said: *"~7,500 SSG pages (7,566 prerendered HTML pages in the 2026-09-24 build: 6,410 bill pages, 1,082 member pages, 30 daily-brief pages and the flat pages, in both languages — pinned by `tests/static-rendering.spec.ts`)"*, and, of `proxy.ts`: *"(since #247, owner-approved 2026-09-24): after the response is sent it adds one to a per-day page-view count keyed by the page's SHAPE (`home`, `bill`, `question`, … — nine labels pinned by `scripts/check-key-namespaces.mjs`), never by path, slug, query, locale, or anything about the visitor; the count lives in the counters database and feeds the daily digest only."* The counts were dropped from `CLAUDE.md` because a test pins the posture and a count needed three corrections in two days. The page-view count is now part of rule 1. One note the move surfaced: member pages, `/today`, `/follow` and 404s are filed under the `other` label, so "nine labels" did not mean member pages were counted apart (audit SY-49).

<a id="ai-content-2026-09-25-marker"></a>

**2026-09-25 — Big Questions under the automated gates** (evidence: [#ai-content-2026-09-25](#ai-content-2026-09-25)). One sentence of the marker is not in that entry: *"Until the automated Big Questions writer ships, changes to `data/moments.json` still reach `main` through PRs."* It still holds, through the merging rule: `data/moments.json` is outside the standing grant, so it waits for the owner.

---

<a id="privacy-lines-2026-09-27"></a>

## 2026-09-27 — Two privacy lines known to be false, left live until launch (card l16)

Rules touched: page 1, rules 1 and 4 (a shipped claim that has stopped being true is a rule-4 conflict). Recorded here so the decision has a date and a tripwire rather than living only in session memory.

- The owner's card l16, "Correct the two false privacy lines", answered **b** at 2026-09-27T00:59:39Z, with the note, verbatim: *"Bring this back up prior to launch."* The option text behind **b** was not exported with the answer; with the note, it leaves both lines as they are for now.
- The two lines, as shipped on 2026-09-27, in both languages: `privacy.p1` says Oravan never asks for your name, email or address — and the optional street-address refinement for split ZIPs asks for an address (sent once by POST, never stored or logged), and the partnership feedback form asks for contact details. `privacy.p8` says Oravan keeps "one plain count" — the page-shape count — while `lib/usage.ts` also keeps daily script-generation, MCP-tool, MCP-client and brand-preview counts, and `lib/impressions.ts` keeps per-partner embed impression counts.
- Not changed by the change that wrote this entry. **Tripwire: before the press hold lifts; date not yet set by the owner.** Whoever lifts the hold brings this card back to the owner first.

---

<a id="party-counts-2026-09-26"></a>

## 2026-09-26 — Party counts on votes vs the nonpartisan lint (card l12), recorded 2026-09-27

Rule touched: page 1, rule 3 (nonpartisan by construction).

- The question: party breakdowns on recorded votes as mechanical counts in text (for example "R 4 yea / 49 nay"). They collide with two shipped rules: `lintForbidden` (`lib/moments-gate.mjs`) rejects party names in Big Question text, and `components/VoteRecord.tsx` documents the vote record as naming no party.
- The owner's card l12, "Party breakdowns: how they appear", answered **b** at 2026-09-26T21:16:56Z, with the note, verbatim: *"You handle the rule change. This is not that big of a deal to me, I just need it to work."* The option text behind **b** was not exported with the answer, so which display **b** chose is not recorded here.
- What the note delegates: the rule change itself — a scoped lint exception for mechanical count patterns, and the vote-record wording to match — is Claude's to write, as a page-1 amendment with its gate, its tests and both languages in one PR. **Not made yet**: this entry records the delegation, and the change that makes it appends its own entry. Rule 3 as written in v2 ("party is text, never a hue") already allows a count in text; the lint does not yet (audit SY-27).

---

<a id="user-data-2026-09-25"></a>

## 2026-09-25 — No server-side user data, ever: the daily distinct-address count

Rule touched: page 1, rule 1 (no server-side user data, ever). The ruling that let one site-wide daily count of distinct network addresses exist, and the hardening the owner chose before it merged. The rule's text is not amended by this change; this entry records why this structure was judged to sit inside it, exactly what it can and cannot do, and the two places where page 1's wording (Constitution v2, adopted the same day) now needs the owner's eye.

The ruling, verbatim. Card 15 (D4), "Counting daily users", answered **a** by the owner on 2026-09-25T02:50Z (evidence: artifact https://claude.ai/artifact/7BoxWU8F4TLDRjUAEKTQgc, db `decisions`, doc `q15-d4`, choice `a`):

> *"Yes, one number a day — Count each day's unique visitors with HyperLogLog, built from the salted hash the rate limiter already makes. It can't identify anyone. Needs a constitution-log entry and one privacy sentence in both languages."*

The 2026-09-27 audit (SY-20) found it ruled and unbuilt, and card a5 of that audit put it in the measurement work.

<a id="user-data-2026-09-27"></a>

**Hardened before merge, 2026-09-27.** The first build of PR #321 did what the card said and reused the rate limiter's salt. Its report showed that this left a window after each day ended in which the sketch could still be tested, and offered options. The owner answered **"2. b"**, which was this option, verbatim:

> *"I harden it first: the sketch gets its own salt, deleted when its UTC day ends, which closes the after-the-day window. I also soften the two strongest lines to say one site-wide daily number is kept."*

So the sketch no longer uses the rate limiter's salt or hash at all. The card's phrase "built from the salted hash the rate limiter already makes" describes the first build, not the one that merges.

What was built:

- One key per UTC day in the counters database, `<env>:uniques:<YYYY-MM-DD>`, holding one HyperLogLog sketch for the whole site. No route, page, surface, bill or locale dimension exists, and `scripts/check-key-namespaces.mjs` makes one a CI failure: `distinct-shape` pins the exact key literal and bans PFMERGE, `distinct-confinement` keeps the key family and every HyperLogLog command inside `lib/ratelimit.ts`, and `distinct-raw-address` forbids a raw address as the added element.
- The sketch's own salt: one key per UTC day, `<env>:uniques-salt:<YYYY-MM-DD>`, holding ≥128 bits of CSPRNG output. It is created with `SET … NX EXAT <00:00:00Z of the next day>`, so it exists with its deadline from the first instant, and nothing ever re-sets, re-expires or extends it. When its UTC day ends the database deletes it. Each server instance may keep a copy in memory for at most 60 seconds and never past that same instant. The rate limiter never reads it, and the sketch never reads the rate limiter's salt. Four more gate rules hold this: `distinct-salt-shape` (the exact key literal), `distinct-salt-confinement` (no other file may reach the salt), `distinct-salt-expiry` (every command on the salt key is a read, a delete, SET NX with EXAT at the end-of-day deadline, or EXPIREAT at that same deadline, and the deadline function's own arithmetic may add at most one day to the day's 00:00:00Z), and `distinct-salt-separation` (the limiter's salt and hash never appear in the functions that feed the sketch or make its salt or element).
- The element added is sha256(day salt ‖ address), a different salt and a different construction from the rate limiter's sha256(address + salt), so an element can never equal a rate-limit key's hash.
- It is added from `proxy.ts` inside `waitUntil`, so the response never waits on it and a counter failure never fails a page, only for requests the page-view counter already counts (a GET asking for HTML; `/api`, `/_next` and `/embed` never reach the proxy). Embeds are never counted, so `embeds.docsPrivacyNoData` stays true.
- The sketch key dies 48 hours after its UTC day ends (an absolute EXPIREAT, never extended). The daily digest reads yesterday's sketch once with PFCOUNT, which needs no salt, and prints it as "Distinct network addresses (bots included)".
- With the counters database unconfigured it does nothing — no in-memory fallback, because a per-instance set of addresses would be an actual list of addresses.
- Cost: one PFADD per counted page view; one EXPIREAT whenever the sketch changes (at most once per new address); one SET per UTC day for the salt; and about one salt GET per server instance per minute, because of the 60-second memo (two when instances race to create the salt). One sketch key of at most about 12 KB per day, plus one 32-character salt that lives until the day ends.

Why it is inside the rule, and where the edge is:

- It is the first stored structure whose value, not just its key, comes from caller material. A HyperLogLog does not store its elements; it stores 2^14 six-bit register maxima. No address and no element is stored by this path (the element crosses the wire inside the PFADD command), and the sketch cannot be listed or reversed.
- The rule's operative clause is "no logs linking network addresses to political positions". One global number per day records no page, bill or stance, so there is nothing to link to. A per-page or per-bill sketch would be exactly that link, which is why the gate forbids one.
- The honest limit. **During the UTC day itself**, someone holding the counters database and a candidate address can still read that day's salt, compute the address's element, and test whether adding it would change the sketch. At low daily counts that test is fairly reliable. **Once the day ends, the salt is gone**, and with it the only way to compute an element, so the sketch cannot be tested for anyone, including for its 48-hour tail before it expires. The first build left that test open for up to about 24 hours after each day ended, because the shared salt lives 24 hours from creation rather than to midnight. That window is what the hardening closed. (The rate limiter's own keys keep their own, separate exposure while its salt lives, for callers of rate-limited routes. That is unchanged and out of this decision's scope.)
- **The Sep 25 card's "It can't identify anyone" was too strong.** What is true now: nothing can be listed or recovered from the sketch, at any time. During its UTC day, someone who already holds the counters database and already has a candidate address can confirm whether that address loaded a page that day. After the day ends, not even that.

Accuracy, stated wherever the number is shown (the digest caveat):

- Redis HyperLogLog standard error is about 0.81%.
- Bots are included. A household, office or carrier NAT shares one address (undercount); a phone changing networks shows several (overcount).
- An address counts once per UTC day, because the salt lives exactly that day. The first build's salt-rotation overcount (an address seen on both sides of the shared salt's rotation counted twice) is gone. One residual edge: if a day's salt were lost mid-day, a new one would be minted and an address seen on both sides of the loss would count twice.

Strings and claims changed in the same change:

- `privacy.p9`, new, in both languages: one number a day for the whole site, never split by page, of distinct network addresses that opened a page, bots included, counted from each address scrambled one way with a key that lasts only that day and is then deleted, with no address stored or recoverable. `privacy.p8` (the per-page-kind count) is not changed here, and it already carries a separate false claim ("one plain count", while other daily counts exist), recorded in card l16 ([#privacy-lines-2026-09-27](#privacy-lines-2026-09-27)) and left live by the owner until launch. This change does not touch that decision.
- The two strongest categorical lines were rewritten, per the owner's option: **`common.footer.mission`** (every page's footer, and also the site's meta description and JSON-LD description) now says nothing that identifies you is stored on our servers and that visitors are counted only as one site-wide number a day, in both languages. **`/llms.txt`**'s notes line ("No user data is collected server-side", read by machines that redistribute it, English-only by design) now says nothing that identifies a visitor is stored server-side and that visitors are counted only as one site-wide number a day.
- The digest's page-view caveat said "no unique/visitor count exists"; it now says the page-view counters carry no identity and the distinct-address line is separate. `lib/usage.ts`'s comment that a unique count was "a pending owner ruling", `proxy.ts`'s header, and the pinned digest issue's creation text in `.github/workflows/daily-metrics.yml` were corrected the same way, and name the sketch's own day salt.
- Checked for this count and left unchanged: `privacy.p1`–`p5`, `p7`, `p8` (none of them is made false by the count; `p1` and `p8` carry the separate card-l16 falsehoods above); `embeds.docsPrivacyNoData` (embeds are never counted); `mcp.privacyRateLimit` (MCP is `/api`, never counted); the MCP envelope (it makes no visitor claim). These lines stay true on the ruling's reading that one site-wide daily number is not data "about you", and none was rewritten because the owner asked for two: `about.accountabilityBody` ("nothing about you kept on a server"), `terms.p5` ("store nothing about you on our servers"), `errorBoundary.eraseHelp` ("Nothing about you is stored anywhere else", said about what the Erase button can clear), and `/llms.txt`'s Pages entry for /privacy ("no server-side user data, ever", which is the constitution rule's own name, and the entry above records why the sketch sits inside that rule). The "no tracking" lines rest on the same reading, plus the fact that the sketch has no page dimension and nothing in it outlives its day's salt: `privacy.p4` ("No analytics trackers"), `common.trustLine2` ("no trackers"), `common.footer.funding` and `about.accountabilityBody` ("no tracking"), and `moments.updates.privacyNote` ("Nobody is watching you read this — no account, no tracking"). Rewording any of them is the owner's call.
- Not changed here: `CLAUDE.md`. Constitution v2 (#315) was adopted on 2026-09-27 and merged into this branch before this change merged, and two of its sentences now need the owner's eye. Both are page-1 text, owner scope, raised in PR #321 rather than edited here:
  - The Architecture paragraph says per-request code includes `proxy.ts` "(locale negotiation, then the page-shape count of rule 1)". With this change `proxy.ts` also adds to the distinct-address sketch, so that parenthesis becomes incomplete.
  - Rule 1 says the server may count, as fixed by `scripts/check-key-namespaces.mjs`, "short-lived rate-limit counters … and aggregate daily counts that carry nothing about a visitor". The sketch is registered and gated there, and the daily number it yields carries nothing about a visitor. During its UTC day, though, the sketch and its salt can confirm a candidate address for someone who already holds the counters database (the honest limit above). Whether rule 1 should name that edge is the owner's call.

---

<a id="ai-content-2026-09-25"></a>

## 2026-09-25 — AI content is always labeled, and never publishes unless the automated gates pass

Evidence for the amendment that brought Big Questions under the same automated-gate rule as the rest of the AI content. The live rule stays inline in `CLAUDE.md`.

What was true on the day:

- The owner's ruling, 2026-09-25, recorded in his plan answers: Big Question text is written by AI and publishes automatically ("Everything automatic").
- #280 (merged 2026-09-25) changed the three strings that described a person reviewing Big Questions, in both languages: `moments.howMadeBody`, `moments.status.lastReviewed` (now "Summary updated {date}") and `moments.aiNote`. They now describe the automated gates.
- `CLAUDE.md` still quoted the old `moments.howMadeBody` wording as true after #280 merged. This amendment corrects that sentence and marks the 2026-08-07 draft-then-merge flow as retired.
- Not changed: the labels, the gates, the forbidden-vocabulary lint on Big Questions, bilingual parity, and the vehicle rule.

---

<a id="merging-2026-09-24"></a>

## 2026-09-24 — Merging: the standing pipeline carve-out

Evidence for the amendment that replaced "Claude opens PRs but never merges — Colby merges." The live rule and its scope stay inline in `CLAUDE.md`.

What was true on the day:

- The daily pipeline-doctor routine (created 2026-09-18) carried the owner's authorization — *"You have my authorization to push and merge. Anything that costs over $3 will need my approval."* — for the pipeline/ops scope, and had merged #261, #263, #265, #266 and #269 on it, each with a PR comment naming the grant. The hard rule and the running practice disagreed in writing. The routine's 2026-09-23 report raised it as a constitutional conflict instead of continuing silently: *"until then, say the word and I will stop merging and leave every PR."*
- The owner's ruling, 2026-09-24, verbatim: *"From now on you can merge anything that has to do with the doctor's pipeline indefinitely or until I request you to stop. This should override line 14 in Claude.md."* He widened the rule rather than stopping the merges.
- The scope written into the rule is copied from the routine's prompt, not invented for the amendment; the $3 line is the same one the routine carries; the green-CI condition and the PR-comment record are the routine's existing practice.
- Session grants for everything else are unchanged: per-session, in his words, never carried forward.

Corrected in the same change:

- "~1,000 SSG pages" (CLAUDE.md) and "~1,000 statically generated pages" (README principle 2) → the measured figure. `.next/prerender-manifest.json` on the 2026-09-19 production build held 6,012 HTML pages (#256), and `tests/static-rendering.spec.ts` pins that every `[locale]` page prerenders in both languages. The claim had been an undercount, not a falsehood, since the loading-boundary regression was fixed by #253.

---

<a id="ai-content-2026-08-07"></a>

## 2026-08-07 — AI content is always labeled, and never publishes unless the automated gates pass

Evidence for the amendment that opened Moment first drafts to `scripts/moment-draft.mjs`. The marker, the scope of what the script may write, the owner-edits-and-merges instruction, and the no-key fallback guarantee all stay inline in `CLAUDE.md`.

Inventory — the other string the same change had to widen:

- `moments.aiNote` was widened in both languages the same day, because it covered the summary only and the name is AI-drafted now too.

---

<a id="ai-content-2026-08-06-schema"></a>

## 2026-08-06 (second pass) — AI content is always labeled, and never publishes unless the automated gates pass

Evidence for the amendment that corrected which mechanism a schema failure actually runs. The marker and the corrected promise stay inline in `CLAUDE.md`.

Mechanism tracing, as of 2026-08-06:

- `scripts/bill-decode.mjs`'s shape check (`bad decode shape`, line 132) is caught per bill at line 239 and only that bill is dropped; `scripts/sync-bills.mjs` exits 1 only when more than half the run failed (line 286).

Inventory — the surfaces that had inherited the wrong wording from `CLAUDE.md` and were corrected with it:

- Same correction applied to README principle 5 and `citations.aiBody` in both languages, which had inherited the wording from here.

---

<a id="ai-content-2026-08-06-vocab"></a>

## 2026-08-06 — AI content is always labeled, and never publishes unless the automated gates pass

Evidence for the amendment that dropped the forbidden-vocabulary lint from the gate list. The marker and the standing instruction — the list is not widened — stay inline in `CLAUDE.md`. This is the measurement that forbids widening it, and the method for reproducing that measurement.

Measurement, taken 2026-08-06 against the committed corpus:

- It was dropped rather than widened, because widening it is not available: run over the 2,589 bills currently decoded in both languages it rejects 701 (27.1%) for correct, neutral legislative description — "block" on 279 (the CRA disapproval resolutions literally block a rule), "attack" on 50 (shark attacks in a fisheries bill, foreign AI-model-extraction attacks in `hr-8283-119`), "defend"/"stop" across the War Powers resolutions — and 358 of those fail in **one language only**, which would break EN/ES parity and red the whole nightly sync at `scripts/verify-sync.mjs`'s parity check.

Method — read this before quoting the numbers above, because a different field set gives different numbers:

- (Measured 2026-08-06 against the committed corpus with the real `lintForbidden` over `ai_headline` + `ai_summary` + the `what`/`who`/`why`/`cost` sections of `ai_sections`, in both languages; a bill counts as rejected when either language trips the lint. `ai_sections` also carries `tldr` and `costChips`, which were **not** in the measured set — including `tldr` gives 712 / 27.5% / 360 instead, so re-run it over exactly these four fields to reproduce these numbers.)

---

<a id="ai-content-2026-07-25"></a>

## 2026-07-25 — AI content is always labeled, and never publishes unless the automated gates pass

Evidence for the founding correction of this rule. The marker sentence that quotes the retired wording, and the Moments carve-out beside it, both stay inline in `CLAUDE.md` — they are the sentences `scripts/check-claim-truth.mjs`'s R3 allowlist counts, and they are counted there on purpose.

Inventory — what the correction had to go fix:

- Four user-facing strings and the MCP envelope had inherited the false claim; they now describe the gates.

# Constitution log

The forensic record behind `CLAUDE.md`'s hard rules: the measurements, the file-and-line tracing, and the inventories of what each amendment had to go fix. Newest first, append-only — an entry is never edited or deleted once written, because the point of it is what was true on the day it was written.

**What is NOT here, deliberately.** Every live rule, every dated `Amended YYYY-MM-DD:` marker sentence, and every instruction an agent must act on stays inline in `CLAUDE.md` — including the two that this repo has already broken once ("the list is not widened" and "nothing on this path writes `data/moments.json` and nothing publishes"). A link is only load-bearing if it gets followed, so nothing that changes what you should DO lives behind one. This file is where you check the arithmetic, not where you learn the rule.

Each `CLAUDE.md` amendment points here with `(evidence: docs/constitution-log.md#anchor)` at the spot its paragraph used to sit.

**Gate coverage:** this file is in `scripts/check-claim-truth.mjs`'s `SCAN_FILES`, added in the same change that created it. Moving text out of a scanned document into an unscanned one is how a gate quietly stops covering what it was written for; it was covered from its first line.

---

<a id="user-data-2026-09-25"></a>

## 2026-09-25 — No server-side user data, ever: the daily distinct-address count

The ruling that let one site-wide daily count of distinct network addresses exist, and the hardening the owner chose before it merged. `CLAUDE.md`'s rule is unchanged; this entry records why this structure was judged to sit inside it, and exactly what it can and cannot do.

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

- `privacy.p9`, new, in both languages: one number a day for the whole site, never split by page, of distinct network addresses that opened a page, bots included, counted from each address scrambled one way with a key that lasts only that day and is then deleted, with no address stored or recoverable. `privacy.p8` (the per-page-kind count) stays true word for word.
- The two strongest categorical lines were rewritten, per the owner's option: **`common.footer.mission`** (every page's footer, and also the site's meta description and JSON-LD description) now says nothing that identifies you is stored on our servers and that visitors are counted only as one site-wide number a day, in both languages. **`/llms.txt`**'s notes line ("No user data is collected server-side", read by machines that redistribute it, English-only by design) now says nothing that identifies a visitor is stored server-side and that visitors are counted only as one site-wide number a day.
- The digest's page-view caveat said "no unique/visitor count exists"; it now says the page-view counters carry no identity and the distinct-address line is separate. `lib/usage.ts`'s comment that a unique count was "a pending owner ruling", `proxy.ts`'s header, and the pinned digest issue's creation text in `.github/workflows/daily-metrics.yml` were corrected the same way, and name the sketch's own day salt.
- Checked and left unchanged: `privacy.p1`–`p5`, `p7`, `p8`; `embeds.docsPrivacyNoData` (embeds are never counted); `mcp.privacyRateLimit` (MCP is `/api`, never counted); the MCP envelope (it makes no visitor claim). These lines stay true on the ruling's reading that one site-wide daily number is not data "about you", and none was rewritten because the owner asked for two: `about.accountabilityBody` ("nothing about you kept on a server"), `terms.p5` ("store nothing about you on our servers"), `errorBoundary.eraseHelp` ("Nothing about you is stored anywhere else", said about what the Erase button can clear), and `/llms.txt`'s Pages entry for /privacy ("no server-side user data, ever", which is the constitution rule's own name, and the entry above records why the sketch sits inside that rule). The "no tracking" lines rest on the same reading, plus the fact that the sketch has no page dimension and nothing in it outlives its day's salt: `privacy.p4` ("No analytics trackers"), `common.trustLine2` ("no trackers"), `common.footer.funding` and `about.accountabilityBody` ("no tracking"), and `moments.updates.privacyNote` ("Nobody is watching you read this — no account, no tracking"). Rewording any of them is the owner's call.
- Not changed here: `CLAUDE.md`. Its "Architecture in one breath" sentence says `proxy.ts` does locale negotiation "and one more thing" (the page-view count); it now does two. That sentence belongs to the constitution change, which names `scripts/check-key-namespaces.mjs` as the list of aggregate counts.

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

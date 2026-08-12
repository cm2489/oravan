# Constitution log

The forensic record behind `CLAUDE.md`'s hard rules: the measurements, the file-and-line tracing, and the inventories of what each amendment had to go fix. Newest first, append-only — an entry is never edited or deleted once written, because the point of it is what was true on the day it was written.

**What is NOT here, deliberately.** Every live rule, every dated `Amended YYYY-MM-DD:` marker sentence, and every instruction an agent must act on stays inline in `CLAUDE.md` — including the two that this repo has already broken once ("the list is not widened" and "nothing on this path writes `data/moments.json` and nothing publishes"). A link is only load-bearing if it gets followed, so nothing that changes what you should DO lives behind one. This file is where you check the arithmetic, not where you learn the rule.

Each `CLAUDE.md` amendment points here with `(evidence: docs/constitution-log.md#anchor)` at the spot its paragraph used to sit.

**Gate coverage:** this file is in `scripts/check-claim-truth.mjs`'s `SCAN_FILES`, added in the same change that created it. Moving text out of a scanned document into an unscanned one is how a gate quietly stops covering what it was written for; it was covered from its first line.

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

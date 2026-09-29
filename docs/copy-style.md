# Copy style — how Oravan's own words are written

This page holds the style rules for the words Oravan writes itself: site copy in `messages/*.json`, and the AI-written headlines, summaries, sections, Big Question text and call scripts. It does not cover the record. When Oravan quotes Congress, the Senate, a clerk or a bill title, it copies the words exactly, capital letters included (page 1, rule 6; `docs/record-truth.md`).

---

## 1. "The president"

**Owner, 2026-09-29**, typed while reviewing artifact `7BuRDMkWu9zigDE1u2XPLJ`: *"It's 'the president' just FYI for all future copy (correct any other copy but first find the rules of how and when 'president' is capitalized"*. His example was the AI headline on `/bills/hconres-89-119`, "Resolution would direct president to halt military action against Iran". It now reads "…direct **the** president to halt…".

### The rule

**English.**

- Write "the president": lowercase, with the article. Don't use a bare "president" as a subject or object. So "direct the president to halt", not "direct president to halt", and "The president may…", not "President may…".
- Capitalize "President" in two cases only:
  - as a formal title directly before a name: "President Trump", "former President Truman";
  - as part of a proper name: "Presidential Medal of Freedom", "President's Park", "Executive Office of the President", "Presidents Day".
- The same rule covers "vice president": "the vice president's residence", but "Vice President Vance".
- Lowercase "the president of the United States", "the president pro tempore" and "the president of the Senate".
- "Presidential" and "presidency" are lowercase unless they are part of a proper name: "a presidential permit", but "Presidential Threat Protection Act".
- A word still takes a capital letter when it starts a sentence or a label: "The president's desk".
- No article is needed where English doesn't use one: "elections for president", "elected president", "serves as president".

**Spanish.** "Presidente", "presidenta", "vicepresidente" and "presidencial" are always lowercase, **even before a name**: "el presidente Trump", "el vicepresidente de Supervisión". The exceptions are the start of a sentence and a word inside an institution's name: "Oficina Ejecutiva del Presidente", "Medalla Presidencial de la Libertad", "Biblioteca Presidencial Theodore Roosevelt".

**The record is never restyled.** Words inside quotation marks stay exactly as the record wrote them: “Signed by President.” stays “Signed by President.” A bill's official title stays as written, and so does any part of it that our text copies word for word. The official record fields are never touched either: `title`, `last_action_text`, the Senate's nomination text, and the clerks' roll calls. These rules apply to the government's words only when we quote them. Our own voice follows this page.

### Where the rule comes from

Researched 2026-09-29. Excerpts are verbatim and kept short. **Where a source could not be opened directly, the list says so.**

- **AP Stylebook: lowercase, capitalize only before a name.**
  - AP's own account: "Capitalize president only as a formal title before names … Lowercase in all other uses." (<https://x.com/APStylebook/status/796784912934326273>). On vice president: "Capitalize the titles president and vice president before names; lowercase in other uses." (<https://x.com/APStylebook/status/1311023883793952769>).
  - *Not opened directly.* The Stylebook entry is paywalled, and x.com refused the automated fetch (HTTP 402). Both lines are quoted as the search index shows those two posts.
  - Read directly: a secondary summary of the entry gives the same rule, "capitalize president only as a formal title that is before one or more names", and adds "Presidential should be lowercase unless a part of a proper name" (<https://writingexplained.org/ap-style/ap-style-president>).
- **Chicago Manual of Style: lowercase.**
  - Chicago's own Q&A, read directly: "titles are commonly lowercase (president of the United States)", and "how fair would it be to lowercase the president and uppercase the librarian?" (<https://www.chicagomanualofstyle.org/qanda/data/faq/topics/Capitalization/faq0003.html>).
  - *Not opened directly:* the manual's paragraph on titles (CMOS 8.21, "titles used in apposition"), which is paywalled.
- **GPO Style Manual (2016), for federal government publications: "the President" is capitalized.** Read directly from the GPO's PDF of chapter 3 (<https://www.govinfo.gov/content/pkg/GPO-STYLEMANUAL-2016/pdf/GPO-STYLEMANUAL-2016-5.pdf>).
  - §3.36: titles "immediately preceding a name are capitalized" ("President Obama").
  - §3.37: a title "used alone as a substitute for it is capitalized", with examples "the President; the President-elect" and "similarly the Vice President".
  - This is why the record says "the President". It is the government's house style, not ours, and we quote it as written.
- **RAE: lowercase, even before a name.** "No, los cargos se escriben con minúscula inicial: el presidente García" (<https://www.rae.es/duda-linguistica/los-cargos-se-escriben-con-mayuscula>).
  - Read through the Internet Archive's copy of 2024-05-08 (<http://web.archive.org/web/20240508182956/https://www.rae.es/duda-linguistica/los-cargos-se-escriben-con-mayuscula>). The live page refused the automated fetch (HTTP 403).
- **FundéuRAE: lowercase whether or not a name follows.**
  - FundéuRAE's own account: cargos "se escriben en minúscula, vayan acompañados del nombre propio o no" (<https://x.com/Fundeu/status/1640649698292760576>). *Not opened directly:* x.com refused the fetch, and fundeu.es could not be fetched by the tool. This is quoted as the search index shows the post.
  - Read directly: FundéuRAE's recommendation as reprinted by Infobae. It says the lowercase applies "en cualquier circunstancia, se trate de la referencia a una persona concreta o no", and it corrects "la Vicepresidenta Kamala Harris" to "la vicepresidenta Kamala Harris" (<https://www.infobae.com/america/agencias/2024/11/06/fundeurae-los-cargos-con-minuscula-inicial/>).

**So:** Oravan writes like AP and Chicago in English, and like the RAE and FundéuRAE in Spanish. The owner's "the president" adds one thing on top: the article, even where AP headline style would drop it. The GPO rule explains why the record capitalizes, and the record keeps its capitals when we quote it.

### How it is held

- **One normalizer:** `lib/president-style.mjs`, which is deterministic, has no model and makes no network call.
  - It skips quoted text and titles copied word for word.
  - It reports anything it can't decide from the words around it instead of guessing. On 2026-09-29 that was "Manhattan Borough President" (H.R. 5309, a local title that may be part of a name).
- **Every pipeline that writes public text runs it on what the model returns**, and each prompt carries the rule as `PRESIDENT_STYLE_RULE`:
  - the decode (`scripts/bill-decode.mjs` `assembleDecode`, which both the batched and the synchronous transports use);
  - moment updates and "where it stands" summaries (`scripts/moment-updates.mjs`);
  - the Big Question first draft (`scripts/moment-draft.mjs`);
  - bill and nomination call scripts (`finishScript` in `lib/scriptprompt.ts`, which both `app/api/script` and nightly pregen call);
  - the one-off backfills.
  - The decode's first call (the summary) doesn't get the rule in its prompt, on purpose. That prompt is fingerprinted (`decode_text_sha`), and one extra line would turn off the unchanged-document veto for the whole corpus and pay for re-decodes. Its summary is normalized after the fact, which is free.
- **The committed corpus:** `node scripts/president-style.mjs --audit` prints every change it would make and every case it skipped, and `--check` exits 1 if anything would change. The one-off sweep of 2026-09-29 used `--write`.
- **Site copy:** `tests/president-style.unit.spec.ts` fails when a string in `messages/en.json` or `messages/es.json` would change under the normalizer. `node scripts/president-style.mjs --messages --write` fixes it and keeps the files' formatting. A label that starts with the bare office ("President pro tempore") is left to the editor and never fails.
- **Not a publish gate, on purpose.** A capital letter is not damage to the corpus.
  - `scripts/verify-sync.mjs` refuses a nightly commit only for integrity failures (page 1, rule 11).
  - A hard CI check on `data/` would turn main red for every open PR over a style slip. It would also block a Big Question the owner approved, because `scripts/moment-approve.mjs` publishes the approved text byte for byte and can't fix it.
  - So the rule is held by fixing the text where it is written, not by refusing it.

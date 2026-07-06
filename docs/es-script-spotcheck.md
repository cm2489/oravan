# ES call-script spot-check — template-level review material (S6)

**What this is:** the exact Spanish-lane prompt material `app/api/script/route.ts`
sends per stance, assembled **statically** for Colby's U7-interim spot-check.
No live generation was run to produce this file — per the S6 constraint, zero
Anthropic API calls were made; cost decisions are the owner's.

**What this is not:** a review of live model *outputs*. The route's cache is
in-memory per instance and nothing is persisted, so **no cached ES script
outputs exist anywhere in the repo or its test fixtures** (verified — the only
committed ES script-shaped text is the walkthrough demo snippet, quoted in §4
and labeled as such). **The live-output spot-check happens post-merge**, on
production or a preview deploy, and gets logged per the S6 "spot-check logged"
done-criterion.

Demo bill used to instantiate the template: **H.R. 1787** (Roberto Clemente
Commemorative Coin Act) — the same deliberately innocuous bill the walkthrough
uses. The `Plain-language summary` block below is its real `ai_summary` from
`data/bills.json`; every other byte comes from the route's template literal.

---

## 1. How the ES lane is conditioned (system-prompt fragments)

There is **no system prompt**: the route sends a single user message built from
one template. The ES lane differs from EN in exactly one fragment, the
language line:

> Write the script in natural, warm Latin American Spanish (tú form). Use the placeholders [TU NOMBRE] and [TU CIUDAD O CÓDIGO POSTAL].

(EN equivalent, for contrast: *"Write the script in plain, warm English at an
8th-grade reading level. Use the placeholders [YOUR NAME] and [YOUR TOWN OR
ZIP]."*)

One rule interacts with Spanish specifically — the citation freeze, which keeps
"H.R. 1787" from being translated to "Ley H.R. 1787" or similar:

> Refer to the bill exactly as "H.R. 1787" - do not alter, translate, or extend that citation.

Everything else (stance lines, structure, nonpartisan rules) is **byte-identical
across locales** — the 3-stance × 2-locale matrix is symmetric by construction.

## 2. Exact ES prompt per stance lane

### 2.1 Support — `{ stance: "support", locale: "es" }`

```
Write a 30-second phone script for a constituent calling a member of Congress about this bill.

Bill: H.R. 1787 — Roberto Clemente Commemorative Coin Act
Plain-language summary: This bill directs the U.S. Treasury to create three types of commemorative coins in 2027 honoring baseball legend and humanitarian Roberto Clemente: a $5 gold coin (up to 50,000 made), a $1 silver coin (up to 400,000 made), and a half-dollar coin (up to 750,000 made), all bearing Clemente's image and inscribed with the year 2027. The coins will be sold to the public — including through prepaid and bulk orders — at a price that covers the cost of making them plus an added surcharge ($35 for the gold coin, $10 for the silver, and $5 for the half-dollar). Those surcharges, after the government fully recoups its production costs, will be paid to the Roberto Clemente Foundation to support its work in education, youth sports, disaster relief, and historic preservation. The program is designed to cost taxpayers nothing, and the Foundation will be subject to financial audits on the money it receives.
Current status: committee

The caller SUPPORTS this bill and urges the member to vote for it.

Write the script in natural, warm Latin American Spanish (tú form). Use the placeholders [TU NOMBRE] and [TU CIUDAD O CÓDIGO POSTAL].

Rules:
- 60-90 words. It must be comfortably readable aloud in 30 seconds.
- Structure: greeting + name placeholder + constituent location placeholder, the bill by its number, the position, ONE concrete reason grounded in the summary, a clear ask, thanks.
- Refer to the bill exactly as "H.R. 1787" - do not alter, translate, or extend that citation.
- Works equally well read to a live staffer or left as a voicemail.
- Strictly nonpartisan tone: no party language, no attacks, no alarmism, no advocacy-group jargon.
- Do not invent facts beyond the summary provided.
- Plain text only: no markdown, no asterisks, no bullet points, no headers.
- Output ONLY the script text, no commentary.
```

### 2.2 Oppose — `{ stance: "oppose", locale: "es" }`

Identical to §2.1 except the stance line:

```
The caller OPPOSES this bill and urges the member to vote against it.
```

### 2.3 Concerned ("Me preocupa") — `{ stance: "undecided", locale: "es" }`

Identical to §2.1 except the stance line:

```
The caller is CONCERNED about this bill and has not settled on support or opposition. The script must register that concern, name the ONE thing that worries them (grounded in the summary), and ask that their concern be noted for the member along with where the member stands - phrased as something for the office to record, never as live questions to the staffer. The staffer only tallies positions; the script must not expect answers or a conversation.
```

This is the lane to weight in the live spot-check: it's the most instruction-
dense, and it must come out in Spanish as a *statement to be recorded*, never
as questions to the staffer — that's the "no debate, no quiz" promise
(`bill.concernNote`) holding in the second language.

## 3. Spot-check rubric (for the post-merge live pass)

Per generated ES script, pass/fail on:

1. **Register** — natural Latin American Spanish, tú form toward the reader;
   usted/formal toward the office is fine inside the quoted call text. No
   machine stiffness, matches the warmth of `messages/es.json`.
2. **Anglicisms** — no "aplicar", "soportar" (for support), "ZIP" bare;
   "código postal" is the house style.
3. **Placeholders** — exactly `[TU NOMBRE]` and `[TU CIUDAD O CÓDIGO POSTAL]`,
   untranslated brackets intact.
4. **Citation** — "H.R. 1787" appears verbatim, never "Ley H.R. 1787",
   "PL 1787", or a translated citation.
5. **Stance structure** — support/oppose ask for a vote; concerned registers
   one worry grounded in the summary and asks that it be noted, with no
   questions posed to the staffer.
6. **Nonpartisan** — no party names, no advocacy vocabulary, no alarmism,
   in Spanish just as in English.
7. **Voicemail-safe** — reads correctly as a message left after hours.

Log the result (date, bills sampled, per-lane pass/fail, failures verbatim) —
S6's done-criterion is "spot-check logged", and §5 of the build/GTM doc
requires this surface to count against the cumulative pre-hire ES-review tally.

## 4. Committed ES script-shaped text (for completeness)

The only ES script text checked into the repo is the walkthrough demo snippet
(`messages/es.json`, `walkthrough.phone.scriptSnippet`) — **hand-written demo
copy, not a generation output**, updated in this PR to match the live
placeholder convention:

> Hola, me llamo [TU NOMBRE] y soy constituyente de [TU CIUDAD O CÓDIGO POSTAL]. Llamo sobre la H.R. 1787, la Ley de la Moneda Conmemorativa de Roberto Clemente…

## 5. Out of scope, on purpose

The §5 "Spanish Callers" surfaces — the Option A hybrid (English phonetic
preamble + Spanish body) and Option B full-Spanish voicemail variants, the
capability-caveat label, and voicemail-as-recommended-path framing — are a
**later, separately-gated build** (ES-review bandwidth gate, build/GTM doc §5).
S6 is the parity last mile only; nothing in this PR implements or preempts
those variants.

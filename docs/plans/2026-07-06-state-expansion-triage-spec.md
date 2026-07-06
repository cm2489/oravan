---
date: 2026-07-06
topic: state-expansion-triage-architecture-spec
focus: Data-architecture shape for the committed-but-parked TX/CA state-bill-tracking build (Sprint S25) — spec-only, no state-bill data ships
provenance: Sprint S25 per docs/ideation/2026-07-05-build-gtm-strategy.md §1.2/§1.3 + STATUS.md sprint tracker. Grounded in a full read of the existing federal pipeline (scripts/sync-bills.mjs, .github/workflows/sync-bills.yml, scripts/verify-sync.mjs, lib/freshness.ts, lib/urgency.mjs, lib/taxonomy.ts, scripts/vacancy_diff.py) so this spec reuses the repo's shapes rather than inventing parallel ones. Data-source comparison is a fresh verification pass (dated inline), not a re-assertion of the strategy doc's own unconfirmed figures.
status: spec-only — no product code ships in this sprint; the state BUILD itself stays parked behind the triggers in §4
---

# State Expansion — Curated-Triage Architecture Spec (S25)

## 0. What this is, and isn't

**What this is:** the data-architecture shape that whoever executes the committed Nov–Dec 2026 TX/CA state-bill-tracking build should start from, written now (per §1.3's S25 slot) so that build doesn't begin from a blank page. It specs the triage-queue pattern, compares the three candidate legislative-data sources the strategy doc left as an open `[FILL]` (§1.2), designs how state bills join the nightly pipeline under KTD-10's inherited conventions, and restates — without resolving — the two triggers that still gate whether the Nov build slot ever locks.

**What this explicitly is not:**

- Not the state build itself. No `data/state-bills-*.json`, no new workflow file, no new route, no new UI ships in this sprint. `git diff` against `main` for this PR should show one file in `docs/plans/` and one line in `STATUS.md`.
- Not a resolution of either open trigger in §1.2 (demand evidence; Feb-2027-gate scope). Both are restated verbatim in §4 and explicitly left open.
- Not a vendor decision. §2's comparison table ends in a recommendation row and a loud "Colby decides" marker, not a chosen API.
- Not a re-litigation of *why* TX/CA (§1.2 already settled that) or *why triage-not-decode* (settled in the strategy's Build section and restated, not re-argued, in §1.3). This spec takes both as given and designs underneath them.
- Not an estimate of engineering hours or a sprint breakdown for the eventual build — that's the future build's own plan document, informed by this spec, not this document.

**Non-goals for the eventual build too** (worth stating now so the build doesn't drift into them later): no editorial bill selection (§1.2), no decode-before-review-before-callable shortcut (§1.4), no new account/login surface for reviewers (out of scope per the strategy's parked org-accounts question, §3 of the strategy doc), no New York work (explicitly deferred per §1.2's own ruling).

---

## 1. Triage-queue architecture

### 1.1 Two gates, not one — don't collapse them

The state build needs two structurally different gates, and the single biggest design risk in under-specifying this now is collapsing them into one:

| Gate | Question it answers | What it protects | Analogous existing mechanism |
|---|---|---|---|
| **A. Mechanical curation** | Which bills enter the review queue at all? | Nonpartisan-by-construction — curation must never read as "we picked the bills we wanted people calling about" | `lib/urgency.mjs`'s ordinal status table (`STATUS_BASE`) + `mapStatus()`'s text-matching in `scripts/sync-bills.mjs` — already a mechanical, action-text-driven classifier, not an editorial one |
| **B. Review-before-callable** | Once curated (and decoded), when does the call-CTA activate? | The constitution's "AI content is always labeled and human-reviewed before it drives a call" rule | The federal pipeline's decode-before-publish gate (§1.4 below) — but state needs a *third* state the federal model doesn't have |

Gate A is a **volume/relevance** filter: legislatures move thousands of bills a session (TX alone: several thousand filed per biennial session; CA: roughly 2,000+ per two-year session) and Rostra cannot, and should not, decode and review all of them. Gate A's job is to mechanically narrow "everything filed" down to "things actually moving" — using the same class of objective signal the federal pipeline already keys its own urgency scoring on: has the bill had **committee action** (referred, heard, marked up, reported), a **scheduled hearing** (calendared, even before it happens — new territory for Rostra; the federal pipeline is reactive-only, scoring only actions already taken), or a **floor vote** (scheduled or held). None of these are editorial judgments about which bills matter to whom; they're the same kind of legislative-process fact `mapStatus()` already text-matches out of Congress.gov's `latestAction.text` today, extended to state legislative data and pulled forward to include *scheduled*, not just *completed*, hearings.

Gate B is a **content-safety** gate, unconditional on Gate A: even a mechanically-curated, decoded bill's call-CTA stays inactive until a human has reviewed the EN and ES text specifically for the call flow. This is not new policy — it's the existing "AI content is always labeled and human-reviewed" hard rule, applied to a new content type.

### 1.2 Mechanical curation gate — design sketch

Reuse, don't reinvent, the ordinal-status shape:

```
STATE_STATUS_BASE-equivalent buckets (per bill, per state):
  introduced          → not yet triage-worthy
  committee_referred  → not yet triage-worthy (mere filing/referral is not "action")
  committee_hearing_scheduled → triage-worthy (NEW: forward-looking; federal has no analog)
  committee_action    → triage-worthy (markup, reported out, amended in committee)
  floor_vote_scheduled → triage-worthy
  floor_vote_held     → triage-worthy
  passed_chamber / conference / signed / vetoed → triage-worthy, same terminal-status
    caveat as lib/taxonomy.ts's TERMINAL_STATUSES (signed/vetoed bills are past
    the call window)
```

A bill enters the triage queue the moment it crosses from "introduced/referred" into any of the triage-worthy buckets — a binary gate, not a continuous score, because the triage queue's job is "does this deserve human attention at all," not "how urgently" (urgency banding, once a bill is in Rostra's public corpus, can reuse `lib/taxonomy.ts`'s existing banding machinery unchanged). The *scheduled*-hearing bucket is the one genuinely new mechanism: it requires a data source that publishes forward-looking committee calendars, not just retrospective action logs — a requirement that materially shapes §2's comparison (Open States/Plural's `events` object is the only candidate that exposes this as a first-class type; see §2.2).

### 1.3 One-state-first rollout: Texas

> "Texas's 90th Legislature convenes **Jan 12, 2027** — its only regular session before 2029 — which is the scarcity argument for prioritizing TX. CA's 2027-28 session and NY's both convene early January too, but NY is explicitly deferred here per the current ruling." — strategy §1.2

Because TX meets biennially and CA meets annually, missing TX's Jan 12, 2027 window costs two full years of TX legislative activity to track; missing an early CA window costs one year. The triage queue and pipeline (§3) should therefore be built TX-first and CA-second-or-not-at-all, not built simultaneously for both — a sequencing point the eventual build's own plan should make explicit, not this spec (which only needs to note that whichever data source is chosen in §2 must cover TX at full depth on day one; CA depth matters only if the Phase E collision rule, §4, resolves toward the full build).

### 1.4 Review-before-callable, never decode-before-callable

The federal pipeline's gate is **decode-before-publish**: a bill enters `data/bills.json` at all only once its EN+ES summary exists (`scripts/sync-bills.mjs`'s `added < MAX_NEW_DECODES` branch). That single gate is sufficient today because Rostra treats "in the corpus" and "callable" as the same moment for federal bills, and because the interim review process (Colby's own spot-check, per U7/U13's substitute) runs informally against that same MAX_NEW_DECODES-capped nightly trickle.

State expansion needs a **third queue state**, because "decoded" and "reviewed" cannot be collapsed the way they informally are today once the volume triples-to-quintuples (§3.3):

```
curated  →  decoded  →  reviewed (call-CTA live)
   ↑            ↑              ↑
 Gate A     EN+ES exist    Gate B: human
 (§1.2)     (cheap, AI)    sign-off, per bill,
                           per language
```

A bill can sit in `curated` or `decoded` state indefinitely without becoming callable — that's a feature, not a backlog problem, because it's the only way "human-reviewed before it drives a call" survives contact with a review bottleneck that can't scale as fast as AI decode capacity.

**This spec explicitly rejects the "decode the full corpus, it's only $2–3k" framing** (named directly in strategy §1.2 as a rejected framing, restated here per the S25 brief). The reason is categorical, not arithmetic: that framing answers "can we afford to decode everything," which was never the constraint. The constraint is reviewer-hours, and bulk-decoding does nothing to relieve it — it would just pile a larger stack of decoded-but-unreviewed content behind Gate B, exactly the shape of the constitutional violation the human-review rule exists to prevent (AI-generated call-driving text reaching a citizen before a human has looked at it). Treating this as a cost-optimization question and treating it as a human-review-rule question lead to opposite designs: the former says "decode more, it's cheap"; the latter says "decode only as fast as review capacity can clear it," which is what Gate A (curation) and the ES-reviewer precondition (§3.3) are actually for. The mechanical curation gate's real job, stated plainly: **it exists to keep the decoded-but-unreviewed backlog inside what a human reviewer can actually clear**, not to save AI spend.

---

## 2. Data source comparison

The strategy doc left this open explicitly: *"the state-legislature bill-tracking data source itself — LegiScan, Open States/Plural API terms, or direct state APIs — is not established in any source material available to this drafter and needs a separate decision before S25's spec can be executed"* (§1.2). This section is that research pass — decision-ready, not decided.

### 2.1 Candidates and method

Three candidates, per the brief: LegiScan, Open States/Plural, and direct TX/CA state APIs. Verified via live web search/fetch on **2026-07-06** (dates noted per finding; several LegiScan pages return HTTP 403 to automated fetches — noted per row, and treated the same way the strategy doc's own §4.1 research already flagged LegiScan's per-state pricing as "could not be confirmed this pass — treat as approximate"; this pass hit the identical wall and doesn't pretend otherwise).

### 2.2 Comparison table

| Dimension | LegiScan | Open States / Plural | Direct TX + CA APIs |
|---|---|---|---|
| **Free-tier query limit** | "Public" pull tier: **30,000 queries/month**, confirmed via multiple independent sources describing legiscan.com/legiscan and legiscan.com/pricing/api (2026-07-06). Paid "Pull" tier: 100,000–250,000 queries/month. Enterprise "Push" tier (paid): full DB replication, refreshed every 4h standard or 15min optional. | Free **bulk data downloads** (no query cap — full per-state dumps) plus a keyed API v3; no confirmed current numeric rate limit — a 2021-era GitHub tiering discussion lists figures that read as stale, and the live interactive docs (v3.openstates.org/docs) don't publish a limit on the page itself. Needs a fresh developer-account check before the build commits to it. | No query limit in the conventional sense — no JSON API exists for either state (see "Bill-event granularity" row); access is via FTP bulk-file mirrors and public HTML pages. |
| **Licensing / attribution** | Access requires an account, "subject to LegiScan Terms of Service" (legiscan.com/terms-of-service). Specific attribution-clause language could not be confirmed this pass — LegiScan's own comparison/pricing/terms pages return HTTP 403 to automated fetch tools; this mirrors the strategy doc's own unresolved caveat at §4.1 ("per-state price points... could not be confirmed this pass"). **Needs a human account-holder to read the ToS directly**, not a re-assertion from secondary sources. | Public-domain-style dedication; per Plural's own "Open States is Now Plural" post (2023): "our open data: we provide bulk data and public data APIs for legislation, hearings, committees and elected officials," attribution "greatly appreciated" but not legally required. **Currency risk, flagged loudly:** this commitment is a **2023** statement, made before SAI360's **Dec 1, 2025** acquisition of Plural Policy (confirmed via SAI360's own press release). No 2026 restatement of free-tier/open-data continuity post-acquisition was found this pass — treat the free tier's survival as **unconfirmed**, not assumed, exactly the same honesty standard the strategy doc applies to its own 2024-vintage chatbot-error-rate citation (§1 of the strategy doc). | TX: public via Texas Legislature Online (capitol.texas.gov) and an FTP mirror (ftp://ftp.legis.state.tx.us) — Texas Legislative Council-published, no confirmed restrictive license found. CA: explicitly public domain by statute — Gov. Code §10248.5: "the information made available on the California Legislative Information website is within the public domain and the State of California retains no copyright or other proprietary interest." Cleanest licensing posture of the three, unsurprisingly, since it's the primary source. |
| **TX + CA coverage quality** | Full depth expected — LegiScan's core product is all-50-states-plus-Congress; TX and CA both have live dashboards (legiscan.com/TX, legiscan.com/CA) and weekly downloadable session datasets. No coverage gap anticipated, but not independently spot-checked against a live TX/CA bill this pass. | Confirmed as one of the org's core all-50-state products historically (the strategy doc's own §4.1 research already independently verified Plural/Open States' "free tier intact: search, tracking, legislator lookup, open API/bulk downloads" as of this document's writing). Per-state scraper *health* is the open question — Open States' own contributor docs acknowledge scrapers "do break" when a state site changes, with no state-by-state current-health page found this pass. **Needs a direct spot-check against a live TX and CA bill from an account before committing**, not assumed from the org's overall reputation. | By construction, 100% authoritative and complete for its own state — there is no "coverage gap" possible against the primary source. |
| **Bill-event granularity (committee / hearing / floor signals)** | `getBill` returns sponsors, committee references, full action history text, and roll-call/vote detail (confirmed via the LegiScan API User Manual's documented method list). Action history is **text**, the same shape as Congress.gov's `latestAction.text` that `mapStatus()` already parses — no evidence of a dedicated **forward-looking scheduled-hearing** object distinct from history text. This is a real gap against §1.2's "scheduled hearings" gate criterion specifically (retrospective committee action is well covered; anticipatory hearing calendars are not confirmed as a distinct queryable type). | The only candidate with an **explicit, first-class `events` object** in its v3 schema, documented as covering "hearings, legislative proceedings" alongside separate `committees` and `bills` (with votes/sponsorships/actions) objects. This is the best structural match to all three of §1.2's gate criteria (committee action, scheduled hearings, floor votes) as *distinct* queryable types rather than one undifferentiated action-text stream. | TX: committee hearing schedules exist as **HTML pages** (`Committees/MeetingsByDate.aspx`) and an email/RSS alert subscription system for committee notices — no structured feed a script can safely parse without its own scraper-breakage risk. CA: committee hearing schedules are published as **PDF "Daily File" documents**; bill history (including committee/floor actions) is queryable via the LegInfo site and an older MySQL bulk-data mirror, but again no modern JSON API. Both states would require Rostra to build and maintain its own scraper — the same "data-plumbing" labor the strategy's own §4.1 competitive analysis argues against Rostra taking on ("Rostra doesn't rebuild the scraping/data-plumbing moat... it depends on it and differentiates on explanation, action, and trust"). |
| **Update latency** | Pull API: "guideline reflecting the minimum time resolution that could include changes"; in practice daily updates are typical for Pull-tier use. Weekly full-session bulk snapshots generated Sunday mornings. Push tier (paid): 15min–4h. | Scraper-based, per state, "as-needed"/session-cadence per Open States' own docs — no fixed SLA. A silently-broken state scraper is a real, acknowledged failure mode (their own contributor docs describe this), which is the same "silent staleness" class this repo already builds dead-man's-switch verifiers against (`scripts/verify-sync.mjs`) — meaning **whichever source is chosen, Rostra still needs its own freshness watchdog on top**, per §3.2. | TX/CA sites update on their own legislative-office cadence (same-day-to-next-day for official actions, per the general pattern already observed for the federal `unitedstates/congress-legislators` repo in strategy §1.2's roster-churn research) — but only as fast as Rostra's own scraper polls it, since no push/webhook mechanism exists for either. |
| **$ cost** | **🔴 Cost, not confirmed.** Free 30k/mo Public tier may suffice depending on query design (batching via `getMasterList` change-hashes, per the API manual's documented workflow, rather than polling every bill individually) — plausible to stay inside the free cap for a TX+CA-only triage feed, but not proven without a build-time query-volume estimate. If it doesn't, the strategy's own §4.1 research already flagged "~$25/state, ~$1,000/yr national" as **unconfirmed, approximate** — this pass could not confirm those figures either (LegiScan's pricing PDFs return 403 to automated fetch). **Any real subscription cost must be confirmed from a live LegiScan account/PDF before it's budgeted anywhere**, not carried forward as an estimate a second time. | **🔴 Cost, not confirmed, plus a continuity risk that is itself a $ risk.** No listed dollar figure was found for the non-commercial tier Rostra would need, but if SAI360's Dec 2025 acquisition has repriced or will reprice access for any commercial-adjacent use (a nonpartisan-but-institutionally-funded civic tool could plausibly be read either way by a new owner), the "free" assumption could evaporate without notice. **This needs a direct, dated confirmation from Plural/Open States before it's assumed free in any build estimate.** | **$0 direct cost** (public data, no vendor). The real cost is engineering hours: building and maintaining two state-specific scrapers (HTML calendar pages + PDF Daily Files for CA; HTML meeting pages + FTP bill-text mirror for TX), each of which can silently break the way any scraper can. Under the solo-builder constraint, hours are the actual scarce resource this option spends, not dollars. |

### 2.3 Recommendation — and the "Colby decides" marker

**🔵 Colby decides. This is a recommendation row, not a decision.** Every option above carries either a confirmed-unconfirmed dollar cost or a confirmed-unconfirmed continuity risk; none of the three is a clean, zero-risk pick.

Directionally, on the evidence gathered this pass:

- **Open States/Plural is the best structural fit** for the triage gate specifically — it's the only candidate with hearings/committees/events as distinct, queryable object types rather than undifferentiated action text, which maps directly onto §1.2's three gate criteria without Rostra having to re-derive "scheduled hearing" from freeform text the way `mapStatus()` already has to for floor/committee status today. Its licensing posture (public-domain-style, attribution encouraged not required) is also the cleanest of the three non-primary-source options.
- **But its free-tier continuity through the Dec 2025 SAI360 acquisition is genuinely unconfirmed**, not merely under-researched — the only continuity commitment found is a pre-acquisition 2023 post. Before this source is chosen, whoever executes the build should get a **direct, dated statement from Plural/Open States (a support ticket, a current ToS page, or a live account) confirming free-tier access still exists for a civic nonprofit use case in 2026**, not proceed on this spec's 2023-vintage citation.
- **LegiScan is the safer bet on coverage breadth and reliability** (an established, all-50-state commercial product with weekly bulk snapshots and a documented API manual) but its bill-event granularity is weaker for the "scheduled hearing" gate specifically (text-based history, no confirmed dedicated hearing-calendar object), and its real dollar cost above the free 30k-query cap is unconfirmed by two independent research passes now (this one and the strategy doc's own §4.1).
- **Direct TX/CA APIs are not a serious primary-source candidate** — no structured API exists for either state's bill data, and building/maintaining two scrapers repeats exactly the data-plumbing labor cost the strategy's own competitive analysis argues Rostra shouldn't take on. They remain useful as an **authoritative cross-check for boundary data specifically** (§3.4), not for bill-tracking.

**Action for whoever executes the build, not this spec:** get a live-account confirmation of (a) Open States/Plural's actual 2026 rate limits and cost for this use case, and (b) LegiScan's actual per-state/national pricing PDF, before the Nov build slot's estimate is finalized. Budget the possibility that the honest answer costs real money either way — this is a **$ decision, surfaced here loudly, per the standing house rule that every dollar commitment gets flagged before it's committed to**, not decided by this document.

---

## 3. Pipeline design

### 3.1 Nightly rhythm — KTD-10 compliance

> "Any new committing workflow copies the exact author-identity + rebase-retry + SHA-verify block from `.github/workflows/sync-bills.yml`, joins the `data-sync` concurrency group, and keeps its file set disjoint (the rebase-retry safety proof). Every pipeline-adjacent unit ships its own loud-failure verifier in the same unit." — KTD-10, `docs/plans/2026-07-03-001-feat-rostra-launch-buildout-plan.md`

A state-bill sync is a new committing workflow, full stop — it writes new data files nightly and needs Vercel to redeploy off them, exactly the shape `sync-bills.yml` already solves. It inherits every part of that block unchanged:

- **Author identity + push retry:** the same `rostra-sync` / linked-account commit identity (`docs/solutions/vercel-bot-push-blocked-deploys.md` — an unlinked commit author gets its deploy silently BLOCKED by Vercel, proven 2026-07-02), the same rebase-onto-`origin/main`-and-retry loop on push rejection.
- **`data-sync` concurrency group:** joins the same group as `sync-bills.yml` and `refresh-legislators.yml` — serialized against them, not parallel, so no two nightly jobs can race a push against the same `main` HEAD.
- **Disjoint file set:** new files only — e.g. `data/state-bills-tx.json` + `data/state-bills-tx-es.json` + `data/sync-state-tx.json` (and the CA-shaped equivalents, if the Phase E branch reaches CA). Never touches `data/bills.json`, `data/bills-es.json`, or `data/sync-state.json` — this is what makes the rebase-retry safety proof hold (KTD-10's stated reason the file sets must stay disjoint).
- **Own loud-failure verifier, same unit:** a `verify-state-sync.mjs` (or per-state variants) mirroring `scripts/verify-sync.mjs`'s shape exactly — parses, checks EN/ES parity (now against the three-state queue model in §1.4, not just "decoded or not"), checks the corpus/queue didn't shrink beyond a documented threshold (mirroring both `verify-sync.mjs`'s 2%-bill-count-drop check and `vacancy_diff.py`'s two-channel anomalous-shrink pattern — small changes surface loudly-but-non-blocking, large ones fail the run before commit), and checks the state-specific `lastRun` actually advanced tonight.
- **+1 PR tax, already budgeted:** per the plan's own §9.1(f) note 4, "this new/modified committing workflow inherits the standard pipeline tax... budget the standard +1 PR, consistent with how electoral, nominations, and state-expansion each carry the same increment." Whoever sizes the eventual build should treat this as already spent, not a surprise found mid-build.

**Design recommendation (not a decision this spec needs to make):** ship TX and CA as **separate workflow files** (`sync-state-bills-tx.yml`, `sync-state-bills-ca.yml`), not one parameterized workflow. Reasons: (1) it keeps "own loud-failure verifier" failure isolation clean — a TX scraper/API failure can't be masked by a healthy CA run in the same job; (2) it makes the Phase E collision rule's TX-only-first branch (§4) a clean file deletion if CA never ships, rather than an `if` branch left inert inside a shared workflow; (3) it matches the existing pattern of `sync-bills.yml` and `refresh-legislators.yml` already being separate files joined only by the concurrency group, not a single combined job.

### 3.2 Freshness — per-corpus extension, never a shared stamp

> "a fresh federal stamp must never mask a stale state corpus" (per the plan's named silent-wrongness class — `docs/plans/2026-07-03-001-feat-rostra-launch-buildout-plan.md`'s own phrase, used there for mid-decade redistricting: "U3's vintage pin + integrity CI turns silent wrongness into loud failure").

Today's `lib/freshness.ts` is a single flat accessor: `getFreshness()` reads one `data/sync-state.json` and returns one `{checkedAt, completeThrough, newestAction}` triple, consumed by every surface's "Data as of {date}" stamp. This works precisely because there is currently only one corpus. The moment a second (TX) or third (CA) corpus exists, that single-accessor shape becomes actively dangerous if left unchanged: a TX bill page or TX MCP tool response that silently reads the *federal* `getFreshness()` would show a fresh federal timestamp on stale-or-broken TX data — exactly the "claims false freshness" failure KTD-1 already named and fixed once for the federal case, now reintroduced one layer up unless the accessor itself becomes corpus-aware.

**Design requirement for the eventual build:** `getFreshness()` must take an explicit corpus key (e.g. `getFreshness('federal' | 'tx' | 'ca')`), backed by its own `data/sync-state-{corpus}.json`. No surface may call a bare, corpus-less `getFreshness()` once a state corpus exists — every TX-scoped page, MCP response, or embed must pass `'tx'` explicitly, so a stale or dead TX sync can never inherit the federal `checkedAt` by omission. This is a direct extension of KTD-1's existing three-timestamp design, not a new pattern — it just stops being safe to leave un-parameterized.

### 3.3 ES decode volume math — the reviewer precondition is blocking, not a checklist item

> "state bills run 3-5× current review volume." — strategy §1.2

The arithmetic, stated plainly so the "$2-3k decode the corpus" framing (§1.4) can't quietly re-enter through a volume argument instead of a cost one: the federal pipeline's decode step already runs at up to `MAX_NEW_DECODES` (40) new bills/night, each requiring an EN+ES pair, reviewed today only informally via Colby's own interim spot-check (the same substitute already standing in for the ES-reviewer hire per U7/U13, S6, and S23). Two additional legislatures' worth of mechanically-curated bills — even *after* Gate A trims TX's and CA's much larger raw filing volume down to only committee/hearing/floor-active bills — stack on top of that existing review load at the strategy's stated 3–5× multiplier. Critically, **this load lands entirely on the review step, not the decode step**: decode is cheap AI inference regardless of volume, but a human (or a small reviewer team) reading and signing off on 3–5× the current EN+ES volume is a real, non-compressible bottleneck. This is precisely why bulk-decoding for cheap doesn't touch the actual constraint (§1.4) and why the strategy names the ES-reviewer hire (or an equivalent bilingual-org partnership) as a **precondition that must exist before state-expansion's ES decode begins**, not a parallel-track hire that can lag the build. This spec restates that as blocking and does not soften it: **no state bill's call-CTA activates in any language until the reviewer capacity this section describes actually exists**, independent of how the Nov build slot's calendar otherwise reads.

### 3.4 ZIP→state-district lookup

The good news, verified this pass: **this is mostly already-solved by infrastructure Rostra already ships**, not a new vendor integration.

- **The existing Census geocoder call already returns the answer.** `/api/district`'s proxy to `geocoding.geo.census.gov` (`lib/district.ts`) requests congressional-district geographies today; the Census Geocoding Services API's default `geographies` response includes **State Legislative District (Upper Chamber)** and **State Legislative District (Lower Chamber)** layers alongside Congressional Districts in the *same* response, by default, per the Census geocoder's own documentation. Practically: the address-refinement split-ZIP path (`lib/district.ts`'s `parseCensusResponse`) needs **new parsing logic for two more layer keys**, not a new network call, a new vendor, or a new API key. The same `FIPS_TO_STATE` table and pattern-matched layer-key lookup (`/congressional districts/i` today) extends directly to `/state legislative district \(upper/i` and `/(lower)/i` matching.
- **A ZCTA-based bulk file exists too, matching the pattern `data/zip-districts.json` already uses.** The Census Bureau publishes a **National 2024 SLDU-to-2020-ZCTA Relationship File** and a **National 2024 SLDL-to-2020-ZCTA Relationship File** (census.gov's Relationship Files page) — structurally the same kind of ZIP→district crosswalk as the `OpenSourceActivismTech/us-zipcodes-congress` dataset `data/zip-districts.json` is already built from, just for state upper/lower chambers instead of congressional districts. This is the natural source for a `data/zip-state-districts-tx.json`-shaped file mirroring the existing pattern, including the same split-ZIP caveat (a ZIP spanning multiple state legislative districts shows all candidates, same as today's congressional-district handling).
- **TX and CA also each publish their own authoritative boundary data** (Texas Legislative Council's data portal + a TxDOT ArcGIS open-data mirror for TX Senate/House districts; California's `data.ca.gov` Senate/Assembly district datasets, certified by the 2020 Citizens Redistricting Commission) — useful as a state-specific cross-check on the Census product, not required as the primary source given the Census relationship file already exists at national scope and matches Rostra's existing ZCTA-based pattern exactly.
- **The same boundary-decay-clock risk S24 already named applies here too, and this is a real sequencing dependency, not a footnote.** TIGER/Census-sourced legislative boundaries lag mid-decade redistricting the same way congressional ones do (§1.2's Alabama example: a static snapshot mid-litigation ships the wrong districts). Redistricting Data Hub — the alternative source S24 is already adopting for the federal two-clock model — explicitly lists **"Legislative Boundaries"** as a filterable data type on its own per-state pages (confirmed for both Texas's and California's RDH state pages), not just congressional boundaries. **Recommendation for the eventual build: adopt RDH as the single boundary-source-of-truth for federal *and* state legislative districts together, once S24 lands, rather than building a second, TX/CA-specific boundary pipeline that duplicates S24's own two-clock design.** This is a sequencing note for whoever schedules the build (S24 before or alongside any state-district lookup work), not a change to S24's own scope in this sprint.

---

## 4. Open triggers — restated, not resolved

Per the S25 brief and the strategy's own instruction that this document "note which of the two open triggers... still need Colby's ruling before the Nov build slot locks" — restated verbatim from strategy §1.2, changed not at all:

> "**(a)** post-launch usage data (coverage search hits, `/reps` traffic, MCP tool-call volume) must show organic demand for state-level lookup before the Nov build slot is actually committed — not assumed from this section alone. **(b)** Whether the Feb 2027 gate governs this feature or only monetization moves is unanswered; Colby needs to rule on this explicitly before the Nov slot locks."

**This spec does not resolve either trigger.** Trigger (a) requires production usage data that doesn't exist yet (the site isn't even indexable until S1 lands). Trigger (b) is a scope-of-governance ruling only Colby can make. Both remain open exactly as the strategy left them.

**The Phase E collision rule, also restated verbatim (binding, already settled elsewhere — cited here, not re-argued):**

> "if the U15 embeds-hardening gate **passes** (read lands ~mid-November under §1.3's calendar), state expansion degrades to **TX-only-first** (TX alone carries the scarcity argument; CA and NY follow in a later session). If U15 **fails**, the full three-state build proceeds as scheduled. Grants-package PRs (U17) are non-displaceable in either branch — grants are the highest-EV revenue line in this whole strategy and don't get bumped for a feature build."

This spec is written to be branch-agnostic where it can be: §1–§3's triage-queue design, KTD-10 pipeline shape, and ZIP→district approach all apply whether the eventual build ships TX-only or TX+CA together — the only place the branches diverge is *whether the CA-shaped files/workflow in §3.1 and §3.4 ever get written at all*. Nothing in this spec should be read as assuming the collision rule resolves toward the full build.

---

## 5. Test scenarios for the eventual build

None of these run in this sprint (S25 is spec-only, per its own Done criterion: "a written spec exists for whoever executes the committed build; no state-bill data ships"). They're written now, in the acceptance-example style this repo already uses (`docs/plans/2026-07-03-001-feat-rostra-launch-buildout-plan.md`'s AE1–AE5), so the eventual build has fixtures to write tests against instead of inventing scenarios from scratch mid-build.

| # | Scenario | Given | When | Then |
|---|---|---|---|---|
| TS1 | **Triage gate fixture — mechanical, not editorial** | A fixture bill with only an "introduced" status and no committee/hearing/floor event | The nightly triage classifier runs | The bill does **not** enter the triage queue — the classifier has no code path that can be swayed by anything except the four mechanical event types in §1.2 |
| TS2 | **Scheduled-hearing gate (new territory vs. federal)** | A fixture bill with a calendared-but-not-yet-held committee hearing | The triage classifier runs | The bill enters the queue on the *scheduled* event, not only once the hearing has occurred — this is the one gate criterion with no federal analog, so it needs its own fixture, not an inherited one |
| TS3 | **Three-state queue, not two** | A curated bill with EN+ES decode complete but no reviewer sign-off | Any surface (site, MCP, embed) requests its call-CTA state | The response shows the bill as decoded-and-visible-for-context (if the eventual build even surfaces pre-review bills publicly — an open design question, not settled by this spec) but the call-CTA itself renders as inactive/absent, never as a normal active CTA |
| TS4 | **Review-queue state transition is one-way per language** | A bill reviewed and approved in English but not yet in Spanish | The site renders the bill in the ES locale | The EN call-CTA does not leak into the ES render as a substitute — mirrors AE2's existing "ES fallback is labeled" rule from the launch-buildout plan, applied to the new reviewed/not-reviewed dimension instead of the existing decoded/not-decoded one |
| TS5 | **EN/ES parity across three corpora, not one** | The federal, TX, and CA corpora (once CA exists) each have their own bills.json-shaped files | `check-messages-parity.mjs`-equivalent parity check runs (or its state-corpus extension) | A decoded-but-parity-broken bill in any one corpus fails that corpus's own verifier — a clean federal run must never mask a broken TX run, mirroring §3.2's freshness-isolation requirement applied to parity instead of staleness |
| TS6 | **Per-corpus freshness never leaks** | The TX sync fails silently (e.g., its verifier catches a shrink or a stale cursor) while the federal sync succeeds the same night | A TX bill page or TX MCP tool response renders its "data as of" stamp | It reads the **TX** `sync-state-tx.json` timestamp (correctly stale/frozen), never the federal one — direct test of §3.2's corpus-keyed `getFreshness()` requirement |
| TS7 | **Anomalous-shrink guard, ported from vacancy_diff.py's pattern** | A state sync run's triage queue shrinks by more than a documented threshold overnight | The state sync's own dead-man's-switch verifier runs | The run fails loudly *before* commit (mirroring `vacancy_diff.py`'s `ANOMALOUS_SHRINK_THRESHOLD` two-channel design: small changes are logged, large ones block) |
| TS8 | **Disjoint file set holds under concurrent nightly jobs** | The federal sync and a state sync both run in the same nightly window, both joined to the `data-sync` concurrency group | Both attempt to push | They serialize (never race) and neither's rebase-retry touches a file the other wrote — direct test of KTD-10's stated disjoint-file-set safety proof, extended to a third workflow instead of two |

---

## 6. STATUS.md

Updated in this same PR: the S25 line under "Numbered sprints" now reads spec-delivered (PR-open, not merged — Colby merges), citing this document, with the sprint still un-checked (`[ ]`) since the *build* it specs remains parked behind §4's triggers — only the spec itself is done.

---

## 7. What this sprint's PR actually contains

Per the S25 brief's own docs-only discipline: this PR's diff is `docs/plans/2026-07-06-state-expansion-triage-spec.md` (new) + one line in `STATUS.md`. Quality gates run anyway, on a `main`-merged tree, as cheap insurance that the `STATUS.md` edit didn't break anything mechanical (`tsc`, lint, EN/ES parity, `public/` allowlist) plus `npm run build` — the Playwright E2E suite is deliberately **not** run, and that omission is disclosed rather than silently skipped, because the diff touches no runtime code, no route, no component, and no message key.

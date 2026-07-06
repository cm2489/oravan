# Rostra Build & GTM Strategy — July 2026

**Date:** July 5, 2026 · **Status:** operating document, pending Colby's approval
**Relation to prior work:** supersedes `docs/ideation/2026-07-02-monetization-strategy.md` as the operating strategy; that report remains the evidentiary base and is cited throughout. Companion specs (`2026-07-02-embeds-spec.md`, `2026-07-02-mcp-spec.md`) remain live build references.

**Decision log — rulings by Colby, 2026-07-05, implemented throughout (constraints win over all other content):**

1. **Venture funding dropped entirely** (§7) — including the previously-open institutional-layer C-Corp structure. Funding = grants + donations + institutional revenue, full stop.
2. **White-label embeds, MCP, and Evergreen Spanish SEO/GEO promoted to core build components** (§1, §8) — the 20-email demand test survives as a GTM/prioritization signal, no longer a build/no-build gate.
3. **Citizen donation tool added** (§6) — reversing the prior no-donations posture, with the guardrails stated there.
4. **Texas and California coverage stated as committed direction** (§1.2) — direction, honestly not yet a date; New York optional, later.

Standing state carried forward: three features shipped and verified live July 4 (share panel + OG cards, beta feedback pipe, animated walkthrough); citizen notifications killed permanently; momentum tracker, map view, state-build execution, electoral context, and nominations parked behind written triggers. The advocacy-customer premise (§3) is settled policy and appears verbatim.

---

## 1. Build Strategy

The backlog below is organized around one fact: almost everything that used to be conditional is now core. Embeds, MCP, and Spanish SEO/GEO all move from "maybe, if a gate clears" to "scheduled" — which means the binding constraint shifts entirely onto sequencing and one-builder throughput. This section inventories what's shipped, states the two new committed-but-parked coverage states plainly, and lays out the sprint sequence through the Feb 2027 gate.

### 1.1 Feature inventory

**Shipped (live as of July 4, 2026):**

| Feature | What it is | Note |
|---|---|---|
| Share panel + per-bill OG cards | Slug-only URLs, generated OG images for social/press sharing | Full brand polish waits on the identity-finish gate below |
| Beta feedback button | GitHub-issue pipe from the live product | `GITHUB_FEEDBACK_TOKEN` is now a second runtime secret alongside `ANTHROPIC_API_KEY` — never shipped to the client |
| Animated call walkthrough | Homepage + bill-page walkthrough, plus a press-ready recording | `docs/press/walkthrough-demo.webm` |
| noindex | Still **ON** | The one thing every distribution channel — press, MCP registries, organic search — is dead until it lifts |

**Core components ahead.** Three items move from "considered" to "scheduled," each for a different reason:

**1. White-label embeds — now core, no longer demand-gated on build/no-build.** The prior spec's 20-email demand test was a green-light gate for the whole embed line. That's reversed: the free tier and the V1.1 paid tier both get built regardless of what the demand test shows. What survives from the old design is the *measurement* — Referer-nominated "installs," manually confirmed by Colby before counting (recipient-page-load fixture, not a spoofable header) — but it now functions as a GTM/prioritization signal (does network-license outreach accelerate?), not a kill switch. The seven security-hardening items are load-bearing regardless of which way the signal reads — none are optional, and none wait on a demand verdict:

| # | Requirement | Ships in | Why it's non-negotiable |
|---|---|---|---|
| F1 | `frame-ancestors 'self'` site-wide, `app/embed/*` sole carve-out | S17 (U15 — not deferrable to U16) | Today, Next sets no clickjacking header; the entire site (call modal, stance selection) is frameable |
| F2 | ZIP-only embeds — address refinement excluded from iframes | S17 | Address entry on an arbitrary third-party page is a phishing/overlay surface |
| F3 | Referrer truncation at ingestion (registrable domain + count only, pre-persistence) | S15 | Referer is client-controlled; a bare `curl` shouldn't be able to fake a demand signal |
| F4 | Two separate Upstash databases (not just namespaces) for caller-keyed vs. content-keyed data | S11, reused by S19 | A single DB's command log would temporally re-pair caller and content even with clean key design |
| F5 | Salt ≥128-bit CSPRNG, never date-derived, 24h TTL, loud-failure age verifier | S11 | 32-bit IPv4 space brute-forces in seconds against a weak salt |
| F6 | Spoofable-counter honesty — daily bucketing, disclosed as best-effort | S20 | Unauthenticated public writes are spoofable by design; bucketing is the only real mitigation |
| F7 | Pregen-flag authentication — build-time secret or direct Upstash write, never a public flag | S21 | No pregeneration script exists today; this must be designed in from its first line, not retrofitted |

Positioning stays unchanged even though the gate logic did: an advocacy org embedding the free widget is fine — it's a utility, like embedding a map. Attribution keeps it legibly Rostra's, and the ToS bars misrepresenting neutrality. What's never for sale is stance-shaping or member capture, and embeds don't build either.

**2. MCP — free, keyless, core distribution asset.** Hosted inside the existing Next app (`app/api/mcp/[transport]/route.ts`, Vercel's `mcp-handler`, Streamable HTTP, stateless over baked JSON — a separate service isn't justified below 1M calls/mo). Exactly **5 tools**, not 6 — `get_bill_coverage` is cut (KTD-6, closed under R16): `lookup_representatives`, `get_bill`, `search_bills`, `whats_moving`, `get_representative`. Every response carries `{as_of, source, canonical_url, ai_label, license}`. `draft_call_script` is explicitly not exposed over MCP — it's the only per-call Anthropic cost, the highest platform-policy risk on a keyless server, and exposing it would bypass the "AI content human-reviewed before it drives a call" constitution; MCP returns `act_url` link-out instead. Direct MCP revenue is **$0 by design** — a dormant `X-Rostra-Key` header ships so a hybrid tier can activate later without re-architecture. Runtime cost: ~$0 marginal at 10k calls/mo, ~$20-60/mo at 1M.

**3. Evergreen Spanish SEO/GEO — now core, the durable-moat move.** The prior conclusion — "per-bill shareable cards beat Spanish SEO" — was right about two things and silent on a third. It was right that the ES-dominant audience's discovery channels are WhatsApp (56% of Hispanic adults) and TikTok (57%, up from 49% in 2023) rather than search, and right that new pages generally rank slowly (1.74% of new pages reach Google's top 10 within a year). It was silent on this: the **~3,350-page bilingual SSG corpus** (1,667 bills × 2 locales, nightly-refreshed, EN/ES key-parity enforced — the code-verified figure; CLAUDE.md's "~1,000" is stale, see §9.1(a)) exists *because bilingual parity is constitutional*, not because of any SEO decision. That means "do Spanish SEO" doesn't mean commissioning Spanish content the way an incumbent would — it means switching on infrastructure (hreflang, JSON-LD, sitemap, noindex removal, freshness stamps) on content that already exists as a byproduct of the constitution. The reframing that supersedes the old argument: this was never really "SEO vs. cards" as competing investments, since the corpus cost is sunk either way — it's whether to spend the small, mostly one-time activation cost to let that asset also compound as an AI-citation source.

Grounds for doing it: zero incumbent — Congress.gov, GovTrack, Ballotpedia, 5 Calls, or any advocacy org — offers durable per-bill Spanish decoding at any depth (verified this pass, not just asserted from the prior doc). Chatbots were documented in Oct 2024 to be worse in Spanish on election questions (52% vs. 43% error rate) — that figure is 2024-vintage, tested on now-superseded models, and should be described as "documented in 2024, not re-confirmed with current-generation models," not quoted as a live 2026 statistic; the general "AI still gets election facts wrong" finding does persist into 2026 (~36% factual-error rate in a May 2026 study). What this is **not**: a traffic promise. No Spanish keyword-volume data exists for these query shapes — a genuine gap, not a confirmed zero — and cards remain the right mechanism for the share-first audience. The two aren't in tension: cards drive the human-share channel; GEO activation captures whatever the AI-answer channel would otherwise hand to Wikipedia by default (the closest analog found — a Spain-domestic-politics study, not a US-Congress study — shows AI assistants falling back to Wikipedia/national media absent a specialized structured source). "Core" means this activation work is scheduled and budgeted; it is not a line any grant application should cite as a traffic-growth claim.

**The rename + noindex lift is one gate, cited once, for everything below.** Two different "renames" exist — only one is open. Frozen forever: the `rostra-sync[bot]` commit-author identity (R16) — untouched, breaks Vercel deploy otherwise. Still baking: the Cabina→Rostra **visual identity** (real mark, favicon/OG assets, DESIGN.md retiring "Cabina era" framing). The technical substrate does not wait for it — the `lib/site.ts` `SITE_URL`/`metadataBase` constant (feeding sitemap/hreflang/JSON-LD/OpenAPI/MCP envelope alike) and the domain confirmations land in S1, a week before identity work even starts. Identity completion (S2) is the precondition for the brand-baked surfaces only: OG cards' full polish, the MCP registry entry (DNS-bound domain verification — registering under an unfinished identity is redone work), the press kit, and any future SSG metadata for nominations/state-expansion pages. The `rostra-build` meta emission `scripts/verify-deploy.mjs` greps nightly must not be disturbed by any of this. This is published once here, not re-litigated PR by PR.

### 1.2 Texas and California: committed coverage direction

State coverage direction is now stated plainly, for donors and grantmakers, as committed: **Texas and California are the two states Rostra is building toward. New York is optional, later.** This is a direction commitment, not a date commitment — the distinction matters and is stated honestly below.

**Why TX and CA, why not a date yet:**
- The full state build (curated + phased, mechanical curation on committee action/scheduled hearings/floor votes, one state first, triage queue gating the call-CTA on review-not-decode) remains **parked** behind two written triggers, per the settled state-expansion verdict — cited here, not re-derived. Rejecting the "decode the full corpus, it's only $2-3k" framing explicitly: that's a human-review-rule violation, not a cost-optimization.
- Calendar-fixed target already on record: build Nov–Dec 2026 (~15-20 PRs), ship first week of January 2027. Texas's 90th Legislature convenes **Jan 12, 2027** — its only regular session before 2029 — which is the scarcity argument for prioritizing TX. CA's 2027-28 session and NY's both convene early January too, but NY is explicitly deferred here per the current ruling.
- Two open triggers this document surfaces, not silently resolves: **(a)** post-launch usage data (coverage search hits, `/reps` traffic, MCP tool-call volume) must show organic demand for state-level lookup before the Nov build slot is actually committed — not assumed from this section alone. **(b)** Whether the Feb 2027 gate governs this feature or only monetization moves is unanswered; Colby needs to rule on this explicitly before the Nov slot locks.
- **Phase E collision rule (binding, already settled — cited, not re-argued):** if the U15 embeds-hardening gate **passes** (read lands ~mid-November under §1.3's calendar), state expansion degrades to **TX-only-first** (TX alone carries the scarcity argument; CA and NY follow in a later session). If U15 **fails**, the full three-state build proceeds as scheduled. Grants-package PRs (U17) are non-displaceable in either branch — grants are the highest-EV revenue line in this whole strategy and don't get bumped for a feature build.
- Displacement rule: this build displaces the post-midterm lull (grant-application writing, Feb-2027-gate prep) — it does not touch the Sept 30 funding-fight launch window or the October embed demand test.
- ES-review bandwidth is a precondition, not a checklist item: the reviewer hire (or an equivalent-standing bilingual-org partnership) must exist *before* state-expansion's ES decode begins, because state bills run 3-5× current review volume. This is the same Sept–Oct 2026 trigger window nominations would hit — the strategy tracks the cumulative load, not five isolated EN/ES parity checks. **Recruiting is therefore a dated action, not an assumed end-state: by Aug 17, 2026 (S7 week), post the contract ES-reviewer role or open the bilingual-org partnership conversation, so the reviewer exists before the trigger fires.**

**Data-architecture groundwork, stated honestly as groundwork and not the build itself:** the existing federal ZIP→district pipeline is already a listed decay-clock weakness — hardcoded to the 119th Congress, and Census TIGER (the obvious "authoritative" source) has **not** been refreshed for the 2025–26 mid-decade redistricting wave (confirmed still 2024-cycle vintage plus partial AL/GA/LA/NY/NC updates only). Redistricting Data Hub is the live-tracked alternative — same-day-to-next-day turnaround on new state plans versus Census's weeks-to-months. Alabama is the sharpest live proof of why a static snapshot is dangerous: SCOTUS reinstated the state's 2023 map on June 2, 2026, and the Aug 11, 2026 special primary uses that reinstated map — a pipeline that snapshotted boundaries once, mid-fight, would have shipped the wrong districts across that reversal. This groundwork (S24 below) fixes the boundary-source question for the *existing* federal lookup feature and is the same architecture any future TX/CA state build sits on top of — it is not itself the state-bill-tracking build. [FILL: the state-legislature bill-tracking data source itself — LegiScan, Open States/Plural API terms, or direct state APIs — is not established in any source material available to this drafter and needs a separate decision before S25's spec can be executed.]

### 1.3 Sprint breakdown (S1–S25, July 2026 → February 2027)

Sequencing: rename/noindex-lift → launch quality → MCP → embeds hardening + build → ES SEO/GEO foundation → TX/CA data-architecture groundwork (late). Sprint = roughly one calendar week. Velocity basis is the plan's own stated figure, **~7 PRs/week demonstrated**, used here because it's the documented basis — but git shows ~5/week merged over the last 4.6 weeks, so several sprints below are sized tight and expected to slip a few days, not because of new information but because the plan's own reference figure may be optimistic.

**Overview**

| Sprint | Dates | Focus |
|---|---|---|
| S1–S2 | Jul 6 – Jul 17 | Rename/noindex-lift gate |
| S3–S8 | Jul 20 – Aug 28 | Launch quality → LAUNCH gate |
| S9–S12 | Aug 31 – Sep 25 | MCP: data core, 5 tools, Upstash, registry |
| S13–S16 | Sep 28 – Oct 23 | Embeds free-tier MVP |
| S17–S21 | Oct 26 – Nov 27 | Embeds V1.1: hardening + paid tier |
| S22–S23 | Nov 30 – Dec 11 | ES SEO/GEO foundation |
| S24–S25 | Dec 14 – Dec 25 | TX/CA data-architecture groundwork |

**S1 · Jul 6–10 — Rename/noindex-lift, technical**
- *Goal:* lift noindex and ship the technical rename substrate every brand-baked feature downstream depends on.
- *Scope:* remove noindex in `app/[locale]/layout.tsx`; ship sitemap/robots/hreflang; land `lib/site.ts` `SITE_URL`/`metadataBase` (KTD-9) as the single constant feeding sitemap, hreflang, JSON-LD, OpenAPI, MCP envelope; confirm `rostra.org` domain ownership/DNS/production alias (U2). Explicit non-goal: `rostra-sync[bot]` stays untouched (R16).
- *Tests:* `scripts/verify-deploy.mjs` nightly grep still green; sitemap includes both locales; hreflang reciprocal-tag validator passes; a live fetch of a bill page carries no noindex meta.
- *Done:* production serves with noindex removed; `SITE_URL` is the only constant any downstream unit reads.

**S2 · Jul 13–17 — Identity finish, minimal (U9)**
- *Goal:* close the one remaining brand-bake gate.
- *Scope:* real mark replacing the `PhoneCall` chip; favicon/OG assets; DESIGN.md retires "Cabina era" framing (booth token name kept, documented as legacy).
- *Tests:* OG image renders correctly at share-panel size, both locales; favicon present across manifest sizes.
- *Done:* U9 marked complete once, here — every consuming unit (press kit, MCP registry, OG surfaces) cites this instead of re-litigating.

**S3 · Jul 20–24 — Freshness stamp + urgency floor (KTD-1, KTD-2)**
- *Goal:* every "as of" claim reads from `getFreshness()`; false urgency stops.
- *Scope:* wire the accessor into bill pages, cards, homepage; land the urgency-floor + quiet-week tri-state.
- *Tests:* AE3 quiet-week/data-stale scenarios pass.
- *Done:* no page states freshness without reading the accessor.

**S4–S5 · Jul 27 – Aug 7 — Homepage funnel + /reps continuation + donation surfaces**
- *Goal:* the ZIP→reps→bill→call path reads as the product; the donations leg gets its build slot.
- *Scope:* homepage restructure around the shipped walkthrough; /reps continuation tightened; donation surfaces per §6 — footer "Donate/Donar" link + About/Support page linking out (new tab) to the HCB-hosted page, zero payment fields anywhere on our infra (~1 PR; the HCB application itself is Phase-0 paperwork, non-code, already in motion).
- *Tests:* full bilingual click-through; en/es key-parity check on any new string; donate links resolve to the HCB-hosted URL and render no payment field on any Rostra page.
- *Done:* a first-time visitor reaches a completed call script in ≤3 clicks, either language; donation surfaces built (the link may sit dark until HCB onboarding completes — the launch-week checklist re-verifies it's live).

**S6 · Aug 10–14 — Spanish paired-script last mile**
- *Goal:* close remaining EN/ES gaps in the call-script flow specifically.
- *Scope:* audit + fix any ES script paths trailing EN; confirm 3-stance × 2-locale parity.
- *Tests:* parity script confirms no missing `es.json` key; Colby spot-check on a stance-output sample (interim substitute per U7 — the ES-reviewer hire is not yet assumed).
- *Done:* no known parity gap in the Spanish call-script path; spot-check logged.

**S7 · Aug 17–21 — Call-moment slice**
- *Goal:* the moment of dialing feels finished.
- *Scope:* pre-dial beat, clipboard copy, office-hours line; night-screen variant only if time allows (first cut if the week runs long).
- *Tests:* manual mobile walkthrough; clipboard copy verified iOS Safari + Android Chrome.
- *Done:* pre-dial, clipboard, office-hours all ship; night screen is optional.

**S8 · Aug 24–28 — Buffer + LAUNCH gate**
- *Goal:* absorb S3–S7 slippage; make the go/no-go call.
- *Scope:* rollover only, no new scope opened.
- *Tests:* full bilingual funnel walkthrough; freshness stamp correctness across page types; noindex re-confirmed off.
- *Done:* LAUNCH gate verdict recorded in writing — yes/no, not left implicit.

**S9 · Aug 31 – Sep 4 — Pure data core + MCP route scaffold**
- *Goal:* `lib/core/` exists as the shared data layer every agent surface reads from — precedes agent surfaces (KTD-5).
- *Scope:* extract bill/rep data access into `lib/core/`; scaffold `app/api/mcp/[transport]/route.ts` (Vercel `mcp-handler`, Streamable HTTP).
- *Tests:* existing pages render identically sourced from `lib/core/`; MCP route answers a bare handshake.
- *Done:* single data-access layer; no tool logic yet.

**S10 · Sep 7–11 — 5 MCP tools + citation envelope**
- *Goal:* ship exactly `lookup_representatives`, `get_bill`, `search_bills`, `whats_moving`, `get_representative` — `readOnlyHint:true`, one `locale` param, `{as_of, source, canonical_url, ai_label, license}` on every response.
- *Scope:* the coverage tool is cut (KTD-6, closed under R16 — not reopened without an explicit amendment); `draft_call_script` explicitly not exposed, `act_url` link-out instead.
- *Tests:* schema validation on every tool response; a `get_bill_coverage` request returns "not available," not a silent 6th tool.
- *Done:* 5 tools live, zero AI-generation cost surface exposed over MCP.

**S11 · Sep 14–18 — Upstash two-database rate limiting + CI privacy gate (KTD-3, F4/F5)**
- *Goal:* caller-keyed counters and content-keyed cache live in **two separate Upstash databases**, not just namespaces.
- *Scope:* stand up both databases; salt ≥128-bit CSPRNG, never date-derived, 24h TTL, loud-failure salt-age verifier shipped in the same unit; anonymous 60/min–1,000/day; dormant `X-Rostra-Key` header ships (does nothing yet).
- *Tests:* `scripts/check-key-namespaces.mjs` fails a PR that writes a stance/content identifier into any caller-originating request path/query; salt-age verifier fires on a forced-stale fixture.
- *Done:* two-DB separation is CI-enforced, not just reviewed; anonymous rate limits live.

**S12 · Sep 21–25 — Registry + directory submissions**
- *Goal:* MCP discoverable where agents look, by the "listed by early October" target.
- *Scope:* official MCP registry `server.json`, domain-verified (depends on S1 domain confirmation + S2 finished identity); PulseMCP/Glama/Smithery claims; Claude Connectors Directory submission (Government & Nonprofit category, no OAuth needed); server docs.
- *Tests:* `server.json` validates; domain verification succeeds; Connectors submission accepted or a specific rejection reason logged.
- *Done:* MCP listed in at least the official registry + Connectors Directory.
- *Explicitly not in scope, per the plan's own designated slippage valve:* OpenAPI 3.1 REST aliases and ChatGPT Apps SDK submission — the plan names directory-tail/REST-alias work as its honest failure-mode cut; it is not free capacity and doesn't get spent pre-emptively here or in any later sprint.

**Sequencing ruling (resolves what an earlier draft left flagged):** running MCP fully before embeds lands the embed free tier at S16 (Oct 23) — after KTD-8's original "early-October sends" reference point. Rather than sending outreach three weeks before recipients have anything to install, **KTD-8's sends move to the week of Oct 26, immediately after S16 ships**, with the 14-day nominate-and-confirm read landing ~Nov 9–13. Two knock-ons, accepted: (1) the outreach pitch reframes from "midterm week" to the lame-duck session and the December funding deadline — arguably the stronger newsroom hook anyway; (2) the Phase E state-expansion branch decision (TX-only-first vs. full build) is recorded ~mid-November instead of October — still ahead of the Nov–Dec build slot actually committing. The alternative — swapping S13–S16 ahead of the MCP registry tail to hit early-October sends — remains available if Colby prefers the embed signal earlier; it costs the "MCP listed by early October" target instead. This document plans on the first option, and §8's press-ready table uses the same dates.

**S13 · Sep 28 – Oct 2 — Rep-lookup widget + loader**
- *Goal:* the first live iframe surface exists.
- *Scope:* ~5KB dependency-free script-tag loader; iframe, not a web component (the privacy claim must be browser-enforced); `embed.rostra.org` subdomain, same brand/repo/Vercel project; rep-lookup widget only.
- *Tests:* CI confirms zero cookies on the embed origin; network trace confirms zero third-party requests.
- *Done:* rep-lookup widget loads on a test host page via the loader, no cookies, no third-party calls.

**S14 · Oct 5–9 — Bill-card widget + theming**
- *Goal:* the second free-tier surface, themeable without tenant code execution.
- *Scope:* bill-explainer card widget; CSS-custom-properties-only theming.
- *Tests:* attempted CSS-injection input is rejected; both-locale render with the EN/ES toggle always present (a tenant sets the default, never removes Spanish).
- *Done:* bill-card widget live; theming surface is CSS-vars-only by construction.

**S15 · Oct 12–16 — Privacy hardening + CI gates (F3)**
- *Goal:* "collects nothing about your visitors" is CI-enforced, not asserted in copy.
- *Scope:* no fingerprinting/analytics; portraits/logos mirrored to Blob; referrer-truncation-at-ingestion (registrable domain + count only, truncated before persistence).
- *Tests:* full-URL-Referer fixture proves no path/query persistence; CI job fails on any new third-party request domain in a widget's trace.
- *Done:* free-tier privacy claims are CI-gated. (The demand-test's manual-confirmation step — Colby visiting each nominated domain — is a GTM process step that runs after S16 ships, not an engineering sprint.)

**S16 · Oct 19–23 — Configurator + docs + launch kit**
- *Goal:* a self-serve org embeds without a sales call.
- *Scope:* configurator UI; public docs; launch kit.
- *Tests:* a cold walkthrough (no prior context) succeeds using only public docs.
- *Done:* free-tier embed MVP complete — also the artifact KTD-8 outreach sends recipients to.

**S17 · Oct 26–30 — `frame-ancestors` split posture (F1, F2)**
- *Goal:* the entire non-embed site stops being frameable.
- *Scope:* `frame-ancestors 'self'` site-wide, `app/embed/*` sole carve-out with its own minimal embed CSP; street-address refinement excluded from iframes, links out to the main site instead.
- *Tests:* bill page returns `frame-ancestors 'self'`; embed route returns the carve-out; iframe attempt at address refinement fails/redirects out.
- *Done:* F1 and F2 both ship in this unit — the ledger is explicit this can't slip to a later unit without the permissive posture risking becoming permanent.

**S18 · Nov 2–6 — Stripe + webhook + tenancy tokens**
- *Goal:* self-serve billing without an accounts DB.
- *Scope:* Stripe self-serve checkout; 128-bit capability tokens written to Edge Config/Upstash KV by the webhook — no accounts DB, no passwords, no dashboard.
- *Tests:* a test-mode subscription provisions a working token; a cancelled subscription's token stops authorizing within the cache TTL.
- *Done:* Pro/nonprofit tiers purchasable and self-provisioning.

**S19 · Nov 9–13 — Action panel (V1.1 paid-tier only) + shared rate-limit architecture**
- *Goal:* the AI-script action panel ships behind ToS-accepted tenancy, reusing S11's two-database architecture — not a parallel implementation.
- *Scope:* action-panel widget; per-tenant rate limits on the same caller/content separation.
- *Tests:* AE5's privacy invariant re-run against the embed-originating request path specifically (the ledger requires this across `/api/script`, MCP, *and* embed routes); action panel refuses to render without ToS acceptance on file.
- *Done:* paid-tier action panel live on the shared cache/rate-limit architecture.

**S20 · Nov 16–20 — Impression counts (F6)**
- *Goal:* tenants see monthly aggregate impressions, disclosed as best-effort.
- *Scope:* server-side aggregate counts (tenant→count/day, IP discarded before storage).
- *Tests:* a spoofed-traffic fixture confirms only a daily bucket survives, no caller-level trace.
- *Done:* impression counts ship with the same measurement-basis honesty as the site's own call counters.

**S21 · Nov 23–27 (Thanksgiving week — expect reduced capacity) — Feed + admin CLI + ToS + pregen auth (F7)**
- *Goal:* close the remaining V1.1 surface and the last open security item.
- *Scope:* tenant JSON/RSS feed; admin CLI (no dashboard); ToS acceptance flow; the site's *first-ever* nightly pre-generation script (none exists today — `/api/script` currently generates per cache-miss only), authenticated via build-time secret or direct Upstash write from its first line, never a public request flag.
- *Tests:* the named F7 scenario — an unauthenticated request presenting any pregen marker is rejected loudly and rate-limited normally, not silently honored.
- *Done:* full V1.1 surface live; all seven security-ledger items (F1–F7) shipped and CI-verified.

**S22 · Nov 30 – Dec 4 — JSON-LD + hreflang correctness + llms.txt**
- *Goal:* activate the existing corpus as an AI-citable source; add no new content.
- *Scope:* per-bill JSON-LD (Article/FAQPage-style, stacked under `@graph` — the "2.5x citation" claims behind this pattern are vendor-blog, not peer-reviewed; ship it because it's cheap and directionally plausible, not because that figure is trustworthy); hreflang correctness pass across the full corpus (noindex removal already shipped in S1; ~75% of hreflang implementations in the wild contain errors per industry sources, so this is a dedicated correctness pass, not a re-ship); `llms.txt` (optional — no major AI lab supports it as of Q1 2026 per Search Engine Land's reporting; a few hours of one-time cost, shipped for completeness, not for proven return).
- *Tests:* hreflang validator across all ~3,350 pages; JSON-LD validates against schema.org.
- *Done:* GEO signals live on the existing corpus. No claim in any grant application or press kit that this drives a measured Spanish-traffic number — that data doesn't exist.

**S23 · Dec 7–11 — Citability/correction page + ES redistribution spot-check**
- *Goal:* close the standing "ES redistribution bar" flag before MCP and embeds put more Spanish AI-generated text in front of third parties.
- *Scope:* citability/correction page reachable from every bill page footer; a native-speaker spot-check pass (Colby-run, interim substitute) over a sample of ES decodes now reachable via MCP responses and embed widgets.
- *Tests:* sample size and pass/fail criteria documented; failing decodes flagged to the ES-reviewer-hire backlog, not silently patched.
- *Done:* one dated spot-check logged. This clears the *existing* corpus's redistribution risk only — it is not a substitute for the ES-reviewer hire, which stays a precondition for nominations and state-expansion ES decode specifically.

**S24 · Dec 14–18 — Federal boundary-source hardening**
- *Goal:* replace/supplement the Census-TIGER-sourced ZIP→district pipeline before any state-level work compounds the existing decay-clock risk.
- *Scope:* adopt Redistricting Data Hub as the live-tracked boundary source; implement the two-clock model — current-term boundaries (valid through Jan 3, 2027 regardless of litigation) vs. next-ballot boundaries (Nov 2026 candidate data).
- *Tests:* a fixture reproducing the vacancy-handling footgun (absence from a "current" roster file must surface as an explicit vacant state, never silently backfill the departed member) fails loudly if regressed.
- *Done:* boundary-source decision recorded in writing; vacancy state handling explicit.

**S25 · Dec 21–25 (Christmas week — likely slips into early January) — Curated-triage architecture spec**
- *Goal:* write the data-architecture shape the committed state build will implement, without building it early.
- *Scope:* spec the triage-queue pattern (mechanical curation on committee action/scheduled hearings/floor votes, one state first, call-CTA gated on review-not-decode); note which of the two open triggers (demand-evidence, Feb-2027-gate scope) still need Colby's ruling before the Nov build slot locks; note KTD-10 pipeline conventions apply to this feature's nightly sync too (+1 PR on top of whatever the eventual build estimate assumes).
- *Tests:* none — spec-only, explicitly rejecting the "decode the full corpus" framing.
- *Done:* a written spec exists for whoever executes the committed build; no state-bill data ships.

**Capacity-conflict synthesis, stated plainly rather than papered over:** this section's own sprint math already runs solo capacity from S1 through S25 into the week of Christmas — which leaves essentially no open runway before the separately-settled "Nov-Dec 2026, ship first week of January 2027" state-expansion build slot. That's not a contradiction to resolve quietly; it's the clearest evidence in this document for why the Phase E collision rule defaults to **TX-only-first** when the U15 gate passes (mid-November read). TX-only isn't just the better product-sequencing call — it's the only version of this calendar a one-builder can actually deliver without displacing the grants-package work (U17, explicitly non-displaceable) or Feb-2027-gate prep itself. If the U15 gate fails and the full three-state build proceeds as scheduled instead, expect the Nov-Dec window to consume this section's S17–S25 slack entirely, and treat the Jan 4–8, 2027 ship date as the one that matters (ahead of TX's Jan 12 session), not "finished building by Dec 31."

**S26 onward (late December 2026 → February 2027):** no new build sequence opens in this section. GTM Phases 3–4 execute on their own calendar; the state-expansion build lands whichever branch the Phase E collision rule selects; and the Feb 2027 gate reviews the whole build — embeds ARR signal, MCP call/directory-referral volume, state-expansion progress, grant pipeline — in one sitting.

---

## 2. GTM Strategy

### 2.1 Timeline: soft-public → funding-fight press moment → midterms → sustained

The real deadline is **Sept 30, 2026**, not Nov 3. Call-your-rep demand spikes on legislative crises, not elections:

> "Call-your-rep demand spikes on *legislative crises* (Feb 2017, Feb 2025: ~1,600 calls/min into the Senate; 5 Calls at 700k calls/week), not elections — October is recess and campaigning, when there's nothing to call about. The government-funding fight is the earned-media window, which means live-and-credible by **late August**. Midterms then deliver a second, different spike: rep-lookup and voter-info traffic in October."

Five phases, running backward from Sept 30:

| Phase | Window | Objective |
|---|---|---|
| 0 — Pattern-breaker | Jul 2–9, 2026 | Lift noindex, ship sitemap/robots/hreflang, move to Vercel Pro, start HCB paperwork, make one dated public commitment as a forcing function |
| 1 — One front, launch quality | Jul 9 – Aug 25, 2026 | Freshness stamp, homepage funnel re-centering, Spanish paired-script last mile, call-moment slice, minimal identity finish |
| 2 — The moment | Aug 25 – Sep 30, 2026 | Public launch into the funding fight; press kit executes; MCP build ships in parallel, listed by early October |
| 3 — The second spike | Oct 1 – Nov 3, 2026 | Midterm lookup/registration traffic; 20-email embed outreach (sends ~Oct 26, post-MVP); WhatsApp-shareable ES cards; goal metric **1,000 logged calls by Nov 3** |
| 4 — Harvest and gate | Nov 2026 – Feb 2027 | Grant applications with a real usage number; post-election network-deal conversations with FiscalNote/VoterVoice refugees; Feb 2027 decision gate |

**Status as of this writing (Jul 5, 2026):** share panel, OG cards, beta feedback pipe, and the animated call walkthrough (+ press webm at `docs/press/walkthrough-demo.webm`) shipped Jul 4. Noindex is still ON — the single item blocking every downstream distribution channel below. It lifts ~2 days after the rename completes; nothing in §2.4 (Show HN, Product Hunt, MCP directories) can fire before that.

---

### 2.2 Outreach targets

**Governing rule:** any target that codes partisan is excluded regardless of reach. Every name below cleared that bar — none is dropped — but several carry a moderate-risk flag from the underlying research and need a pre-commit review by Colby, not a blanket pass. Where a target's own recent output (not its founding mission) creates perceived-lean risk, the table says so; that's a "review before first email," not an automatic exclusion.

This is also why the tables below matter more than they'd otherwise seem to for a free product: outreach itself is a partisan-coding surface. Per the advocacy-customer premise already settled elsewhere in this document —

> "Rostra sells neutral utilities to institutions that need neutrality, and never builds capture mechanics for any customer. If an advocacy org embeds the free widget, that's fine — it's a utility, like embedding a map; attribution keeps it legibly Rostra's voice, and the ToS bars misrepresenting Rostra's neutrality. What's never for sale: stance-shaping, member capture, unlabeled white-label of the call flow."

— the same discipline applies to who Rostra pitches: covered by a partisan-coded outlet, cited by a partisan-coded creator, and the "nonpartisan by construction" claim is compromised by association, not by anything Rostra did.

#### 2.2.1 Journalists / newsletters

| Name | Outlet | Beat | Pitch angle | Partisan-coding check |
|---|---|---|---|---|
| Jake Sherman, Anna Palmer, John Bresnahan, Rachel Schindler | Punchbowl News | DC trade press, Capitol Hill power players; has a Tech vertical | Sept 30 funding fight is their entire beat — pitch the Tech desk on "how citizens are using tech to navigate this Congress," offer embargoed access | **Low risk.** MBFC rates it "Least biased / High factual." |
| — (byline example: Riley Rogerson & Em Luetkemeyer) | NOTUS (Allbritton Journalism Institute) | Nonpartisan nonprofit newsroom; largest Capitol Hill bureau in the country; CEO Arielle Elliott (ex-Bloomberg) named **March 25, 2025** — not Nov 2025 as earlier drafted; has a 2025-announced local-news-syndication initiative | Pitch the local-syndication angle — Rostra's rep-lookup is inherently localizable. Reference piece: "Congress Is Set to Pass a Funding Deal After Trump Gets Holdouts in Line" (Feb 2, 2026), notus.org/congress/congress-is-set-to-pass-a-funding-deal-after-trump-gets-holdouts-in-line | **Low-moderate risk.** Built/funded explicitly to avoid partisan lean; no formal AllSides/MBFC rating found (unverified). |
| Hugo Balta (exec editor) | The Fulcrum | Nonpartisan pro-democracy-reform outlet; Civic Engagement Education vertical; Fall Journalism Fellowship Sept 14–Oct 20, 2026 overlaps the launch window | Pitch the civic-education desk specifically, not general politics | **Moderate risk — review before commit.** AllSides rates it Center but with "low/initial confidence"; recent headlines skew anti-Trump. Colby should scan a few weeks of recent Fulcrum headlines before this one goes out. |
| Isaac Saul | Tangle News | Daily "one big debate, left/right/center" newsletter; ~470–500K total subscribers, **71,000 paying** (corrected down from 75,000); ~$6M projected 2026 revenue (up from $4.15M in 2025); <1% monthly unsubscribe | Pitch Rostra as the tool that turns Tangle's "here's what each side says" into an action — the 3-stance-lane call script | **Low risk, but not unanimous.** AllSides' own Feb 2024 blind-bias survey shows only Left/Lean-Left/Center/Lean-Right raters converged on Center — self-identified Right-leaning raters scored it "Lean Left." Still best-in-class in this list; don't claim unanimous neutrality in the pitch. |
| Gabe Fleisher | Wake Up To Politics | Daily nonpartisan newsletter, running since 2011 (Substack since 2024); ~60,000 subscribers, all 50 states + 100+ countries, readership includes members of Congress; 15th anniversary lands **April 2026**; briefly tested a 3-day/week cadence Feb 2026 | Fleisher's daily job is "explain what Congress just did" — pitch the plain-language bill decoder directly | **Low risk.** Long-running nonpartisan format aimed at civically engaged readers — strong early-adopter match. |
| Andrew Solender | Axios (Congress desk) | Congressional reporter since Oct 2021, ex-Forbes; "smart brevity" format | Screenshot-heavy product demo fits the format directly | **Low-moderate risk.** Not left/right coded, but sometimes perceived as DC-insider/access journalism; safe as a mainstream trade pitch. |
| Burgess Everett (Congressional Bureau Chief, ex-Politico), Kadia Goba | Semafor Principals | DC politics newsletter, reported tripling subscriber base YoY; format explicitly separates "the reporter's view" from "room for disagreement" | Rostra's 3-stance design mirrors Semafor's own multi-perspective structure — pitch the format parallel directly | **Low risk.** |
| Makena Kelly | WIRED — Politics Lab | Politics, power, and technology; known for DOGE coverage | Citizen-facing, privacy-absolute civic tech as a counterpoint to DOGE-era distrust of government tech | **Moderate risk — review before commit.** WIRED's DOGE coverage has read as adversarial toward the current administration; could code left to some readers. Worth pitching, flag the risk first. |
| Chris Teale (managing editor); Natalie Alms (Senior Correspondent, Nextgov/FCW, cross-publishes at Route Fifty — not a Route Fifty staffer) | Route Fifty / Government Technology (e.Republic) | B2G trade press for state/local gov leaders; dedicated Civic Tech vertical | Case-study framing for gov-tech/digital-services leaders on a zero-server-side-data constituent tool — ties directly to the committed TX/CA state-coverage direction | **Low risk.** Professional trade press, not politically inflected. |

#### 2.2.2 Creators

| Name | Platform / reach | Collaboration shape | Partisan-coding check |
|---|---|---|---|
| Sharon McMahon (Sharon Says So / The Preamble) | IG 1M; "Governerds" community 1.1M+; Preamble Substack 225,000 subs; podcast "Here's Where It Gets Interesting" 1.2M+ downloads/mo (Feb 2026) | Guest walkthrough of the call-script tool on the podcast, or a Preamble deep-dive on "how a bill actually becomes law" timed to Sept 30 | **Moderate-low risk — flag to Colby explicitly.** AllSides' "low/initial confidence" Center rating is confirmed. Some right-leaning listeners read her as liberal over positions like gun control, anti-gerrymandering, and voting rights — she frames this as "principle over party" in her own writing (a Substack essay of that title; profiles in Time, No Small Endeavor), not an AllSides characterization. Single largest nonpartisan-branded civics creator available; the "nonpartisan is strategic" house rule applies directly here. |
| Sarah Stewart Holland (left-of-center) & Beth Silvers (right-of-center) | Pantsuit Politics | 10-year podcast, tens of thousands of Substack subscribers, "grace over grievance" format | Joint episode, each host tries the tool from a different stance lane — directly demonstrates the product's 3-lane design | **Low risk.** The two-host structure is a built-in balance mechanism — one of the safest fits available. |
| Jessica Yellin | News Not Noise | Multi-platform (Substack, YouTube, Instagram, podcast), hundreds of thousands of subscribers; ex-CNN chief White House correspondent; mission to counter "partisan content with trust" | — | **Moderate risk — review before commit.** Some critics read her CNN-anchor background as progressive-leaning despite the stated nonpartisan mission; vet recent segments before pitching. |
| Cleo Abram | Huge If True | 8.1M YouTube subscribers (June 2026); tech-optimism brand, not politically framed | "Can software make democracy easier to participate in" — a tech-innovation story, not a political one | **Lowest risk in the set.** Deliberately apolitical; tradeoff is that the civic-app pitch is a bigger stretch from her usual beat. |
| theSkimm | Historically ~7M "Daily Skimm" subscribers (not re-confirmed for 2026 — keep as historical, not current); long-running nonpartisan "No Excuses" voter-turnout initiative (2016/2018/2020 cycles; 2026-cycle specifics [FILL: confirm current-cycle "No Excuses" status before pitching]) | Position Rostra as the actionable companion to "No Excuses" for the midterms | **Low risk historically**, but "No Excuses" is itself a turnout-mobilization campaign — closer to advocacy than strict news-explainer neutrality. Frame any collab strictly as a neutral utility, consistent with the advocacy-customer premise above. |
| iCivics | Nonpartisan civic-education nonprofit, founded 2009 by Justice Sandra Day O'Connor; reaches up to 145,000 teachers and 9M students with free curriculum | Propose the bill-decoder as a free classroom companion resource / teacher-newsletter mention — aligns with the embeds core-build ruling | **Lowest risk.** Gold-standard nonpartisan pedigree in US civics education. |

#### 2.2.3 Spanish-language outlets

| Name | Profile | What they'd use | Partisan-coding check |
|---|---|---|---|
| Factchequeado | National consortium (Maldita.es + Chequeado); 3M+ reached via 130+ media partners across 25 states + Puerto Rico (2024); 20–25 original pieces/week for ~146 partners across 27 states; 2026 IFCN SUSTAIN grant (~$30,000); runs "ChatMigrante," a WhatsApp immigration chatbot | Cite Rostra's bilingual decoder as a reliable source inside fact-checks, or link from ChatMigrante for "how to contact your rep" | **Low risk.** Explicit anti-misinformation mission, IFCN-vetted. |
| Conecta Arizona | AZ–Sonora border bicultural/bilingual nonprofit, WhatsApp-native (8 groups/lists across 7 countries); ~100,000 total reach (Mar 2026; growth slowing, partly "WhatsApp fatigue") | A WhatsApp-forwardable link to Rostra's AZ rep-lookup/call tool | **Low risk.** Founded to combat misinformation; no advocacy positioning found. |
| El Tímpano | Bay Area (CA) nonprofit serving Latino/Mayan immigrant communities, SMS-based; $350,000 2025 revenue via gov/nonprofit contracts; published a "Civic Partnerships Playbook" | Cite/link Rostra inside SMS replies to "how do I contact my representative" — matches the committed CA-coverage direction | **Low risk.** Service-journalism model, philanthropic/institutional funding, no advocacy stance found. |
| CalMatters en Español | Spanish vertical of CalMatters, a nonprofit, nonpartisan CA-politics newsroom; runs a 2026 CA Voter Guide | Embed Rostra's CA-specific rep lookup/call tool inside the voter guide — directly operationalizes the CA-coverage commitment | **Low risk.** Nonpartisan-nonprofit standard-bearer in state journalism. |
| Radio Bilingüe | National Latino public radio, founded 1980 in CA's San Joaquin Valley; owns/operates **30 stations** (not 29) across AZ/CA/CO/NM/OR/TX **plus 75 affiliates — ~105 total stations across 25 states** (not "29 owned + 102 syndicated" as two additive figures); daily call-in civic show "Línea Abierta" | An on-air "call your rep live" segment reaching TX and CA audiences simultaneously — serves both committed state directions through one partner | **Low risk.** Public-service civic mission; 46-year operating history is explicitly nonpartisan public radio, though its founding roots in 1980s farmworker/activist organizing could read as culturally progressive-coded to some. |
| Puente News Collaborative | El Paso (TX) / Ciudad Juárez bilingual bridge-journalism nonprofit, funded by the El Paso Community Foundation with Microsoft seed funding; partners KVIA ABC-7, Univision 26, El Paso Times, KTEP/NPR; exec editor Alfredo Corchado named 2026 I.F. Stone Medal recipient | A bilingual resource link in border-community reporting on federal legislation — directly satisfies the committed TX-coverage direction | **Low risk.** Explicitly nonpartisan bridge-journalism mission. Confirm Corchado's "executive editor" title is still current before the outreach email goes out. |

*Enlace Latino NC belongs in this list — corrected reach is 500,000+ people reached annually (not ~200,000 as earlier drafted, which understated the org) — but this pass has no verified beat/pitch-angle detail for it. [FILL: beat, pitch angle, partisan-coding check — run a dedicated research pass before adding it to the outreach queue.]*

---

### 2.3 Outreach mechanics

**Embargo etiquette:**
- Reconfirm the embargo date/time in every single touch, no exceptions — this is the one piece of embargo practice actually documented in the source research.
- Front-load the complete press kit (screenshots, numbers, quotes) on first embargoed contact so no reporter has to ask twice.
- Treat "reach out roughly 1–2 weeks ahead of the embargo lift" as generic industry practice, not a sourced claim — no citation in hand supports a specific lead-time number.

**Cadence, running backward from Sept 30 (a Wednesday):**
- T-anchors name target *weeks*, not exact days — send on the Monday/Tuesday inside that week, per the send-window rule below.
- **T-3 weeks (week of Sep 7; send Mon/Tue Sep 7–8):** first, non-embargoed touch to the top tier only (Punchbowl, NOTUS, Tangle, Wake Up To Politics, Semafor) — a relationship-building heads-up offering embargoed early access, not the full pitch.
- **T-2 to T-1 weeks (weeks of Sep 14 and Sep 21; Mon/Tue sends):** the embargoed pitch, full press kit attached, to the complete journalist list.
- **First-touch send window: Monday/Tuesday mornings, 9–11 AM.** This is the corrected finding — the source's actual guidance for the *initial* pitch. "Best days Tue–Thu" was an earlier miscite; drop it.
- **Follow-up send window: 8 AM–noon**, any weekday — this window is specifically the source's guidance for *follow-ups*, not first touches. Don't conflate the two.
- **Follow-up timing:** if no response, one follow-up at roughly 2–3 business days out — the best-supported number in the source (about 3-in-10 journalists name this as their preferred gap). There is no source support for a blanket "3–5 business day" rule; don't cite one.
- **Max touches: two, period** (initial + one follow-up). 62% of journalists want at most one follow-up, and over 50% will block a contact who sends repeated follow-ups — corrected up from an earlier 48% figure. Do not send a third touch under any framing.

**Creators (§2.2.2) cadence:** no embargo cycles — first touch **T-2 weeks (Mon/Tue, Sep 14–15)** with the press kit and an offer of a personal walkthrough; same two-touch cap. Exceptions with partner-editorial lead times: **iCivics and theSkimm, first touch by Sep 1**; a Radio Bilingüe "Línea Abierta" segment needs producer lead time — **open that conversation by Sep 1** as well.

**Spanish-language outlets (§2.2.3) cadence:** first touch **T-3 weeks (Mon/Tue, Sep 7–8)**, framed as a resource-link/partnership conversation rather than an embargoed exclusive — Factchequeado, El Tímpano, and Conecta Arizona operate as ongoing service-journalism partners, and the relationship is meant to outlast launch week.

---

### 2.4 Channel plays

**Show HN.** Effectively one shot — no bump culture; resurface only with a materially new angle (the MCP listing, a v1.1 feature), never a repost of the same submission. Factual, non-editorialized title, no exclamation points or marketing language. Post a top-level maker comment with the solo-builder backstory; don't post from a company-branded username. Rostra's no-accounts-ever design is a natural fit for HN's try-it-without-friction preference. No prior "call your reps" Show HN precedent was found in research — this would be a first, which cuts both ways (novelty helps, no proof of format-fit).

**Product Hunt.** ~30-day prep runway — start prepping around Aug 31 if targeting a Sept 30 launch day. Complete maker profile, assets prepped, supporters lined up for the first ~6 PT hours. Recommended launch window is Tuesday–Thursday, 12:01 AM PT. Sept 30, 2026 falls on a Wednesday, which happens to line up with that window — a coincidence worth exploiting, not an independent PH recommendation for that specific date. No incentivized-upvote language ("check it out," never "please upvote"). Treat launch day as a live, synchronous event — top performers reply within ~15 minutes.

**MCP directory listing as distribution.** Per §1.3, the MCP build runs S9–S12 (Aug 31 – Sep 25): data core, the 5 tools, Upstash rate limiting, then registry/directory submissions the week of Sep 21. (The citability/correction page is a separate, later item — S23, Dec 7–11 — and is not part of any pre-press-moment claim.) Registry/directory sequence: publish `server.json` to the Official MCP Registry (registry.modelcontextprotocol.io, via the `mcp-publisher` CLI, GitHub-auth based) → claim listings on PulseMCP (~19,000+ servers indexed — not a clean "20,000+"; check PulseMCP's live count before publishing a precise number in any kit), Awesome MCP Servers, mcp.so, Glama, Smithery → submit to the Claude Connectors Directory under Government & Nonprofit (currently 8 connectors, zero congressional — an open lane, no OAuth needed). Full sequence runs in parallel with the press cadence and lands **listed by early October** — a second distribution wave landing right behind the Sept 30 press moment.

**Directories and communities.** Submit to Civic Tech Field Guide (civictech.guide) — new manager Daniel Mackisack onboarded ~Jun 26, 2026, a good moment for a fresh submission. Use the "Civic Technology and Open Government" Slack/Discord (~7,413 members) as the standing community channel — treat Code for America's Slack as declining (reportedly winding down "at the end of the year," exact year ambiguous) and don't over-invest there. Submit to the Congressional Hackathon (house.gov, House-run, bipartisan-organized) — not a citizen-acquisition channel, but a credible institutional-trust venue whose explicitly bipartisan framing is a positive signal for Rostra's own positioning.

---

### 2.5 Phase checklists

**Press-kit checklist — complete by T-3 weeks (~Sep 9, 2026), before the first touch goes out:**
- [ ] Walkthrough webm linked (already shipped: `docs/press/walkthrough-demo.webm`, Jul 4, 2026 release)
- [ ] Screenshots: homepage, bill-decode card, rep lookup, call-script panel — EN + ES pairs
- [ ] One-paragraph solo-builder story, tied to the labeled/human-reviewed AI positioning
- [ ] Concrete numbers pulled fresh at kit-assembly time: bills decoded (both languages), calls logged to date — [FILL: pull live counts when the kit is assembled, not before]
- [ ] Bilingual + privacy hooks written as standalone quotable lines
- [ ] "Free replacement for the APIs Google and ProPublica turned off" framing included
- [ ] Public funding-disclosure page live and linked (mitigates left-adjacent-coding risk on any grant/donation mention)
- [ ] Embargo terms doc: identical date/time stated across every contact
- [ ] TX/CA state-coverage commitment stated as a specific line for the Route Fifty, CalMatters, El Tímpano, Radio Bilingüe, and Puente pitches
- [ ] Long-lead partner touches sent by Sep 1: iCivics, theSkimm, Radio Bilingüe producer (per §2.3 cadence)
- [ ] Full kit passes the same nonpartisan-language bar as the product itself — no partisan-coded vocabulary anywhere

**Launch-week checklist — week of Sep 28–Oct 2, 2026 (Sep 30 is the anchor date, a Wednesday):**
- [ ] Noindex removal confirmed live; indexed status spot-checked in Search Console
- [ ] Freshness "data as of {date}" stamp live sitewide
- [ ] Embargo lifts at the agreed time; kit goes out to every embargoed contact simultaneously
- [ ] Product Hunt listing live at 12:01 AM PT (if Sep 30 is the chosen PH day)
- [ ] Show HN post live the same week — factual title, maker comment ready, non-branded username
- [ ] Founder available for synchronous replies (PH comments, HN thread, journalist follow-ups) for the full day
- [ ] Public close-the-loop post on whatever channel carried the Phase 0 dated commitment
- [ ] Donation page + "what your $ runs" page live (surfaces built in S4–S5; requires HCB onboarding complete — paperwork started in Phase 0). If HCB isn't live yet, launch without the ask — never rush a partisan-clean money surface
- [ ] Vercel/Upstash usage dashboards actively monitored for the traffic spike (a Feb-2025-style 100× spike runs ≈$450 in bandwidth for the month — survivable, but watch it in real time)

**Phase 3 checklist — Oct 1–Nov 3, 2026:**
- [ ] 20-email embed outreach sent week of Oct 26 — after S16's free-tier MVP ships; recipients need a live product to click into (14-day read lands ~Nov 9–13)
- [ ] MCP directory listings confirmed live across all registries named in §2.4
- [ ] WhatsApp-shareable per-bill cards live for the ES audience
- [ ] 1,000-logged-calls tracker visible and updated toward the Nov 3 goal

**Phase 4 checklist — Nov 2026–Feb 2027:**
- [ ] Grant applications assembled with the Nov 3 usage number and spike story (Press Forward local chapters, Latino Community Foundation, Trust for Civic Life, Echoing Green if its fall window opened, Mozilla Builders monitored only)
- [ ] Network-deal conversations opened with FiscalNote/VoterVoice-displaced institutions post-election
- [ ] Feb 2027 decision-gate review scheduled against the embed kill criteria and MCP activation criteria already set

---

## 3. Advocacy Integration

> "The moneyed segment (advocacy orgs) buys advocate-data capture — lists, CRMs, conversion funnels. Rostra's constitution forbids building those mechanics for anyone, which resolves the 'would you sell to advocacy groups?' fork without touching partisanship: Rostra sells neutral utilities to institutions that need neutrality, and never builds capture mechanics for any customer. If an advocacy org embeds the free widget, that's fine — it's a utility, like embedding a map; attribution keeps it legibly Rostra's voice, and the ToS bars misrepresenting Rostra's neutrality. What's never for sale: stance-shaping, member capture, unlabeled white-label of the call flow."

This is settled policy, not a live question. What follows is how it operates.

**What's for sale, identically to any institution.** An advocacy org buys the same product at the same price as a newsroom, a library, or a nonpartisan civic nonprofit: the embed tiers already priced in the spec — Free ($0, attribution required), Pro ($29/mo or $290/yr, white-label + AI call-script action panel), Nonprofit ($15/mo, self-attested), or a hand-negotiated network/site license ($500–2,000/yr). There is no advocacy-specific tier, no volume discount tied to "advocates reached," no separate sales motion. Attribution is structural, not optional — the free tier requires it and the paid tier is domain-locked, so a reader sees "Powered by Rostra" no matter who embedded it. Bill-list curation works the same way: an org can choose which bills matter to its mission and push that list to its own members through its own channels — its newsletter, its site, its embed configuration — but the curation is visibly the org's editorial choice sitting on top of Rostra's neutral bill data, not a targeting layer Rostra builds for them. This is the same posture already priced into the network-license motion (LION, INN, LWV national): member-benefit distribution through a channel the org already owns.

**What's never for sale, without exception.** Three things stay off the table regardless of the size of the check: stance-shaping (no "recommended position" feature attached to an org's brand), member capture (no CRM, no advocate-list export, no queryable contact database — the exact mechanic every incumbent in this market prices on, and the reason FiscalNote's collapse and Plural Policy's absorption into SAI360 don't touch Rostra's model at all), and unlabeled white-label (no embed ships without attribution, so no org can present Rostra's decode-and-call-flow as its own independent build). This isn't a case-by-case sales judgment — there is no enterprise tier that unlocks list export, and the ToS makes misrepresenting Rostra's neutrality a violation regardless of who's paying.

**The parked constitutional question that has to resolve before org-facing accounts get designed.** Tenancy today deliberately isn't accounts: capability tokens (128-bit, Stripe-webhook-issued into Edge Config/KV), no accounts database, no passwords, no dashboard. That design already keeps the "no accounts, ever" hard rule clean for institutional customers the same way it's clean for citizens. But the first time anyone proposes an org-facing convenience with a persistent identity — a self-serve billing portal, a login to edit embed theming, anything an org admin signs into more than once — that's a new constitutional question, not a Stripe-integration detail, and it doesn't get resolved inside the PR that builds it. Before any org-facing account or login exists, it needs the same explicit, written resolution the advocacy-customer question got above: what an org account can and cannot hold (no citizen data ever, no cross-org merging, no admin-tracking that resembles what's barred for citizens). Until that session happens, org-facing accounts are parked — not for lack of demand, but because the constitution has to define the shape before the code does.

## 4. Solo + AI Analysis

The original recalculation stands, and fresh landscape research (verified July 2026) confirms it category by category:

> "What solo+AI changes: supply... What solo+AI does not change: demand... Cost-structure failures are genuinely re-openable... [demand failures are not]."

### 4.1 OpenCongress-class (bill intelligence)

OpenCongress itself — launched Feb 2007 with Sunlight Foundation backing, which took over full operations in 2013, retired March 1, 2016 with users redirected to GovTrack — is the namesake failure: a pure bill-database utility has a short competitive half-life once the underlying data commoditizes. Durability lives in the layer on top of the data, not the data plumbing.

**What's missing today:** no one combines plain-language bill explanation, a call-to-action layer, true bilingual EN/ES, and zero data collection in a single free citizen product. Every incumbent is either a raw tracker built for professionals or free-but-thin for citizens, with no action layer either way.

**Competitive landscape, verified:**
- GovTrack.us — solo-operator (Civic Impulse LLC, wholly owned by Joshua Tauberer), ~256k monthly visits (Similarweb, trailing 3 months to May 2026), funded by AdSense + Patreon + a single 2015 Kickstarter ($36,063 from 900 backers) that funded human-written bill-summary content ("GovTrack Insider," now cross-posted to Substack). No Spanish. No call-action layer. Proof a one-person operator can run this category at near-zero cost — and proof of its ceiling.
- Congress.gov — official, free, no revenue model needed; its public API went dark Aug 23, 2025 (unexplained) and was restored by mid-2026 — a live reliability argument against depending solely on official-government uptime.
- LegiScan — free "OneVote" citizen tier + paid "GAITS Professional" for lobbyists/trade groups/agencies; API tiers confirmed at Public (free, 30,000 queries/mo) and Pull (paid, 100,000–250,000 queries/mo); per-state price points (~$25/state, ~$1,000/yr national) could not be confirmed this pass — treat as approximate.
- BillTrack50 — free "Citizen" tier; paid tracking at $1,000/yr one state or $5,000/yr all 50 + Congress ($84/mo, $420/mo); content-partners with IssueVoter on a "Bill of the Month" series.
- Plural Policy (absorbed the Open States project in 2021; brand folded into Plural's own product 2023–24) — free tier intact (search, tracking, legislator lookup, open API/bulk downloads); paid "Basic" $3,500/yr, Professional/Enterprise custom.
- Quorum/Capitol Canary — the dominant enterprise player: $61.1M revenue in 2024, 438 employees (per GetLatka, a self-reported estimate — Quorum is private with no audited public financials; hold as directional). Acquired Capitol Canary Sept 2022; now 2,000+ clients including 50%+ of the Fortune 100; fully custom, sales-call pricing.

**Unique positioning:** the citizen-facing explanation-plus-action layer on top of commodity legislative data is unclaimed. Rostra doesn't rebuild the scraping/data-plumbing moat (LegiScan's, Plural's decades of infrastructure) — it depends on it and differentiates on explanation, action, and trust.

**Who pays:** citizens never do — every free tier here (GovTrack, LegiScan OneVote, BillTrack50 Citizen, Plural's free tier) is ad-, Patreon-, or philanthropy-subsidized. Institutions pay $500–$5,000/yr for professional tiers (BillTrack50, Plural Basic) up to fully custom six-to-seven-figure enterprise contracts (Quorum/Capitol Canary). No mass-market consumer-paid bill-tracking subscription exists anywhere. Rostra's kept paths — network/site licenses ($500–2k/yr) and self-serve embeds ($29/mo Pro) — sit at the floor of this exact institutional-pay band; the ceiling above it requires the capture/CRM layer the constitution forbids, which is why Rostra doesn't chase it.

### 4.2 Ballotpedia-class (plain-language explanation)

**What's missing today:** bill-specific (not election/candidate) plain-language explanation, delivered with genuine bilingual parity, from an organization whose nonpartisanship rests on diversified funding rather than one ideological donor network. Verified white space — nothing found combines all of it.

**Competitive landscape, verified:**
- Ballotpedia — Lucy Burns Institute, 501(c)(3); revenue $8.7–9.3M across FY2022–24 (up from $5.4M in 2019 — real growth), against FY2024 expenses of $9.18M (a deficit year). Editorial staff reported "over 50" as of 2021; more recent verification puts the org at roughly 80-plus people, including 25-plus full-time writers. Not systematically bilingual — a handful of hand-translated Spanish resource pages exist, not parity across ~674,000 articles. One investigative outlet (chaoticera.news, not independently cross-verified — a documented account, not settled consensus) traces $30M+ from DonorsTrust/Donors Capital Fund since 2013 (including $3.9M in 2023 alone) plus grants from Scaife, Bradley, Bradley Impact Fund, Uihlein, and Searle Freedom Trust — foundations documented elsewhere as core conservative-movement funders — and estimates ~65–70% of Ballotpedia's revenue comes from donations rather than ad sales or subscriptions. A real, sourced funding-concentration critique against the category's dominant incumbent.
- IssueVoter.org — the closest analog: nonprofit, fiscally sponsored by Community Partners, plain-language bill summaries with both supporting and opposing arguments, a rep scorecard, donor messaging to reps (no calling/script feature). Analyzed 131 federal bills in 2024. No Spanish. No disclosed revenue or staff size.
- TheyWorkForYou (UK, mySociety) — plain-English vote summaries grouped into named "policies," funded by charitable-foundation grants, donations, and a trading subsidiary. A strong structural analog for "plain-language explanation as a charity-funded public good" — UK-only, English-only, not a direct competitor.
- BillTrack50, Plural, GovTrack — all bolting AI-generated summaries onto professional tracking products in 2024–26, aimed at government-affairs staff, not citizens, none bilingual.
- Factchequeado/Electopedia — bilingual, but elections-process explainers, not bill-by-bill legislative content.

**Unique positioning:** nobody combines Ballotpedia-style plain-language explanation, applied to bills specifically, delivered bilingually, nonpartisan-by-construction, free, and privacy-first. Rostra's diversified funding stack (grants + institutional revenue + citizen donations, §7) is a direct structural answer to Ballotpedia's own documented funding-concentration exposure.

**Who pays:** nobody, directly — this is a pure philanthropy category. Ballotpedia runs ~65–70% on donations (single-source estimate); IssueVoter is donation/membership-funded; TheyWorkForYou runs on foundation grants, donations, and a trading subsidiary. No institutional-paid tier exists anywhere in this category — which is exactly why Rostra's grants and donations paths (§7), not embeds or MCP, carry this category's revenue load.

**Cannot replicate:** Ballotpedia's 50-to-80-plus-person hand-verification operation across every candidate, judicial race, and ballot measure in the country — labor-intensive human research, not an AI-leverageable function. Rostra's scope avoids this trap by design: federal Congress plus limited, explicitly stated state expansion (Texas and California as committed direction; New York optional/later) — a bill-explanation product, not a down-ballot encyclopedia.

### 4.3 ActionButton-class (embeds)

**What's missing today:** a neutral action-utility institutions can embed without buying into a capture-mechanics business model. No existing vendor separates "the button" from "the list it builds" — the list is the business in every case checked.

**Competitive landscape, verified:**
- ActionButton/Speakable — founded by Jordan Hewson; $2M seed (Crunchbase, May 2016), though the company told TechCrunch in Dec 2020 it had raised $2.5M since inception. Launched ~Oct 2016 on Guardian US and Vice, with NGO partners Amnesty International, CARE, and UNHCR corroborated (other frequently-cited partners did not surface in verification and should be treated as unconfirmed). Reached 10 million cumulative actions by December 2020 (5.2 million in 2020 alone). NationBuilder acquired the company June 23, 2021 — but Hewson had already pivoted in December 2020, before the acquisition, launching "actionable" as an explicit B2B SaaS for brands and nonprofits. Both actionbutton.org and actionable.org are live in 2026, marketing to grassroots organizers and brands respectively, still citing what read as stale 2020–22 headline stats.
- New/Mode — 600+ organizations, 80 million messages sent (confirmed). Current pricing: Individual (free), Grassroots ($44/mo), Teams ($189/mo), Movement Builder+ (from $349/mo) — supersedes a stale "$99/mo" figure no longer on their live pricing page.
- Action Network — hard, public per-unit pricing: $1.25 per 1,000 emails/month ($15 minimum) or $7.50 per 1,000 actions taken/month ($15 minimum).
- Resistbot — structured as a 501(c)(4) ("Resistbot Action Fund"), donations processed through ActBlue Civics, Inc. — legally distinct from the partisan ActBlue platform but brand-adjacent, exactly the risk Rostra's HCB-hosted, non-ActBlue-class donation design (§7) is built to avoid. Cited operating cost ~$40k per nationwide push (single-source figure, not independently re-verified this pass).

**Unique positioning:** Rostra can sell the neutral call-flow/embed utility itself to institutions — the advocacy-customer premise in §3 — without ever selling the capture layer that is every other player's actual product. No competitor can credibly make that offer, because separating the button from the list is not how any of their businesses work.

**Who pays:** institutions only, everywhere checked — contact-volume-based SaaS ($1.25–$7.50 per 1,000 actions, Action Network) or fully custom enterprise (New/Mode's top tier, Quorum/Capitol Canary). The one donation-funded, consumer-facing exception, Resistbot, still routes money through partisan-brand-adjacent rails and monetizes a premium tier on top — not a model Rostra can copy cleanly.

**The honest demand caveat — the risk this ruling is knowingly accepting.** ActionButton/Speakable reached 10 million cumulative actions across Guardian, Vice, and NGO partners including Amnesty, CARE, and UNHCR, and still could not sustain an independent publisher-facing business — it pivoted to B2B brand SaaS before its own acquisition even closed. That is direct, well-funded precedent for the exact bet embeds now represent: no newsroom has ever asked for a civic embed, and 10 million real actions wasn't enough demand to keep the free-to-publisher version of this alive on its own. Making embeds a core build component does not repeal that history — it accepts it. The bet is that a 10–100x cheaper cost structure lets Rostra survive indefinitely at a small fraction of ActionButton's scale, riding whatever demand shows up rather than needing enough demand to fund a company. Cost-structure failures are re-openable by cheaper building; ActionButton's was a demand failure, and demand failures are not re-openable by cheaper building. The 20-email test still runs — not as a gate on whether embeds get built, but as the first real read on where on that spectrum Rostra actually lands.

---

## 5. Spanish Callers

### The honest capacity picture

There's no clean answer to "will the person who picks up speak Spanish" — only dated, adjacent proxies:

- The only survey of Members' own language ability (JNCL-NCLIS, 2013; 540 offices contacted, 65.6% response) found 35% of respondents claimed some second-language ability, 20% claimed fluency, and Spanish was 54% of all languages claimed — 49% of Senators vs. 32% of House members claimed any second-language ability. This measures the Member, not the intern answering the phone, and it's now 13 years stale with no refresh found.
- The best institutional proxy is a Univision News analysis (Sept 1, 2017) of official websites/social media: only 85 of 534 members' (15%) websites carried any Spanish, 34 of those via raw Google Translate. Of 34 House members in >50%-Hispanic districts, 15 offered no Spanish on their website and 16 posted zero Spanish social content in the sample month. Only 18 of 292 Republican members offered any Spanish. Dated (2017), but the most concrete evidence that most offices — including many in heavily Hispanic districts — don't institutionally invest in Spanish capacity.
- Anecdote, not data: Rep. Grace Napolitano, Roll Call (2011) — "A lot of the constituents feel more comfortable speaking to someone who can speak their language because they're able to articulate a little better." Member-level, 2011, not a staff-capacity claim.
- No source anywhere answers "do the staffers who actually answer the phone speak Spanish, system-wide, today." Treat capacity as real but uneven and unaudited — concentrated in majority-Latino districts and Latino-member offices — not a number to promise users.

### The voicemail play

Voicemail is not a fallback — it's tallied identically to a live call, and it's the lower-anxiety option for a non-fluent speaker:

- 5calls.org's own guidance: "Congressional offices check voicemail every day and will tally your message just like a call."
- CMF's 2011 survey (260 staff, Oct–Dec 2010; full PDF read directly) puts phone calls at **86% total influence** on an undecided Member (14% "a lot" + 72% "some") — right between telephone town halls (85%) and individualized email (88%), well above any form-letter channel. That report contains zero mentions of "Spanish," "language," or "LEP" — a confirmed silence, not a failed search.
- CMF's 2017 follow-up (≈1,200 staff, nine surveys, 2004–2016) found 91% of staff say local-impact detail is helpful, but only 9% of constituents actually include it — personalization is the scarce, high-value ingredient, not the language it's delivered in.
- Verification mechanics, corroborated across independent secondary sources: staff ask for name + ZIP (or full address, since ZIPs can span districts) to confirm constituency, log a stance tag, and roll tallies up daily/weekly.
- Volume reality check: during the Feb 2025 call surge, Senate-side volume reportedly spiked to roughly 1,600 calls/minute against a ~40/minute baseline, with Senate voicemail boxes holding only ~1,000 messages before filling (AP-wire coverage as carried by Washington Times/WOSU; PBS NewsHour; Daily Beast). Separately, Washingtonian (Feb 6, 2025) documented specific House offices (Reps. Beyer, Holmes Norton, McClain Delaney) going from ~50 calls/day to 150+/day, ~600 overnight. Rep. Suozzi, CBS New York: "We keep track of the calls. I know exactly how many calls come in. It's reported to me every day" — his office's volume rose from ~25/day to 250+/day, and an aide confirmed "every voicemail is listened to." **None of this coverage — any outlet — mentions Spanish speakers or language access at all.** Practical implication for the product: when DC lines are saturated, route users to the district/local office number instead of retrying DC.

### Script patterns — original synthesis, explicitly labeled as such

I found no precedent anywhere — not 5 Calls, not Resistbot, not Common Cause (not exhaustively checked, but no evidence found), not Voto Latino (confirmed: its "Call Your Representatives" page has an "Español" toggle but no actual script, just a link out to EveryAction) — for a bilingual script purpose-built for calling Congress. Everything below is Rostra's own reasoned design, not a validated industry pattern, and should be labeled that way to users.

The logic: the tally-critical fields (name, constituency, ZIP, topic, stance) are short, formulaic, and safe to deliver in English even for a non-fluent speaker — a staffer who understands nothing else can still log a valid entry from those words alone. The substantive "why this matters to me" sentence is where influence actually lives (per the CMF personalization data above), and forcing that into a second language a caller doesn't command produces the worst outcome: hardest to say, least likely to land. So Rostra should offer two patterns, not one bet:

**Option A — Hybrid (recommended default): English phonetic preamble + Spanish body**

> "Hello, my name is [Name] — *OH-lah, my nay-m is.* I am a constituent — *ai am ah CON-stih-tuent.* My zip code is [ZIP]. I am calling about [Bill]. I ask Representative/Senator [Name] to support / oppose it — *sup-ORT / uh-POHZ.*"
>
> "Le dejo este mensaje en español porque prefiero expresarme en mi idioma. [Razón personal breve — cómo le afecta esta ley a usted o su familia]. Gracias por su tiempo. Otra vez, mi nombre es [Name], código postal [ZIP]."

**Option B — Full Spanish (for callers who'd rather not switch languages mid-message):**

> "Buenas tardes. Mi nombre es [Nombre]. Soy elector/a de este distrito, código postal [ZIP]. Le llamo sobre [Proyecto de ley]. Le pido al Representante / a la Senadora [Nombre] que vote a favor / en contra. [Razón personal breve]. Gracias por su tiempo. Mi nombre es [Nombre], código postal [ZIP]."

Both must ship with an explicit, visible caveat — an extension of Rostra's existing "AI content is always labeled" norm to "capability claims are always labeled": **Rostra cannot confirm whether this office has Spanish-speaking staff, and no evidence found — anywhere, including the extensive 2025 call-surge coverage — confirms offices translate Spanish-language voicemails.** Never assert either "your Spanish message will be understood" (unverifiable) or "always call in English" (defeats the tool's purpose and violates bilingual parity).

Background context, kept neutral per the nonpartisan constraint: EO 14224 (Mar 1, 2025) designated English the official U.S. language and revoked the prior LEP-access mandate for federal executive agencies — it doesn't reach the legislative branch, so it has no direct bearing on how a House/Senate personal office runs its phones. H.R. 7223 and H.R. 8604 (introduced Jan 22, 2026, sponsors Meng/Chu/Goldman/Vargas + a Padilla Senate companion; confirmed via GovTrack, govinfo, and sponsor press releases since congress.gov blocked direct fetch) would restore federal-agency language-access obligations — again, not congressional offices' own phone practice. Mention this only as landscape context, never as a claim about how Congress itself operates. Scale note for framing: roughly 42 million people speak Spanish at home nationally, per Census-sourced reporting (the LEP subset is reported around 29.6 million, though a smaller ~25M figure appears in some advocacy sources and the discrepancy isn't reconciled here).

### Product implications for the script generator

For ES-locale users, the generator should offer, on top of the existing 3-stance × 2-locale matrix:

- A choice between Option A (hybrid) and Option B (full Spanish) — not a forced default — with one line explaining the tradeoff.
- The capability-caveat label above, shown adjacent to the script itself, not buried in a help page.
- Voicemail framed as the *recommended* path for this audience, not an apologetic fallback — normalizing after-hours calling reduces the anxiety of a live conversational exchange in a non-native language.
- Where the split-ZIP/district lookup already resolves a caller's district (existing product flow), surface the district office number as an alternative to the DC line — flagged as "you can also try," not a guaranteed-better option, since no per-office Spanish-capacity data exists to back a stronger claim.
- The English phonetic respellings need a native/fluent check, not just the Spanish grammar — phonetic-for-Spanish-speakers respelling is its own small linguistic task.

### The gate: ES-review bandwidth

These two script variants are new, call-driving Spanish content — not translated UI strings — so the constitution's "AI content is human-reviewed in both languages before it drives a call" applies at full force, with no workaround. Today that review is Colby's personal spot-check (the same interim substitute the plan already uses in U7/U13); the scaled ES-reviewer hire is not yet in place, and its adopted trigger ("third parties redistribute ES text") fires in the Sept–Oct 2026 window — the same window nominations and state-expansion would each add their own ES load. This script surface adds to that same finite pre-hire capacity and must be logged in the cumulative tally the ledger calls for — not cleared as an isolated EN/ES-parity checkbox. Ship only after Colby's spot-check pass on both script variants; do not let this surface, or any other, be the one nobody added to the sum.

---

## 6. Donation Tool

This is the donations leg of the funding ruling (grants + donations + institutional revenue, no venture funding). It reverses the prior no-donations posture — **by Colby's explicit ruling** — and must ship inside the same guardrails that make every other Rostra surface constitution-clean.

### Why HCB, and why hosted-off-infra is the only shape that fits

The constitution's hard rule — no server-side citizen data, ever — makes the processor choice almost mechanical: the donation flow must never touch Rostra's own Vercel project. **HCB (Hack Club's fiscal-sponsorship arm) is the strongest fit on every axis that matters here:**

- Flat **7% of donations**, stated as the only fee — no legal, startup, transaction, card-issuing, subscription, or check-deposit fees layered on top.
- Fiscal sponsor is **The Hack Foundation**, a 501(c)(3) (EIN 81-2908499, West Hollywood, CA; confirmed via Charity Navigator, GuideStar, CauseIQ), sponsoring ~1,500 projects since opening to outside groups in 2018.
- Each sponsored project gets its own **hosted donation page on `hcb.hackclub.com`** — the project's own name/logo up top, a disclosure line ("[Project] is fiscally sponsored by Hack Club, a 501(c)(3) nonprofit," EIN printed), one-time/monthly options, donor name/email/message fields, an opt-out for public display, and a link to a transparent transaction ledger. Donors get an immediate deduction because they're legally giving to Hack Club, which re-grants to Rostra.
- HCB **auto-files Form 990** — no separate nonprofit tax-filing burden.
- Because the entire donor experience lives on `hackclub.com`/`hcb.hackclub.com`, no card data, name, or email is ever processed or logged by Rostra's Next.js app. A citizen clicking "Donate" leaves Rostra's origin entirely — this is the cleanest available way to satisfy "hosted off-site, zero payment/PII on our infra," cleaner than embedding HCB's iframe on a Rostra page, so the link should point out (new tab), not iframe in.

Alternatives considered and set aside for now: Givebutter, Stripe Payment Links, and Open Collective are checkout layers, not tax-deductibility sources — none confers 501(c)(3) status without a sponsor's EIN behind them, and Open Collective's own US fiscal-sponsorship arm shut down Sept 30, 2024, pointing departing groups toward HCB by name. Givebutter can sit on top of HCB's EIN later as a nicer front end (Phase 2, not now) via its fiscally-sponsored-org verification flow.

One soft, non-partisanship consideration worth a plain-language line in the copy: donors will see "fiscally sponsored by Hack Club," a teen-coding-education nonprofit. Hack Club itself is apolitical — not a nonpartisan-coding risk — but an adult donor giving to a government-accountability tool may find the juxtaposition odd unless the ask copy briefly explains fiscal sponsorship ("Rostra doesn't have its own 501(c)(3) yet, so gifts are made tax-deductible through our sponsor").

**Hard exclusion, non-negotiable:** ActBlue, ActBlue Civics, WinRed, and Anedot must never appear near Rostra's donate flow, in code, in a footer link, or inside a fiscal sponsor's stack. ActBlue is the Democratic party's dominant small-dollar rail (and is what 5 Calls itself routes to, via its 501(c)(4) status — a trap to avoid, not a model to follow); WinRed is its RNC-controlled mirror; Anedot is conservative-owned and, while it denies being an "anti-Trump platform," is documented as the processor establishment-skeptical Republicans moved to under WinRed pressure. None of the four has a politically unbranded user base the way HCB/Stripe/Givebutter/Open Collective do — that neutrality is exactly why the latter group is safe and the former group isn't.

### Placement: no interruption, ever

Rostra's credibility on this feature **is** the no-ask experience during the actual task — nobody should ever see a donate prompt between choosing a stance and finishing a call. Placement is exactly two spots:

- A persistent **footer link** ("Donate" / "Donar"), present site-wide, quiet, never a banner or modal.
- A dedicated **About/Support page**, where the fuller ask copy and funding-independence disclosure live.

Model this on Ballotpedia's `/Support` page (donation copy stated entirely in outcome terms — "your gift funds this specific civic-data output" — never emotional or urgency-based, with a monthly-donor tier and a printed EIN for donor convenience) and GovTrack's charter language, which states funding independence in the same breath as its "about" framing: "We do not accept grants from or have any relationship with partisan organizations." **Do not** model this on Wikipedia's interruption-banner pattern ("please don't scroll past this") — that's the opposite of the no-interruption promise the product is built on. 5 Calls' footer/header link *placement* is fine structurally; its processor choice is the part to reject.

### Ask copy

**Footer link (EN):** Donate
**Footer link (ES):** Donar

**About/Support page (EN):**
> Rostra is free, ad-free, and takes no partisan money. Your gift helps us: track every bill moving through Congress each week, keep the plain-language decodes current and human-reviewed, and keep call scripts free in English and Spanish. Rostra takes no advertising, no partisan grants, and stores no donor political activity — gifts are tax-deductible and processed off Rostra's own servers by our fiscal sponsor, The Hack Foundation, a 501(c)(3) nonprofit.

**About/Support page (ES):**
> Rostra es gratuito, sin anuncios y no acepta dinero partidista. Su donación nos ayuda a: dar seguimiento a cada proyecto de ley en el Congreso cada semana, mantener actualizadas y revisadas por personas las explicaciones en lenguaje sencillo, y mantener gratuitos los guiones de llamada en inglés y español. Rostra no acepta publicidad, ni subvenciones partidistas, ni almacena la actividad política de quienes donan — las donaciones son deducibles de impuestos y son procesadas fuera de los servidores de Rostra por nuestro patrocinador fiscal, The Hack Foundation, una organización 501(c)(3).

No suggested-amount tiers, no countdowns, no "act now" language — consistent with the no-urgency-theatrics rule and with Ballotpedia's outcome-based model rather than Wikipedia's personalized-urgency one.

### Setup checklist

1. **HCB application** — submit at `hcb.hackclub.com/applications/new` (or via `hcb@hackclub.com` / +1 844-237-2290); confirm fiscal-sponsorship terms and EIN 81-2908499 usage before publishing any donor-facing copy.
2. **Page config** — set up the hosted donation page (slug should use the settled public name, not a pre-rename placeholder, to avoid rework), enable one-time + monthly options, confirm the disclosure line renders with the EIN.
3. **Link wiring** — footer link + About/Support page link, both pointing out to the HCB-hosted URL in a new tab; no embedded iframe, no payment fields rendered inside Rostra's own pages.
4. **Disclosure line** — footer and Support page both carry the fiscal-sponsorship + EIN + nonpartisan-funding-commitment line verbatim (or near-verbatim) as drafted above, in both languages, published in the same change per bilingual-parity rule.
5. **[FILL: Colby confirms final donation-page slug/name once the rename lands, and reviews final copy for tone before publish.]**

### This reverses a prior ruling — with guardrails

Colby's ruling adds a citizen donation tool where the prior posture was no donations at all. The guardrails that make this tasteful rather than a drift toward the thing Rostra explicitly isn't: hosted entirely off Rostra's infra (no payment/PII ever touches the product), placed only in the footer and About page (never interrupting the call flow), copy that is outcome-based and non-urgent (no Wikipedia-style personal appeals, no ActBlue-style branding), and a standing exclusion of every partisan-coded processor regardless of how the deal is packaged.

---

## 7. Funding Decision

**Venture funding is dropped, entirely, as a funding path.** Not deprioritized — off the table.

**Why:**
- The one active, recurring check-writer in exactly this category — Higher Ground Labs' rolling Fund V, ~$100k checks — is explicitly progressive-Democratic. Appearing in its portfolio breaks nonpartisan-by-construction permanently, and there is no comparably active nonpartisan-coded fund to substitute; this isn't a hypothetical tradeoff, it's the actual shape of the available capital in civic tech.
- The constitution caps the venture-shaped upside structurally, independent of who's willing to write a check. Venture wants a real-company outcome — recurring revenue at scale, usually built on a data or capture layer. Every civic-tech company that has actually reached venture scale in this landscape (Quorum, ~$61.1M revenue/438 employees per GetLatka; FiscalNote, pre-collapse) got there by selling institutional capture-and-analytics products — the exact mechanic Rostra's hard rules forbid building for any customer, including advocacy orgs (§3). The one venture-shaped structure previously left open — spinning the institutional API/data layer into a separate C-Corp with the citizen product as top-of-funnel — is dropped along with venture funding itself. There's no remaining structure where outside equity and the constitution coexist.
- The market is the cautionary tale, not a hypothetical: FiscalNote — a public, growth-capital-fueled civic-data company — was delisted in April 2026, posted FY2025 revenue of $95.4M (down 21%), carries roughly $123–126M in debt, faces going-concern doubt, and has a forbearance agreement expiring 2026-07-21. Capital-driven growth ambitions in this exact market did not prevent collapse; if anything they set the size of the fall. And the venture-funded consumer side of civic tech (Brigade, ~$40–50M from Sean Parker, ~200k peak users, founders' own verdict "nobody came"; Causes, 190M registered users, never sustained; iCitizen, $10M+, dissolved insolvent) all died of demand, not undercapitalization — venture money doesn't buy the one thing that actually kills civic-tech products, and it conflicts with the one asset Rostra depends on instead: legible nonpartisan credibility.

**What's left — the whole stack:**

- **Grants** — the real early money, pursued post-launch, unlocked by HCB fiscal sponsorship (7%, resolves the 501(c)(3)-only-funds problem in days, no entity conversion). Funder classes, from verified research:
  - Press Forward local chapters — rolling 2026 calls; the "Closing Coverage Gaps" call accepts for-profit newsrooms directly, others need the fiscal sponsor.
  - Latino Community Foundation — record $12.9M grantmaking in 2025, $2.6M+ specifically to civic power (through Q3 2025); the bilingual wedge is squarely their thesis, and stating Texas and California as committed state-coverage direction strengthens this pitch specifically — both are large Latino-population states LCF already funds into.
  - Trust for Civic Life — $25k open-application civic-experiment grants, explicitly nonpartisan; needs the rural frame (bilingual district-office/border-community angle fits).
  - Echoing Green — $100k over 18 months, recoverable grant, for-profit eligible; fall 2026 window expected but not yet announced — monitor, don't plan on.
  - Mozilla Builders — up to $100k, funds individuals, open-source AI; no 2026 cohort announced — monitor only.
  - EV: ~$10–30k over 18 months, arriving after the midterms — the fall itself has to be ridden on bootstrap economics, not grant timing. Never fund recurring costs with grant money; mitigate left-adjacent-by-association coding with a public funding-disclosure page.

- **Donations** — citizen-facing, HCB-hosted checkout, neutral processor, explicitly not ActBlue-class (see §4.3 on Resistbot's brand-adjacency risk as the cautionary case). Full mechanics and the "what your dollar runs" framing are in §6. 18-month realistic range: $0–5k. Risk to manage: don't couple the ask to outrage-cycle timing beyond the one launch-moment push.

- **Institutional revenue (embeds/MCP tiers)** — now a core build component, not gated on a demand test as a build/no-build decision; the 20-email test still runs, but as GTM motion and a prioritization signal (§4.3). Self-serve embeds ($29/mo Pro, $15/mo nonprofit): $0–10k ARR range. Network/site licenses ($500–2,000/yr, hand-negotiated): $1.5–6k from 2–4 deals. MCP direct revenue is $0 by design — a distribution asset, not a revenue line — with a dormant `X-Rostra-Key` header that can activate institutional keyed tiers ($0–5k) at the Feb 2027 decision gate if usage justifies it.

- **HCB fiscal sponsorship** is the legal and financial home underneath all three money paths above, not just a grants mechanism. It's what lets a for-profit-adjacent build accept 501(c)(3)-restricted grant funds and run tax-deductible donations within days, with no entity conversion, at a flat 7% fee. Paperwork starts now (Phase 0); everything else in this section depends on it existing before the first check or the first donation.

Net: bootstrap costs (~$700–1,500 over 18 months) are covered by default from any one of these; the honest 18-month revenue range remains $0–5k pessimistic / $15–40k base / $70–130k good — decomposed by line: grants $0–50k (EV ~$10–30k), network licenses $1.5–6k, self-serve embeds $0–10k ARR, institutional keys $0–5k, donations $0–5k. None of it required, or now permits, outside equity.

---

## 8. Embed/Widget Assessment

**Status: no embed exists in the codebase today. Press-ready = NO.**

What exists is a specification and a hardening ledger — not shipped code. There is no `app/embed/*` route, no CSP carve-out, no referrer-ingestion pipeline, no ZIP-only mode anywhere in the tree. What's real: `deepen-security` findings F1–F7 and the buildout plan's U15 unit approach, both fully specced, neither built. Calling this "press-ready" today would be describing a spec as a product.

**The seven hardening deltas the spec must close before build starts** (all load-bearing, none optional — deepen-security F1–F7):

| # | Requirement | Why |
|---|---|---|
| 1 | `frame-ancestors 'self'` site-wide; sole carve-out `app/embed/*` (any host + its own minimal embed CSP) — ships **in U15**, not deferred to U16 | Next.js sets no clickjacking header by default; today the entire site (call modal, stance selection) is frameable |
| 2 | ZIP-only embeds — street-address refinement excluded from iframes, links out to the main site | Address entry on an arbitrary third-party page is an overlay/phishing surface |
| 3 | Referrer truncation at ingestion — registrable domain + count only, truncated before persistence; Referer only *nominates* candidate domains, Colby manually confirms each live install before it counts toward ≥2/20 | Referer is client-controlled/forgeable — a single spoofed header shouldn't trigger a 4-week build |
| 4 | Two separate Upstash databases (caller-keyed counters vs. `slug:stance:locale` content cache) — not just namespaces; enforced by CI grep-gate + AE5 runtime invariant + a request-shape invariant (no stance/content identifier in any caller-originating URL, across `/api/script`, MCP, and embed) | A single DB's command log would temporally re-pair caller and content even with clean key separation |
| 5 | Salt: ≥128-bit CSPRNG, never date-derived, atomic create + 24h TTL, loud-failure salt-age verifier in the same unit | 32-bit IPv4 space brute-forces a weak salt in seconds |
| 6 | `stance:*` / `calls:total:{date}` accepted as spoofable-by-design; mitigations are hashed-IP limits + daily bucketing only | These are unauthenticated public writes — no stronger guarantee is honest |
| 7 | Pre-generation authenticates via build-time secret or direct Upstash write — never a public request flag; an unauthenticated pregen marker is rejected loudly and rate-limited normally | Forecloses a free rate-limit bypass + Sonnet-spend trigger |

**Ruling change to apply here:** under the original plan (R16), embeds "build only past the gate" — i.e., the demand test decided *whether* to build. That's superseded. Embeds are now a **core build component**; the 20-email/LION outreach still runs (KTD-8: sends the week of Oct 26, immediately after the free-tier MVP ships in S16, with the 14-day Referer-nominate + manual-confirm read landing ~Nov 9–13), but it's repositioned as a **GTM motion and prioritization signal** — it informs how much further investment the paid tier gets, not whether the build happens at all.

**Who this is for, stated once, in Colby's words (verbatim, settled):**

> The moneyed segment (advocacy orgs) buys advocate-data capture — lists, CRMs, conversion funnels. Rostra's constitution forbids building those mechanics for anyone, which resolves the "would you sell to advocacy groups?" fork without touching partisanship: Rostra sells neutral utilities to institutions that need neutrality, and never builds capture mechanics for any customer. If an advocacy org embeds the free widget, that's fine — it's a utility, like embedding a map; attribution keeps it legibly Rostra's voice, and the ToS bars misrepresenting Rostra's neutrality. What's never for sale: stance-shaping, member capture, unlabeled white-label of the call flow.

**Path to press-ready — sprint mapping** (today: 2026-07-05):

| Phase | Window (aligned with §1.3 — the single authoritative calendar) | Output |
|---|---|---|
| Spec-hardening deltas | Done | The 7-item ledger above — already specced via `deepen-security` + U15 approach, zero incremental PRs |
| Prerequisite: Upstash two-DB build | S11 · Sep 14–18 | Item 4 above wires into the AE5 invariant; KTD-7 requires Upstash landed before any press-visible embed moment |
| Free-tier build | S13–S16 · Sep 28 – Oct 23 | Loader, rep-lookup + bill-card widgets, privacy CI gates, configurator + docs — the artifact outreach recipients actually try |
| Outreach send + read (KTD-8) | Sends week of Oct 26; 14-day read → ~Nov 9–13 | Referer-nominated + manually-confirmed installs — GTM/prioritization signal for paid-tier scope, not a build/kill gate |
| Hardening + paid tier (V1.1) | S17–S21 · Oct 26 – Nov 27 | Frame-ancestors split posture, ZIP-only, Stripe tenancy, action panel, impression counts, pregen auth — F1–F7 all shipped and CI-verified |
| **Press-ready** | ~Early Dec 2026, after the S17–S21 hardening review | By construction this lands *after* Sept 30: the launch-window press story runs on the citizen product + MCP, and embeds join the press narrative once hardened. If embeds must be in the Sept 30 story instead, S13–S16 has to swap ahead of the MCP block — a §1.3 re-sequencing decision, not the default |

Scheduling caveat: the plan's own stated velocity is **~7 PRs/week** (Goal Capsule) — used for the math here — but git shows **~5/week** merged over the last 4.6 weeks, so build windows above may run ~25% longer in practice.

---

## 9. Deployment Strategy

### 9.1 Technical/Infra Scaling

**(a) Vercel Pro — confirmed, paid. What it buys the spike posture.**

- $20/month platform fee (1 deploying seat) + $20/month usage credit; unlimited free read-only Viewer seats.
- Included, reset monthly: 1TB Fast Data Transfer (then $0.15/GB), 10M Edge Requests (then ~$2/1M), Fast Origin Transfer metered from the first byte at $0.06/GB (confirmed directly against Vercel's regional-pricing docs — no longer flagged as unconfirmed).
- Fluid Compute on Pro has **no included allotment** (unlike Hobby's 4hr Active CPU / 360GB-hrs / 1M invocations) — everything is on-demand, offset by the $20 credit: $0.60/M invocations, Active CPU $0.128/CPU-hr (`iad1`), memory $0.0106/GB-hr. Active CPU billing *pauses* while a function waits on an external call, so `/api/script`'s wall-clock time mostly doesn't bill as CPU — the Anthropic round-trip is close to free from Vercel's side.
- WAF: DDoS mitigation, IP blocking, and custom rules are free on every plan. Pro gets up to **40 rate-limit rules/project** (vs. 1 on Hobby), metered at ~$0.50/1M allowed requests (confirmed, not a secondary-sourced guess).
- Read-through: the corpus is **1,667 bills → ~3,348 SSG pages** (2 locales × 1,667 bill pages + 14 static routes), not the ~1,000 figure in `CLAUDE.md`'s architecture summary — that figure is stale and should be corrected there separately. At 50–100k spike-month visits, FDT and Edge Requests stay far under the included allotments even generously modeled, and the three dynamic routes' compute is trivial. Realistic Vercel bill: **~$20/month flat**.
- What this buys for spike posture specifically: WAF rate-limiting (40 rules/project) is available **today**, before Upstash ships — a same-day edge-level lever (deny/challenge, doesn't consume FDT/request quota) if a spike hits before the in-memory rate-limit gap in (c) is closed.

**(b) The "I'm concerned" button — cost assessment and recommendation.**

It's 1 of 3 stance lanes (`support` / `oppose` / `undecided`, framed in-product as *concerned*). Per-generation marginal cost, grounded in the actual code (`max_tokens: 520`, 60–90 word target, ~200 realistic output tokens — not the ~900-token planning figure, which is 4–7x the code's own ceiling):

| Assumption | Intro pricing ($2/$10, through Aug 31) | Standard pricing ($3/$15, Sept 1 on) |
|---|---|---|
| Code-realistic (200 out-tok) | ~$0.0028/gen | ~$0.0042/gen |
| Directive's inflated (900 out-tok) | ~$0.0098/gen | ~$0.0147/gen |

Dropping the lane cuts generation cost by exactly ⅓ — real, but small in absolute terms: it saves cents per night on the top-10 pregen run in (d), and single-digit dollars a month even at spike volume in (e). Cache-hit reality (per-instance `Map`, no content-version key, cold Fluid Compute instances each miss independently) doesn't change this math — removing 1 of 3 stances reduces the combo space uniformly regardless of hit rate, so the saving stays proportionally the same, and small.

Non-cost side: the *undecided* lane isn't a simple polarity flip — the prompt structurally differs (name the one concern, ask that it be recorded, explicitly "never as live questions... must not expect answers or a conversation"). It's the only in-product path for a caller who hasn't taken a side, which is the direct product expression of "nonpartisan by construction." Cutting it removes the sole on-ramp for the undecided.

**Recommendation: keep it.** The ⅓ saving is real but trivial in dollars against a mission-load-bearing feature. This was a cost question with a cost answer: the numbers say it isn't a cost problem.

**(c) Upstash — status: not built. Rebuild assessment.**

Today: in-memory only. `/api/script` and `/api/district` each keep a per-instance `Map<string, number[]>` for rate limiting (8/10min/IP and 10/10min/IP respectively), plus `/api/script`'s separate in-memory `cache` Map for generated scripts. No Upstash package anywhere in `package.json`.

Why it needs rebuilding: Fluid Compute spins up multiple concurrent instances under load, each with its own empty `Map`. Both claims the current code makes — "8 requests/10min/IP" and "popular bills cost one generation total" — silently fail once traffic is spread across more than one instance (detailed in (e)).

Two separate Upstash databases are required, not a shared one with namespaces — per the security ledger (item 4/KTD-3): caller-keyed rate counters and `slug:stance:locale` content cache must be physically separate, because a single DB's command/REST log would temporally re-pair caller and content even if the key design keeps them apart. Enforced by a CI grep-gate (`scripts/check-key-namespaces.mjs`), an AE5 runtime invariant, and a request-shape rule (no stance/content identifier ever in a caller-originating URL path/query, across `/api/script`, MCP, and embed routes — U6, U12, U15 all wired into this).

Salt requirements (item 5): ≥128-bit CSPRNG, never date-derived, atomic create + 24h TTL, a loud-failure salt-age verifier shipped in the same unit. Vocabulary discipline: these are "short-lived rate-limit counters," never "anonymized" — hashing a small IP space is pseudonymization, not anonymization.

Cost: the free plan supports **up to 10 free databases per account** (not 1 — don't let a false single-DB scarcity shape this decision; two free DBs for the two required purposes cost nothing). Beyond free-tier volume, pay-as-you-go is $0.20/100k commands ($2/M); Fixed is $10/month for 250MB/50GB bandwidth. Modeling the workload (rate-limit check + cache GET/occasional SET — **2–5 commands/request is this drafter's own estimate, not an Upstash-documented figure; the "deny-list adds 2 commands" detail some research surfaced is unsourced and dropped**):

| Daily requests | Commands/mo (n=3 est.) | PAYG cost | Fixed ($10/mo, unlimited) |
|---|---|---|---|
| 10,000/day | 900,000 | ~$1.80 | worse |
| 50,000/day | 4,500,000 | ~$9.00 | about even |
| 100,000/day | 9,000,000 | ~$18.00 | cheaper |

Breakeven ≈ 56,000 req/day. Realistic monthly cost: **~$1–30/month**, likely near the low end at current traffic (two free DBs cover both purposes at zero cost until volume crosses breakeven), moving to the $10 Fixed tier once it does.

**(d) Pre-generation for top-band bills — recommend top 10.**

Top 10 bills (via the existing `getTopActions(n)` helper, already ranked by `effectiveUrgency`) × 3 stances × 2 locales = **60 scripts/night**.

| N | Generations/night | Cost/night, code-realistic (intro / standard) | Cost/night, directive's inflated assumption (intro / standard) |
|---|---|---|---|
| 10 | 60 | $0.17 / $0.25 | $0.59 / $0.88 |
| 50 | 300 | $0.84 / $1.26 | $2.94 / $4.41 |

At 30 nights: top-10 runs **~$5–7.50/month** (realistic) or ~$18–26/month (inflated assumption); top-50 runs ~$25–38/month or ~$88–132/month. Routing through `messages.batches.create` (the same async pattern already used by `backfill-search-inputs.mjs`) applies Sonnet 5's 50%-off batch discount and roughly halves every figure above.

**Why top-10 beats top-50 is not the dollar cost — both are cheap.** It's architectural exposure. Per the codebase audit behind (c) and (e), pre-generating anything today requires building, from scratch: a persisted read path into `/api/script` (none exists — the only cache is the ephemeral `Map`), a content-version component in the cache key (today's `slug:stance:lang` key has none, so a corrected `ai_summary` won't invalidate a stale pregenerated script), and pregen-flag authentication that is a build-time secret or a direct Upstash write — **never** a public request flag (ledger item 7; an unauthenticated pregen marker must be rejected loudly and rate-limited normally). Building and proving that plumbing correctly on a small top-10 set is the right first cut; widening to top-50 multiplies the surface needing that same freshness/auth correctness before usage data justifies it.

**(e) Spike posture — what breaks first, the mitigation ladder, and cost bands.**

What breaks first at 50–100k visits/month: **`/api/script`**. Every other surface is either static-CDN-served (all ~3,348 SSG pages — near-zero marginal cost) or a cheap in-memory lookup (`/api/reps`, no external dependency, no rate limiting at all today) or a stateless Census proxy with its own 10/10min/IP limiter (`/api/district`). `/api/script` is the only route with an external network dependency, a real per-call dollar cost, and an exposed rate limiter.

The core structural gap: both `/api/script`'s and `/api/district`'s rate-limit `Map`s are per-instance. Under concurrency, the stated "8/10min/IP" limit is enforced per instance, not globally — a client spread across N concurrent instances can exceed it network-wide. The crude `hits.size > 5000` full-map clear compounds this, periodically wiping every IP's window per instance regardless of elapsed time. The script cache's "popular bill costs one generation total" claim likewise only holds inside a single warm instance — concurrent cold instances each independently miss on the same popular combo and each fire a separate Anthropic call. No `maxDuration`/concurrency setting is visible in-repo (no `vercel.json`, no route-level export), so the platform-level ceiling under load isn't determinable from the codebase. No differentiated handling of Anthropic 429s exists — any provider-side rate-limit event surfaces as the same generic `502`, no retry-after propagated.

Mitigation ladder:
1. **Static-first architecture is the moat** — ~3,348 SSG pages absorb the overwhelming majority of spike traffic at near-zero marginal cost, independent of anything below.
2. **Upstash rate limits** (9.1c) — durable, cross-instance, closes the actual structural gap.
3. **Vercel WAF rules** — available today even pre-Upstash, up to 40 rate-limit rules/project, a same-day lever.
4. **Cost ceilings** — [FILL: dollar alert threshold on Anthropic spend Colby wants monitored] — nothing today distinguishes a legitimate spike from abuse beyond the rate limiter itself.

Monthly cost bands, using **standard** (post-Sept-1) Sonnet pricing since the Sept 30 funding-fight spike falls after the Aug 31 intro-pricing cutoff:

- Low end: ~$21–25/month (Vercel ~$20 flat + AI ~$1–4, optimistic cache/realistic tokens).
- Most-likely middle: ~$40–120/month (Vercel ~$20 + Upstash ~$5–10 + AI ~$15–90).
- Worst-case ceiling: ~$135–270/month (Vercel ~$20 + Upstash ~$24–30 heavy + AI ~$90–220, pessimistic cache/conservative tokens).

Even the worst-case band for a genuine Sept 30 spike stays under ~$300/month — double-digit-to-low-hundreds, not a launch-gating line item.

**(f) Data resilience — 2026 redistricting, roster churn, and what it means for district lookup.**

*The redistricting wave.* Eight states have new maps locked in for Nov 2026 without live dispute — TX, CA, MO, NC, OH, UT, FL, TN — plus LA (likely, litigation delayed) and AL (settled: SCOTUS's *Allen v. Milligan* ruling on June 2, 2026 reinstated Alabama's 2023 map — the state's own May 19, 2026 primary had run under a now-superseded court map, which is why Gov. Ivey called an Aug 11, 2026 special primary in CD 1, 2, 6, 7 **under the reinstated 2023 map**, not "the court-ordered map"). Roughly the "10 states" figure NBC's tracker cites. Virginia, Indiana, and Maryland attempted redraws that failed — their existing maps stand for 2026.

*The structural fact that governs everything else here:* a mid-decade map change does not unseat a sitting member. House terms run Jan 3 → Jan 3; a new map governs the Nov 2026 ballot and who's sworn in starting Jan 3, 2027 — it does not change who represents a ZIP code today (California's own Secretary of State states this explicitly for Prop 50).

*What this means for district lookup correctness:* Rostra needs, at minimum, two datasets on two separate clocks — "who represents you now" (current boundaries, valid through Jan 3, 2027) vs. "your Nov 2026 ballot / Jan 2027 rep" (new boundaries, state by state, as litigation resolves). Today, `/api/district` hardcodes `'119th Congressional Districts'` as a manually-maintained literal that, per its own code comment, requires a human edit on vintage rollover — correct for "who represents you now" through Jan 3, 2027, but with no mechanism to also carry or switch to a Nov-ballot/next-term dataset.

*Census TIGER staleness:* Census's own TIGER congressional-district product has **not** been refreshed for the 2025–26 mid-decade wave — it's still on the prior cycle's vintage (with only AL/GA/LA/NY/NC baked in from an earlier round). If any Rostra pipeline ever sources boundaries from TIGER instead of a faster tracker, it will silently ship stale districts for Nov 2026. Flag to whoever owns the district pipeline now, before it's needed.

*When data must swap:* the current weekly `zccd.csv`-based `zip-districts.json` needs no swap through Jan 3, 2027 for "who represents you today," regardless of what's happening elsewhere. A separate Nov-2026-ballot/Jan-2027-term dataset would only be needed if Rostra ever surfaces ballot-facing district content — [FILL: not currently a stated Rostra feature; confirm before scoping]. The `'119th Congressional Districts'` literal needs its mandatory human-edit bump timed to the Jan 3, 2027 turnover to the 120th Congress — track this as a dated sprint item, not something to notice after the fact.

*Monitoring plan:* the Redistricting Data Hub's "What's New" feed is the fastest verified tracker — days-scale turnaround (e.g., Florida's map posted one day after passage). Poll it on a defined cadence [FILL: weekly, tied to the Monday `refresh-legislators` cron?] rather than waiting on Census/TIGER, which is weeks-to-months and event-driven. Ballotpedia's news arm (same-day-to-1-day observed, no documented SLA) as secondary corroboration.

*Roster churn:* detection today depends entirely on the weekly `refresh-legislators.yml` cron (Mondays 08:00 UTC) doing a full fresh pull, with no diff against the prior week and no vacancy flag or alerting. The upstream `unitedstates/congress-legislators` repo itself is fast for the departure event (same-day-to-1-day, verified directly via `gh api` commit timestamps) but slower for successor swearing-in (days-to-2-weeks — a June 2 special-election win wasn't reflected until June 11, a 9-day lag). Worst case for Rostra: up to 7 days between an official change and the next scheduled refresh, plus whatever upstream lag stacks on top — not bounded or monitored in-repo today.

*A specific data-model footgun:* when a member departs with no immediate successor, their record moves from `legislators-current.yaml` to `legislators-historical.yaml` with a `terms[].end` date — there's no explicit "vacant" placeholder. The current `process-data.py` approach of taking each legislator's `terms[-1]` as-is, without checking current-file membership, would silently surface a stale departed member instead of a vacancy.

*Vacant-seat display policy:* GovTrack's practice (medium confidence — direct fetch blocked, but vacancy pages for TX-23/CA-14/FL-20/GA-13 are snippet-confirmed) is a plain "this seat is currently vacant" label rather than silently showing the departed member; 5 Calls and Open States/Plural have no discoverable public vacancy policy. Recommend Rostra adopt GovTrack's pattern. FL-20 is the sharpest edge case on record: Cherfilus-McCormick resigned Apr 21, 2026, and Florida's new map (signed May 4) eliminates the district outright, so no special election has been committed for a seat that won't exist after Jan 2027 — a ZIP mapped there needs to show "vacant, no election scheduled," not an inferred in-progress special.

*Sprint items this adds:*
1. Vacancy-diff step in `refresh-legislators.yml` — compare this week's `legislators-current.yaml` membership against last week's; flag any state+district absent from the new pull as vacant rather than falling through to `terms[-1]`.
2. Explicit "vacant" UI state on rep-lookup surfaces, EN/ES parity required.
3. Redistricting Data Hub polling feeding a manual-review alert when a tracked state's map status changes, ahead of the `'119th Congressional Districts'` literal's mandatory Jan 3, 2027 bump.
4. Per KTD-10, this new/modified committing workflow inherits the standard pipeline tax (author-identity/rebase-retry/SHA-verify block, `data-sync` concurrency group, disjoint file set, own loud-failure verifier) — budget the standard **+1 PR**, consistent with how electoral, nominations, and state-expansion each carry the same increment.

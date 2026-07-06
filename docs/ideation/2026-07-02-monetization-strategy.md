---
date: 2026-07-02
topic: monetization-positioning-gtm
focus: Full landscape → positioning → monetization → GTM/deployment → team & funding strategy for Rostra, produced as an independent from-scratch pass
provenance: Multi-agent research harness — 9-agent landscape sweep (7 web-research angles + 2 repo/prior-build readers), 12 adversarial fact-verifiers (0 claims refuted; corrections applied inline), 3 design agents (embeds spec, MCP spec, red team). Synthesized and edited by hand. Companion docs — 2026-07-02-embeds-spec.md, 2026-07-02-mcp-spec.md.
---

# Rostra: monetization, positioning, and go-to-market

## 0. The verdict

1. **Don't pivot.** Rostra sits in a real, recently-vacated position: the free civic-lookup infrastructure the ecosystem lost in 2024–25 (Google Civic Representatives API dead 2025-04-30, ProPublica Congress API dead 2024-07-10), plus the only bilingual plain-language decoded federal bill corpus anywhere, wrapped in the only privacy posture no competitor can copy without destroying their business model. Every structural choice already made — utility not network, static-first, zero accounts, nonpartisan by construction — lands on the surviving side of the civic-tech graveyard.
2. **Say the ceiling out loud.** Without heroic assumptions, Rostra is a **$20–70k/yr fiscally-sponsored public utility** (grants + donations + maybe a network deal) that costs ~$25–60/mo to run. The upside case — institutional embeds + network licenses + philanthropy all compounding — is **~$50–150k ARR by 2028**. It is not a venture-scale business inside its own constitution, and the constitution is the product. If that base-case outcome isn't worth running through 2027, the time to know is now, not after a fourth build.
3. **The binding constraint is not the market. It's the launch.** This is build #3 in ~4 months; builds #1 and #2 died polished-but-unlaunched, and Rostra's noindex gate was explicitly re-kept *yesterday* (commit `bb55a47`). Every revenue line in this document — grants, embeds, MCP citations, earned media — has "the site is public" as a hard prerequisite. **Lifting noindex within 7 days is the strategy.** Everything else is sequencing.
4. **The real deadline is September 30, not November 3.** Call-your-rep demand spikes on *legislative crises* (Feb 2017, Feb 2025: ~1,600 calls/min into the Senate; 5 Calls at 700k calls/week), not elections — October is recess and campaigning, when there's nothing to call about. The government-funding fight is the earned-media window, which means live-and-credible by **late August**. Midterms then deliver a second, different spike: rep-lookup and voter-info traffic in October.
5. **Money, in order of expected value:** philanthropy/grants → network site-licenses → self-serve white-label embeds (gated on a demand test) → institutional API/MCP keys (dormant hook) → citizen-side donations. Direct MCP revenue: **$0 in year one, by design** — it's a distribution asset. No VC for the citizen product; TinySeed only if institutional MRR materializes in 2027; decline Higher Ground Labs (partisan money breaks nonpartisan-by-construction permanently).

---

## 1. The landscape (wide)

### 1.1 Who actually makes money: the B2B barbell

The "contact your representative" market is a barbell. On the heavy end, sales-led enterprise platforms: Quorum (market leader; acquired Capitol Canary/Phone2Action in Sept 2022; median contract ~$23.5k/yr per Vendr), FiscalNote/VoterVoice (~$5k/yr entry), Speak4 ($9,900/yr base), CiviClick, OneClickPolitics, Muster (~$2–7.5k/yr, still sales-led). On the light end, almost nothing: New/Mode's $44/mo Grassroots tier (self-serve, embeddable forms — but explicitly progressive-movement-coded: Greenpeace, Sunrise, unions) and Actionable at $29.99/mo (the ex-Countable team's obscure micro-SaaS; countable.com literally redirects there now).

Two structural facts matter more than any single competitor:

- **Every incumbent's business model is advocate-data capture.** Pricing scales on "advocates uploaded"; the CRM is the product. Rostra cannot compete on that axis — and doesn't want to, because that axis is what makes every one of them unusable by institutions that need visible neutrality (schools, libraries, local newsrooms, most 501(c)(3)s).
- **The market is consolidating and shedding customers.** FiscalNote: NYSE trading suspended 2026-03-25, formally delisted April 2026, FY2025 revenue $95.4M (−21%), ~$123–126M debt, going-concern doubt disclosed, subordinated-creditor forbearance expiring **2026-07-21** (three weeks from now). Plural Policy (Open States' commercial arm) was absorbed into compliance vendor SAI360 in Dec 2025. Mid-market orgs on dying platforms are churn candidates in the post-election budget cycle (Dec 2026–Jan 2027).

**The precise gap:** it is *not* "nobody sells cheap self-serve advocacy" (New/Mode and Actionable do). It is: **no nonpartisan, US-focused, bilingual, privacy-first vendor serves small institutions without a sales call at any price.** That's Rostra's slot, and the incumbents structurally cannot follow (their unit economics require the data capture and the sales team).

### 1.2 The consumer graveyard and its law

The graveyard splits cleanly by cause of death, and the split is the answer to the "does solo+AI change the calculus?" question (§3):

- **Demand deaths** — politics-as-social-network: Brigade (~$40–50M of Sean Parker's money, ~200k verified users at peak, founders' own verdict: nobody came), Causes (190M registered users, never sustained), iCitizen ($10M+, dissolved insolvent), Votizen, Ruck.us, and per the Civic Tech Field Guide ~150+ dead projects. Cost was never the constraint. No amount of AI cheapness rescues these.
- **Cost-structure deaths** — real demand, unsustainable org: Sunlight Foundation's OpenCongress died in 2016 inside a ~$9M/yr, ~40-person grant-funded org — and its users were explicitly handed to GovTrack, a one-person bootstrapped project doing the same job ever since. The demand existed; the payroll didn't fit it.
- **The survivors are all utilities:** 5 Calls (only public 990: ~$17.7k annual expenses in FY2017; now claims ~15% of Senate call volume; the technical co-founder still has a day job), Resistbot (volunteers + small-dollar members; its SMS/fax model costs ~$40k per nationwide push — a marginal-cost trap Rostra's dial-it-yourself model avoids), GovTrack (one person, ads + Patreon + ~$66k Kickstarters), Ballotpedia (the expensive exception: ~$8.9M revenue / ~$9.2M expenses FY2024, human editorial staff — the exact cost line LLMs collapse).

**The law: utilities survive, networks die.** Rostra's ZIP→reps→bill→call flow is on the survivor side. Any roadmap pressure toward profiles, feeds, comments, or communities is the graveyard's front gate.

### 1.3 The 2024–25 infrastructure collapse (the tailwind)

Every major *free* civic-data API of the last decade is dead: Sunlight (2016), GovTrack's API/bulk data (2017), ProPublica Congress API (2024-07-10), Google Civic Representatives (2025-04-30). Google's own migration guidance points to paid vendors. The replacements: Cicero at ~$9–60/1,000 lookups (and only ~370–385 local jurisdictions covered — there is no national local-officials source at any price), Geocodio at ~$3/1,000 with district+legislator appends, 5 Calls' own Representatives API (federal + state executives only, email-gated). The free federal core underneath is healthy — Congress.gov API (5,000 req/hr), unitedstates/congress-legislators (active, pushed June 2026) — which is exactly the stack Rostra builds on.

**Rostra's static rep-lookup + decoded-bill layer is now scarce plumbing.** That is simultaneously a launch press angle ("the free replacement for what Google turned off"), an embed product (companion spec), and an MCP thesis (below).

### 1.4 The MCP/agent economy (and what happened to build #2's idea)

MCP won the standards war (Linux Foundation, all major assistants speak remote MCP mid-2026) — but **paid MCP is pre-revenue as an ecosystem**: <5% of ~10–18k public servers monetize at all, the winners make $500–3k/mo, x402 micropayment volume is tiny and partly gamed, and neither the Claude nor ChatGPT directory has native billing for data services. The exact-category precedent: congressMCP tried a $19/mo Pro tier and retreated to free open source by March 2026 (verified).

Meanwhile the slot itself is empty and *documented* as empty: official government MCPs (GovInfo, Census) are document-retrieval only; registry searches for "representative" return zero locator tools; the Claude Connectors Directory's Government & Nonprofit category holds 8 connectors, none congressional. And because Rostra stores no user data, it skips OAuth — the hardest directory requirement.

So build #2's instinct (agent-native civic layer) was right; its monetization model (metered $19–299/mo tiers) was wrong for 2026. Free-and-canonical is the play. Full comparison in the MCP spec §0.

### 1.5 Demand and distribution reality

- **Demand is spike-shaped**, driven by legislative/executive crises. Feb 2025: ~1,600 calls/min into the Senate, 5 Calls at ~700k calls/week and top of the App Store. Between spikes, traffic halves (5 Calls: 189k → 92k monthly visits Apr→May 2026).
- **SEO head terms are unwinnable by November.** ".gov + Ballotpedia" own rep-lookup queries; only 1.74% of new pages reach Google top-10 within a year. A July-indexed site wins **long-tail only**: bill-nickname pages ("SAVE Act explained"), and Spanish-language queries where competition is effectively zero. Evergreen SEO is a 2027+ compounding asset, not a 2026 plan — but it compounds from the day noindex lifts.
- **Distribution for civic tools is earned media + word of mouth** (5 Calls: 58% direct traffic; its 2017 and 2025 press hits followed the same playbook — launch into a live outrage cycle, publish concrete call counts, offer the solo-builder human story, get amplified).
- **"AI-citable source" is a real, new channel.** Platforms answer-and-redirect *voting-mechanics* queries to designated partners (Democracy Works owns that), but the "what does this bill do / who represents me / how do I reach them" slot has **no designated partner** — it's answered from web search. AI referrals are ~1% of traffic but convert 4.4×; open-access structured content wins citations. Chatbots are documented to be *worse* in Spanish (>50% error rate on election answers) — Rostra's ES corpus is the corrective source.
- **Spanish is a wedge, not a traffic engine.** ~36.2M Latino eligible voters in 2026, but only ~21% of Hispanic adults get news mostly in Spanish (consistent with the existing ES ≈ 5–7% weighting). No incumbent — Congress.gov, GovTrack, Ballotpedia, 5 Calls — offers Spanish bill decoding. Use bilingualism for press, partnerships (NALEO, UnidosUS, Voto Latino, Telemundo/Univision civic campaigns — none have bill tools), and funders (Latino Community Foundation: record $12.9M grantmaking 2025, $2.6M+ to civic power). Distribution for the ES audience is WhatsApp/creator-shaped (Hispanics are 48% of WhatsApp news consumers; 49% of Hispanic adults on TikTok), not search-shaped: per-bill shareable cards beat Spanish SEO.

---

## 2. Where Rostra is uniquely positioned

**Assets no competitor has (verified against the repo):**

| Asset | Why it's differentiating |
|---|---|
| ~1,085 AI-decoded bills with structured plain-language sections, **in English and Spanish**, refreshed nightly with EN/ES parity enforced | No other source, free or paid, has a bilingual decoded federal corpus. This replicates Ballotpedia's ~$9M/yr editorial function at hobby cost. |
| 537 members + **1,280 district offices** + 33,774 ZIP→district mappings incl. 7,299 split ZIPs with stateless address refinement | Replaces the dead free-lookup infrastructure; split-ZIP correctness is a known LLM failure mode; district-office numbers are what constituents should actually dial and Congress.gov doesn't model them. |
| Zero-server-side-user-data architecture, provable | The one claim no incumbent can copy — their pricing scales on captured advocates. Sells itself to privacy-skittish institutions and at-risk users. |
| Nonpartisan by construction (structural, not editorial) | The precondition for schools/libraries/newsrooms; also the platform-policy shield for MCP/directory listings. |
| Static-first, ~$25/mo cost base, hardened nightly pipeline (dead-man's-switch, deploy verification, 4 incident postmortems with CI gates) | Survives 100× spikes at hobby cost; survives funding winters that kill grant-staffed peers; operational maturity is itself diligence-grade IP. |
| Pure, framework-free logic modules (urgency, coverage, district parsing) + exportable JSON data layer | The embed/MCP/API products are extractions, not new builds. |

**Weaknesses and standing flags:**

- **noindex is still on** (`app/[locale]/layout.tsx:28`) — every distribution channel is dead until it lifts.
- **AllSides bias data is CC BY-NC** — lean labels cannot ship in anything commercial (embeds, paid API) without relicensing or re-sourcing. Decision made in both specs: exclude lean labels from all commercial surfaces; the citizen site keeps them under NC+attribution. Resolve properly before the first invoice or grant hits an entity.
- **Vercel Hobby prohibits commercial use** (verified) — the moment anything monetizes (or arguably, solicits), move to Pro ($20/mo). Cheap; do it at launch.
- **No tenancy/keys/billing layer exists** — all institutional revenue is new build (sized in the specs).
- **Decay clocks:** corpus hardcoded to the 119th Congress; Census geocoder layer pinned to "119th Congressional Districts"; ZIP→district data needs a provenance/refresh check against 2026 mid-decade redistricting (TX et al.) — one wrong district during an earned-media moment is the trust-killing failure mode.
- **Freshness honesty:** sync repaired (last run 2026-07-02) but cursor high-water is 2026-06-05 and newest bill action is 2026-06-09 — the "data as of {date}" stamp (audit idea #2) must ship before launch; it's also load-bearing for citability.
- **ES redistribution bar:** embeds and MCP will put Spanish AI text in front of Spanish-dominant users via third parties — the current review bar was set for the site; spot-check before listing.

**Positioning statement** (the one-sentence version everything else hangs off): *Rostra is the free, nonpartisan, bilingual civic utility — understand any bill in plain language, find exactly who represents you, and make a call that counts, without an account, in either language — and the infrastructure version of that utility for the institutions that need visible neutrality.*

## 2.1 The advocacy-customer question (resolved structurally)

The moneyed segment (advocacy orgs) buys advocate-data capture — lists, CRMs, conversion funnels. Rostra's constitution forbids building those mechanics *for anyone*, which resolves the "would you sell to advocacy groups?" fork without touching partisanship: **Rostra sells neutral utilities to institutions that need neutrality, and never builds capture mechanics for any customer.** If an advocacy org embeds the free widget, that's fine — it's a utility, like embedding a map; attribution keeps it legibly Rostra's voice, and the ToS bars misrepresenting Rostra's neutrality. What's never for sale: stance-shaping, member capture, unlabeled white-label of the call flow.

---

## 3. The solo+AI recalculation (the follow-up question, answered honestly)

The suspicion — "past failures may not apply to solo builders with AI-assisted virtual teams" — is **half right, and the half matters**:

- **What solo+AI changes: supply.** Ballotpedia pays ~$9M/yr for human plain-language political content; GovTrack paid ~$35k per six months for human bill summaries; Sunlight carried $3.5M/yr payroll; Brigade carried ~20 SF engineers. Rostra replicates the content function for tens of dollars a night and the engineering function for one person's attention. **Cost-structure failures are genuinely re-openable.** OpenCongress-class bill intelligence, Ballotpedia-class explanation, ActionButton-class embeds — all of these now run at 10–100× lower cost base than when they failed or got absorbed.
- **What solo+AI does not change: demand.** Every big-dollar death was a demand death. AI makes it cheap to build things nobody wanted in 2015 — they are still things nobody wanted. CB Insights' pattern holds in civic tech: "no market need" kills 42%, "ran out of funding" 29%.
- **The synthesis:** solo+AI's real gift is that **Rostra can survive indefinitely at 5 Calls/GovTrack scale without sacrifice** — proven-demand utilities, run at near-zero cost, riding spike demand, funded by grants and goodwill. That's new, real, and worth doing. It is a $20–70k/yr outcome unless the institutional layer finds demand that has *never yet been demonstrated* (no newsroom has ever asked for a civic embed — ActionButton reached 10M actions through publishers and still couldn't sustain a publisher business). Hence: demand tests before build (§5.4), and honest tiers (§11).

One more inversion worth keeping: the incumbents are all bolting on AI *volume* weapons (mass personalized messages to beat congressional mail filters) with zero transparency labeling — while Hill offices increasingly discount exactly that flood. Rostra's labeled, human-reviewed, call-first posture is the high-signal channel *and* the only posture platform policies and skittish institutions will touch. The anti-slop position gets more valuable as the slop rises.

---

## 4. Monetization paths, ranked by expected value

| # | Path | 18-mo realistic | What it requires | Distortion risk |
|---|---|---|---|---|
| 1 | **Philanthropy/grants** (§10.2) | $0–50k (EV ~$10–30k) | HCB fiscal sponsorship (7%, days to set up); a live product with a usage number; applications timed post-launch | Left-adjacent *coding* by association (disclose all funding publicly); grant-writing hours; never fund recurring costs with it |
| 2 | **Network/site licenses** ($500–2k/yr: LION, INN, state press associations, LWV national, Spanish-language press) | $1.5–6k (2–4 deals) | The free embed live + one warm champion per network; committee-speed patience | Minimal — sold as member benefit; the only sales motion allowed |
| 3 | **Self-serve white-label embeds** ($29/mo; $15 nonprofit) | $0–10k ARR — **gated on the demand test** | Embeds MVP (~4 wks) + billing (~2 wks); kill criteria set | Support burden; "free is enough" cannibalization (fine — free tier is distribution) |
| 4 | **Institutional API/MCP keys** (dormant `X-Rostra-Key`, activate ~Feb 2027 if pulled) | $0–5k | Nothing now (hook ships with MCP); Stripe + docs later | None if demand-pulled |
| 5 | **Citizen-side donations** (HCB-hosted page, neutral processor — not ActBlue) | $0–5k | A launch-moment ask + a "what your $ runs" page | Coupling revenue to outrage cycles if leaned on |
| — | **MCP direct revenue** | **$0 by design** | — | — |

**Rejected, with reasons:** ads (GovTrack survives on them, but trackers contradict the privacy constitution and cheapen the trust product); x402/crypto micropayments (volume is tiny and half-gamed); paid citizen features (constitution + the graveyard: citizens don't pay for their own activism); the advocacy-CRM market (capture mechanics, §2.1); Higher Ground Labs' rolling Fund V (writes ~$100k checks into exactly this category — and is explicitly progressive-Democratic; appearing in its portfolio breaks nonpartisan-by-construction permanently); email-digest product (a second product's ops burden — shipped as a tenant JSON/RSS feed instead).

**Mapped to the revenue-goal question (unanswered, so all three):**
- *Cover costs:* achieved by default — costs are ~$300–700/yr; one small grant or a trickle of donations covers a decade.
- *Sustainable solo income ($3–10k/mo):* requires paths 1–4 **all** working plus 2–3 years of compounding — possible, not probable; the Feb 2027 gate is where this becomes evidence instead of hope.
- *Real company:* not inside the constitution. The only venture-shaped version is the institutional data/API layer as a C-Corp (TinySeed-scale, §10.2) with the citizen product as top-of-funnel — decide only if MRR shows up.

---

## 5. The embed/widget deep-dive (answers to the specific questions)

Full spec: `2026-07-02-embeds-spec.md`. The decisions:

- **Same domain or separate?** Same brand, subdomain: `embed.rostra.org`, same repo and Vercel project. A solo dev cannot feed two brands; the Datawrapper attribution loop requires one. The subdomain (vs. a path) makes the no-cookie posture structural and lets embed pages carry permissive `frame-ancestors` while the apex stays locked down.
- **Form:** iframe + ~5KB script-tag loader (auto-resize via postMessage). The iframe is what makes the marquee claim *enforceable by the browser*: **"collects nothing about your visitors — and even your own page's scripts can't see what they type into it."** That claim, backed by public CI tests (zero cookies, zero third-party requests, zero storage), is the product. Every competitor is architecturally a data-capture funnel; Rostra sells the absence.
- **V1 surface:** the "who represents me" lookup (the Google-Civic-shaped hole; evergreen; zero AI cost) + the bill explainer card (bilingual decode — the thing nobody else has). The AI call-script action panel is v1.1, paid-tier, after multi-tenant hardening — it's also the politically hottest surface, so it ships behind ToS-accepted tenancy.
- **Addressable market, honestly:** ~1,200 small digital newsrooms (LION median revenue ~$138k), ~9,000 library systems (budget-crisised, politically skittish — sell the bilingual *explainer* framing, never the call-to-action framing), 800+ LWV Leagues, low-thousands of civic nonprofits. At optimistic penetration, **$70–120k ARR is the mature ceiling; year one is $5–16k** (2–4 network deals + 10–30 self-serve). Datawrapper — the best embed business newsrooms ever loved — took 13 years to ~$3.2M ARR. Creators are referral partners, not buyers (Substack cannot host iframes). Philanthropy, not subscriptions, is the sector-scale payer — the free-tier install base is the grant credential.
- **The no-brainer price:** free-with-attribution *is* the no-brainer (that's the growth loop); $29/mo white-label ($290/yr), $15/mo nonprofit/library/edu, $500–2,000/yr network licenses. Anchors: New/Mode $44, Actionable $29.99, ActionButton Plus $49 (NationBuilder add-on), Newspack's $50 tier for sub-$300k publishers. Nothing exists below $100 that a neutral institution can touch.
- **Cost structure:** ~$35–75/mo at 100 tenants; a Feb-2025-scale spike costs ~$450 in bandwidth for the month — survivable, Cloudflare-frontable. Support ~1–3 hrs/wk at 100 tenants if (and only if) dashboards, passwords, and custom CSS are refused.
- **Build:** ~4 solo weeks to free-tier MVP, ~9 to paid v1.1 — but see the gate below before spending any of them. Tenancy is config-not-accounts (capability tokens + Edge Config + Stripe-as-CRM); no login exists.
- **AllSides:** lean labels excluded from every embed tier, entirely.

### 5.4 The gate (do this before building anything)

The red team's strongest market attack: *newsroom demand for a civic embed is pattern-matched, not evidenced* — Datawrapper solves a production problem (reporters must make charts); a civic widget is a reader-service garnish, and the direct precedent (ActionButton: 10M actions through publisher embeds) still couldn't sustain a publisher business, retreating to a $49/mo advocacy add-on. Newsrooms also police the news/advocacy line hardest — a "call Congress" button in an article is editorially an act of advocacy regardless of stance neutrality (lead with the lookup + explainer for them; the action panel is for civic orgs).

**So: test before build.** After launch, stand up a minimal free lookup embed (a weekend, not the 4-week MVP) and cold-email 20 LION-member newsrooms whose outlets have covered a specific bill in `data/coverage.json`, each with a live demo embed of *that bill*. **Success bar: ≥2 of 20 embed it within 14 days.** Clear → build the MVP properly and start network conversations. Miss → the paid embed thesis is dead; keep the free lookup as goodwill/backlink infrastructure and put the hours elsewhere. Do not build billing, white-labeling, or a partner deck before this clears. Hard kill criteria if built: <10 active embedded domains or <$300 MRR-equivalent by 2027-01-31.

---

## 6. The MCP deep-dive

Full spec: `2026-07-02-mcp-spec.md`. Prior art found as requested: `~/Projects/oravan/docs/PIVOT.md` — build #2's "Oravan Civic Action MCP" (2026-06-11, strategy complete, never built; one commit). Its gap thesis was right and is *still open*; its monetization model is superseded by 2026 evidence.

The decisions:

- **Role: free, keyless, read-only distribution asset for 12 months. Direct revenue: $0, by design — say it out loud.** What it earns instead: registry/directory placement (the Claude directory's Gov & Nonprofit category has zero congressional connectors), agent citations pointing at canonical rostra.org URLs, the "canonical civic MCP" credential for grant applications and network pitches, and a press hook. A dormant `X-Rostra-Key` header ships so an institutional keyed tier can activate later without re-architecture.
- **Tool surface:** `lookup_representatives` (with split-ZIP address refinement — never stored, never logged, and the tool description says so), `get_bill`, `search_bills`, `whats_moving` (the recurrence engine; honest `quiet_week: true` when nothing clears the floor), `get_bill_coverage` (lean-stripped), `get_representative` (facts only, no scorecards). Every response carries a citation envelope: `as_of`, source, canonical URL, AI label.
- **`draft_call_script` is NOT exposed over MCP.** It's the only per-call AI cost (an uncapped spend faucet on a keyless server), the highest platform-policy risk ("generates political messages" vs. "read-only civic data"), and it would bypass the review-before-call constitution. The MCP links out to the on-site flow instead — which also makes it a funnel. Pre-generated, human-spot-checked scripts for top-band bills may return as static resources in v1.5.
- **Hosting:** inside the existing Next app (`mcp-handler`, Streamable HTTP, stateless over the baked JSON). Rate limiting + the script cache move to Upstash with an explicit privacy design: hashed-IP counters that never touch content keys, content cache that never touches caller keys, a CI grep-gate on key construction (this repo's one prior privacy near-miss — the heartbeat — was exactly this shape).
- **Build:** 3.5–4 part-time weeks including the full canonical-source playbook (official registry, PulseMCP/Glama/Smithery, Claude directory submission, OpenAPI/REST aliases, llms.txt, per-bill JSON-LD + hreflang + sitemap, citability/correction pages). Runtime cost ≈$0 at 10k calls/mo.
- **Value model:** being the *cited* source matters as much as being the invoked tool — AI referrals convert 4.4× organic, chatbots are demonstrably bad at exactly Rostra's queries (split ZIPs, Spanish), and the "what does this bill do / who represents me" slot has no designated platform partner yet. The whole playbook is moot while noindex is on.

---

## 7. Change / add / drop

**Add now (pre-launch, gating):** noindex removal + sitemap/robots/hreflang; "Bill data as of {date}" freshness stamp (audit idea #2 — also load-bearing for citability); call-funnel re-centering (idea 3); Spanish last-mile paired script (idea 6); the call-moment package sliced to what fits (idea 4); minimal identity finish (idea 7 — enough that press coverage has a real name and mark to print); ZIP-data provenance + redistricting check; Vercel Pro.

**Add soon (post-launch, sequenced):** MCP + canonical-source playbook (3.5–4 wks); the 20-email embed demand test (a weekend); HCB fiscal sponsorship (~2 hrs, parallel-safe now); stance-mix instrumentation (nightly-baked aggregate counter, privacy-clean — the first real evidence on whether nonpartisan demand exists, per red-team attack 7); client-side "it counted" ledger (audit idea 5 — the retention feature everything else benefits from).

**Add later (demand-gated):** embeds MVP → v1.1 (only past the gate); institutional keys (Feb 2027 gate); state legislatures (2027 option — Open States bulk data is free, healthy, and architecturally compatible with the nightly-sync pattern; the real cost is 50-state bilingual decode spend, not data).

**Drop / never:** social features of any kind; advocacy-CRM mechanics for anyone; ads/trackers; x402; paid citizen features; ActBlue-style processors (partisan branding); lean labels on any commercial surface (pending relicense); email-digest product; national local-officials coverage (nobody can sell completeness — city pilots only, ever); the Nov-3-as-deadline framing.

**Pivot?** No. Every candidate pivot (advocacy SaaS, consumer network, data-vendor-only) lands on a graveyard square or breaks the constitution. The position is right; the execution risk is the launch loop.

---

## 8. Go-to-market plan (calendar runs backwards from Sept 30)

**Phase 0 — this week (July 2–9): the pattern-breaker.**
Lift noindex + ship sitemap/robots/hreflang (the chore list already specs it). Move to Vercel Pro. Start HCB fiscal-sponsorship paperwork. Make one dated public commitment (a LION Slack post, an email to 5 Calls' founder, a tweet) — external witnesses are the forcing function internal gates haven't been (the CI warning was absorbed within a day of shipping). *If this phase doesn't happen in 7 days, stop treating this as a strategy problem — name build #3 as portfolio work and decide honestly (§12).*

**Phase 1 — July 9 → Aug 25: one front, launch quality.**
The audit's own ranked list, in order: freshness stamp + honest "Act now" floor (idea 2); homepage funnel re-centering + /reps continuation (idea 3); Spanish paired-script last mile (idea 6); the call-moment slice that fits (idea 4: pre-dial beat + clipboard + office-hours line; the night screen if time allows); minimal identity finish (idea 7). Nothing else. At ~7 PRs/week (the repo's demonstrated velocity) this fits — barely, which is the point.

**Phase 2 — Aug 25 → Sept 30: the moment.**
Launch publicly into the government-funding fight. Press kit pre-written to the 5 Calls playbook: concrete numbers ("N bills decoded in both languages, N calls logged"), the solo-builder story, the bilingual + privacy hooks, the "free replacement for the APIs Google and ProPublica turned off" infrastructure angle. Targets: civic-tech press, ES-language press (the unserved-wedge story), local-news trades (Nieman Lab, Poynter), newsletter writers as referral partners (co-branded landing pages — they can't embed, they can link). MCP build runs in parallel here (3.5–4 wks part-time) → listed by early October.

**Phase 3 — Oct → Nov 3: the second spike.**
Midterm lookup/registration traffic (different demand: who-represents-me + what's-on-my-radar). Run the 20-email embed demand test. Stance-mix data starts accumulating. WhatsApp-shareable per-bill cards for the ES audience. Goal metric (usage, not revenue): **1,000 logged calls by Nov 3** — measured client-side, privacy-clean, and it's the number every grant application wants.

**Phase 4 — Nov → Feb 2027: harvest and gate.**
Grant applications with a usage number and a spike story: Press Forward local chapters (fiscal sponsor satisfies the c3 requirement), Latino Community Foundation, Trust for Civic Life ($25k, open-application, nonpartisan-required — needs the rural angle: a bilingual district-office/border-community frame fits), Echoing Green if the fall window opens (note: for-profit ventures get it as a recoverable grant), Mozilla Builders only if a new cohort is announced (none is, as of July 2026 — monitor, don't plan on it). Post-election churn window for FiscalNote/VoterVoice refugees (network-deal conversations). **Feb 2027 decision gate:** MCP volume, embed installs, MRR, grant pipeline → double down on what pulled, freeze what didn't. Everything frozen survives at ~$0 carrying cost — that's the architecture's gift.

---

## 9. Deployment strategy

### 9.1 Technical / infra scaling

- **Vercel Pro at launch** ($20/mo): Hobby prohibits commercial use (verified), and donations/grants arguably cross the line — don't argue the edge case for $20.
- **Upstash Redis for the script cache + rate limits** (the README's own known caveat, now load-bearing): hashed-IP counters (10-min TTL, daily salt) strictly separated from content-keyed cache; CI grep-gate on key construction. This is *more* private than today's in-memory raw-IP maps, and the reasoning ships verbatim in the privacy policy.
- **Pre-generate all 6 scripts (3 stances × 2 locales) for top-band bills nightly** — spikes concentrate on exactly those bills, so spike traffic becomes ~100% cache hits; degraded mode serves the cached script, never queues.
- **Spike posture:** the static architecture already absorbs reads; add Vercel WAF rate rules as backstop; know the bandwidth math (a 100× month ≈ hundreds of dollars, not thousands; Cloudflare fronting is the lever if spikes recur); keep the two dynamic routes rate-limited and gracefully degrading.
- **Data resilience:** the corpus is self-contained by design — upstream outages degrade freshness, never availability, and the `as_of` stamp makes that honest. Watch the decay clocks: 119th-Congress hardcode, Census layer vintage, ZIP-data refresh against mid-decade redistricting.
- **Monitoring is already unusually good** (dead-man's-switch, deploy verification, incident ledger). The one gap the audit named: user-visible staleness. Fixed by the freshness stamp.

### 9.2 Public rollout

Staged, but fast: noindex off + sitemaps (week 1) → soft-public (indexable, shareable, no announcement) through Phase 1 → launch moment aimed at the funding fight (Phase 2) → MCP registry/directory listings (early Oct) → embed configurator public only if the demand test clears. Every stage is reversible except the first, which is the point of doing it first.

---

## 10. Team and funding

### 10.1 Should you bring anyone in?

**No hires.** The economics that make this work are the absence of payroll, and the survivors' pattern (5 Calls, GovTrack) is founder + volunteers. Three targeted exceptions:

1. **A Spanish-language editorial reviewer, contract, a few hours/month.** The moment MCP/embeds redistribute ES text through third parties, the review bar rises above what machine parity checks give you. This is the one skill gap that's real, cheap to fill, and mission-critical. (A bilingual civic-org partnership could fill it for free.)
2. **An accountability structure, not a person on payroll.** The founder-pattern risk (§12) responds to external witnesses: a public launch commitment, a standing check-in with one named peer, the 1,000-calls-by-Nov-3 number published somewhere costly to walk back.
3. **Later, only if network deals show life:** a fractional partnerships person on commission (post-Feb-2027, evidence-gated). Not before — BD ahead of demand is the classic solo-dev time sink.

Also worth cultivating deliberately: 1–2 open-source contributors before the fall spike (the 5 Calls bus-factor hedge; the repo's docs/solutions culture makes it unusually onboardable).

### 10.2 Funding: all three paths, with the distortion each imposes

**Bootstrap (default; recommended as the spine).**
Cost floor ~$25–60/mo all-in. No distortion, no deadlines, survives funding winters that kill grant-staffed peers (Democracy Works swung $4.1M→$14.9M across election cycles; Code for America cut 35 roles in 2023 — grant-scale civic tech staffs up and down with cycles; Rostra's cost base makes it immune *if it stays unstaffed*). Ceiling: your time and attention. Rule: any outside money accelerates features; none of it ever funds recurring costs.

**Grants/philanthropy (the real early money; pursue post-launch).**
Mechanics first: **HCB fiscal sponsorship (7%)** unlocks 501(c)(3)-only funds and tax-deductible donations in days, no entity conversion. The genuinely open doors, verified July 2026: Press Forward local chapters (rolling 2026 calls; for-profits need the fiscal sponsor — solved); Latino Community Foundation (record $12.9M in 2025, $2.6M+ civic power — the bilingual wedge is squarely their thesis); Trust for Civic Life ($25k civic-experiment grants, open-application, explicitly nonpartisan — needs the rural frame); Echoing Green ($100k over 18 months; recoverable grant for for-profits; window expected fall 2026, not yet announced); Mozilla Builders (up to $100k, funds individuals, open-source AI — **no 2026 cohort announced; monitor only**). Closed doors not worth hours: Knight (invite-only outside episodic calls), Democracy Fund, Omidyar, Emerson (all refuse unsolicited). EV honesty: ~$10–30k over 18 months, arriving *after* the midterms — the fall must be ridden on bootstrap economics. Distortion: grant timelines, reporting, and the left-adjacent coding risk — mitigate with a public funding-disclosure page and by never taking partisan-ecosystem money (decline Higher Ground Labs despite it being the easiest check in the category).

**VC (not now; one narrow future door).**
Verified dead for citizen-facing civic: a16z American Dynamism explicitly disclaims it; every venture-scale consumer civic play 2014–2019 died or pivoted (Brigade's end state: acqui-hire + IP fire sale); the $1.8B OpenGov exit priced B2G contract revenue, not civic engagement. The one honest future path: if the institutional layer produces real MRR by mid-2027, **TinySeed** ($120–220k for 10–12%, C-Corp required, applications ~Sept annually) is the right-sized first check, with the citizen product as protected top-of-funnel. Taking it makes the institutional layer *the company* — a decision to make with revenue evidence, not before. Preserve optionality: keep institutional code/billing separable from day one (the specs already do).

---

## 11. Honest expectations (recorded so future-us doesn't gaslight itself)

| Line | Pessimistic | Base | Good (requires demand tests clearing) |
|---|---|---|---|
| Costs, 18 mo | ~$700 | ~$900 | ~$1,500 (spike bandwidth) |
| Grants | $0 | $10–30k | $50–100k (Press Forward-class infra grant) |
| Network deals | $0 | $1.5–3k | $6–12k |
| Self-serve embeds | $0 (test fails) | $1–4k ARR | $10–16k ARR |
| MCP direct | $0 | $0 | $0 (institutional keys activate 2027: $0–5k) |
| Donations | $0 | $1–3k | $5k+ (spike moment) |
| **Total, 18 mo** | **~$0–5k** | **~$15–40k** | **~$70–130k** |

The base case is a self-sustaining public utility with beer money; the good case is a modest livelihood-adjacent project with grant acceleration. Nothing here is a salary by mid-2027 unless the good case compounds. The usage goal that unlocks the money column: **1,000 logged calls by Nov 3, 2026.**

---

## 12. The founder-pattern appendix (kept intact, because it's the highest-severity finding)

An adversarial review of all three builds was explicitly commissioned for this strategy; its top finding outranks every market fact above:

> Build #1 reached donor-ready polish, live domain, working OAuth — never launched (noindex never lifted, zero public users, frozen 2026-06-10). Build #2 produced immaculate strategy docs — zero code, dead in one evening (2026-06-11). Build #3 was founded the next day, is superbly engineered, and is still noindex-gated — a gate re-affirmed by commit `bb55a47` *yesterday*, which responded to an audit flag by making the gate more comfortable to keep rather than lifting it. Strategy and research production — including this document — is the displacement activity. Four of the strategy's five fronts (grants, MCP, embeds, BD) can be worked indefinitely behind noindex; that is precisely their danger. Zero of the revenue numbers are achievable while the site is unlaunchable. The only action that distinguishes build #3 from builds #1 and #2 costs one line and ten minutes.

The strategy's answer is structural, not motivational: Phase 0 makes the noindex lift the *first* step with a 7-day clock and an external witness; the goal metric is usage, not revenue; every monetization workstream is gated behind a cheap demand test instead of a build; and the Feb 2027 gate forces an explicit keep/freeze decision. And one question only Colby can answer, worth answering in writing: *if the realistic outcome is a $20–70k/yr fiscally-sponsored public utility — 5 Calls with bilingual AI decode and better privacy — is that worth running through 2027?* If yes, everything above is the plan. If no, better to know before the fourth build.

---

## Appendix: verification notes

12 adversarial verifiers re-checked the load-bearing claims against primary sources (SEC filings, IRS 990s, live pricing pages, license texts). **None refuted.** Corrections applied throughout, the material ones: FiscalNote's formal delisting was April 2026 (trading suspended 2026-03-25); debt is ~$123–126M filed, with going-concern doubt disclosed; ActionButton is $49/mo as a NationBuilder add-on (Basic included with Starter), not a standalone $39/mo product; Ballotpedia's "50+ editors" is a 2021 figure (org now ~80+ people, 25+ FT writers); LION median member revenue is $138k (2024); Mozilla Builders has no announced 2026 cohort; Echoing Green's $100k is a recoverable grant for for-profit ventures and its fall-2026 window is expected, not announced; Press Forward's Closing Coverage Gaps call accepted for-profit newsrooms directly (the c3 requirement is call-specific); LCF's $2.6M civic figure was through Q3 2025. Confirmed as stated: New/Mode $44/mo (progressive-coded), Actionable $29.99/mo, Speak4 $9,900/yr, Quorum ~$23.5k median, both API shutdowns and dates, congressMCP's paid→free retreat, the empty civic-MCP slot and the Claude directory's 8-connector Gov category, 5 Calls' FY2017 990 (~$17.7k expenses) and Feb 2025 volume, BillTrack50/Cicero/Geocodio pricing, Vercel Hobby's commercial prohibition, AllSides CC BY-NC, Substack's iframe prohibition, Open States' post-acquisition health, LegiScan's free 30k/mo tier, TinySeed's terms and September window.

---
date: 2026-07-02
topic: rostra-embeds-spec
focus: Spec-level exploration of the white-label embeddable civic widget product — companion to 2026-07-02-monetization-strategy.md
provenance: Produced by a multi-agent research/design pass (design agent grounded in this repo + a 7-angle verified market sweep), reviewed and corrected by hand. Design document only — no code exists and none is committed to.
---

# Rostra Embeds — product spec (design document, no code)

**Status:** exploration → decided shape. **Owner:** solo builder. **Constraint stack:** citizen-side no-server-side-user-data constitution (CLAUDE.md), bilingual parity, nonpartisan by construction, AI labeled, static-first, ~$75/mo infra budget, zero sales calls for self-serve.

**Gate before any of this is built:** the 20-email demand test (strategy doc §5.4). This spec exists so the test can be run against a concrete offer, not to green-light the build.

---

## 0. One-paragraph shape

A family of iframe widgets served from `embed.rostra.org`, installed with one `<script>` tag, that put Rostra's existing static civic data (537 members, 1,280 district offices, 33,774 ZIP mappings, ~1,085 bilingual AI-decoded bills) inside newsroom articles, library sites, and civic-org pages. Free tier: full function, "Powered by Rostra" backlink, no registration. Paid tier ($29/mo self-serve): white-label theming, the AI call-script action panel, aggregate impression counts. Network tier ($500–$2,000/yr, hand-negotiated): all members of LION/INN/a state press association/LWV covered at once. The marquee, verifiably true claim: **"This widget collects nothing about your visitors — and because it's an iframe, even your own page's scripts can't see what they type into it."**

---

## 1. Product surface — what embeds, and what v1 cuts

| Embed | Verdict | Why |
|---|---|---|
| **"Who represents me" lookup** (ZIP → 3 members + district offices + split-ZIP address refinement) | **V1 — lead product** | This is the Google-Civic-API-shaped hole (Representatives endpoint dead 2025-04-30; ProPublica Congress API dead 2024-07-10; replacements are paid per-lookup). Evergreen, zero AI cost, zero editorial risk, exactly what libraries and newsrooms lost. Midterms 2026-11-03 make it seasonal-urgent. |
| **Bill explainer card** (headline / TLDR / what / who / why / cost, EN+ES, status, links to full Rostra page) | **V1 — second product** | Pure static data already baked nightly; the contextual embed a reporter drops into a story about that bill. Differentiator nobody else has: bilingual plain-language AI decode, labeled and human-reviewed. |
| **"Worth a call" action panel** (stance picker → AI 30-sec script → office numbers → call) | **V1.1 — paid-tier feature** | Highest value, but needs multi-tenant hardening first: shared KV script cache (current cache is in-memory per instance — README already flags this), per-tenant rate limits, and pregeneration for top-band bills. Also the feature most sensitive to partisan-host-page framing, so it ships behind ToS-accepted paid/network tenancy. |
| **Weekly "what moved" digest** | **Cut as an embed.** Reshaped in v1.1 as a free tenant-facing **JSON/RSS feed** ("what moved this week," from the existing urgency bands) that powers *their* newsletters with an attribution line. An email digest product is a different muscle (deliverability, templates, list management) a solo dev shouldn't buy into. |

Also cut: any comment/reaction/social surface (the consumer graveyard law — utilities survive, networks die), and any coverage/"Read" section in embeds (see §4 licensing).

**V1 = two embeds. V1.1 = three embeds + a feed.**

---

## 2. Architecture

### 2.1 iframe + script-tag loader — not a web component

**Decision: iframe, loaded by a tiny (~5 KB, dependency-free) script tag that injects and auto-resizes it.**

- **The privacy claim is only enforceable in an iframe.** A web component runs in the host page's JS context: the host's analytics/tag-manager scripts could read the ZIP a visitor types, observe stance selection, exfiltrate everything. Cross-origin iframe = the browser itself guarantees the host page cannot see inside. This converts the marquee claim from a promise into a mechanism — worth more than the styling flexibility a web component offers.
- CSP/security is one page (`frame-ancestors` on the embed origin) instead of auditing every host page.
- Style isolation for free; no Tailwind-vs-host-CSS wars; the #1 embed support-ticket class ("it looks broken on my site") mostly disappears.
- Auto-resize via `postMessage` height reporting (the iframe-resizer pattern) kills the #2 ticket class ("it's cut off"). The loader does injection + resize + nothing else; no fetch, no storage.
- Fallback documented for script-tag-hostile CMSes: a plain `<iframe>` tag with fixed height. (Substack cannot host iframes at all — creators stay referral partners with co-branded landing pages, not embed buyers.)

Web component revisited only if a major CMS partner demands it; noted, not planned.

### 2.2 Domain: `embed.rostra.org` subdomain, same brand — not a path, not a separate product

**Decision: subdomain, marketed as "Rostra Embeds" / "Rostra for Newsrooms" — one brand.**

- **vs. `rostra.org/embed/...` (path):** the subdomain makes the no-cookie posture *structurally* robust — even if the apex ever gains a cookie (it constitutionally won't, but "can't" beats "won't"), it never rides into embed requests. It also allows divergent security headers cleanly: apex keeps `frame-ancestors 'self'`; embed origin allows framing by anyone (free tier) with per-tenant tightening later. Same repo, same Vercel project, one domain alias — zero extra ops.
- **vs. a separate product/brand:** a solo dev cannot feed two brands. Every "Powered by Rostra" badge must pay into one domain's authority and one reputation. The Datawrapper template — free embed with attribution, paid white-label — is explicitly a *single-brand* loop.
- **SEO:** embed iframe pages get `noindex` (they'd be thin duplicates); the attribution link points to the canonical `rostra.org` bill/reps page. Host-page embeds thus generate real editorial backlinks to rostra.org. (Prerequisite: the citizen site's own `noindex` launch gate at `app/[locale]/layout.tsx:28` must be gone before embeds launch — attribution links into a noindexed site are self-defeating.)
- **Brand risk (partisan host embeds it):** a subdomain doesn't insulate from this and a separate brand only hides the flag. Mitigation is content-level, not domain-level: the widget's content is nonpartisan by construction in both languages; free-tier attribution is always visible (so the widget is legibly *Rostra's voice, not the host's*); AI labeling is mandatory at every tier; ToS forbids visually framing the widget with advocacy chrome that misattributes a stance to Rostra, with a revocation path (tenant token kill, and for free tier a `frame-ancestors` denylist for egregious cases). Position publicly: "anyone may embed the lookup — it's a utility, like embedding a map."

### 2.3 The marquee privacy claim, made verifiably true

The embed must truthfully say: **"Collects nothing about your visitors."** Specification:

1. **No cookies, ever, on the embed origin.** No `Set-Cookie` header on any `embed.rostra.org` response. Enforced by a Playwright CI test that loads every widget and asserts zero cookies, zero storage writes (the repo already has a Playwright harness and a `check-public-allowlist` gate culture to bolt this onto).
2. **No client-side persistence in embeds.** Unlike the citizen site (which uses localStorage deliberately), embeds are stateless per pageview. Browsers partition third-party storage anyway; opting out entirely makes the claim clean and testable. Cost: no "remembered ZIP" inside embeds — acceptable; the widget links to rostra.org for the persistent experience.
3. **Zero third-party requests from the iframe.** Every asset — fonts (system stack), legislator portraits, tenant logos — served from the embed origin. Consequence: portraits currently hotlink `unitedstates.github.io` (see `portraitUrl` in `lib/data.ts`); the embed mirrors portraits into the deploy/Blob at build time (public-domain images; cheap nightly-sync artifact copy). Tenant logos are **re-hosted at provisioning time** (copied to Vercel Blob), never fetched live from the tenant's server.
4. **No fingerprinting, no client analytics.** No analytics script of any kind inside the iframe. The `/api/script` and `/api/district` endpoints keep their existing stateless posture (address never stored/logged; rate limiting without durable IP logs).
5. **Analytics = tenant-level aggregate impression counts only, from server-side request counting.** Decision between "nothing at all" and "CDN-log aggregates": **ship aggregates, minimally.** Paid tenants genuinely need a number to justify renewal ("your embed loaded 41,200 times in October"). Mechanism: the tenant ID is in the iframe path (`/e/{tenant}/reps`); a daily job reads Vercel's per-path request counts (or a log-drain aggregation that retains *only* `tenant → count` per day, discarding IP/UA/referrer before storage). No per-visitor anything exists anywhere. Free tier gets no stats (upgrade nudge). *(Needs a 1-day technical spike to confirm the aggregate-only counting path works without retaining IPs anywhere.)*
6. **Verifiability as marketing.** A public `/privacy` page on the embed origin states all of the above in plain language, plus a machine-readable `privacy.json`; the docs say "open devtools on this page and check — no cookies, no third-party calls." The CI tests that enforce it are in the public repo. This is the sales pitch to post-IMLS-crisis politically-skittish libraries and privacy-conscious newsrooms: *the one civic embed whose data-capture answer is "there is nothing to disclose."* Every competitor (New/Mode, ActionButton, VoterVoice) is architecturally an advocate-data-capture funnel; Rostra's constitution turns their business model into its differentiator.

---

## 3. Tenancy without accounts creep

### 3.1 The line

The constitution forbids server-side data about **citizens**; institutional customer records are explicitly allowed. Keep the line bright:

- **Visitor data: none, ever** (§2.3).
- **Tenant data: the minimum that Stripe doesn't already hold.** Stripe is the system of record for identity, billing, email. Rostra stores only *config*: `{tenantId, domains[], planTier, theme{accentColor, radius, fontChoice}, logoBlobUrl, defaultLocale, attributionRequired}`.

### 3.2 Config storage: Edge Config/KV, not baked static JSON, not an accounts DB

- **Static JSON per tenant, baked at build:** appealing (matches the repo's static-first soul) but couples *signup* to *deploy* — a Stripe checkout at 11pm waits for a GitHub Action to commit and rebuild. Fragile (the audit history shows CI silent-failure is this repo's recurring disease) and slow.
- **Real accounts DB (passwords, dashboard, sessions):** premature. Dashboards, password reset, and session security are the single biggest hidden-cost item for a solo dev, and nothing in v1.1 needs them.
- **Decision: Vercel Edge Config (or Upstash KV) keyed by tenant ID, written by the Stripe webhook.** Instant provisioning, no rebuild, no database server, reads are edge-fast in the embed route. This is config-as-data, not accounts: there is no login.

**Tenant identity = capability token.** The paid embed URL contains a random 128-bit tenant token; the config includes a domain allowlist checked against `Origin`/`Referer` (best-effort — these can be stripped; a stolen token still only yields *paying for someone else's white-label*, detectable in the tenant's own impression stats, and rotatable in one click). No passwords in v1 or v1.1. Config changes: a "manage" form reachable via Stripe Customer Portal metadata / a signed magic link emailed on request — at <50 paid tenants, email-driven changes are minutes/week and honestly documented.

### 3.3 Free tier: zero registration

Free embeds take theme-lite options as query params on the iframe/script tag (`?locale=es&accent=...` from a constrained palette), with attribution forced on. No token, no signup, no stored anything. The public **configurator page** (pick widget, pick bill, pick locale, copy the snippet) is the entire onboarding — and it's also the top of the paid funnel ("remove the badge and add your logo →").

### 3.4 White-label mechanics

- **Theming:** CSS custom properties only — accent color (validated hex; contrast-checked at provisioning against AA on the fixed background palette — a11y is constitutional), border radius, one of ~4 safe font stacks, light/dark. **No arbitrary tenant CSS or JS in v1.1** (that's the script-injection door; revisit for network deals only, reviewed by hand).
- **Logo:** uploaded at checkout, re-hosted to Blob (§2.3), rendered in the widget header.
- **Locale default:** tenant sets `en`/`es` default; the visitor-facing EN/ES toggle is **always present** (bilingual parity is constitutional — a tenant can choose the default, not remove Spanish).
- **Attribution mechanics (the growth loop):** free tier renders "Powered by Rostra ↗" linking to the canonical rostra.org page with `utm_source={host-domain}` — this is both the backlink engine and the free-tier telemetry (referral traffic shows which hosts drive value). Paid removes the badge. **Non-negotiable at every tier:** the AI-integrity label on bill cards and scripts ("AI-decoded, human-reviewed") — that's honesty labeling, not branding, and it's constitutional.

---

## 4. Packaging & pricing

| Tier | Price | Contents | Anchor logic |
|---|---|---|---|
| **Free** | $0, attribution required | Rep lookup + bill cards, EN/ES, default theme + accent param, fair-use ~100k loads/mo/domain, community docs | Datawrapper loop; LION-median (~$138k revenue, 2024) newsrooms pay $0-with-attribution happily; this tier IS distribution |
| **Pro** | **$29/mo or $290/yr**, Stripe self-serve, no calls | White-label (logo, theme, no badge), **action panel with AI call scripts**, domain-locked token, monthly aggregate impression counts, email support | Undercuts New/Mode $44 and Newspack's $50 anchor; matches Actionable $29.99; ActionButton Plus is a $49/mo NationBuilder add-on. Deliberately NOT $9–19: too little revenue per support-ticket, and nobody else even exists under $100 — no need to race to the floor |
| **Nonprofit / library / edu** | **$15/mo or $150/yr** (self-attested, spot-checked) | Same as Pro | Libraries demonstrably buy sub-$600/yr SaaS (Niche Academy entry $588/yr); $150/yr is a no-committee purchase even post-IMLS |
| **Network / site license** | **$500–$2,000/yr flat**, hand-negotiated (the only sales motion) | All member orgs of a network get Pro; co-branded configurator ("Rostra × LION"); optional custom default theme per network | State press association ~$500–750; LION/INN ~$1,500; LWV national ~$2,000. Sold as a *member benefit* — one deal replaces 50 self-serve sales, which is the realistic sector economics (Press Forward money flows to shared infrastructure, not per-seat SaaS) |

**Revenue realism:** the honest ceiling for beloved newsroom embeds is Datawrapper's ~$3.2M ARR after 13 years (third-party estimate); the realistic year-one shape for Rostra is **2–4 network deals ($1,500–6,000) + 10–30 self-serve ($3,500–10,000) ≈ $5k–16k ARR**, with philanthropy (Press Forward-style shared-infrastructure grants) as the sector-scale upside that the network deals establish credibility for. Price accordingly (low support promise, high margin) and spend outreach time on networks, not on $29 onesies.

**AllSides CC BY-NC decision: exclude lean labels from all embed tiers, entirely.** Paid embeds shipping `data/media-bias.json` content would breach CC BY-NC outright, and even the free tier is arguably marketing for a commercial product — legally gray and reputationally dumb for a trust product. The coverage/"Read" section simply does not exist in embeds (it's also the least embed-shaped feature). The citizen site keeps it under the existing NC-with-attribution use. Alternatives noted and rejected for now: licensing AllSides (unknown cost, one more dependency) and swapping to Ad Fontes (also commercial licensing) — revisit only if a network partner specifically demands coverage-with-lean in an embed and will fund the license.

**Stripe mechanics:** Payment Links / Checkout with custom fields (domain, org name, nonprofit self-attestation) → webhook provisions Edge Config + emails the snippet. Tax via Stripe Tax. Refund-friendly, cancel-anytime, no invoices except network tier (Stripe invoicing, still no dashboard to build).

---

## 5. Ops & cost

**Infra at 100 tenants (mix of free/paid), normal load:**

| Item | Est. |
|---|---|
| Vercel Pro | $20/mo |
| Upstash KV (script cache + rate limits) | $0–10/mo |
| Blob (logos, mirrored portraits) | <$2/mo |
| Anthropic script generation | Bounded by design: 3 stances × 2 locales × ~1,085 bills ≈ 6.5k cache keys max per corpus cycle; top-band pregeneration + KV cache means steady state ≈ $10–30/mo |
| **Total** | **≈ $35–75/mo** — one Pro tenant covers it |

**Caching/CDN:** loader JS at immutable versioned URLs (`/v1/loader.js` = stable semantics, `/v1.3.2/loader.js` = pinnable, far-future cache headers + optional SRI hashes published). Iframe pages SSG/ISR with edge cache, payload budget **<30 KB** (system fonts, no client framework bloat). Data slices per widget (one bill's JSON, one ZIP's reps) served as cached JSON, not the 3.4 MB corpus. Version pinning promise: `/v1/` never breaks; data schema changes are additive within v1.

**Feb-2025-style 100x spike:** static iframes + edge cache absorb reads structurally — the failure surface is (a) **bandwidth cost**: at 100x of a 1M-loads/mo baseline × 30 KB ≈ 3 TB ≈ ~$450 of Vercel data transfer for the spike month — survivable, and mitigable by fronting the embed origin with Cloudflare if spikes recur; (b) **/api/script**: mitigated by KV-shared cache (must move off in-memory before launch — already a known caveat), pregenerating all 6 scripts for top-band bills nightly (spikes concentrate on exactly those bills, so spike traffic is ~100% cache hits), per-tenant + global rate limits, and a graceful degraded mode (serve the cached generic script; queue nothing); (c) **/api/reps and /api/district**: pure lookups/stateless proxy, fine. Vercel WAF rate rules as backstop.

**Support burden (solo):** with iframe isolation + auto-resize + a good configurator, realistic steady state is **1–3 hrs/week at 100 tenants**, spiking around elections and CMS quirks. Keep it there by: email-only support, public FAQ built from every ticket, no SLA below network tier, and refusing custom CSS requests. The network tier is where support concentration is acceptable (it's paid for).

**Abuse cases & mitigations:**
- *Partisan host framing:* content nonpartisan by construction; mandatory attribution on free; ToS + token revocation + frame-ancestors denylist for egregious misrepresentation (§2.2).
- *Script/config injection:* no tenant CSS/JS; theme values validated (hex regex, enum fonts); logos re-hosted and content-type-verified; all bill/tenant strings rendered as text, never HTML.
- *Token theft:* domain allowlist (best-effort), one-click rotation, stats anomaly visibility.
- *Defacement of the loader:* immutable versioned URLs + published SRI + the loader does nothing but inject/resize.
- *Scraping/API freeloading via the JSON slices:* accept it — the data is public-domain-derived; rate-limit only for cost.

---

## 6. Build estimate (solo-dev weeks)

**Reused from the repo (verified):** `lib/data.ts` (~140 lines, `server-only` pinned but trivially extractable), `lib/urgency.mjs`, `lib/coverage.ts`, `lib/district.ts`, `lib/taxonomy.ts`, `lib/types.ts`; the full nightly data pipeline unchanged; `/api/reps` and `/api/district` as-is; `/api/script` logic reused with cache/limit rework; components `RepCard`, `BillCard`, `ZipForm`, `AddressForm`, `DecodedSections`, `ActionPanel` (the big adaptation) as the widget UIs; `messages/en+es.json` i18n infrastructure; Playwright harness for the privacy CI gates. **All of auth-lite/keys, billing, provisioning, loader, docs/configurator are new.**

**MVP — free tier live (~4 weeks):**
- **W1:** embed route group with bare chrome-less layout; extract data access for embed slices; **rep-lookup widget** (adapt ZipForm/RepCard/AddressForm); loader.js + postMessage auto-resize.
- **W2:** **bill-card widget** (adapt BillCard/DecodedSections); query-param theming; portrait mirroring into the build; EN/ES toggle + parity.
- **W3:** privacy hardening — headers/CSP, zero-cookie/zero-third-party/zero-storage Playwright CI gates, `/privacy` + `privacy.json`; versioned loader URLs.
- **W4:** public configurator + snippet generator + gallery + docs; a11y pass (AA, focus, touch targets); launch kit (LION/INN/library-listserv outreach email, demo pages).

**v1.1 — paid + action panel (~5 weeks):**
- Stripe Checkout + webhook provisioning + emails (1.0w)
- Tenant config in Edge Config, capability tokens, domain allowlist, logo re-hosting, white-label rendering (1.0w)
- **Action-panel widget**: ActionPanel adaptation + KV script cache (replaces in-memory) + per-tenant/global rate limits + top-band pregeneration job (1.5w)
- Aggregate impression counts (log-drain/metrics job + monthly tenant email) (0.5w)
- "What moved" JSON/RSS tenant feed; admin CLI (list/rotate/revoke tenants); ToS/AUP; polish (1.0w)

**Total: ~9 solo-dev weeks to full v1.1.** A minimal free-tier demo for the demand test is much less — roughly a weekend to a week, given the static architecture. Sized-as-new subsystems: billing ≈ 1w, tenancy/keys ≈ 1w, admin ≈ 2–3 days as CLI only — kept small precisely by refusing dashboards and passwords.

---

## 7. Failure analysis — the three most likely paths to <$5k ARR

1. **Free is enough; nobody converts.** The lookup and bill card (the genuinely wanted things) are free; the paid delta (badge removal + scripts + stats) may not clear $29/mo for a ~$138k-revenue newsroom. *Early signal:* by +90 days, >40 active free domains but <3 paid conversions and configurator→checkout <1%. *Response:* this is not failure of the asset — it's failure of the self-serve tier. Shift the paid value entirely to network deals and treat free embeds as the grant-credibility metric ("embedded by 60 newsrooms in 3 months" is a Press Forward pitch, not a Stripe one).
2. **No embed demand at all — the workflow miss.** Reporters don't decorate articles with interactive civic tools; libraries route through committees; the whole category may be a builder's fantasy about other people's CMSes. *Early signal:* direct outreach to 50 named newsrooms/libraries yields <5 installs by +60 days; installed embeds show near-zero loads. *Response:* stop building, keep the free lookup alive as cheap goodwill/backlink infrastructure, and redirect effort to the citizen product or the MCP direction.
3. **Network/philanthropy deals stall past the midterm window.** LION/INN/LWV move by committee and conference cycle; post-Nov-3 civic attention collapses, and grant funding may require a fiscal sponsor. *Early signal:* zero signed LOIs or pilot commitments by 2026-11-03 despite live product and warm intros. *Response:* don't grind a solo dev against institutional sales cycles — freeze paid, keep free tier + attribution loop running at ~$0 marginal cost, revisit at the next legislative flashpoint.

**Hard kill criteria for the paid product: <10 active embedded domains OR <$300 MRR-equivalent (incl. prorated network deals) by 2027-01-31.** The free tier survives any of these outcomes at near-zero cost and keeps feeding the citizen product's distribution.

---

## Alternatives briefly noted (rejected)

- **Web component instead of iframe** — surrenders the enforceable privacy claim (§2.1).
- **Separate brand/domain product** — doubles marketing surface for zero benefit; attribution loop needs one brand (§2.2).
- **Static-baked per-tenant config** — couples signup to deploy in a repo with a documented CI-silent-failure history (§3.2).
- **Accounts DB + dashboard for institutions** — allowed by constitution, but the support and security cost is the classic solo-dev sinkhole; capability tokens + Stripe-as-CRM covers v1.1 entirely (§3.2).
- **License AllSides / swap to Ad Fontes for embed lean labels** — pay money to add editorial risk to a trust product; excluded instead (§4).
- **$9–19/mo pricing** — no competitor pressure below $100 exists; support cost per tenant doesn't halve with the price (§4).
- **Weekly digest as an email product** — deliverability/list ops is a second product; shipped as a tenant feed instead (§1).

## Open questions

- Legal entity / fiscal sponsorship: philanthropy money and some network deals may require a 501(c)(3) or fiscal sponsor — does that change whether the paid tier is a company or a project?
- Vercel per-path request metrics vs. a log drain for tenant impression counts — 1-day technical spike needed.
- Network-deal sequencing: LION first (most reachable given the $0-with-attribution culture)? Does a midterm-season pilot ("free for all members through Nov 2026, priced Jan 2027") beat asking for money up front?
- Spanish-language press: bilingual parity is the standout differentiator — is there a Spanish-language press association worth making deal #1?
- Per-tenant editorial knobs on the action panel (e.g., a tenant disabling the "oppose" stance): powerful for skittish libraries, but edges toward compromising the nonpartisan-by-construction guarantee. Default answer: no.

# Oravan MCP Server

**Status:** live, free, read-only. **Endpoint:** `https://oravan.org/api/mcp/mcp` (Streamable HTTP). **Docs page:** `https://oravan.org/mcp`. **Repository:** `https://github.com/cm2489/oravan`. **Registry:** `org.oravan/mcp` on the Official MCP Registry (`registry.modelcontextprotocol.io`).

This file is a standalone description of the server for anywhere that isn't `oravan.org` itself — directory listings, crawlers, and claim/enrich forms (PulseMCP, Glama, Smithery, Awesome MCP Servers, mcp.so). It uses the same framing and tool descriptions the live server and `docs/ideation/2026-07-02-mcp-spec.md` §2 use — nothing here is written fresh for a pitch. Descriptions below match `lib/core/mcp.ts`'s `TOOL_INFO` export as of 2026-07-11; if that changes, this file needs a matching update (it's a static copy for external redistribution, not an importable module).

**Avoid list, honored here on purpose:** no *advocacy*, *mobilize*, *campaign*, *pressure*, or *flood* language anywhere in this file, per `docs/ideation/2026-07-05-build-gtm-strategy.md` §5. This is nonpartisan civic information infrastructure, not an action or persuasion tool.

## What it is

Oravan is nonpartisan civic information infrastructure: official U.S. federal government data — bill status, sponsor, dates, text — paired with plain-language explanations in English and Spanish that help constituents understand active legislation and contact their own representatives. The MCP server exposes the same corpus the website reads to any AI agent, over five read-only tools, with no account, no API key, and a citation on every response.

**Why an agent would call this instead of Congress.gov's API or a generic legislative-document server:**

- **Pre-decoded plain language, in English and Spanish.** Congress.gov returns bill XML and status codes; Oravan returns a structured, pre-generated, human-review-gated plain-language decode in one call, in Spanish too — a bilingual decoded federal-bill corpus with no equivalent free source.
- **Representative lookup that actually resolves.** ZIP-to-district mapping across all 435 U.S. House districts, with district-office phone numbers — the number a constituent should actually call — not just a Washington, D.C. line.
- **Urgency ranking, not just an archive.** `whats_moving` answers "what's active in Congress this week," scored by an explicit, disclosed urgency model — not a raw, undifferentiated bill list.
- **One round trip, composite answers.** A ZIP code resolves to representatives and their offices in a single call; a bill slug or citation resolves to a full plain-language decode in a single call.
- **Citable by construction.** Every response carries a stable canonical URL, an explicit freshness date, and clear labeling of AI-drafted content versus the official record.

## Connect

Streamable HTTP, stateless, no authentication:

```json
{
  "mcpServers": {
    "oravan": {
      "url": "https://oravan.org/api/mcp/mcp"
    }
  }
}
```

## The five tools

All five are `readOnlyHint: true`, `openWorldHint: false` — nothing here writes anything, and nothing reaches outside Oravan's own nightly-synced data.

### `lookup_representatives`

`{ zip, locale? }` → a person's U.S. House member and two Senators by 5-digit ZIP code. Returns each member's name, party, phone, official website, portrait URL, and district-office phone numbers — the number a constituent should actually call. Some ZIP codes span more than one congressional district (`needs_address: true`, all candidate districts returned); this tool does not perform address-level refinement itself — the response points to a stateless, unlogged Census-geocoder proxy that narrows it to a single district from a street address Oravan never stores. A currently vacant House seat is listed explicitly (`vacancies`), never silently backfilled with a departed member.

### `get_bill`

`{ slug?, citation?, locale? }` → the full plain-language decode of a federal bill by slug (e.g. `"hr-2701-119"`) or citation (e.g. `"H.R. 2701"`). Returns the AI-generated summary (headline, tl;dr, what/who/why/cost — human-reviewed before publish and clearly labeled when present), the official status in plain language, an urgency band, sponsor, key dates, the official Congress.gov page, and an `act_url` to Oravan's on-site call flow. This tool never drafts a phone script — script generation only happens on-site, behind a human-review step, never over this API.

### `search_bills`

`{ query?, topic?, status?, active_only?, locale?, limit? }` → short teasers (headline, status, urgency) for bills matching a free-text query, issue topic, status, or active-only filter, most urgent first, across Oravan's bilingual federal bill corpus.

### `whats_moving`

`{ days?, topic?, locale?, limit? }` → active, plain-language-decoded bills that cleared Oravan's "act now" urgency bar within the last N days (default 7), optionally filtered by topic. Returns an honest empty list with `quiet_week: true` when nothing has cleared the bar — this tool never pads the list to look busier than Congress actually is. If the list is empty because Oravan's own data sync looks stale rather than Congress being quiet, `data_stale` is set instead, so that distinction is never lost.

### `get_representative`

`{ bioguide, locale? }` → full details for one member of Congress by bioguide ID, plus their 5 most recently active sponsored bills. Facts only: no scorecards, ratings, or vote grades.

## Every response carries a citation

Every tool response nests a `meta` object:

```json
{
  "as_of": "2026-07-11",
  "source": "Congress.gov and unitedstates/congress-legislators, via Oravan's nightly sync",
  "canonical_url": "https://oravan.org/bills/hr-2701-119",
  "ai_label": "This plain-language content is AI-generated and human-reviewed before publish. It is not the official bill text.",
  "license": "CC BY 4.0 (Oravan's AI-generated plain-language content); underlying official data is U.S. public domain (Congress.gov)."
}
```

`ai_label` is `null` and `license` reads "Public domain" when a response carries no AI-drafted content. `source`, `ai_label`, and `license` are returned in the language the query's `locale` parameter requested (English or Spanish) — the exact strings above and their Spanish equivalents are defined once in `lib/core/mcp.ts` and quoted verbatim at `https://oravan.org/citations` and `https://oravan.org/mcp`.

`as_of` is Oravan's own nightly-sync freshness date, not the moment a query ran — the data refreshes once a night from Congress.gov, not live.

## Privacy

No accounts, no API key — anyone can call it. Anonymous use is rate-limited (60 calls/minute, 1,000/day) by a short-lived, hashed counter keyed only to a caller, never a stored IP address and never linked to what was asked. Nothing about a call is logged in a way that could connect a caller to a bill, a representative, or a political position. Full policy: `https://oravan.org/privacy`.

## Not exposed over MCP, on purpose

Oravan's on-site AI call-script generator (`draft_call_script`) is deliberately not a tool here. It is the product's only per-call AI-generation cost and its highest platform-policy-review surface, and exposing it here would bypass the constitutional rule that AI content is human-reviewed before it drives a call. `get_bill`'s `act_url` field links out to the on-site flow instead, where that review step is enforced.

## Contact

`hello@oravan.org` · privacy policy: `https://oravan.org/privacy` · source: `https://github.com/cm2489/oravan`

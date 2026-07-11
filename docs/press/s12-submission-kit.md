# S12 — MCP registry & directory submission kit (owner runbook)

**Status:** copy-paste-ready. **Ruling, 2026-07-11:** quiet-submit — run every entry below this week; the announce/press moment for the MCP listing is held for the late Aug–Sep 2026 window (`docs/ideation/2026-07-05-build-gtm-strategy.md` §2, Phase 2), same as the site's own soft-public posture. Submitting to a registry now is infrastructure, not an announcement — nothing here requires the noindex lift or a press touch to be safe to run today.

**In-repo half (this PR):** `server.json`, its CI validation gate, the `/mcp` docs page, `llms.txt`, and `docs/mcp-server-readme.md` are all shipped in the same branch as this kit. Everything below is the remaining *owner* action — CLI commands only Colby can run (they need real credentials, DNS access, and external accounts this agent has none of).

**Two open blockers, read before starting:**

1. **`github.com/cm2489/oravan` is a private repository** (confirmed via `gh api repos/cm2489/oravan --jq '.private'` → `true`). The Official Registry's `repository` field, and every directory below that links out to source for transparency (Awesome MCP Servers, mcp.so, Smithery's GitHub-based flow), point at a repo the public can't open. None of the steps below are blocked by this — a private repo URL is still a syntactically valid field — but "inspect the code" claims some of these directories make about listed servers won't resolve for anyone who clicks through. Decide before submitting: keep private (submissions still work, source-inspection claims just won't resolve) or open the repo (a bigger call, outside this sprint's scope — flagging, not deciding).
2. **The Claude Connectors Directory submission portal requires a Team or Enterprise Claude.ai organization** (`claude.ai/admin-settings/directory/submissions/new` — Anthropic's own docs: "Admin settings aren't available on individual plans... only organization Owners and Primary owners can submit"). If the account submitting today is an individual plan, (f) below can't run until that's resolved — confirm the org type before starting that one.

---

## 0. Shared facts (copy these into every form below)

| Field | Value |
|---|---|
| Name | Oravan |
| One-line description (≤100 chars, the exact `server.json` string) | `Nonpartisan U.S. Congress data: bill decodes, rep lookup, bilingual EN/ES, read-only, no accounts.` |
| Longer description (for forms with more room) | "Oravan is nonpartisan civic information infrastructure: official U.S. federal government data paired with plain-language explanations in English and Spanish that help constituents understand active legislation and contact their own representatives. Free, read-only, keyless — no account required." |
| Endpoint (Streamable HTTP) | `https://oravan.org/api/mcp/mcp` |
| Docs page | `https://oravan.org/mcp` |
| Privacy policy | `https://oravan.org/privacy` |
| Support contact | `hello@oravan.org` |
| Repository | `https://github.com/cm2489/oravan` (currently private — see blocker 1 above) |
| Registry namespace | `org.oravan/mcp` |
| Version | `0.1.0` |
| Category | Government / Civic / Legislative data |
| Icon | `public/icons/icon-512.png` in the repo (512×512 PNG) |
| Authentication | None — keyless, read-only, no OAuth |
| License (AI-drafted content) | CC BY 4.0; underlying official data is U.S. public domain (Congress.gov) |

**A note on URLs in this kit vs. the original brief:** the brief that spawned this sprint listed `https://oravan.org/en/mcp` and `https://oravan.org/en/privacy` (with an `/en/` segment). The site's actual locale routing (`i18n/routing.ts`, `localePrefix: 'as-needed'`, `defaultLocale: 'en'`) never puts an `/en/` prefix on English URLs — only Spanish gets `/es/`. Every URL in this kit uses the real, live form (`/mcp`, `/privacy`, no `/en/`) rather than the brief's shorthand; an `/en/mcp` URL would 404.

**Avoid list (all forms, every field):** no *advocacy*, *mobilize*, *campaign*, *pressure*, or *flood* language. Use "nonpartisan civic information infrastructure," "official government data with plain-language explanations in English and Spanish," "helps constituents understand and contact their own representatives" (`docs/ideation/2026-07-05-build-gtm-strategy.md` §5).

---

## (a) Official MCP Registry (`registry.modelcontextprotocol.io`)

Verified 2026-07-11 against the registry's own docs (`modelcontextprotocol/registry`, `docs/modelcontextprotocol-io/{quickstart,authentication}.mdx`) — commands below are copied from there, not reconstructed from memory.

### Install `mcp-publisher`

```bash
brew install mcp-publisher
mcp-publisher --help   # sanity check
```

(Binary/curl install is the fallback if Homebrew doesn't have it yet — see the quickstart doc.)

### Domain verification (DNS — recommended; matches the existing `google-site-verification` TXT precedent on oravan.org's Vercel DNS zone)

**macOS caveat, read first:** macOS ships LibreSSL as the system `openssl`, which does **not** implement Ed25519 in `genpkey` — the command below will fail with `Algorithm Ed25519 not found` unless OpenSSL 3 is installed and invoked explicitly:

```bash
brew install openssl@3
# Apple Silicon: /opt/homebrew/opt/openssl@3/bin/openssl
# Intel:         /usr/local/opt/openssl@3/bin/openssl
# Substitute that full path for every `openssl` call below.
```

Generate the key pair and the TXT record value:

```bash
MY_DOMAIN="oravan.org"
OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl   # adjust for Intel per above

"$OPENSSL" genpkey -algorithm Ed25519 -out key.pem

PUBLIC_KEY="$("$OPENSSL" pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "${MY_DOMAIN}. IN TXT \"v=MCPv1; k=ed25519; p=${PUBLIC_KEY}\""
```

That prints the exact TXT record value to add. **Add it at the apex of `oravan.org`** (not under a selector like `_mcp-auth.oravan.org` — DNS auth here is SPF-style, apex-only) via Vercel's DNS dashboard for the `oravan.org` zone — the same panel and the same "add a TXT record at the apex" action already used for the existing `google-site-verification` record, so this is a familiar step, not a new one. Give it a few minutes to propagate.

**Keep `key.pem` somewhere durable and out of the repo** (a password manager or a local secrets file — never commit it; it is a signing credential, not a runtime secret the app needs, so `CLAUDE.md`'s runtime-secrets list doesn't apply, but it still must never land in git history).

Once the TXT record has propagated, authenticate:

```bash
MY_DOMAIN="oravan.org"
OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl

PRIVATE_KEY="$("$OPENSSL" pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
mcp-publisher login dns --domain "${MY_DOMAIN}" --private-key "${PRIVATE_KEY}"
```

**Alternative — HTTP verification** (skip DNS propagation delay; needs one file deployed instead): generate the same key pair, write `v=MCPv1; k=ed25519; p=${PUBLIC_KEY}` to a file, and serve it at `https://oravan.org/.well-known/mcp-registry-auth` (a static file under `public/.well-known/mcp-registry-auth` in this Next.js app would do it — not added in this PR since it's a credential artifact, not app code; the owner generates and commits it directly when running this step). Then:

```bash
mcp-publisher login http --domain "oravan.org" --private-key "${PRIVATE_KEY}"
```

Either method unlocks the `org.oravan/*` namespace — the reverse-DNS form of `oravan.org`, matching `server.json`'s `name: "org.oravan/mcp"` exactly (this repo's `scripts/check-server-json.mjs` gate enforces that match in CI already).

### Publish

From the repo root (where `server.json` already lives, shipped in this PR):

```bash
mcp-publisher publish
```

### Verify

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=org.oravan/mcp"
```

Confirm the returned `remotes[0].url` reads `https://oravan.org/api/mcp/mcp` and `version` reads `0.1.0`.

**Re-publishing on a version bump:** bump `version` in both `package.json` and `server.json` (the CI gate fails the PR if they disagree), then re-run `mcp-publisher publish` from repo root — no re-authentication needed while the DNS/HTTP proof stays live.

---

## (b) PulseMCP

PulseMCP ingests from the Official MCP Registry automatically ("we ingest entries from the Official MCP Registry daily and process them weekly" — pulsemcp.com/submit, verified 2026-07-11) — so (a) above is most of this step. To accelerate or to submit directly instead of waiting for the daily ingest:

- **Submit form:** `https://www.pulsemcp.com/submit` — field asks for a URL, described as "a GitHub repository, a subfolder of a repository, or a standalone website." Use `https://oravan.org/mcp` (the docs page) rather than the bare repo URL, since the repo is currently private (blocker 1) and the docs page is the more useful public landing point for PulseMCP's crawler either way.
- **Live indexed count, verified 2026-07-11:** PulseMCP's own site states **21,847 servers** indexed. This number moves constantly — re-check `pulsemcp.com` before quoting a figure in any press or grant material; don't reuse this pass's number as a fixed fact. (This replaces the GTM doc's placeholder "~19,000+, not a clean 20,000+" with a fresher, dated read — still expect it to have moved again by submission time.)
- **Claim/correct an existing listing:** no self-serve claim flow found in this pass; PulseMCP's own docs point to `hello@pulsemcp.com` for adjustments. Use that address if the auto-ingested listing needs a correction the submit form can't fix.

---

## (c) Glama

Glama auto-crawls the Official Registry too (per `docs/ideation/2026-07-02-mcp-spec.md` §4 item 5: "Glama auto-crawls the registry — claim and enrich"), so (a) is the prerequisite here as well.

- **Directory:** `https://glama.ai/mcp/servers` — has an "Add Server" action in the page navigation.
- **Scale context, verified 2026-07-11:** Glama's own count reads **54,257 servers** at time of this check — again, don't treat as fixed.
- **No explicit self-serve "claim" flow was confirmed in this pass** (the page shows "Claimed" as a listing attribute, implying one exists, but the exact URL/form wasn't reachable via this pass's fetch). Owner action: after (a) lands and Glama's crawler has had a cycle to pick it up, search `glama.ai/mcp/servers?query=oravan`, open the listing, and look for a claim/verify action on the listing page itself (commonly a GitHub-sign-in-based ownership check on directories built this way) — if none is visible, use the site's support/contact link.

---

## (d) Smithery

Smithery supports publishing an already-deployed remote server directly by URL — no SDK, no rebuild:

```bash
smithery mcp publish https://oravan.org/api/mcp/mcp -n @oravan/mcp
```

(Install the Smithery CLI first per `smithery.ai/docs` if not already present.) This is the right path here — Oravan's server is already live on Vercel; Smithery's SDK-based hosted-deployment flow is for servers Smithery itself runs, which doesn't apply. **Correction from an earlier draft of this kit:** Smithery's own `-n` naming convention is `@your-org/your-server` (npm-scope style, confirmed against `smithery.ai/docs/build/publish`), not the Official Registry's reverse-DNS form — `-n org.oravan/mcp` would likely be rejected. `@oravan` above is a placeholder for whatever Smithery org/account handle is actually submitting; confirm the real handle at `smithery.ai` before running the command, and it does not need to match the Official Registry's `org.oravan/mcp` namespace — only be recognizable as Oravan's.

---

## (e) Awesome MCP Servers / mcp.so

**Awesome MCP Servers** (`github.com/punkpeye/awesome-mcp-servers`, verified 2026-07-11): a GitHub pull request against the README, per its `CONTRIBUTING.md`. Format: one line, `[Server Name](repository-or-site-url) - Brief description`, alphabetical within its category. No dedicated Government/Civic category was confirmed to exist in this pass — check the current README's category list when opening the PR and either use the closest existing fit or ask in the PR description if none fits well. Use `https://oravan.org/mcp` as the link (not the private repo — blocker 1). One useful detail found: PRs from automated agents get a fast lane if the PR title ends in `🤖🤖🤖` — irrelevant for a human-submitted PR, noted for completeness.

**mcp.so:** this pass's fetch of `mcp.so/submit` returned an HTTP 403 (likely bot-blocking on an automated fetch, not a real outage) — the exact submission form wasn't verified. Owner action: visit `https://mcp.so` directly in a browser, find its submit/add-server flow, and use the shared facts in §0 above. Flagging as unverified-this-pass rather than guessing at a form that couldn't be loaded.

---

## (f) Claude Connectors Directory (Government & Nonprofit)

Verified 2026-07-11 against `claude.com/docs/connectors/building/submission`. **Blocker 2 above applies — confirm a Team/Enterprise Claude.ai org before starting.**

Submission happens entirely inside `claude.ai/admin-settings/directory/submissions/new` (no separate CLI or repo file). Field-by-field answers, using §0's shared facts:

- **Introduction step:** accepts remote MCP servers only — Oravan's server qualifies (it's remote, Streamable HTTP).
- **Connection step:** server URL `https://oravan.org/api/mcp/mcp`; transport: Streamable HTTP; "every user connects to the same URL" (true — no per-user routing).
- **Tools step:** auto-synced from the live server. All 5 tools already carry `title` + `readOnlyHint: true` annotations (this repo's own `tests/mcp.spec.ts` pins that in CI), so nothing should be flagged for missing annotations.
- **Listing step:**
  - Server name (≤100 chars): `Oravan`
  - Tagline (≤55 chars): `Nonpartisan U.S. Congress data, bilingual EN/ES`
  - Description (≤2,000 chars): use §0's longer description, expanded with 2-3 sentences from `docs/mcp-server-readme.md`'s "What it is" section if more length is wanted.
  - Category: Government & Nonprofit
  - Documentation URL: `https://oravan.org/mcp`
  - Privacy policy URL: `https://oravan.org/privacy`
  - Support contact: `hello@oravan.org`
  - Icon: `public/icons/icon-512.png`
  - URL slug: `oravan` (permanent once published — confirm before submitting)
- **Use cases step:** primary use case — "look up your federal representatives and their contact info by ZIP code; get a plain-language, bilingual explanation of an active bill." No account, plan, or setup required before connecting (keyless). Reads data only; writes nothing.
- **Company step:** company name `Oravan` (or Colby's legal name if no entity exists yet — the strategy doc's own funding section notes Oravan doesn't have its own 501(c)(3) yet); website `https://oravan.org`; primary contact pre-fills from the submitting account.
- **Authentication step:** select **no authentication** — matches the spec's own design rule (§2: `readOnlyHint: true`, `openWorldHint: false` on every tool "is also what lets the Claude Connectors Directory submission skip OAuth, the hardest requirement").
- **Data handling step:** the underlying API is Oravan's own (not proxied from a third party); no personal health data; no sponsored content.
- **Test & launch step:** no test account needed (keyless, public). Provide a working example call for the reviewer, e.g. `lookup_representatives` with `zip: "20002"`, and confirm every tool has been run via MCP Inspector or a custom connector before submitting (this repo's `tests/mcp-tools.spec.ts` already exercises all 5 against real data in CI, which the reviewer note can point to as evidence).
- **Compliance step:** all seven acknowledgments apply cleanly — first-party API (true), no financial transactions, no AI media generation, no prompt injection surface (read-only, no user-supplied content reaches a tool that acts on it), no conversation-data collection (constitutional no-server-side-user-data rule), public documentation (`https://oravan.org/mcp`).
- **Review step:** submit. Track status at `claude.ai/admin-settings/directory/submissions`; escalate to `mcp-review@anthropic.com` if needed.

---

## After submitting: what to update in `STATUS.md`

Once every entry above has actually been run (not just this kit written), update S12's `STATUS.md` bullet with: which of (a)-(f) are confirmed live/accepted, which are pending review, and the registry search URL from (a)'s verify step as evidence. Don't mark S12 fully done until at least (a) (the Official Registry) and (f) (Connectors Directory, if the org-type blocker clears) have a confirmed result — the others are secondary indexes that matter less on their own.

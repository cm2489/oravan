# CLAUDE.md — Oravan

Read README.md first; its **Design principles** section is the product constitution.

## Hard rules

- **No server-side user data, ever.** No accounts, no PII storage, no analytics trackers, no logs linking network addresses to political positions. Personalization belongs in `localStorage` (`lib/local.ts`).
- **Bilingual parity.** Every user-facing string goes through `messages/en.json` + `messages/es.json` — both, in the same change. No hardcoded UI strings.
- **Nonpartisan by construction.** No party-coded colors, no advocacy language, in either language.
- **AI content is always labeled and human-reviewed** before it drives a call.
- **Accessibility is not optional:** semantic HTML, visible focus, AA contrast, 44px touch targets.
- Never log or expose secrets. The only *runtime* secrets are `ANTHROPIC_API_KEY`, `GITHUB_FEEDBACK_TOKEN` (issues-only fine-grained PAT for beta feedback intake), `STRIPE_WEBHOOK_SECRET` (webhook signature verification, S18 — unset everywhere until the owner arms billing; the route refuses with 503 without it), and the Upstash REST tokens `UPSTASH_COUNTERS_REST_TOKEN` / `UPSTASH_CACHE_REST_TOKEN` / `UPSTASH_TENANCY_REST_TOKEN` (three physically separate databases: short-lived rate-limit counters vs. content cache vs. durable tenant config, a reconstructable cache of Stripe's state — never merged, never called "anonymized"); `CONGRESS_API_KEY` and the optional `NEWS_API_KEY` are build-time only (nightly sync scripts), never shipped to the client.
- Claude opens PRs but **never merges** — Colby merges.

## Architecture in one breath

Next.js 16 App Router + Tailwind v4 + next-intl. Static JSON in `data/` is the database; ~1,000 SSG pages; the only dynamic routes are `app/api/script` (Anthropic, cached + rate-limited), `app/api/reps` (pure lookup), `app/api/district` (stateless Census-geocoder proxy for split-ZIP address refinement — address never stored or logged), `app/api/feedback` (beta feedback → GitHub issue; only the volunteered text, no identifiers), `app/api/mcp/[transport]` (the MCP server: 5 read-only tools, rate-limited, citation envelope), and `app/api/stripe/webhook` (S18 tenant provisioning; 503-dark until `STRIPE_WEBHOOK_SECRET` exists). `proxy.ts` does locale negotiation only.

## This is build #3 of 3

Firewalled from the predecessor builds — the old Oravan app (its local repo location and archival plan are recorded in `docs/migration/oravan-grounding.md`; read-only reference) and the Civic Action MCP build. Don't import code or guardrail docs from either.

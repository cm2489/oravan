# CLAUDE.md — Rostra

Read README.md first; its **Design principles** section is the product constitution.

## Hard rules

- **No server-side user data, ever.** No accounts, no PII storage, no analytics trackers, no logs linking network addresses to political positions. Personalization belongs in `localStorage` (`lib/local.ts`).
- **Bilingual parity.** Every user-facing string goes through `messages/en.json` + `messages/es.json` — both, in the same change. No hardcoded UI strings.
- **Nonpartisan by construction.** No party-coded colors, no advocacy language, in either language.
- **AI content is always labeled and human-reviewed** before it drives a call.
- **Accessibility is not optional:** semantic HTML, visible focus, AA contrast, 44px touch targets.
- Never log or expose secrets. `ANTHROPIC_API_KEY` is the only *runtime* secret; `CONGRESS_API_KEY` and the optional `NEWS_API_KEY` are build-time only (nightly sync scripts), never shipped to the client.
- Claude opens PRs but **never merges** — Colby merges.

## Architecture in one breath

Next.js 16 App Router + Tailwind v4 + next-intl. Static JSON in `data/` is the database; ~1,000 SSG pages; the only dynamic routes are `app/api/script` (Anthropic, cached + rate-limited), `app/api/reps` (pure lookup), and `app/api/district` (stateless Census-geocoder proxy for split-ZIP address refinement — address never stored or logged). `proxy.ts` does locale negotiation only.

## This is build #3 of 3

Firewalled from the live Oravan app (`~/Projects/be-the-change`, read-only reference) and from the Civic Action MCP build. Don't import code or guardrail docs from either.

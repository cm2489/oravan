# Secrets inventory

The rule is page 1, rule 10 of `CLAUDE.md`: secrets are never logged and never shipped to the client, and build-time keys stay build-time. This page is the inventory behind it.

Moved here from `CLAUDE.md` on 2026-09-27 with Constitution v2, with the same content. **The status notes below (what is armed, what is unset) are copied as they stood in `CLAUDE.md` on that date and were not re-checked against Vercel or GitHub in the move** — confirm a status before acting on it.

## Runtime secrets

The only *runtime* secrets are:

| Secret | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | The Anthropic API key. |
| `GITHUB_FEEDBACK_TOKEN` | Issues-only fine-grained PAT for beta feedback intake. Since 2026-09-28 it must have Issues read/write on the private ops repo `cm2489/oravan-ops`, where `app/api/feedback` files notes; a token scoped only to the public `cm2489/oravan` makes every submission fail with 502. |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification (S18). Unset everywhere until the owner arms billing; the route refuses with 503 without it. |
| `UPSTASH_COUNTERS_REST_TOKEN` / `UPSTASH_CACHE_REST_TOKEN` / `UPSTASH_TENANCY_REST_TOKEN` | The Upstash REST tokens for three physically separate databases: short-lived rate-limit counters vs. content cache vs. durable tenant config (a reconstructable cache of Stripe's state). Never merged, never called "anonymized". |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob `oravan-blob`, private store — same-origin portrait mirror/proxy only, armed 2026-07-12. Also a nightly-sync Actions secret. |

## Build-time only

`CONGRESS_API_KEY` and the optional `NEWS_API_KEY` are build-time only (nightly sync scripts), never shipped to the client.

## Actions-only

`OPS_ISSUES_TOKEN` (added 2026-09-28) is a GitHub Actions secret on `cm2489/oravan`, never a Vercel variable: a fine-grained PAT with Issues read/write on the private ops repo `cm2489/oravan-ops`. `daily-metrics.yml` uses it to post the daily metrics digest, its traffic-spike and traffic-decline issues, and the standing pipeline-health issue there, because they carry traffic numbers and the day's spend estimate. Without it the job posts nowhere — never to the public repo — and says so in the job summary without a number. The same PAT can also serve as `GITHUB_FEEDBACK_TOKEN`.

## What checks this

`scripts/check-key-namespaces.mjs` confines each Upstash database's env vars and client constructor to its one registry module. Nothing yet checks that no secret reaches the client bundle.

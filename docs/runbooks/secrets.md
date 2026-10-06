# Secrets inventory

The rule is page 1, rule 10 of `CLAUDE.md`: secrets are never logged and never shipped to the client, and build-time keys stay build-time. This page is the inventory behind it.

Moved here from `CLAUDE.md` on 2026-09-27 with Constitution v2, with the same content. **The status notes below (what is armed, what is unset) are copied as they stood in `CLAUDE.md` on that date and were not re-checked against Vercel or GitHub in the move** — confirm a status before acting on it.

## Runtime secrets

The only *runtime* secrets are:

| Secret | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | The Anthropic API key. |
| `GITHUB_FEEDBACK_TOKEN` | Issues-only fine-grained PAT for the beta feedback intake. **Unused since 2026-09-28:** the feedback option and `app/api/feedback` were removed (owner decision), and no code reads it any more. The change that removed them did not delete the secret anywhere; restoring the feature is a revert of that change, and it needs this secret again. |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification (S18). Unset everywhere until the owner arms billing; the route refuses with 503 without it. |
| `UPSTASH_COUNTERS_REST_TOKEN` / `UPSTASH_CACHE_REST_TOKEN` / `UPSTASH_TENANCY_REST_TOKEN` | The Upstash REST tokens for three physically separate databases: short-lived rate-limit counters vs. content cache vs. durable tenant config (a reconstructable cache of Stripe's state). Never merged, never called "anonymized". |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob `oravan-blob`, private store — same-origin portrait mirror/proxy only, armed 2026-07-12. Also a nightly-sync Actions secret. |

## Build-time only

`CONGRESS_API_KEY` and the optional `NEWS_API_KEY` are build-time only (nightly sync scripts), never shipped to the client.

## Social sending (GitHub Actions secrets)

Read only by `scripts/social-send.mjs` through `.github/workflows/social-send.yml` (manual runs only), sent only to their own platform, never printed. **Not set yet; the owner creates them** (with the accounts). Until all four exist, and `data/social-sending.json` says the owner turned sending on, the sender only prints what it would send.

| Secret | What it is |
|---|---|
| `BLUESKY_HANDLE` | The Bluesky account's handle, the sign-in name. |
| `BLUESKY_APP_PASSWORD` | A Bluesky app password for that account (not the account password). |
| `TELEGRAM_BOT_TOKEN` | The Telegram bot's token; the bot is an administrator of the channel. |
| `TELEGRAM_CHANNEL` | The channel to post in, as `@channelname` or its numeric id. Not "oravan", which is taken. |

## What checks this

`scripts/check-key-namespaces.mjs` confines each Upstash database's env vars and client constructor to its one registry module. Nothing yet checks that no secret reaches the client bundle.

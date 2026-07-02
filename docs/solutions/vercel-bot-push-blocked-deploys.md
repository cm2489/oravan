---
title: Vercel silently blocked every bot-authored data-sync deploy
date: 2026-07-01
tags: [pipeline, vercel, deploys, silent-failure]
---

# Vercel silently blocked every bot-authored deploy

**What happened.** For the repo's entire life (confirmed back through every
bot commit since 2026-06-21 via the Vercel API), no nightly/weekly data-sync
commit ever deployed to production. GitHub Actions reported success, the
commit landed on `main`, and the production deployment was quietly dropped.
The site only ever looked current because human-merged PRs periodically
rebuilt `main` and dragged the pending data along.

**Root cause.** Vercel's GitHub integration only auto-deploys a push when the
commit author has a Vercel account linked to their GitHub identity. The sync
workflows commit as `cabina-sync[bot]`, which GitHub reports to Vercel as
`web-flow` — unlinked — so Vercel marked each of those production deployments
`BLOCKED` before a build even started. No error surfaced anywhere.

**Fix (PR #18).** Both data-sync workflows now call a Vercel Deploy Hook
(`VERCEL_DEPLOY_HOOK_URL` secret) after a successful commit+push; deploy hooks
aren't identity-gated. Gated on the commit step's `changed` output so no-op
nights don't trigger pointless rebuilds.

**Prevention.** PR #18's "verify the hook actually fires" checkbox was never
completed — so it's automated now. The build bakes its commit SHA into a
`<meta name="rostra-build">` tag, and after the hook fires,
`scripts/verify-deploy.mjs` polls production until it serves the exact SHA the
workflow just pushed, failing loudly on timeout. (Needs the `PROD_URL` repo
variable; until it's set the step skips with a visible notice.)

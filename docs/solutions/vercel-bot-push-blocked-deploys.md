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

**Attempted fix (PR #18) — disproven 2026-07-02.** Both data-sync workflows
were changed to call a Vercel Deploy Hook (`VERCEL_DEPLOY_HOOK_URL` secret)
after a successful commit+push, on the assumption that deploy hooks aren't
identity-gated. The first verified live run (nightly sync, 2026-07-02,
commit `5ff903a`) proved that assumption wrong: Vercel created *two*
production deployments for the commit — one from the git integration, one
from the hook (`deployHookName: data-sync`) — and marked **both** `BLOCKED`.
Hook-triggered deployments inherit the commit's author metadata and are
gated identically. The hook only ever added a second blocked deployment.

**Actual fix (2026-07-02).** The sync workflows now author commits as
`rostra-sync <223600121+cm2489@users.noreply.github.com>` — an email GitHub
maps to the repo owner's account, which is linked to the Vercel project. The
commit author is therefore authorized, Vercel's ordinary git-integration
deploy proceeds on push, and the deploy-hook step was removed (the
`VERCEL_DEPLOY_HOOK_URL` secret and the hook itself in Vercel project
settings are now unused). Cosmetic trade-off, accepted deliberately: nightly
data commits are attributed to the owner's account rather than a bot name.

**Prevention.** PR #18's "verify the hook actually fires" checkbox was never
completed — so verification is automated now, and it is what caught the
failed fix on its first live run. The build bakes its commit SHA into a
`<meta name="rostra-build">` tag, and after each data push
`scripts/verify-deploy.mjs` polls production until it serves the exact SHA
the workflow just pushed, failing loudly on timeout. (Needs the `PROD_URL`
repo variable; until it's set the step skips with a visible notice.)

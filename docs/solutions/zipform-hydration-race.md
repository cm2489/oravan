---
title: ZipForm silently rejected valid ZIPs typed during hydration
date: 2026-07-05
tags: [react, hydration, forms, e2e, silent-failure]
---

# ZipForm silently rejected valid ZIPs typed during hydration

**What happened.** PR #38's merge-ref CI failed on `tests/landing.spec.ts` and
`tests/funnel.spec.ts`: the homepage ZIP form's submit click fired but the URL
never left `/`. Every downloaded CI trace showed the same rendered alert —
*"That doesn't look like a US ZIP code. Try 5 digits."* — for a correctly
typed `78501`. Both contributing branches (#36, #37, #38) were green in
isolation; the bug never reproduced locally in 100+ attempts, including under
artificial CPU load.

**Root cause.** `ZipForm.submit()` validated a value derived purely from React
state (`typed ?? prefs.zip`), not the DOM's actual input value. When the field
is filled while the page is still hydrating, the native `input` event
dispatches before React's `onChange` listener attaches. React's post-hydration
event replay covers *discrete* events (the follow-up `click`) but **not**
`input`/`change` — so `typed` stayed at its pre-hydration `null` while the DOM
held a valid ZIP. Submit then validated stale state and rejected it. Not a
crash, no console error: a silent validation lie. The bug is latent on any
page; #36/#37/#38 merely added enough client-side surface to widen the
pre-hydration window until CI's constrained single-worker runner landed in it.

**Fix (PR #38, commit `ac74d1c`).** `submit()` reads the field's live value
synchronously via `new FormData(e.currentTarget).get('zip')`, falling back to
the state mirror only when empty. No test assertions were changed.

**Lessons.**
1. Controlled-form submit handlers must read DOM truth (FormData), not trust
   state that hydration timing can leave stale — React replays clicks, not
   input events.
2. A "flaky" E2E failure whose trace shows a *rendered validation error* is a
   real product bug wearing a flake costume — the production victim is a fast
   typer on a slow device, i.e. exactly the traffic-spike user.
3. Green-in-isolation branches can break combined; CI tests the merge ref.
   House rule since: agents merge latest main and re-run the full suite
   immediately before opening any PR.

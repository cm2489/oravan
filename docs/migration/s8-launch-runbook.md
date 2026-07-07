# S8 — Launch Cutover Runbook

The turnkey checklist for taking Oravan public. Consolidates the kickoff's Sprint 8 + the
manual-actions master list (M8–M14) + the R4/R5 record decisions into one ordered, day-of
sequence. **Colby executes the infra; the agent assists + verifies.** Every code change still
goes through a PR — the agent never pushes to `main`.

> **Go/no-go gate — M8.** S8 does not start until Colby gives the **written launch go**. Merging
> the S6–S7 PR (#61, done) does *not* trigger launch. This runbook waits for the word.

---

## Pre-flight state (confirmed 2026-07-07, going into S8)

- ✅ S0–S7 merged to `main` (`#54`–`#61`), deployed, prod verified (`cabina-nine.vercel.app` serving the new build; deploy `READY`).
- ✅ Zero-survivor clean in code (by-hand + gate). Remaining banned-term references are **only** the S8 infra below.
- ✅ Deploy receipts preserved: `docs/migration/vercel-deploy-history.json` (R4).
- ✅ Sync-bot rename (`rostra-sync` → `oravan-sync`) already live and deploying clean; **the sync email `223600121+cm2489@users.noreply.github.com` is load-bearing — NEVER touch it** (Vercel blocks deploys from unlinked authors; proven 2026-07-02).
- 🔒 **Still-on by design (do NOT lift yet):** the citizen-site noindex (`app/[locale]/layout.tsx:36`). The embed-route noindex (`app/embed/layout.tsx:47`) is **permanent** — never touch it.
- 🔒 **Held for this sprint (exactly 2 lines):** `refresh-legislators.yml` `--repo cm2489/rostra` literals (lines ~74, ~112) — flip only *after* the repo rename (M11).

---

## The cutover — strict order, verify between every step

### Step 1 · M9 — Vercel project rename + env audit  *(Colby, agent assists)*
1. **Colby:** Vercel dashboard → project `cabina` → Settings → rename to **`oravan`**.
   - Project id stays `prj_xnjVTqzPIGSxU2jXDNM7ISIUhOGt`; only the name + `*.vercel.app` URLs change.
2. **Colby → agent:** audit env-var **names** (never values) for anything name-bearing. Install the CLI + `vercel link`, then `vercel env ls`, or read the dashboard. Report the **names** back.
   - Runtime secrets that must exist: `ANTHROPIC_API_KEY`, `GITHUB_FEEDBACK_TOKEN`, `UPSTASH_COUNTERS_REST_TOKEN`, `UPSTASH_CACHE_REST_TOKEN`. Build-time: `CONGRESS_API_KEY`, `NEWS_API_KEY` (optional). Dormant/owner: `BLOB_READ_WRITE_TOKEN` (S15 portraits), `PREGEN_ENABLED` (S21 var).
   - **Check:** no env-var *name* contains `cabina`/`rostra`. Values are irrelevant to the rename — do not read or log them.
3. **Verify:** the renamed project still serves (`*.vercel.app` new alias + the old `cabina-nine.vercel.app` alias both resolve until the domain lands); latest prod deploy still `READY`.

### Step 2 · M10 — Domain: release oravan.org, attach it here  *(Colby)*
1. **Colby:** decommission/archive the **old** Oravan Vercel project (the one currently holding `oravan.org`) to release the domain (M3 decision: archive).
2. **Colby:** attach **`oravan.org`** + **`www.oravan.org`** to *this* (renamed `oravan`) project; set DNS; wait for the certificate.
3. **Verify:** `https://oravan.org` + `https://www.oravan.org` serve the app over TLS; both `*.vercel.app` aliases still serve (no alias dropped). `lib/site.ts` `SITE_ORIGIN` is already `https://oravan.org` — canonical URLs now resolve for real.

### Step 3 · M11 — GitHub repo rename (R5 strict sequence)  *(Colby, then agent)*
1. **Colby:** rename old **`cm2489/oravan` → `cm2489/oravan-brand-v1`**.
2. **Colby:** **archive** `cm2489/oravan-brand-v1`.
3. **Colby:** rename **`cm2489/rostra` → `cm2489/oravan`**. *(Accepted caveat: this claims the vacated name and breaks the old brand repo's original-URL redirect — it's private/dormant, preserved under its new name.)*
   - `cm2489/rostra` must NEVER be reused (R6) — every PR/commit-history redirect depends on it.
4. **Agent (immediately after):** open a PR flipping the **2 held workflow lines** `refresh-legislators.yml` `--repo cm2489/rostra` → `cm2489/oravan` (removing them from the naming-gate allowlist), and confirm the console easter-egg URL (already `cm2489/oravan` since S3) is correct.
5. **Verify:** GitHub Actions still run under the new name; the Vercel↔GitHub integration survived the rename — **trigger a manual `workflow_dispatch` of `sync-bills` and watch it deploy `READY`** (this is the real proof the integration + author-identity still work post-rename).

### Step 4 · M12 — Email + contact surfaces  *(Colby, agent PRs the copy)*
1. **Colby:** create **`hello@oravan.org`**; set SPF / DKIM / DMARC.
2. **Agent:** PR the address into contact surfaces (the About accountability line + Partners intake can point at it once it exists; today they point at the in-app feedback dialog).

### Step 5 · M13 — Trademark  *(Colby)*
Professional clearance search (watch items: OravanOSA + CARAVAN-formatives) → attorney opinion → file the **ITU** application *after* domains are settled.

### Step 6 · Defensive domains  *(Colby)*
Register `oravan.net` / `.app` / `.io` / `.co` + the top misspelling `orivan.org` (all confirmed available; ~$100/yr total).

### Step 7 · M14 — Lift the noindex (T+2 days after cutover, on Colby's go)  *(agent PRs)*
1. **Agent:** one PR that (a) lifts the citizen-site noindex — `app/[locale]/layout.tsx:36` `robots: { index: false }` → indexable — and (b) removes the CI launch-gate reminder step (`ci.yml`). **Never** touch the permanent embed-route noindex (`app/embed/layout.tsx:47`).
2. **Colby:** merge, confirm prod serves `index` on citizen pages and `noindex` still on `/embed/*`.
3. **Colby/agent:** submit the sitemap to Google Search Console + Bing Webmaster.

---

## Rollback notes
- The pre-migration state is tagged `pre-oravan-migration`; recent prod deploys are `isRollbackCandidate: true` (see the R4 export) — a bad deploy can be rolled back to the last-good in the Vercel dashboard.
- The GitHub rename (M11) is the least-reversible step — do it only after the domain (M10) is confirmed serving, so a rename hiccup can't take the live site down.

## Parallel owner tracks (not cutover-blocking, but launch-readiness)
Standing items from STATUS.md, independent of the infra cutover: HCB donation onboarding (unlocks the About support section + donate CTA) · ES-reviewer recruiting (start by ~Aug 17) · pregen arming (`PREGEN_ENABLED`, ~$3–4/mo) · Blob store for embed portraits · the Stripe decision (unlocks the paid tier, S18–S20).

## Deferred product polish (agent can do any time, non-blocking)
Per-article "(en inglés)" news tags (needs a coverage data-model language field) · a named legal entity on About (once the fiscal-sponsor onboarding lands) · the cosmetic `EmbedConfigurator.tsx` stale comment.

# KICKOFF — Rostra → Oravan Migration

You are a fresh Claude Fable 5 session, opened in `~/Projects/rostra`. You are the
ORCHESTRATOR and builder for the Oravan migration. All subagents run on **Sonnet 5**; you
remain Fable 5 throughout. **Ultracode and plan mode are cleared and encouraged**: enter plan
mode for Sprint 0 and for any sprint whose scope is ambiguous; use Workflow orchestration for
persona panels, fan-out sweeps, and verification passes. The founder (Colby) makes every
decision at every gate.

Before anything else, read `docs/migration/oravan-grounding.md` — every count, path, palette
value, and mechanical constraint referenced below is verified there. Do not re-derive facts
that file already establishes; DO re-verify any fact you are about to make load-bearing.

---

## MISSION

Migrate this app (currently "Rostra", infra-labeled "cabina") fully to **Oravan**: identity,
brand colors, brand assets, UI/UX, and all user-facing copy in BOTH locales — accounting for
white-label embeds and core GTM surfaces (Spanish-language newsrooms, libraries, paid org
use). The site ships `noindex` today; launch follows ~2 days after the rename lands.

## DONE = ALL FOUR, NO EXCEPTIONS

1. **Persona gate:** every persona (drafted for this run, see Sprint 6) scores **≥85%** on
   every user-facing surface across UI/UX, copy, brand coherence, and resonance. Iterate
   fix→rescore until true.
2. **Grep gate (explicit launch gate):** all code has been grepped; every required change is
   found and made. No mistakes. This gate is CI-enforced (Sprint 3) and re-run by hand in
   Sprint 7.
3. **Zero survivors:** no instance of `rostra`, `be the change`, or `cabina` (case-insensitive,
   including filenames, attrs like `data-rostra-*`, postMessage source strings, and the
   Spanish forms "sé el cambio"/"se el cambio") survives anywhere in the tree, GitHub metadata,
   or Vercel config — except items Colby explicitly exempts in writing (see Manual Decisions:
   the `lib/local.ts` localStorage shim and git history are the known candidates).
4. **Line budget:** minimize new code. Only UI, UX, and feature corrections/tweaks/adds may
   introduce meaningful new lines (25+ line additions). Renames, copy, and token swaps must be
   net-neutral-or-negative where possible. Consolidation and cleanup are a plus. Test fully
   for bugs.

## STANDING RULES (every turn, every sprint)

- **Manual-actions protocol:** at the START of every turn, surface the list of manual actions
  currently blocking or pending on Colby, step-by-step. At the END of every turn, surface the
  updated list (new items, completed items, still-waiting items). Never bury a manual item in
  prose.
- **Models:** subagents = Sonnet 5 (`model: 'sonnet'` in Workflow calls / Agent calls). You do
  the orchestration, judgment, and merges.
- **Honesty:** report failures verbatim; never skip a prescribed step silently — say what you
  skipped and why, then wait for Colby's call. If tests fail, show the output.
- **Never proceed on an unanswered question.** Gates wait for Colby.
- **Grep hygiene:** every sweep excludes `node_modules/`, `.next/`, `package-lock.json`, and
  `.git/`; `.claude/worktrees/` is deleted in Sprint 0 and must stay gone.

## MERGE & BUILD CADENCE (procedural — protection is plan-gated and unavailable)

- **No direct pushes to main. Ever.** Branch protection cannot be enabled (private repo,
  GitHub Free — verified 403); discipline is procedural and absolute.
- **One PR per sprint**, branch names `mig/s<N>-<slug>`. **Squash-merge**, strictly in sprint
  order: PR-0 → PR-1 → PR-2 → PR-3 → PR-4 → PR-5a → PR-5b → PR-6 → PR-7. If multiple PRs are
  ever open simultaneously, the LOWER sprint number merges first; higher-numbered branches
  rebase onto the new main before their own merge. No exceptions, no out-of-order merges.
- **Build cadence:** every merge to main triggers a production Vercel deploy (git integration
  is active; noindex keeps it unindexed). Therefore: a PR may merge ONLY when (a) full CI is
  green, (b) `npm run typecheck && npm run lint && npx playwright test` pass locally on the
  rebased branch, and (c) the previous sprint's deploy reached READY on Vercel. Check deploy
  state after every merge before starting the next sprint.
- **Sync window:** never merge, push, or rebase main between **07:00–08:30 UTC daily**
  (nightly bill sync commits at 07:30 as `rostra-sync`) and extend to **09:00 UTC on Mondays**
  (legislators refresh at 08:00). After any nightly data commit lands, rebase open branches
  onto main before merging.
- **Identity invariant:** the sync workflows' git email
  `223600121+cm2489@users.noreply.github.com` is load-bearing (Vercel blocks deploys from
  unlinked authors — proven 2026-07-02). Rename `user.name` rostra-sync → `oravan-sync`;
  NEVER touch the email. Verify the first post-rename nightly run deploys successfully.
- **Tag after every merge:** `oravan-s<N>` on the merge commit.

---

## SPRINT PLAN

### Sprint 0 — Preflight (plan mode; PR-0 `mig/s0-preflight`)
1. Read this file + `docs/migration/oravan-grounding.md` in full. Enter plan mode; present
   your understanding + any deviations you propose; get Colby's go.
2. Verify clean tree on main, in sync with origin. Baseline: `npm ci`, `npm run typecheck`,
   `npm run lint`, `npx playwright test` — all green before anything changes. Record the
   baseline LOC count (`git ls-files | xargs wc -l` summary) for the line-budget ledger.
3. Tag `pre-oravan-migration` on main (push tag).
4. PR-0 contents (tiny): delete stale `.claude/worktrees/agent-*` directories; `git mv`
   `docs/plans/2026-07-03-001-feat-rostra-launch-buildout-plan.md` →
   `...-feat-launch-buildout-plan.md` (filename carries the old name); fix the stale
   `cabina-sync[bot]` line in `docs/solutions/vercel-bot-push-blocked-deploys.md`.
5. MANUAL (surface to Colby): confirm pronunciation "OR-uh-van"; decide the
   `lib/local.ts` cabina.* localStorage shim (keep = recommended, documented exemption; purge
   = absolute zero-survivor); decide fate of the old oravan Vercel project + `~/Projects/oravan`
   repo (archive recommended); confirm GitHub repo rename timing (Sprint 8).

### Sprint 1 — Color exploration in a worktree → token decision (PR-1 `mig/s1-tokens`)
1. **EnterWorktree** (`color-exploration`) — all exploration happens in the worktree; main
   stays untouched until Colby picks.
2. Build THREE candidate token systems as drop-in `@theme` replacements for
   `app/globals.css:8-32`, each applied and screenshot across: home (hero), a bill detail
   page, reps lookup, the embeds configurator page, and both OG images:
   - **A. Full Oravan port:** ink #1F2E2A / signal #E65A2B / paper #F7F4EE family + tints
     (values in grounding doc §4), Instrument Serif + Inter Tight type system.
   - **B. Oravan ground, amber kept:** Oravan ink+paper, retain the existing amber accent
     (#E8A317, renamed from `booth` — no cabina-era token names survive).
   - **C. Hybrid:** Oravan palette with a newly proposed accent (justify it against the
     anti-references: no red/blue, no neon), current font stack retained.
3. Run a quick Sonnet persona panel (the Sprint 6 personas, early-draft versions) over the
   three candidates' screenshots; report scores as ADVISORY input only.
4. MANUAL GATE: present the three candidates (screenshots + rationale + persona scores) to
   Colby. **He picks. Wait.**
5. Implement the chosen system in PR-1: `@theme` tokens (rename `booth*` tokens), the Satori
   hexes in both `opengraph-image.tsx` files, `app/embed/embed.css` palette (keep its
   deliberate isolation — re-declare, don't import), `EmbedConfigurator.tsx` DEFAULT_ACCENT,
   fonts if changed (next/font in `app/[locale]/layout.tsx`). Exit/remove the worktree.

### Sprint 2 — Brand assets & identity (PR-2 `mig/s2-brand-assets`)
1. Port from `~/Projects/oravan`: `assets/brand/*.svg` (8 files) →
   `rostra/assets/brand/`; `OravanWordmark.tsx` pattern → `components/brand/OravanWordmark.tsx`
   (className-only, currentColor — matches the repo's lucide convention).
2. Replace the `PhoneCall` placeholder logo chip in `components/Header.tsx` with the real
   mark; land the wordmark wherever `t('appName')` renders as text-as-logo.
3. Regenerate: `app/icon.svg` from the Oravan mark; add `app/manifest.ts` (port oravan's,
   paper/ink theme colors — none exists in rostra today); adapt oravan's
   `scripts/gen-app-icons.mjs` if PWA icons are wanted; re-theme both OG image templates with
   the mark/wordmark.
4. Line-budget note: the wordmark component + manifest are sanctioned adds (UI); log them in
   the ledger.

### Sprint 3 — The rename sweep + CI grep gate (PR-3 `mig/s3-rename`)
The mechanical heart. Work from the grounding doc's verified inventory (406 rostra / 13
cabina hits). Sub-checklist, in order:
1. `package.json` name → `oravan`.
2. `messages/en.json` + `messages/es.json` **in lockstep** (38 hits each; `appName`,
   body-copy mentions, both locales in one commit — `check-messages-parity` and
   `tests/es-parity.spec.ts` must stay green). Fix the three hardcoded aria-labels
   (Header.tsx:33,65; Footer.tsx:26) by moving them into i18n while you're in there.
3. `lib/site.ts` SITE_ORIGIN → `https://oravan.org` + the six test files hardcoding
   `cabina-nine.vercel.app` (og-cards, hreflang, sitemap, embeds-cold-walkthrough, share ×2,
   jsonld). NOTE: deploys keep serving from cabina-nine.vercel.app until Sprint 8 attaches
   the domain — tests that fetch SITE_ORIGIN must use the Playwright webServer origin, not
   the production URL; verify none actually hit prod.
4. `public/embed.js`: WIDGET_TITLES ("Oravan representative lookup" / "Oravan bill decoder"),
   `data-rostra-*` → `data-oravan-*`, postMessage source `'rostra-embed'` → `'oravan-embed'`
   (update BOTH sides: embed.js:109 + EmbedConfigurator.tsx:101,110), `--rostra-accent` →
   `--oravan-accent` in embed.css:335 + configurator. Breaking-change note in the PR body:
   safe pre-launch (no external embedders exist — verified), impossible later.
5. MCP identity: `app/api/mcp/[transport]/route.ts` (9 hits) + `lib/core/mcp.ts` (4) — tool
   names/descriptions surface to external AI callers; rename cleanly, no alias needed
   pre-launch.
6. The remaining app/ (41), components/ (24), lib/ (17), tests/ (41), scripts/ (6) hits —
   including the GitHub-URL console easter egg in `app/[locale]/layout.tsx` (points at
   cm2489/rostra; update in Sprint 8's window or point at the future URL now, Colby's call).
7. Docs sweep (176 hits): README, PRODUCT.md, STATUS.md, CLAUDE.md, DESIGN.md (booth-token
   note), docs/plans + docs/ideation + docs/press. Historical sprint logs may keep "Rostra"
   ONLY if Colby exempts them in writing; default is full sweep.
8. Workflows: `sync-bills.yml` + `refresh-legislators.yml` — user.name → `oravan-sync`
   (EMAIL UNCHANGED), `--repo cm2489/rostra` literals (refresh-legislators.yml:74,112) staged
   to flip with the repo rename (Sprint 8; leave a TODO(s8) marker the grep gate allowlists
   until then, or hold these two lines for the Sprint 8 PR — prefer holding).
9. **Add the CI grep gate** (blocking, self-test-first — model on
   `check-key-namespaces.mjs`): `scripts/check-naming.mjs` fails CI on any case-insensitive
   match of `rostra`, `be the change`, `sé el cambio`, `se el cambio`, or `cabina` in tracked
   files (filenames included), with an explicit, documented allowlist containing ONLY
   Colby-exempted items (e.g. the localStorage shim if kept, the two Sprint-8-staged workflow
   lines). Wire into ci.yml after the parity check.
10. Full local gate + CI green; squash-merge; tag `oravan-s3`; verify Vercel deploy READY and
    the next nightly sync (07:30 UTC) commits and deploys cleanly under `oravan-sync`.

### Sprint 4 — Voice & copy pass, EN + ES (PR-4 `mig/s4-copy`)
1. Rework ALL user-facing copy to the Oravan voice — **warm, editorial, trustworthy** — per
   the verbatim personality/anti-reference definitions in the grounding doc §4 (no advocacy
   verbs, no alarmism, no gamification, calm confidence). Cover all 21 namespaces in both
   locales; ES is a first-class rewrite, not a translation pass.
2. Resolve the hero decision with Colby (MANUAL, quick): rostra's "Congress counts calls." vs
   oravan's "Your voice matters. Make it heard." vs new — present options with the S1 palette
   applied.
3. Sweep rendered non-i18n surfaces: OG image text, embed widget strings, llms.txt route,
   error/404 pages, `<title>` templates, manifest description.
4. Copy edits are line-neutral; log any structural additions in the ledger.

### Sprint 5 — White-label embeds + GTM features (PR-5a, PR-5b)
This is the sanctioned 25+ line zone. Enter plan mode first; propose scope; Colby approves.
- **PR-5a `mig/s5a-embed-whitelabel` (merges FIRST):** close the documented rep-lookup
  theming gap (param map + component); add partner white-label capability — a
  `data-brandless` (or equivalent) mode that removes/replaces the Oravan name in widget
  chrome for licensed partners, with the attribution default ON; extend EmbedConfigurator
  accordingly; tests for both modes (embed fingerprinting gate must stay green).
- **PR-5b `mig/s5b-gtm-surfaces` (merges SECOND, rebased on 5a):** the GTM surfaces the run
  needs — a `/partners` (or `/newsroom`) docs-grade page covering Spanish-language newsrooms,
  libraries, and paid org use (pricing copy only if Colby supplies terms — MANUAL input);
  ES-first parity from day one; update `docs/press/embeds-launch-kit.md` to Oravan.
- Explicit order: **5a → 5b.** If 5b is deferred, say so and renumber nothing.

### Sprint 6 — Persona gate (no PR unless fixes; fixes land as PR-6 `mig/s6-persona-fixes`)
1. Draft the persona panel FOR THIS RUN (Sonnet subagents, isolated; definitions written to
   `docs/migration/personas.md` for Colby's approval — MANUAL GATE before scoring):
   suggested seats — Spanish-language newsroom editor (embed partner), public librarian
   (program/resource lens), paid-org program director (union/LWV budget holder), white-label
   partner developer (integration lens), Spanish-dominant end user, English-dominant
   skeptical end user, accessibility-focused reader. Adjust seats to the run's needs; justify
   each.
2. Scoring protocol (pre-committed): every persona scores every user-facing surface —
   home, bill list + bill detail, reps lookup, walkthrough, about/privacy/citations/feedback,
   embeds configurator page, both embed widgets (default + white-label mode), OG cards,
   manifest/PWA chrome, EN and ES separately — on four axes (UI/UX, copy, brand coherence,
   resonance), 0–100 each. **Pass = every persona ≥85 on every surface on every axis.**
3. Publish the full score matrix. Fix failures, rescore ONLY failed cells with fresh persona
   instances, repeat until pass. Report every iteration honestly.

### Sprint 7 — Zero-survivor audit + full QA (PR-7 `mig/s7-final-audit` only if fixes needed)
1. Run `scripts/check-naming.mjs` AND an independent by-hand sweep (different tool: `git grep
   -i` + filename scan + `gh api` on repo metadata) — the gate checking itself is not enough.
2. Full suite: typecheck, lint, all 52 specs, production build, manual click-through of every
   surface in both locales. Bug pass: fix-only commits.
3. Line-budget ledger final report: net lines added/removed by sprint, with every 25+ block
   attributed to a sanctioned UI/UX/feature item.
4. Present the audit to Colby. **His written go is the launch trigger for Sprint 8.**

### Sprint 8 — Infra cutover + launch (manual-heavy; agent assists, Colby executes)
Ordered, with verification between steps:
1. Colby: Vercel dashboard — rename project `cabina` → `oravan`; audit env-var names
   (`vercel env ls` after installing CLI + `vercel link`, or dashboard) for name-bearing
   values; report names (never values) back.
2. Colby: decommission decision executed for the old oravan project (archive), releasing
   oravan.org; attach `oravan.org` (+ `www`) to this project; DNS; verify certificate + both
   vercel.app aliases still serve.
3. Colby: GitHub — rename repo `cm2489/rostra` → `cm2489/oravan`. Agent: immediately land the
   held workflow-slug edits (refresh-legislators.yml:74,112) + easter-egg URL, verify Actions
   still run and Vercel integration survived (trigger a manual `workflow_dispatch` of
   sync-bills and watch it deploy).
4. Colby: create hello@oravan.org; SPF/DKIM/DMARC; update contact surfaces (agent PRs the
   address swap).
5. Colby: professional trademark clearance search (OravanOSA + CARAVAN-formatives are the
   named watch items) → attorney opinion → file ITU application AFTER domains are settled.
6. Register defensives: oravan.net/.app/.io/.co + top misspelling `orivan.org` (all confirmed
   available; ~$100/yr total).
7. T+2 days after cutover, on Colby's go: lift the citizen-site noindex
   (`app/[locale]/layout.tsx:36`) + remove the CI launch-gate reminder step in the same PR
   (NEVER touch the permanent embed-route noindex in `app/embed/layout.tsx:47`); submit
   sitemap in Search Console + Bing.

---

## MANUAL ACTIONS MASTER LIST (surface per protocol; owner: Colby)

| # | When | Action |
|---|---|---|
| M1 | S0 | Confirm pronunciation "OR-uh-van" (affects copy lockups) |
| M2 | S0 | Decide localStorage `cabina.*` shim: keep (exempt+document) or purge |
| M3 | S0 | Decide fate of old oravan Vercel project + `~/Projects/oravan` repo |
| M4 | S1 | Pick color direction A / B / C |
| M5 | S4 | Pick hero line (Congress counts calls / Your voice matters / new) |
| M6 | S5b | Supply paid-org/pricing terms (or defer that page) |
| M7 | S6 | Approve persona panel before scoring |
| M8 | S7 | Written go for launch cutover |
| M9 | S8 | Vercel project rename + env audit (install CLI, `vercel link`, `vercel env ls`) |
| M10 | S8 | Repoint oravan.org; archive old project |
| M11 | S8 | GitHub repo rename |
| M12 | S8 | hello@oravan.org + SPF/DKIM/DMARC |
| M13 | S8 | Professional TM clearance + ITU filing |
| M14 | S8+2d | Noindex-lift go |

Boot sequence for this session: `cd ~/Projects/rostra` → read this file → read
`docs/migration/oravan-grounding.md` → enter plan mode → Sprint 0.

# STATUS — Rostra build

> Living guiding doc. Updated by the orchestrator on every PR open/merge and at every ruling.
> Convention: every sprint entry records **done-ness, PR, and issues encountered** — problems are captured here first, then compounded into `docs/solutions/` when they're durable lessons (compound-engineering rule: never solve the same problem twice).
> Operating rules: rename is the ONLY gate · Claude orchestrates, Colby reviews/merges everything · subagents on Sonnet 5 · every $ decision surfaced before commit.
> Strategy of record: `docs/ideation/2026-07-05-build-gtm-strategy.md` (approved 2026-07-05).

**Last updated:** 2026-07-06 (on PR #43 branch, orchestrator)

## Now / Next / Blocked

- **Now:** Awaiting review: #42 (S13 embed widget), #43 (S11 Upstash), #46 (S23 citability/correction page). Merged this cycle: #39, #40, #41.
- **Next:** S14 (bill-card widget, after S13), S15 (privacy CI gates). Chore #41 merged — guiding docs are tracked; agents now update STATUS.md inside their own PRs and read the strategy from any worktree.
- **Blocked on Colby:** 🔑 the NAME (gates noindex lift, identity, registry, press kit — critical path for the Sept 30 GTM calendar; needed ~mid-Aug) · HCB application (donation page + grants) · ES-reviewer recruiting (start by Aug 17) · sync-crons re-enable (due Jul 6).

## Sprint tracker

Pre-sprint features (approved verdicts, shipped Jul 4, all verified in production):
- [x] Share panel — PR #27 · slug-only URLs, `lib/site.ts` created
- [x] Beta feedback pipe — PR #28 · e2e verified (issue #32), CLAUDE.md secret amendment
- [x] Call walkthrough component — PR #29 · H.R. 1787 demo, reduced-motion/SR complete
- [x] Per-bill OG cards — PR #30 · 3,334 PNGs static, +12.3s build, freshness from sync-state
- [x] Walkthrough integration — PR #31 · homepage + bill disclosure, press webm rider

Numbered sprints (S1–S25 per strategy §1.3; resequenced 2026-07-05 under rename-only-gate ruling):
- [ ] S1 — Rename/noindex-lift, technical — **RENAME-GATED** (SITE_ORIGIN constant + sitemap/robots/hreflang substrate already built via #27/#39; remaining: noindex lift + domain confirmation, fires within days of christening)
- [ ] S2 — Identity finish — **RENAME-GATED**
- [x] S3 — Freshness stamp + urgency floor — PR #35, merged Jul 5 · *Issues:* none in-sprint; agent's own review caught a P1 hydration mismatch + a homepage/bills quiet-week contradiction pre-open
- [x] S4 — Homepage funnel (combined w/ S5) — PR #38, merged Jul 6 · *Issues:* merge-ref E2E failure post-#36/#37 → root cause was a **latent ZipForm hydration race on main** (input events not replayed post-hydration; valid ZIP rejected from stale state). Product fix (FormData live read). CI flake was a real slow-device user bug. → docs/solutions candidate
- [x] S5 — Donation surfaces — PR #38 (same) · built dark behind `DONATE_URL = null`; lights up when HCB lands
- [x] S6 — Spanish paired-script last mile — PR #33, merged Jul 5 · *Issues:* parity was already 304/304 — sprint honestly re-scoped to ES test coverage + 2 copy nits. Agent initially self-paused on stale premises (didn't fetch; didn't know rename-only ruling) → briefs now carry the ruling inline
- [x] S7 — Call-moment slice — PR #36, merged Jul 6 · pre-dial beat for all callers, voicemail never-apologize (test-enforced); night screen deferred per first-cut rule. *Issues:* agent briefly ran git commands in the main checkout (disclosed, restored; left package-file residue we cleaned) → "never cd into main checkout" rule added
- [ ] S8 — Buffer + LAUNCH gate (calendar-anchored ~Aug 25; needs rename landed)
- [x] S9 — Data core + MCP scaffold — PR #34, merged Jul 5 · *Issues:* merge conflicts vs #35 (moved the functions #35 modified) → resolved by rebase agent, "location follows branch, content follows main"; #35 logic verified function-by-function into `lib/core/`
- [x] S10 — Five MCP tools + envelope — PR #37, merged Jul 6 · ZIP-only lookup w/ refine_hint (privacy-conservative cut); quiet-week tested on real corpus; PW_PORT rider ended the port-race class. Lockfile name-sync accepted here (ends 4-agent churn class)
- [ ] S11 — Upstash two-DB rate limiting + CI privacy gate — PR #43 **OPEN**, awaiting review · plain-fetch clients (no SDK), salt 128-bit/24h w/ nightly dead-man's-switch, cache keys gain content-version hash, graceful in-memory fallback, self-testing key-namespace CI gate. *Issues:* agent initially refused on unverifiable authorization (docs were untracked — fixed by #41) + correctly declined nested CLAUDE.md edit (amendment orchestrator-authored instead). *Owner post-merge:* add the two counter secrets to GitHub Actions so the salt verifier arms (PR checklist)
- [ ] S12 — MCP registry + directory submissions — **RENAME-GATED** (DNS-bound verification)
- [ ] S13 — Embed rep-lookup widget + loader — PR #42 **OPEN**, awaiting review · 3.6KB loader (origin-derived, subdomain-migration-ready), embed route outside locale middleware (no cookies ever), embed-scoped CSP, portraits deferred to S15 (no third-party hotlink). Adopted #40's vacancy signal mid-flight
- [ ] S14 — Bill-card widget + theming
- [ ] S15 — Embed privacy hardening + CI gates (F3)
- [ ] S16 — Configurator + docs + launch kit (→ KTD-8 outreach sends week of Oct 26, post-S16)
- [ ] S17 — frame-ancestors split posture (F1, F2)
- [ ] S18 — Stripe + tenancy tokens ($ decision: surface before build)
- [ ] S19 — Action panel paid tier + shared rate-limit arch
- [ ] S20 — Impression counts (F6)
- [ ] S21 — Feed + admin CLI + ToS + pregen auth (F7; pregen ~$5–7.50/mo — surface at build)
- [x] S22 — JSON-LD + hreflang + sitemap/robots/llms.txt — PR #39, merged Jul 6 · *Findings:* #30's hreflang covered bills only; /impact structurally lacked metadata (split to server wrapper); x-default added; URL-building centralized after validator caught homepage canonical/sitemap disagreement. noindex provably untouched
- [ ] S23 — Citability/correction page + ES redistribution spot-check — PR #46, open · `/citations` (both locales), footer-reachable from every page incl. bill pages, correction path reuses the existing beta-feedback intake (`#feedback` anchor into Footer's own dialog, no parallel form). `lib/core/mcp.ts`'s `SOURCE`/`AI_LABEL_TEXT`/`LICENSE_*` exported and quoted verbatim on the page so it can't drift from the real MCP envelope. `docs/es-spotcheck-redistribution.md` assembles a real 12-bill sample (4 high-urgency, 4 recently-decoded, 4 older/settled) + rubric (legal-meaning accuracy, register/neutrality, label presence) + pass/fail criteria + a log section — no live native-speaker pass run yet, same interim-material pattern as S6's `docs/es-script-spotcheck.md`. *Findings:* the MCP envelope's `ai_label`/`source`/`license` fields are English-only regardless of the `locale` param requested — flagged on the page itself and in the spot-check doc as a real gap, not fixed in this PR.
- [ ] S24 — Federal boundary-source hardening (RDH adoption; two-clock model)
- [ ] S25 — Curated-triage state-architecture spec (spec-only)

Off-plan riders (pulled forward, rename-independent):
- [x] Data resilience: vacancy-diff + vacant UI state (§9.1(f) items 1–2 + KTD-10 tax) — PR #40, merged Jul 6 · seat-set derivation (never `terms[-1]`), seeded with the 4 real current vacancies (CA-14, FL-20, GA-13, TX-23), two-channel loud failure (≤5 vacancies → labeled issue each; >5 → exit 1 pre-commit), vacant-seat card EN/ES with no invented election claims. *Issues:* one suite run poisoned by a mid-run server death from concurrent agent load — clean isolated re-run counted, disclosed in PR. Live cron path statically validated only (crons still paused)
- [ ] RDH map-monitoring polling (§9.1(f) item 3) — follow-up after the above

## Decision log (chronological)

- 2026-07-04: Feature verdicts ruled — 3 build (shipped), 5 parked w/ triggers, notifications killed. Velocity debate: "ignore, focus on building."
- 2026-07-05: Strategy doc approved as-is. Rulings: VC dropped; embeds/MCP/ES-SEO core; donations added (HCB, off-infra); TX/CA stated. Rename = only gate; build everything else now.
- 2026-07-05: KTD-8 outreach re-timed to week of Oct 26 (post-S16) — recipients need a live product.
- 2026-07-05: "I'm concerned" stance KEPT (cost analysis: savings are cents; it's the undecided on-ramp).
- 2026-07-05: Lockfile cabina→rostra name-sync accepted via #37 (ends recurring churn; rename PR loses one line item).
- 2026-07-05: Full-speed subagents (no CPU throttling) — Colby watches and flags.

## Issues & learnings ledger (compound these)

- **ZipForm hydration race** (found via #38 CI): controlled-input state can be stale vs DOM post-hydration; React replays clicks, not input events. Fix pattern: read live values via FormData at submit. → **write docs/solutions entry** (queued for next chore PR)
- **Parallel-agent test-port race** (port 3300): fixed via PW_PORT param (#37). Pattern: shared-default ports + `reuseExistingServer:false` = cross-session poisoning.
- **Agent self-parking**: subagents ending turns "waiting" on already-resolved background notifications (2 cases). Fix: briefs mandate polling result files, never ending turn on a wait.
- **Merge-ref blindness**: green-in-isolation branches can break combined; CI tests the merge ref, local suites don't. Fix: pre-open rule — merge latest main + full suite before `gh pr create`.
- **Worktree hygiene**: agents must never cd into the main checkout (1 incident, disclosed + cleaned).
- **Stale-fetch premises**: agents must `git fetch` before reasoning about repo state (1 agent argued from a 4-day-old view).

## Definition-of-done addendum (every future PR)

1. Tests that must clear are listed in the sprint entry and green on a main-merged tree before the PR opens.
2. EN/ES parity in the same PR. 3. No $ commitment without a surfaced decision. 4. STATUS.md updated (orchestrator) on open and on merge, including issues encountered. 5. Durable lessons go to docs/solutions/ via chore PRs.

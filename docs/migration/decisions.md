# Oravan Migration — Founder Decisions Record

Written record of Colby's gate decisions, kept in-repo so the Sprint 3 grep-gate
allowlist and the Sprint 7 zero-survivor audit can cite explicit written
exemptions (done-criterion 3 requires exemptions "in writing"). Decision IDs
follow the kickoff's manual-actions master list.

## Sprint 0 — decided 2026-07-06 (structured questions, plan-mode session)

- **M1 — Pronunciation: CONFIRMED "OR-uh-van"** (caravan pattern, first-syllable
  stress; the cold-read-tested variant). S4 copy lockups unblocked.
- **M2 — `lib/local.ts` legacy localStorage shim: KEEP + EXEMPT.** The
  `cabina.prefs` / `cabina.calls` literals stay (data migration for pre-rename
  testers) and are a documented allowlist entry in the S3 CI naming gate.
- **M3 — Old Oravan app: ARCHIVE BOTH.** The `~/Projects/oravan` repo is
  archived and the old Vercel project decommissioned at Sprint 8 cutover,
  releasing oravan.org to this project. Brand kit remains readable for S1/S2.
- **M0 — Migration docs: COMMIT + EXEMPT.** The kickoff plan
  (`docs/plans/2026-07-06-002-oravan-migration-kickoff.md`) and
  `docs/migration/**` are tracked in-repo as verbatim migration history; they
  necessarily contain the banned strings and are a documented allowlist entry
  in the S3 CI naming gate.
- **Merge authority — KICKOFF GOVERNS for this run.** Claude squash-merges the
  migration PRs, strictly in sprint order, only when every cadence condition
  holds (CI green, local suite green, previous deploy READY, outside the
  07:00–08:30/09:00-Mon UTC sync window), reporting each merge immediately.
  This supersedes the CLAUDE.md "Colby merges" rule for the nine migration PRs
  only.
- **Repo rename timing — Sprint 8** (as written in the kickoff; reconfirmed at
  plan approval).

## Record-keeping decisions — decided 2026-07-06, post-S0 (structured questions)

Context: the founder uses the Rostra build (53 PRs) as portfolio evidence for
job searches. Record integrity is a first-class requirement of this migration;
where it conflicts with zero-survivor purity, these written exemptions govern.

- **R1 — S3 docs sweep scope: EXEMPT DATED RECORDS.** Dated historical docs
  keep "Rostra"/"Cabina" verbatim, as file-level allowlist entries:
  - `docs/plans/2026-07-03-001-feat-launch-buildout-plan.md`
  - `docs/plans/2026-07-06-state-expansion-triage-spec.md` (dated pre-rename
    spec; may be re-classified living at S3 review)
  - `docs/ideation/2026-07-01-post-june-audit-ideation.md`
  - `docs/ideation/2026-07-02-embeds-spec.md`
  - `docs/ideation/2026-07-02-mcp-spec.md`
  - `docs/ideation/2026-07-02-monetization-strategy.md`
  - `docs/ideation/2026-07-05-build-gtm-strategy.md`
  - `docs/solutions/two-clock-district-boundaries.md`

  Living docs are swept as planned: README, PRODUCT.md, STATUS.md, CLAUDE.md,
  DESIGN.md, `docs/press/embeds-launch-kit.md` (S5b rewrites it), and
  `docs/solutions/vercel-bot-push-blocked-deploys.md` (operational — must track
  the live sync-bot name, so swept, not exempted).
- **R2 — Immutable history: EXEMPT, confirmed in writing.** Git history
  (commits/messages), tags and releases, historical PR & issue
  titles/bodies/comments, and historical branch names are exempt from
  zero-survivor. The S7 metadata audit checks only LIVE metadata: repo
  name/description/topics/homepage, workflow files, Vercel project + env-var
  names. No history rewrite of any kind, ever.
- **R3 — Standalone artifacts: CREATED 2026-07-06.** GitHub Release "Rostra —
  final build (pre-Oravan migration)" on tag `pre-oravan-migration` in the
  primary repo, plus frozen private mirror `cm2489/rostra-archive`
  (commits/tags to 55d4b99 + the same release; GitHub-archived read-only).
  Mirrors carry no PRs — the receipts live only in the primary repo.
- **R4 — Vercel receipts: EXPORT AT S8.** Before the M9 project rename, agent
  exports the cabina project's full deployment history (JSON: timestamps,
  commit SHAs, states, URLs) to `docs/migration/vercel-deploy-history.json`;
  founder optionally adds dashboard screenshots.
- **R5 — S8 GitHub rename sequence (M10/M11 runbook, strict order):**
  (1) rename old `cm2489/oravan` → `cm2489/oravan-brand-v1`; (2) archive it;
  (3) rename `cm2489/rostra` → `cm2489/oravan`. Recorded caveat: step 3 claims
  the vacated name, which breaks the old brand repo's original-URL redirect
  (accepted — private, dormant, preserved under its new name).
- **R6 — Sacred name: `cm2489/rostra` must NEVER be reused.** Any new repo at
  that name would break every redirect into the build's PR/commit history.
  (`cm2489/be-the-change` is public and out of scope — separate product
  history; the "be the change" gate entry screens ported material only.)

## Sprint 1 — M4 color direction, decided 2026-07-06

- **M4 — Color direction: "FIELD NOTEBOOK" (candidate G).** Tarnished-brass
  accent #82632A on aged-cream paper #F3ECDD, iron-gall ink #2A2318, Fraunces
  display + Source Sans 3 body. Chosen from a six-candidate standalone slate in
  which every candidate was designed palette-blind (no exposure to the Oravan
  or Rostra palettes) and rendered with the real Oravan mark/wordmark; scored
  by an anonymized 7-persona panel. Founder rejected two earlier rounds that
  were anchored on the June Oravan kit — process record in
  `docs/migration/color-exploration/`. Consequences: the June kit's forest ink
  is retired; the `booth*` tokens are renamed `brass*` in PR-1 (no Cabina-era
  token names survive); S2 ports the mark/wordmark (color-agnostic
  `currentColor` assets) onto the new ground.

## Sprint 3 — rename sweep decisions, 2026-07-07

- **GitHub reference URLs: FLIP NOW (founder, structured question).** In-repo
  references to `github.com/cm2489/rostra` (console easter egg, doc links)
  point at `github.com/cm2489/oravan` immediately — dead for the few days
  until the S8 repo rename (site is noindex), then permanent. The two
  FUNCTIONAL `--repo cm2489/rostra` lines in `refresh-legislators.yml` are
  held per the kickoff and allowlisted (exactly 2) until S8.
- **M2-bis — `rostra.prefs` / `rostra.calls` join the legacy-key exemption.**
  The S3 rename moves live keys to `oravan.*`; consistent with M2's intent
  (testers keep their data), the shim now migrates both `cabina.*` and
  `rostra.*`. `lib/local.ts` allowlisted at exactly 4 literals.
- The CI naming gate (`scripts/check-naming.mjs`, blocking, self-test-first)
  enforces done-criterion 3 from this sprint forward; its allowlist is
  exactly this file's written exemptions (M0, M2/M2-bis, R1, the two held
  workflow lines).

## Cadence amendments — founder-approved 2026-07-07

- **Path-filtered CI (fast path):** PRs whose entire diff is `docs/**` or
  `*.md` skip the E2E build in CI (all static gates, typecheck, and lint
  still run). Every push to main runs the full suite regardless. Rationale:
  the E2E build was the dominant per-PR wall-clock cost (13–44 min).
- **Stacked branches:** the next sprint's branch may be cut from the previous
  sprint's PR branch once that PR is green-and-waiting (CI passed, awaiting
  merge order/deploy), rebasing onto main after each squash-merge. Merge
  order itself is unchanged — strictly sprint-ordered, lower number first.

## Sprint 5 — decided 2026-07-07

- **M6 — Pricing: DEFERRED.** The /partners page ships with the three
  audience sections and a licensing-contact line (the beta feedback dialog),
  no numbers. Pricing copy lands whenever the founder supplies terms.
- **M5 — Hero (recorded from S4): "Your voice matters. Make it heard." /
  "Tu voz importa. Hazla escuchar."** — founder pick from three rendered
  options.
- **S5a white-label semantics:** `data-brandless` removes the Oravan name
  from widget chrome (loader title, page title, fallback labels) while the
  attribution link stays ON; `data-attribution="none"` removes attribution
  and is documented as licensed-partner-only (honor system until the tenant
  registry exists — stated plainly on /embeds). The AI-content label is
  never removable. The public configurator offers brandless, never
  attribution removal.
- **Line budget (founder, 2026-07-07): the 25+ line rule is a CONCEPT, not
  a hard constraint** — build lean; ledger keeps light notes only.

## Sprint 6 — persona gate round 1, decided 2026-07-07

- **Panel outcome (round 1): NOT PASSED.** The seven M7-approved seats scored
  all 18 user-facing surfaces × EN/ES × 4 axes against the ≥85 bar. The core
  (home, both widgets in default + white-label, OG cards) cleared across all
  seven seats in both languages; the failures were concentrated and every one
  was confirmed in source. Full matrix + findings published to the founder as
  the S6 scorecard (Round 1).
- **Capture-integrity note (methodology, not product).** The round-1 EN
  captures for surfaces 2–12 were corrupted by a single-browser-session cookie
  bleed: after the run visited `/es`, next-intl's default `localeDetection`
  307-redirected every later bare English URL to its `/es` twin. Six of seven
  seats flagged it; confirmed by hand (`curl /bills` with/without the cookie).
  Re-captured clean (cookies isolated per navigation) and re-scored in round 2.
- **M-routing — Locale routing = URLs AUTHORITATIVE (founder decision).**
  `i18n/routing.ts` gains `localeDetection: false`. A stored `NEXT_LOCALE`
  cookie must never redirect a bare English URL to Spanish — an English link
  always renders English, Spanish lives at `/es`. Chosen over next-intl's
  sticky-cookie default because that default contradicts the S22 per-locale
  canonical-URL/hreflang architecture and is the shared-library-terminal trap
  the librarian seat raised. The language switcher still writes the cookie on
  an explicit toggle (only passive detection is disabled). Guarded by
  `tests/locale-routing.spec.ts`.
- **PR-6 fix batch — approved and landed.** (1) PWA manifest is now bilingual:
  a locale-aware `app/[locale]/manifest.webmanifest` route sourced from
  `messages/*.json`, replacing the English-only static `app/manifest.ts`, with
  a reviewed description reconciled to the shipped voice (was a stale
  M5-pending placeholder — a hard-rule parity violation all seven seats
  caught). (2) Rep-lookup widget `brandless` wiring — it was leaking "Oravan"
  in the multi-district block (the page never passed `brandless` and the widget
  had no such prop; bill-card already did it right). (3) OG ES card
  "las leyes" → "los proyectos de ley". (4) Configurator previews the page's
  own locale on `/es/embeds`. (5) Quiet-week copy clarified against news
  coverage. (6) ES office-hours time notation. (7) "Leyes" → "Proyectos" mobile
  tab. Gates green: typecheck, lint, message parity, key-namespaces, naming,
  and the targeted Playwright suite.
- **Deferred, with reasons (not silently dropped).** The "(en inglés)" tag on
  English news sources needs per-article language metadata the coverage data
  model doesn't carry (a blanket tag would mislabel the Spanish-language
  outlets Oravan courts). An About "who's behind this" accountability line is
  the founder's call on how much identity to disclose given the no-PII ethos —
  surfaced for M-input rather than invented.

## Sprint 6 — gate passed after three rounds, 2026-07-07

- **Round 2 (clean captures): 4/7 seats clean.** The failures clustered on five
  source-confirmed causes: a bill-card widget missing root padding (`.bc-root`
  vs `.re-root`'s 16px), a 36px Impact delete target (under the 44px rule), the
  About accountability gap, the Partners bug-tracker intake (no partnership
  category/reply path), and untagged English news headlines on ES bill pages.
- **PR-6 round-2 fixes (founder-approved full batch, 2026-07-07):** `.bc-root`
  padding; 44px Impact delete target; an About "Independent, and reachable"
  section stating organizational accountability + a real contact path, rendered
  outside the donation gate (deliberately NOT claiming the pending fiscal
  sponsor or the private source, and NOT the personal-identity disclosure the
  founder deferred); a dedicated "Partnership or licensing" feedback category
  (dialog + API label) with a partnership-specific opt-in contact notice — which
  also resolved a copy contradiction (dialog "we can't reply" vs a promised
  reply time) caught during verification; and a section-level ES note that
  linked coverage may be in English. Cosmetic EmbedConfigurator comment
  deferred. Deferred with reasons still standing: per-article "(en inglés)"
  tags (needs a data-model language field) and a named legal entity on About
  (launch-gated; the fiscal sponsor onboarding is in-flight).
- **S6 PASSED — round 3.** All 7 seats now score ≥85 on every surface, every
  axis, both locales. The three previously-failing seats (Elena, Priya, Amara)
  re-scored ONLY their own failed cells with FRESH instances (per protocol) and
  all cleared; the four clean seats (Rosa, Jake, Marcus, Devon) carried forward.
  Verified on production captures. The full three-round matrix was published to
  the founder as the S6 scorecard.

## Naming timeline (historical record)

- **Cabina** — infra-era name; survives in the Vercel project name until S8
  and the localStorage shim keys (exempted, M2).
- **Rostra** — renamed via PR #6, merged 2026-06-12; the main build (53 PRs)
  shipped under this name.
- **Oravan** — migration kickoff 2026-07-06; chosen for the owned domain,
  finished brandwork, and clean politics.

## Standing S3 allowlist (grows only by written entry here)

1. `lib/local.ts` — `cabina.prefs` / `cabina.calls` legacy-key literals (M2).
2. `docs/plans/2026-07-06-002-oravan-migration-kickoff.md` + `docs/migration/**` (M0).
3. The two Sprint-8-staged workflow lines (`refresh-legislators.yml` `--repo
   cm2489/rostra` literals) IF held rather than TODO-marked — finalized in S3.
4. The eight R1 dated historical docs listed above.

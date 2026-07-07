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

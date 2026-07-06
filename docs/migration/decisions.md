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

## Standing S3 allowlist (grows only by written entry here)

1. `lib/local.ts` — `cabina.prefs` / `cabina.calls` legacy-key literals (M2).
2. `docs/plans/2026-07-06-002-oravan-migration-kickoff.md` + `docs/migration/**` (M0).
3. The two Sprint-8-staged workflow lines (`refresh-legislators.yml` `--repo
   cm2489/rostra` literals) IF held rather than TODO-marked — finalized in S3.

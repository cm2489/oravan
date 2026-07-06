# Oravan Migration — Line-Budget Ledger

Done-criterion 4 of the kickoff: minimize new code. Only UI, UX, and feature
corrections/tweaks/adds may introduce meaningful new lines (25+ line blocks).
Renames, copy, and token swaps must be net-neutral-or-negative where possible.
Every sprint PR updates this ledger; Sprint 7 publishes the final report.

## Baseline (main @ 55d4b99, tag `pre-oravan-migration`, 2026-07-06)

226 tracked files, **41,010 lines** total.

| Area | Lines |
|---|---|
| app/ | 3,015 |
| components/ | 3,710 |
| lib/ | 3,135 |
| tests/ | 6,615 |
| scripts/ | 3,075 |
| messages/ | 992 |
| docs/ | 9,965 |
| data/ | 181 |
| public/ | 121 |

## Per-sprint entries

| PR | Net code lines | Net doc lines | 25+ blocks (sanctioned item) |
|---|---|---|---|
| PR-0 `mig/s0-preflight` | 0 (docs only) | + kickoff package, ledger, decisions record | none — no code touched |
| PR-1 `mig/s1-tokens` | ~+2 (token value/name swaps net-neutral; +1 `brass-deep` token, +1 contrast comment line) | + M4 decision record, exploration archive (10 JSON receipts + README) | none — token swap is value-level |

Sanctioned-add register (kickoff-named): S2 wordmark component + `app/manifest.ts`;
S5a rep-lookup theming + white-label mode; S5b GTM page. Everything else must
justify itself here or stay net-neutral.

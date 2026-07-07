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
| PR-2 `mig/s2-brand-assets` | +~110 (all kickoff-sanctioned UI adds) | — | OravanMark + OravanWordmark components (~40), lib/og-brand.ts (~20), app/manifest.ts (~20), scripts/gen-app-icons.mjs (~28) — each named in the kickoff S2 list; Header/PhoneScene/OG wiring is net-negative (placeholder chip + text removed) |
| PR-3 `mig/s3-rename` | ~+130 (gate script, kickoff-mandated); rename itself net-neutral (string swaps); +6 shim/i18n lines | sweep across living docs | scripts/check-naming.mjs (~120, the S3-mandated CI gate); LEGACY shim extension (+4); aria-label i18n keys (+2 per locale) |
| PR-4 `mig/s4-copy` | 0 (copy line-neutral, 47/47) | — | hero/lore/voice pass |
| PR-5 `mig/s5-embeds-gtm` (S5a+S5b consolidated) | ~+180 (feature work: rep-lookup theming, white-label knobs, /partners page, new spec) | press-kit capability update | budget is a concept per founder amendment — noted for the record only |
| PR-6/7 `mig/s6-s7-quality` (S6 persona gate + fixes; S7 audit) | **net +279** (+320 / −41, 20 files). Functional: locale-aware manifest route (~40, replaces the deleted static `app/manifest.ts`, −19); the mandated `tests/locale-routing.spec.ts` guard (~46); rep-lookup brandless wiring; bill-card padding; 44px Impact target; About accountability + Partners intake; `localeDetection: false`. Copy/OG/configurator edits net-neutral. Docs: personas.md (+71), decisions record, this ledger. | persona scorecard (3 rounds) | none unsanctioned — manifest route replaces the deleted static one; the test is a mandated guard; the rest is UI/copy corrections + records |

## Final report (S7, 2026-07-07)

- **Baseline** (`pre-oravan-migration`): 226 files / **41,010** lines.
- **Current** (`mig/s6-s7-quality` tip): 261 files / **44,216** lines → net **+3,206** across the full S0–S7 migration.
- Every meaningful add is a sanctioned UI/feature/mandated item: S2 brand assets + wordmark/manifest, the S3 CI naming gate (~120), S5 embed white-label + `/partners` + specs, and S6–S7's persona-panel doc, locale-aware manifest route, and the `localeDetection` regression test. Renames, copy, and token swaps were net-neutral-or-negative (S6 deleted the English-only static manifest, −19). **No unsanctioned 25+ blocks.**
- **Zero-survivor audit: clean** (by-hand `git grep` + filename scan + `check-naming.mjs`, cross-checked). The only banned-term survivors are the 6 documented allowlist literals (4 in `lib/local.ts`, 2 S8-staged workflow lines) and the S8-staged infra (repo name `rostra`, Vercel `homepage` URL) — all tracked for the M9–M11 cutover.

Sanctioned-add register (kickoff-named): S2 wordmark component + `app/manifest.ts`;
S5a rep-lookup theming + white-label mode; S5b GTM page. Everything else must
justify itself here or stay net-neutral.

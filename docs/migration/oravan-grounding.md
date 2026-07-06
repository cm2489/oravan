# Oravan Migration — Grounding Facts (hand-off recon, 2026-07-06)

Read-only recon snapshot compiled by the naming-sprint hand-off agent. Every fact below was
verified against the working tree, GitHub, or Vercel on 2026-07-06. The kickoff prompt
(`docs/plans/2026-07-06-002-oravan-migration-kickoff.md`) depends on this file.

## 1. Naming decision (why Oravan)

- Chosen by founder 2026-07-06 after a full red-team process (Civistry killed by cold-user
  measurement, 16% EN spelling; Cabina and Turna survived with mitigations; Oravan chosen for
  owned domain + finished brandwork + clean politics).
- Oravan cold-read data (35 isolated reads): spelling 85.7% (EN 88 / ES 80; "orivan" is the top
  miss), pronunciation agreement 97.1%, toxic guesses 0%. Category priming skews travel/vehicle
  (54%) off the "-van" tail — copy must do the category-setting work.
- Tested pronunciation: **OR-uh-van** (caravan pattern, first-syllable stress). Founder to
  confirm; if different, flag before any pronunciation lockup ships.
- Trademark: moderate risk, professional clearance REQUIRED before filing. Watch items:
  OravanOSA(TM) (FDA-cleared sleep-apnea device, oravanosa.com — registration not ruled out) and
  CARAVAN-formative marks in software classes. Politically clean (FEC/OpenSecrets/Ballotpedia/
  InfluenceWatch, two passes). Spanish gate: pass ("ora van" split does not fire when heard).
- Domains: oravan.org OWNED (reg 2026-05-23, currently serving the old Oravan app on Vercel);
  oravan.com = third party via HugeDomains (for sale, optional buy); oravan.net/.app/.io/.co all
  unregistered (cheap defensives); npm + PyPI "oravan" free; github.com/oravan squatted-dormant
  (2017, 0 repos).

## 2. Ban-list inventory (current tree, verified counts)

- "rostra": **406 hits** repo-wide (excl node_modules/.next/.claude/package-lock). Distribution:
  docs 176, app/ 41, tests/ 41, messages/en.json 38, messages/es.json 38 (strict parity),
  components/ 24, lib/ 17, public/embed.js 10, scripts/ 6, package.json 1 (`"name": "rostra"`).
  One FILENAME carries it: `docs/plans/2026-07-03-001-feat-rostra-launch-buildout-plan.md`
  (needs `git mv`).
- "cabina": **13 hits in 10 files.** Load-bearing ones:
  - `lib/site.ts:10` — `SITE_ORIGIN = 'https://cabina-nine.vercel.app'` (drives sitemap,
    hreflang, JSON-LD, OpenAPI, MCP).
  - Six test files hardcode that domain: tests/og-cards.spec.ts:14, hreflang.spec.ts:22,
    sitemap.spec.ts:12, embeds-cold-walkthrough.spec.ts:31, share.spec.ts:10+53,
    jsonld.spec.ts:17.
  - `lib/local.ts:33` — `LEGACY = { 'cabina.prefs', 'cabina.calls' }` localStorage migration
    shim. **Founder decision required**: keep (data migration for pre-rename testers) or purge
    to satisfy zero-survivor absolutely.
  - `app/globals.css:4` comment; `DESIGN.md:16` ("booth" token named for the Cabina era);
    `STATUS.md:57`; `docs/solutions/vercel-bot-push-blocked-deploys.md:18` (stale: says
    `cabina-sync[bot]`, live workflows actually use `rostra-sync`); plan/ideation docs.
- "be the change": **0 hits in this repo** (fixed-string greps EN + "sé el cambio"/"se el
  cambio" ES). It exists in ~/Projects/oravan docs (DESIGN_PLAYBOOK.md:13 — Oravan's own prior
  name). Gate stays: ported material must be screened.
- Stale `.claude/worktrees/agent-a0248eb9d4fce00b5/` and `agent-ada80286fe531e300/` contain
  old cabina-flavored file copies — exclude from rename tooling AND delete in S0.

## 3. Current design system (rostra)

- Tokens: Tailwind v4 `@theme` in `app/globals.css:8-32`. Palette: paper #FAF6EE,
  paper-deep #F2EBDC, surface #FFFCF6, ink #18203A (navy), ink-soft/faint, night #11182E,
  booth #E8A317 (amber accent, legacy Cabina name), booth-bright/soft, line #E2D9C6,
  moss #3E6B4F(+soft), clay #A14D3A(+soft). Plus --font-display/--font-sans aliases,
  --radius-card/control, --shadow-lift.
- Hardcoded hexes outside tokens (must move with any palette change):
  `app/[locale]/opengraph-image.tsx:26-48` and `app/[locale]/bills/[id]/opengraph-image.tsx`
  (Satori renders, cannot use CSS vars) — #11182E/#FAF6EE/#E8A317/#F2B33D;
  `app/embed/embed.css` (19 hex declarations, deliberate cross-origin isolation; theming hook
  `var(--rostra-accent, #e8a317)` at :335); `components/EmbedConfigurator.tsx:39`
  DEFAULT_ACCENT '#e8a317'.
- Fonts: next/font/google — Bricolage Grotesque (--font-display) + Public Sans (--font-body),
  applied in `app/[locale]/layout.tsx:2,12,13`.
- Placeholder logo: `components/Header.tsx:3,29` renders lucide `PhoneCall` as the logo chip —
  flagged unfinished in docs/plans/2026-07-03-001:294-295. Replace with the real mark.

## 4. Portable Oravan brand kit (~/Projects/oravan)

- Personality (PRODUCT.md:17-33, verbatim quotes preserved there): **warm, editorial,
  trustworthy**. Anti-references: generic SaaS; cold bureaucratic gov site; partisan/activist
  (no advocacy verbs, no red/blue); social gamification; crypto/techbro neon.
- Palette (globals.css:6-20 + tailwind.config.ts:12-56 with tint scales): ink #1F2E2A
  (dark green) + hover #121C19; signal #E65A2B (warm orange CTA) + hover #CB4918;
  paper #F7F4EE + dark #EDE7D8 + mid #FAF8F5; card #FFFFFF; divider #E8E2D3/#D4CBB5;
  moss #2F6B4E (success), amber #C27803 (warn), oxblood #9A2A2A (error), each with 10-tints.
- Type: Instrument Serif 400 (+italic) for h1/h2 voice moments (--font-instrument-serif);
  Inter Tight 400-700 UI/body; JetBrains Mono 500 tabular. Type scale utilities t-display 56
  → t-meta 12 uppercase; `broadsheet` clamp(2.75rem,8vw,6rem) hero exception.
- Assets: `~/Projects/oravan/assets/brand/` — oravan-mark.svg + oravan-wordmark.svg, each in
  default/black/ink/paper variants (8 files, flattened single-path SVGs). Mark = solid circle
  with the wordmark-o's swash punched out (evenodd) — self-referential monogram. Wordmark =
  lowercase Instrument Serif outlines, swash on the o, viewBox 52.3 678.2 1947.6 691.5 (~2.82:1).
- Component: `components/brand/OravanWordmark.tsx` — `{ className }` only, currentColor,
  default `h-6 w-auto` via cn(); aria-label "Oravan".
- Icons/manifest: app/icon.svg, app/manifest.ts (name/short_name Oravan, description "Make your
  voice heard. One call at a time.", bg paper, theme ink), scripts/gen-app-icons.mjs →
  public/icons/icon-192/512.png.
- Copy worth carrying (app/page.tsx + layout.tsx): "Your voice matters. Make it heard." /
  "Congress counts calls." (rostra's current hero — decide which survives) / trust line "Free.
  No ads, no data selling, no tracking." / "Anyone in the US can do this." / footer
  "Nonpartisan, by design" / title "Oravan — Make Your Voice Heard".
- Also in Downloads (references only): oravan-api-vs-app.html comparison grid + images/ (20
  sans-serif wordmark explorations) + images-2/ (40 icon/monogram explorations) — Recraft
  exports, useful if the mark gets revisited.
- Stack compatibility: oravan uses Tailwind v3 config-file tokens; rostra is Tailwind v4
  @theme CSS tokens — port VALUES, not files. Fonts port cleanly via next/font/google.

## 5. Merge/deploy mechanics (verified)

- GitHub: repo cm2489/rostra PRIVATE on Free plan → **branch protection and rulesets are
  plan-gated (403) and CANNOT be enabled.** No required checks; direct pushes to main are
  technically possible. Merge discipline is therefore procedural. All three merge methods
  enabled; branches not auto-deleted.
- CI (`.github/workflows/ci.yml`, on PR + push to main): vacancy-diff python unittest →
  npm ci → check-messages-parity → check-public-allowlist → check-key-namespaces (self-test
  first) → check-embed-fingerprinting (self-test first) → typecheck → lint →
  `npx playwright test` (52 specs, webkit, app via webServer). Launch-gate step warns (never
  fails) while `index: false` exists in app/[locale]/layout.tsx.
- Data automation: sync-bills.yml nightly cron 07:30 UTC; refresh-legislators.yml Mondays
  08:00 UTC; shared `data-sync` concurrency group; both commit to main as user.name
  `rostra-sync` with email `223600121+cm2489@users.noreply.github.com`. **The EMAIL is
  load-bearing** — Vercel blocks auto-deploys from unlinked authors (proven 2026-07-02;
  docs/solutions/vercel-bot-push-blocked-deploys.md). Rename user.name → `oravan-sync` freely;
  NEVER change the email. refresh-legislators.yml hardcodes `--repo cm2489/rostra` at lines
  74 and 112 — must update in the same window as any repo rename.
- Vercel: team cm2489s-projects; project `cabina` (prj_xnjVTqzPIGSxU2jXDNM7ISIUhOGt), Next.js,
  node 24.x, `live: false`; domains cabina-nine.vercel.app (+ two aliases);
  git-integration auto-deploy on push to main is ACTIVE (every merge = production deploy;
  noindex keeps it unindexed). Latest deploy READY.
- Env vars: **could not be enumerated by any automated path** (no vercel CLI installed, no
  .vercel/project.json link, MCP has no env endpoint). Manual dashboard/CLI audit required.
- oravan.org currently serves the OLD Oravan app from a separate Vercel deployment. Domain
  must be re-pointed to this project at S8; fate of the old oravan project/repo is a founder
  decision.

## 6. Embed / white-label surface facts

- public/embed.js: data-rostra-widget (rep-lookup|bill-card), data-locale, data-target;
  bill-card only: data-slug, data-accent, data-radius (sharp|soft|round), data-font
  (system|serif). Iframe titles hardcode "Rostra representative lookup"/"Rostra bill decoder".
  postMessage source string 'rostra-embed' (embed.js:109 + EmbedConfigurator.tsx:101,110).
  data-rostra-embed attr on injected iframes. Renaming these is a breaking API change —
  SAFE now (pre-launch; no external embedders found), impossible later.
- Documented gap: rep-lookup widget has no theme params (embed.js param map + component).
- True white-labeling (partner hides/replaces the product name in widget chrome) does NOT
  exist — new feature work if wanted.
- i18n: 21 namespaces in messages/{en,es}.json, `embeds` namespace (50 keys) is the public
  configurator page. Hardcoded aria-labels bypass i18n: Header.tsx:33,65 ("Primary"),
  Footer.tsx:26 ("Footer").
- GTM surfaces today are docs-stage only: docs/press/embeds-launch-kit.md, GTM/monetization
  ideation docs; no /pricing, /partners, /newsroom routes exist.

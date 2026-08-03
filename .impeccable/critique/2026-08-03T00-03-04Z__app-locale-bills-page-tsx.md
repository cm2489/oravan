---
target: /bills (browser, filters, search, news lens, radar buckets)
total_score: 34
p0_count: 0
p1_count: 1
score: 34
p0: 0
p1: 1
timestamp: 2026-08-03T00-03-04Z
slug: app-locale-bills-page-tsx
---
# Critique + audit — /bills (browser, filters, search, news lens, radar buckets)

Pre-launch design evaluation sweep, anchored pass. Register: **product** (earned familiarity — would a Linear/Stripe-fluent user trust it). Single-context run (no sub-agent tool in this harness; inline permitted per critique reference). Browser evidence: Playwright headless Chromium at 1280×900, 390×844, 768×1024, 320×660, EN + ES, real states walked (search hit "tax", miss "zzqqxx", Big Question alias "iran", topic filter toggle + localStorage persistence, band expansion, news lens). Detector: `detect.mjs --json` over page.tsx, BillsBrowser, BillCard, NewsLens, UrgencyEmptyState, StalenessNote, system/Chip → **0 findings, exit 0**.

## Scores

- **Critique (Nielsen, /40): 34**
- **Audit (technical, /20): 17**
- **P0: 0 · P1: 1 · P2: 4 · P3: 5**

### Nielsen heuristics (0–4)

| # | Heuristic | Score | Evidence |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Live count "2568 of 2568 bills" (`aria-live=polite`), `aria-pressed` filled-ink chips, "Data as of Aug 2, 2026" + StalenessNote sentinel, band caps announce "Show all 41 / 2527". Deductions: the "Moving" band silently vanishes on live data; focus/state lost after expansion. |
| 2 | Match with real world | 4 | Plain-language bands ("Deciding now / Moving / On the radar"), decoded statuses ("Just introduced", "On the floor calendar"), dated actions with year. 8th-grade voice holds in both locales. |
| 3 | User control & freedom | 3 | X clears, Escape clears, "Clear all filters" ghost button, chips toggle, "All topics" resets. But no collapse after "Show all", and keyboard focus is destroyed on expansion. |
| 4 | Consistency & standards | 3 | Token system rigorously applied (verified computed); shared ghost-button idiom; nav consistent. Deduction: native WebKit search-cancel ✕ renders beside the custom clear X — two adjacent clear controls while typing. |
| 5 | Error prevention | 4 | Forgiving search: bidirectional alias containment ("iran" and "war with iran" both pin), localized tag-name matching, identifier matching. Nothing on the page can error. |
| 6 | Recognition over recall | 4 | All topics visible as chips, frequency-ordered so taps rarely land empty; saved interests pre-applied and visibly pressed; `/` hint visible (desktop only, correctly hidden on touch). |
| 7 | Flexibility & efficiency | 3 | `/` shortcut works (verified), Escape, localStorage interests (`oravan.prefs` verified), alias search for laypeople. Missing: no URL state for query/filters — filtered views unshareable, back loses state (likely privacy-deliberate; flagged as owner decision, not assumed). |
| 8 | Aesthetic & minimalist | 3 | Restrained, zero slop tells, band hierarchy visible before read (3px ink rule vs hairline, 2px emphasis cards). Deductions: 30-word AI note in 12px tracked uppercase reads as fine print; desktop hero leaves the right half of a 5xl column empty. |
| 9 | Error recognition & recovery | 3 | Miss state: "0 of 2568 bills" + "No bills match. Try clearing a filter." + one-tap recovery (EN+ES verified). But that copy misdiagnoses a query-only miss with zero filters active. |
| 10 | Help & documentation | 4 | Privacy note at the point of persistence; AI provenance + flag path explained above the feed; band subheads teach the urgency model. |

### Audit dimensions (0–4)

| Dimension | Score | Evidence |
|---|---|---|
| Accessibility | 3 | Computed-verified: 3px ink outline + 2px offset on every focusable (white on the on-dark pin — two-tone system holds); contrast ledger holds in rendered colors (chip text ink-2/paper 7.87, line-strong edge on paper 3.24 with paper on one side, placeholder ink-2 7.87); targets ≥44px (chips 44, clear X 44, news rows 46); `aria-pressed`, `aria-live`, sr-only label, skip link, clean landmark/heading outline. Gaps: focus→body after "Show all" (P1); tiny native cancel button; chip-rail group mislabeled "All topics". |
| Performance | 2 | /bills HTML = **972KB raw / 198KB gzipped** — full 2,568-teaser corpus serialized twice (HTML + RSC flight) for client-side search. "Show all 2527" renders **23,023 DOM nodes / 221,212px scroll height** in one shot (568ms desktop; keystroke cost 9–14ms → 64ms after). No images; fonts self-hosted (64KB). Dev-mode JS (22MB unminified Turbopack) excluded from scoring as unrepresentative. |
| Theming / system fidelity | 4 | The two laws hold under computed-style verification: **zero green** except content-link hover decoration and the pin's go-bright CTA (actions — legal); **zero amber** (documented, owner-consistent: all six "now" cards are floor_vote, amber would be wallpaper); chips 3px / search-cards-buttons 8px; nothing is a pill; no raw hex in components; `line` used only as separator. |
| Responsive | 4 | No horizontal overflow at 320/390/768/1280 (measured scrollWidth). Chip rail scrolls one-row on mobile with a cut-chip affordance; grid 1-col→2-col; 5.8 screens at 390; ES longer strings (240px chip) fit; kbd hint hidden on touch. |
| Anti-patterns | 4 | Detector: 0 findings. No side-stripes, no gradient text, no shadows (namespace cleared), no eyebrow scaffolding, no card-grid monotony (bands differentiate). Passes the product slop test. |

## Findings

### P1 — Keyboard focus destroyed when "Show all" unmounts its own button
`components/BillsBrowser.tsx:308-316`. The button renders under `{!isOpen && …}` and unmounts on activation; verified: after focusing "Show all" and pressing Enter, `document.activeElement` = BODY. A keyboard user who expands "On the radar" (2,527 cards, 246 screens tall) is silently dropped to the top of the document and must Tab from the skip link. Fix (S): move focus to the first newly revealed card, or keep the control mounted as a real disclosure (`aria-expanded`, label flips to "Show fewer" — which also fixes the missing-collapse gap). → `$impeccable harden`

### P2 — Double clear control: native WebKit search-cancel not suppressed
`components/BillsBrowser.tsx:146` (`type="search"`) + `app/globals.css` (no `::-webkit-search-cancel-button` reset). Verified: pseudo-element computes `appearance:auto; display:inline-block`; screenshots show two adjacent ✕ marks while the field is focused with text. The native one is tiny (non-44px), unlabeled, and duplicates the custom 44px labeled button. Fix (S): `[type="search"]::-webkit-search-cancel-button { appearance: none; }`. → `$impeccable polish`

### P2 — "Show all 2527" renders the entire corpus into the DOM in one shot
`components/BillsBrowser.tsx:292-316`. 23,023 nodes, 221k px tall, 568ms on desktop Chromium; post-expansion keystrokes 64ms (was 9–14ms). On the product's stated audience (low-end mobile, slow connections) this will be seconds of jank and real memory pressure. The click is opt-in and honestly labeled, but every fluent tool paginates or virtualizes here. Fix (M): chunked reveal (+100 per click / intersection observer) or virtualization; also restores a collapse path. **decisionNeeded** (pagination pattern is a product call). → `$impeccable optimize`

### P2 — Page payload: full 2,568-teaser corpus ships in the HTML, twice
`app/[locale]/bills/page.tsx:57-61` (`bills={getTeasers(locale)}`). 972KB raw / 198KB gzipped before any JS, because every teaser is serialized in the SSG HTML and again in the RSC payload for the client search. This is the deliberate zero-server-search architecture, and it buys real privacy — but it is the single heaviest cost for the slow-connection mobile user the product names first. Options (L): trim teaser fields sent to the browser, lazy-load the radar tail on demand, or accept and record the trade. **decisionNeeded** (architecture/privacy trade the owner has to price). → `$impeccable optimize`

### P2 — The "Moving" band is silently absent on live data; taxonomy is degenerate today
`lib/taxonomy.ts:53-77` + `components/BillsBrowser.tsx:269-279`. Live corpus: now=41, moving=**0**, radar=2,527. Tie-heavy urgency (319 floor_vote bills) means everything clearing the moving floor also clears the now floor, so the middle band never renders — no message, no trace (only "now" earns an honest empty state, by documented design). The three-band architecture the subheads teach is a two-band page where "quieter right now" absorbs 98% of the corpus. A returning user who saw "Moving" last week gets no explanation. **decisionNeeded** (retune band floors vs. an honest absence note vs. accept). Fix (M). → `$impeccable clarify` for the presentation half; the floor math is a data-pipeline call outside impeccable's scope.

### P3 — Filter/search state not in the URL
`components/BillsBrowser.tsx:64,89`. No `?q=`/topic params: filtered views can't be shared or bookmarked, back doesn't restore. Fluent product users expect URL-synced filters — but a `?q=immigration` URL would put a political interest into any host's access logs, which the privacy constitution exists to prevent. Likely deliberate; needs an owner ruling recorded, not a silent gap. **decisionNeeded** (S if hash-fragment state, which never reaches server logs, is acceptable). → `$impeccable harden`

### P3 — Chip-rail group labeled "All topics"
`components/BillsBrowser.tsx:178` reuses `t('bills.all')` — the group's accessible name duplicates its first button. A screen-reader user hears "All topics, group" then "All topics, toggle button". Fix (S): distinct `bills.topicFilters` string in both locales. → `$impeccable clarify`

### P3 — Miss-state copy misdiagnoses a query-only miss
`components/BillsBrowser.tsx:253` + `messages/*/bills.noResults`. "No bills match. Try clearing a filter." shows when zero topic filters are active and only the query missed (verified EN "zzqqxx", ES parity identical). Fix (S): branch copy ("Try a different word or a bill number") or make the string cover both. → `$impeccable clarify`

### P3 — EN search placeholder undersells; ES already has the better copy
`messages/en.json bills.searchPlaceholder` "Search by topic or number" vs ES "Buscar — tema, palabra o número". Search also matches title/headline words in both locales (`BillsBrowser.tsx:102-108`), so the ES string is accurate and the EN one under-promises. Cross-locale copy drift, not a parity break. Fix (S). → `$impeccable clarify`

### P3 — The AI provenance note is 30 words of 12px tracked uppercase
`app/[locale]/bills/page.tsx:44-48` via `Chip tone="ai"` (unboxed, owner ruling 2026-08-01). On this page the caption is a 3–4 line all-caps paragraph — the page's central trust claim set as fine print, on a product that promises 8th-grade readability. Contrast passes (ink-2 7.87). Options (S): shorten the string to one clause + link, or let long captions drop to sentence case. **decisionNeeded** (touches the 2026-08-01 chip ruling). → `$impeccable typeset`

## Strengths

- The two laws survive computed-style verification on a complex interactive surface: zero unearned green, zero amber, 3px/8px shape law exact, detector-clean.
- Honesty engineering is visible everywhere: the pinned Big Question sits outside the bill count and never inflates it ("iran" → pin + "15 of 2568 bills"); teardown-resistant staleness sentinels; empty states that refuse to claim "quiet week" from a build-time clock.
- The alias→Big Question pin works bilingually end-to-end (`/questions/iran-war-powers`, `/es/questions/iran-war-powers`) with correct on-dark focus (white 3px ring, verified).
- Keyboard support beyond the checklist: `/` focuses search, Escape clears, visible two-tone focus everywhere.
- ES parity is essentially perfect: every string, the miss state, the pin, chip sizing for longer Spanish labels (240px chip, 44px height, no overflow at 390).
- Responsive discipline: no horizontal overflow 320→1280, one-row scrolling chip rail with a natural cut-chip affordance.

## Method

Playwright (project's @playwright/test via createRequire) headless Chromium against localhost:3000 dev server; computed styles, bounding rects, network sizes, and DOM counts read programmatically, not eyeballed; screenshots at both mandated viewports plus 768/320. `detect.mjs` run on all seven surface source files (0 findings). Caveats flagged: JS bundle weight not scored (dev-mode Turbopack, 22MB unminified — unrepresentative); "quiet week" empty state unreachable on the live hot corpus (code-reviewed only); Firefox/Safari not driven (WebKit cancel-button finding derived from Chromium computed styles + Tailwind v4 preflight, which does not reset the cancel button).

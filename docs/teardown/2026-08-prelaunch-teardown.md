# Pre-launch teardown — Phase 1 report (v2)

*2026-08-03. Campaign plan: `~/.claude/plans/hazy-sprouting-hummingbird.md`. This v1 carries the full evaluation sweep (11 surface units, critique /40 + audit /20, dual-viewport, snapshots in `.impeccable/critique/`), the triaged detector sweep, and the 2026-08-02 blind-panel cross-reference. v2 (2026-08-04) adds the benchmark + walkthrough addendum at the foot of this file.*

## Scoreboard

| Surface | Critique /40 | Audit /20 | P0 | P1 | Weight |
|---|---|---|---|---|---|
| /bills/[id] — bill detail (product register), 8-bill sample: s-3988-11 | 35 | 18 | 0 | 3 | ×3 |
| / (homepage, EN+ES) — brand register, anchored sweep | 33 | 18 | 0 | 1 | ×3 |
| /bills (browser, filters, search, news lens, radar buckets) — product  | 34 | 17 | 0 | 1 | ×2 |
| /reps (ZIP flow: empty, invalid, clean 78501, PO-box 30301, split 1000 | 35 | 19 | 0 | 1 | ×2 |
| /embeds (configurator + docs), register: product | 35 | 16 | 0 | 1 | ×2 |
| /embed/bill-card + /embed/action-panel + /embed/rep-lookup (product re | 30 | 18 | 0 | 2 | ×2 |
| /questions + /questions/[id] (Big Questions index + both live entries: | 36 | 19 | 0 | 1 | ×1.5 |
| /record — the civic record (product register; empty + populated + eras | 33 | 17 | 0 | 2 | ×1.5 |
| /why-call (register: brand) — EN + ES, 320/390/768/1280 | 36 | 19 | 0 | 0 | ×1.5 |
| /about, /partners, /citations, /mcp — EN + ES, brand register (anchore | 34 | 19 | 1 | 0 | ×1 |
| /privacy, /terms, /embeds/terms, both 404s, error boundary, loading sk | 27 | 17 | 0 | 2 | ×1 |

**Weighted overall: 85.9%** (target ≥90% + zero P0/P1 = "100%" per the campaign definition). Open at sweep time: **1 P0, 14 P1**. The P0 (About raw i18n keys — the campaign's own regression) is hotfixed in PR #147; post-fix the burn-down is P1-only.

**Trend, homepage:** July critique 28/40 with 2 P0 → **33/40 with 0 P0** — both July P0s verified fixed in-browser (h1/specimen intersection at 5 widths × 2 locales; the crown's amber claim gated on the record's own calendar sentence).

## The P0 (hotfixed)
- **/about renders raw i18n keys in the operator/funding paragraph, both locales** — app/[locale]/about/page.tsx:43,50 calls t('builtBy')/t('repoLinkLabel') with the 'about' namespace (line 19), but both keys live under 'privacy' (messages/en.json:436-437, messages/es.json:436-437). Rendered text at http://localhost:3000/about and /es/about is the literal 'about.builtBy about.repoLinkLabel' — the paragraph naming Colby Maxwell and linking the public repo, directly above the Stripe donation ask; on /es the visible literals are the English key paths (double parity break). Two server MISSING_MESSAGE console errors confirm; Next dev overlay shows '2 Issues'. Introduced by commit c *(PR #147)*

## All P1s, ranked by funnel weight

| # | Finding | Surface | Effort | Decision needed |
|---|---|---|---|---|
| 1 | Generic script failure dead-ends the entire call path | /bills/[id] — bill detail (product r | S |  |
| 2 | Unknown bill slugs bypass the localized 404 (EN-only, lang="en", no chrome) | /bills/[id] — bill detail (product r | M |  |
| 3 | Floating call button collides with the green panel's own CTA on floor-calendar bills | /bills/[id] — bill detail (product r | S |  |
| 4 | Rows + specimen kicker claim "On the floor calendar" against records that say otherwise | / (homepage, EN+ES) — brand register | M | YES |
| 5 | Keyboard focus destroyed when 'Show all' unmounts its own button | /bills (browser, filters, search, ne | S |  |
| 6 | multiDistrict note says "both" for ZIPs spanning 3-6 districts | /reps (ZIP flow: empty, invalid, cle | S |  |
| 7 | Color-drag remounts preview iframe per input event — July remount finding NOT fixed on mai | /embeds (configurator + docs), regis | M |  |
| 8 | Unpressed toggle hover erases its own label (1.58:1 light / 1.37:1 dark) | /embed/bill-card + /embed/action-pan | S |  |
| 9 | API failure misdiagnosed as "invalid ZIP" with aria-invalid on a correct input | /embed/bill-card + /embed/action-pan | M |  |
| 10 | summary_large_image share card with no image | /questions + /questions/[id] (Big Qu | S | YES |
| 11 | Cancel button edge fails the constitution's own wash-ground contrast rule | /record — the civic record (product  | S |  |
| 12 | Erase flow drops keyboard focus to <body> twice; confirmation may be silent to screen read | /record — the civic record (product  | M |  |
| 13 | Locale 404 is dead code — every 404 renders the bare English root fallback | /privacy, /terms, /embeds/terms, bot | S |  |
| 14 | "[FOUNDER: fill]" placeholder is live on public /embeds/terms §9, both locales | /privacy, /terms, /embeds/terms, bot | S | YES |

## P1 details

### Generic script failure dead-ends the entire call path
*/bills/[id] — bill detail (product register), 8-bill sample: · effort S · $impeccable harden*

When /api/script fails non-429, no fallback script is seeded (only the 429 branch seeds one: components/ActionPanel.tsx:270 vs :275), and every call affordance — phone numbers, ZIP form, foot CTA, modal, Capitol switchboard — is gated behind `script &&` (ActionPanel.tsx:516, :742, :765). Walked live at localhost:3000/bills/sjres-99-119: stance click -> 'Couldn't draft a script right now' -> zero phone numbers anywhere on the page. An Anthropic outage takes the product's core action down with it, against funnel invariant I2 (tests/funnel.spec.ts). Fix: seed the same honestly-labeled static fallback template on generic failure that the 429 path already uses.

### Unknown bill slugs bypass the localized 404 (EN-only, lang="en", no chrome)
*/bills/[id] — bill detail (product register), 8-bill sample: · effort M · $impeccable harden*

Verified live: /es/bills/hr-99999-119 returns the ROOT not-found — English copy, lang="en", system font, no header/footer — while app/not-found.tsx:3-6 claims in-app slugs are caught by app/[locale]/not-found.tsx (they are not: `dynamicParams = false` at app/[locale]/bills/[id]/page.tsx:56 404s above the locale boundary). Bilingual-parity hard rule broken on exactly the path a dropped/re-synced bill link produces for a Spanish visitor. Fix carefully: the soft-404 rationale documented at page.tsx:50-55 must survive — e.g. dynamicParams=true plus the existing getBill()->notFound() guard at page.tsx:116, which 404s inside the locale boundary.

### Floating call button collides with the green panel's own CTA on floor-calendar bills
*/bills/[id] — bill detail (product register), 8-bill sample: · effort S · $impeccable adapt*

FloorVotePanel's 'Make your call' CTA carries no data-call-cta (components/system/FloorVotePanel.tsx:161), so FloatingCallButton never stands down for it — at 390x844 both CTAs are visible simultaneously; at 320 the floating button visually OVERLAPS the panel's white button (screenshots en-floorCal-390.png, spot-320-sjres-141-119.png in the sweep scratchpad). This violates the component's own contract (components/FloatingCallButton.tsx:9-12: 'two identical buttons are never visible at once'). Both target #act so the task is not blocked — but the collision sits on the loudest surface the product has. Fix: add data-call-cta to the bill page's FloorVotePanel usage (or its section wrapper).

### Rows + specimen kicker claim "On the floor calendar" against records that say otherwise
*/ (homepage, EN+ES) — brand register, anchored sweep · effort M · $impeccable clarify (label) + $impeccable harden (row gate)*

app/[locale]/page.tsx:654 (listing status via tShared('bills.status.'+b.status)) and :149 (specimen kicker); label at messages/en.json + es.json bills.status.floor_vote. On the 2026-08-02 corpus: H.R. 6500 last action = cloture motion; S.J.Res 199 = motion to proceed REJECTED 47-52; S.J.Res 181 = motion to discharge REJECTED 49-50 — all three print "On the floor calendar" / "En el calendario del pleno" on the truth-first front door, directly under weekNote's "the green panel marks one fact". July's P0 fix landed at the panel (crown bill S.J.Res 187 genuinely reads "Placed on Senate Legislative Calendar", strict floorCalendarChamber() gate verified); the row-level half ("rows that fail the sentence print the last action verbatim") did not land. Fix: rows failing floorCalendarChamber() print a procedural status or the last action verbatim. The string is shared sitewide (bill pages, /bills, embeds), so bucket relabel vs. row-level override is an owner call.

### Keyboard focus destroyed when 'Show all' unmounts its own button
*/bills (browser, filters, search, news lens, radar buckets)  · effort S · $impeccable harden*

components/BillsBrowser.tsx:308-316 — the button renders under {!isOpen && ...} and unmounts on activation. Verified in Playwright: focus 'Show all', press Enter, document.activeElement === BODY. A keyboard user expanding 'On the radar' (2,527 cards, 246 screens at 900px) is silently dropped to the top of the document and must Tab from the skip link. Fix: move focus to the first revealed card, or keep the control mounted as a disclosure (aria-expanded, label flips to 'Show fewer' — also restores the missing collapse path).

### multiDistrict note says "both" for ZIPs spanning 3-6 districts
*/reps (ZIP flow: empty, invalid, clean 78501, PO-box 30301,  · effort S · grep -n multiDistrict messages/en.json messages/es.json 'app/[locale]/reps/page.tsx'*

messages/en.json + messages/es.json reps.multiDistrict ("We've shown both below" / "Te mostramos los dos abajo") rendered by app/[locale]/reps/page.tsx:170. 841 ZIPs in data/zip-districts.json map to 3-6 districts; verified http://localhost:3000/reps?zip=91711 renders SIX district h2s directly under that sentence, in both languages. A plain factual miscount on the flagship truth surface of a truth-first product. Fix: pass candidates.length into the message and pluralize ("We've shown all {count} below").

### Color-drag remounts preview iframe per input event — July remount finding NOT fixed on main
*/embeds (configurator + docs), register: product · effort M · Debounce the accent value feeding previewSrc (~250ms trailing), or push theme changes into the same-origin iframe via postMessage/CSS-var update instead of navigation; verify with the 10-event burst = 1 reload*

components/EmbedConfigurator.tsx:544 (accent onChange), :288-306 (previewSrc memo includes accent), :720 (key={previewSrc}). Browser-verified: a 10-event input burst on #oravan-accent fired 10 full /embed/rep-lookup document loads and the iframe DOM node was replaced (element-identity check false). A real color-picker drag fires continuously, so one drag = dozens of SSR renders plus visible white-flash remounts; a single discrete change costs 1 reload (verified). No debounce/useDeferredValue exists in this file's history on any branch. FLAG (no-guessing rule): my brief said this was fixed; I found no fixing commit and the behavior reproduces on main today — if a fix exists elsewhere I could not see it, and this empirical result should supersede the assumption.

### Unpressed toggle hover erases its own label (1.58:1 light / 1.37:1 dark)
*/embed/bill-card + /embed/action-panel + /embed/rep-lookup ( · effort S · $impeccable polish*

.re-btn:hover{background:var(--_ink-hover)} at app/embed/embed.css:230-232 (specificity 0-2-0) overrides .re-toggle's transparent background (0-1-0) while the text color stays inherited ink, so hovering an unpressed EN/ES toggle, any stance radio, or the retry button turns the label near-invisible: measured 1.58:1 in light and 1.37:1 in dark at 1280x900 (screenshot hover-light.png confirms visually). Desktop-pointer-only — exactly the defect class the July 390-only detector missed. Fix: add .re-toggle:hover { background: var(--_line-faint); } (or flip color to var(--_surface) alongside the dark fill).

### API failure misdiagnosed as "invalid ZIP" with aria-invalid on a correct input
*/embed/bill-card + /embed/action-panel + /embed/rep-lookup ( · effort M · $impeccable harden*

components/embed/RepLookupWidget.tsx:113-116 and 136-139 map /api/reps !ok and fetch-throw to the same 'error' status as a malformed ZIP; lines 231 and 241-245 then render t.home.zipInvalid ("That doesn't look like a US ZIP code. Try 5 digits.") and set aria-invalid=true. Verified live: intercepted /api/reps with a 500 while submitting valid 90210 — the user is blamed and told the wrong fix, and will re-type a correct ZIP forever (Nielsen 9). Fix: a distinct lookupFailed status with a new EN/ES message pair (messages/en.json + es.json together), aria-invalid reserved for format errors.

### summary_large_image share card with no image
*/questions + /questions/[id] (Big Questions index + both liv · effort S · Edit app/[locale]/questions/[id]/page.tsx:71 — change twitter: { card: 'summary_large_image' } to { card: 'summary' }, or add an og:image asset + metadata*

app/[locale]/questions/[id]/page.tsx:71 sets twitter: { card: 'summary_large_image' } but neither the page nor the locale layout emits og:image/twitter:image — verified in the rendered head of /questions/iran-war-powers (6 og:* tags, zero image tags). Share previews on X/Slack/iMessage degrade to an imageless fallback on exactly the surface whose own privacy note argues 'the same page can be shared across the spectrum.' Fix: ship a default OG image, or one-line change to card: 'summary'. Which of the two is an owner call (an OG image is design work; 'summary' is honest today).

### Cancel button edge fails the constitution's own wash-ground contrast rule
*/record — the civic record (product register; empty + popula · effort S · Edit ImpactPageClient.tsx:239 — replace border-line-strong with border-ink-2 on the Cancel button (or add bg-paper); recheck with getComputedStyle in Playwright*

app/[locale]/record/ImpactPageClient.tsx:239 — the erase-flow Cancel button is border-line-strong with a transparent fill sitting on the bg-wash erase panel (:212). Computed with the ledger's own WCAG math: line-strong #7e948a on wash #f3f6f4 = 2.97:1, the exact enabled-control case app/globals.css's contrast ledger marks FAIL ('an enabled component's line-strong edge must have paper on at least one side; a component whose own ground is wash takes an ink-2 edge'). This is a 1.4.11-adjacent defect on the flagship privacy interaction. Fix: swap to border-ink-2, or give Cancel a bg-paper fill.

### Erase flow drops keyboard focus to <body> twice; confirmation may be silent to screen readers
*/record — the civic record (product register; empty + popula · effort M · Add focus management via refs + useEffect on confirming/erased transitions; pre-render <p role='status'> empty and fill it on erase; re-verify with the pass-2 keyboard walk script*

app/[locale]/record/ImpactPageClient.tsx:215-250 — activating 'Erase all my data' unmounts the focused button (verified: activeElement === body after Enter), and confirming unmounts both confirm buttons (activeElement === body again). The visible focus indicator vanishes mid-flow; Chromium's sequential-focus recovery happens to make the next Tab land on 'Yes, erase everything', but AT context is lost and other engines are less forgiving. Additionally the 'All local data erased.' <p role=status> (:247) mounts WITH its text — the classic pattern VoiceOver/NVDA often fail to announce (not verified with real AT; flagged as inference). Fix: on confirm-open move focus to the confirm button; on erase move focus to the status node (tabIndex=-1) and pre-mount an empty live region so the text change is announced.

### Locale 404 is dead code — every 404 renders the bare English root fallback
*/privacy, /terms, /embeds/terms, both 404s, error boundary,  · effort S · curl -s http://localhost:3000/es/bills/nope | grep -o 'lang="[a-z]*"' | head -1  # shows lang="en" — should be es with site chrome*

Browser-verified at 1280x900 and 390x844: /bills/nope, /es/bills/nope, /nonexistent-xyz, and /en/nonexistent ALL render app/not-found.tsx (English-only, lang="en", no header/footer/skip link, no <title>, system fonts) — the reviewed bilingual app/[locale]/not-found.tsx never fires anywhere. Mechanism: app/[locale]/bills/[id]/page.tsx:56 `dynamicParams = false` rejects unknown ids at routing level (its notFound() at :116 is unreachable for bad slugs), there is no [...rest] catch-all under app/[locale]/, and app/[locale]/layout.tsx:82's notFound() renders the PARENT boundary by design. The locale file's own comment (app/[locale]/not-found.tsx:5-8) describes behavior that does not exist. A Spanish user mistyping any URL gets an unannotated English page with no navigation — runtime violation of the bilingual-parity hard rule; borderline P0, filed P1 because the fallback works (correct 404 status + noindex, 121x52 Go-home CTA, live token colors). Fix: add app/[locale]/[...rest]/page.tsx that calls notFound(), so unmatched paths under a valid locale render the locale 404 inside the layout.

### "[FOUNDER: fill]" placeholder is live on public /embeds/terms §9, both locales
*/privacy, /terms, /embeds/terms, both 404s, error boundary,  · effort S · grep -n 'FOUNDER: fill' /Users/colbymaxwell/Projects/oravan/messages/en.json /Users/colbymaxwell/Projects/oravan/messages/es.json*

Screenshot-verified: /embeds/terms and /es/embeds/terms render '§9 Governing law: [FOUNDER: fill] — governing law and jurisdiction to be specified…' to any visitor (messages/en.json + messages/es.json embedsTerms.lawBody; page app/[locale]/embeds/terms/page.tsx:59). The page comment says this is deliberate pending the founder's jurisdiction decision — but the page is publicly routable and sitemapped now, and a literal scaffold string in a Terms of Service reads as unfinished product to any prospective tenant. Owner must supply the jurisdiction (and ideally lawyer-review the whole document per the file's own flag) before Stripe consent_collection points here; until then consider unpublishing §9's placeholder wording.

## P2/P3 backlog (by surface)

**/bills/[id] — bill detail (product register), 8-bill sample: s-3988-11**
- [P2] Bill page renders the green band on stale calendar placements the homepage would refuse *(effort S, decision)*
- [P2] TL;DR meta line overcounts: 'N questions answered below' includes the TL;DR itself *(effort S)*
- [P2] No way to get a fresh AI draft once a script draft exists *(effort M, decision)*
- [P3] Two failure registers, two geometries: border-left alert stripe vs border-top ink rule *(effort S)*
- [P3] Present-tense 'is deciding' over a months-dead rejected motion *(effort M, decision)*

**/ (homepage, EN+ES) — brand register, anchored sweep**
- [P2] Specimen bill duplicates listing row #1 — same headline twice, unmarked *(effort S, decision)*
- [P2] "In the news" claims "right now" over cards dated Sep 16, 2025 / Dec 1, 2025 *(effort S)*
- [P2] Mobile focus order detours through the bottom tab bar before any content *(effort S)*
- [P3] DESIGN.md:236 still carries the retired "human-reviewed" claim *(effort S)*
- [P3] Paused screencast's Play overlay covers the frame the step markers just selected *(effort S)*

**/bills (browser, filters, search, news lens, radar buckets) — product **
- [P2] Double clear control: native WebKit search-cancel not suppressed *(effort S)*
- [P2] 'Show all 2527' renders the whole corpus into the DOM in one shot *(effort M, decision)*
- [P2] Full 2,568-teaser corpus ships in the page HTML, twice *(effort L, decision)*
- [P2] 'Moving' band silently absent on live data — taxonomy degenerate today *(effort M, decision)*
- [P3] Filter/search state not in URL — likely privacy-deliberate, needs a recorded ruling *(effort S, decision)*
- [P3] Chip-rail group's accessible name duplicates its first button ('All topics') *(effort S)*
- [P3] Miss-state copy misdiagnoses a query-only miss *(effort S)*
- [P3] EN search placeholder undersells what search matches; ES already has the better copy *(effort S)*
- [P3] AI provenance note is 30 words of 12px tracked uppercase *(effort S, decision)*

**/reps (ZIP flow: empty, invalid, clean 78501, PO-box 30301, split 1000**
- [P2] Change-ZIP link is the one touch target under the 44px law *(effort S)*
- [P2] Split view duplicates full senator cards per district *(effort M, decision)*
- [P3] District regions announce as "TX 15" / "DC 0" to screen readers *(effort S)*
- [P3] Vacant seat card renders last; occupied House seat renders first *(effort S)*
- [P3] Lede claims every US resident has two senators; false for DC/territories *(effort S, decision)*
- [P3] ES heading has trailing period EN lacks (reps.nextTitle) *(effort S)*
- [P3] Document title identical across all lookup states *(effort S)*
- [P3] ZIP form gives no pending feedback after valid submit *(effort S)*
- [P3] ZIP-not-found alert wraps the entire recovery form in role="alert" *(effort S)*
- [P3] Rep name wraps with orphan word at 768 (235px cards) *(effort S)*

**/embeds (configurator + docs), register: product**
- [P2] Mobile: bill/knob changes give no signal the preview updated *(effort M, decision)*
- [P2] 'Showing 25 of 2568 matches' mislabels corpus size as match count *(effort S)*
- [P2] Bill search fails WCAG 2.5.3 label-in-name *(effort S)*
- [P2] Mockup's fake headlines pollute the real document outline *(effort S)*
- [P3] 'Choose a bill above' points the wrong way on desktop *(effort S)*
- [P3] Docs column centered while h1/configurator anchor left *(effort S, decision)*
- [P3] 'Simulated preview' disclosure set at 10.4px, off the type ladder *(effort S, decision)*
- [P3] Match-your-site autofill has no revert *(effort M, decision)*

**/embed/bill-card + /embed/action-panel + /embed/rep-lookup (product re**
- [P2] Failed portrait renders a permanent broken 44x54 slot — no fallback to initials *(effort S)*
- [P2] "Local offices (N)" disclosure is a 23px target *(effort S)*
- [P2] Dark-scheme placeholder text fails AA at 3.83:1 *(effort S)*
- [P2] Action-panel refusal chrome drops the always-visible EN/ES toggle and any heading *(effort M, decision)*
- [P3] SSR ships html lang="en" for locale=es embeds until hydration *(effort M)*
- [P3] Disabled stance buttons look identical to enabled — no [disabled] style exists *(effort S)*
- [P3] bill-card not-found names the problem but offers no way forward *(effort S)*
- [P3] role="alert" on static server-rendered refusal copy *(effort S)*
- [P3] Hydration payload vs. the spec's "no client framework bloat" promise — prod weight unverified *(effort L, decision)*

**/questions + /questions/[id] (Big Questions index + both live entries:**
- [P2] AI-note caption renders as 6 lines of 12px uppercase at 390 *(effort S, decision)*
- [P3] 'Why this Big Question exists' H2 visually smaller than the H3s above it *(effort S, decision)*
- [P3] Timeline ledger has no list semantics *(effort M)*
- [P3] Skip link is 41.6px tall when focus-revealed *(effort S)*
- [P3] ~8.7-screen mobile record page with no in-page navigation *(effort M, decision)*
- [P3] 'Where it stands — July 26' beside 'Data as of August 2' reads as a 7-day gap *(effort L)*

**/record — the civic record (product register; empty + populated + eras**
- [P2] Topic chip labeled with one topic navigates to the union of all followed topics *(effort M, decision)*
- [P2] Per-row delete is instant, unconfirmed, and un-undoable *(effort M, decision)*
- [P2] Row bill links are 19px-tall targets, under the project's 44px hard floor *(effort S)*
- [P2] Post-erase page is a dead end that keeps a live erase button over an empty store *(effort S)*
- [P2] Storage write failures are swallowed silently under copy that promises persistence *(effort M, decision)*
- [P3] Stat labels overflow their cards at 320px *(effort S)*
- [P3] dl stat groups are invalid: dd precedes dt with a raw svg sibling *(effort S)*
- [P3] Call-row dates lack tabular-nums while read-row dates have it *(effort S)*
- [P3] All delete buttons share identical accessible names *(effort S)*
- [P3] Stat trio floats headingless between 'What you've read' and 'Your calls' *(effort S, decision)*
- [P3] No export: the civic record's only copy is quota-limited browser storage *(effort L, decision)*

**/why-call (register: brand) — EN + ES, 320/390/768/1280**
- [P2] Unsourced empirical claims on a citations-first brand *(effort M, decision)*
- [P3] Script section describes the script but never links it *(effort S, decision)*
- [P3] Wrapped CTA has no vertical padding *(effort S)*
- [P3] Double max-w-read cap contradicts the file's own 'capped ONCE' comment *(effort S)*
- [P3] DESIGN.md type-ladder drift: text-h2-loud documented 26→40, implemented 24→40 *(effort S)*
- [P3] No 'you are here' signal on mobile *(effort M, decision)*

**/about, /partners, /citations, /mcp — EN + ES, brand register (anchore**
- [P2] No copy affordance on the three copyable artifacts (/mcp endpoint, client config, /citations canonical URL) *(effort M, decision)*
- [P2] Three visual weights for the same act: 'read the sibling policy' *(effort S, decision)*
- [P2] /about has no distinctive brand artifact (brand-register judgment) *(effort M, decision)*
- [P3] Tool-title span untagged lang="en" on /es/mcp *(effort S)*
- [P3] External links open new tabs unannounced on /about *(effort S)*
- [P3] Redundant inner max-w-read wrapper on all four pages *(effort S)*

**/privacy, /terms, /embeds/terms, both 404s, error boundary, loading sk**
- [P2] loading.tsx never fires on navigation — no pending indication on slow navs *(effort M)*
- [P2] Privacy page dead-ends its own commitments: no contact, no repo link, no /record link *(effort S)*
- [P2] Root 404 has no <title> and zero brand identity *(effort S)*
- [P2] Embeds-terms doc-foot links: 22px tall standalone links, stretched full column width *(effort S)*
- [P2] ES error-boundary copy is machine-drafted and never native-reviewed *(effort S, decision)*
- [P3] Sibling legal docs disagree on h1 scale *(effort S, decision)*
- [P3] Feed has no browser presentation (raw XML wall) and no atom:link self-ref *(effort M, decision)*
- [P3] hello@oravan.org in embeds terms §10 is plain text, not a mailto link *(effort S)*
- [P3] OG bill card AI marker uses 6px radius — off both shape tokens *(effort S)*
- [P3] Invalid percent-encoding (/%ff) serves Next's unbranded default 400 page *(effort L, decision)*
- [P3] DESIGN.md still claims AI content is 'human-reviewed' — contradicts the 2026-07-25 constitution amendment *(effort S)*

## Detector sweep

Ran the impeccable detector three times over app/ and components/ in /Users/colbymaxwell/Projects/oravan: default pass (exit 2, 1 finding), --scope type (exit 0, 0 findings), --scope layout (exit 0, 0 findings); verified in the detector source that --scope is a validated flag with type/layout as legal values and that the default pass covers all rules, so the empty scoped results are genuine. The single finding — broken-image at app/embed/portrait/[bioguide]/route.ts:15 — is a false positive: the pattern matched '<img>' inside a prose comment in a markup-free server route, while the real image rendering (RepLookupWidget.tsx via next/image) has a concrete src and a fallback. Zero confirmed defects; DESIGN.md was read first but no owner-ruling citation was needed. Nothing was suppressed — no config writes, no inline ignores, repo untouched.

- Zero confirmed findings across app/ + components/ (both scoped passes).
- false positive [broken-image] app/embed/portrait/[bioguide]/route.ts: The detector matched the literal string '<img>' inside a block comment (line 15: '...never even renders an <img> pointed at it...') in a server-side API route handler that contains no JSX/HTML at all — it streams portrai

## Cross-reference: the blind panel (2026-08-02)

Six zero-context reviewers scored 7.5–8.5/10 before this sweep; all 22 of their findings were dispositioned (19 fixed in PRs #141–#145, 3 declined on owner-ruling grounds). This anchored sweep confirms the fixes held and found the next layer down.

## Strengths the sweep verified (a sample)

- Quiet-day collapse works exactly as specced in both locales — verified live: today-singleton ('Nothing recorded yet today'), 9-day folded run ('July 24 – August 1, 2026 · Nothing recorded across 9 days' / 'Nada registrad
- The two laws survive computed-style verification on a complex interactive surface: zero unearned green (only content-link hover decoration and the pin's go-bright CTA), zero amber (documented owner-consistent absence), c
- Error-state craft is best-in-class: five distinct failure modes (invalid ZIP, PO-box unmappable, address invalid/notFound/unavailable/rateLimited) each with plain-language WHY and recovery paths, tri-signal register (3px
- Erase completeness is real and verified end-to-end: after 'Yes, erase everything' all three keys (oravan.prefs/calls/reads) read null, the role=status prints, and the confirm inventory copy matches lib/local.ts's actual 
- The stepper never lies: all 8 sample records verified in-browser against deriveJourney — committee/markup at the right chamber, calendar placement = green band + matching step + matching now-sentence, cloture (hr-6500-11
- Both July P0s verified fixed in-browser: h1 never intersects the specimen at 320/390/768/800/1280 in either locale (ES stroke 722px vs 992px measure at 1280; 26px downstep at 320), and the crown's amber claim now matches

## Proposed Phase-2 wave map

- **Wave A (this week, S/M effort):** the 11 non-decision P1s — focus-management pair (/bills Show-all, /record erase), script-failure dead end, floating-call-button collision, embed toggle hover + ZIP misdiagnosis, locale-404 pair, multiDistrict wording, configurator remount (regressed or never landed on main — re-verify against #143 first), questions share-card image.
- **Wave B (needs your rulings):** floor-calendar row labels (the status-string overclaim — bucket relabel vs row-level gate, shared sitewide), the "[FOUNDER: fill]" placeholder on /embeds/terms §9 (legal text — yours alone), share-card image approach for /questions.
- **Wave C (P2/P3 polish sink):** per-surface `$impeccable polish` in weight order, then re-critique for trend lines.

## Standing decision cards (unchanged from the campaign ledger)

1. "On the floor calendar" chip overclaims on embed/MCP surfaces (now joined by the homepage row-label P1 — same root).
2. The record-truth CI corpus tripwire (reds CI on unclassifiable action text) — accept or soften.
3. DESIGN.md machine-readable frontmatter (activates the detector's design-system rules).
4. ES native-review packet — now including the sweep's flagged draft strings.

---

# v2 addendum — competitive benchmark + scripted walkthroughs (2026-08-04)

*Phase 1C/1D complete: six live site teardowns (5calls, Resistbot, GovTrack, VOTE411, The Marshall Project, Stripe Press) + two scripted persona walkthroughs, synthesized blind to everything but the results. Screenshots in the session scratchpad.*

## Site scores (/10 per lens)

| Site | First impr. | Task flow | Mobile | Type craft | Trust | Spanish |
|---|---|---|---|---|---|---|
| The Marshall Project — https:/ | 9 | 8.5 | 9 | 9.5 | 9 | 3 |
| https://www.vote411.org (VOTE4 | 8 | 7.5 | 7 | 7.5 | 7.5 | 7 |
| https://resist.bot (Resistbot  | 8 | 5 | 8 | 7 | 8 | — |
| 5calls.org | 7 | 9 | 7 | 6 | 7 | — |
| https://press.stripe.com (Stri | 10 | 8 | 8 | 10 | 9 | — |
| https://www.govtrack.us | 6.5 | 7.5 | 6 | 6.5 | 7 | — |

## The gap matrix — one call per dimension

### Task funnel length
- **5calls.org**: 3 interactions from landing to a dialable number (ZIP 78501 → issue → giant tel: link). Search accepts bill numbers: 'H.R. 7757' filters the 47-issue list to one. The shortest funnel measured.
- **Resistbot**: 1 click to a hard identity wall (/auth/signin, email+code) for web chat; petition sign is 2 clicks to the same wall. Zero anonymous web completions exist — the real accountless path is SMS (keyword + 50409), untestable f
- **GovTrack**: 4 interactions from home to a dialable DC number + script (search → bill → 'Call or Write' → ZIP). One resilience failure: Enter in the address field silently did nothing on one of two runs — only the explicit 'Find My R
- **VOTE411**: 5 interactions (4 address fields + submit) and 2 page loads before any personalization — 5x Oravan's input burden; payoff is street-level ballot precision fanned into a 6-module dashboard.
- **CALL: MATCH — Oravan already sits at best-in-class length (invariants I1/I2 hold; only 5calls' 3-tap path is shorter, and it buys that with a fixed advocacy stance). Close the two walkthrough snags (P1 dead click, P3 step-order wobble) rather than restructure. One small STEAL folded in: accept bare bill-number lookup ('H.R. 6500') in /bills search, S — it is how journalists and staffers arrive, and both**

### Script quality
- **5calls.org**: Static ~80-word script, one [NAME] placeholder, auto-filled city and named target ('demand Senator Cornyn oppose H.R. 7757'). NOT editable (no textarea/contenteditable), no stance choice — the only path is the site's 'op
- **GovTrack**: Support AND oppose templates rendered side by side unconditionally on every /comment page — the UI itself certifies no house position — plus a staffer-dialogue simulation and chamber-aware ask verb (cosponsor vs oppose v
- **Oravan (walkthroughs)**: 3 stances including 'I'm concerned' (relief moment for the nervous persona), AI-drafted editable script ('Edit anything. It works best when it sounds like you'), Copy, office-hours awareness, staffer-expectation guidance
- **CALL: STEAL (M) — GovTrack's both-sides display as visible neutrality proof: render the unselected stance scripts as collapsed ghosts beneath the chosen one, keeping Oravan's personal editable script while the UI certifies no position. Secondary S steal from 5calls: name the specific live target inside the script once chamber routing exists. Oravan otherwise wins this dimension outright — but the P1 scr**

### Bill-status communication
- **5calls.org**: Chamber status designed into the contact panel: because KOSA passed the House, the House rep row is greyed with 'House reps are not currently relevant to this issue' and only senators are dialable — wasted calls designed
- **GovTrack**: Icon timeline (completed step + greyed future steps) but with generic boilerplate identical on every bill; 'Prognosis: 1% chance of being enacted' with a methodology link; call flow reads bill state to pick WHICH rep and
- **Oravan (walkthroughs)**: 'You are here · Aug 3, 2026' stepper + bill-specific narrative ('Right now: the Senate is deciding whether to bring it to a vote…') + latest action with CR citation — strictly more informative than GovTrack's timeline. G
- **CALL: STEAL (S) — chamber-aware rep routing. Oravan's pipeline already knows chamber via the 'You are here' tracker; route it into the rep list ('your House rep already voted on this — your senators are the live target'). Both incumbents prove the pattern and both reviewers independently called it the cheapest high-leverage borrow in the whole benchmark. Second-order steals: a coarse three-band enactmen**

### Plain-language depth
- **GovTrack**: 'Summary' = the CRS digest verbatim: 15,264 words for H.R. 1 at ~22-word average sentences, published Oct 6 2025 — months after introduction. Small bills like H.R. 547 get NO summary at all, just the sponsor-written titl
- **5calls.org**: 515-word cited background brief per issue plus narrative updates explaining WHY the moment matters ('Senate co-authors declared the House version unacceptable') — but written from one advocacy position; there is no 'supp
- **Marshall Project**: The reading ceiling for civic content: 4,737 words, zero ad slots, zero inline interrupts, single text column — a genre benchmark, not a bill product.
- **Oravan (walkthroughs)**: 55-second Q&A decode ('What does this do? / Who does it affect? / Why does it matter?') across all 2,574 tracked bills, AI-labeled with the official Congress.gov text linked, in EN and ES. The nervous persona chose and u
- **CALL: STEAL (S) — the claim, not the content: state the live decoded-bill count and the defensible headline 'every bill decoded, within a day' at the point of first input, VOTE411-style ('16,040 candidates and 8,445 races' inline is a trust signal and expectation-setter). Oravan already wins the substance against GovTrack's no-summary small bills and months-late digests — it just never says so anywhere **

### Bilingual support
- **5calls.org**: None: html lang='en', zero hreflang alternates, /es/ 404, no toggle, no Spanish scripts (reviewer probed landing, an issue page, about, and site-wide alternates; did not crawl all 47 issues — templates carry no language 
- **GovTrack**: None: 'Español' appears nowhere, /es 404 — the 20-year incumbent has no answer for Spanish-dominant constituents in the very district (TX-15) ZIP 78501 resolves to. Score -1.
- **Resistbot**: None found. Score -1.
- **Marshall Project**: Token: ~4 ESPAÑOL-tagged articles ever (latest Dec 2025), /espanol and /tag/en-espanol both 404, no chrome translation, no toggle. Score 3.
- **CALL: STEAL, defensively (S-M) — Oravan owns this dimension outright (no major call-tool competitor has ANY Spanish; name that wedge in positioning against GovTrack). Protect the moat: fix the P1 persistence and record-title findings first, then steal VOTE411's two good moves — an ES-specific trust anchor (Spanish-language sources on decodes or a VE-Y-VOTA-style escalation line on call pages, M) treatin**

### Mobile experience
- **5calls.org**: Issue page is 5,803px at 390x844 (6.9 screens); the phone number sits 4.2 screens down, the script at 4.7, with no jump link or sticky call bar — users re-scroll ~4 screens per rep contact cycle. Local-office tel links a
- **Resistbot**: 175x50px sticky 'Sign Petition' pill fixed 20px above the viewport bottom (thumb zone) for the whole read; nav condenses 7 items to 3 + hamburger; no overflow. Anti-lesson: a 9,860-CSS-px mobile landing (11+ viewports).
- **GovTrack**: Flow worked identically at 390x844 with no overflow — but a GLP-1 belly-patch photo ad rendered directly beneath the Prognosis chip, and guidance sits below a ~630px map.
- **VOTE411**: Floating chat bubble (~60px) covered the 'Monday, October 5' registration-deadline text and section-heading letters on 3 of 4 captured pages; MENU toggle only 26px tall. Inputs (50px) and Submit (46px) pass the 44px bar.
- **CALL: STEAL (S) — Marshall's mobile h1 breathing room: nudge line-height from 1.06 to ~1.12-1.15; costs nothing, reads noticeably calmer. Fix the P2 panel-fade discoverability. CONSCIOUSLY DECLINE overlay/floating patterns beyond the existing FAB: Marshall's 12-13%-of-viewport newsletter bar taxes the experience its brand sells, and VOTE411's bubble covered a registration deadline — instead adopt the ru**

### Trust/privacy story
- **5calls.org**: Trust via longevity and humans: named founders with personal emails, 501(c)(4) footer disclosure, open-source GitHub org, live public dashboard, 13.9M calls since 2017. But voicemail guidance tells users to 'leave your f
- **Resistbot**: A named 'User Bill of Rights': 6 plain-language principles (~450 words), 'no trackers or use of Google Analytics', 'we rely on your membership, not your data', linked in every footer — undercut by the identity wall befor
- **GovTrack**: Ads on the civic record: sidebar display, mid-content interstitial, sticky bottom banner; a GLP-1 photo ad under the Prognosis chip on mobile; 'Hide The Ads ▶' paid upsell as the FIRST header element; emoji sentiment (an
- **VOTE411**: Strong visible copy ('Your address is not stored', LWV nonpartisan disclaimer at the point of candidate data) — while the same pages load The Trade Desk ad pixels (cookie_sync=1), AddToAny, OpenWidget, and AccessiBe: 4 t
- **CALL: STEAL (S) — placement and naming: put a 4-6 word version of 'Free, nonpartisan. No accounts, no ads, no trackers' in the header slot (Marshall's move), surface it on bill pages where the GovTrack-ads comparison actually happens, and give the existing privacy promise a named, linkable identity (Resistbot's move) without changing its substance. CONSCIOUSLY DECLINE: communal call tallies and per-user**

### Typographic craft
- **Marshall Project**: Three voices: Miller serif display (55/66), Utopia text (23/36.8, ~72 cpl — past the classic 66), and GT Pressura Mono as a UTILITY voice for ALL metadata — kickers, decks, bylines, datelines, nav. A fixed two-line mono 
- **Stripe Press**: One family (Ivar) in three optical sizes + italic as the only secondary voice; only 4 distinct text sizes measured on a book page; section labels are italic + hairline rule, not size jumps; 17px/25.5 body at ~55 cpl. Dis
- **VOTE411**: Condensed all-caps 'rift' at 84px/700 with a single yellow accent word — an instantly recognizable civic-poster voice carried identically onto /es; craft slips exist (text clipped behind a card edge, tiny footer legalese
- **Resistbot**: Three voices from minimal ingredients: Hubot Sans UI, rounded mono chips for bot keywords (SIGN PVMWIZ), and a serif face for the letter body — the 'document' reads distinct from the 'interface' (which face actually rend
- **CALL: STEAL (S) — extend the existing mono stamp into a full utility voice for every piece of metadata (bill number, status, dates, AI chip) formatted as a fixed-position, fixed-order provenance ritual — same order, same voice, every page — which is what makes it read as institutional habit rather than a badge; reviewer priced it at ~zero layout cost. Companion S steals: Resistbot-style chip tokens for **

### Motion
- **Stripe Press**: Book-open transition runs ~1.2s (spine-to-cover rotation + full-page palette crossfade) but the text panel is fully legible by ~400ms — mid-transition frames prove content arrives first and theater finishes around it; th
- **Other five sites**: Effectively static; no motion behavior measured or reported by reviewers.
- **Oravan (comparisons)**: Near-zero motion — instant SSG navigations; nothing currently to block. Future motion surfaces exist: script generation waits (a measured 9s AI-draft wait in the walkthrough) and decode loading.
- **CALL: STEAL-AS-RULE (S) — codify Stripe Press's contract now, before any reveal animation ships: content readable within ~400ms, ornament may continue to ~1.2s, state committed to the URL before the animation ends, prefers-reduced-motion honored. CONSCIOUSLY DECLINE the WebGL-shelf-level theater itself: it shipped with a blank no-JS page and invisible focus — both direct violations of Oravan's accessibi**

## Top steals (effortized)

- **[S]** Chamber-aware call routing: read bill stage into the rep list — grey/demote the chamber that already voted ('your House rep already voted on this — your senators are the live target') and pick the ask verb (cosponsor/oppose/vote). The pipeline already knows chamber via the 'You are here' tracker; two reviewers independently called this the cheapest high-leverage borrow. Also fixes today's equal-weight three-rep list on Senate-floor bills like H.R. 6500. *(from 5calls.org + GovTrack)*
- **[S]** Move the trust line to the header: a 4-6 word version of 'Free, nonpartisan. No accounts, no ads, no trackers' in the masthead on every page, and visible on bill pages — the exact surface where GovTrack shows a GLP-1 ad under its Prognosis chip. Today Oravan's best trust asset lives on the last screen. *(from Marshall Project (placement) + GovTrack (the contrast))*
- **[S]** Make the number the CTA: render the primary tel: link at display size (5calls: ~40px+, 277x45 tap target) so the next physical action is unmistakable from across the room. Oravan currently sets numbers at body size, visually equal-weight with guidance text. *(from 5calls.org)*
- **[S]** Extend the 'DATA AS OF' mono stamp into a full utility voice + fixed-order provenance ritual for all metadata (bill number, status, dates, AI chip), and style phone numbers/copyable script lines as chip-shaped tokens. Marshall-grade editorial texture at ~zero layout cost. *(from Marshall Project + Resistbot)*
- **[S]** State the corpus at the point of first input: live decoded-bill count plus the defensible headline 'every bill decoded, within a day' — counter-positioned against GovTrack's no-summary small bills and months-late 15,264-word CRS digests. VOTE411 proves the inline pattern ('16,040 candidates and 8,445 races'). *(from VOTE411 (pattern) + GovTrack (the gap))*
- **[S]** Bare bill-number lookup ('H.R. 6500', 'S. 1874') in /bills search — how journalists and staffers arrive; both incumbents support it, no evidence Oravan does. *(from GovTrack + 5calls.org)*
- **[S]** Two e2e regression gates minted from incumbent failures: (a) Enter always submits the ZIP form (GovTrack's silent Enter failure at the moment of highest intent); (b) no /es page ever renders 'null'/'undefined' or an untranslated fallback heading (VOTE411's 84px 'EN NULL'). *(from GovTrack + VOTE411 (anti-lessons))*
- **[S]** Mobile h1 breathing room: nudge line-height from the measured 1.06 to ~1.12-1.15 for 3-line-wrapping bill titles. *(from Marshall Project)*
- **[S]** Codify the motion contract before any reveal animation ships (script generation, decode loading): content readable ≤400ms, ornament to ~1.2s, state in the URL before the animation ends, reduced-motion honored. *(from Stripe Press)*
- **[S]** Name the privacy promise: give the existing (already better-placed) privacy copy a named, linkable identity a la 'User Bill of Rights' — memorable and shareable without changing substance. *(from Resistbot)*
- **[M]** Both-sides scripts as visible neutrality proof: render the unselected stance scripts as collapsed ghosts beneath the chosen one, so the UI certifies no house position while keeping Oravan's personal, editable draft. *(from GovTrack)*
- **[M]** Coarse enactment odds as expectation-setting: a three-band label (long-shot / in play / likely) derived from status + cosponsor counts with a methodology note — truth-first protection against burning the one call on messaging-bill theater; no new data source needed. *(from GovTrack)*
- **[M]** AI-decoded, gate-checked dated 'what changed' log per bill — the nonpartisan version of 5calls' Updates stack (vote tallies, 2-3 sources per entry, newest first) that communicates WHY this moment matters. Runs through the existing publish gates. *(from 5calls.org)*
- **[M]** State-tagged relevance after ZIP: a 'bills your delegation is voting on' surface computed client-side from the localStorage ZIP — 5calls proves one ZIP entry personalizing content reads as magic, not surveillance, and it needs no server-side storage. *(from 5calls.org)*
- **[M]** ES-specific trust anchor on /es surfaces: at least one credibility element built FOR the Spanish audience (Spanish-language sources on decodes, or a VE-Y-VOTA-style escalation line on call pages) rather than pure string parity. *(from VOTE411)*

## Where Oravan already wins

- Bilingual moat: the only real Spanish product in the space — full EN/ES parity verified end-to-end (decode → stance → TX-15 reps → call logging → record, 0px overflow at 390px) vs -1 scores for 5calls, GovTrack, and Resistbot, ~4 token articles at Marshall, and VOTE411's 84px 'NULL' dynamic-boundary leaks. Worth naming explicitly in positioning against the incumbent.
- Accountless action: ZIP → 3 reps with DC + local numbers in 1 click, no identity — vs Resistbot, where the web path is 1-2 clicks to an email sign-in wall with zero anonymous completions. A structural moat worth marketing explicitly ('no sign-up, no phone number').
- Script experience: 3 stances including 'I'm concerned', an editable AI draft, office-hours awareness, staffer-expectation guidance, and a labeled template fallback that carried the entire funnel through total API failure — vs 5calls' single uneditable ~80-word oppose-only script.
- The nonpartisan lane is genuinely unoccupied: 5calls is advocacy-as-product (10 of 12 top titles are directive verbs, ActBlue donate, no 'support' path exists), and Resistbot publishes its own skew (GOP senators 2-5% response vs 74-83% for Democrats). Oravan's truth-first bill framing + user-chosen stance serves the whole electorate.
- Plain-language coverage: a 55-second decode across all 2,574 tracked bills vs GovTrack's verbatim 15,264-word CRS digest published months late — and NO summary at all on small bills.
- Status narrative: 'You are here · Aug 3 2026' + bill-specific 'Right now: the Senate is deciding…' + CR citation is strictly more informative than GovTrack's generic boilerplate timeline.
- Clean civic record: no ads, no trackers — vs GovTrack's GLP-1 ad beneath the Prognosis chip and 'Hide The Ads' paid upsell, and VOTE411's Trade Desk cookie_sync pixels loading under 'your address is not stored' copy.
- Mobile action reach: the follow-along panel + 'Make the call' FAB keep the number ≤1 gesture away vs 5calls' phone number 4.2 screens down with no jump link or sticky bar; 0px horizontal overflow in every mobile test.
- Accessibility floor beats the craft ceiling: semantic HTML, visible focus, 44px targets, no-JS-readable SSG content — vs Stripe Press's visually blank no-JS page and 'outline: 3px none' focus. A competitive asset, not table stakes.
- Privacy promise verifiably kept: /record shows exactly the truth — the one read, 'No calls logged yet', 'Stored only in this browser', and 'Erase all my data'. The promise made at the ZIP box is confirmed at journey's end; the nervous-caller walkthrough is a PASS with the decisive reassurances placed exactly where fear occurs.
- Anxiety engineering as product craft: 'nobody debates or quizzes you' before commitment, 'What you'll hear first' and 'Nervous? Call after hours' beside the script, 'Tonight works as well as right now' at the dial point, and 'Couldn't get through' offered as a loggable outcome (permission to fail).
- Reading measure and restraint: 51 cpl Besley desktop beats Marshall's 72; one quiet 'Support Oravan' link per page vs Resistbot's coin economy threaded through advocacy surfaces — the audit priced that gamification at a point of trust.

## Walkthrough findings (the next wave input)

*Environmental caveat on the 429 finding: eight parallel agents shared one IP during the runs, so the limiter tripping is partly an artifact — but the Wave-A fallback script should have surfaced on 429 and neither persona describes seeing it. Verify the fallback path renders before treating that item as done.*

- **[P1]** 'Start the call' with no ZIP saved is a silent dead click — verified in a clean profile: no modal, no scroll cue, no message. The loudest button on the page does nothing for anyone who taps it first. Fix: scroll/focus the ZIP field.
- **[P1]** Split-ZIP 10001 shows FOUR reps (Goldman AND Nadler) under copy reading 'Call any of your three' with no 'which one is mine?' disambiguation or address-refinement offer in the panel, and the modal leads with Goldman, who may be the wrong member. This is exactly the nervous caller's fear (calling the wrong office and being corrected) — the existing /api/district refinement never surfaces here. Reviewer flag: refinement may exist on another surface (/reps); not found from this panel, repo not checked.
- **[P1]** AI script generation failed on every persona attempt, both walkthroughs, both servers — /api/script returned 429 rate_limited (retryAfterSec 486), then 502 generation_failed after the window cleared — and the error card invites a 'Try again' that keeps failing while promising 'in a minute' (the countdown later said 8:01). The labeled template fallback is load-bearing and worked (in good Spanish too); lead with it or soften the retry promise. Flagged caveats: the 429 pool was shared across parallel benchmark agents (a solo visitor may not hit it); the 502 root cause is unverified (possibly missing/invalid local ANTHROPIC_API_KEY); Spanish AI-script quality remains entirely untested.
- **[P1]** Spanish is a mode you must re-enter: bare / serves English even to an es-MX Accept-Language browser, and choosing Español never updates the NEXT_LOCALE cookie (stays 'en' forever), so every bare-URL entry restarts in English with the banner reappearing. Reviewer verdict: the single biggest Spanish-experience defect.
- **[P1]** /es/record renders stored English bill titles verbatim ('S. 1874 · Bill would extend nurse training funding through 2030 with increases') instead of resolving by bill id + current locale — the Spanish headline demonstrably exists on /es/bills. A bilingual-parity hard-rule breach on the surface meant to celebrate the user's history; bites any user who reads a bill in EN then checks their record in ES.
- **[P2]** Stance buttons ('Where do you stand?') say nothing about the tap being local-only/reversible — the persona feared pressing would submit a position somewhere. A one-line 'saved only on this device' at the buttons closes it; also a small 'what will THAT generate?' pause at the unusual 'I'm concerned' option.
- **[P2]** The sticky call panel's internal scroll hides the ZIP form under a fade — both personas (EN and ES) had to discover that the panel scrolls internally before finding where to enter the ZIP/código postal.
- **[P2]** The dial-point modal never addresses the 'I'm on my laptop, phone in hand' case — desktop tel: links often do nothing or open FaceTime, and there is no 'dial this from your phone' hint beyond Copy number.
- **[P2]** Official-record English leaks on /es with no gloss: 'Última acción: 3 de agosto de 2026 — Motion to proceed to measure considered in Senate. (CR S4414)' — defensible as record fidelity, but the Spanish reader gets no hint why the language switched or what the token 'CR S4414' means.
- **[P2]** Port-3000 dev server: a 500 cascade after compile error "Export localeText doesn't exist" (app/[locale]/questions/[id]/opengraph-image.tsx importing from @/lib/moments) took every route down permanently — including a blank 'My record' at the persona's single worst trust moment ('what do you have on me?'). NOT reproducible on a freshly started server (all 200s), so likely transient Turbopack/dev-compilation state — unverified either way; restart :3000 and re-test /record once.
- **[P3]** Bills-index status chips ('ON THE FLOOR CALENDAR', 'PASSED ONE CHAMBER') are unexplained procedural jargon at list level; the translating green banner only appears later, on the bill page.
- **[P3]** '2574 of 2574 bills' triggers an overwhelm spike before the eye lands on the six-item 'Deciding now' rail; the rail's 'A call lands hardest here' framing rescued the choice.
- **[P3]** Cold-visitor nav opacity: 'My record' (whose record — mine or politicians'?), 'Big Questions' (carries no meaning without its subtitle), and repeated 'decoded' product jargon each cost a first-timer a beat of confusion.
- **[P3]** Funnel-order wobble: the homepage says step 1 is your ZIP ('Find your three'); why-call's only CTA says 'Find a bill worth calling about' — a 'which comes first?' beat before trusting the funnel to converge (it does).
- **[P3]** Hero ZIP microcopy answers the privacy question the visitor hadn't asked yet but not 'what happens after I press this?' — the nervous persona detoured to Why call? instead of typing.
- **[P3]** 'Never stored on our servers' hair-split: the ZIP IS saved in localStorage (device-side, consistent with the server-only promise, and /record is honest about it), but a wary reader could take 'never stored' as absolute. Tighten the phrasing.
- **[P3]** ES entry banner ambiguity: the X and 'No volver a mostrar este aviso' sit together — unclear whether X dismisses once or forever, and whether dismissing kills the only obvious road to Spanish.
- **[P3]** Three different AI-label wordings across ES surfaces — 'TRADUCIDO POR IA, VERIFICADO CON EL REGISTRO' (home cards), 'DESCIFRADO CON IA · VERIFICADO CON EL REGISTRO' (bill page), 'REDACTADO POR IA A PARTIR DEL REGISTRO PÚBLICO' (questions) — possibly intentional distinctions, but briefly read as different trust levels.
- **[P3]** Spanish machine-tell tail: 'Citas y correcciones' (reads as 'appointments' for a beat; expected 'Fuentes'/'Referencias'), 'Widgets', 'robocalls extranjeras', 'ZIP' anglicism, comité/comisión flips on adjacent timeline entries, and the calque 'Número de Votación de Registro 192' vs 'votación registrada 192' for the same fact.
- **[P3]** Environment/orchestration housekeeping (not site defects, action needed): port-3000 dev server is still down and needs a manual restart; the reviewer's port-3001 replacement server (background task b9adccaih, log at scratchpad/benchmark/dev3001.log) is still running and should be stopped; two walkthrough agents shared one browser-profile directory and screenshot prefix, contaminating mid-walk localStorage evidence (site exonerated after six isolation tests) — separate profile dirs per agent before the next benchmark run. One unresolved automation-only flag: a scripted click on 'Empezar la llamada' timed out once; unconfirmed whether a real user could hit it.

## The two walks, verbatim verdicts

**Spanish-dominant visitor. My browser is set to es-MX (Accept:** The Spanish funnel is real, complete, and mostly excellent — but Spanish is a mode you must re-enter, not a first-class door. A Spanish-dominant visitor completes the entire journey in Spanish: decode (hr-6500-119, high-quality idiomatic decode), stance, ZIP 78501 → correct TX-15 reps with local numbers, script (template), call logging, and a Spanish civic record — with zero layout strain at 1280px or 390px (0px overflow everywhere tested) and repeatedly warm, human microcopy ("Respira y vuelve a intentarlo pronto", "Tú acabas de hacerla"). The four failures that matter, in order: (1) Language

**The nervous first-time caller: has never phoned a congressio:** PASS for the nervous first-time caller — the funnel is genuinely anxiety-lowering and I reached verified tel: links (15 rendered anchors, e.g. tel:+12022257944 for Goldman DC, plus district offices) in 4 pages and about 6 interactions from a cold landing, with the decisive reassurances placed exactly where fear occurs: 'nobody debates or quizzes you' before commitment, 'What you'll hear first' and 'Nervous? Call after hours' beside the script, 'Tonight works as well as right now' at the dial point, and 'Couldn't get through' offered as a loggable outcome (permission to fail). The privacy promi


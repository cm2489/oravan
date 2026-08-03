# Pre-launch teardown — Phase 1 report (v1)

*2026-08-03. Campaign plan: `~/.claude/plans/hazy-sprouting-hummingbird.md`. This v1 carries the full evaluation sweep (11 surface units, critique /40 + audit /20, dual-viewport, snapshots in `.impeccable/critique/`), the triaged detector sweep, and the 2026-08-02 blind-panel cross-reference. Pending for v2: the live competitor benchmark (plan §1C) and the two scripted walkthroughs (§1D — partially covered by the blind panel).*

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

---
date: 2026-07-25
topic: prelaunch-audit-open-findings
focus: The findings from the 2026-07-25 pre-launch audit that were deliberately NOT fixed before launch — logged with reproduction evidence so they are actionable later rather than re-discovered.
provenance: Produced by a 6-lens multi-agent audit of the full tree, every finding independently re-derived by an adversarial verifier before it was allowed to stand. 56 raised, 4 refuted, 14 downgraded, 38 confirmed. 18 were fixed (PRs #116, #117, and the truth-and-parity pass); these are the rest.
---

# Pre-launch audit — the open findings

**Read this before assuming a defect is new.** Everything below reproduced at least twice: once by the finder, once by an independent verifier who was instructed to refute it. Severities are the verifier's, and they measure **exploitability and blast radius — not embarrassment**. Several `low` items are cosmetically minor and reputationally not (that is exactly why the human-review claim, also rated `low`, was fixed rather than logged).

## What was fixed instead of logged

| Where | What |
|---|---|
| #116 | MCP batch amplification (blocker) · the false ZIP privacy promise (blocker) · the "Heading to a vote" forecast, in the UI label and in the published AI summary |
| #117 | LOC-echo dedupe · `statusDiffToCandidate` emitting non-events · `pruneEntry` referential integrity · the VERBATIM kill-switch's coverage gap · white-label `accentInk` AA floor · `call-action` non-determinism · the tenant-token/analytics credential split |
| this pass | the per-item human-review claim (4 strings + the MCP envelope + CLAUDE.md) · banned vocabulary in Moments chrome, plus a gate so it cannot return · the verbatim fallback's English-in-the-Spanish-field parity break · the Spanish 320px thumb-bar crowding · `DESIGN.md`'s stale one-full-bleed-band rule · Next 16.2.9 → 16.2.12 |

## Owner actions (not code)

- **Revoke or document five unused credentials.** `KV_REST_API_READ_ONLY_TOKEN`, `KV_REST_API_TOKEN`, `KV_REST_API_URL`, `KV_URL`, `REDIS_URL` sit in `.env.local` and are referenced by **no source file** (verified by grep across `app/`, `lib/`, `scripts/`). They are live credentials to a store nothing uses, and they are outside CLAUDE.md's declared runtime-secret inventory — so nobody would know to rotate them. Revoke in the provider dashboard, or add them to the inventory with a reason.
- **7 dependency advisories remain (4 high, 3 moderate) and are upstream-blocked.** `npm audit fix --force` proposes `next@16.2.12`, which is now installed and does **not** clear them — 16.2.12 still bundles `postcss@8.4.31` and `sharp@0.34.5`. Reachability: the PostCSS ones need attacker-controlled CSS (ours is authored, not user-supplied); `sharp`/libvips is reached through `next/image`. Re-check when the next Next minor ships.


## Test-suite honesty (9)

### `medium` · test-honesty-003

**The 905-line collector runner — the only module in the v2 live layer that spends money and writes AI text into the repo on every nightly and hourly run — has zero test coverage. Every failure branch the spec relies on for safety is unexercised: decode-call failure, decode JSON-parse failure, per-item lint rejection → verbatim fallback, batch-cap overflow, daily-event ceiling, summary JSON-parse failure, and the `_meta.generated_at` no-restamp write.**

`scripts/moment-updates.mjs`:525

*Evidence:* `grep -rn 'moment-updates.mjs' tests/` returns only a comment: tests/moment-updates-collect.unit.spec.ts:6 — "scripts/moment-updates.mjs itself is deliberately NOT imported". The tested surface is scripts/moment-updates-map.mjs (pure half) and lib/moment-updates-gate.mjs. Untested branches, all inside scripts/moment-updates.mjs: line 550 `catch (e) { console.error('decode call failed…'); return new Map(); }`; line 568 `catch { 'decode JSON parse failed… every item falls back to the verbatim record' }`; lines 810-822 the lint-reject → `fallbackTextFor(c); c.ai = false` path; line 833 the `DROPPED … even the verbatim record fails the lint` path; line 697 `summary … JSON parse failed`; line 746

*Suggested fix:* Split the runner the same way moment-updates-map.mjs already was: export `decodeUpdates`, `lintPair`, and the apply-decode-or-fallback loop as pure functions taking an injected client, then unit-test (a) a throwing client, (b) a client returning non-JSON, (c) a client returning a hedged line for a `vote` (must reject → ai:false + verbatim), (d) overflow past BATCH_CAP still stored with ai:false.

### `medium` · test-honesty-005

**Three tests hard-code the assumption "there is no live ANTHROPIC_API_KEY in this sandbox → 502". On a machine that has .env.local — i.e. the founder's own, where the standing rule is to verify e2e locally before pushing UI — those three go red in both projects (6 failures), and each attempt drives a real, billed Anthropic generation. With retries that is up to 12 paid script generations per local suite run, against a <$5/day all-in directive.**

`tests/embed-script-route.spec.ts`:40

*Evidence:* My full-suite run on current checkout: `[webkit-mobile] tests/embed-script-route.spec.ts:40` and `:96` and `:138` failed, and the same three failed on webkit-desktop — 6 of the 44 total failures. Log excerpt for :138: `expect(received).toEqual(expected) … - Expected "error" + Received "script", "cached"` at tests/embed-script-route.spec.ts:148 — i.e. the route returned a REAL generated script, not the 502 the test asserts. For :40 the artifact reads `Expected: 502 / Received: 200`. `grep -oE '^[A-Z_0-9]+' .env.local` confirms ANTHROPIC_API_KEY is present (value not read). The file header at tests/embed-script-route.spec.ts:16-20 states the 502 assumption as load-bearing: "502 means every che

*Suggested fix:* Stop keying the proof on Anthropic being unreachable. Either (a) have tests/e2e-server.mjs unset ANTHROPIC_API_KEY in the child env it spawns — it already controls that env block at e2e-server.mjs:149-153 — so the 502 assumption is created rather than assumed; or (b) assert the gate outcome without reaching generation (`expect([200, 502]).toContain(res.status())` plus `expect(res.status()).not.toBe(403)`), which is what the tests actually mean.

### `low` · test-honesty-002

**The AI-disclaimer count on the moment page is no longer pinned by anything. moments.spec.ts:93 uses `.first()` and moment-updates-page.spec.ts:72 uses `.last()`; with exactly one occurrence in the DOM both selectors resolve to that same element and both pass. Deleting the disclaimer under the AI-written "Where it stands" summary is therefore invisible to the suite — a CLAUDE.md hard rule ("AI content is always labeled") with no remaining test.**

`tests/moments.spec.ts`:93

*Evidence:* app/[locale]/moments/[id]/page.tsx renders `{t('bill.aiDisclaimer')}` twice: line 168 (hand-authored summary) and line 206 (machine-written state summary). data/moment-updates.json currently carries 2 summary_revisions for both moments (`government-funding-deadline updates=3 revisions=2`, `iran-war-powers updates=5 revisions=2`), so both render today. `grep -n 'aiDisclaimer' tests/*.ts` returns exactly two call sites: moment-updates-page.spec.ts:72 `.last()` and moments.spec.ts:93 `.first()`. Neither is a count assertion; delete line 206 and `.last()` falls back to the line-168 element and still reports visible. The `.first()` was introduced in fc4f63c with the comment "tests/moment-updates-

*Suggested fix:* In moment-updates-page.spec.ts, scope to the section rather than to ordinal position: `await expect(page.locator('section[aria-labelledby="where-it-stands"]').getByText(en.bill.aiDisclaimer)).toHaveCount(1)`. In moments.spec.ts, replace `.first()` with an explicit `toHaveCount(revision ? 2 : 1)` derived from the same fixture the page uses.

### `low` · test-honesty-004

**Five of the v2 spec's named editorial promises render on the live Moment page but have no assertion anywhere in tests/: the timeline's AI chip, the honest overflow line, the correction link, the verbatim kill-switch label, and the "we couldn't check" staleness sentence. The data-side helpers are well tested; the render side of the constitution is not.**

`components/MomentTimeline.tsx`:143

*Evidence:* Message keys under `moments.updates` in messages/en.json: whereHeading, summaryAiChip, revisionsToggle, revisionAsOf, revisionReasonLabel, timelineHeading, timelineLede, timelineAiChip, class, quietToday, quietDay, checkGapNote, overflow, sourcesLabel, correctionLink, verbatimLabel, refsLabel, refKind, privacyNote. `grep -on 'moments\.updates\.[a-zA-Z]*' tests/*.ts | sort | uniq -c` yields hits only for timelineHeading(3), summaryAiChip(3), refsLabel(2), quietDay(2), class(2), whereHeading, sourcesLabel, revisionsToggle, revisionAsOf, refKind, quietToday, privacyNote. Zero hits for: timelineAiChip (rendered MomentTimeline.tsx:143, gated on `hasAi` at :125 — the CLAUDE.md "AI content is alway

*Suggested fix:* Add fixture-driven render tests: a day with >RENDER_DAY_CAP updates (overflow line + count + congress.gov href), a `correction`-class update (label + back-link), a build with MOMENT_UPDATES_VERBATIM=1 (verbatimLabel shows, timelineAiChip does not), and an all-`ai:false` day (timelineAiChip absent). MomentQuietNote's checkGap branch is client-clock driven — drivable with page.clock.setFixedTime, the same idiom freshness.spec.ts already uses.

### `low` · test-honesty-006

**The corpus-dependence class that produced today's red is not confined to the one test that was rewritten. Seven other assertions hard-code a corpus identifier or a hand-counted total that the nightly sync or a curation edit can invalidate, with no gate proving the identifier still exists.**

`tests/sitemap.spec.ts`:31

*Evidence:* Hard-coded corpus identifiers, each re-derivable by grep: tests/sitemap.spec.ts:31 and :32 pin `<loc>…/moments/iran-war-powers</loc>` (both locales) — data/moments.json currently holds exactly two ids, `iran-war-powers` and `government-funding-deadline`; retiring the Iran moment reddens the sitemap suite. tests/hreflang.spec.ts:36 pins the same id. tests/sitemap.spec.ts:15 `const STATIC_PATH_COUNT = 14` is a hand-maintained count that must be edited in lockstep with app/sitemap.ts. tests/citations.spec.ts:35, :48 and :90 pin `hr-1787-119`; tests/decoded.spec.ts:6 and :33 pin `hr-5582-119`; tests/call-action.spec.ts:126 and tests/embed-script-route.spec.ts:33 pin `sjres-99-119` — none of thes

*Suggested fix:* For the id-pinned specs, derive from the data the way coverage.spec.ts does, or add one cheap guard spec that asserts every hard-coded fixture slug/moment id still resolves (`getBill(slug)` non-null, `getMoments()` contains the id) so a corpus change fails with a one-line diagnosis instead of a page-render mystery. For STATIC_PATH_COUNT, compute it from the same list app/sitemap.ts iterates rather than restating it.

### `low` · test-honesty-007

**Six of the suite's 18 skips are the same three staleness-honesty tests skipped in both projects, and they are skipped whenever the corpus is active — i.e. essentially always. The "Data check needed, never 'quiet'" copy, which is one of the product's core trust claims, is not exercised end-to-end in any normal run. Two more skips mean the `settled` moment framing is never rendered.**

`tests/freshness.spec.ts`:129

*Evidence:* Skip list extracted from the run log (`grep -E '^\s+-\s+[0-9]+ \[' `): 18 skipped = 5 mobile-only footer-reachability guards skipped on webkit-desktop (about:34, citations:56, embeds-configurator:197, landing:31) + 2 pointer/keyboard-only skipped on mobile (call-walkthrough:76 hover, feed:72 "/" accelerator) + 6 × freshness.spec.ts AE3 (:135, :147, :162, each in both projects) + 2 × funnel.spec.ts:117 quiet-week fallback + 2 × moments.spec.ts:124 settled-vs-live. The freshness three are gated by `test.skip(anyNow, 'corpus not quiet this week — empty band not renderable')` at lines 130, 139 and 151; `anyNow` is true for any corpus with an Act-now bill, which is the steady state. moments.spec.

*Suggested fix:* Cover the tri-state at a level that does not depend on live data: freshness.unit.spec.ts already owns emptyStateVerdict — add page-level coverage via a fixture route or a build-time env override, or accept the gap explicitly and note in STATUS.md that the stale/settled copy is unit-covered only. At minimum make the skip visible: a single always-running test asserting `anyNow === false || <the stale path is unit-covered>` documents the trade inste

### `low` · test-honesty-008

**A test named "the window matches the number published to users" never reads the published number. Its body asserts a constant against a literal, so the constant and the four places the copy states "14 days" can diverge with the suite green.**

`tests/moments-ui.unit.spec.ts`:84

*Evidence:* tests/moments-ui.unit.spec.ts:84-86: `test('the window matches the number published to users', () => { expect(SIGNAL_WINDOW_DAYS).toBe(14); });`. The published number lives in messages/en.json:750 ("…within the last 14 days."), en.json:763 ("…appeared in the last 14 days…") and the ES equivalents at es.json:750 and :763 — none of which the test imports. Changing SIGNAL_WINDOW_DAYS to 21 and this literal to 21 (the natural edit) leaves all four strings saying 14 and the suite green.

*Suggested fix:* Assert against the copy, not a literal: `for (const m of [en, es]) expect(m.moments.whyCriteria).toContain(String(SIGNAL_WINDOW_DAYS))` (and the howMadeRule2 key), which is what the test's own name promises.

### `low` · test-honesty-009

**The footer rebuild landed 113 changed lines and removed a message key from both locales with zero test changes. Nothing asserts the new colophon — the three provenance sentences, their aria-hidden separators (the stated screen-reader contract), or the removal of footer.corrections.**

`components/Footer.tsx`:163

*Evidence:* `git show d7f9636 --stat` = components/Footer.tsx | 113 ++---, messages/en.json | 5 +--, messages/es.json | 5 +--, and no tests/ path in the diff. The commit body claims "separators are aria-hidden so a screen reader hears three sentences, not soup" and "the now-unrendered footer.corrections key removed from both files"; `grep -rn 'corrections\|colophon\|aiNote' tests/*.ts` returns nothing for any of them. The only surviving footer pins are donate-shaped: tests/donate.spec.ts:35 (`footer.fundingLive` visible) and tests/donate.unit.spec.ts:46/50 (source-string pins). So the geometry-and-copy claims the commit was made for are self-reported only.

*Suggested fix:* Add one footer spec asserting: the colophon renders exactly three sentences, each separator carries aria-hidden, `footer.corrections` resolves nowhere (a missing-key render would surface as the raw key), and the feedback trigger is still reachable at #feedback on mobile.

### `low` · test-honesty-010

**The headline claim of the surface-promotion slice — /moments joining the primary nav — and the nav's active-state contract have no test. Nothing asserts that Moments is in the header nav, in the mobile tab bar, or that exactly one nav item carries aria-current="page".**

`components/Header.tsx`:99

*Evidence:* components/Header.tsx:99 and :133 render `aria-current={active ? 'page' : undefined}` from `isActive(pathname, href)` (Header.tsx:68-70, `pathname.startsWith(href)`). `grep -rn "aria-current" tests/*.ts` returns only tests/call-walkthrough.spec.ts:52 and :57, which are the walkthrough's step dots — no page-nav assertion exists. `grep -rn "nav.moments" tests/*.ts` returns nothing. The nav entry itself is components/Header.tsx:62 `{ href: '/moments', key: 'moments', wide: false }`, added in 1f7ca62 (#113) with no accompanying test.

*Suggested fix:* One spec on /moments and /moments/iran-war-powers: the header nav exposes a Moments link, `page.locator('nav [aria-current="page"]')` has count 1 per nav, and it is the Moments entry on both the index and a detail page (the startsWith prefix rule).


## Correctness (7)

### `medium` · correctness-changed-because-raw-tokens-rendered

**`rev.changed_because` holds machine tokens generated by the collector and the page prints them verbatim to readers, in both locales, under a localized label. Today /es/moments/government-funding-deadline renders "Se reescribió porque seed" — an untranslated English token in Spanish UI, violating the bilingual-parity hard rule ("Every user-facing string goes through messages/en.json + messages/es.json"). Worse, the status form of the token embeds the raw bill status enum the collector goes out of its way to keep off the page: a status change renders as `status:hr-9770-119 committee→floor_vote`.**

`app/[locale]/moments/[id]/page.tsx`:228

*Evidence:* app/[locale]/moments/[id]/page.tsx:228 — `{rev.changed_because.join(' · ')}`. Token producers in scripts/moment-updates.mjs: line 597 `return ['first-summary']`, line 602 `reasons.push(`status:${slug} ${grounded[slug] ?? 'unknown'}→${status}`)`, then `updates:+N` and `reanchor:Nd`. Shipped data/moment-updates.json carries changed_because values 'seed', 'updates:+1', 'updates:+2'. Verified on a running production build: `curl -s http://localhost:3441/es/moments/government-funding-deadline` returns "...|Se reescribió porque| |seed|..." and the EN page returns "Rewritten because | seed". scripts/moment-updates.mjs:155-162 documents that the raw enum must never reach reader-facing prose ("first

*Suggested fix:* Give changed_because a structured shape (e.g. `{kind:'status', slug, from, to}`) and render it through message keys with the existing `bills.status.*` phrases (which the collector already loads as STATUS_PHRASES), or drop the disclosure list's reason line from the UI and keep changed_because as an audit-only field in the data.

### `low` · correctness-press-cluster-leans-misaligned

**`source.leans` is documented and typed as the AllSides leans of `source.outlets` "in the same order", but the collector stores a de-duplicated, alphabetically sorted set. Any consumer that zips the two arrays by index mislabels outlets' political lean — on a site whose first hard rule is nonpartisan-by-construction. With 3 outlets [apnews(center), foxnews(right), npr(left)] the stored arrays index-map Fox News to 'left' and NPR to 'right'; with 4 outlets sharing a lean the arrays have different lengths entirely (4 vs 3), silently yielding `undefined`.**

`scripts/moment-updates-map.mjs`:604

*Evidence:* lib/moment-updates.ts:67-68 declares `/** AllSides leans of `outlets`, in the same order. Never rendered as a badge. */ leans?: MediaLean[];`. scripts/moment-updates-map.mjs:604 writes `leans: [...new Set(leans.filter(Boolean))].sort()`. Reproduced with the shipped function: outlets ['apnews.com','cbsnews.com','foxnews.com','npr.org'] (len 4) vs leans ['center','left','right'] (len 3); index-zipping gives npr.org => undefined. In the 3-outlet case outlets ['apnews.com','foxnews.com','npr.org'] vs leans ['center','left','right'] gives foxnews.com => 'left' and npr.org => 'right'. Nothing renders the field today (components/MomentTimeline.tsx deliberately never shows lean), so this is a live d

*Suggested fix:* Either store the per-outlet leans positionally (`leans: outlets.map((d) => leanOf(d, leanByDomain))`, keeping nulls so the arrays stay parallel) or rename the field to something set-shaped (e.g. `lean_set`) and update the JSDoc in lib/moment-updates.ts:67. Add a gate assertion in checkMomentUpdates that `source.leans.length === source.outlets.length` if the positional contract is kept.

### `low` · correctness-vehicle-action-sameday-skip

**The per-vehicle fetch skip is day-granular, so once the newest stored congress_actions day equals the corpus's `last_action_date`, the collector stops fetching that vehicle entirely — and any qualifying action added later on that same legislative day is never collected. If the bill then goes quiet (i.e. that day IS its last action), the missing events are lost permanently. This also falsifies the daily-ceiling log line at 787 ("the rest re-collect on the next run") and §3's "the store keeps every qualified event": events deferred by MOMENT_UPDATE_DAILY_EVENTS=40 for a vehicle whose newest day was already admitted can never come back.**

`scripts/moment-updates.mjs`:265

*Evidence:* scripts/moment-updates.mjs:265 — `if (stored && lastAction && lastAction <= stored) { ...continue; }` where `stored = newestStoredDay(slug)` is a 'YYYY-MM-DD' and `lastAction` is bills.json's date-only `last_action_date`. Congress.gov routinely lands multiple qualifying actions on one legislative day: tests/fixtures/congress-actions-hconres89.json has three qualifying actions all dated 2026-07-23 (floor_action + two votes) while data/bills.json's hconres-89-119.last_action_date is exactly 2026-07-23; tests/fixtures/congress-actions-hr9770.json has three qualifying actions on 2026-07-21. So a run that stores only the first of them locks the rest out on every subsequent run.

*Suggested fix:* Make the skip condition strictly-less-than plus a same-day grace: re-fetch when `lastAction >= stored` (not `<=`), or track the newest `recorded_at` per vehicle and always re-fetch a vehicle whose newest stored day is today/yesterday. Alternatively store a per-vehicle count of collected actions for the newest day and re-fetch when the corpus's action count disagrees.

### `low` · correctness-calls-store-not-validated

**The localStorage hardening added in this delta validates the calls array with `Array.isArray` only, so a malformed ELEMENT still crashes the whole tree — the exact failure class the change's own doc comment claims to close ("this layer has to be total"). A single null element in `oravan.calls` throws in ImpactPageClient and drops /impact to the error boundary. The boundary's copy then tells the reader to fix it by "erasing your saved data on the Impact page" — the page that is broken — so the documented escape hatch is unreachable.**

`lib/local.ts`:117

*Evidence:* lib/local.ts:117 — `const callsSnapshot = makeSnapshot<CallRecord[]>(CALLS_KEY, EMPTY_CALLS, Array.isArray);` (compare line 116, which validates prefs with isPlainObject). app/[locale]/impact/ImpactPageClient.tsx:25 dereferences `c.outcome` on every element. Reproduced against a production build with Playwright/WebKit: after `localStorage.setItem('oravan.calls','[null]')` and a reload, /impact renders h1 "Something went wrong" and the console shows `TypeError: null is not an object (evaluating 'c.outcome')` handled by ErrorBoundaryHandler; with `'[]'` or with `oravan.prefs='null'` the page renders "Your impact" normally. messages/en.json errorBoundary.body: "...erasing your saved data on the

*Suggested fix:* Validate elements, not just the container: pass a predicate like `(v) => Array.isArray(v) && v.every(r => r && typeof r === 'object' && typeof r.at === 'string')` — or have makeSnapshot filter invalid elements rather than reject the whole value. Separately, move the erase control (or a `?reset` query handler) somewhere the boundary can actually reach, so the recovery instruction is not circular.

### `low` · correctness-status-change-unrecoverable-on-step-failure

**The collector step is `continue-on-error: true` on the stated theory that "the collector is additive, and the next hourly run re-collects whatever this one missed". That is false for the `status_change` class: it is derived from `git show HEAD:data/bills.json` vs the working tree, and the job commits `data/` regardless of whether the collector step succeeded. Once the new bills.json is in HEAD, the diff is empty forever and the status change can never be recovered.**

`.github/workflows/newsdesk.yml`:83

*Evidence:* .github/workflows/newsdesk.yml:83 sets `continue-on-error: true` on the collector step; the subsequent "Commit data" step runs `git add data/` unconditionally and commits whenever anything changed. scripts/moment-updates.mjs:198-215 (collectStatusChanges) reads the pre-state from `git show HEAD:data/bills.json`, and statusDiffToCandidate returns null when before and after match. Demonstrated with the shipped function: `statusDiffToCandidate({before: bill, after: bill, ...})` returns null, while the same call with a differing prior status returns a candidate (id u_d51e2f76). The same shape applies in sync-bills.yml:59-75.

*Suggested fix:* Either fail the job (or at least skip the data commit for bills.json) when the collector step errors, or persist the pre-state the collector needs independently of git HEAD — e.g. have the collector write a small `last_seen_status` map it owns and diff against that instead of HEAD, so a skipped run does not consume the only copy of the pre-state.

### `low` · correctness-summary-ai-chip-not-data-gated

**The "Where it stands" AI chip renders whenever ANY revision exists, ignoring the revision's own `model` field — so a hand-authored revision is labeled "AI-drafted from the public record". The sibling timeline chip in the same delta IS data-gated (`u.ai`), so the two surfaces disagree about when a label is earned. The shipped seed carries exactly the shape that triggers it (`model: "hand-authored"`), and that revision is current on any deployment where the nightly summary step is skipped (no ANTHROPIC_API_KEY) or its output is rejected by the lint.**

`app/[locale]/moments/[id]/page.tsx`:186

*Evidence:* app/[locale]/moments/[id]/page.tsx:186 `{summaryRevision && (` … :195 `{t('moments.updates.summaryAiChip')}` — no reference to `summaryRevision.model`. Contrast components/MomentTimeline.tsx:125 `const hasAi = !VERBATIM && days.some((d) => d.rendered.some((u) => u.ai));`. data/moment-updates.json contains `s_1856a409` and `s_d26a6b43` with `"model": "hand-authored"`; they are currently the PRIOR revisions (the newest are claude-sonnet-5), which is why the mislabel is masked today. scripts/moment-updates.mjs:889-891 skips summary generation entirely when ANTHROPIC_API_KEY is unset, and lines 713-719 keep the previous revision standing when the model output fails lint — both leave a hand-autho

*Suggested fix:* Gate the chip on the revision's provenance, e.g. `const summaryIsAi = summaryRevision.model !== 'hand-authored'` (or add an explicit `ai: boolean` to SummaryRevision the way MomentUpdate has one) and render the chip only when true.

### `low` · correctness-verbatim-mode-hides-chip-over-ai-text

**The `MOMENT_UPDATES_VERBATIM=1` kill switch suppresses the timeline's AI chip unconditionally, but it only swaps the text for classes that HAVE a record. A `press_cluster` has `record === null` by schema, so in verbatim mode it keeps its AI-written sentence while the AI chip is gone — AI content rendered with no label, which the constitution's "AI content is always labeled" rule forbids.**

`components/MomentTimeline.tsx`:125

*Evidence:* components/MomentTimeline.tsx:125 `const hasAi = !VERBATIM && days.some((d) => d.rendered.some((u) => u.ai));` vs line 229 `const verbatim = VERBATIM && update.record !== null;` and line 230 `const body = verbatim ? update.record!.action_text : update.text[lang];`. lib/moment-updates.ts documents `record` as "Null ONLY on a press_cluster", and the component's own header comment acknowledges "a press cluster has none (record === null by schema), so it keeps its attributed sentence either way" — without reconciling that with the chip being switched off. No press clusters exist in data/moment-updates.json yet, so this is not currently visible in production; the collector produces them in nightl

*Suggested fix:* Compute the chip from the text actually rendered: `const hasAi = days.some((d) => d.rendered.some((u) => u.ai && !(VERBATIM && u.record !== null)));` so verbatim mode only removes the label for the rows whose voice it actually replaced.


## The live layer & collector (7)

### `medium` · live-layer-4

**The press-cluster attribution requirement is a bare substring test against outlet display names, several of which are 2–4 letters, so sentences that name no outlet pass — and because press_cluster is excluded from the speculation lint, an entirely unattributed forecast ships in Oravan's voice.**

`lib/moment-updates-gate.mjs`:594

*Evidence:* lintUpdateText:598 does `value.toLowerCase().includes(n.trim().toLowerCase())`. outletDisplayName() maps live coverage domains to short stems: rt.com->"Rt", en.protothema.gr->"En", news.ycombinator.com->"News", time.com->"Time", app.buzzsumo.com->"App" (187 distinct domains enumerated from data/coverage.json). Four real pairs pass with zero failures on sentences naming nobody: [Rt,Tass] + "Two outlets reported on the measure." ("repo-rt-ed"); [En,Ndtv] + "Coverage appeared when the House sent the bill over." ("wh-en"); [News,Wnd] + "The news of the vote circulated widely."; [Time,Ksl] + "At the time of the vote, coverage followed.". Separately, SPECULATION_LINT_CLASSES (:117) omits press_clu

*Suggested fix:* Require a word-boundary match (`new RegExp('\\b'+escape(name)+'\\b','i')`) and reject names shorter than ~4 characters by falling back to the full domain as the required token. Apply the speculation lint to press_cluster too, exempting only hedges that sit inside a clause containing a matched outlet name.

### `medium` · live-layer-7

**Removing or swapping a vehicle on a moment permanently reddens CI, because the gate applies current vehicle membership to append-only summary_revisions whose grounded_in.vehicle_statuses is a historical fact that can never be corrected without destroying the audit trail.**

`lib/moment-updates-gate.mjs`:985

*Evidence:* checkMomentUpdates:984-988 fails every `grounded_in.vehicle_statuses` key not in the moment's CURRENT vehicles; summary_revisions are append-only by design (lib/moment-updates.ts:187-190, gate chronology check at :944). Simulated on the real files: dropping sjres-172-119 from iran-war-powers' vehicles yields three violations, two of them `iran-war-powers.summary_revisions[0].grounded_in.vehicle_statuses: "sjres-172-119" is not one of iran-war-powers's vehicles` and the same for [1]. Both stored revisions currently ground in all four vehicles, so any curation change to that list is unfixable except by deleting revision history. summaryNeedsRefresh (:517-537) also never notices a removed vehic

*Suggested fix:* Apply the vehicle-membership check on grounded_in.vehicle_statuses only to the LATEST revision (hard) and warn on prior ones — a past revision truthfully records the vehicles the moment had when it was written. Keep the hard check on updates[].vehicle only for updates inside the current retention window, or add an explicit `retired_vehicles` field to moments.json.

### `medium` · live-layer-8

**The nightly run prunes revisions BEFORE appending the new one, so once a moment reaches the 30-revision cap every summary night commits 31 revisions — a hard gate violation that verify-sync does not catch, so it deploys and then reddens CI on main until the next night trims it.**

`scripts/moment-updates.mjs`:857

*Evidence:* scripts/moment-updates.mjs:857-870 runs pruneEntry (which does `slice(-MAX_REVISIONS)` at lib/moment-updates-gate.mjs:496) and only then does the summary loop at :873-899 do `entry.summary_revisions = [...(entry.summary_revisions ?? []), revision]`. checkMomentUpdates:919 fails at `> MAX_REVISIONS`. Reproduced with the real entry grown to 30 revisions: `after pruneEntry: 30 (cap 30)` -> `after tonight's append: 31` -> gate violation `government-funding-deadline.summary_revisions: 31 exceeds the 30-revision cap`. scripts/verify-sync.mjs:163-261, the only check that runs before the nightly commit, has no revision-count check at all.

*Suggested fix:* Move the prune loop after the summary loop, or have pruneEntry take an `incoming` count so it slices to `MAX_REVISIONS - incoming`. Also add the revision-count and per-day ceilings to verify-sync.mjs so the nightly dead-man's-switch catches this before the commit rather than after the deploy.

### `low` · live-layer-6

**Retiring a moment — a documented lifecycle operation on the hand-authored file — reddens CI on its own PR, and the only way to make it green is to hand-edit the machine-owned data/moment-updates.json, which is exactly the file-ownership contention the split exists to prevent.**

`lib/moment-updates-gate.mjs`:692

*Evidence:* checkMomentUpdates:692-696 emits a hard violation for any entry whose moment has `status === 'retired'`; the deletion that clears it happens only inside the nightly collector's prune (scripts/moment-updates.mjs:860), which cannot run inside a PR. Simulated against the real files: flipping data/moments.json's iran-war-powers to `status: "retired"` and re-running checkMomentUpdates yields `["iran-war-powers: the moment is stored-retired — a retired moment's updates are deleted, not kept (v2 spec §4, git history is the archive)"]`. Both live moments carry review_by 2026-08-22, so the first retire/renew decision lands before the ~Sep 22 launch.

*Suggested fix:* Downgrade the stored-retired case to a warning when the entry still has content (the nightly prune clears it within 24h) and keep it a hard violation only if the entry is empty-but-present, or teach the gate to tolerate one nightly cycle by comparing against `git show HEAD:data/moments.json`.

### `low` · live-layer-9

**The `prefer the chamber-source record, suppress the LOC echo` rule (v2 spec §4, implemented as sourceRank) is unreachable from the collector: the id-identity filter drops the duplicate before dedupeUpdates ever sees it, so which of the two records is stored depends on Congress.gov's response ordering — and once the LOC paraphrase is stored it can never be replaced.**

`scripts/moment-updates.mjs`:775

*Evidence:* For a voted action both rows hash to the SAME id (verified: hr-9770 roll 272 chamber row and LOC echo both -> u_31b2d040). scripts/moment-updates.mjs:774-778 filters candidates with `if (knownIds.has(c.id) || seen.has(c.id)) continue;` — first-seen wins — and only afterwards does the merge at :850 call dedupeUpdates, whose sourceRank tiebreak (lib/moment-updates-gate.mjs:321-323, 367-369) therefore never runs. Feeding the pair as [LOC, chamber] the collector's filter keeps `Library of Congress`, while dedupeUpdates on the same pair keeps `House floor actions`. Because knownIds is keyed by id, a stored LOC row is permanently sticky: `record.action_text` stays the paraphrase "Passed/agreed to

*Suggested fix:* Run the collected candidates through dedupeUpdates (or an explicit sourceRank-aware pick per id) BEFORE the knownIds/seen filter, and when a candidate's id already exists in the store but its sourceRank is higher, replace the stored row rather than skipping it.

### `low` · live-layer-10

**A moment vehicle whose only milestone actions fall outside the 60-day retention window is re-fetched from Congress.gov on every single run, forever, because the skip heuristic compares against the newest STORED day and nothing is ever stored for it.**

`scripts/moment-updates.mjs`:265

*Evidence:* scripts/moment-updates.mjs:265 skips only when `stored && lastAction <= stored`, where `stored = newestStoredDay(slug)` (:245-255) reads only rows already in data/moment-updates.json. Actions older than `retentionFloor` are filtered out at :287 and never stored, so `stored` stays null and the skip can never fire. Confirmed in the real production log of run 30167142037 (Newsdesk headline trigger, 2026-07-25T17:12:16Z): `actions hconres-38-119: 13 action(s), 1 milestone match(es), 0 candidate(s) inside retention` — one wasted Congress.gov request every hour, ~12/day, indefinitely, for a vehicle that structurally cannot yield anything.

*Suggested fix:* Track the newest actionDate EXAMINED per vehicle (a small map in data/moment-updates.json's _meta, or just compare against the bill's own last_action_date alone), so a vehicle whose corpus last_action_date has not advanced is skipped regardless of whether anything was stored.

### `low` · live-layer-11

**The timeline's day window is baked at build time on a fully static route, so between ET midnight and the next deploy the page prints the previous day labelled "Nothing recorded yet today" and omits the real current day entirely — a date claim the record does not support (§9.5) and a quiet day not rendered as a quiet day (§3). The MomentQuietNote sentinel that would caveat it stays silent for five days.**

`components/MomentTimeline.tsx`:115

*Evidence:* app/[locale]/moments/[id]/page.tsx sets `export const dynamicParams = false` and declares no `revalidate` (grep for 'export const revalidate' across the route returns nothing), so the page is fully prerendered. MomentTimeline.tsx:115 calls `timelineDays(momentId, WINDOW_DAYS, now)` with `now` undefined, and lib/moments-ui.ts's timelineDays defaults to `Date.now()` — i.e. build time; groupByDay (lib/moment-updates-gate.mjs:431-434) then builds the window starting from `etDay(now)`. MomentQuietNote.tsx:48 returns null while `freshnessState(checkedAt) === 'fresh'`, and lib/freshness-state.ts:19 sets FRESHNESS_CLAIM_WINDOW_DAYS = 5. Production confirms the surface is live and carries the claim:

*Suggested fix:* Render the "yet today" wording from the visitor's clock rather than the build clock — either move the isToday sentence into a client sentinel beside MomentQuietNote (same useSyncExternalStore hydration gate), or add `export const revalidate` to the route and pass an explicit `now` into MomentTimeline so the frame is a declared input rather than an ambient one.


## Design-refresh debt (5)

### `medium` · design-debt-configurator-iframe-remount

**The live-preview iframe is keyed on the full theme URL, so every tick of a native color-picker drag unmounts the iframe and re-fetches the widget document — one full SSR render and one blank-then-repaint per tick. Still present on main.**

`components/EmbedConfigurator.tsx`:719

*Evidence:* `<iframe key={previewSrc} src={previewSrc}>` at line 719-720. `previewSrc` is a useMemo whose deps (line 305) include `accent`, `surfaceInput` and `inkInput` — all driven by `<input type="color">` onChange, which fires continuously during a drag.

Reproduced (Chromium, page.on('request') counting only /embed/* document requests): dispatching 12 successive `input` events on #oravan-accent produced a delta of exactly 12 new document requests —
  /embed/rep-lookup?locale=en&accent=%23303030&radius=soft&font=system
  /embed/rep-lookup?locale=en&accent=%23404040&...
  ... through accent=%23e0e0e0 (12 URLs, one per tick)
The comment at line 253-254 justifies the key as "forces a fresh iframe/mount

*Suggested fix:* Key the iframe on the identity that actually needs a remount (`${widget}|${slug}`) and let `src` changes reuse the element, or debounce/commit the color inputs (onChange -> local state, onBlur/rAF -> previewSrc).

### `medium` · design-debt-match-success-silent

**The "Match your site" aria-live region announces loading and all four failures but is EMPTY on the ordinary success path, so a screen-reader user hears nothing while six theme controls silently change value.**

`components/EmbedConfigurator.tsx`:505

*Evidence:* The `<div aria-live="polite">` at line 505 has exactly three branches: `matchStatus === 'loading'` (506), the four error states (511-520), and `matchStatus === 'done' && adjusted` (522). There is no branch for `done && !adjusted`.
`adjusted` is only true when the server had to repair the extracted ink (lib/brandprompt.ts:130-134 — set inside `if (contrastRatio(ink, surface) < 4.5)`), so a site whose own colors already pass AA produces `done && !adjusted` — the region renders nothing at all.
Meanwhile lines 181-188 mutate six controls on success: accentInput, surfaceInput, inkInput, customColors, radius, font, mode. The only other live region on the page (line 749) is the copy-snippet confirm

*Suggested fix:* Render a success string in the same region for `matchStatus === 'done'` unconditionally (append the "adjusted" sentence when `adjusted` is true, rather than gating the whole announcement on it). Requires one new key in messages/en.json + messages/es.json.

### `low` · design-debt-designmd-lockstep-stale

**DESIGN.md's standing ⚠️ warning that `app/embed/embed.css` is out of lockstep and "still holds the retired Field Notebook palette" is factually false on main — the file was re-keyed to variant B, but the warning was never removed.**

`DESIGN.md`:219

*Evidence:* DESIGN.md:219 names six hexes as still present: #f3ecdd, #2a2318, #82632a, #fbf8f0, #1b1611, #e4d9c0.
`grep -rn "f3ecdd\|2a2318\|82632a\|fbf8f0\|1b1611\|e4d9c0" app components lib` returns ZERO matches repo-wide.
app/embed/embed.css:48-56 carries `--_surface: var(--oravan-surface, #ffffff)`, `--_ink: var(--oravan-ink, #16191b)`, `--_accent: var(--oravan-accent, #0f6c4a)` — identical to globals.css's @theme values and to lib/embed-theme.ts:84-85 MODE_DEFAULTS. embed.css:63-68 carries alert as rgba(140,58,31,.12) = #8c3a1f at 12%.
Risk: the doc is the constitution and is read first by every agent; a stale ⚠️ either invites a redundant "fix" or teaches the reader to discount the file's warnings

*Suggested fix:* Delete the ⚠️ block at DESIGN.md:219, keep the standing lockstep obligation sentence above it, and (optionally) note the date the re-key landed so the history stays legible.

### `low` · design-debt-offscale-spacing

**Two of the refresh-era surfaces use spacing values DESIGN.md explicitly declares off the scale — including one added by the newest commit on main — and nothing mechanical catches it.**

`components/Footer.tsx`:160

*Evidence:* DESIGN.md:107-109 enumerates the legal steps (2·4·8·12·16·20·24·32·48·64·96) and states: "`p-7` / `p-9` / `p-10` / `p-11` (28/36/40/44) are **off** the scale."
  components/Footer.tsx:160 — `mt-10` (40px) on the new colophon. `git blame` attributes it to d7f9636 "fix(footer): one section geometrically", the newest commit on main.
  app/[locale]/page.tsx:420 — `py-10` (40px) and `md:py-14` (56px, also not a legal step) on the moments strip. `git blame` -> b74430f (#104, the refresh itself).
Everything else checks out: the only `clamp()` outside globals.css (app/[locale]/bills/[id]/page.tsx:331, `clamp(2rem,4vw,4rem)`) lands on legal steps at both bounds, and I found no other off-scale spacing

*Suggested fix:* Footer.tsx:160 `mt-10` -> `mt-8` or `mt-12`; page.tsx:420 `py-10 ... md:py-14` -> `py-8 ... md:py-12`. If the scale is meant to hold across agent-built work, make it machine-enforced (an ESLint rule or a check-* script over the class strings) rather than doc-enforced.

### `low` · design-debt-configurator-input-shrink

**Three form controls on /embeds are missing `shrink-0` inside flex labels, so they render 13-18px wide instead of the declared 20px at phone widths — three different control sizes on one page. The correct idiom already exists elsewhere in the codebase.**

`components/EmbedConfigurator.tsx`:384

*Evidence:* Measured rendered boxes on /embeds (Chromium):
  @320 — the two widget-type radios (`mt-1 h-5 w-5 accent-ink`, line 384) measure 13.0 x 20 with computed flex-shrink: 1; the checkboxes at lines 614 and 670 (`h-5 w-5 accent-ink`) measure 20 x 20 and 17.6 x 20
  @390 — the same two radios measure 13.9 x 20 and 15.4 x 20
  @768 — all measure 20 x 20 (the squeeze is phone-only)
Each sits inside `<label className="flex ...">` (line 375, 608, 665) with no `shrink-0`, so flex-shrink defaults to 1 and the label's text sibling wins the space.
components/FeedbackDialog.tsx:213 uses `h-5 w-5 shrink-0 accent-ink` on the same kind of control — the idiom is already established, these three call sites just

*Suggested fix:* Add `shrink-0` to the three inputs at components/EmbedConfigurator.tsx:384, 614 and 670, matching FeedbackDialog.tsx:213.


## Constitution compliance (4)

### `medium` · constitution-05

**The "The vehicles" section of a Moment page renders four AI-decoded headlines beside the "Read + call" CTA with no AI label anywhere in the section — the one place on the site where unlabeled AI text sits directly on the control that drives a call.**

`app/[locale]/moments/[id]/page.tsx`:262

*Evidence:* app/[locale]/moments/[id]/page.tsx:262-285 passes `headline={bill.ai_headline}` and `ctaLabel={t('moments.readCall')}` ("Read + call") to MomentVehicleCard; components/MomentVehicleCard.tsx imports Chip but never renders `tone="ai"`. Measured in headless Chromium on /moments/iran-war-powers: the only AI chips are at y=312 ("AI-decoded", scoped by the page's own comment to the dek) and y=1086 ("AI-drafted from the public record", scoped to Where-it-stands); the vehicles `<h2>` sits at y=3188 at 1440x900 and y=3453 at 390x844 — 2876px / 3200px below the nearest label. Programmatic check of the rendered section: 0 occurrences of the AI marker, `'AI-decoded' in section` False, while 'Read + call

*Suggested fix:* Add one `Chip tone="ai"` above the vehicles grid carrying a string equivalent to bills.aiNote ("Plain-language headlines below are AI-decoded, then read by a person before they suggest a call"), EN+ES, matching the homepage's pattern.

### `medium` · constitution-07

**The revision-history disclosure prints raw internal machine tokens to users — "Rewritten because seed" in English and the identical untranslated "Se reescribió porque seed" in Spanish. Future values are worse ("updates:+1", "status:hr-9770-119 committee→floor_vote").**

`app/[locale]/moments/[id]/page.tsx`:228

*Evidence:* app/[locale]/moments/[id]/page.tsx:226-229 renders `{t('moments.updates.revisionReasonLabel')}` followed by `{rev.changed_because.join(' · ')}` with no mapping to a message key. The values are produced by scripts/moment-updates.mjs:600-610 as `seed`, `updates:+${fresh}`, `status:${slug} ${old}→${new}`, `reanchor:${n}d`. Live in production, both locales: `curl -s https://oravan.org/moments/government-funding-deadline` contains "Rewritten because seed" and `curl -s https://oravan.org/es/moments/government-funding-deadline` contains "Se reescribió porque seed". This bypasses the bilingual-parity rule (an English/machine token rendered inside Spanish chrome) and next-intl entirely.

*Suggested fix:* Map the token family to message keys (a `moments.updates.changedBecause.*` group with ICU args for slug/status/count) and render the localized form, falling back to hiding the line rather than printing the raw token.

### `low` · constitution-02

**The "How it's being covered" section renders third-party headlines and snippets verbatim, unquoted, as page body copy — including reader-directed advocacy and party-as-adversary framing. Nothing lints this corpus, so "nonpartisan by construction / no advocacy language, in either language" holds only for text Oravan writes, not for text Oravan publishes.**

`components/CoverageSection.tsx`:101

*Evidence:* components/CoverageSection.tsx:101 renders `{article.snippet}` in a bare `<p className="...text-ink-2">` — no quotation marks, no `<blockquote>`, no inline attribution beside the sentence. Live examples in production: https://oravan.org/bills/sjres-185-119 renders juancole.com / "Not rated" with the snippet "Now it's time for the Senate to act. Let's keep the pressure on and send this resolution to Trump's desk" (also on /es, untranslated); https://oravan.org/bills/hr-9200-119 renders "'Illegal aliens raping teenagers in America': Chip Roy blasts Dems for delays in ICE funding bill" (economictimes.indiatimes.com, "Not rated"). Counted over data/coverage.json: 535 items total, 5 carrying read

*Suggested fix:* Either (a) run lintForbidden over title+snippet in scripts/sync-coverage.mjs and drop or truncate-to-title items that trip it, or (b) mark the snippet as the outlet's words typographically (quote marks plus a visible "— {source}" attribution) so third-party advocacy can never read as Oravan's voice. (a) is closer to the constitution's "by construction" phrasing.

### `low` · constitution-08

**The "Where it stands" AI chip is not gated on provenance, unlike the timeline's. A hand-authored revision is therefore presented under an "AI-drafted from the public record" chip today, and a hand-authored current revision would be labeled AI outright — over-labeling, which erodes the label the same way under-labeling does.**

`app/[locale]/moments/[id]/page.tsx`:186

*Evidence:* app/[locale]/moments/[id]/page.tsx:186 renders the section on `summaryRevision &&` alone and the chip at :193-197 unconditionally; lib/moment-updates.ts:109-121 shows `SummaryRevision` carries `model: string` but no `ai: boolean`, and getCurrentSummary (:183) returns `.at(-1)` with no provenance check. Contrast components/MomentTimeline.tsx, which computes `const hasAi = !VERBATIM && days.some(d => d.rendered.some(u => u.ai))` and renders no chip when every update is `ai:false` — which is why the timeline currently shows no chip at all (all 8 shipped updates are `ai:false`). Live instance: both Moments' revision history renders the seed revision stamped `"model": "hand-authored"` (data/momen

*Suggested fix:* Gate the chip on provenance the way the timeline does — e.g. render it only when `summaryRevision.model !== 'hand-authored'`, and stamp each entry in the revision list with its own provenance so a mixed history reads honestly.


## Security (2)

### `low` · security-api-reps-no-rate-limiter

**/api/reps is the only public dynamic route with no rate limiter and no entry in the RouteName union, and its responses are not CDN-cached — so every request is an unbounded, unmetered serverless invocation.**

`app/api/reps/route.ts`:5

*Evidence:* Enumerating the API surface against lib/ratelimit.ts's RouteName union: script ('script'), district ('district'), feedback ('feedback'), mcp ('mcp-min'/'mcp-day'), brand ('brand'/'brand-day'), tenant/impressions ('tenant-impressions'/'tenant-impressions-read') all call a limiter; stripe/webhook deliberately has none and documents why (route.ts:54-60, signature-authenticated caller). app/api/reps/route.ts imports nothing from lib/ratelimit.ts at all and has no documented exemption. Live probe: `curl -D- https://oravan.org/api/reps?zip=78501` returns `HTTP/2 200`, `cache-control: public, max-age=0, must-revalidate`, `x-vercel-cache: MISS` — no shared-cache absorption, so each request executes

*Suggested fix:* Either add a 'reps' member to the RouteName union with a generous limiter (it is a legitimate high-frequency lookup — the district route's 10/10min shape is a reasonable starting point), or write the exemption down in the route header the way the Stripe webhook does, stating what absorbs the load instead.

### `low` · security-brand-outbound-fetch-precedes-global-breaker

**/api/brand performs up to three attacker-directed outbound HTTPS fetches before any aggregate cap is consulted. The global daily breaker sits after the fetch on the stated reasoning that failed fetches are '$0', which is false: each one holds a serverless function for up to 12 seconds of wall time and originates traffic from Oravan's egress IPs to a caller-chosen host.**

`app/api/brand/route.ts`:126

*Evidence:* app/api/brand/route.ts:126 issues `fetchGuarded(`${origin}/`, HTML_FETCH)` and :135 fetches up to two stylesheets, while the global breaker `dayLimiter.isLimited(GLOBAL_BUCKET)` is only reached at :143. The only gate before the fetch is the per-IP limiter at :101 (5 requests / 10 min). Timeouts: HTML_FETCH.timeoutMs = 8000 (:82), CSS_FETCH.timeoutMs = 4000 (:89) — so a single request can pin a function for ~12 s against a deliberately slow host. The code comment at :98-100 justifies the ordering with 'cache hits, bad requests, or failed fetches (all $0)', which holds for Anthropic spend but not for function time or outbound-request volume; there is consequently no ceiling at all on how many

*Suggested fix:* Move a cheap aggregate breaker in front of the fetch — a second global window (e.g. 'brand-fetch-day') consumed on the fetch path, sized well above the Anthropic breaker so cheap junk still can't dark the feature, but finite. Correct the :98-100 comment: a failed fetch costs function time and egress, not nothing.


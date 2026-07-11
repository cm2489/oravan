# Predecessor gap audit — what builds #1 and #2 left behind

**Recorded:** 2026-07-11, during the three-repo folder consolidation (local working folder is now `~/Projects/oravan` = this repo; both predecessors archived).
**Purpose:** one dated record of every predecessor feature/idea and where it landed — absorbed, consciously killed, or still an open idea — so nothing is silently lost and nothing already decided gets re-litigated. Ideas only; no code was ported (CLAUDE.md firewall intact).

**The predecessors** (naming-gate note: build #1's product name is a banned literal here; it is named in `docs/migration/oravan-grounding.md` §2 and narrated in `docs/ideation/2026-07-02-monetization-strategy.md` §1.4):
- **Build #1** — the pre-pivot consumer app (Supabase accounts, personalized feed, dashboard; 312 commits, frozen 2026-06-10). Public GitHub repo; local copy archived at `~/Projects/_archive/` (folder carries the product name). Its MCP-pivot docs also live on its `feat/mcp-pivot-docs` branch.
- **Build #2** — the Civic Action MCP plan (2026-06-11, strategy docs only, zero code). Complete history archived at `cm2489/oravan-brand-v1` (main + 2 branches); local copy at `~/Projects/_archive/oravan-mcp-fork`. Its PIVOT.md is already superseded point-by-point by `2026-07-02-mcp-spec.md` §0.

---

## 1. Never absorbed — open ideas (the payload)

| Idea | Origin | What it is | Notes for a future decision |
|---|---|---|---|
| `get_upcoming_activity` calendar tool | Build #2 F4 | Scheduled committee hearings/markups from Congress.gov committee-meeting data ("what's happening this week on healthcare"). Explicitly NO floor-vote-date prediction. | The forward-looking complement to `whats_moving` (which is retrospective). Read-only, fits the constitution. Costs: new sync-time ingestion + a 6th tool (mcp-spec §2 warns tool-count bloat degrades agent tool selection). |
| Rep roll-call votes (`get_rep_vote`) | Build #2 F5 | "How did my rep vote on X" from Congress.gov roll-call endpoints — a top-frequency civic query the live site can't answer. Facts only; scorecards/grades stay banned. | Closes the loop: decode → call → "here's what happened." Needs vote ingestion into `data/`; `get_representative` covers profile facts already. |
| Bill progress meter | Build #1 (parked, `deferred.md`) | Pass-odds / "how far along is this bill" visual on bill pages. | Was parked pre-pivot; never rejected. Brittleness concerns are the same ones that killed vote-date prediction — treat with care. |
| Bill impact projections | Build #1 (parked) | Surface CBO/OMB analyses on bill pages. | Facts-only sourcing exists (CBO is public domain); scope cost unknown. |
| Action moments v2 | Build #1 (parked, its STRATEGY.md §15) | Callable civic events *without* a bill_id (nominations, funding deadlines, oversight hearings). | Overlaps the `get_upcoming_activity` idea; could be its citizen-site face. |
| Per-category winners/losers ("issue analysis") | Build #1 (schema concept, never generated anywhere) | Structured per-bill "who's affected and how" beyond the plain-language summary. | Died unbuilt in build #1; decode quality here may already cover the need. Listed for completeness. |
| Client-side bill following | Build #1 had a server-side watchlist table (no writer ever built) | A localStorage "follow this bill" on the citizen site (constitution-compatible variant of build #2's tracking). | Server-side tracking is killed (see §2); a *local* follow + freshness diff on revisit was never evaluated. |

The Apple MCP gateway distribution flag — the other genuinely un-absorbed item — ships separately as `docs/ideation/2026-07-11-apple-mcp-gateway-flag.md` (its own PR), not in this table.

## 2. Consciously killed — decided, with receipts (do not re-litigate casually)

- **Metering, Stripe billing, tier ladder, tracking-as-paywall, webhooks, x402, OAuth phases** (build #2's monetization core) — killed by `2026-07-02-mcp-spec.md` §0–§1: free/keyless for 12 months, dormant institutional key hook, Feb 2027 decision gate. Build #2's honest-revenue framing and tier ladder remain useful *inputs* to the Stripe decision (S18–S20) and are preserved in the archives.
- **`draft_call_script` over MCP** — deliberately not exposed (mcp-spec: cost + policy risk + constitution).
- **Accounts, profiles, dashboards, personalized server-side feed, email verification, GDPR delete** (build #1's spine) — superseded by the no-server-side-user-data constitution (CLAUDE.md hard rule #1); `localStorage` + the impact ledger are the replacements.
- **Web push** — killed twice (build #2's PIVOT §8 "do not resurrect"; this repo's 2026-07-04 feature verdicts: "notifications killed").
- **Email-blast / multi-channel messaging, scorecards/grades, district sentiment analytics, sales-led anything** — rejected in build #2's PIVOT §3/§8 and never revived here.
- **State legislatures** — spec'd (S25, `docs/plans/2026-07-06-state-expansion-triage-spec.md`), build parked behind its two triggers. Not a predecessor gap; tracked live.

## 3. Absorbed — already in this build (for the record)

Brand kit (mark/wordmark/voice — mig S2, values not files) · the decoded bilingual corpus concept + urgency scoring · the 5 read-only MCP tools incl. the "recurrence beats coverage" insight (`whats_moving`) · anti-slop call-first positioning · review-before-use AI scripts · Aug/Sep 2026 listing deadline · honest-revenue discipline · the reference-client idea (this whole site).

## 4. Reference implementations (archives, firewall applies)

Build #1 contains proven, tested implementations of things this repo may someday rebuild: Congress.gov member/district/seniority lookup quirks, a 32-CRS-area taxonomy + keyword tagger, summary/headline prompt engineering with cost ceilings, sync high-water-mark orchestration. **The firewall stands:** if any §1 idea is ever green-lit, re-derive the implementation here; the archives are for checking *what was learned*, not for copying code. Consult via the archived repos, read-only.

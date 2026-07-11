# Apple MCP gateway — standing distribution flag

**Recorded:** 2026-07-11 (ported from build #2, the Civic Action MCP plan — original decision 2026-06-11).
**Source:** branch `feat/apple-mcp-gateway-flag` of the archived build-#2 repo (`cm2489/oravan-brand-v1`), the only piece of that build's distribution thinking that never made it into this repo's docs. Ported as strategy, not code; screened through the naming gate.
**Status:** standing watch item — no build work implied today. Listed under STATUS.md standing owner items.

---

## The flag

**Apple is shipping native MCP support** — integrated with App Intents across macOS/iOS/iPadOS (in betas since iOS 26.1; WWDC June 2026 centered on an agentic Siri). When Apple's MCP surface reaches consumers, **any compliant MCP server becomes reachable from ~1.5B Apple devices** — for us that's distribution at platform scale with **zero extra build, no approval program, no per-user fees, no human-support requirement**. Potentially the single largest distribution event this product will ever get; the cost of being ready is near zero, so the only way to lose it is to forget it.

The Poke / Messages-for-Business path was evaluated and **rejected** (2026-06-11): that route means per-user fees to Apple, a mandatory live-human-support commitment, and building a consumer assistant — all of which violate the solo/4-hrs-week operating model. **We ride Apple's MCP door, not Apple's assistant-approval door.**

## Why this repo is already positioned

The live MCP server's design rules line up with Apple-compat by accident of good hygiene: read-only tools (`readOnlyHint: true`, `openWorldHint: false`), no OAuth requirement, Streamable HTTP, citation envelope (`docs/ideation/2026-07-02-mcp-spec.md` §2). Strict MCP-spec compliance (auth, transport) is the whole moat here — keep it current and Apple-compat is automatic, not a scramble.

## Standing actions

1. **Track Apple's MCP/App Intents rollout** (betas, WWDC sessions, dev docs) — know when the consumer surface ships.
2. **The moment Apple's MCP client is testable, verify the server connects and every tool works from it** — treat breakage as a P1.
3. **Be present in whatever connector directory/registry Apple surfaces, the week it opens** — add it to the S12 registry/directory submission list (`docs/ideation/2026-07-05-build-gtm-strategy.md` §S12) alongside the official MCP registry, PulseMCP/Glama/Smithery, and the Claude Connectors Directory.
4. **Keep MCP-spec compliance strictly current** (auth, transport) so item 2 is a checkbox, not a project.

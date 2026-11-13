The nightly sync of 2026-11-13 ran the Moment-scaffold floor-action sweep (`scripts/check-scaffold-corpus.mjs`) and found something to read.

**No page reads this matcher.** `floorActionInRecord` drafts the qualifying signal in a `moment-watch`
scaffold. A sentence it misses leaves that field empty and says so, which is the safe direction. That is
why this is an issue and not a failed night — and why it no longer reds CI on unrelated PRs.

### Floor activity the matcher does not read
- **sjres-98-119** — `floor_vote`, not a placement, not claim-free, not settled:
  > Point of order that the measure is not entitled to expedited procedures under 50 U.S.C. 1546(a) raised against the measure agreed to in Senate by Yea-Nay Vote. 50 - 50. Record Vote Number: 9.

Swept: 603 `floor_vote` records — 40 floor activity, 1 claim-free, 12 settled outcomes.

Fix a missed sentence by extending `FLOOR_ACTION_PATTERNS` in `scripts/moment-scaffold.mjs` (or, if the
sentence is read and deliberately claim-free, `floorMakesNoClaim` in `lib/floor-text.mjs`), with a fixture
in `tests/moment-scaffold.unit.spec.ts`. Close this issue when the sweep comes back clean.
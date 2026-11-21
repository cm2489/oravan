# Names fixture (test data only)

`short-titles.json` here is **test data for CI**, never the live data file.

- It holds the record short titles of 11 bills of the 119th Congress, copied unchanged from `data/short-titles.json` on Nov 19, 2026.
- Only the `names-fixture` job in `.github/workflows/ci.yml` reads it, through the switch `ORAVAN_E2E_NAMES_FIXTURE=1` (`lib/names-fixture.mjs`). With the switch on, every other bill counts as tried, so the fill gate turns names on and six list pages exist: `born-alive-abortion-survivors-protection-act`, `earth-mri-reauthorization-act-of-2026`, `guard-act`, `guarding-unprotected-aging-retirees-from-deception-act`, `protecting-american-taxpayers-act` and `take-care-of-americas-veterans-act` (two spellings of the title).
- A Vercel build refuses the switch, and every other build ignores this folder. `tests/names-fixture.unit.spec.ts` pins both.

If one of these bills leaves `data/bills.json`, a page may lose a bill. The browser tests read the pages from the build's own tables, so they stay correct. The unit test fails when fewer than three pages remain, which is the sign to refresh this file.

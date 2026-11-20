/*
 * THE NAMES FIXTURE SWITCH — TEST DATA ONLY (the independent check of #510,
 * Nov 19, 2026: "make CI see the list page").
 *
 * While the nightly's first fill of data/short-titles.json is unfinished the
 * fill gate keeps every name off (lib/short-address-build.ts gateNameTables),
 * so no page under /names/ exists and nothing has ever rendered one in a
 * browser on CI. This switch lets ONE CI job (`names-fixture` in
 * .github/workflows/ci.yml) build the site with a small, committed FIXTURE
 * titles file instead, so that a few list pages exist and the browser tests
 * that need them run:
 *
 *   ORAVAN_E2E_NAMES_FIXTURE=1
 *
 * ON, the build reads its record short titles from
 * tests/fixtures/names-e2e/short-titles.json (real titles of the record,
 * copied from data/short-titles.json on Nov 19, 2026, for 11 bills), and every
 * other corpus bill counts as tried (as if its read had failed), so the fill
 * gate turns names on. Nothing in data/ is read for names, and nothing is
 * written anywhere.
 *
 * OFF (unset, empty, "0", "off", "false"), which is every real build, nothing
 * changes: the build reads data/short-titles.json and
 * data/short-titles-retry.json exactly as before. tests/names-fixture.unit.spec.ts
 * pins that the tables and pages a build makes with the switch off are the ones
 * the data files alone give, and tests/static-rendering.spec.ts runs on the
 * main CI build, which never sets it.
 *
 * REFUSED on Vercel: a deployed site must never serve fixture names. Any of
 * the Vercel variables below set together with the switch throws, so that
 * build fails and nothing deploys. (Unlike the ended-Congress review switch,
 * it is allowed in CI: CI is where it is for.) Any value but "1" throws too.
 *
 * Read only at build and on the server (next.config.ts, lib/short-address-build.ts);
 * no page's browser code imports it.
 */

/** The switch's name. */
export const NAMES_FIXTURE_ENV = 'ORAVAN_E2E_NAMES_FIXTURE';

/** The fixture titles file, relative to the project root. Test data only. */
export const NAMES_FIXTURE_TITLES_PATH = 'tests/fixtures/names-e2e/short-titles.json';

/** The environment names under which the switch is refused. */
export const NAMES_FIXTURE_REFUSED_WHERE = Object.freeze(['VERCEL', 'VERCEL_ENV', 'VERCEL_TARGET_ENV', 'VERCEL_URL', 'VERCEL_GIT_COMMIT_SHA']);

/**
 * Whether the switch is on, from an environment. Throws where it is refused.
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function namesFixtureFrom(env) {
  const raw = String(env?.[NAMES_FIXTURE_ENV] ?? '').trim();
  if (raw === '' || raw === '0' || /^(off|false)$/i.test(raw)) return false;
  const refusedBy = NAMES_FIXTURE_REFUSED_WHERE.filter((name) => {
    const v = env?.[name];
    return typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  });
  if (refusedBy.length > 0) {
    throw new Error(`${NAMES_FIXTURE_ENV} is a CI test setting and is refused here (${refusedBy.join(', ')} set): a deployed site never serves fixture names.`);
  }
  if (raw !== '1') throw new Error(`${NAMES_FIXTURE_ENV}=${JSON.stringify(raw)} is not accepted: set it to "1" or leave it unset.`);
  return true;
}

const runtimeEnv = typeof process !== 'undefined' && process.env ? process.env : {};

/** On for this process: only in the CI job that sets it. */
export const NAMES_FIXTURE_ON = namesFixtureFrom(runtimeEnv);

/**
 * The retry entries the fixture stands in for: every corpus bill the fixture
 * does not hold counts as tried, so the fill gate can turn names on. Pure.
 * @param {ReadonlyArray<{ bill_type: string, bill_number: number, congress_number: number }>} bills
 * @param {Record<string, unknown>} titles
 * @returns {Record<string, unknown>}
 */
export function fixtureRetries(bills, titles) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const b of bills) {
    const slug = `${b.bill_type}-${b.bill_number}-${b.congress_number}`;
    if (!Object.prototype.hasOwnProperty.call(titles, slug)) out[slug] = { failures: 1, last_tried: 'fixture', reason: 'not in the names fixture' };
  }
  return out;
}

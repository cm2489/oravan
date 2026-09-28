/*
 * Weekly: record the FEC's special-election dates for every vacant House
 * seat in data/special-elections.json. Runs from refresh-legislators.yml
 * right after scripts/process-data.py has rewritten data/vacancies.json, so a
 * seat that got a member this week drops off here too. Pure logic, the source
 * and what is (and is not) recorded: lib/special-elections.mjs.
 *
 * Never fails the run on the FEC's account: a seat whose request fails keeps
 * its last good entry (old `checked` date and all) and the run prints a
 * ::warning. The weekly roster must still commit when the FEC is down. $0, no
 * secret: the key is api.data.gov's public DEMO_KEY. Stdlib-only (Node's
 * global fetch), like scripts/check-redistricting-watch.mjs.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildSpecialElections, electionDatesUrl, seatSlug, specialDatesFrom } from '../lib/special-elections.mjs';

const VACANCIES_PATH = 'data/vacancies.json';
const OUT_PATH = 'data/special-elections.json';

async function fetchDates(seat) {
  try {
    const res = await fetch(electionDatesUrl(seat), {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'oravan-special-elections/1.0 (+https://github.com/cm2489/oravan)' },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const dates = specialDatesFrom(await res.json(), seat);
    if (!dates) throw new Error('unexpected response shape');
    return dates;
  } catch (e) {
    console.log(
      `::warning::FEC election dates for ${seatSlug(seat).toUpperCase()} not fetched (${e.message}) - ` +
        'keeping the last recorded entry, with its old checked date.'
    );
    return null;
  }
}

async function main() {
  const vacancies = JSON.parse(readFileSync(VACANCIES_PATH, 'utf8'));
  const prev = existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, 'utf8')) : {};
  const today = new Date().toISOString().slice(0, 10);

  const fetched = new Map();
  for (const seat of vacancies) fetched.set(seatSlug(seat), await fetchDates(seat));

  const next = buildSpecialElections(vacancies, fetched, prev, today);
  writeFileSync(OUT_PATH, `${JSON.stringify(next, null, 2)}\n`);

  for (const [slug, entry] of Object.entries(next)) {
    const list = entry.dates.map((d) => `${d.type} ${d.date}`).join(', ') || 'none on the FEC calendar';
    console.log(`special-elections: ${slug} - ${list} (checked ${entry.checked})`);
  }
  console.log(`special-elections: ${Object.keys(next).length} vacant seat(s) recorded`);
}

main().catch((e) => {
  console.error(`::error::special-elections sync crashed: ${e.message}`);
  process.exit(1);
});

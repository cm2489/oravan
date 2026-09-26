/**
 * CI gate for data/question-press.json — the per-question GDELT evidence
 * (lib/question-press.mjs). The same judgement runs in the nightly
 * scripts/verify-sync.mjs (where every finding only WARNS: this optional file
 * can never fail the nightly) and, before every write, in
 * scripts/gdelt-intake.mjs.
 *
 *   node scripts/check-question-press.mjs
 *   node scripts/check-question-press.mjs --self-test
 *
 * WHY HERE TOO: the file is written by .github/workflows/question-press.yml,
 * which commits straight to main and dispatches ci.yml against the pushed
 * data — the same reasoning scripts/check-conversation.mjs gives for itself.
 *
 * WHAT IT PROTECTS: every count in the file is a number of links a reader can
 * open, from an outlet AllSides rates, inside the week it claims — and the
 * file carries nothing else. No tone, no sentiment, no titles, no article
 * text: any key the format does not define fails here. And GDELT's terms ask
 * that any redistribution cite the GDELT Project with a link, so a file
 * without that citation fails too.
 *
 * WHAT FAILS HERE, AND WHAT ONLY WARNS. Only DAMAGE IN THE FILE ITSELF fails
 * (`failures`): a finding no change to another data file can cause. DRIFT
 * (`drift`) only warns: the file names a question data/moments.json no longer
 * has, or an outlet data/media-bias.json no longer rates or now rates with
 * another lean. Those come from a change to THOSE files, so failing here
 * would block a moments or bias PR over a file it did not touch, and turn
 * main red until GDELT answered again. The collector repairs drift by itself
 * on its next run, even a run on which GDELT answers nothing (a repair write,
 * lib/question-press.mjs `shouldWrite`). The cost: CI cannot tell an outlet
 * media-bias.json stopped rating from a never-rated outlet added by hand.
 * Both warn here, and the next collector run removes either.
 *
 * A MISSING file is not a failure: scripts/gdelt-intake.mjs is what first
 * writes it.
 *
 * TIME: every day in the file is judged against the day it was written
 * (`_meta.as_of`), never against the clock this check runs at — so the file
 * the collector committed yesterday still passes at 00:30 UTC today, before
 * the first run of the day has rewritten it, and a file GDELT's outage left
 * unwritten for a week still passes. Lateness (a file or a question
 * not refreshed for days) is a ::warning::, never a failure: it says "we are
 * behind", not "the file is damaged" (the owner's N8-A2 ruling, CLAUDE.md).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  GDELT_ATTRIBUTION,
  MATCH_RULE,
  OUTLET_POLICY,
  QUERY_SHAPE,
  QUESTION_PRESS_PATH,
  QUESTION_PRESS_SCHEMA,
  QUESTION_PRESS_WINDOW_DAYS,
  countsFor,
  verifyQuestionPress,
} from '../lib/question-press.mjs';

const url = (p) => new URL(`../${p}`, import.meta.url);

if (process.argv.includes('--self-test')) {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const bias = { 'foxnews.com': 'right', 'npr.org': 'center', 'cnn.com': 'left' };
  const moments = { 'q-live': { status: 'live' } };
  const meta = {
    schema: QUESTION_PRESS_SCHEMA,
    source: 'GDELT DOC 2.0 API',
    attribution: GDELT_ATTRIBUTION,
    window_days: QUESTION_PRESS_WINDOW_DAYS,
    as_of: today,
    outlet_policy: OUTLET_POLICY,
    bias_table: 'data/media-bias.json',
    query_shape: QUERY_SHAPE,
    matches: MATCH_RULE,
    stores: 'counts and links',
  };
  const outlet = (over = {}) => ({
    domain: 'foxnews.com',
    lean: 'right',
    firstSeen: today,
    lastSeen: today,
    articles: [{ url: 'https://www.foxnews.com/politics/a', seen: today }],
    ...over,
  });
  const doc = (outlets, entryOver = {}, metaOver = {}) => ({
    _meta: { ...meta, ...metaOver },
    questions: {
      'q-live': { checkedOn: today, terms: ['war powers'], counts: countsFor(outlets), outlets, ...entryOver },
    },
  });
  // DRIFT: the file disagrees with data/moments.json or data/media-bias.json.
  // Each must be reported as drift — a warning, never a failure — and never
  // accepted silently.
  const driftCases = [
    ['an unrated outlet', doc([outlet({ domain: 'example-blog.test', articles: [{ url: 'https://example-blog.test/a', seen: today }] })])],
    ['a lean that disagrees with data/media-bias.json', doc([outlet({ lean: 'left' })])],
    ['an unknown question id (deleted from data/moments.json)', { _meta: meta, questions: { 'no-such-question': { checkedOn: today, terms: ['war powers'], counts: countsFor([]), outlets: [] } } }],
  ];
  // DAMAGE: wrong in the file itself, whatever the other files say.
  const cases = [
    ['a lean that is not a rated lean', doc([outlet({ lean: 'far-left' })])],
    ['a tone score on an outlet', doc([outlet({ tone: -3.2 })])],
    ['a headline stored with a link', doc([outlet({ articles: [{ url: 'https://www.foxnews.com/politics/a', seen: today, title: 'x' }] })])],
    ['a sentiment block on a question', doc([outlet()], { sentiment: { avg: 1 } })],
    ['a link on another outlet’s domain', doc([outlet({ articles: [{ url: 'https://cnn.com/a', seen: today }] })])],
    ['a counted outlet with no links', doc([outlet({ articles: [] })])],
    ['a link older than the window', doc([outlet({ firstSeen: '2020-01-01', articles: [{ url: 'https://www.foxnews.com/politics/a', seen: '2020-01-01' }] })])],
    ['a future-dated link', doc([outlet({ lastSeen: '2099-01-01', articles: [{ url: 'https://www.foxnews.com/politics/a', seen: '2099-01-01' }] })])],
    ['counts that disagree with the stored links', doc([outlet()], { counts: { outlets: { left: 5, center: 0, right: 1 }, articles: { left: 5, center: 0, right: 1 } } })],
    ['a single-word search term', doc([outlet()], { terms: ['iran'] })],
    ['a bill-number search term', doc([outlet()], { terms: ['s. 3172'] })],
    ['a missing GDELT citation', doc([outlet()], {}, { attribution: 'from the internet' })],
    ['an unknown schema', doc([outlet()], {}, { schema: 'question-press/v99' })],
    ['no _meta.as_of (nothing to judge the days against)', doc([outlet()], {}, { as_of: undefined })],
    ['an _meta.as_of in the future', doc([outlet()], {}, { as_of: '2099-01-01' })],
    ['a link seen after the day the file was written', doc([outlet()], {}, { as_of: '2020-01-01' })],
    ['a last check outside the window (zero counts that would read as "no coverage")', doc([], { checkedOn: '2020-01-01' })],
    ['no statement of what a count means', doc([outlet()], {}, { matches: '' })],
    ['no recorded query shape (the counts could not be re-run)', doc([outlet()], {}, { query_shape: undefined })],
  ];
  let ok = true;
  for (const [name, data] of cases) {
    const { failures } = verifyQuestionPress({ data, fileBytes: 100, bias, moments, now });
    if (failures.length === 0) {
      console.error(`::error::check-question-press --self-test: "${name}" was ACCEPTED by the gate`);
      ok = false;
    }
  }
  for (const [name, data] of driftCases) {
    const { failures, drift } = verifyQuestionPress({ data, fileBytes: 100, bias, moments, now });
    if (drift.length === 0) {
      console.error(`::error::check-question-press --self-test: drift "${name}" was not reported`);
      ok = false;
    }
    if (failures.length > 0) {
      console.error(`::error::check-question-press --self-test: drift "${name}" FAILED the gate (another file's change must only warn): ${failures[0]}`);
      ok = false;
    }
  }
  const good = doc([outlet(), outlet({ domain: 'npr.org', lean: 'center', articles: [{ url: 'https://www.npr.org/2026/09/24/x', seen: today }] })]);
  if (verifyQuestionPress({ data: good, fileBytes: 100, bias, moments, now }).failures.length > 0) {
    console.error('::error::check-question-press --self-test: a valid document was REJECTED by the gate');
    ok = false;
  }
  if (verifyQuestionPress({ data: { _meta: meta, questions: {} }, fileBytes: 100, bias, moments, now }).failures.length > 0) {
    console.error('::error::check-question-press --self-test: a valid EMPTY file was REJECTED by the gate');
    ok = false;
  }
  // The file is judged against the day it was written, never the wall clock:
  // the same valid file must still pass after midnight UTC and days later
  // (lateness is a warning — the owner's N8-A2 ruling — never a failure).
  for (const later of [86_400_000 + 1, 3 * 86_400_000, 30 * 86_400_000]) {
    const { failures } = verifyQuestionPress({ data: good, fileBytes: 100, bias, moments, now: now + later });
    if (failures.length > 0) {
      console.error(`::error::check-question-press --self-test: a valid document FAILED ${Math.round(later / 86_400_000)} day(s) after it was written: ${failures[0]}`);
      ok = false;
    }
  }
  if (!ok) process.exit(1);
  console.log('check-question-press --self-test passed');
  process.exit(0);
}

if (!existsSync(url(QUESTION_PRESS_PATH))) {
  console.log(`check-question-press: ${QUESTION_PRESS_PATH} does not exist yet — nothing to validate.`);
  process.exit(0);
}

const data = JSON.parse(readFileSync(url(QUESTION_PRESS_PATH), 'utf8'));
const bias = JSON.parse(readFileSync(url('data/media-bias.json'), 'utf8')).outlets ?? {};
const moments = JSON.parse(readFileSync(url('data/moments.json'), 'utf8'));
const { failures, drift, warnings, notes } = verifyQuestionPress({
  data,
  fileBytes: statSync(url(QUESTION_PRESS_PATH)).size,
  bias,
  moments,
});
for (const n of notes) console.log(`check-question-press: ${n}`);
// Drift is another data file's change, never damage here: it warns, and the
// GDELT collector's next run repairs it by itself.
for (const d of drift) console.warn(`::warning::check-question-press: ${d}`);
for (const w of warnings) console.warn(`::warning::check-question-press: ${w}`);
if (failures.length) {
  for (const f of failures) console.error(`::error::check-question-press: ${f}`);
  process.exit(1);
}
console.log(
  drift.length
    ? `check-question-press passed with ${drift.length} drift warning(s) — the file is undamaged, but data/moments.json or data/media-bias.json changed under it; the GDELT collector's next run repairs it.`
    : 'check-question-press passed — every counted outlet is AllSides-rated, every count is a stored link on that outlet, inside the week it claims, and the GDELT citation travels with the data.'
);

/*
 * THE SHORT-TITLES SAFETY NET: ONE SUMMARY LINE A NIGHT, AND FOUR CHECKS ON IT
 * (2026-11-17; the owner's card 194, Nov 15, 2026, option a: "One more round,
 * built the simpler way (a nightly summary line and a health-report alarm on
 * it), then a fifth check.").
 *
 * WHY. The event-based TROUBLE lines (scripts/sync-short-titles.mjs) catch
 * the causes someone thought of. This catches the rest by looking at the
 * STATE every night, whatever happened: how many bills have a short title,
 * how that compares with a week ago, when a bill was last read, how many lost
 * every title tonight. The fourth independent check's example: Congress.gov
 * renames its title type, every answer stays valid, nothing is refused, and
 * titled bills drain away a few a night under every event threshold.
 *
 * THE LINE. Every run of the step prints exactly one, through its single exit
 * helper, on every path (a crash prints what it knows, the rest `unknown`):
 *   SHORT TITLES SUMMARY: day=2026-11-17 outcome=done titled=1333 titled_7_nights_ago=1320 bills_7_nights_ago=3300
 *     bills=3322 newest_read_on=2026-11-17 retry=15 read_tonight=82 lost_all_titles_tonight=0
 * (one line; wrapped here). `titled` counts only bills still in data/bills.json.
 *
 * THE HISTORY: data/short-titles-trend.json, the last TREND_NIGHTS nights'
 * { day, titled, bills }. A file of its own (not inside the retry file, whose
 * entries are per bill and gated per bill), small and bounded, gated by
 * verifyShortTitlesTrend in scripts/verify-sync.mjs. A missing or damaged
 * history heals itself: the step starts it afresh and says so in one TROUBLE
 * line, and never stops for it.
 *
 * THE FOUR CHECKS (shortTitlesAlarms, read by lib/pipeline-health.mjs into
 * the daily health report; each has its own code and a runbook line):
 *   (a) short-titles-summary-missing: the nightly ran and its log has no
 *       summary line (the step was skipped, killed or crashed before printing).
 *   (b) short-titles-falling: bills with a short title fell, over 7 nights, by
 *       more than max(FALL_MIN, FALL_SHARE of last week's count), after
 *       allowing for bills that left the corpus. A bill should almost never
 *       lose EVERY short title: the record keeps listing a bill's earlier
 *       short titles (the "as introduced" one stays beside later ones), so a
 *       loss needs the record to withdraw them all. That rate was not
 *       measured on real nights (one read of 3,322 bills cannot show it); the
 *       renamed-title-type failure loses about 17 to 24 a night. 10, or 2% of
 *       ~1,300 titled bills (about 27), is crossed in two nights of that, and
 *       new bills keep adding titled bills in an ordinary week.
 *   (c) short-titles-lost-tonight: LOST_TONIGHT_ALARM (5) or more bills lost
 *       every short title in one night: the fast detector.
 *   (d) short-titles-not-read: the newest read is more than STALE_READ_DAYS (3)
 *       days older than the night's own day.
 * An ordinary night and the first fill (titled rising from 0) raise none;
 * tests/short-titles-summary.unit.spec.ts proves both.
 *
 * Pure and import-free, so the script, verify-sync, the health report and the
 * tests read the same rules.
 */

export const SHORT_TITLES_TREND_PATH = 'data/short-titles-trend.json';
export const TREND_NIGHTS = 14;
export const LOST_TONIGHT_ALARM = 5;
export const FALL_MIN = 10;
export const FALL_SHARE = 0.02;
export const STALE_READ_DAYS = 3;

const DAY_MS = 86_400_000;
/** The runbook line every alarm ends with. */
const RUNBOOK = ' What to do: docs/runbooks/new-congress-switch.md, section "The nightly summary line and the four state alarms"';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const slugOf = (b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);

/** Bills still in the corpus whose entry holds at least one short title. */
export function countTitled(file, bills) {
  let n = 0;
  for (const b of Array.isArray(bills) ? bills : []) {
    const e = file?.[slugOf(b)];
    if (e && Array.isArray(e.titles) && e.titles.length > 0) n++;
  }
  return n;
}

/** The newest `read_on` among the corpus's entries, or null. */
export function newestReadOn(file, bills) {
  let newest = null;
  for (const b of Array.isArray(bills) ? bills : []) {
    const d = file?.[slugOf(b)]?.read_on;
    if (typeof d === 'string' && DATE.test(d) && (newest === null || d > newest)) newest = d;
  }
  return newest;
}

/** The history with tonight's entry in it (replacing an earlier one for the same day), oldest first, at most TREND_NIGHTS. */
export function nextTrend(trend, entry) {
  const nights = (trend?.nights ?? []).filter((n) => n.day !== entry.day);
  nights.push({ day: entry.day, titled: entry.titled, bills: entry.bills });
  nights.sort((a, b) => (a.day < b.day ? -1 : 1));
  return { nights: nights.slice(-TREND_NIGHTS) };
}

/** The newest history entry at least `nights` days before `day`, or null. */
export function trendAgo(trend, day, nights = 7) {
  const limit = dayMs(day) - nights * DAY_MS;
  let best = null;
  for (const n of trend?.nights ?? []) {
    if (dayMs(n.day) <= limit && (best === null || n.day > best.day)) best = n;
  }
  return best;
}

/** The trend file as written. */
export function serializeTrend(trend) {
  return `${JSON.stringify({ nights: trend.nights }, null, 1)}\n`;
}

/**
 * THE GATE for data/short-titles-trend.json (hard rule 11): { nights: [...] },
 * at most TREND_NIGHTS entries, each exactly { day, titled, bills } with a
 * YYYY-MM-DD day and whole numbers, days strictly rising.
 */
export function verifyShortTitlesTrend({ data }) {
  const P = SHORT_TITLES_TREND_PATH;
  const failures = [];
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.nights) || Object.keys(data).join() !== 'nights') {
    return { failures: [`${P} is not { "nights": [...] }`] };
  }
  if (data.nights.length > TREND_NIGHTS) failures.push(`${P} holds ${data.nights.length} nights, more than ${TREND_NIGHTS}`);
  let last = '';
  for (const n of data.nights) {
    const ok =
      n && typeof n === 'object' && Object.keys(n).sort().join() === 'bills,day,titled' && typeof n.day === 'string' && DATE.test(n.day) &&
      Number.isInteger(n.titled) && n.titled >= 0 && Number.isInteger(n.bills) && n.bills >= 0 && n.titled <= n.bills;
    if (!ok) {
      failures.push(`${P}: an entry is not { day, titled, bills } with whole numbers`);
      continue;
    }
    if (n.day <= last) failures.push(`${P}: ${n.day} is not after ${last}`);
    last = n.day;
  }
  return { failures };
}

const FIELDS = ['day', 'outcome', 'titled', 'titled_7_nights_ago', 'bills_7_nights_ago', 'bills', 'newest_read_on', 'retry', 'read_tonight', 'lost_all_titles_tonight'];

/** The one summary line. Missing values print as `unknown`. */
export function summaryLine(s) {
  return `SHORT TITLES SUMMARY: ${FIELDS.map((f) => `${f}=${s?.[f] ?? 'unknown'}`).join(' ')}`;
}

/**
 * The LAST summary line in a log (Actions prefixes and colour codes allowed), parsed; null when there is none.
 * @returns {Record<string, any> | null}
 */
export function parseShortTitlesSummary(log) {
  const lines = String(log ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /SHORT TITLES SUMMARY: (.+)$/.exec(lines[i].replace(/\u001b\[[0-9;]*m/g, ''));
    if (!m) continue;
    const out = {};
    for (const part of m[1].trim().split(/\s+/)) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const k = part.slice(0, eq);
      const v = part.slice(eq + 1);
      out[k] = v === 'unknown' ? null : /^\d+$/.test(v) ? Number(v) : v;
    }
    return out;
  }
  return null;
}

/**
 * The four checks, in plain words a non-programmer can act on. `checked` says
 * whether a finished nightly's log was read at all (without one there is
 * nothing to judge, and nothing is claimed). `disable` lets a test switch one
 * check off to prove another fires on its own.
 * @param {Record<string, any> | null} summary
 * @param {{ checked?: boolean, disable?: string[] }} [opts]
 * @returns {Array<{ code: string, text: string }>}
 */
export function shortTitlesAlarms(summary, { checked = true, disable = [] } = {}) {
  const out = [];
  const on = (code) => !disable.includes(code);
  if (!checked) return out;
  if (!summary) {
    if (on('short-titles-summary-missing')) {
      out.push({
        code: 'short-titles-summary-missing',
        text: "the nightly ran but its short-titles step printed no summary line: the step was skipped, killed or crashed before it could report. Open the nightly's log at the step \"Read the record's short titles\" to see why." + RUNBOOK,
      });
    }
    return out;
  }
  const { titled, titled_7_nights_ago: ago, bills, bills_7_nights_ago: billsAgo, lost_all_titles_tonight: lost, newest_read_on: newest, day } = summary;
  if (on('short-titles-falling') && Number.isInteger(titled) && Number.isInteger(ago)) {
    const left = Number.isInteger(bills) && Number.isInteger(billsAgo) ? Math.max(0, billsAgo - bills) : 0;
    const fall = ago - titled - left;
    const limit = Math.max(FALL_MIN, Math.ceil(FALL_SHARE * ago));
    if (fall > limit) {
      out.push({
        code: 'short-titles-falling',
        text: `bills with a name address fell from ${ago} to ${titled} in a week (more than ${limit}), while bills almost never lose their short title: Congress.gov may have changed how it labels short titles. Open two of the bills named in the nightly log's "no longer gives a short title" warnings on Congress.gov and compare their titles.${RUNBOOK}`,
      });
    }
  }
  if (on('short-titles-lost-tonight') && Number.isInteger(lost) && lost >= LOST_TONIGHT_ALARM) {
    out.push({
      code: 'short-titles-lost-tonight',
      text: `${lost} bills lost every short title in one night (an alarm from ${LOST_TONIGHT_ALARM}), which the record almost never does: Congress.gov may have changed how it labels short titles. The nightly log names each bill in a "no longer gives a short title" warning; open two of them on Congress.gov.${RUNBOOK}`,
    });
  }
  if (on('short-titles-not-read') && typeof newest === 'string' && typeof day === 'string' && DATE.test(newest) && DATE.test(day)) {
    const age = Math.round((dayMs(day) - dayMs(newest)) / DAY_MS);
    if (age > STALE_READ_DAYS) {
      out.push({
        code: 'short-titles-not-read',
        text: `no bill's short titles have been read for ${age} days (an alarm after ${STALE_READ_DAYS}): the step is running but reading nothing. Look for "SHORT TITLES TROUBLE" lines in the last nightly logs.${RUNBOOK}`,
      });
    }
  }
  return out;
}

/**
 * The summary's state fields for a night that got as far as knowing what will
 * stand afterwards: the titles file and retry file as they stand after the
 * night (tonight's when written, else what was there), the history BEFORE
 * tonight's entry, tonight's reads and losses. The script and the tests both
 * build the line from this, so they cannot drift apart. Pure.
 */
export function nightSummary({ day, bills, titles, retry, trend, read, lost }) {
  const weekAgo = trendAgo(trend, day);
  return {
    day,
    titled: countTitled(titles ?? {}, bills),
    titled_7_nights_ago: weekAgo?.titled ?? null,
    bills_7_nights_ago: weekAgo?.bills ?? null,
    bills: Array.isArray(bills) ? bills.length : null,
    newest_read_on: newestReadOn(titles ?? {}, bills),
    retry: Object.keys(retry ?? {}).length,
    read_tonight: read,
    lost_all_titles_tonight: lost,
  };
}

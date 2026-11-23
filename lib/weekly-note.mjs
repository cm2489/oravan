/**
 * The weekly owner note — what it says, and nothing about how it is fetched
 * (scripts/weekly-note.mjs does the reading and the posting).
 *
 * WHY IT EXISTS. The owner's answer of 2026-11-23, 12:23 PM ET (card
 * `emails`, option a, his Report page): "One plain note every Monday at 9 AM
 * ET, and the robot threads go quiet". GitHub used to email him every robot
 * comment on #81 (Daily metrics), #242 (Pipeline health), #268 (Journey
 * corpus) and #398 (Scaffold corpus), and he read none of them. This note is
 * the one thing written for him: plain English, at most about a dozen lines,
 * the thing that needs him first.
 *
 * THE RULES IT KEEPS.
 *   - Rule 1: the repo is public, so the note carries aggregate counts only —
 *     page loads summed over a week and one site-wide estimate a day. Nothing
 *     about any visitor, page path or address.
 *   - No invented number. Every figure is one a source already holds; a source
 *     that could not be read says so in its own line ("couldn't be read"),
 *     never a zero. AI spend appears only when #242's body already prints it.
 *   - Rule 10: nothing here sees a secret.
 *
 * Import-free and clock-free (`now` is a parameter), so the unit suite loads it
 * directly.
 */

export const NOTE_LABEL = 'weekly-note';
export const NOTE_ASSIGNEE = 'cm2489';
export const HEALTH_ISSUE = 242;
/** How many "Needs you" lines the note shows before pointing at #242. */
export const MAX_NEEDS = 5;
/** How old a doctor's report can be and still speak for "Needs you". */
export const NEEDS_MAX_AGE_DAYS = 8;

const ET = 'America/New_York';

/** YYYY-MM-DD of `now` on the owner's clock (Eastern). */
export function easternDate(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The Monday on or before `now`, Eastern, as YYYY-MM-DD. */
export function mondayOf(now) {
  const day = easternDate(now);
  const d = new Date(`${day}T12:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7; // Mon 0 … Sun 6
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** "Nov 30" for 2026-11-30. */
export function shortDate(isoDay) {
  return new Date(`${isoDay}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
}

/** "Sun" for 2026-11-22. */
const weekday = (isoDay) => new Date(`${isoDay}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' });

export function noteTitle(now) {
  return `📬 Oravan this week — ${shortDate(mondayOf(now))}`;
}

const n = (x) => Number(x).toLocaleString('en-US');

/** Markdown emphasis and code ticks off, whitespace squashed: plain English. */
const plain = (s) => String(s).replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();

/** At most `max` characters, cut at a sentence end when one is close enough. */
function clip(s, max = 170) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '));
  return stop > max * 0.5 ? cut.slice(0, stop + 1) : `${cut.slice(0, max - 1).trimEnd()}…`;
}

const NOTHING = /^nothing(?: new| needs (?:you|colby))?(?: (?:today|this week))?\.?$/i;

/**
 * The top-level bullets under a "Needs Colby" heading, or null when the text
 * has no such heading. A heading may be "## 3. Needs Colby", "### Needs
 * Colby" or a bold line "**Needs Colby**". The list ends at the next heading
 * or rule. "Nothing new." and its kin are not a need.
 *
 * @param {string} markdown
 * @returns {string[] | null}
 */
export function needsColbyLines(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const at = lines.findIndex((l) => /^\s*(?:#{1,6}\s*(?:\d+[.)]\s*)?|\*\*)\s*needs colby\b/i.test(l));
  if (at === -1) return null;
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (/^\s*#{1,6}\s/.test(l) || /^\s*(?:---|\*\*\*|___)\s*$/.test(l) || /^\*\*[^*]+\*\*\s*$/.test(l.trim())) break;
    const bullet = /^[-*]\s+(.*)$/.exec(l); // top level only: no leading space
    if (!bullet) continue;
    const text = plain(bullet[1]);
    if (text && !NOTHING.test(text)) out.push(text);
  }
  return out;
}

/**
 * Where "Needs you" comes from. #242's body first (the daily-metrics job
 * rewrites it, and the heading would be read there if it ever carries one);
 * then the pipeline doctor's newest report on #242, which is where the
 * heading lives today ("## 3. Needs Colby"), provided it is under
 * NEEDS_MAX_AGE_DAYS old. Older than that, the note says it cannot tell,
 * rather than "nothing needs you" over a report nobody has written.
 *
 * @param {{ body: string | null, comments: Array<{ body: string, createdAt: string, url: string }> | null, now: Date }} src
 * @returns {{ status: 'ok', lines: string[], url: string | null } | { status: 'unread' } | { status: 'stale' }}
 */
export function pickNeeds({ body, comments, now }) {
  if (body == null && comments == null) return { status: 'unread' };
  const fromBody = body == null ? null : needsColbyLines(body);
  if (fromBody) return { status: 'ok', lines: fromBody, url: null };
  if (comments == null) return { status: 'unread' };
  const cutoff = now.getTime() - NEEDS_MAX_AGE_DAYS * 86_400_000;
  const newest = [...comments]
    .filter((c) => needsColbyLines(c.body) !== null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!newest || Date.parse(newest.createdAt) < cutoff) return { status: 'stale' };
  return { status: 'ok', lines: needsColbyLines(newest.body) ?? [], url: newest.url };
}

/** The "Needs you" block: the note's first line is always the answer. */
export function needsBlock(needs) {
  if (needs.status === 'unread') {
    return [`Needs you: couldn't be read this week (the pipeline report, #${HEALTH_ISSUE}, didn't answer).`];
  }
  if (needs.status === 'stale') {
    return [`Needs you: can't tell this week — the pipeline doctor hasn't written a report on #${HEALTH_ISSUE} in over a week.`];
  }
  if (!needs.lines.length) return ['Nothing needs you this week.'];
  const shown = needs.lines.slice(0, MAX_NEEDS).map((l) => `- ${clip(l)}`);
  const more = needs.lines.length - shown.length;
  const tail = more > 0 ? [`- …and ${more} more in the doctor's report.`] : [];
  const source = needs.url ? [`(From the pipeline doctor's latest report: ${needs.url})`] : [];
  return ['Needs you:', ...shown, ...tail, ...source];
}

/**
 * Visitors over the last 7 UTC days. Aggregates only (rule 1).
 *
 * @param {{ pageviews: { ok: boolean, total?: number }, distinct: Array<{ day: string, ok: boolean, count?: number | null }> }} v
 */
export function visitorsLine({ pageviews, distinct }) {
  const label = 'Visitors, last 7 days (bots included; a real-people count is coming):';
  const loads = pageviews.ok ? `${n(pageviews.total ?? 0)} page loads.` : "page loads couldn't be read.";
  const kept = distinct.filter((d) => d.ok && d.count != null);
  if (!pageviews.ok && !distinct.some((d) => d.ok)) {
    return `${label} couldn't be read this week (the counters database couldn't be reached).`;
  }
  let addresses;
  if (!distinct.some((d) => d.ok)) {
    addresses = "Different addresses a day couldn't be read.";
  } else if (!kept.length) {
    addresses = 'Different addresses a day: none on record (each day is kept for about 3 days).';
  } else {
    const days = kept.map((d) => `${weekday(d.day)} ${n(d.count)}`).join(' · ');
    const older = kept.length < distinct.length ? ' (older days are not kept)' : '';
    addresses = `Different addresses a day: ${days}${older}.`;
  }
  return `${label} ${loads} ${addresses}`;
}

/**
 * Of the last scheduled nightly runs (newest first, completed only), how many
 * succeeded.
 *
 * @param {Array<{ conclusion: string, createdAt: string }> | null} runs
 */
export function nightlyLine(runs) {
  if (runs == null) return "Nightly data: the run history couldn't be read.";
  const last = runs.slice(0, 7);
  if (!last.length) return 'Nightly data: no scheduled nightly run has finished yet.';
  const ok = last.filter((r) => r.conclusion === 'success').length;
  const bad = last.filter((r) => r.conclusion !== 'success').map((r) => shortDate(r.createdAt.slice(0, 10)));
  const misses = bad.length ? ` (didn't: ${bad.join(', ')})` : '';
  return `Nightly data: ${ok} of the last ${last.length} nightly runs worked${misses}.`;
}

/**
 * Open Big Question candidates: how many, and the newest three. Each is named
 * by its bill's title when the caller found one (`billTitle`), else by the
 * issue title with its fixed "Big Question candidate:" prefix dropped.
 *
 * @param {Array<{ number: number, title: string, createdAt: string, billTitle?: string | null }> | null} issues
 */
export function candidatesLine(issues) {
  if (issues == null) return "Big Question candidates waiting: couldn't be read.";
  if (!issues.length) return 'Big Question candidates waiting: none.';
  const newest = [...issues]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 3)
    .map((i) => `#${i.number} ${clip(plain(i.billTitle || String(i.title).replace(/^\s*big question candidate:\s*/i, '')), 60)}`);
  return `Big Question candidates waiting: ${issues.length}. Newest: ${newest.join(' · ')}`;
}

/**
 * AI spend, only as #242's body already prints it (scripts/pipeline-health.mjs
 * writes the row `spend (estimate)  ~$0.617-$0.659 today (…)`). The figure is
 * quoted, never rounded or re-estimated. No row, no line.
 *
 * @param {string | null} healthBody
 * @returns {string | null}
 */
export function spendLine(healthBody) {
  if (healthBody == null) return null;
  const row = /^spend \(estimate\)\s+(~\$\d+(?:\.\d+)?(?:-\$\d+(?:\.\d+)?)?) today\b/m.exec(healthBody);
  if (!row) return null;
  const stamp = /Last update: (\d{4}-\d{2}-\d{2})T/.exec(healthBody);
  const when = stamp ? ` in the 24 hours to ${shortDate(stamp[1])}` : ' on the last day it counted';
  return `AI spend: ${row[1]}${when} (the pipeline report's estimate; it leaves some calls out, so it is a floor, not the bill).`;
}

/**
 * The whole note body.
 *
 * @param {{ needs: ReturnType<typeof pickNeeds>, visitors: string, people: string | null, nightly: string, candidates: string, spend: string | null }} parts
 */
export function noteBody({ needs, visitors, people, nightly, candidates, spend }) {
  return [
    ...needsBlock(needs),
    '',
    visitors,
    ...(people ? [people] : []),
    nightly,
    candidates,
    ...(spend ? [spend] : []),
    '',
    `_One note a week. Last week's note is closed. Detail, if you ever want it: #${HEALTH_ISSUE}._`,
  ].join('\n');
}

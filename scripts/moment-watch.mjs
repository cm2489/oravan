/**
 * Moment watch — the delivery layer for the candidate shortlist
 * (owner decision, 2026-08-05).
 *
 *   node scripts/moment-watch.mjs --mode=push     # nightly: only NEWLY-qualifying bills
 *   node scripts/moment-watch.mjs --mode=weekly   # Monday: the full shortlist + what changed
 *   node scripts/moment-watch.mjs --mode=push --json
 *   node scripts/moment-watch.mjs --mode=push --commit-seen   # persist the seen-set
 *   node scripts/moment-watch.mjs --mode=weekly --now=2026-08-05T12:00:00Z
 *
 * WHY THIS EXISTS. scripts/moment-candidates.mjs has been a complete, correct
 * ranked report since it was written — and it was wired to nothing. It ran only
 * if someone remembered to type it, and nobody did, so 38 qualified candidates
 * sat unread while two Moments went stale (owner escalation, 2026-08-05). The
 * report was never the missing piece. Delivery was.
 *
 * ZERO NETWORK, ZERO AI, ZERO WRITES unless --commit-seen. Everything is
 * computed from files already in the repo, through moment-candidates.mjs's own
 * exported buildReport() — so this file can never disagree with the report the
 * owner reads. It adds exactly two things: a qualification FLOOR, and a memory
 * of what has already been shown.
 *
 * THE BOUNDARY IS INHERITED. moment-candidates.mjs prints STANDING_LINE on
 * every run — "This report never creates, proposes, or drafts a Moment." This
 * script re-prints it and honours it: the scaffold below carries only facts
 * copied from the official record (slug, status, dates, URLs). Every
 * user-facing sentence — name, summary, role — is left empty for the owner to
 * write, in both languages. That is what keeps `moments.howMadeBody` true.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReport, STANDING_LINE } from './moment-candidates.mjs';

const path = (p) => join(process.cwd(), p);
const read = (p) => JSON.parse(readFileSync(path(p), 'utf8'));

const SEEN_PATH = 'data/candidates-seen.json';

/*
 * ============================ THE FLOORS ============================
 *
 * A push notification is only worth anything if it is rare and it means
 * something. The candidate report itself has no floor — it ranks all 38
 * qualifying bills, which is right for a report you sit down to read and wrong
 * for something that pages you at 4am.
 *
 * These five gates are ANDed. Every one is here because its absence would
 * produce a specific kind of junk notification. They are deliberately in one
 * object so the owner can retune them without reading the rest of this file.
 */
export const FLOORS = {
  /* F1 — LEGISLATIVE MOTION IS IMMINENT.
     The single strongest signal, and the one an adversary cannot manufacture:
     a chamber has actually scheduled this. Committee-stage bills are the bulk
     of the corpus and almost never become a Big Question without moving first,
     so they belong in the weekly digest, not in a notification. */
  statuses: new Set(['floor_vote', 'passed_chamber']),
  requireFloorCalendarOrStatus: true,

  /* F2 — REAL CROSS-SPECTRUM ATTENTION, not one outlet's interest.
     `cross` already means two or more partisan-lean outlets covered it, which
     is the press bar's whole point. `neutral` is weaker — it only means "two or
     more outlets, none of them lean-rated" — so it needs volume to count.
     Three distinct outlets is the smallest number that isn't a coincidence. */
  minOutletsForNeutral: 3,

  /* F3 — CURRENCY.
     A bill can sit on a floor calendar for months without moving. Without this,
     the first run would page the owner about placements from last winter. 45
     days is a chamber's working month plus a recess. */
  maxLastActionAgeDays: 45,

  /* F4 — THERE IS SOMEWHERE TO PUT IT.
     The 6-live cap is the scarcity claim the whole feature rests on. Pushing a
     candidate the owner cannot act on trains him to ignore the notification,
     which is the only way this mechanism actually fails. When slots are full,
     candidates still surface in the weekly digest. */
  respectLiveCap: true,

  /* F5 — NEW.
     Enforced by the seen-set, not here. A bill that qualifies, drops out, and
     re-qualifies fires again on purpose: re-qualifying is itself news. */
};

const DAY_MS = 86_400_000;

/** Days between an ISO date (YYYY-MM-DD) and `now`. Infinity when unparseable,
 *  so a malformed date fails the currency floor rather than passing it. */
export function ageInDays(isoDate, now) {
  if (!isoDate) return Infinity;
  const t = Date.parse(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? Infinity : Math.floor((now - t) / DAY_MS);
}

/**
 * Does this candidate clear the notification bar?
 * @returns {{ pass: boolean, why: string[] }} `why` lists the FAILED gates, so a
 *          near-miss is explainable in the weekly digest instead of invisible.
 */
export function passesFloors(c, { now, openSlots }) {
  const why = [];

  if (FLOORS.requireFloorCalendarOrStatus && !c.floorCalendar && !FLOORS.statuses.has(c.status)) {
    why.push(`no floor-calendar placement and status is "${c.status}"`);
  }
  if (c.tier === 'cross') {
    // clears F2 by definition
  } else if (c.tier === 'neutral') {
    if ((c.outlets ?? 0) < FLOORS.minOutletsForNeutral) {
      why.push(`neutral coverage from only ${c.outlets ?? 0} outlet(s), need ${FLOORS.minOutletsForNeutral}`);
    }
  } else {
    why.push(`coverage tier "${c.tier}" is below the press bar`);
  }
  const age = ageInDays(c.lastActionDate, now);
  if (age > FLOORS.maxLastActionAgeDays) {
    why.push(`last action ${age === Infinity ? 'undated' : `${age} days ago`}, limit ${FLOORS.maxLastActionAgeDays}`);
  }
  if (FLOORS.respectLiveCap && openSlots <= 0) {
    why.push('no open Moment slots (6 live)');
  }

  return { pass: why.length === 0, why };
}

/** Previously-notified slugs. Missing file = first run, everything is new. */
export function readSeen() {
  if (!existsSync(path(SEEN_PATH))) return { slugs: [], _meta: {} };
  try {
    const raw = read(SEEN_PATH);
    return { slugs: Array.isArray(raw.slugs) ? raw.slugs : [], _meta: raw._meta ?? {} };
  } catch {
    return { slugs: [], _meta: {} };
  }
}

/** A paste-ready data/moments.json entry — FACTS ONLY.
 *  Every string a reader will see is left empty on purpose; see the header. */
export function scaffoldFor(c) {
  return {
    [`REPLACE-WITH-MOMENT-ID`]: {
      name: { en: '', es: '' },
      summary: { en: '', es: '' },
      aliases: [],
      category: '',
      vehicles: [
        {
          slug: c.slug,
          role: { en: '', es: '' },
          _record: c.url,
          _status_at_scaffold: c.status,
          _last_action_at_scaffold: c.lastActionDate,
        },
      ],
      qualifying_signal: `${c.tier} coverage across ${c.outlets} outlet(s)${c.floorCalendar ? `; on the ${c.floorChamber ?? ''} floor calendar`.trimEnd() : ''}`,
      opened: '',
      review_by: '',
      status: 'live',
      context_refs: [],
    },
  };
}

function renderCandidate(c) {
  const bits = [
    `**${c.citation} — \`${c.slug}\`**`,
    '',
    c.headline ? `${c.headline}` : '',
    '',
    `- status \`${c.status}\` · last action ${c.lastActionDate ?? 'undated'} · urgency ${c.urgency}`,
    `- coverage **${c.tier}** · ${c.outlets} outlet(s)${c.floorCalendar ? ` · **on the ${c.floorChamber ?? ''} floor calendar**`.replace('  ', ' ') : ''}`,
    `- ${c.url}`,
    '',
    '<details><summary>Paste-ready scaffold (facts only — you write every sentence)</summary>',
    '',
    '```json',
    JSON.stringify(scaffoldFor(c), null, 2),
    '```',
    '',
    '</details>',
  ];
  return bits.join('\n');
}

export function renderPush(newly, report) {
  const lines = [
    `## ${newly.length} new Big Question candidate${newly.length === 1 ? '' : 's'}`,
    '',
    `> ${STANDING_LINE}`,
    '',
    `Cleared the notification floor overnight. **${report.moments.openSlots} of 6 slots open.**`,
    '',
    '---',
    '',
  ];
  for (const c of newly) {
    lines.push(renderCandidate(c), '', '---', '');
  }
  lines.push(
    '',
    '### To decline',
    '',
    'Close this issue and append the reason to `docs/moment-rejections.json` — that file is the audit trail for "absence is a finding", and it is currently empty.',
  );
  return lines.join('\n');
}

export function renderWeekly(report, { newly, dropped, expiring, now }) {
  const passing = report.candidates
    .map((c) => ({ c, ...passesFloors(c, { now, openSlots: report.moments.openSlots }) }))
    .filter((r) => r.pass)
    .map((r) => r.c);

  const lines = [
    `# Moment review — week of ${new Date(now).toISOString().slice(0, 10)}`,
    '',
    `> ${STANDING_LINE}`,
    '',
    '## What changed',
    '',
    `- **${newly.length}** newly above the floor since last run`,
    `- **${dropped.length}** dropped below the floor`,
    `- **${report.moments.openSlots} of 6** Moment slots open`,
    `- **${expiring.length}** live Moment(s) with \`review_by\` inside 14 days`,
  ];

  if (expiring.length) {
    lines.push('', '### ⚠ Expiring');
    for (const m of expiring) {
      lines.push(`- \`${m.id}\` — review_by **${m.review_by}** (${m.days} day(s))`);
    }
  }

  lines.push('', `## Above the floor (${passing.length})`, '');
  if (!passing.length) {
    lines.push('_Nothing clears the notification floor this week. That is a finding, not a gap._');
  } else {
    for (const c of passing) lines.push(renderCandidate(c), '', '---', '');
  }

  lines.push(
    '',
    `## Below the floor (${report.candidates.length - passing.length})`,
    '',
    'Qualifying for the report but not worth a notification — listed so the floor stays auditable.',
    '',
  );
  for (const c of report.candidates) {
    const { pass, why } = passesFloors(c, { now, openSlots: report.moments.openSlots });
    if (pass) continue;
    lines.push(`- \`${c.slug}\` ${c.citation} — ${why.join('; ')}`);
  }

  lines.push(
    '',
    '## Tuning',
    '',
    `- corpus ${report.corpus.bills} bills, ${report.corpus.withCoverage} with stored coverage`,
    `- tier histogram: ${Object.entries(report.histogram).map(([k, v]) => `${k} ${v}`).join(' · ')}`,
    `- floors: floor-calendar-or-\`${[...FLOORS.statuses].join('\`/\`')}\`, neutral needs ≥${FLOORS.minOutletsForNeutral} outlets, last action ≤${FLOORS.maxLastActionAgeDays}d`,
    `- \`COVERAGE_TOP_N\` default is 600 with a ${Math.round((1 - 0.5) * 100)}/${Math.round(0.5 * 100)} urgency/least-recently-checked split`,
  );
  return lines.join('\n');
}

/** Live Moments whose review_by falls within `days`. */
export function expiringMoments(moments, now, days = 14) {
  const out = [];
  for (const [id, m] of Object.entries(moments)) {
    if (id.startsWith('_') || m?.status !== 'live' || !m?.review_by) continue;
    const remaining = Math.ceil((Date.parse(`${m.review_by}T00:00:00Z`) - now) / DAY_MS);
    if (Number.isFinite(remaining) && remaining <= days) out.push({ id, review_by: m.review_by, days: remaining });
  }
  return out.sort((a, b) => a.days - b.days);
}

function main(argv) {
  const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const has = (name) => argv.includes(`--${name}`);

  const mode = arg('mode') ?? 'push';
  if (mode !== 'push' && mode !== 'weekly') {
    console.error(`unknown --mode=${mode} (expected "push" or "weekly")`);
    process.exit(2);
  }
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();

  const bills = read('data/bills.json');
  const coverage = read('data/coverage.json');
  const moments = read('data/moments.json');
  const rejections = existsSync(path('docs/moment-rejections.json')) ? read('docs/moment-rejections.json') : [];

  const report = buildReport({ bills, coverage, moments, rejections, now });
  const openSlots = report.moments.openSlots;

  const qualifying = report.candidates.filter((c) => passesFloors(c, { now, openSlots }).pass);
  const qualifyingSlugs = qualifying.map((c) => c.slug);

  const seen = readSeen();
  const seenSet = new Set(seen.slugs);
  let newly = qualifying.filter((c) => !seenSet.has(c.slug));
  const dropped = seen.slugs.filter((s) => !qualifyingSlugs.includes(s));

  /* --only=<slug> narrows the push body to one candidate so the workflow can
     open one issue per candidate instead of N copies of the same digest. It
     deliberately does NOT re-check the seen-set: the caller already decided
     this slug is new, and re-deriving it here would make the loop's Nth issue
     depend on whether the 1st had committed yet. */
  const only = arg('only');
  if (only) {
    newly = qualifying.filter((c) => c.slug === only);
    if (!newly.length) {
      console.error(`--only=${only} is not currently above the floor`);
      process.exit(3);
    }
  }

  if (has('json')) {
    console.log(JSON.stringify({ mode, generated: new Date(now).toISOString(), openSlots, qualifying: qualifyingSlugs, newly: newly.map((c) => c.slug), dropped, expiring: expiringMoments(moments, now) }, null, 2));
  } else if (mode === 'push') {
    if (newly.length) console.log(renderPush(newly, report));
  } else {
    console.log(renderWeekly(report, { newly, dropped, expiring: expiringMoments(moments, now), now }));
  }

  /* The seen-set is only advanced when explicitly asked. A dry run must never
     mark candidates as delivered, or the very first accidental invocation
     silently swallows the backlog. */
  if (has('commit-seen')) {
    writeFileSync(
      path(SEEN_PATH),
      `${JSON.stringify({ _meta: { schema: 1, updated: new Date(now).toISOString(), note: 'Slugs already surfaced by scripts/moment-watch.mjs. Removing a slug re-notifies it.' }, slugs: qualifyingSlugs.sort() }, null, 2)}\n`
    );
  }

  // Consumed by .github/workflows/moment-watch.yml to decide whether to open an issue.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `new_count=${newly.length}\n`);
  }

  process.exitCode = 0;
}

if (process.argv[1]?.endsWith('moment-watch.mjs')) {
  main(process.argv.slice(2));
}

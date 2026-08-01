/**
 * Moment candidates — the read-only shortlist report (spec §7.4,
 * docs/ideation/2026-07-26-truth-first-repositioning.md).
 *
 *   node scripts/moment-candidates.mjs                    # ranked markdown
 *   node scripts/moment-candidates.mjs --json             # same run, machine-readable
 *   node scripts/moment-candidates.mjs --now=2026-07-31T12:00:00Z
 *
 * ZERO network, ZERO AI, ZERO writes. Every input is a file already in the
 * repo: data/bills.json, data/coverage.json, data/media-bias.json,
 * data/moments.json, and docs/moment-rejections.json (optional). The report
 * exists to give the owner a shortlist to READ — it is the valve for the
 * surplus the 6-live cap creates, and the boundary printed on every run
 * (STANDING_LINE below) is exactly what separates it from the automated
 * proposal system v1 deliberately never built.
 *
 * THE PRESS BAR — a bill is a candidate when all three hold:
 *   1. its coverage tier is `cross` or `neutral` (never `one_sided`, never
 *      `none`): the same rule the "In the news" lens uses, so partisan-only
 *      attention can't push a bill toward the front door;
 *   2. it is not already a vehicle in ANY data/moments.json entry — any
 *      status, live or retired, because a retired Moment's vehicle is a
 *      question the owner has already answered;
 *   3. its status is not terminal (lib/urgency.mjs TERMINAL_STATUSES): a
 *      signed law can't be un-signed by a phone call.
 *
 * THE RANKING — legislative proximity first (decision of record, 2026-07-31,
 * spec §9 decision 3). Floor-calendar placement, then effectiveUrgency, then
 * cross-spectrum breadth, and article volume STRICTLY last. Volume is the one
 * input an adversary can buy, and it is not even measurable today: stored
 * article counts are truncated by COVERAGE_PER_BILL, so every count printed
 * here is a floor, not a measurement. Proximity is measurable now, costs $0,
 * and cannot be manufactured by amplification.
 *
 * IMPORT-FREE COPIES — this file is .mjs and lib/coverage.ts is TypeScript, so
 * the tier logic is carried here by hand, the same discipline
 * scripts/check-moments.mjs uses for lib/moments-gate.mjs. Each copy names its
 * source of truth below, and tests/moment-candidates.unit.spec.ts pins the
 * copies against the real modules across the entire corpus — a drift makes
 * that test fail, not this report lie.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TERMINAL_STATUSES, effectiveUrgency } from '../lib/urgency.mjs';

/** Printed verbatim on every run, in both output modes. The boundary is the feature. */
export const STANDING_LINE =
  'This report never creates, proposes, or drafts a Moment. A Moment is hand-authored in both languages and exists only when the owner merges it.';

/**
 * The per-bill article cap that shaped data/coverage.json at sync time
 * (scripts/sync-coverage.mjs PER_BILL — same env var, same default, so the two
 * read the same number when someone overrides it).
 */
const COVERAGE_PER_BILL = Number(process.env.COVERAGE_PER_BILL ?? 5);

/** The live-Moment cap. Source of truth: lib/moments-gate.mjs (`liveCount > 6`). */
const LIVE_CAP = 6;

/*
 * Paths resolve from the working directory (run this from the repo root, like
 * scripts/hot-bills.mjs and scripts/sync-bills.mjs do) — NOT from
 * `import.meta.url`, which is how scripts/check-moments.mjs does it.
 *
 * The difference is deliberate and load-bearing: the Playwright runner
 * transpiles an imported .mjs to CJS, where `import.meta` cannot be
 * represented — the module dies on import with "exports is not defined in ES
 * module scope", taking the whole spec file with it. Since the point of this
 * file exporting its internals is that tests/moment-candidates.unit.spec.ts
 * can pin the copied coverage logic against lib/coverage.ts, the drift pin
 * wins over path independence.
 */
const path = (p) => join(process.cwd(), p);
const read = (p) => JSON.parse(readFileSync(path(p), 'utf8'));

/* ------------------------------------------------------------------ *
 * Import-free copy #1 — lib/coverage.ts normalizeSource / leanFor /
 * coverageTier. SOURCE OF TRUTH: lib/coverage.ts. Copied faithfully;
 * pinned by tests/moment-candidates.unit.spec.ts against every entry in
 * data/coverage.json. If you change the tier rule, change it there first.
 * ------------------------------------------------------------------ */

/** Reduce an API source to a bare lowercase domain: strip scheme, path, leading "www.". */
export function normalizeSource(source) {
  return (source ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

/** AllSides lean keyed by bare outlet domain (data/media-bias.json). */
const LEAN_BY_DOMAIN = read('data/media-bias.json').outlets;

/** Outlet lean from the AllSides table, or null when the outlet is unrated. */
export function leanFor(source) {
  return LEAN_BY_DOMAIN[normalizeSource(source)] ?? null;
}

/**
 * Classify a bill's coverage by how it spreads across the press:
 * `none` when fewer than two distinct outlets, `cross` when two or more
 * distinct partisan (left/right) leans are present, `one_sided` when exactly
 * one is, `neutral` otherwise.
 *
 * @param {{ source: string, lean: string | null }[]} articles
 */
export function coverageTier(articles) {
  const outlets = new Set(articles.map((a) => normalizeSource(a.source)));
  if (outlets.size < 2) return 'none'; // a single outlet isn't "how it's being covered"
  const partisan = new Set(articles.map((a) => a.lean).filter((l) => l === 'left' || l === 'right'));
  if (partisan.size >= 2) return 'cross';
  if (partisan.size === 1) return 'one_sided';
  return 'neutral';
}

/* ------------------------------------------------------------------ *
 * Import-free copy #2 — the amber gate's placed-on-calendar test.
 * SOURCE OF TRUTH: app/[locale]/bills/[id]/page.tsx `floorCalendarChamber`.
 * That regex is deliberately stricter than `status === "floor_vote"`
 * (253 bills carry the status; only the ones whose own last action says
 * Congress placed them on a calendar earn the claim), and this report
 * ranks on the same evidence the page is willing to print in amber.
 * Pinned by tests/moment-candidates.unit.spec.ts.
 * ------------------------------------------------------------------ */

/** @param {string | null} actionText @returns {'house' | 'senate' | null} */
export function floorCalendarChamber(actionText) {
  if (!actionText) return null;
  const match = /placed on (?:the )?(senate legislative|union|house|senate)\s+calendar/i.exec(
    actionText
  );
  if (!match) return null;
  return /senate/i.test(match[1]) ? 'senate' : 'house';
}

/**
 * The bill page's full gate, not just the regex: the calendar sentence earns
 * the claim, the date earns the amber, and the status has to still be
 * floor_vote (a bill that has since passed its chamber is no longer standing
 * on that calendar).
 */
function isOnFloorCalendar(bill) {
  return (
    bill.status === 'floor_vote' &&
    Boolean(bill.last_action_date) &&
    floorCalendarChamber(bill.last_action_text ?? null) !== null
  );
}

/* ------------------------------------------------------------------ *
 * Import-free copy #3 — display citation.
 * SOURCE OF TRUTH: lib/format.ts `formatCitation` / TYPE_LABELS.
 * Display only: a drift here misprints a label, it cannot change what
 * qualifies or how anything ranks.
 * ------------------------------------------------------------------ */
const TYPE_LABELS = {
  hr: 'H.R.',
  s: 'S.',
  hres: 'H.Res.',
  sres: 'S.Res.',
  hjres: 'H.J.Res.',
  sjres: 'S.J.Res.',
  hconres: 'H.Con.Res.',
  sconres: 'S.Con.Res.',
};

export function formatCitation(billType, billNumber) {
  return `${TYPE_LABELS[String(billType).toLowerCase()] ?? String(billType).toUpperCase()} ${billNumber}`;
}

/* ------------------------------------------------------------------ *
 * Ranking
 * ------------------------------------------------------------------ */

/** cross before neutral — the same order lib/coverage.ts's NEWS_TIER_RANK uses. */
const TIER_RANK = { cross: 0, neutral: 1 };

/**
 * The fields the ranking reads. A real candidate carries more (citation,
 * headline, link, dates); the comparator never looks at any of them.
 *
 * @typedef {{ slug: string, floorCalendar: boolean, urgency: number, tier: string, partisanLeans: number, outlets: number, articles: number }} RankInput
 */

/**
 * Proximity first, volume last. Slug is the final tiebreak so two otherwise
 * identical candidates never swap places between runs.
 *
 * @param {RankInput} a
 * @param {RankInput} b
 */
export function compareCandidates(a, b) {
  return (
    Number(b.floorCalendar) - Number(a.floorCalendar) ||
    b.urgency - a.urgency ||
    (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) ||
    b.partisanLeans - a.partisanLeans ||
    b.outlets - a.outlets ||
    b.articles - a.articles ||
    a.slug.localeCompare(b.slug)
  );
}

/** @template {RankInput} T @param {T[]} candidates @returns {T[]} */
export function rankCandidates(candidates) {
  return [...candidates].sort(compareCandidates);
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

/** Every bill slug named as a vehicle by any Moment, at any status. */
export function vehicleSlugs(moments) {
  const slugs = new Set();
  for (const moment of Object.values(moments ?? {})) {
    for (const vehicle of moment?.vehicles ?? []) {
      if (vehicle?.slug) slugs.add(vehicle.slug);
    }
  }
  return slugs;
}

/**
 * Build the candidate set + the counts that explain it. Pure over its inputs
 * so the unit suite can run it on fixtures.
 */
export function buildReport({ bills, coverage, moments, rejections, now }) {
  const vehicles = vehicleSlugs(moments);
  const histogram = { cross: 0, neutral: 0, one_sided: 0, none: 0 };
  const funnel = { covered: 0, tierQualified: 0, alreadyVehicle: 0, terminal: 0 };
  const candidates = [];

  for (const bill of bills) {
    const raw = coverage[bill.full_identifier];
    if (!Array.isArray(raw) || raw.length === 0) continue;
    funnel.covered++;

    const articles = raw.map((a) => ({ ...a, lean: leanFor(a.source) }));
    const tier = coverageTier(articles);
    histogram[tier] = (histogram[tier] ?? 0) + 1;
    if (tier !== 'cross' && tier !== 'neutral') continue;
    funnel.tierQualified++;

    if (vehicles.has(bill.full_identifier)) {
      funnel.alreadyVehicle++;
      continue;
    }
    if (TERMINAL_STATUSES.has(bill.status)) {
      funnel.terminal++;
      continue;
    }

    const outlets = new Set(articles.map((a) => normalizeSource(a.source)));
    const leans = new Set(articles.map((a) => a.lean ?? 'unrated'));
    const partisan = new Set(articles.map((a) => a.lean).filter((l) => l === 'left' || l === 'right'));

    candidates.push({
      slug: bill.full_identifier,
      citation: formatCitation(bill.bill_type, bill.bill_number),
      headline: bill.ai_headline ?? bill.short_title ?? bill.title,
      status: bill.status,
      lastActionDate: bill.last_action_date ?? null,
      floorCalendar: isOnFloorCalendar(bill),
      floorChamber: floorCalendarChamber(bill.last_action_text ?? null),
      urgency: effectiveUrgency(bill.status, bill.last_action_date ?? null, now),
      tier,
      outlets: outlets.size,
      leans: [...leans].sort(),
      partisanLeans: partisan.size,
      articles: articles.length,
      url: bill.congress_gov_url ?? null,
    });
  }

  const live = Object.values(moments ?? {}).filter((m) => m?.status === 'live').length;

  return {
    generated: new Date(now).toISOString(),
    standing_line: STANDING_LINE,
    corpus: { bills: bills.length, withCoverage: funnel.covered },
    moments: { live, cap: LIVE_CAP, openSlots: Math.max(0, LIVE_CAP - live) },
    histogram,
    funnel,
    article_count_cap: COVERAGE_PER_BILL,
    candidates: rankCandidates(candidates),
    rejections,
  };
}

/* ------------------------------------------------------------------ *
 * The rejection log — docs/moment-rejections.json, append-only, owner-edited
 * by PR. It lives in docs/ so nothing in the app can ever import it. See
 * docs/moment-rejections.md for the schema and why the file exists.
 * ------------------------------------------------------------------ */

const REJECTION_FIELDS = ['date', 'topic', 'why_no_vehicle', 'evidence', 'revisit_when'];

/**
 * Warn-lint only: a malformed rejection entry is a note the owner should fix,
 * never a reason to withhold the report. Returns warnings; the caller prints
 * them to stderr and carries on.
 */
export function lintRejections(entries) {
  const warnings = [];
  if (entries === null) return warnings; // file absent — the normal state until the first rejection
  if (!Array.isArray(entries)) {
    warnings.push('docs/moment-rejections.json is not a JSON array — nothing to report');
    return warnings;
  }
  entries.forEach((entry, i) => {
    const at = `docs/moment-rejections.json[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push(`${at}: expected an object with {${REJECTION_FIELDS.join(', ')}}`);
      return;
    }
    if (isMetadata(entry)) return; // "_"-prefixed keys are metadata (the data/coverage.json convention)
    for (const field of REJECTION_FIELDS) {
      const value = entry[field];
      if (field === 'evidence') {
        if (!Array.isArray(value)) warnings.push(`${at}.evidence: expected an array of sources`);
        else if (value.length === 0) warnings.push(`${at}.evidence: empty — a rejection is a finding, and a finding cites something`);
        continue;
      }
      if (typeof value !== 'string' || value.trim() === '') {
        warnings.push(`${at}.${field}: missing or empty`);
      }
    }
    if (typeof entry.date === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
      warnings.push(`${at}.date: "${entry.date}" — expected YYYY-MM-DD`);
    }
  });
  return warnings;
}

/** An object whose every key starts with "_" is metadata, not an entry. */
function isMetadata(entry) {
  const keys = Object.keys(entry);
  return keys.length > 0 && keys.every((k) => k.startsWith('_'));
}

/** Entries only — metadata objects dropped. */
export function rejectionEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.filter((e) => e && typeof e === 'object' && !Array.isArray(e) && !isMetadata(e));
}

/* ------------------------------------------------------------------ *
 * Markdown rendering
 * ------------------------------------------------------------------ */

const TIER_LABEL = { cross: 'cross-spectrum', neutral: 'neutral' };

export function renderMarkdown(report) {
  const { corpus, moments, histogram, funnel, candidates } = report;
  const day = report.generated.slice(0, 10);
  const out = [];

  out.push(`# Moment candidates — ${day}`);
  out.push('');
  out.push(`> ${STANDING_LINE}`);
  out.push('');
  out.push(`Run ${report.generated} · corpus ${corpus.bills} bills, ${corpus.withCoverage} with stored coverage.`);
  out.push(
    `Live Moments: **${moments.live} of ${moments.cap}** — ${moments.openSlots} open slot${moments.openSlots === 1 ? '' : 's'}. The cap is the scarcity claim; this report is the valve for the surplus, not a reason to raise it.`
  );
  out.push('');
  out.push('**The press bar** — coverage tier `cross` or `neutral`, never already a vehicle in any Moment (any status), status not terminal (`' + [...TERMINAL_STATUSES].sort().join('`, `') + '`).');
  out.push('');
  out.push('**The ranking** — legislative proximity first: floor-calendar placement → effective urgency → tier and cross-spectrum breadth → outlet count. Article count is the LAST tiebreak, and is capped at `COVERAGE_PER_BILL=' + report.article_count_cap + '` — a floor, not a measurement.');
  out.push('');

  out.push('## How the corpus narrows');
  out.push('');
  out.push(`| Stage | Bills |`);
  out.push(`| --- | ---: |`);
  out.push(`| With stored coverage | ${funnel.covered} |`);
  out.push(`| …tier \`cross\` or \`neutral\` | ${funnel.tierQualified} |`);
  out.push(`| …minus bills already a Moment vehicle | −${funnel.alreadyVehicle} |`);
  out.push(`| …minus terminal status | −${funnel.terminal} |`);
  out.push(`| **Candidates** | **${candidates.length}** |`);
  out.push('');
  out.push(
    `Tier histogram (all ${funnel.covered} covered bills): cross ${histogram.cross} · neutral ${histogram.neutral} · one_sided ${histogram.one_sided} · none ${histogram.none}.`
  );
  out.push('');

  const onCalendar = candidates.filter((c) => c.floorCalendar).length;
  out.push(`## Candidates (${candidates.length}${onCalendar ? `, ${onCalendar} on a floor calendar` : ''})`);
  out.push('');
  if (candidates.length === 0) {
    out.push('_No bill clears the press bar today. Absence is a finding: it is reported, not filled._');
    out.push('');
  }
  candidates.forEach((c, i) => {
    const chamber = c.floorChamber === 'senate' ? 'Senate' : 'House';
    const flag = c.floorCalendar ? ` · **on the ${chamber} floor calendar**` : '';
    out.push(`### ${i + 1}. ${c.citation} — \`${c.slug}\`${flag}`);
    out.push(`${c.headline}`);
    out.push('');
    out.push(`- status \`${c.status}\` · last action ${c.lastActionDate ?? 'undated'} · urgency ${c.urgency}`);
    out.push(
      `- coverage ${TIER_LABEL[c.tier] ?? c.tier} · ${c.outlets} outlet${c.outlets === 1 ? '' : 's'} · leans ${c.leans.join(', ')} · ${c.articles} article${c.articles === 1 ? '' : 's'} (capped at ${report.article_count_cap})`
    );
    if (c.url) out.push(`- ${c.url}`);
    out.push('');
  });

  const rejected = report.rejections.entries;
  out.push(`## Previously rejected — no legislative vehicle: ${rejected.length} topic${rejected.length === 1 ? '' : 's'}`);
  out.push('');
  if (rejected.length === 0) {
    out.push('_None logged yet. `docs/moment-rejections.json` records the topics that had real public attention and no bill to call about — a year of it is the evidence for the Feb 2027 re-scope decision._');
  } else {
    for (const r of rejected) {
      out.push(`- **${r.topic}** — ${r.date}: ${r.why_no_vehicle}`);
      if (Array.isArray(r.evidence) && r.evidence.length) out.push(`  - evidence: ${r.evidence.join(' · ')}`);
      if (r.revisit_when) out.push(`  - revisit when: ${r.revisit_when}`);
    }
  }
  out.push('');
  out.push(`> ${STANDING_LINE}`);
  out.push('');

  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function main(argv) {
  const asJson = argv.includes('--json');
  const nowArg = argv.find((a) => a.startsWith('--now='));
  let now = Date.now();
  if (nowArg) {
    const parsed = new Date(nowArg.slice('--now='.length)).getTime();
    if (!Number.isFinite(parsed)) {
      console.error(`moment-candidates: ${nowArg} is not a parseable date`);
      process.exit(2);
    }
    now = parsed;
  }

  const bills = read('data/bills.json');
  const coverage = read('data/coverage.json');
  const moments = read('data/moments.json');

  // docs/moment-rejections.json may not exist yet, and its absence is normal.
  const rejectionsPath = path('docs/moment-rejections.json');
  let rejectionsRaw = null;
  if (existsSync(rejectionsPath)) {
    try {
      rejectionsRaw = JSON.parse(readFileSync(rejectionsPath, 'utf8'));
    } catch (err) {
      console.warn(`::warning::moment-candidates: docs/moment-rejections.json is not valid JSON (${err.message}) — reporting zero rejections`);
    }
  }
  const warnings = lintRejections(rejectionsRaw);
  for (const w of warnings) console.warn(`::warning::moment-candidates: ${w}`);

  const report = buildReport({
    bills,
    coverage,
    moments,
    rejections: { entries: rejectionEntries(rejectionsRaw), warnings },
    now,
  });

  // stdout carries the report and nothing else; every warning went to stderr,
  // so `--json | jq` stays parseable however malformed the rejection log is.
  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : `${renderMarkdown(report)}\n`);
}

/*
 * Run-directly guard, written without `import.meta` for the reason given at
 * the top: argv[1] is this file when node executes it, and the Playwright CLI
 * when tests/moment-candidates.unit.spec.ts imports it.
 */
if (process.argv[1]?.endsWith('moment-candidates.mjs')) {
  main(process.argv.slice(2));
}

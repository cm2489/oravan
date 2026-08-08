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
 * ZERO NETWORK and ZERO WRITES unless --commit-seen; every candidate, every
 * floor, and every number is computed from files already in the repo, through
 * moment-candidates.mjs's own exported buildReport() — so this file can never
 * disagree with the report the owner reads. It adds exactly two things: a
 * qualification FLOOR, and a memory of what has already been shown.
 *
 * NOT ZERO AI, as of 2026-08-07 — and the boundary moved with it. The scaffold
 * used to leave every user-facing sentence empty under the banner "facts only
 * — you write every sentence". The owner's ruling: *"I want to review and edit
 * the writing and the choice of what goes up. I don't actually want to write
 * them."* So scripts/moment-draft.mjs now fills name, summary and role in both
 * languages from the record printed in the same issue, lint-gated before it is
 * offered, and this file labels the result as the unreviewed AI first draft it
 * is. What did NOT move: nothing here writes to data/moments.json, nothing
 * publishes, and a Big Question still exists only when the owner edits the
 * draft and merges it — which is what `moments.howMadeBody` describes, and is
 * now the whole of the owner's job rather than its last step.
 *
 * AND THE SCAFFOLD NOW MERGES. Drafting fixed the half of the scaffold only a
 * writer can fill and left the mechanical half exactly as the blank form had
 * it, so the finished-looking result still failed `node
 * scripts/check-moments.mjs` eight times over the moment it was pasted —
 * `aliases: []`, a free-text `qualifying_signal`, a blank category, two blank
 * dates, an empty `context_refs`, an uppercase id. scripts/moment-scaffold.mjs
 * derives those from the same record, emits the correct SHAPE with an empty
 * value for anything the record does not support, and prints why beside the
 * scaffold. Pasted verbatim the entry now passes with zero violations; with
 * drafting off its only failures are the six empty prose fields.
 *
 * moment-candidates.mjs's STANDING_LINE ("This report never creates, proposes,
 * or drafts a Moment") is still true of THAT report, which this file has not
 * touched — so it is still printed verbatim on any issue carrying a blank
 * scaffold. An issue carrying drafted prose prints DRAFT_STANDING_LINE
 * instead, because re-printing the old line over an AI draft would be a claim
 * this file had stopped honouring.
 *
 * SPEND. Drafting is the only thing here that costs money, and it happens ONLY
 * where a scaffold is actually rendered: --json spends nothing, --commit-seen
 * with --no-draft spends nothing, and a weekly digest with nothing above the
 * floor spends nothing. See the cost note in .github/workflows/moment-watch.yml.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReport, STANDING_LINE, leanFor, normalizeSource } from './moment-candidates.mjs';
import {
  DEFAULT_DRAFT_CAP,
  DRAFT_LABEL,
  DRAFT_MODEL,
  DRAFT_PROMPT_VERSION,
  blankDraft,
  draftAll,
  groundFor,
} from './moment-draft.mjs';
import { blankStructure, structureFor } from './moment-scaffold.mjs';

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

/**
 * The line printed above an issue whose scaffold carries drafted prose. The
 * inherited STANDING_LINE stays on blank ones — see the header for why the two
 * differ rather than one being softened to cover both.
 */
export const DRAFT_STANDING_LINE =
  'This issue proposes nothing and publishes nothing. The prose in the scaffold is an AI first draft written from the record printed with it; a Big Question exists only when the owner edits it and merges it.';

/**
 * A paste-ready data/moments.json entry — and PASTE-READY now means what it
 * says: pasted verbatim, this passes `node scripts/check-moments.mjs` with
 * zero violations (tests/moment-scaffold.unit.spec.ts proves it against the
 * real corpora), and with drafting off the only violations left are the six
 * empty prose fields.
 *
 * It used to fail the gate eight times over — `aliases: []` where an
 * `{ en, es }` pair of non-empty lists belongs, a free-text sentence where a
 * `{ type, refs }` object belongs, a blank category, two blank dates, an empty
 * `context_refs`, and an uppercase id. A scaffold that drafts the hard part and
 * then reds CI on the mechanical part is worse than blanks, because it looks
 * finished.
 *
 * The three prose slots carry the AI first draft when there is one and — on
 * every degrade path — the empty strings this scaffold has always shipped.
 * Everything else comes from `structure` (scripts/moment-scaffold.mjs), which
 * derives only what the record supports and leaves the rest correctly SHAPED
 * and empty, with the reason printed beside the scaffold.
 *
 * The `_`-prefixed vehicle keys are provenance for the reader, not schema: the
 * gate ignores unknown keys, so they survive a verbatim paste harmlessly and
 * can be deleted on the way past.
 */
export function scaffoldFor(c, draft = blankDraft(), structure = blankStructure()) {
  return {
    [structure.id]: {
      name: draft.name,
      summary: draft.summary,
      aliases: structure.aliases,
      category: structure.category,
      vehicles: [
        {
          slug: c.slug,
          role: draft.role,
          _record: c.url,
          _status_at_scaffold: c.status,
          _last_action_at_scaffold: c.lastActionDate,
        },
      ],
      qualifying_signal: structure.signal,
      opened: structure.opened,
      review_by: structure.review_by,
      status: 'live',
    },
  };
}

/**
 * The coverage rows one candidate's `press` signal could cite, reduced to what
 * scripts/moment-scaffold.mjs needs: the article URL, its outlet, and the
 * AllSides lean of that outlet. Both helpers come from
 * scripts/moment-candidates.mjs — the module whose copies of the coverage
 * logic the unit suite already pins against lib/coverage.ts — so the leans a
 * ref is chosen on are the same leans the tier was computed from.
 */
export function articlesFor(coverage, slug) {
  const raw = coverage?.[slug];
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => ({ url: a?.url, outlet: normalizeSource(a?.source), lean: leanFor(a?.source) }));
}

/**
 * One candidate's block: the record, then the scaffold.
 *
 * `ground` adds the two record lines the draft is allowed to lean on that the
 * issue did not previously print — the official title and the verbatim last
 * action. They are here because "every claim in a draft is traceable to the
 * record in the issue" is only checkable if the owner was handed the same
 * facts the model was (scripts/moment-draft.mjs recordLines is the one source
 * for both). `draft` defaults to blank, which renders exactly what this
 * function rendered before drafting existed.
 */
function renderCandidate(c, { ground = null, draft = blankDraft(), structure = blankStructure() } = {}) {
  const bits = [
    `**${c.citation} — \`${c.slug}\`**`,
    '',
    c.headline ? `${c.headline}` : '',
    '',
    ...(ground?.title ? [`- official title: ${ground.title}`] : []),
    `- status \`${c.status}\` · last action ${c.lastActionDate ?? 'undated'} · urgency ${c.urgency}`,
    ...(ground?.lastActionText ? [`- last action text: “${ground.lastActionText}”`] : []),
    `- coverage **${c.tier}** · ${c.outlets} outlet(s)${c.floorCalendar ? ` · **on the ${c.floorChamber ?? ''} floor calendar**`.replace('  ', ' ') : ''}`,
    `- ${c.url}`,
    /* The derived signal, printed as a RECORD LINE rather than left inside the
       JSON: `press` refs are article URLs the issue did not otherwise carry,
       and a ref nobody can see is not evidence. Deliberately not added to
       scripts/moment-draft.mjs's recordLines — that list is the closed record
       the model is grounded in, and news URLs are not something a draft may
       reason from. */
    `- qualifying signal: ${structure.signal.type ? `\`${structure.signal.type}\`` : '**not derivable from this record — see below**'}${structure.signal.refs.length ? `\n${structure.signal.refs.map((r) => `  - ${r}`).join('\n')}` : ''}`,
    '',
    ...(draft.drafted ? [DRAFT_LABEL, ''] : []),
    draft.drafted
      ? '<details><summary>Paste-ready scaffold (AI first draft — edit every sentence before merging)</summary>'
      : '<details><summary>Paste-ready scaffold (facts only — you write every sentence)</summary>',
    '',
    '```json',
    JSON.stringify(scaffoldFor(c, draft, structure), null, 2),
    '```',
    '',
    '</details>',
    ...(structure.notes.length ? ['', 'Before you merge this scaffold:', ...structure.notes.map((n) => `- ${n}`)] : []),
    ...(draft.notes.length ? ['', 'Drafting notes:', ...draft.notes.map((n) => `- ${n}`)] : []),
    ...(draft.drafted ? ['', `<sub>Drafted by \`${DRAFT_MODEL}\`, prompt v${DRAFT_PROMPT_VERSION}, from the record above. Lint-checked in both languages (forbidden vocabulary, speculation, asserted vote timing) before it was shown — that check is the only automated guarantee here; accuracy is yours.</sub>`] : []),
    ...(structure.gaps.length
      ? ['', `<sub>Pasted as-is this entry still fails \`check-moments\` on **${structure.gaps.join('**, **')}**${draft.drafted ? '' : ' — plus the empty prose, which is yours'}. Every other field is derived from the record above.</sub>`]
      : ['', `<sub>Every non-prose field above is derived from the record and passes \`node scripts/check-moments.mjs\` as written${draft.drafted ? '' : ' — the empty prose is what is left'}.</sub>`]),
  ];
  return bits.join('\n');
}

/** The blank-scaffold line stays the inherited one; a drafted issue says what
 *  it actually is. See DRAFT_STANDING_LINE. */
function standingLineFor(drafts) {
  return [...drafts.values()].some((d) => d.drafted) ? DRAFT_STANDING_LINE : STANDING_LINE;
}

/** The candidates a weekly digest renders a scaffold for — the ONE definition,
 *  so main() cannot draft a different set than renderWeekly() prints. */
export function passingCandidates(report, now) {
  return report.candidates.filter((c) => passesFloors(c, { now, openSlots: report.moments.openSlots }).pass);
}

export function renderPush(newly, report, { grounds = new Map(), drafts = new Map(), structures = new Map() } = {}) {
  const lines = [
    `## ${newly.length} new Big Question candidate${newly.length === 1 ? '' : 's'}`,
    '',
    `> ${standingLineFor(drafts)}`,
    '',
    `Cleared the notification floor overnight. **${report.moments.openSlots} of 6 slots open.**`,
    '',
    '---',
    '',
  ];
  for (const c of newly) {
    lines.push(renderCandidate(c, { ground: grounds.get(c.slug), draft: drafts.get(c.slug), structure: structures.get(c.slug) }), '', '---', '');
  }
  lines.push(
    '',
    '### To decline',
    '',
    'Close this issue and append the reason to `docs/moment-rejections.json` — that file is the audit trail for "absence is a finding", and it is currently empty.',
  );
  return lines.join('\n');
}

export function renderWeekly(report, { newly, dropped, expiring, now, grounds = new Map(), drafts = new Map(), structures = new Map() }) {
  const passing = passingCandidates(report, now);

  const lines = [
    `# Moment review — week of ${new Date(now).toISOString().slice(0, 10)}`,
    '',
    `> ${standingLineFor(drafts)}`,
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
    for (const c of passing) {
      lines.push(renderCandidate(c, { ground: grounds.get(c.slug), draft: drafts.get(c.slug), structure: structures.get(c.slug) }), '', '---', '');
    }
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

/**
 * The Anthropic client, or null. Null is a first-class outcome, not an error:
 * every caller degrades to the blank scaffold and the issue still opens.
 *
 * The import is DYNAMIC on purpose. This script and the moment-candidates.mjs
 * it wraps were stdlib-only, and the workflow that runs them installed no
 * dependencies for years; a checkout without node_modules must still deliver
 * the shortlist rather than crash on an import it may not need. Nothing is
 * imported and no client is constructed when there is no key, so the no-key
 * path costs nothing and touches nothing.
 */
async function anthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY unset — scaffolds ship blank (delivery never depends on the model)');
    return null;
  }
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    return new Anthropic({ maxRetries: 8 });
  } catch (e) {
    console.error(`@anthropic-ai/sdk unavailable (${e.message}) — scaffolds ship blank`);
    return null;
  }
}

async function main(argv) {
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

  /* ---------------------------------------------------------------------
   * Drafting. Bounded on three axes, in this order:
   *   WHAT   — only candidates whose scaffold this run actually renders, so
   *            --json and a nothing-above-the-floor weekly cost exactly $0.
   *   HOW MANY — MOMENT_DRAFT_CAP per run; the rest render blank with a note.
   *   WHETHER — --no-draft, and the absence of a key. Both degrade to blank.
   * The grounds map is built either way: its two extra record lines (official
   * title, verbatim last action) belong in the issue whether or not a draft
   * was written, because they are facts and they make the draft auditable.
   * --------------------------------------------------------------------- */
  const rendering = has('json') ? [] : mode === 'push' ? newly : passingCandidates(report, now);
  const bySlug = new Map(bills.map((b) => [b.full_identifier, b]));
  const statusPhrases = rendering.length
    ? { en: read('messages/en.json').bills?.status ?? {}, es: read('messages/es.json').bills?.status ?? {} }
    : null;
  const grounds = new Map(rendering.map((c) => [c.slug, groundFor(c, bySlug.get(c.slug), statusPhrases)]));
  const drafts = rendering.length && !has('no-draft')
    ? await draftAll(await anthropicClient(), [...grounds.values()], {
        cap: Number(process.env.MOMENT_DRAFT_CAP ?? DEFAULT_DRAFT_CAP),
      })
    : new Map();

  /* The structural half of the same scaffold — free, offline, and computed
     UNCONDITIONALLY wherever a scaffold renders, drafted or not. That is the
     honest-degradation property: with no key the entry is still schema-valid
     and its only failures are the six empty prose fields, so a blank scaffold
     asks the owner for sentences and nothing else.
     AFTER drafting, because the moment id is kebabed from the drafted name;
     with no draft it falls back to a placeholder that is still a valid slug. */
  const takenIds = new Set(Object.keys(moments));
  const structures = new Map(
    rendering.map((c) => [
      c.slug,
      structureFor(c, bySlug.get(c.slug), {
        now,
        articles: articlesFor(coverage, c.slug),
        takenIds,
        nameEn: drafts.get(c.slug)?.name?.en ?? '',
      }),
    ])
  );

  if (has('json')) {
    console.log(JSON.stringify({ mode, generated: new Date(now).toISOString(), openSlots, qualifying: qualifyingSlugs, newly: newly.map((c) => c.slug), dropped, expiring: expiringMoments(moments, now) }, null, 2));
  } else if (mode === 'push') {
    if (newly.length) console.log(renderPush(newly, report, { grounds, drafts, structures }));
  } else {
    console.log(renderWeekly(report, { newly, dropped, expiring: expiringMoments(moments, now), now, grounds, drafts, structures }));
  }

  /* The seen-set is only advanced when explicitly asked. A dry run must never
     mark candidates as delivered, or the very first accidental invocation
     silently swallows the backlog. */
  if (has('commit-seen')) {
    /* Only touch the file when the set itself moves: _meta.updated changes on
       every write, so an unconditional rewrite would hand the workflow a
       timestamp-only diff to commit — and therefore deploy — nightly. */
    const nextSlugs = [...qualifyingSlugs].sort();
    if (JSON.stringify(nextSlugs) !== JSON.stringify([...seen.slugs].sort())) {
      writeFileSync(
        path(SEEN_PATH),
        `${JSON.stringify({ _meta: { schema: 1, updated: new Date(now).toISOString(), note: 'Slugs already surfaced by scripts/moment-watch.mjs. Removing a slug re-notifies it.' }, slugs: nextSlugs }, null, 2)}\n`
      );
    }
  }

  // Consumed by .github/workflows/moment-watch.yml to decide whether to open an issue.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `new_count=${newly.length}\n`);
  }

  process.exitCode = 0;
}

if (process.argv[1]?.endsWith('moment-watch.mjs')) {
  /* main() is async only because drafting is. Every drafting failure is
     already handled inside scripts/moment-draft.mjs, so this catch is for the
     unexpected — and it still prints, rather than swallowing, because a
     watcher that fails silently is indistinguishable from a quiet night. */
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

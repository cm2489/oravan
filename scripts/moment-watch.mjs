/**
 * Moment watch — the delivery layer for the candidate shortlist
 * (owner decision, 2026-08-05).
 *
 *   node scripts/moment-watch.mjs --mode=push     # nightly: only NEWLY-qualifying bills
 *   node scripts/moment-watch.mjs --mode=weekly   # Monday: the full shortlist + what changed
 *   node scripts/moment-watch.mjs --mode=push --json
 *   node scripts/moment-watch.mjs --mode=push --commit-seen   # persist the seen-set
 *   node scripts/moment-watch.mjs --mode=push --commit-seen --filed=hr-1-119,s-2-119
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
 * THE MEMORY IS THE FRAGILE HALF, and both of its failures have now been
 * written down as invariants rather than patched (see seenSetAfter): a slug
 * enters the set only when its issue exists, and a slug LEAVES the set only on
 * genuine signal loss — never because all six Moment slots happened to be
 * full, which used to erase the file wholesale and re-fire every candidate the
 * day a slot reopened.
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
  DRAFT_FIELDS,
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

/**
 * The slugs a `--commit-seen` run is allowed to write.
 *
 * THE INVARIANT. A slug may enter the committed seen-set ONLY if its issue
 * actually exists — created by this run, or already open/closed from an
 * earlier one. Before this function existed the seen-set was simply
 * "everything above the floor", which is correct only when every issue got
 * filed.
 *
 * WHICH IS NOT THE INCIDENT, and the distinction matters. #167–#169 really did
 * re-file as #173–#175, but the cause was the untracked-file guard in
 * .github/workflows/moment-watch.yml — `git diff` exits 0 for a file git has
 * never seen — fixed in #176. What this function closes is the OTHER route to
 * the identical outcome, which #176 did not touch and which has not been
 * observed to fire: the issue loop ran `gh issue create` bare under `bash -e`,
 * so one failed call would kill the step, the commit step would never run, and
 * the next night would re-file every candidate — including the ones whose
 * issues had just been created. Same destination, different door.
 *
 * Committing "everything qualifying" after a partial loop would have been the
 * mirror-image bug: the failed candidate marked delivered and silently
 * dropped. Hence an invariant rather than a patch.
 *
 * So the arithmetic is exactly: hold back the slugs this run OWED an issue and
 * did not get one for; write everything else. Nothing more is held back, which
 * is what stops a filed issue from ever re-filing, and nothing less, which is
 * what stops a failed one from being swallowed.
 *
 * ---------------------------------------------------------------------------
 * THE SECOND INVARIANT: CAPACITY IS NOT FORGETTING (2026-08-09).
 *
 * The set used to be *replaced* by whatever qualified right now, and F4 —
 * respectLiveCap — zeroes "qualifying" the moment all six Moment slots are
 * full. Together those two say: **the night the owner fills the sixth slot,
 * the watcher forgets every candidate it has ever issued**, and the next time
 * a slot frees, all of them re-fire as new. Concretely, on the corpus this
 * shipped against: seen = [s-3172-119, s-4668-119, s-4784-119], candidates
 * hr-3633-119 and s-1525-119 above the floor; merge one Moment, slots fill,
 * the next run computes qualifying = [] and commits `slugs: []`. Three issues
 * the owner has already read come back the day a slot reopens.
 *
 * That is the same class of bug as the incident above — memory that fails
 * silently — reached from the opposite side, so it gets the same treatment: a
 * stated invariant rather than a patch.
 *
 *   A slug leaves the seen-set only on GENUINE SIGNAL LOSS. Having nowhere to
 *   put a candidate is a fact about US, not about the candidate, and it may
 *   never age a slug out.
 *
 * `withSignal` is the slug list that clears every floor EXCEPT the live-cap
 * one (slugsWithSignal below). A previously-seen slug is retained iff it is
 * still in that list; a slug that genuinely stopped qualifying — its placement
 * went stale, its coverage thinned, it became a Moment vehicle — still leaves,
 * which is F5 working as designed ("re-qualifying is itself news").
 *
 * A brand-new candidate seen for the first time on a slots-full night is
 * deliberately NOT added: it never qualified, so it was never owed an issue,
 * and adding it would mean it never fires at all once a slot opens.
 *
 * @param {object} args
 * @param {string[]} args.qualifying  every slug above the floor right now
 * @param {string[]} args.newly       the subset this run owed an issue
 * @param {string[]|null} [args.filed]  the subset whose issue is confirmed to
 *   exist. `null` — the flag absent — means the caller is not tracking
 *   per-candidate delivery, and every qualifying slug is written: the exact
 *   behaviour this script had before the flag, kept so a hand-run
 *   `--commit-seen` is unchanged.
 * @param {string[]} [args.seen]      the committed seen-set this run read
 * @param {string[]|null} [args.withSignal]  every slug clearing every floor
 *   except the live cap. `null` means the caller is not distinguishing
 *   capacity from signal, and nothing is retained — the pre-2026-08-09
 *   behaviour, kept only so a partial caller degrades to the old arithmetic
 *   instead of throwing. main() always passes it.
 * @returns {string[]} sorted, ready to write
 */
export function seenSetAfter({ qualifying, newly, filed = null, seen = [], withSignal = null }) {
  const stillHasSignal = withSignal === null ? null : new Set(withSignal);
  const retained = stillHasSignal === null ? [] : seen.filter((s) => stillHasSignal.has(s));
  const sorted = [...new Set([...qualifying, ...retained])].sort();
  if (filed === null) return sorted;
  const confirmed = new Set(filed);
  const held = new Set(newly.filter((s) => !confirmed.has(s)));
  return sorted.filter((s) => !held.has(s));
}

/**
 * Every slug that clears every floor EXCEPT F4, the live cap — "this still
 * looks like a Big Question, whether or not we have anywhere to put it".
 *
 * The ONE definition, so seenSetAfter's retention and the weekly digest's
 * "dropped below the floor" line can never disagree about what a drop is.
 * Infinity for openSlots rather than a flag on passesFloors: the cap gate is
 * literally `openSlots <= 0`, so an unbounded slot count is the honest way to
 * ask the question "would this pass if we had room?".
 */
export function slugsWithSignal(report, now) {
  return report.candidates
    .filter((c) => passesFloors(c, { now, openSlots: Number.POSITIVE_INFINITY }).pass)
    .map((c) => c.slug);
}

/**
 * The per-run drafting ceiling, from `MOMENT_DRAFT_CAP`.
 *
 * `Number(process.env.MOMENT_DRAFT_CAP ?? DEFAULT_DRAFT_CAP)` was a spend
 * ceiling that a typo silently removed. `Number('ten')` is NaN, and every
 * comparison against NaN is false, so `i >= cap` never fires and the cap is
 * GONE — an unbounded night of drafting calls on a workflow whose whole cost
 * story is "at most ten". The empty string is the mirror failure: `Number('')`
 * is 0, so `MOMENT_DRAFT_CAP=` in an env block quietly disables drafting
 * altogether and every scaffold ships blank with nobody told why. A ceiling
 * that can be removed by accident is not a ceiling.
 *
 * So: an unset or empty value means the default, any finite integer ≥ 0 is
 * honoured (0 included — "draft nothing tonight" is a legitimate instruction),
 * and anything else falls back to the default with a warning naming the value.
 * Never throws: this runs inside a job whose job is to deliver the shortlist.
 *
 * @param {string|undefined} raw
 * @returns {{ cap: number, warning: string | null }}
 */
export function resolveDraftCap(raw) {
  if (raw === undefined || String(raw).trim() === '') return { cap: DEFAULT_DRAFT_CAP, warning: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return {
      cap: DEFAULT_DRAFT_CAP,
      warning: `MOMENT_DRAFT_CAP=${JSON.stringify(String(raw))} is not a whole number ≥ 0 — falling back to ${DEFAULT_DRAFT_CAP}. (An unusable value used to remove the spend ceiling entirely: NaN loses every comparison.)`,
    };
  }
  return { cap: n, warning: null };
}

/**
 * The one sentence the push issue says about the rejection log — DERIVED, not
 * asserted. It read "and it is currently empty" on every issue this workflow
 * has ever opened, which stopped being true at PR #158 and stayed wrong
 * because nothing ever re-read the file. The log is the audit trail for
 * "absence is a finding"; an issue that misreports its size is telling the
 * owner that nobody is looking at it.
 *
 * @param {unknown} rejections  the parsed docs/moment-rejections.json (an
 *        array), or anything else — a malformed file says so rather than
 *        guessing a count.
 */
export function rejectionsSentence(rejections) {
  if (!Array.isArray(rejections)) {
    return 'that file is the audit trail for "absence is a finding" — it is not currently readable as a JSON array, which is worth a look on its own.';
  }
  if (rejections.length === 0) {
    return 'that file is the audit trail for "absence is a finding", and it is currently empty.';
  }
  return `that file is the audit trail for "absence is a finding", and it currently holds ${rejections.length} ${rejections.length === 1 ? 'entry' : 'entries'}.`;
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
 * Every rendered candidate's structural half, derived IN SEQUENCE so that one
 * run cannot hand out the same moment id twice.
 *
 * THE BUG THIS CLOSES. `takenIds` was a snapshot of `Object.keys(moments)`
 * taken once and never extended, so it only ever knew about ids already IN the
 * file. Two candidates in the same night — a House bill and its Senate
 * companion, which is the ordinary way a measure reaches the floor — draft to
 * the same bare name, kebab to the same id, and both scaffolds carried it with
 * no collision note on either issue. Pasting both into data/moments.json is
 * not an error: duplicate keys are legal JSON and the second silently REPLACES
 * the first, so one of the two Big Questions the owner just wrote would
 * disappear and every gate would pass.
 *
 * Two things fix it, and both are needed. Adding each id to `takenIds` as it
 * is assigned makes momentIdFor de-collide the SECOND one (it gets its vehicle
 * slug appended, exactly as a collision with the file does). Comparing the
 * pre-suffix `idBase` afterwards is what tells the FIRST one — which took the
 * bare id and would otherwise never learn anything happened — that it has a
 * twin. A collision is a fact about both candidates, and it is reported on
 * both issues, because they are read separately and days apart.
 *
 * WHAT THIS DOES NOT COVER, stated plainly rather than left to be discovered.
 * "One run" here means ONE PROCESS. The nightly workflow renders each issue in
 * its own invocation (`--only=<slug>`, one per candidate, so the loop opens one
 * issue per bill instead of N copies of a digest), and those processes cannot
 * see each other's drafted names: each reads data/moments.json as it stands,
 * which does not yet contain the id the previous issue proposed. So on the
 * NIGHTLY path two companion candidates can still both propose one id, and
 * neither issue will say so. This function fully covers the weekly digest and
 * any hand-run `--mode=push` without `--only`, which are the invocations that
 * render more than one scaffold at a time.
 *
 * Closing the nightly half needs the loop to carry the ids it has already
 * handed out from one invocation to the next — a new flag on this script and
 * matching plumbing in .github/workflows/moment-watch.yml — and even then the
 * FIRST issue can never carry the note, because it has already been filed by
 * the time the second is rendered. That is a design decision with a workflow
 * change in it, so it is the owner's call, not a silent extension of this fix.
 *
 * @param {Record<string, any>[]} rendering  candidates whose scaffold renders
 * @param {{ bySlug: Map<string, any>, coverage: Record<string, any>,
 *           drafts: Map<string, any>, now: number, takenIds: Set<string> }} args
 * @returns {Map<string, ReturnType<typeof structureFor>>} keyed by slug
 */
export function structuresFor(rendering, { bySlug, coverage, drafts = new Map(), now, takenIds = new Set() }) {
  const structures = new Map();
  /** idBase -> the slugs in THIS run that wanted it. */
  const wanted = new Map();

  for (const c of rendering) {
    const structure = structureFor(c, bySlug.get(c.slug), {
      now,
      articles: articlesFor(coverage, c.slug),
      takenIds,
      nameEn: drafts.get(c.slug)?.name?.en ?? '',
    });
    /* The id is claimed the moment it is handed out — not when it is merged.
       Nothing else in this run may derive it again. */
    takenIds.add(structure.id);
    structures.set(c.slug, structure);
    if (!wanted.has(structure.idBase)) wanted.set(structure.idBase, []);
    wanted.get(structure.idBase).push(c.slug);
  }

  for (const [idBase, slugs] of wanted) {
    if (slugs.length < 2) continue;
    for (const slug of slugs) {
      const others = slugs.filter((s) => s !== slug);
      structures.get(slug).notes.push(
        `**Another candidate in this same run drafted to the same id \`${idBase}\`** (${others.map((s) => `\`${s}\``).join(', ')}). ` +
          `Each has been given a distinct id — this one is \`${structures.get(slug).id}\` — but they are probably companion measures of one question: consider ONE Big Question with both as vehicles, rather than two. ` +
          'Pasting two entries under one key is not an error in JSON; the second silently replaces the first.',
      );
    }
  }

  return structures;
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
  /* PER FIELD, NOT PER DRAFT. `draft.drafted` is true when ANY of the three
     prose fields survived the lint, which is the right flag for "does this
     issue carry AI prose at all" and the wrong one for "is there prose left to
     write" — the footer used both. A run where the summary was blanked for
     forbidden vocabulary and name/role survived therefore printed "the empty
     prose is what is left" nowhere and read as finished, with two empty
     bilingual fields inside the fold. The drafting notes said so; the sentence
     under the scaffold contradicted them. */
  const blankProse = DRAFT_FIELDS.filter((f) => !(draft[f]?.en && draft[f]?.es));
  const allBlank = blankProse.length === DRAFT_FIELDS.length;
  const named = `**${blankProse.join('**, **')}** (both languages)`;
  /* The two footers differ because the sentences around them do: one lists
     what the entry still FAILS on, the other says the mechanical half is
     already clean. Both have to name the same blanks. */
  const gapTail = allBlank
    ? ' — plus the empty prose, which is yours'
    : blankProse.length
      ? ` — plus the still-empty ${named}, which ${blankProse.length === 1 ? 'is' : 'are'} yours`
      : '';
  const cleanTail = allBlank
    ? ' — the empty prose is what is left'
    : blankProse.length
      ? ` — the still-empty ${named} ${blankProse.length === 1 ? 'is' : 'are'} what is left`
      : '';
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
    draft.drafted && blankProse.length
      ? `<details><summary>Paste-ready scaffold (PARTIAL AI first draft — ${blankProse.join(', ')} came back blank; edit every sentence before merging)</summary>`
      : draft.drafted
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
      ? ['', `<sub>Pasted as-is this entry still fails \`check-moments\` on **${structure.gaps.join('**, **')}**${gapTail}. Every other field is derived from the record above.</sub>`]
      : ['', `<sub>Every non-prose field above is derived from the record and passes \`node scripts/check-moments.mjs\` as written${cleanTail}.</sub>`]),
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

export function renderPush(newly, report, { grounds = new Map(), drafts = new Map(), structures = new Map(), rejections = [] } = {}) {
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
    `Close this issue and append the reason to \`docs/moment-rejections.json\` — ${rejectionsSentence(rejections)}`,
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
  /* Captured BEFORE --only narrows `newly` below. The seen-set arithmetic at
     the bottom has to reason about every slug this run OWES an issue, not the
     one slug a render happened to be asked for — otherwise `--only` combined
     with `--commit-seen` would mark the other candidates delivered. */
  const newlySlugs = newly.map((c) => c.slug);
  /* Every slug that still LOOKS like a Big Question, whether or not there is a
     slot for it. Both the seen-set arithmetic and the digest's "dropped" line
     read this rather than `qualifyingSlugs`, because the live cap zeroes
     qualifying whenever all six slots are full — and "we have nowhere to put
     it" is not a candidate dropping below the floor. See seenSetAfter. */
  const withSignal = slugsWithSignal(report, now);
  const dropped = seen.slugs.filter((s) => !withSignal.includes(s));

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
  const { cap: draftCap, warning: capWarning } = resolveDraftCap(process.env.MOMENT_DRAFT_CAP);
  if (capWarning) console.error(`::warning::moment-watch: ${capWarning}`);
  const drafts = rendering.length && !has('no-draft')
    ? await draftAll(await anthropicClient(), [...grounds.values()], { cap: draftCap })
    : new Map();

  /* The structural half of the same scaffold — free, offline, and computed
     UNCONDITIONALLY wherever a scaffold renders, drafted or not. That is the
     honest-degradation property: with no key the entry is still schema-valid
     and its only failures are the six empty prose fields, so a blank scaffold
     asks the owner for sentences and nothing else.
     AFTER drafting, because the moment id is kebabed from the drafted name;
     with no draft it falls back to a placeholder that is still a valid slug. */
  const structures = structuresFor(rendering, {
    bySlug,
    coverage,
    drafts,
    now,
    takenIds: new Set(Object.keys(moments)),
  });

  if (has('json')) {
    console.log(JSON.stringify({ mode, generated: new Date(now).toISOString(), openSlots, qualifying: qualifyingSlugs, newly: newly.map((c) => c.slug), dropped, expiring: expiringMoments(moments, now) }, null, 2));
  } else if (mode === 'push') {
    if (newly.length) console.log(renderPush(newly, report, { grounds, drafts, structures, rejections }));
  } else {
    console.log(renderWeekly(report, { newly, dropped, expiring: expiringMoments(moments, now), now, grounds, drafts, structures }));
  }

  /* The seen-set is only advanced when explicitly asked. A dry run must never
     mark candidates as delivered, or the very first accidental invocation
     silently swallows the backlog. */
  if (has('commit-seen')) {
    /* --filed=<slug,slug,…> is the delivery receipt: the slugs whose issue the
       caller confirmed exists. Absent, every qualifying slug is written (the
       pre-2026-08-08 behaviour); present, a newly-qualifying slug missing from
       it is held back so the next run re-files it. `--filed=` with an EMPTY
       value is meaningful and distinct from omitting the flag — it says "the
       loop filed nothing", which is why this reads the raw arg rather than
       coalescing it. See seenSetAfter for the invariant and the incident. */
    const filedArg = arg('filed');
    const filed = filedArg === undefined ? null : filedArg.split(',').map((s) => s.trim()).filter(Boolean);
    const nextSlugs = seenSetAfter({
      qualifying: qualifyingSlugs,
      newly: newlySlugs,
      filed,
      seen: seen.slugs,
      withSignal,
    });
    const held = newlySlugs.filter((s) => !nextSlugs.includes(s));
    if (held.length) {
      console.error(`held out of the seen-set (no issue was filed, so they retry next run): ${held.join(', ')}`);
    }
    /* Loud, because it is the case that used to erase the file: everything the
       set remembers is being kept on signal alone, with no open slot to
       re-derive it from. */
    const retainedOnSignal = nextSlugs.filter((s) => !qualifyingSlugs.includes(s));
    if (retainedOnSignal.length) {
      console.error(
        `kept in the seen-set although nothing qualifies right now (no open Moment slot is not signal loss): ${retainedOnSignal.join(', ')}`,
      );
    }
    /* Only touch the file when the set itself moves: _meta.updated changes on
       every write, so an unconditional rewrite would hand the workflow a
       timestamp-only diff to commit — and therefore deploy — nightly. */
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

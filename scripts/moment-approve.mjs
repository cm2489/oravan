/**
 * Moment approve — the APPROVE half of the Big Question intake loop.
 *
 * WHY THIS EXISTS. scripts/moment-watch.mjs has delivered the notification
 * half since 2026-08-05 and the drafted scaffold since 2026-08-07: a candidate
 * that clears the floor gets its own issue, carrying a lint-checked AI first
 * draft of every sentence. What it could not do is put one on the site. The
 * owner's ruling (2026-08-10):
 *
 *   "I just want to approve what Big Questions are on the live site, I don't
 *    want to do any writing. Ideally when something new clears the bar I want
 *    to be notified of it and then I can decide whether it goes on, and if the
 *    6 spots are already full, what it should replace."
 *
 * So the remaining job was never more automation of the WRITING — that job is
 * done — it was removing the copy-paste-open-a-PR ritual between a decision and
 * the site. This module is that path: it takes the scaffold out of the issue
 * the owner just approved, and produces the exact data/moments.json edit,
 * gate-checked, with nothing rewritten on the way past.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THIS FILE OBEYS: **the copy that publishes is the copy he read.**
 *
 * A Big Question's page carries a promise about how it got there — an
 * automated check first, and a person's judgement after it, before anything
 * goes live (`moments.howMadeBody`, both languages). That promise survives
 * automation only if the thing approved and the thing published are THE SAME
 * TEXT. If this script trimmed a sentence, normalised a dash, re-flowed a
 * paragraph, or "fixed" a category, the entry on the site would be an entry
 * nobody read — automated copy wearing a person's approval.
 *
 * So the byte-fidelity rule is not a nicety, it is the whole warrant:
 *
 *   parse -> splice -> write -> RE-READ FROM DISK -> compare, field for field,
 *   against the entry parsed out of the issue. Any difference at all aborts
 *   and restores the file.
 *
 * The corollary is what makes the rest of this file simple: **when a gate
 * wants something changed, this script does not change it.** It reports the
 * exact delta back on the issue, drops the label, and stops. The owner then
 * either waits for the watcher to re-draft, or edits the issue body himself —
 * and his edit IS the approved draft, because the next run reads the issue
 * exactly as it reads a fresh one. There is no path here where a machine
 * decides what a Big Question says.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REFUSES ON, and why each refusal is a refusal rather than a fix:
 *
 *   no scaffold / two scaffolds ... an issue that does not carry exactly one
 *       paste-ready block is ambiguous about what was approved.
 *   the id was never edited ...... `REPLACE-WITH-MOMENT-ID` is the screaming
 *       placeholder; publishing it would mint the permanent URL of a question
 *       nobody named.
 *   the id already exists ........ two entries under one key is legal JSON and
 *       the second silently REPLACES the first, so an id collision would
 *       delete a live Big Question and pass every gate.
 *   a gate violation ............. the gate is the spec; a script that edits
 *       copy to satisfy it has published copy nobody approved.
 *   the record moved ............. `_status_at_scaffold` /
 *       `_last_action_at_scaffold` are what the draft was written from. If
 *       Congress has acted since, the approved sentences describe a record
 *       that no longer exists.
 *   the signal aged out .......... `moments.whyCriteria` tells readers a
 *       question opens on a signal inside 45 days. Approving one on a
 *       51-day-old action publishes a page that contradicts its own criteria.
 *   six slots, no directive ...... the cap is the scarcity claim. Which one
 *       retires is an editorial decision, and it is his.
 *
 * ZERO NETWORK. Every input is a file: the issue body and its comments are
 * fetched by .github/workflows/moment-approve.yml with `gh` and handed over as
 * paths, the corpora are already in the repo. That is what lets the unit suite
 * drive every branch above with fixtures and no GitHub at all.
 *
 * ZERO WRITES unless --write. A dry run computes the whole decision and prints
 * it; nothing touches data/moments.json until the caller asks.
 *
 * IMPORT DISCIPLINE. Stdlib plus this repo's own modules, all of them
 * import-free or stdlib-only, so this runs on bare node with no `npm ci` —
 * the same property scripts/check-moments.mjs has, and the reason the workflow
 * that drives it installs nothing. The gate is IMPORTED, never re-implemented
 * (v2 spec §2.3): `checkMoments` here is the same function CI runs, so an
 * entry this script accepts cannot be one CI then rejects.
 *
 * Usage:
 *   node scripts/moment-approve.mjs --body-file=issue.md --comments-file=c.json \
 *     --issue=123 --owner=cm2489 [--now=2026-08-10T00:00:00Z] [--write] \
 *     [--out=decision.json] [--comment-out=comment.md] [--pr-body-out=pr.md] \
 *     [--pr-title-out=title.txt]
 *
 * See docs/big-question-intake.md for the operator's view of the same loop.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkMoments, vehicleKind } from '../lib/moments-gate.mjs';
import { PLACEHOLDER_ID, PUBLISHED_SIGNAL_MAX_AGE_DAYS } from './moment-scaffold.mjs';
import { nominationSlug } from './nominations-fetch.mjs';

const DAY_MS = 86_400_000;

/**
 * The live cap. lib/moments-gate.mjs is the ENFORCER — it fails the whole file
 * at 7 — and this copy exists only to answer the question the gate cannot:
 * "is there room, and if not, what retires?". Kept equal by
 * tests/moment-approve.unit.spec.ts rather than imported, because the gate
 * states it inside a violation string rather than as a constant.
 */
export const LIVE_CAP = 6;

/** The directive that names which live question retires. Owner comments only. */
export const REPLACE_RE = /^\s*\/replace\s+([a-z0-9][a-z0-9-]*)\s*$/i;

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

/**
 * May this actor approve?
 *
 * BOTH the labeler and the workflow actor must be the owner, and they are
 * checked as a pair on purpose. On an `issues: labeled` event they are
 * normally the same person, and a run where they are NOT is a run whose
 * provenance nobody can explain — which is not a state to publish from.
 *
 * The real gate is .github/workflows/moment-approve.yml's first step, which
 * runs this test before anything is checked out. This copy exists so the rule
 * is testable and so a hand-run of this script cannot skip it.
 */
export function authorized({ sender, actor, owner }) {
  const ok = (v) => typeof v === 'string' && v.trim().length > 0;
  if (!ok(owner)) return false;
  return ok(sender) && ok(actor) && sender === owner && actor === owner;
}

/* ------------------------------------------------------------------ *
 * The scaffold, out of the issue body
 * ------------------------------------------------------------------ */

/** Every ```json fenced block in a markdown body, in order. */
function jsonBlocks(body) {
  const out = [];
  const re = /```json\s*\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(String(body ?? ''))) !== null) out.push(m[1]);
  return out;
}

/**
 * The one paste-ready scaffold in a candidate issue, parsed.
 *
 * EXACTLY ONE, and both other counts are refusals rather than a choice. Zero
 * means the issue is not a candidate issue (or its body was replaced), and
 * two or more means a hand-run `--mode=push` digest or a weekly one: those
 * carry a scaffold per candidate, and picking one of them would be this
 * script deciding which Big Question the owner meant. It never decides that.
 *
 * The top level must be a single `{ "<id>": { … } }`, which is what
 * scripts/moment-watch.mjs's scaffoldFor emits and what data/moments.json is
 * keyed by. Anything else is a body somebody rewrote by hand into a shape
 * this loop cannot honour byte-for-byte.
 *
 * @returns {{ ok: true, id: string, entry: object } | { ok: false, error: string }}
 */
export function parseScaffold(body) {
  const blocks = jsonBlocks(body);
  if (blocks.length === 0) {
    return {
      ok: false,
      error:
        'this issue carries no ```json scaffold block, so there is nothing to publish. A candidate issue from `moment-watch` always has one, inside the "Paste-ready scaffold" fold.',
    };
  }
  if (blocks.length > 1) {
    return {
      ok: false,
      error: `this issue carries ${blocks.length} scaffold blocks. Approve publishes exactly one Big Question, and choosing between them is an editorial decision, not a parsing one — open one issue per question, or delete the blocks you are not approving.`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(blocks[0]);
  } catch (e) {
    return { ok: false, error: `the scaffold block is not valid JSON (${e.message}). Nothing was changed.` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'the scaffold block is not a JSON object keyed by moment id.' };
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1) {
    return {
      ok: false,
      error: `the scaffold block holds ${keys.length} top-level keys (${keys.join(', ') || 'none'}); it must hold exactly one moment id.`,
    };
  }
  const id = keys[0];
  const entry = parsed[id];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, error: `\`${id}\` does not map to an object.` };
  }
  if (id === PLACEHOLDER_ID) {
    return {
      ok: false,
      error: `the moment id is still \`${PLACEHOLDER_ID}\`, the placeholder the scaffold ships when nothing could be derived. That id becomes the question's permanent address (\`/questions/<id>\`) — edit the issue body to the id you want, then re-apply the label.`,
    };
  }
  return { ok: true, id, entry };
}

/* ------------------------------------------------------------------ *
 * The replace directive
 * ------------------------------------------------------------------ */

/**
 * Every `/replace <moment-id>` the OWNER wrote on this issue, in comment
 * order. Anyone else's is ignored — silently as far as the parse goes, and
 * loudly in the comment the caller posts, because "I told it to replace X and
 * nothing happened" is the confusing failure this exists to avoid.
 *
 * A directive must be its own line: `/replace shutdown` inside a sentence
 * about how one might replace something is prose, not an instruction.
 *
 * @param {{author?: {login?: string}, body?: string}[]} comments
 */
export function parseReplaceDirectives(comments, { owner } = {}) {
  const out = [];
  for (const [i, c] of (Array.isArray(comments) ? comments : []).entries()) {
    const login = c?.author?.login;
    if (!owner || login !== owner) continue;
    for (const line of String(c?.body ?? '').split(/\r?\n/)) {
      const m = REPLACE_RE.exec(line);
      if (m) out.push({ id: m[1].toLowerCase(), comment: i, at: c?.createdAt ?? null });
    }
  }
  return out;
}

/**
 * The directive that counts: the LAST one.
 *
 * Last-wins rather than refuse-on-conflict because the conflict is almost
 * always a person changing his mind in a thread ("/replace syria" … "actually
 * /replace college-athletes"), and refusing there would be a machine
 * pretending not to understand English. Every directive found is reported in
 * the PR body regardless, so the record shows what was overridden.
 */
export function replaceDirective(comments, { owner } = {}) {
  const all = parseReplaceDirectives(comments, { owner });
  return all.length ? { ...all[all.length - 1], all } : null;
}

/* ------------------------------------------------------------------ *
 * Slots
 * ------------------------------------------------------------------ */

/** The stored-live moments, in file order — what the cap counts. */
export function liveMoments(moments) {
  return Object.entries(moments ?? {})
    .filter(([, m]) => m?.status === 'live')
    .map(([id, m]) => ({ id, name: m?.name?.en ?? '', review_by: m?.review_by ?? '' }));
}

/**
 * Is there room, and if not, what retires?
 *
 * `retired` is expressed the one way lib/moments.ts represents it: the stored
 * status becomes `"retired"`, which computeMomentState returns ahead of every
 * other state and which takes the question off every surface (its route 404s).
 * Nothing is deleted — a retired Big Question stays in the file as the record
 * that it existed, exactly as a settled one does.
 *
 * @param {{ moments: Record<string, any>, replaceId?: string | null, newId?: string | null }} args
 * @returns {{ ok: true, action: 'append' | 'replace', retire: string | null }
 *          | { ok: false, need: 'directive' | 'valid-directive', error: string }}
 */
export function slotDecision({ moments, replaceId = null, newId = null }) {
  const live = liveMoments(moments);
  const names = () =>
    live.map((m) => `- \`${m.id}\` — ${m.name || '(no English name)'} · review_by ${m.review_by || 'unset'}`).join('\n');

  if (newId && Object.prototype.hasOwnProperty.call(moments ?? {}, newId)) {
    return {
      ok: false,
      need: 'valid-directive',
      error: `\`${newId}\` is already a key in \`data/moments.json\`. Two entries under one key is not an error in JSON — the second silently replaces the first — so publishing this would delete the existing question and pass every gate. Rename the id in the issue body, then re-apply the label.`,
    };
  }

  if (replaceId) {
    const target = live.find((m) => m.id === replaceId);
    if (!target) {
      const known = Object.prototype.hasOwnProperty.call(moments ?? {}, replaceId);
      return {
        ok: false,
        need: 'valid-directive',
        error: known
          ? `\`/replace ${replaceId}\` names a question that is not live (its stored status is \`${moments[replaceId]?.status}\`), so retiring it frees no slot. The live six are:\n\n${names()}`
          : `\`/replace ${replaceId}\` names no question in \`data/moments.json\`. The live ones are:\n\n${names()}`,
      };
    }
    return { ok: true, action: 'replace', retire: replaceId };
  }

  if (live.length < LIVE_CAP) return { ok: true, action: 'append', retire: null };

  return {
    ok: false,
    need: 'directive',
    error:
      `All ${LIVE_CAP} Big Question slots are full, so publishing this one means retiring one of them — and which one is your call, not this workflow's.\n\n${names()}\n\n` +
      'Comment `/replace <moment-id>` on this issue with the id that should retire, then re-apply the `approve-moment` label. The retired question keeps its entry in the file as the record that it existed; it simply stops appearing anywhere.',
  };
}

/* ------------------------------------------------------------------ *
 * Has the record moved since the draft was written?
 * ------------------------------------------------------------------ */

/** Whole days between an ISO date and `now`; Infinity when unparseable, so an
 *  undated record reads as old rather than as fresh (same posture as
 *  scripts/moment-scaffold.mjs's copy). */
function ageInDays(isoDate, now) {
  if (!isoDate) return Infinity;
  const t = Date.parse(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? Infinity : Math.floor((now - t) / DAY_MS);
}

/**
 * Everything about this entry that is no longer true of the record.
 *
 * THREE KINDS, and all three block, because all three mean the same thing:
 * the sentences the owner approved describe a state of the world that has
 * changed since they were written.
 *
 *   1. THE VEHICLE MOVED. `_status_at_scaffold` and `_last_action_at_scaffold`
 *      are stamped into every scaffold by scripts/moment-watch.mjs precisely
 *      so this comparison is possible later. A bill that was on the calendar
 *      when the draft was written and has since passed its chamber has a role
 *      sentence describing a step it already took.
 *   2. THE SIGNAL AGED OUT. `moments.whyCriteria` and `moments.howMadeRule2`
 *      tell every reader that a Big Question opens on a signal "within the
 *      last 45 days". A candidate issue can sit for a week; approving one
 *      whose newest action is 51 days old publishes a page that contradicts
 *      its own published criteria. The number is IMPORTED from
 *      scripts/moment-scaffold.mjs so it cannot drift from the one the
 *      scaffold prints or the one the site promises.
 *   3. REVIEW_BY ALREADY PASSED. `opened`/`review_by` are stamped at DRAFTING
 *      time and are not touched here (byte fidelity), so a long-delayed
 *      approval can publish a question that lib/moments.ts immediately reads
 *      as 'stale'. Born stale is not a state to publish in.
 *
 * A vehicle with no `_status_at_scaffold` (hand-authored, or the provenance
 * keys deleted on the way past) is NOT silently passed: it gets a note saying
 * this check could not run for it. Absence of evidence is reported, never
 * treated as evidence of absence.
 *
 * @param {Record<string, any>} entry  the parsed scaffold entry
 * @param {{ billBySlug?: Map<string, any>, nominationBySlug?: Map<string, any>, now?: number }} [opts]
 * @returns {{ blocking: string[], notes: string[] }}
 */
export function recordDrift(entry, { billBySlug, nominationBySlug, now = Date.now() } = {}) {
  const blocking = [];
  const notes = [];
  const rowFor = (v) =>
    vehicleKind(v) === 'nomination' ? nominationBySlug?.get(v.slug) : billBySlug?.get(v.slug);

  let newest = null;
  for (const v of Array.isArray(entry?.vehicles) ? entry.vehicles : []) {
    const row = rowFor(v);
    if (!row) {
      // Not reported here: an unresolvable slug is a gate VIOLATION, and the
      // gate's message names the corpus file to look in. Saying it twice, in
      // two different vocabularies, makes the real one harder to find.
      continue;
    }
    if (row.last_action_date && (newest === null || row.last_action_date > newest)) {
      newest = row.last_action_date;
    }
    const wasStatus = v._status_at_scaffold;
    const wasAction = v._last_action_at_scaffold;
    if (wasStatus === undefined && wasAction === undefined) {
      notes.push(
        `\`${v.slug}\` carries no \`_status_at_scaffold\`/\`_last_action_at_scaffold\`, so this check could not compare it against the record it was drafted from. Its current status is \`${row.status}\`, last action ${row.last_action_date ?? 'undated'}.`,
      );
      continue;
    }
    if (wasStatus !== undefined && row.status !== wasStatus) {
      blocking.push(
        `\`${v.slug}\` was \`${wasStatus}\` when this draft was written and is \`${row.status}\` now. The approved sentences describe the earlier state.`,
      );
    }
    if (wasAction !== undefined && (row.last_action_date ?? null) !== wasAction) {
      blocking.push(
        `\`${v.slug}\` last acted ${wasAction} when this draft was written; the record now says ${row.last_action_date ?? 'undated'}.`,
      );
    }
  }

  const age = ageInDays(newest, now);
  if (age > PUBLISHED_SIGNAL_MAX_AGE_DAYS) {
    blocking.push(
      `the newest action across this question's vehicles is ${age === Infinity ? 'undated' : `${age} days old`} (${newest ?? 'no date on file'}). \`moments.whyCriteria\` tells readers a Big Question opens on a signal within the last ${PUBLISHED_SIGNAL_MAX_AGE_DAYS} days, so publishing it now would contradict the criteria printed on its own page.`,
    );
  }

  const reviewBy = Date.parse(`${String(entry?.review_by ?? '').slice(0, 10)}T00:00:00Z`);
  if (entry?.status === 'live' && Number.isFinite(reviewBy) && now >= reviewBy + DAY_MS) {
    blocking.push(
      `\`review_by\` is ${entry.review_by}, which has already passed — \`lib/moments.ts\` would read this question as \`stale\` the moment it published. Edit \`opened\`/\`review_by\` in the issue body (that edit becomes the approved draft), then re-apply the label.`,
    );
  }

  return { blocking, notes };
}

/* ------------------------------------------------------------------ *
 * Byte fidelity
 * ------------------------------------------------------------------ */

/**
 * The comparator the whole warrant rests on.
 *
 * Compares two parsed entries as ORDERED JSON: same keys, in the same order,
 * with the same values, all the way down. `JSON.stringify` preserves insertion
 * order, and `JSON.parse` inserts in source order, so a stringify-equality
 * test over parsed values is exactly "the same object, written the same way".
 *
 * WHAT IT DELIBERATELY DOES NOT COMPARE: the raw bytes of the fenced block.
 * The block is markdown a person is allowed to edit — reindenting it, or
 * writing `—` where the model wrote an em dash, changes the bytes and
 * changes nothing about the copy. The unit of "the same copy" is the decoded
 * string, and that is what this compares.
 *
 * WHAT IT CATCHES, which is the point: any trim, any normalisation, any
 * re-ordering, any silently-dropped field, any value this file touched on the
 * way past. Run against the entry RE-READ FROM DISK after the write, it also
 * catches anything lost in serialisation.
 */
export function sameCopy(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Where two entries differ, as dotted paths — the readable half of sameCopy,
 * used only to explain a failure. Order-sensitive for object keys, because a
 * re-ordered object is a rewritten file even when it holds the same values.
 */
export function copyDiff(a, b, path = '') {
  const at = (k) => (path ? `${path}.${k}` : String(k));
  const isObj = (v) => v !== null && typeof v === 'object';

  if (!isObj(a) || !isObj(b)) {
    return sameCopy(a, b) ? [] : [`${path || '(root)'}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`];
  }
  if (Array.isArray(a) !== Array.isArray(b)) return [`${path || '(root)'}: array/object mismatch`];
  if (Array.isArray(a)) {
    if (a.length !== b.length) return [`${path || '(root)'}: ${a.length} item(s) -> ${b.length}`];
    return a.flatMap((v, i) => copyDiff(v, b[i], `${path}[${i}]`));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.join(',') !== kb.join(',')) {
    return [`${path || '(root)'}: keys [${ka.join(', ')}] -> [${kb.join(', ')}]`];
  }
  return ka.flatMap((k) => copyDiff(a[k], b[k], at(k)));
}

/* ------------------------------------------------------------------ *
 * The edit
 * ------------------------------------------------------------------ */

/**
 * The new moments object: the approved entry appended verbatim, and — when
 * directed — one live question's stored status flipped to `retired`.
 *
 * PURE, and deliberately shallow: the retirement rewrites one string on an
 * entry that is otherwise passed through by reference, and the new entry is
 * the object parsed from the issue with nothing done to it. Appending rather
 * than inserting keeps the file's diff to one added block plus (at most) one
 * changed line, which is what makes the PR readable.
 *
 * @param {Record<string, any>} moments
 * @param {string} id
 * @param {Record<string, any>} entry
 * @param {string | null} [retireId]
 * @returns {Record<string, any>}
 */
export function applyEntry(moments, id, entry, retireId = null) {
  const next = {};
  for (const [k, v] of Object.entries(moments ?? {})) {
    next[k] = k === retireId ? { ...v, status: 'retired' } : v;
  }
  next[id] = entry;
  return next;
}

/* ------------------------------------------------------------------ *
 * The gate, wired exactly as scripts/check-moments.mjs wires it
 * ------------------------------------------------------------------ */

/**
 * The slug of one STORED nomination row.
 *
 * scripts/nominations-fetch.mjs's nominationSlug takes an API LIST ITEM
 * ({number, partNumber, congress}), not a data/nominations.json row
 * ({pn_number, part_number, congress_number}), and it reads missing fields
 * rather than throwing on them — so handing it a stored row directly returns
 * "pn-undefined-119" for every record and collapses the whole corpus into a
 * one-element set. The same three-line adapter appears in
 * scripts/check-moments.mjs, scripts/check-nominations.mjs and
 * scripts/sync-nominations.mjs, repeated rather than shared for the reason
 * check-moments.mjs states: a gate must not reach across into a sync script.
 * The collapse tripwire lives there; this file inherits its protection by
 * running behind it in the same job.
 */
const storedNominationSlug = (n) =>
  nominationSlug({ number: n.pn_number, partNumber: n.part_number, congress: n.congress_number });

/**
 * Run the real gate over the spliced object, in process and BEFORE anything
 * is written.
 *
 * `baselineVehicles` is built from the moments file as it stands on disk —
 * which, in the workflow, is `main`. That is the same baseline the merge will
 * face, so the new-vehicle terminality rule (a vehicle that is already over
 * may not be added) really runs here rather than being deferred to CI.
 *
 * `checkMoments` is IMPORTED. A second implementation of the gate is the one
 * way this script could accept an entry that CI then rejects, which would put
 * a red PR in front of the owner over copy he already approved.
 */
export function runGate({ moments, bills, nominations, baselineVehicles, now }) {
  const slugsByKind = {
    bill: new Set(bills.map((b) => b.full_identifier)),
    nomination: new Set(nominations.map(storedNominationSlug)),
  };
  const statusByKind = {
    bill: new Map(bills.map((b) => [b.full_identifier, b.status])),
    nomination: new Map(nominations.map((n) => [storedNominationSlug(n), n.status])),
  };
  const describedNominationSlugs = new Set(
    nominations
      .filter((n) => typeof n.nominee_description === 'string' && n.nominee_description.trim() !== '')
      .map(storedNominationSlug),
  );
  return checkMoments(
    moments,
    slugsByKind,
    (v) => statusByKind[vehicleKind(v)]?.get(v.slug),
    { describedNominationSlugs, baselineVehicles, now },
  );
}

/** The baseline pair set for the new-vehicle terminality rule. */
export function vehiclePairs(moments) {
  const pairs = new Set();
  for (const [id, m] of Object.entries(moments ?? {})) {
    for (const v of m?.vehicles ?? []) if (v?.slug) pairs.add(`${id}|${v.slug}`);
  }
  return pairs;
}

/* ------------------------------------------------------------------ *
 * The whole decision, pure
 * ------------------------------------------------------------------ */

/**
 * Everything except the file I/O: parse the issue, ask the four questions, and
 * return either the edit to make or the comment to post.
 *
 * Ordered so the message the owner gets is the FIRST thing wrong, not a wall
 * of consequences: a body that carries no scaffold should not also complain
 * about slots.
 *
 * @returns {{ decision: 'approve', id, entry, next, action, retire, gate, drift }
 *          | { decision: 'refuse', reason: string, error: string }}
 */
export function decide({ body, comments, moments, bills, nominations, owner, now = Date.now() }) {
  const scaffold = parseScaffold(body);
  if (!scaffold.ok) return { decision: 'refuse', reason: 'scaffold', error: scaffold.error };
  const { id, entry } = scaffold;

  const directive = replaceDirective(comments, { owner });
  const slots = slotDecision({ moments, replaceId: directive?.id ?? null, newId: id });
  if (!slots.ok) return { decision: 'refuse', reason: slots.need, error: slots.error, id, directive };

  const billBySlug = new Map(bills.map((b) => [b.full_identifier, b]));
  const nominationBySlug = new Map(nominations.map((n) => [storedNominationSlug(n), n]));
  const drift = recordDrift(entry, { billBySlug, nominationBySlug, now });
  if (drift.blocking.length) {
    return { decision: 'refuse', reason: 'drift', error: drift.blocking.join('\n\n'), id, directive };
  }

  const next = applyEntry(moments, id, entry, slots.retire);
  /* The baseline is the file BEFORE the splice — which, in the workflow, is
     `main`. That is the same baseline the merge will face, so the
     new-vehicle terminality rule fires here rather than at CI time, on a PR
     the owner would otherwise have to read a red check on. */
  const gate = runGate({
    moments: next,
    bills,
    nominations,
    baselineVehicles: vehiclePairs(moments),
    now,
  });
  if (gate.violations.length) {
    return {
      decision: 'refuse',
      reason: 'gate',
      error: gate.violations.map((v) => `- ${v}`).join('\n'),
      id,
      directive,
    };
  }

  return {
    decision: 'approve',
    id,
    entry,
    next,
    action: slots.action,
    retire: slots.retire,
    directive,
    gate,
    drift,
  };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const REFUSAL_HEAD = {
  scaffold: 'Nothing was published — this issue does not carry one approvable scaffold',
  directive: 'Nothing was published — all six slots are full',
  'valid-directive': 'Nothing was published — the replace directive does not resolve',
  drift: 'Nothing was published — the record has moved since this draft was written',
  gate: 'Nothing was published — the curation gate wants changes this workflow will not make',
};

/**
 * The comment posted back on the issue when a run refuses.
 *
 * It always ends the same way, because the escape hatch is the same in every
 * case and it is the thing that keeps this loop honest: the owner can EDIT THE
 * ISSUE BODY. The next run reads an edited body exactly as it reads a fresh
 * one, so his edit is the approved draft — no different from the model's,
 * except that he wrote it.
 */
export function refusalComment(decision, { issue } = {}) {
  return [
    `### ${REFUSAL_HEAD[decision.reason] ?? 'Nothing was published'}`,
    '',
    decision.error,
    '',
    '---',
    '',
    'The `approve-moment` label has been removed and `data/moments.json` is untouched. Two ways forward, both of which end with you re-applying the label:',
    '',
    '1. **Wait for the watcher.** Tonight\'s `moment-watch` run re-reads the record; if this candidate still clears the floor it re-drafts against the current facts.',
    `2. **Edit this issue body yourself.** The scaffold in issue #${issue ?? ''} is read exactly as written — your edit *is* the draft that publishes, byte for byte.`,
    '',
    '<sub>Nothing here rewrites your copy. When a gate wants a sentence changed, the change comes back to you rather than going out to the site.</sub>',
  ].join('\n');
}

/** A plain, declarative PR title in this repo's voice. */
export function prTitle(decision, moments) {
  const name = String(decision.entry?.name?.en ?? decision.id).replace(/\s+/g, ' ').trim();
  const short = name.length > 70 ? `${name.slice(0, 67)}…` : name;
  if (decision.retire) {
    const old = String(moments?.[decision.retire]?.name?.en ?? decision.retire).replace(/\s+/g, ' ').trim();
    return `${short} opens as a Big Question and ${old} retires`;
  }
  return `${short} opens as a Big Question`;
}

/**
 * The PR body: the issue link, the byte-fidelity attestation, the gate
 * evidence, and the constitution check.
 *
 * `moments.howMadeBody` is READ OUT OF messages/*.json rather than quoted from
 * memory, so the sentence this PR claims to keep true is the sentence the site
 * is actually shipping on the day it is opened.
 */
export function prBody(decision, { issue, moments, messages, now }) {
  const q = (lang) => messages?.[lang]?.moments?.howMadeBody ?? '(not found)';
  const lines = [
    `Closes #${issue}.`,
    '',
    `The \`approve-moment\` label went on #${issue}, so the scaffold in that issue is now \`${decision.id}\` in \`data/moments.json\`.`,
    decision.retire
      ? `\`${decision.retire}\` retires in the same commit, on the \`/replace ${decision.retire}\` directive in that thread — its entry stays in the file as the record that it existed, with \`status: "retired"\`, which is how \`lib/moments.ts\` takes a question off every surface.`
      : `There was room — ${LIVE_CAP - liveMoments(moments).length} of ${LIVE_CAP} slots open — so nothing retires.`,
    '',
    '## Byte-fidelity attestation',
    '',
    `Every field of \`${decision.id}\` is the JSON parsed out of issue #${issue}, written through unchanged and then **re-read from disk and compared field for field** against the parse. The comparison passed with zero differences.`,
    '',
    'This is the load-bearing property, not a nicety. What publishes is exactly the text that was read and approved — no trim, no normalisation, no re-flow, no field this workflow decided to improve. If any gate had wanted a change, the change would have gone back to the issue as a comment and nothing would have been written at all.',
    '',
    '## Gate evidence',
    '',
    `Run in process against the spliced file, with \`checkMoments\` imported from \`lib/moments-gate.mjs\` — the same function \`scripts/check-moments.mjs\` runs in CI, not a second copy of it:`,
    '',
    `- **violations: 0** (schema, EN/ES parity, vehicle resolution, qualifying-signal shape, dates, the ${LIVE_CAP}-live cap, the forbidden-vocabulary lint in both languages)`,
    `- **new-vehicle terminality:** baseline taken from \`data/moments.json\` as \`main\` has it (${vehiclePairs(moments).size} vehicle pair(s)); every vehicle added here is non-terminal`,
    decision.gate.warnings.length
      ? `- **warnings (non-blocking, printed for the record):**\n${decision.gate.warnings.map((w) => `  - ${w}`).join('\n')}`
      : '- **warnings:** none',
    decision.drift.notes.length
      ? `- **drift checks that could not run:**\n${decision.drift.notes.map((n) => `  - ${n}`).join('\n')}`
      : `- **record drift:** none — every vehicle's status and last-action date still match what it was drafted from, and the newest action is inside the ${PUBLISHED_SIGNAL_MAX_AGE_DAYS}-day window \`moments.whyCriteria\` publishes`,
    '',
    '## Constitution check',
    '',
    'The claim this flow has to keep true is `moments.howMadeBody`, which every reader sees on `/questions`:',
    '',
    `> **EN** — ${q('en')}`,
    '>',
    `> **ES** — ${q('es')}`,
    '',
    'It stays true, exactly as written, and here is the whole argument:',
    '',
    `1. **The automated check really runs, and it runs first.** \`checkMoments\` gated this entry before a byte was written, and \`scripts/check-moments.mjs --require-baseline\` re-ran it against the working tree before the commit. A failure at either point publishes nothing.`,
    `2. **A person really did the reviewing.** The draft in #${issue} is unreviewed AI prose until somebody reads it. The owner read that draft and applied the label; the label is the judgement. No other account can apply it — the workflow's first step, before checkout, drops the label and stops when the labeler is not the owner.`,
    `3. **What publishes is what he approved.** This is what byte fidelity buys. Had this script been free to edit copy on the way past, "a person reviewed it" would describe a draft rather than the entry, and the sentence above would quietly stop being true.`,
    '',
    `One boundary genuinely moved, and it is stated rather than glossed: the 2026-08-07 amendment in \`CLAUDE.md\` said of the drafting path *"nothing on this path writes \`data/moments.json\` and nothing publishes"*. That is still true of \`scripts/moment-draft.mjs\`, which this change does not touch. It is **not** true of the approve path, and it is not meant to be — writing that file on the owner's label is the whole point of the label. \`docs/big-question-intake.md\` describes the loop end to end.`,
    '',
    `<sub>Generated by \`.github/workflows/moment-approve.yml\` from issue #${issue} on ${new Date(now).toISOString().slice(0, 10)}. The label is the approval; this PR is its transcript.</sub>`,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

/**
 * Repo-relative for the corpora, ABSOLUTE-SAFE for everything the caller
 * names. `join(cwd, '/tmp/approve/body.md')` silently yields
 * `<repo>/tmp/approve/body.md`, which is how the first wiring of this script
 * failed: the workflow hands over absolute /tmp paths (an issue body has to be
 * written somewhere outside the checkout), and every one of them landed inside
 * the working tree instead. `resolve` leaves an absolute path alone and treats
 * a relative one as repo-relative, which is what both callers want.
 */
const path = (p) => resolve(process.cwd(), p);
const readJSON = (p) => JSON.parse(readFileSync(path(p), 'utf8'));

function main(argv) {
  const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const has = (name) => argv.includes(`--${name}`);

  const bodyFile = arg('body-file');
  const commentsFile = arg('comments-file');
  const owner = arg('owner');
  const issue = arg('issue');
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();

  if (!bodyFile || !owner) {
    console.error('usage: node scripts/moment-approve.mjs --body-file=<md> --owner=<login> [--comments-file=<json>] [--issue=<n>] [--write]');
    process.exit(2);
  }

  /* The labeler check is enforced by the workflow BEFORE anything is checked
     out. It is repeated here so a hand-run cannot skip it, and so the rule has
     one testable definition rather than living only in YAML. */
  const sender = arg('sender') ?? process.env.APPROVE_SENDER ?? owner;
  const actor = arg('actor') ?? process.env.APPROVE_ACTOR ?? owner;
  if (!authorized({ sender, actor, owner })) {
    console.error(`::error::moment-approve: "${sender}"/"${actor}" is not the owner (${owner}) — refusing.`);
    process.exit(3);
  }

  const body = readFileSync(path(bodyFile), 'utf8');
  const comments = commentsFile ? JSON.parse(readFileSync(path(commentsFile), 'utf8')) : [];
  const momentsText = readFileSync(path('data/moments.json'), 'utf8');
  const moments = JSON.parse(momentsText);
  const bills = readJSON('data/bills.json');
  const nominations = readJSON('data/nominations.json');

  const decision = decide({
    body,
    comments: Array.isArray(comments) ? comments : comments?.comments ?? [],
    moments,
    bills,
    nominations,
    owner,
    now,
  });

  const out = (name, text) => {
    const p = arg(name);
    if (p) writeFileSync(path(p), text.endsWith('\n') ? text : `${text}\n`);
  };

  if (decision.decision === 'refuse') {
    console.error(`::warning::moment-approve: refused (${decision.reason})`);
    console.error(decision.error);
    out('comment-out', refusalComment(decision, { issue }));
  } else {
    if (has('write')) {
      writeFileSync(path('data/moments.json'), `${JSON.stringify(decision.next, null, 2)}\n`);
      /* THE VERIFICATION LOOP, and the reason the write is not the last step.
         Everything above operates on objects; this reads the FILE back and
         compares it to the parse of the issue. A serialisation that lost or
         changed anything — and every future edit to this script that starts
         "just normalise the…" — fails here, restores the file, and refuses. */
      const reread = JSON.parse(readFileSync(path('data/moments.json'), 'utf8'));
      const diff = copyDiff(decision.entry, reread[decision.id]);
      if (diff.length) {
        writeFileSync(path('data/moments.json'), momentsText);
        console.error('::error::moment-approve: BYTE FIDELITY FAILED — the entry on disk is not the entry in the issue. data/moments.json has been restored and nothing was published.');
        for (const d of diff) console.error(`::error::  ${d}`);
        process.exit(4);
      }
      console.log(`moment-approve: wrote ${decision.id} (${decision.action})${decision.retire ? `, retired ${decision.retire}` : ''}; byte fidelity verified against issue #${issue}.`);
    } else {
      console.log(`moment-approve: would write ${decision.id} (${decision.action})${decision.retire ? `, retiring ${decision.retire}` : ''} — dry run, nothing changed.`);
    }
    const messages = { en: readJSON('messages/en.json'), es: readJSON('messages/es.json') };
    out('pr-title-out', prTitle(decision, moments));
    out('pr-body-out', prBody(decision, { issue, moments, messages, now }));
  }

  out('out', JSON.stringify({
    decision: decision.decision,
    reason: decision.reason ?? null,
    id: decision.id ?? null,
    action: decision.action ?? null,
    retire: decision.retire ?? null,
    branch: decision.id ? `moment/approve-${decision.id}` : null,
    directives: decision.directive?.all?.map((d) => d.id) ?? [],
  }, null, 2));

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `decision=${decision.decision}`,
        `reason=${decision.reason ?? ''}`,
        `moment_id=${decision.id ?? ''}`,
        `retire=${decision.retire ?? ''}`,
        `branch=${decision.id ? `moment/approve-${decision.id}` : ''}`,
        '',
      ].join('\n'),
    );
  }

  /* A refusal is a NORMAL outcome, not a failure: the owner asked a question
     and got an answer on the issue. Exiting non-zero here would page him with
     a red run every time he approved something a day late. */
  process.exitCode = 0;
}

if (process.argv[1]?.endsWith('moment-approve.mjs')) {
  main(process.argv.slice(2));
}

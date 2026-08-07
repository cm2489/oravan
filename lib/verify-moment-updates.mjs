/**
 * The moment-updates half of the nightly dead-man's-switch, as a pure
 * function. Same split scripts/check-moment-updates.mjs uses over
 * lib/moment-updates-gate.mjs: all the judgement lives here so the unit suite
 * can drive it, and scripts/verify-sync.mjs does the file I/O, the `git show`,
 * and the exit code.
 *
 * WHY THIS IS A SEPARATE GATE FROM check-moment-updates.mjs, given that one
 * validates the same file far more thoroughly: they run at different moments
 * and only one of them can stop a bad night. check-moment-updates runs in
 * ci.yml — on pull requests and on pushes to main, which for the nightly means
 * AFTER the data commit has already landed and deployed. verify-sync runs
 * inside sync-bills.yml, between the collector and the commit step, and is the
 * last thing standing between a damaged file and production.
 *
 * That gap is not theoretical. The collector pruned summary revisions to
 * MAX_REVISIONS and then appended tonight's, so a moment sitting at the cap
 * committed MAX_REVISIONS + 1. verify-sync had no revision-count check, so the
 * file passed verification, committed, deployed, and only then reddened main
 * on the CI run the data push dispatches — where it stayed red until the next
 * night's prune trimmed it back (found 2026-08-06).
 *
 * So the retention caps are checked HERE too. Not a duplicate of the gate: the
 * gate says "this file is invalid", this says "do not commit tonight's run",
 * and the second sentence is the one that prevents the outage. The numbers are
 * imported from the gate, never copied, so there is exactly one definition of
 * each cap in the repo.
 */
import {
  HARD_DAY_CEILING,
  MAX_REVISIONS,
  MAX_UPDATES_PER_MOMENT,
  SCHEMA_VERSION,
  SIZE_FAIL_BYTES,
} from './moment-updates-gate.mjs';

export const MOMENT_UPDATES_PATH = 'data/moment-updates.json';

/** Total updates across every moment entry, ignoring the _meta key. */
const countUpdates = (obj) =>
  Object.entries(obj ?? {})
    .filter(([k]) => k !== '_meta')
    .reduce((n, [, e]) => n + (Array.isArray(e?.updates) ? e.updates.length : 0), 0);

/**
 * @param {{
 *   updates: Record<string, any>,
 *   moments?: Record<string, any>|null,
 *   before?: Record<string, any>|null,
 *   fileBytes?: number|null,
 *   now?: number,
 * }} input
 *   `before` is the committed (HEAD) copy of the file, or null when there
 *   isn't one — the expected case on the branch that first adds it, and on a
 *   shallow checkout. Never a failure.
 * @returns {{ failures: string[], warnings: string[], notes: string[] }}
 *   failures fail the workflow before anything is committed; warnings print;
 *   notes are the green-path log lines.
 */
export function verifyMomentUpdates({ updates, moments = null, before = null, fileBytes = null, now = Date.now() }) {
  /** @type {string[]} */ const failures = [];
  /** @type {string[]} */ const warnings = [];
  /** @type {string[]} */ const notes = [];

  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    failures.push(`${MOMENT_UPDATES_PATH} is not an object keyed by moment id`);
    return { failures, warnings, notes };
  }

  if (updates._meta?.schema !== SCHEMA_VERSION) {
    failures.push(
      `${MOMENT_UPDATES_PATH} _meta.schema is ${JSON.stringify(updates._meta?.schema)}, not the known schema version ${SCHEMA_VERSION}`,
    );
  }

  // Size ceiling — the same number the gate fails at, imported not copied.
  if (typeof fileBytes === 'number' && fileBytes >= SIZE_FAIL_BYTES) {
    failures.push(
      `${MOMENT_UPDATES_PATH} is ${fileBytes} bytes, at or past the ${SIZE_FAIL_BYTES}-byte ceiling — retention pruning has stopped working`,
    );
  }

  const entries = Object.entries(updates).filter(([k]) => k !== '_meta');
  const total = countUpdates(updates);

  // Every id resolves in the hand-authored file. moments.json and
  // moment-updates.json are deliberately separate owners (auto-commits and
  // hand edits never contend for one file); an orphan here means one of
  // them moved without the other.
  if (moments && typeof moments === 'object') {
    const orphans = entries.map(([id]) => id).filter((id) => !moments[id]);
    if (orphans.length) {
      failures.push(
        `${MOMENT_UPDATES_PATH}: ${orphans.length} entr(ies) reference moments that don't exist in data/moments.json (first: ${orphans[0]})`,
      );
    }
  }

  // EN/ES parity over every rendered string — update one-liners AND summary
  // revisions. The bilingual hard rule does not get a machine-authored
  // exemption.
  const parityGaps = [];
  const futureDated = [];
  // Retention envelopes the collector is responsible for holding. Each is a
  // cap check-moment-updates already fails on; the point of repeating them
  // here is that this runs BEFORE the commit and that one runs after it.
  const overCap = [];
  for (const [id, entry] of entries) {
    const entryUpdates = entry?.updates ?? [];
    for (const u of entryUpdates) {
      if (!u?.text?.en?.trim() || !u?.text?.es?.trim()) parityGaps.push(`${id}/${u?.id} update text`);
      for (const field of ['day', 'occurred_at', 'recorded_at']) {
        const t = Date.parse(u?.[field]);
        if (Number.isFinite(t) && t > now + 86_400_000) futureDated.push(`${id}/${u?.id}.${field}=${u[field]}`);
      }
    }
    for (const r of entry?.summary_revisions ?? []) {
      if (!r?.text?.en?.trim() || !r?.text?.es?.trim()) parityGaps.push(`${id}/${r?.id} summary revision`);
    }

    const revisionCount = Array.isArray(entry?.summary_revisions) ? entry.summary_revisions.length : 0;
    if (revisionCount > MAX_REVISIONS) {
      overCap.push(`${id}: ${revisionCount} summary revisions exceeds the ${MAX_REVISIONS}-revision cap`);
    }
    if (entryUpdates.length > MAX_UPDATES_PER_MOMENT) {
      overCap.push(`${id}: ${entryUpdates.length} updates exceeds the ${MAX_UPDATES_PER_MOMENT}-per-moment retention cap`);
    }
    /** @type {Map<string, number>} */
    const perDay = new Map();
    for (const u of entryUpdates) {
      if (typeof u?.day !== 'string') continue;
      perDay.set(u.day, (perDay.get(u.day) ?? 0) + 1);
    }
    for (const [day, count] of perDay) {
      if (count > HARD_DAY_CEILING) {
        overCap.push(`${id} ${day}: ${count} updates exceeds the ${HARD_DAY_CEILING}-per-day storage ceiling`);
      }
    }
  }

  if (parityGaps.length) {
    failures.push(
      `EN/ES parity broke in ${MOMENT_UPDATES_PATH}: ${parityGaps.length} string(s) missing a sibling (first: ${parityGaps[0]})`,
    );
  }
  if (futureDated.length) {
    failures.push(
      `${MOMENT_UPDATES_PATH}: ${futureDated.length} future-dated field(s) — nothing claims a date the record does not support (first: ${futureDated[0]})`,
    );
  }
  if (overCap.length) {
    failures.push(
      `${MOMENT_UPDATES_PATH}: ${overCap.length} retention cap(s) blown — the collector wrote a file its own CI gate rejects, so nothing is committed tonight (${overCap.join('; ')})`,
    );
  }

  // Update-count vs the committed file. Retention prunes gradually; an
  // overnight cliff means the collector replaced the file with a partial
  // result. Same idiom as the coverage-shrink check in verify-sync.mjs.
  if (before && typeof before === 'object') {
    const beforeTotal = countUpdates(before);
    if (beforeTotal >= 10 && total < beforeTotal * 0.5) {
      failures.push(
        `${MOMENT_UPDATES_PATH} shrank ${beforeTotal} -> ${total} updates (>50% overnight) — a partial collector run replaced the file`,
      );
    } else if (beforeTotal >= 10 && total < beforeTotal * 0.8) {
      warnings.push(`${MOMENT_UPDATES_PATH} shrank ${beforeTotal} -> ${total} updates (>20% overnight) — worth a look`);
    } else {
      notes.push(`moment updates: ${beforeTotal} -> ${total} across ${entries.length} moment(s)`);
    }
  } else {
    notes.push(
      `no HEAD:${MOMENT_UPDATES_PATH} to compare against (first commit of the live layer?) — ${total} update(s) now`,
    );
  }

  return { failures, warnings, notes };
}

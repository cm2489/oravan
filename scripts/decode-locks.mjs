/**
 * DECODE LOCKS — a hand-corrected decode is never silently rewritten.
 *
 * WHY IT EXISTS (2026-11-25). #562 corrected two wrong sentences in the
 * decodes of hr-9237-119 and hr-2347-119, by hand, in both languages. Every
 * pipeline path that re-decodes a bill rewrites the whole decode
 * (`ai_summary`, `ai_headline`, `ai_sections` in data/bills.json and the
 * bill's entry in data/bills-es.json), so the next re-decode would have put
 * the wrong sentences back, with nobody told.
 *
 * THE FILE. data/decode-locks.json, committed and edited by hand:
 *   { "_about": [...], "locks": { "<full_identifier>": {
 *       reason, locked_on (YYYY-MM-DD), pr (number),
 *       text_version_date, text_version_type, text_version_count } } }
 * The three version fields are the provenance stamp data/bills.json carried
 * when the correction was made (the same fields `textVersionStamp` writes and
 * the nightly's new-text trigger compares; null where the record had none).
 * They say WHICH published text the correction was checked against.
 *
 * WHAT A LOCK DOES. Every path that writes a decode skips a locked bill:
 *   - scripts/bill-decode.mjs `redecodeBill` — the one writer behind the
 *     nightly new-text re-decode, FORCE_REDECODE_SLUGS, and both newsdesk
 *     re-decode triggers (stale decode, vehicle swap). It returns 'locked',
 *     spends nothing and mutates nothing. FORCE_REDECODE_SLUGS does NOT
 *     outrank a lock: a person who wants the bill re-decoded deletes the lock
 *     in the same change, which leaves a record of why.
 *   - scripts/sync-bills.mjs drops a locked bill from the nightly's detected
 *     candidates before the ceiling is applied, so a lock never costs another
 *     bill its slot.
 *   - The one-off scripts that rewrite decode fields (merge-headlines,
 *     restructure-decoded, generate-cost-chips, translate-summaries) skip it.
 *   - `completeDecode` (new bills only) cannot meet one: a lock must name a
 *     bill already in the corpus (pinned by tests/decode-locks.unit.spec.ts).
 * The hourly hot-bill refresh (scripts/hot-bills.mjs) and every other refresh
 * write status, dates and urgency only, never a decode, so they need no gate.
 *
 * WHEN CONGRESS PUBLISHES A NEW TEXT VERSION — the chosen behaviour: STILL
 * SKIP, AND RAISE AN ALARM. A newer version (a later date, a different type,
 * a higher count, or a new title for the same number) means the correction
 * may no longer describe the bill, but an automatic re-decode would throw the
 * person's fix away without anyone reading it. So the bill keeps its corrected
 * decode and every run that sees the newer text prints
 *   ::warning::DECODE LOCK STALE: <slug> ...
 * which lib/pipeline-health.mjs `parseDecodeLockStale` reads from the day's
 * data-workflow logs and raises as the `decode-lock-stale` alarm in the
 * pipeline-health issue the doctor reads. The alarm repeats every day until a
 * person acts: delete the lock (the next nightly re-decodes from the new
 * text), or update its version fields to the new version if the correction
 * still holds. A lock never expires on its own.
 */
import { existsSync, readFileSync } from 'node:fs';
import { pickTextVersion } from './text-version.mjs';

export const DECODE_LOCKS_PATH = 'data/decode-locks.json';

/** The exact prefix every stale-lock warning carries; the health parser keys on it. */
export const DECODE_LOCK_STALE_TAG = 'DECODE LOCK STALE';

const SLUG_RE = /^[a-z]+-\d+-\d+$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Check a parsed decode-locks file and return its locks as a Map. Throws on
 * any malformed entry, naming it: a lock file that half-parses would
 * half-protect, which is worse than a loud failure in CI.
 * @param {any} raw
 * @returns {Map<string, {reason:string, locked_on:string, pr:number,
 *   text_version_date:string|null, text_version_type:string|null,
 *   text_version_count:number|null}>}
 */
export function parseDecodeLocks(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('decode-locks: the file is not a JSON object');
  const locks = raw.locks;
  if (!locks || typeof locks !== 'object' || Array.isArray(locks)) throw new Error('decode-locks: "locks" must be an object keyed by full_identifier');
  const out = new Map();
  for (const [slug, l] of Object.entries(locks)) {
    const bad = (why) => new Error(`decode-locks: ${slug}: ${why}`);
    if (!SLUG_RE.test(slug)) throw bad('key is not a full_identifier like hr-1234-119');
    if (!l || typeof l !== 'object') throw bad('entry is not an object');
    if (typeof l.reason !== 'string' || !l.reason.trim()) throw bad('reason is missing');
    if (typeof l.locked_on !== 'string' || !DAY_RE.test(l.locked_on)) throw bad('locked_on must be YYYY-MM-DD');
    if (!Number.isInteger(l.pr) || l.pr <= 0) throw bad('pr must be a pull request number');
    for (const k of ['text_version_date', 'text_version_type']) {
      if (!(k in l)) throw bad(`${k} is missing (use null when the record had none)`);
      if (l[k] !== null && typeof l[k] !== 'string') throw bad(`${k} must be a string or null`);
    }
    if (l.text_version_date !== null && !Number.isFinite(Date.parse(l.text_version_date))) throw bad('text_version_date does not parse');
    if (!('text_version_count' in l)) throw bad('text_version_count is missing (use null when the record had none)');
    if (l.text_version_count !== null && !(Number.isInteger(l.text_version_count) && l.text_version_count >= 0)) {
      throw bad('text_version_count must be a whole number or null');
    }
    if (l.text_version_date === null && l.text_version_type === null && l.text_version_count === null) {
      throw bad('records no text version at all, so a new version could never be noticed');
    }
    out.set(slug, {
      reason: l.reason,
      locked_on: l.locked_on,
      pr: l.pr,
      text_version_date: l.text_version_date,
      text_version_type: l.text_version_type,
      text_version_count: l.text_version_count,
    });
  }
  return out;
}

/**
 * Read data/decode-locks.json. A missing file is "no locks"; a malformed one
 * throws (see parseDecodeLocks).
 * @param {string} [path]
 */
export function readDecodeLocks(path = DECODE_LOCKS_PATH) {
  if (!existsSync(path)) return new Map();
  return parseDecodeLocks(JSON.parse(readFileSync(path, 'utf8')));
}

/** Memoised per path for the long-running scripts; tests pass their own Map. */
const cache = new Map();
export function decodeLocks(path = DECODE_LOCKS_PATH) {
  if (!cache.has(path)) cache.set(path, readDecodeLocks(path));
  return cache.get(path);
}

/**
 * Is the text Congress serves today the text the lock was made against?
 * Pure. The lock HOLDS either way (the caller never decodes a locked bill);
 * this only decides whether a person has to be told.
 *
 * `versions`/`count` are a /text reply as fetchTextVersions returns it; pass
 * null for both when they could not be read. `newTitle` is the served title
 * when it differs from the corpus's (a vehicle swap), else null.
 *
 * @param {{text_version_date: string|null, text_version_type: string|null, text_version_count: number|null}} lock
 * @param {{versions?: any[]|null, count?: number|null, newTitle?: string|null}} [served]
 * @returns {{stale: boolean, reason: string, detail: string}}
 *   reason: 'same-text' | 'unknown' | 'newer-date' | 'other-type' | 'more-versions' | 'new-title'
 */
export function decodeLockVerdict(lock, { versions = null, count = null, newTitle = null } = {}) {
  const changes = [];
  if (newTitle) changes.push({ reason: 'new-title', detail: `Congress now serves the title "${newTitle}"` });
  const picked = Array.isArray(versions) ? pickTextVersion(versions) : null;
  const servedDate = picked?.date ?? null;
  const servedType = picked?.type ?? null;
  if (lock.text_version_date && servedDate && Date.parse(servedDate) > Date.parse(lock.text_version_date)) {
    changes.push({ reason: 'newer-date', detail: `the current text is dated ${servedDate.slice(0, 10)}, the lock's ${lock.text_version_date.slice(0, 10)}` });
  }
  if (lock.text_version_type && servedType && servedType !== lock.text_version_type) {
    changes.push({ reason: 'other-type', detail: `the current text is "${servedType}", the lock's "${lock.text_version_type}"` });
  }
  if (Number.isFinite(lock.text_version_count) && Number.isFinite(count) && count > lock.text_version_count) {
    changes.push({ reason: 'more-versions', detail: `${count} text versions published, ${lock.text_version_count} when locked` });
  }
  if (changes.length) {
    return { stale: true, reason: changes[0].reason, detail: changes.map((c) => c.detail).join('; ') };
  }
  if (!Array.isArray(versions) && !newTitle) {
    return { stale: false, reason: 'unknown', detail: 'the current text version could not be read this run' };
  }
  return { stale: false, reason: 'same-text', detail: 'the text Congress serves is the version the correction was checked against' };
}

/**
 * The one log line for a skipped locked bill. A stale lock's line is a GitHub
 * `::warning::` carrying DECODE_LOCK_STALE_TAG, which pipeline-health reads.
 * @param {string} slug
 * @param {{pr:number, locked_on:string}} lock
 * @param {{stale:boolean, reason?:string, detail:string}} verdict
 * @param {string} [where] which path skipped it, for the log only
 */
export function decodeLockLine(slug, lock, verdict, where = 're-decode') {
  if (verdict.stale) {
    return `::warning::${DECODE_LOCK_STALE_TAG}: ${slug} has newer text than its hand-corrected decode (PR #${lock.pr}, locked ${lock.locked_on}): ${verdict.detail}. Kept the corrected decode and did NOT re-decode; a person must re-check it, then delete or update the lock in ${DECODE_LOCKS_PATH}.`;
  }
  return `  ${slug}: ${where} skipped - decode locked by PR #${lock.pr} (${lock.locked_on}); ${verdict.detail}`;
}

/*
 * Salt-health assessment — the ONE copy (S11, F5). Plain .mjs with JSDoc
 * types, no side effects, following lib/urgency.mjs's pattern so the nightly
 * verifier script (scripts/verify-salt.mjs) and the unit spec
 * (tests/verify-salt.unit.spec.ts) import the exact logic that guards
 * production.
 *
 * Context: rate-limit caller hashes are sha256(ip + salt); the salt lives in
 * the counters database as JSON {v, t} under a 24h TTL (lib/ratelimit.ts).
 * If rotation silently fails, short-lived rate-limit counters quietly become
 * stable identifiers — the exact silent-failure disease this repo's
 * verifiers exist to make loud.
 */

/** 24h TTL + 1h slack for clock skew between writer and verifier. */
export const MAX_SALT_AGE_MS = 25 * 60 * 60 * 1000;

/** Must match lib/ratelimit.ts's SALT_TTL_SECONDS. */
export const SALT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Assess one keyspace's salt state. Pure, so tests can force a stale
 * fixture without a live database.
 *
 * @param {{ record: string | null, ttlSeconds: number, now?: number }} input
 *   record: the raw stored value (null when the key is absent);
 *   ttlSeconds: Redis TTL semantics (-2 missing, -1 no expiry, else seconds).
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function assessSalt({ record, ttlSeconds, now = Date.now() }) {
  if (record === null) {
    // No salt: created lazily on first traffic after rotation. Healthy.
    return { ok: true, problems: [] };
  }
  const problems = [];

  let parsed = null;
  try {
    parsed = JSON.parse(record);
  } catch {
    problems.push('salt record is not JSON — lib/ratelimit.ts did not write this');
  }
  if (parsed !== null) {
    if (typeof parsed.v !== 'string' || !/^[0-9a-f]{32,}$/.test(parsed.v)) {
      problems.push('salt value is not ≥32 hex chars — that is under 128 bits of CSPRNG output (F5 floor)');
    }
    const created = typeof parsed.t === 'string' ? Date.parse(parsed.t) : NaN;
    if (Number.isNaN(created)) {
      problems.push('salt record has no parseable creation time');
    } else {
      const age = now - created;
      if (age < 0) problems.push('salt creation time is in the future — clock or record corruption');
      if (age > MAX_SALT_AGE_MS) {
        problems.push(
          `salt is ${(age / 3_600_000).toFixed(1)}h old — the 24h TTL should have rotated it; rotation has FAILED and pseudonyms are going stable`
        );
      }
    }
  }

  if (ttlSeconds === -1) {
    problems.push('salt key has NO TTL — rotation is broken outright; every caller hash is now a stable identifier');
  } else if (ttlSeconds > SALT_TTL_SECONDS) {
    problems.push(`salt TTL is ${ttlSeconds}s (> 24h) — rotation is misconfigured`);
  }

  return { ok: problems.length === 0, problems };
}

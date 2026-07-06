/**
 * Salt-age dead-man's-switch (S11, F5) — same loud-failure posture as
 * scripts/verify-sync.mjs. Runs nightly in sync-bills.yml.
 *
 * The rate-limit caller hash is sha256(ip + salt); the salt is supposed to
 * be ≥128 bits of CSPRNG output living in the counters database under a 24h
 * TTL (lib/ratelimit.ts). If rotation silently fails — the TTL got stripped,
 * the record got corrupted, a weak/short value got written — the daily
 * pseudonyms quietly become STABLE identifiers, which is exactly the failure
 * class this repo's verifiers exist to make loud (three silent data failures
 * shipped in 19 days before verify-sync.mjs; this is the same disease).
 *
 * FAILS (exit 1) when a salt record exists and any check in
 * lib/salt.mjs's assessSalt trips:
 *   - the record isn't JSON of shape {v, t}
 *   - v is shorter than 32 hex chars (that's <128 bits) or not hex
 *   - t is unparseable, in the future, or more than 25h old (24h TTL + 1h
 *     slack for clock skew — an older record means the TTL didn't kill it)
 *   - the key has no TTL (TTL -1: rotation is broken outright)
 *   - the TTL exceeds 24h (misconfigured rotation)
 * Also FAILS when the counters database can't be read at all: "couldn't
 * look" is not "looked and it was fine".
 *
 * PASSES when no salt exists (it's created lazily on the first rate-limited
 * request after each rotation — absence just means no traffic yet).
 *
 * SKIPS with a ::warning when UPSTASH_COUNTERS_REST_URL/TOKEN aren't in the
 * environment (same posture as verify-deploy.mjs's PROD_URL skip): the check
 * is armed by adding those two GitHub Actions secrets. It checks the
 * 'production' and 'preview' keyspaces (the two VERCEL_ENV prefixes
 * lib/upstash.ts's keyPrefix() can produce in deployed environments).
 */
import { assessSalt } from '../lib/salt.mjs';

async function cmd(url, token, command) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`counters DB request failed (status ${res.status})`); // status only
  const data = await res.json();
  if (data.error) throw new Error(`counters DB returned an error (status ${res.status})`);
  return data.result;
}

async function main() {
  const url = process.env.UPSTASH_COUNTERS_REST_URL;
  const token = process.env.UPSTASH_COUNTERS_REST_TOKEN;
  if (!url || !token) {
    console.log(
      "::warning::salt-age verifier SKIPPED — UPSTASH_COUNTERS_REST_URL/TOKEN not in this environment. Add both as Actions secrets to arm the dead-man's-switch."
    );
    return;
  }

  let failed = false;
  for (const prefix of ['production', 'preview']) {
    const key = `${prefix}:salt:current`;
    let record;
    let ttlSeconds;
    try {
      record = await cmd(url, token, ['GET', key]);
      ttlSeconds = await cmd(url, token, ['TTL', key]);
    } catch (e) {
      console.error(`::error::salt-age verifier could not read ${prefix} keyspace: ${e.message}`);
      failed = true;
      continue;
    }
    const { ok, problems } = assessSalt({
      record: typeof record === 'string' ? record : null,
      ttlSeconds: typeof ttlSeconds === 'number' ? ttlSeconds : -2,
    });
    if (record === null || record === undefined) {
      console.log(`${prefix}: no salt present (no rate-limited traffic since last rotation) — OK`);
    } else if (ok) {
      console.log(`${prefix}: salt healthy (TTL ${ttlSeconds}s)`);
    } else {
      for (const p of problems) console.error(`::error::${prefix} keyspace: ${p}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(`::error::salt-age verifier crashed: ${e.message}`);
  process.exit(1);
});

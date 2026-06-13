import 'server-only';

/*
 * The heartbeat store: Upstash Redis over REST, no SDK.
 *
 * Privacy contract (stronger than "anonymous"):
 * - Per bill we store ONLY counters: hb:{slug}:{yyyy-mm-dd} (7-day pulse,
 *   8-day TTL) and hb:{slug}:total. No identity, no ZIP, no stance.
 * - Abuse control NEVER links a network address to a bill. The per-IP key
 *   (hbr:{sha256(ip+daySalt)}) holds one coarse daily counter across ALL
 *   tallies; which bills were tallied is not recorded against it.
 * - One-tap-per-bill dedupe lives client-side in localStorage.
 */

const URL_ =
  process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? null;
const TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? null;

export const heartbeatEnabled = Boolean(URL_ && TOKEN);

async function pipeline(commands: (string | number)[][]): Promise<{ result: unknown }[]> {
  const res = await fetch(`${URL_}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  return res.json();
}

function dayKeys(slug: string, days = 7): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    out.push(`hb:${slug}:${d}`);
  }
  return out;
}

export async function getPulse(slug: string): Promise<{ pulse7: number; total: number }> {
  if (!heartbeatEnabled) return { pulse7: 0, total: 0 };
  const keys = dayKeys(slug);
  const [mget, total] = await pipeline([
    ['MGET', ...keys],
    ['GET', `hb:${slug}:total`],
  ]);
  const pulse7 = ((mget.result as (string | null)[]) ?? []).reduce(
    (sum, v) => sum + (Number(v) || 0),
    0
  );
  return { pulse7, total: Number(total.result) || 0 };
}

const DAILY_IP_CAP = 30;

export async function addTally(
  slug: string,
  ip: string
): Promise<{ ok: boolean; pulse7: number; total: number }> {
  if (!heartbeatEnabled) return { ok: false, pulse7: 0, total: 0 };

  const day = new Date().toISOString().slice(0, 10);
  // Daily salt so the hash can't be correlated across days; counter only,
  // never associated with a bill.
  const salt = `rostra-${day}`;
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const ipKey = `hbr:${Buffer.from(digest).toString('hex').slice(0, 24)}`;

  const [count] = await pipeline([['INCR', ipKey]]);
  if (Number(count.result) === 1) await pipeline([['EXPIRE', ipKey, 86_400]]);
  if (Number(count.result) > DAILY_IP_CAP) {
    const current = await getPulse(slug);
    return { ok: false, ...current };
  }

  const todayKey = `hb:${slug}:${day}`;
  await pipeline([
    ['INCR', todayKey],
    ['EXPIRE', todayKey, 8 * 86_400],
    ['INCR', `hb:${slug}:total`],
  ]);
  const current = await getPulse(slug);
  return { ok: true, ...current };
}

export async function getAllPulses(slugs: string[]): Promise<Record<string, number>> {
  if (!heartbeatEnabled || slugs.length === 0) return {};
  const out: Record<string, number> = {};
  // One MGET per bill is heavy; batch 7-day keys for many bills per pipeline call.
  const BATCH = 100;
  for (let i = 0; i < slugs.length; i += BATCH) {
    const batch = slugs.slice(i, i + BATCH);
    const results = await pipeline(batch.map((s) => ['MGET', ...dayKeys(s)]));
    batch.forEach((s, j) => {
      const sum = ((results[j].result as (string | null)[]) ?? []).reduce(
        (acc, v) => acc + (Number(v) || 0),
        0
      );
      if (sum > 0) out[s] = sum;
    });
  }
  return out;
}

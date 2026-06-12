/**
 * Nightly: pull every bill's 7-day pulse from Upstash into
 * data/heartbeats.json so the static build can blend community signal
 * into feed ordering. Exits quietly when the store isn't configured.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const URL_ = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
if (!URL_ || !TOKEN) {
  console.log('heartbeat store not configured; skipping pulse pull');
  process.exit(0);
}

const bills = JSON.parse(readFileSync('data/bills.json', 'utf8'));
const slugs = bills.map((b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase());

function dayKeys(slug) {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    out.push(`hb:${slug}:${d}`);
  }
  return out;
}

const out = {};
const BATCH = 100;
for (let i = 0; i < slugs.length; i += BATCH) {
  const batch = slugs.slice(i, i + BATCH);
  const res = await fetch(`${URL_}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(batch.map((s) => ['MGET', ...dayKeys(s)])),
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  const results = await res.json();
  batch.forEach((s, j) => {
    const sum = (results[j].result ?? []).reduce((acc, v) => acc + (Number(v) || 0), 0);
    if (sum > 0) out[s] = sum;
  });
}
writeFileSync('data/heartbeats.json', JSON.stringify(out));
console.log(`pulses written: ${Object.keys(out).length} bills with activity`);

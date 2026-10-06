import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECHECK_DAYS, runMirror } from '../scripts/mirror-portraits.mjs';
import { countPortrait404s } from '../lib/pipeline-health.mjs';

/*
 * The nightly portrait mirror must not keep asking for photos that do not
 * exist upstream. Everything outside the function is injected: no network,
 * no Blob store, no clock.
 */

const NOW = new Date('2026-10-15T04:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);

function harness(statusFor: (id: string) => number) {
  const requested: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  const fetchImpl = async (url: string) => {
    const id = /\/([A-Z]\d{6})\.jpg$/.exec(url)![1];
    requested.push(id);
    const status = statusFor(id);
    return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => new ArrayBuffer(4) };
  };
  const put = async (path: string) => ({ url: `https://blob.example/${path}` });
  const run = (over: { legislators: string[]; manifest?: object; missing?: object }) => {
    const manifest: Record<string, unknown> = { ...(over.manifest ?? {}) };
    const missing: Record<string, { firstMissing: string; lastChecked: string }> = { ...(over.missing ?? {}) } as never;
    return runMirror({
      legislators: over.legislators.map((bioguide) => ({ bioguide })),
      manifest,
      missing,
      fetchImpl: fetchImpl as never,
      put,
      token: 'x',
      now: NOW,
      log: (m: string) => logs.push(m),
      error: (m: string) => errors.push(m),
    }).then((counts) => ({ counts, manifest, missing }));
  };
  return { run, requested, errors, logs };
}

test('a 404 is recorded with today as first seen and last checked, and no manifest entry', async () => {
  const h = harness(() => 404);
  const { manifest, missing, counts } = await h.run({ legislators: ['B001323'] });
  expect(missing).toEqual({ B001323: { firstMissing: daysAgo(0), lastChecked: daysAgo(0) } });
  expect(manifest).toEqual({});
  expect(counts.failed).toBe(1);
});

test('a non-404 failure is not recorded as missing', async () => {
  const h = harness(() => 503);
  const { missing } = await h.run({ legislators: ['B001323'] });
  expect(missing).toEqual({});
});

test('a recorded member is skipped inside 30 days and re-checked after', async () => {
  expect(RECHECK_DAYS).toBe(30);
  const h = harness(() => 404);
  const inside = await h.run({
    legislators: ['B001323'],
    missing: { B001323: { firstMissing: daysAgo(40), lastChecked: daysAgo(29) } },
  });
  expect(h.requested).toEqual([]);
  expect(inside.counts.knownMissing).toBe(1);
  expect(inside.missing.B001323.lastChecked).toBe(daysAgo(29));

  const after = await h.run({
    legislators: ['B001323'],
    missing: { B001323: { firstMissing: daysAgo(80), lastChecked: daysAgo(31) } },
  });
  expect(h.requested).toEqual(['B001323']);
  // first-seen date survives the re-check; last-checked moves to today
  expect(after.missing.B001323).toEqual({ firstMissing: daysAgo(80), lastChecked: daysAgo(0) });
});

test('a photo that turns up is mirrored and its missing record is removed', async () => {
  const h = harness(() => 200);
  const { manifest, missing } = await h.run({
    legislators: ['B001323', 'C000127'],
    missing: { B001323: { firstMissing: daysAgo(90), lastChecked: daysAgo(31) } },
  });
  expect(Object.keys(manifest)).toEqual(['B001323', 'C000127']);
  expect(missing).toEqual({});
});

test('a mirrored member is never requested, whatever the missing file says', async () => {
  const h = harness(() => 404);
  await h.run({
    legislators: ['C000127'],
    manifest: { C000127: { blobUrl: 'u', mirroredAt: 't' } },
    missing: { C000127: { firstMissing: daysAgo(90), lastChecked: daysAgo(90) } },
  });
  expect(h.requested).toEqual([]);
});

test('the 404 log line keeps the format lib/pipeline-health.mjs counts', async () => {
  const h = harness((id) => (id === 'C000127' ? 200 : 404));
  await h.run({ legislators: ['B001323', 'H001104', 'C000127'] });
  expect(h.errors).toEqual([
    'mirror-portraits: B001323 source fetch failed (status 404) - skipped',
    'mirror-portraits: H001104 source fetch failed (status 404) - skipped',
  ]);
  expect(countPortrait404s(h.errors.join('\n'))).toBe(2);
  // and the same members, now recorded, add nothing to tomorrow's count
  const second = harness(() => 404);
  await second.run({
    legislators: ['B001323', 'H001104'],
    missing: {
      B001323: { firstMissing: daysAgo(1), lastChecked: daysAgo(1) },
      H001104: { firstMissing: daysAgo(1), lastChecked: daysAgo(1) },
    },
  });
  expect(countPortrait404s(second.errors.join('\n'))).toBe(0);
});

test('the committed missing file has the documented shape', () => {
  const file = JSON.parse(readFileSync(join(process.cwd(), 'data/portrait-missing.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'data/portrait-manifest.json'), 'utf8'));
  for (const [id, v] of Object.entries<{ firstMissing: string; lastChecked: string }>(file)) {
    expect(id).toMatch(/^[A-Z]\d{6}$/);
    expect(v.firstMissing).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(v.lastChecked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest[id], `${id} is both mirrored and missing`).toBeUndefined();
  }
});

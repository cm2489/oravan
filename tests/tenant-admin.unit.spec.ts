import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  cmdImpressions,
  cmdInspect,
  cmdList,
  cmdRevoke,
  cmdRotate,
  cmdSetAttribution,
  formatImpressions,
  formatInspect,
  formatList,
  formatRotate,
  hashPreview,
  keyspaceBanner,
  main,
  requireCountersConfigured,
  requireTenancyConfigured,
  type InspectResult,
  type RotateResult,
  type TenantRow,
} from '../lib/tenant-admin';
import { provisionFromCheckout, tokenHash } from '../lib/tenancy';
import { CACHE_URL, COUNTERS_URL, MockUpstash, TENANCY_URL, installUpstashFetch, setUpstashEnv } from './upstash-mock';

/*
 * Pins the S21 admin-CLI contract (embeds spec §6: "admin CLI (list/rotate/
 * revoke tenants)"). Same test-seam convention as tests/tenancy.unit.spec.ts
 * and tests/pregen-runner.unit.spec.ts: no live Upstash token exists in this
 * environment; MockUpstash + installUpstashFetch/setUpstashEnv IS the seam.
 *
 * lib/tenant-admin.ts's commands are thin callers of lib/tenancy.ts's own
 * primitives (already pinned by tests/tenancy.unit.spec.ts) — these tests
 * focus on what's genuinely new here: row shaping, REDACTION (pinned by
 * test, not just by comment), --yes gating, loud env refusal, and the
 * grep-based bundle-safety self-test.
 */

test.describe.configure({ mode: 'serial' }); // shared env + global-fetch swaps

let restoreFetch: (() => void) | null = null;
let restoreEnv: (() => void) | null = null;

test.afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  restoreEnv?.();
  restoreEnv = null;
});

async function seedTenant(
  tenancy: MockUpstash,
  overrides: Partial<Parameters<typeof provisionFromCheckout>[0]> = {}
) {
  restoreEnv = setUpstashEnv();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: new MockUpstash(), [CACHE_URL]: new MockUpstash(), [TENANCY_URL]: tenancy });
  const ok = await provisionFromCheckout({
    tenantId: 'cus_admin1',
    subscriptionId: 'sub_admin1',
    tier: 'pro',
    orgName: 'Admin Test Org',
    domainAllowlist: ['example.org'],
    subscriptionStatus: 'active',
    ...overrides,
  });
  expect(ok).toBe(true);
}

test('hashPreview: 12 hex chars + ellipsis, never the full 64-char hash', () => {
  const full = 'a'.repeat(64);
  const preview = hashPreview(full);
  expect(preview).toBe('aaaaaaaaaaaa…');
  expect(preview.length).toBe(13); // 12 chars + the ellipsis glyph
  expect(preview).not.toBe(full);
});

test('keyspaceBanner: names the active env prefix (dev in this test env)', () => {
  expect(keyspaceBanner()).toBe('Operating on keyspace: dev');
});

test('requireTenancyConfigured / requireCountersConfigured: null when set, a message when unset', () => {
  expect(requireTenancyConfigured()).toContain('TENANCY database');
  expect(requireCountersConfigured()).toContain('COUNTERS database');
  const restore = setUpstashEnv();
  try {
    expect(requireTenancyConfigured()).toBeNull();
    expect(requireCountersConfigured()).toBeNull();
  } finally {
    restore();
  }
});

test('cmdList: enumerates provisioned tenants via SCAN, shaped rows carry a hash preview only', async () => {
  const tenancy = new MockUpstash();
  await seedTenant(tenancy);
  const rows = await cmdList();
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row.tenantId).toBe('cus_admin1');
  expect(row.subscriptionId).toBe('sub_admin1');
  expect(row.orgName).toBe('Admin Test Org');
  expect(row.tosAcceptedAt).toBe('NOT ON FILE');
  expect(row.tokenHashPreview).toMatch(/^[0-9a-f]{12}…$/);
});

test('cmdList: empty registry returns an empty array, not an error', async () => {
  const tenancy = new MockUpstash();
  restoreEnv = setUpstashEnv();
  restoreFetch = installUpstashFetch({
    [COUNTERS_URL]: new MockUpstash(),
    [CACHE_URL]: new MockUpstash(),
    [TENANCY_URL]: tenancy,
  });
  expect(await cmdList()).toEqual([]);
});

test('cmdInspect: full record + last-3-months impressions (readImpressionsWindow reused verbatim); unknown tenant -> null', async () => {
  const tenancy = new MockUpstash();
  await seedTenant(tenancy);
  const result = (await cmdInspect('cus_admin1')) as InspectResult;
  expect(result).not.toBeNull();
  expect(result.tenant.tenantId).toBe('cus_admin1');
  expect(result.impressions).not.toBeNull();
  expect(result.impressions!.months).toHaveLength(3);

  expect(await cmdInspect('cus_does_not_exist')).toBeNull();
});

test('cmdRotate: mints a new token, writes both keys, deletes the old index; unknown tenant -> null', async () => {
  const tenancy = new MockUpstash();
  await seedTenant(tenancy);
  const before = tenancy.commands.length;

  const result = (await cmdRotate('cus_admin1')) as RotateResult;
  expect(result).not.toBeNull();
  expect(result.plaintextToken).toMatch(/^[0-9a-f]{32}$/);
  expect(result.tokenHashPreview).toBe(hashPreview(tokenHash(result.plaintextToken)));

  // The old token must no longer resolve, and the new one must be
  // rotate()-fresh, not the same as any prior value.
  const commandsAfterRotate = tenancy.commands.slice(before);
  expect(commandsAfterRotate.some((c) => c[0] === 'DEL')).toBe(true);

  expect(await cmdRotate('cus_does_not_exist')).toBeNull();
});

test('cmdRevoke: literally cancelSubscription — no separate code path, tenant becomes non-active', async () => {
  const tenancy = new MockUpstash();
  await seedTenant(tenancy);
  const ok = await cmdRevoke('cus_admin1');
  expect(ok).toBe(true);
  const rows = await cmdList();
  expect(rows[0].subscriptionStatus).toBe('canceled');
});

test('cmdSetAttribution: writes the entitlement field only; unknown tenant -> false', async () => {
  const tenancy = new MockUpstash();
  await seedTenant(tenancy);
  expect(await cmdSetAttribution('cus_admin1', 'none')).toBe(true);
  const rows = await cmdList();
  expect(rows[0].attribution).toBe('none');
  expect(await cmdSetAttribution('cus_does_not_exist', 'none')).toBe(false);
});

test('cmdImpressions: reuses readImpressionsWindow, honors the requested month count', async () => {
  const tenancy = new MockUpstash();
  await seedTenant(tenancy);
  const result = await cmdImpressions('cus_admin1', 5);
  expect(result).not.toBeNull();
  expect(result!.months).toHaveLength(5);
});

// --- redaction, pinned by test -----------------------------------------------

test('formatList: never contains a full 64-char tokenHash or a plaintext token', () => {
  const rows: TenantRow[] = [
    {
      tenantId: 'cus_x',
      subscriptionId: 'sub_x',
      orgName: 'X Org',
      tier: 'pro',
      subscriptionStatus: 'active',
      domainAllowlist: 'x.org',
      tosAcceptedAt: 'NOT ON FILE',
      attribution: 'required',
      tokenHashPreview: hashPreview('b'.repeat(64)),
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  const out = formatList(rows);
  expect(out).toContain('cus_x');
  expect(out).toContain('sub_x');
  expect(out).not.toContain('b'.repeat(64));
  expect(out).not.toMatch(/[0-9a-f]{64}/);
});

test('formatInspect: same redaction rule as formatList', () => {
  const result: InspectResult = {
    tenant: {
      tenantId: 'cus_y',
      subscriptionId: 'sub_y',
      orgName: 'Y Org',
      tier: 'nonprofit',
      subscriptionStatus: 'active',
      domainAllowlist: '(none)',
      tosAcceptedAt: '2026-07-01T00:00:00.000Z',
      attribution: 'required',
      tokenHashPreview: hashPreview('c'.repeat(64)),
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    impressions: { months: [{ month: '2026-07', impressions: 42, partial: true }], total: 42 },
  };
  const out = formatInspect(result);
  expect(out).toContain('cus_y');
  expect(out).not.toMatch(/[0-9a-f]{64}/);
  expect(out).toContain('42');
});

test('formatRotate: shows the plaintext token exactly once, behind the "copy now" banner, plus a hash preview', () => {
  const token = 'f'.repeat(32);
  const result: RotateResult = { plaintextToken: token, tokenHashPreview: hashPreview(tokenHash(token)) };
  const out = formatRotate(result);
  expect(out).toContain('COPY NOW');
  expect(out).toContain(token);
  expect(out.split(token)).toHaveLength(2); // exactly one occurrence
  expect(out).not.toMatch(/[0-9a-f]{64}/); // the hash preview stays truncated even here
});

test('formatImpressions: renders every month plus a total', () => {
  const out = formatImpressions({
    months: [
      { month: '2026-05', impressions: 10, partial: false },
      { month: '2026-06', impressions: 20, partial: true },
    ],
    total: 30,
  });
  expect(out).toContain('2026-05: 10');
  expect(out).toContain('2026-06: 20 (partial)');
  expect(out).toContain('total: 30');
});

// --- main(): argv handling, --yes gating, loud env refusal -------------------

function collectingPrint(): { print: (l: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { print: (l: string) => lines.push(l), lines };
}

test('main(): prints the keyspace banner before doing anything else, on every command', async () => {
  const { print, lines } = collectingPrint();
  await main([], { print });
  expect(lines[0]).toBe('Operating on keyspace: dev');
});

test('main(): refuses loudly (no crash) when the tenancy database is unconfigured', async () => {
  const { print, lines } = collectingPrint();
  const code = await main(['list'], { print });
  expect(code).toBe(1);
  expect(lines.some((l) => l.includes('TENANCY database'))).toBe(true);
});

test('main(): mutating commands refuse without --yes, and proceed with it', async () => {
  const tenancy = new MockUpstash();
  await seedTenant(tenancy);

  const { print: p1, lines: l1 } = collectingPrint();
  const codeWithoutYes = await main(['revoke', 'cus_admin1'], { print: p1 });
  expect(codeWithoutYes).toBe(1);
  expect(l1.some((l) => l.includes('--yes'))).toBe(true);

  const { print: p2, lines: l2 } = collectingPrint();
  const codeWithYes = await main(['revoke', 'cus_admin1', '--yes'], { print: p2 });
  expect(codeWithYes).toBe(0);
  expect(l2.some((l) => l.includes('revoked'))).toBe(true);
});

test('main(): rotate --yes prints the one-time plaintext token via the redacted formatter', async () => {
  const tenancy = new MockUpstash();
  await seedTenant(tenancy);
  const { print, lines } = collectingPrint();
  const code = await main(['rotate', 'cus_admin1', '--yes'], { print });
  expect(code).toBe(0);
  expect(lines.some((l) => l.includes('COPY NOW'))).toBe(true);
});

test('main(): unknown command exits nonzero and prints usage', async () => {
  const tenancy = new MockUpstash();
  await seedTenant(tenancy);
  const { print, lines } = collectingPrint();
  const code = await main(['not-a-real-command'], { print });
  expect(code).toBe(1);
  expect(lines.some((l) => l.includes('unknown command'))).toBe(true);
});

test('main(): set-attribution rejects a garbage entitlement value before ever touching Upstash', async () => {
  const tenancy = new MockUpstash();
  await seedTenant(tenancy);
  const before = tenancy.commands.length;
  const { print, lines } = collectingPrint();
  const code = await main(['set-attribution', 'cus_admin1', 'sometimes', '--yes'], { print });
  expect(code).toBe(1);
  expect(lines.some((l) => l.includes('usage'))).toBe(true);
  expect(tenancy.commands.length).toBe(before); // no wasted round trip
});

test('main(): impressions additionally requires the counters database configured', async () => {
  const tenancy = new MockUpstash();
  restoreEnv = setUpstashEnv();
  restoreFetch = installUpstashFetch({ [COUNTERS_URL]: new MockUpstash(), [CACHE_URL]: new MockUpstash(), [TENANCY_URL]: tenancy });
  await provisionFromCheckout({
    tenantId: 'cus_admin1',
    subscriptionId: 'sub_admin1',
    tier: 'pro',
    orgName: 'Admin Test Org',
    domainAllowlist: [],
    subscriptionStatus: 'active',
  });
  // Now blank ONLY the counters env to prove the additional, command-specific check.
  delete process.env.UPSTASH_COUNTERS_REST_URL;
  delete process.env.UPSTASH_COUNTERS_REST_TOKEN;
  const { print, lines } = collectingPrint();
  const code = await main(['impressions', 'cus_admin1'], { print });
  expect(code).toBe(1);
  expect(lines.some((l) => l.includes('COUNTERS database'))).toBe(true);
});

// --- bundle-safety self-test (grep, mirroring tests/pregen-route-posture.unit.spec.ts) --

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

test('S21 bundle safety: nothing under app/ or components/ references lib/tenant-admin', () => {
  const root = process.cwd();
  const scanDirs = ['app', 'components'].filter((d) => {
    try {
      return statSync(join(root, d)).isDirectory();
    } catch {
      return false;
    }
  });
  const offenders: string[] = [];
  for (const dir of scanDirs) {
    for (const file of walk(join(root, dir))) {
      const source = readFileSync(file, 'utf8');
      if (/tenant-admin/.test(source)) offenders.push(file);
    }
  }
  expect(offenders, `unexpected reference(s) to tenant-admin under app/ or components/: ${offenders.join(', ')}`).toEqual(
    []
  );
});

test('S21 sanity: scripts/tenant-admin.mjs exists and is a thin shim (no command logic of its own)', () => {
  const source = readFileSync(join(process.cwd(), 'scripts/tenant-admin.mjs'), 'utf8');
  expect(source).toMatch(/from '\.\.\/lib\/tenant-admin'/);
  expect(source).not.toMatch(/case 'list'/); // command switch lives in lib/tenant-admin.ts, not here
});

test('S21 sanity: check-key-namespaces gate still passes with the new tenancy functions (SCAN over the existing tenant: key shape only)', () => {
  // Genuine process spawn (not an import) — this gate's own file guards
  // against exactly the "new key shape" class of regression a rotate/list
  // implementation could introduce; running it for real is the only
  // meaningful proof, mirroring how the gate is invoked in CI.
  expect(() => execSync('node scripts/check-key-namespaces.mjs', { cwd: process.cwd(), stdio: 'pipe' })).not.toThrow();
});

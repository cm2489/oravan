import { readImpressionsWindow, type ImpressionMonth } from './impressions';
import {
  cancelSubscription,
  listTenants,
  rotateCapabilityToken,
  setAttributionEntitlement,
  type TenantRecord,
} from './tenancy';
import { countersConfigured, keyPrefix, tenancyConfigured } from './upstash';

/*
 * Owner-only tenant admin CLI logic (S21, embeds spec §6: "admin CLI
 * (list/rotate/revoke tenants)"). Split the same way scripts/pregen-
 * scripts.mjs / lib/pregen-runner.ts already established: scripts/
 * tenant-admin.mjs is a thin tsx shim (argv in, process.exit out);
 * everything else — argument handling, the six commands, and every string
 * this CLI prints — lives here so it's directly importable by unit tests
 * (tests/tenant-admin.unit.spec.ts), the same way pregen-runner.unit.spec.ts
 * imports lib/pregen-runner.ts directly rather than shelling out to the
 * .mjs entrypoint Playwright's own loader doesn't transform.
 *
 * `main()` never calls process.exit itself — it RETURNS an exit code, and
 * the .mjs shim is the only place that actually exits the process. That's
 * what makes this file safely importable from a test runner.
 *
 * STAYING OUT OF THE CLIENT BUNDLE: structural, not just disciplined —
 * nothing under app/ or components/ imports this module, so the Next.js
 * bundler never sees it (there is no route or component that could pull an
 * owner tool with Upstash write access into a page a visitor's browser
 * downloads). tests/tenant-admin.unit.spec.ts pins this with a grep-based
 * self-test mirroring tests/pregen-route-posture.unit.spec.ts's pattern.
 *
 * REDACTION RULE (pinned by test): every command's output shows a tokenHash
 * truncated to 12 hex chars, never the full 64-char hash and never a
 * plaintext token — with exactly one deliberate exception: `rotate`'s own
 * output, which shows the freshly-minted plaintext token exactly once,
 * behind an explicit "copy now" banner, because that's the only moment the
 * plaintext will ever exist anywhere again (lib/tenancy.ts stores only the
 * hash). tenantId (cus_...) and subscriptionId (sub_...) print in full on
 * every command — not secrets, needed as command arguments / a
 * Stripe-dashboard cross-reference.
 *
 * ENVIRONMENT FOOTGUN: keyPrefix() (lib/upstash.ts) resolves to
 * `VERCEL_ENV ?? 'dev'`. Run outside Vercel (a laptop shell), VERCEL_ENV is
 * unset, so this CLI would silently operate on the DEV keyspace unless the
 * owner exports VERCEL_ENV=production first. Mitigation: every invocation
 * prints the keyspace banner below BEFORE doing anything else, and every
 * mutating command additionally requires --yes. No new flag/override
 * plumbing into keyPrefix() itself — that function is shared with the
 * hardened S18 webhook path and isn't touched here.
 */

const HASH_PREVIEW_LEN = 12;

/** Truncate a tokenHash to 12 hex chars for terminal display — hygiene/
 *  scannability, never a security boundary: SHA-256 is preimage-resistant,
 *  so the hash itself was never a bearer credential in the first place. */
export function hashPreview(hash: string): string {
  return `${hash.slice(0, HASH_PREVIEW_LEN)}…`;
}

export function keyspaceBanner(): string {
  return `Operating on keyspace: ${keyPrefix()}`;
}

const MUTATING_COMMANDS = new Set(['rotate', 'revoke', 'set-attribution']);

// Deliberately describe the databases, never spell out their env var names
// literally in this file: scripts/check-key-namespaces.mjs's env-
// confinement rule fires on that literal substring appearing ANYWHERE
// outside lib/upstash.ts, including a comment or a string constant, not
// just an actual `process.env` read — see lib/upstash.ts's own
// tenancyConfigured/countersConfigured doc comment for the exact variable
// names this refers to.

/** Non-null return value = the refusal message to print; null = go ahead. */
export function requireTenancyConfigured(): string | null {
  return tenancyConfigured()
    ? null
    : 'refusing: the TENANCY database is not configured in this process’s env (see lib/upstash.ts for the required variable names).';
}

export function requireCountersConfigured(): string | null {
  return countersConfigured()
    ? null
    : 'refusing: the COUNTERS database is not configured in this process’s env (see lib/upstash.ts for the required variable names).';
}

// --- row shaping (the ONE place a TenantRecord becomes printable text) -----

export interface TenantRow {
  tenantId: string;
  subscriptionId: string;
  orgName: string;
  tier: string;
  subscriptionStatus: string;
  domainAllowlist: string;
  tosAcceptedAt: string;
  attribution: string;
  tokenHashPreview: string;
  createdAt: string;
}

function toRow(t: TenantRecord): TenantRow {
  return {
    tenantId: t.tenantId,
    subscriptionId: t.subscriptionId,
    orgName: t.orgName,
    tier: t.tier,
    subscriptionStatus: t.subscriptionStatus,
    domainAllowlist: t.domainAllowlist.length > 0 ? t.domainAllowlist.join(',') : '(none)',
    tosAcceptedAt: t.tosAcceptedAt ?? 'NOT ON FILE',
    attribution: t.attribution,
    tokenHashPreview: hashPreview(t.tokenHash),
    createdAt: t.createdAt,
  };
}

// --- commands (return data; never print — formatting is a separate step,
//     so tests can assert on structure OR on rendered text independently) --

export async function cmdList(): Promise<TenantRow[]> {
  const tenants = await listTenants();
  return tenants.map(toRow);
}

export interface InspectResult {
  tenant: TenantRow;
  impressions: { months: ImpressionMonth[]; total: number } | null;
}

/** Full record + last 3 months' impressions — readImpressionsWindow reused verbatim. */
export async function cmdInspect(tenantId: string): Promise<InspectResult | null> {
  const tenants = await listTenants();
  const match = tenants.find((t) => t.tenantId === tenantId);
  if (!match) return null;
  let impressions: InspectResult['impressions'] = null;
  if (countersConfigured()) {
    const window = await readImpressionsWindow(tenantId, 3);
    if (window.ok) impressions = { months: window.months, total: window.total };
  }
  return { tenant: toRow(match), impressions };
}

export interface RotateResult {
  tokenHashPreview: string;
  /** Shown exactly once by formatRotate — never logged or stored anywhere else. */
  plaintextToken: string;
}

export async function cmdRotate(tenantId: string): Promise<RotateResult | null> {
  const result = await rotateCapabilityToken(tenantId);
  if (!result) return null;
  return { plaintextToken: result.token, tokenHashPreview: hashPreview(result.tokenHash) };
}

/** Zero new code beyond this thin pass-through — literally cancelSubscription(). */
export function cmdRevoke(tenantId: string): Promise<boolean> {
  return cancelSubscription(tenantId);
}

export type AttributionSetting = 'required' | 'none';

export function cmdSetAttribution(tenantId: string, attribution: AttributionSetting): Promise<boolean> {
  return setAttributionEntitlement(tenantId, attribution);
}

export interface ImpressionsResult {
  months: ImpressionMonth[];
  total: number;
}

export async function cmdImpressions(tenantId: string, months: number): Promise<ImpressionsResult | null> {
  const window = await readImpressionsWindow(tenantId, months);
  return window.ok ? { months: window.months, total: window.total } : null;
}

// --- formatting (pure string builders — the redaction rule lives here) -----

const ROW_FIELDS: (keyof TenantRow)[] = [
  'tenantId',
  'orgName',
  'tier',
  'subscriptionStatus',
  'domainAllowlist',
  'tosAcceptedAt',
  'attribution',
  'tokenHashPreview',
  'subscriptionId',
  'createdAt',
];

export function formatList(rows: TenantRow[]): string {
  if (rows.length === 0) return '(no tenants found)';
  const header = ROW_FIELDS.join('\t');
  const lines = rows.map((r) => ROW_FIELDS.map((f) => r[f]).join('\t'));
  return [header, ...lines].join('\n');
}

export function formatInspect(result: InspectResult): string {
  const t = result.tenant;
  const lines = [
    `tenantId:           ${t.tenantId}`,
    `subscriptionId:     ${t.subscriptionId}`,
    `orgName:            ${t.orgName}`,
    `tier:               ${t.tier}`,
    `subscriptionStatus: ${t.subscriptionStatus}`,
    `domainAllowlist:    ${t.domainAllowlist}`,
    `tosAcceptedAt:      ${t.tosAcceptedAt}`,
    `attribution:        ${t.attribution}`,
    `tokenHash:          ${t.tokenHashPreview}`,
    `createdAt:          ${t.createdAt}`,
  ];
  if (result.impressions) {
    lines.push('impressions (last 3 months):');
    for (const m of result.impressions.months) {
      lines.push(`  ${m.month}: ${m.impressions}${m.partial ? ' (partial)' : ''}`);
    }
    lines.push(`  total: ${result.impressions.total}`);
  } else {
    lines.push('impressions:        unavailable (counters database not configured, or read failed)');
  }
  return lines.join('\n');
}

export function formatRotate(result: RotateResult): string {
  return [
    '=== NEW CAPABILITY TOKEN — COPY NOW. This will never be shown again. ===',
    result.plaintextToken,
    `(tokenHash: ${result.tokenHashPreview})`,
  ].join('\n');
}

export function formatImpressions(result: ImpressionsResult): string {
  const lines = result.months.map((m) => `${m.month}: ${m.impressions}${m.partial ? ' (partial)' : ''}`);
  lines.push(`total: ${result.total}`);
  return lines.join('\n');
}

// --- CLI entry point ---------------------------------------------------------

const USAGE = `usage: tenant-admin <command> [args] [--yes]

commands:
  list                                       enumerate all tenants
  inspect <tenantId>                         full record + last 3 months' impressions
  rotate <tenantId> --yes                    mint a new capability token (shown once)
  revoke <tenantId> --yes                    cancel a tenant's subscription now
  set-attribution <tenantId> <required|none> --yes
                                              write the attribution entitlement (S5a honor system;
                                              wires no widget enforcement — see lib/tenancy.ts)
  impressions <tenantId> [--months N]        full-window impression pull (default 13)

requires the tenancy database configured (all commands) and the counters
database configured (inspect/impressions) in this process's env — see
lib/upstash.ts for the exact variable names.`;

export interface MainDeps {
  print?: (line: string) => void;
}

/** Never calls process.exit — returns the exit code. See file header. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const print = deps.print ?? console.log;
  print(keyspaceBanner());

  const [command, ...rest] = argv;
  const yes = rest.includes('--yes');
  const args = rest.filter((a) => a !== '--yes');

  if (!command) {
    print(USAGE);
    return 0;
  }

  if (command !== 'list' && command !== 'inspect' && command !== 'rotate' && command !== 'revoke' &&
      command !== 'set-attribution' && command !== 'impressions') {
    print(`unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }

  const tenancyErr = requireTenancyConfigured();
  if (tenancyErr) {
    print(tenancyErr);
    return 1;
  }

  if (MUTATING_COMMANDS.has(command) && !yes) {
    print(`refusing: "${command}" mutates tenant state — rerun with --yes to confirm.`);
    return 1;
  }

  switch (command) {
    case 'list': {
      print(formatList(await cmdList()));
      return 0;
    }
    case 'inspect': {
      const tenantId = args[0];
      if (!tenantId) {
        print('usage: inspect <tenantId>');
        return 1;
      }
      const result = await cmdInspect(tenantId);
      if (!result) {
        print(`no tenant found: ${tenantId}`);
        return 1;
      }
      print(formatInspect(result));
      return 0;
    }
    case 'rotate': {
      const tenantId = args[0];
      if (!tenantId) {
        print('usage: rotate <tenantId> --yes');
        return 1;
      }
      const result = await cmdRotate(tenantId);
      if (!result) {
        print(`no tenant found (or rotation failed): ${tenantId}`);
        return 1;
      }
      print(formatRotate(result));
      return 0;
    }
    case 'revoke': {
      const tenantId = args[0];
      if (!tenantId) {
        print('usage: revoke <tenantId> --yes');
        return 1;
      }
      const ok = await cmdRevoke(tenantId);
      print(ok ? `revoked: ${tenantId}` : `revoke failed (tenancy database unreachable): ${tenantId}`);
      return ok ? 0 : 1;
    }
    case 'set-attribution': {
      const [tenantId, setting] = args;
      if (!tenantId || (setting !== 'required' && setting !== 'none')) {
        print('usage: set-attribution <tenantId> <required|none> --yes');
        return 1;
      }
      const ok = await cmdSetAttribution(tenantId, setting);
      print(
        ok
          ? `attribution set to "${setting}" for ${tenantId}`
          : `set-attribution failed (no such tenant, or tenancy database unreachable): ${tenantId}`
      );
      return ok ? 0 : 1;
    }
    case 'impressions': {
      const tenantId = args[0];
      if (!tenantId) {
        print('usage: impressions <tenantId> [--months N]');
        return 1;
      }
      const countersErr = requireCountersConfigured();
      if (countersErr) {
        print(countersErr);
        return 1;
      }
      const monthsIdx = args.indexOf('--months');
      const parsedMonths = monthsIdx >= 0 ? Number(args[monthsIdx + 1]) : 13;
      const months = Number.isFinite(parsedMonths) && parsedMonths > 0 ? Math.min(400, parsedMonths) : 13;
      const result = await cmdImpressions(tenantId, months);
      if (!result) {
        print('impressions read failed (counters database unreachable)');
        return 1;
      }
      print(formatImpressions(result));
      return 0;
    }
    default:
      // Unreachable — the command allowlist check above already returned.
      return 1;
  }
}

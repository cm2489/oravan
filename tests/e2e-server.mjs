/**
 * S19 e2e web-server bootstrap. Test-only infra, never part of the shipped
 * app, never imported by production code — used ONLY by
 * playwright.config.ts's `webServer.command`.
 *
 * WHY THIS EXISTS: `app/embed/action-panel/page.tsx` and the live
 * `X-Oravan-Key` check in `app/api/script/route.ts` both need a resolvable
 * tenant record to reach their "authorized" branch. This sandbox has no
 * real Upstash credentials (by design — see tests/upstash-mock.ts's header
 * comment), and Playwright's own task ordering starts `webServer` BEFORE
 * any `globalSetup` hook runs, so a `globalSetup`-based fake-Upstash
 * couldn't set env the webServer process would ever see. The fix: BE the
 * webServer command. This script starts a tiny in-process HTTP server that
 * speaks just enough of the Upstash REST command surface (GET/SET/DEL —
 * the only three lib/tenancy.ts's read/write paths ever send), seeds four
 * fixture tenants (tests/fixtures/e2e-tenant.ts — one per degraded-state-
 * vs-live branch: active+ToS+empty-allowlist, active+no-ToS,
 * inactive/revoked, and active+ToS+non-empty-allowlist for the domain
 * check), points `UPSTASH_TENANCY_REST_URL`/`TOKEN` at it, and only THEN
 * execs `npm run build && next start` as its own child so the child
 * inherits that env.
 *
 * Deliberately narrow: ONLY the tenancy database gets a live (fake)
 * backend. Counters and cache stay completely unconfigured, exactly as
 * every other e2e test in this suite has always run — this changes
 * nothing observable for any pre-S19 test (nothing before S19 ever sends
 * an X-Oravan-Key header or loads /embed/action-panel).
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  E2E_TENANT_DOMAIN_ALLOWLIST,
  E2E_TENANT_ID,
  E2E_TENANT_ID_DOMAIN_GATED,
  E2E_TENANT_ID_INACTIVE,
  E2E_TENANT_ID_NO_TOS,
  E2E_TENANT_ORG_NAME,
  E2E_TENANT_TOKEN,
  E2E_TENANT_TOKEN_DOMAIN_GATED,
  E2E_TENANT_TOKEN_INACTIVE,
  E2E_TENANT_TOKEN_NO_TOS,
} from './fixtures/e2e-tenant.ts';

const PORT = process.env.PW_PORT ?? '3300';

// --- the fake Upstash REST surface: GET / SET / DEL over a plain Map -------

const store = new Map();

function exec(command) {
  const [op, ...args] = command;
  switch (op) {
    case 'GET':
      return store.has(args[0]) ? store.get(args[0]) : null;
    case 'SET':
      store.set(args[0], args[1]);
      return 'OK';
    case 'DEL':
      return store.delete(args[0]) ? 1 : 0;
    default:
      return null;
  }
}

// keyPrefix() (lib/upstash.ts) is `process.env.VERCEL_ENV ?? 'dev'` — 'dev'
// in every local/sandbox run, matching what every unit spec already assumes.
function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

/** Seed one tenant record + its token reverse-index, mirroring provisionFromCheckout's shape. */
function seedTenant({ token, tenantId, orgName, domainAllowlist, subscriptionStatus, tosAcceptedAt }) {
  const hash = tokenHash(token);
  store.set(
    `dev:tenant:${tenantId}`,
    JSON.stringify({
      tenantId,
      tokenHash: hash,
      tier: 'pro',
      domainAllowlist,
      orgName,
      attribution: 'required',
      createdAt: new Date().toISOString(),
      subscriptionId: `sub_${tenantId}`,
      subscriptionStatus,
      ...(tosAcceptedAt ? { tosAcceptedAt } : {}),
    })
  );
  store.set(`dev:token:${hash}`, tenantId);
}

// Four tenants, one per degraded-state-vs-live branch — see
// tests/fixtures/e2e-tenant.ts's header comment for which is which.
seedTenant({
  token: E2E_TENANT_TOKEN,
  tenantId: E2E_TENANT_ID,
  orgName: E2E_TENANT_ORG_NAME,
  domainAllowlist: [],
  subscriptionStatus: 'active',
  tosAcceptedAt: new Date().toISOString(),
});
seedTenant({
  token: E2E_TENANT_TOKEN_NO_TOS,
  tenantId: E2E_TENANT_ID_NO_TOS,
  orgName: 'S19 E2E No-ToS Fixture Org',
  domainAllowlist: [],
  subscriptionStatus: 'active',
  tosAcceptedAt: null, // the point of this fixture
});
seedTenant({
  token: E2E_TENANT_TOKEN_INACTIVE,
  tenantId: E2E_TENANT_ID_INACTIVE,
  orgName: 'S19 E2E Inactive Fixture Org',
  domainAllowlist: [],
  subscriptionStatus: 'canceled',
  tosAcceptedAt: new Date().toISOString(),
});
seedTenant({
  token: E2E_TENANT_TOKEN_DOMAIN_GATED,
  tenantId: E2E_TENANT_ID_DOMAIN_GATED,
  orgName: 'S19 E2E Domain-Gated Fixture Org',
  domainAllowlist: E2E_TENANT_DOMAIN_ALLOWLIST,
  subscriptionStatus: 'active',
  tosAcceptedAt: new Date().toISOString(),
});

const upstash = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let command;
    try {
      command = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: exec(command) }));
  });
});

upstash.listen(0, '127.0.0.1', () => {
  const { port } = upstash.address();
  const child = spawn('sh', ['-c', `npm run build && npx next start -p ${PORT}`], {
    stdio: 'inherit',
    env: {
      ...process.env,
      UPSTASH_TENANCY_REST_URL: `http://127.0.0.1:${port}`,
      UPSTASH_TENANCY_REST_TOKEN: 'e2e-fixture-token',
    },
  });

  const forward = (signal) => child.kill(signal);
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGINT', () => forward('SIGINT'));

  child.on('exit', (code) => {
    upstash.close();
    process.exit(code ?? 0);
  });
});

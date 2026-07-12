/**
 * S19 e2e fixture constants — the tenants `tests/e2e-server.mjs` seeds into
 * its tiny in-process fake tenancy database before the real Next.js server
 * (`next build && next start`) boots, pointed at it via
 * UPSTASH_TENANCY_REST_URL/TOKEN. This is what makes genuinely LIVE
 * "valid token -> the action panel actually renders" e2e coverage possible
 * in this sandbox, which has no real Upstash credentials by design (same
 * "no live tokens exist anywhere in the test environment" rule
 * tests/upstash-mock.ts's header comment states for the unit specs).
 *
 * Kept in their own file (not inlined in tests/e2e-server.mjs) so ordinary
 * *.spec.ts files can import the plaintext tokens/tenantIds without also
 * pulling in the bootstrap script's node:http/node:child_process code.
 *
 * Every token's sha256 MUST match what tests/e2e-server.mjs seeds — both
 * files hardcode the same 32-hex-char values on purpose (a real capability
 * token is never derived from anything else, so there is no "compute it"
 * shortcut that wouldn't just be reimplementing mintCapabilityToken for a
 * fixture that needs to stay constant across runs anyway).
 *
 * Four tenants, one per degraded-state-vs-live branch resolveTenantAccess
 * / the domain check can take — see tests/embed-action-panel.spec.ts:
 *   MAIN          active, ToS accepted, empty allowlist -> Live.
 *   NO_TOS        active, ToS NOT accepted -> tos_required.
 *   INACTIVE      subscriptionStatus 'canceled' -> unauthorized (revoked).
 *   DOMAIN_GATED  active, ToS accepted, allowlist=['example.org'] -> Live
 *                 when no Referer is sent (direct navigation), but "domain
 *                 not authorized" through a genuine cross-origin iframe
 *                 host (tests/helpers.ts's startCrossOriginHost, which
 *                 always presents as an IP-literal origin registrableDomain
 *                 can never resolve to 'example.org' either).
 */
export const E2E_TENANT_TOKEN = '472b9b7cc7475c85dedbba7a1202a5ea';
export const E2E_TENANT_ID = 'cus_e2e_fixture';
export const E2E_TENANT_ORG_NAME = 'S19 E2E Fixture Org';

export const E2E_TENANT_TOKEN_NO_TOS = 'ae19c2a4b1d0470f9a5e2c6b8d3f1047';
export const E2E_TENANT_ID_NO_TOS = 'cus_e2e_fixture_no_tos';

export const E2E_TENANT_TOKEN_INACTIVE = '0c4f7b2e9a1d4c6f8b3e5a7d9c1f2e40';
export const E2E_TENANT_ID_INACTIVE = 'cus_e2e_fixture_inactive';

export const E2E_TENANT_TOKEN_DOMAIN_GATED = '7d1e3a5c9f2b4d6e8a0c1f3b5d7e9a20';
export const E2E_TENANT_ID_DOMAIN_GATED = 'cus_e2e_fixture_domain_gated';
export const E2E_TENANT_DOMAIN_ALLOWLIST = ['example.org'];

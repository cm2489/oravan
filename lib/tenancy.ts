import { createHash, randomBytes } from 'node:crypto';
import { keyPrefix, noteUpstashError, tenancyClient, type UpstashClient } from './upstash';

/*
 * Institutional tenant registry (S18) — the TENANCY database's only
 * registry module, gated by scripts/check-key-namespaces.mjs the same way
 * lib/ratelimit.ts, lib/scriptcache.ts, and lib/embed-referrer.ts gate the
 * counters/cache database. This module is the ONLY place tenancy-database
 * keys are built, and the ONLY place outside lib/upstash.ts allowed to call
 * tenancyClient() — every other caller (the Stripe webhook route) imports
 * functions FROM here, never touches the client directly.
 *
 * Stripe is the system of record for tenant identity/billing (embeds spec
 * §3.1). This database is not itself a system of record — it is a fast,
 * request-path-readable CACHE of a subset of Stripe's state, kept in sync by
 * app/api/stripe/webhook/route.ts and fully reconstructable from Stripe if
 * lost. That is why it's durable (no TTL on tenant/token records) rather
 * than short-lived like the counters database, and why it is its own
 * physical database rather than a namespace of an existing one — see
 * lib/upstash.ts's header comment for the full "who + what re-pairing"
 * argument.
 *
 * Key registry — the only shapes ever written to the tenancy database:
 *
 *   <env>:tenant:<tenantId>      -> JSON TenantRecord  (primary; tenantId =
 *                                    Stripe customer id, cus_... — an
 *                                    INTERNAL-ONLY identifier, never placed
 *                                    in a URL)
 *   <env>:token:<sha256(token)>  -> tenantId             (reverse index;
 *                                    THIS is what a presented capability
 *                                    token resolves through. DEL'd on
 *                                    revocation — see lookupTenantByToken)
 *   <env>:stripe-event:<id>      -> "1", TTL 7d           (webhook
 *                                    idempotency marker; comfortably exceeds
 *                                    Stripe's ~3-day retry window)
 *
 * The CAPABILITY TOKEN — not the tenant ID — is the bearer credential that
 * appears in a paid embed URL (embeds spec §3.2). Storage is hashed, never
 * plaintext: a leaked tenancy-DB record must not itself be a usable
 * credential, and the spec already designs around one-click rotation as the
 * theft mitigation, so "we can never redisplay the old plaintext" costs
 * nothing (mintCapabilityToken/tokenHash are the same two primitives a
 * future admin-CLI "rotate" command would call, not new code).
 *
 * No caller-derived material (IP, forwarded, caller hash, salt, address,
 * ZIP) may ever appear in a tenancy key — tenant config is institutional,
 * not caller data, and must never blur into the caller-keyed doctrine any
 * more than it may blur into the content-keyed one. CI enforces this with a
 * tenancy-specific rule mirroring the cache database's caller-material check
 * (scripts/check-key-namespaces.mjs).
 *
 * ATTRIBUTION HONOR-SYSTEM BREADCRUMB (docs/migration/decisions.md, S5a,
 * ~L131): that entry documents `data-attribution="none"` as
 * "licensed-partner-only (honor system until the tenant registry exists —
 * stated plainly on /embeds)". This file IS that registry, and S19 (below)
 * wires the FIRST live embed route read of it (the action panel) — but
 * still does NOT flip attribution-field enforcement on: the action panel
 * doesn't check an incoming request's token against the `attribution`
 * field before honoring that widget's own `attribution` query param
 * either. The S19 design doc this sprint implements is silent on that
 * wiring, so it stays deliberately out of scope here rather than being
 * invented unprompted — flagged in the PR body for an explicit owner call.
 * Per the standing append-only rule for decisions.md, don't edit the S5a
 * entry itself; a new dated entry closing the honor-system caveat belongs
 * to whichever PR actually wires the enforcement.
 *
 * S19 additions: `TenantRecord.tosAcceptedAt` (optional — see below) plus
 * `resolveTenantAccess`, the ONE shared gate both `app/api/script` and
 * `app/embed/action-panel/page.tsx` call so the "no token / bad token /
 * inactive / no ToS on file" checks can never drift into two different
 * implementations between the API route and the widget page.
 */

// --- token lifecycle ---------------------------------------------------------

const TOKEN_BYTES = 16; // 128 bits of CSPRNG output — same primitive/size as
// lib/ratelimit.ts's SALT_BYTES; reusing it means no new randomness-source
// decision. Hex (not base64url) matches the salt's own .toString('hex')
// encoding and needs no URL-encoding handling.

/** Mint a new 128-bit capability token, hex-encoded (32 lowercase chars). */
export function mintCapabilityToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/** sha256(token) hex — the actual Redis key, never a value compared against. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// --- tenancy-database key builders (the whole registry) --------------------

const STRIPE_EVENT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7d — exceeds Stripe's ~3-day retry window

export function tenantKey(tenantId: string): string {
  return `${keyPrefix()}:tenant:${tenantId}`;
}

export function tokenIndexKey(hash: string): string {
  return `${keyPrefix()}:token:${hash}`;
}

export function stripeEventKey(eventId: string): string {
  return `${keyPrefix()}:stripe-event:${eventId}`;
}

// --- record shape -------------------------------------------------------------

export type TenantTier = 'pro' | 'nonprofit' | 'network';
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid';

export interface TenantRecord {
  tenantId: string; // Stripe customer id (cus_...) — internal only, never in a URL
  tokenHash: string; // sha256(plaintext token) hex — mirrors the token:<hash> key
  tier: TenantTier;
  domainAllowlist: string[]; // registrable domains, lowercase, normalized before storage
  orgName: string;
  // Entitlement, NOT a live enforcement flag (see this file's header
  // comment) — "none" is licensed-partner-only per S5a and is never granted
  // by this file's own self-serve checkout path (see provisionFromCheckout).
  attribution: 'required' | 'none';
  createdAt: string; // ISO-8601
  subscriptionId: string; // sub_... — for correlating future subscription.* events
  subscriptionStatus: SubscriptionStatus;
  /**
   * ISO-8601, set the moment Stripe Checkout's own consent_collection
   * reports acceptance (S19, §3). OPTIONAL — absent, not a parse failure —
   * because every tenant S18 has ever provisioned predates this field
   * (STRIPE_WEBHOOK_SECRET has been unset in every environment since S18
   * shipped) and must still round-trip cleanly. "Absent" is read by
   * resolveTenantAccess below as "ToS not on file yet", never invented and
   * never defaulted to a timestamp.
   */
  tosAcceptedAt?: string;
}

const VALID_TIERS: TenantTier[] = ['pro', 'nonprofit', 'network'];
const VALID_STATUSES: SubscriptionStatus[] = ['active', 'trialing', 'past_due', 'canceled', 'unpaid'];
/** active/trialing = the token authorizes; everything else does not (S18/S19). */
export const ACTIVE_STATUSES: SubscriptionStatus[] = ['active', 'trialing'];

/** Parse-or-reject, matching lib/ratelimit.ts's parseSaltRecord style. */
export function parseTenantRecord(raw: string): TenantRecord | null {
  try {
    const p = JSON.parse(raw) as Partial<TenantRecord>;
    if (typeof p.tenantId !== 'string' || p.tenantId.length === 0) return null;
    if (typeof p.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(p.tokenHash)) return null;
    if (typeof p.tier !== 'string' || !VALID_TIERS.includes(p.tier as TenantTier)) return null;
    if (!Array.isArray(p.domainAllowlist) || !p.domainAllowlist.every((d) => typeof d === 'string')) return null;
    if (typeof p.orgName !== 'string') return null;
    if (p.attribution !== 'required' && p.attribution !== 'none') return null;
    if (typeof p.createdAt !== 'string') return null;
    if (typeof p.subscriptionId !== 'string') return null;
    if (typeof p.subscriptionStatus !== 'string' || !VALID_STATUSES.includes(p.subscriptionStatus as SubscriptionStatus)) {
      return null;
    }
    // Optional-if-absent (S19): a missing key is fine (every pre-S19 record
    // lacks it) — only a PRESENT-but-wrong-typed value is a parse failure.
    if (p.tosAcceptedAt !== undefined && typeof p.tosAcceptedAt !== 'string') return null;
    return {
      tenantId: p.tenantId,
      tokenHash: p.tokenHash,
      tier: p.tier as TenantTier,
      domainAllowlist: p.domainAllowlist as string[],
      orgName: p.orgName,
      attribution: p.attribution,
      createdAt: p.createdAt,
      subscriptionId: p.subscriptionId,
      subscriptionStatus: p.subscriptionStatus as SubscriptionStatus,
      ...(p.tosAcceptedAt !== undefined ? { tosAcceptedAt: p.tosAcceptedAt } : {}),
    };
  } catch {
    return null;
  }
}

async function getTenantRecord(client: UpstashClient, tenantId: string): Promise<TenantRecord | null> {
  const raw = await client.cmd(['GET', tenantKey(tenantId)]);
  return typeof raw === 'string' ? parseTenantRecord(raw) : null;
}

// --- the S19 read path (S18 ships it now; nothing calls it yet) ------------

/**
 * Resolve a presented capability token to its tenant record, or null.
 *
 * FAIL CLOSED — the one deliberate divergence from this codebase's usual
 * philosophy. Every other Upstash-backed thing here (the counters- and
 * cache-database callers) fails OPEN to in-memory behavior when Upstash is
 * unreachable, because degrading there just means less-durable rate
 * limiting or a cache miss — both acceptable. This function must NEVER do
 * that: on any Upstash error, parse failure, or unconfigured env, it
 * returns null (not authorized), never "skip the check". Failing open here
 * would mean a paid-tier feature (the action panel, S19) silently opens to
 * everyone the moment Upstash hiccups — a straightforward authorization
 * hole dressed up as graceful degradation. Do not "fix" this into fail-open
 * by mistaken consistency with this file's neighbors.
 *
 * No caching layer in S18 (every lookup hits Upstash fresh, mirroring
 * createRateLimiter/ScriptCache's per-call resolution) — so for S18's own
 * purposes the revocation-propagation bound is effectively zero. If a later
 * sprint adds an in-memory read-through cache for cost/volume reasons, THAT
 * layer must declare its own explicit TTL (recommend ≤60s); S18 does not
 * invent caching it doesn't need yet.
 */
export async function lookupTenantByToken(token: string): Promise<TenantRecord | null> {
  const client = tenancyClient();
  if (!client) return null; // unconfigured — fail closed, not "skip the check"
  try {
    const hash = tokenHash(token);
    const tenantId = await client.cmd(['GET', tokenIndexKey(hash)]);
    if (typeof tenantId !== 'string' || tenantId.length === 0) return null;
    return await getTenantRecord(client, tenantId);
  } catch (err) {
    noteUpstashError('tenancy', err);
    return null; // fail closed on any Upstash error too
  }
}

// --- webhook idempotency ------------------------------------------------------

export type StripeEventClaim = 'claimed' | 'duplicate' | 'unavailable';

/**
 * Atomically claim a Stripe event id for processing: `SET NX EX 604800`
 * (the exact primitive lib/ratelimit.ts's salt creation already proves — no
 * new pattern). 'claimed' = first delivery, go ahead and process. 'duplicate'
 * = already processed (or a concurrent delivery is mid-flight) — the caller
 * should return 200 without reprocessing. 'unavailable' = the tenancy
 * database isn't configured/reachable — the caller should fail the request
 * (not silently succeed) so Stripe's own retry schedule gets another chance
 * once Upstash recovers.
 */
export async function claimStripeEvent(eventId: string): Promise<StripeEventClaim> {
  const client = tenancyClient();
  if (!client) return 'unavailable';
  try {
    const created = await client.cmd([
      'SET',
      stripeEventKey(eventId),
      '1',
      'NX',
      'EX',
      String(STRIPE_EVENT_TTL_SECONDS),
    ]);
    return created === 'OK' ? 'claimed' : 'duplicate';
  } catch (err) {
    noteUpstashError('tenancy', err);
    return 'unavailable';
  }
}

/**
 * Release a previously-successful claimStripeEvent claim. Callers use this
 * ONLY when a claim was won ('claimed') but the actual processing that
 * followed it failed (provisionFromCheckout/updateSubscriptionStatus/
 * cancelSubscription returned false) — otherwise a transient Upstash hiccup
 * on the processing write, landing in the split second after a successful
 * claim write, would permanently swallow the event: the claim marker
 * survives for its full 7-day TTL, so Stripe's own retry (which exists
 * specifically to recover from exactly this kind of transient failure)
 * would see 'duplicate' and return 200 without ever actually provisioning
 * the paying customer.
 *
 * Best-effort: if the DEL itself fails (e.g. Upstash is still down), this
 * silently does nothing more than log — there is no worse fallback than
 * "the 7-day TTL eventually expires on its own", and the caller has already
 * returned (or is about to return) a non-2xx response, so Stripe will keep
 * retrying on its own schedule regardless.
 */
export async function releaseStripeEventClaim(eventId: string): Promise<void> {
  const client = tenancyClient();
  if (!client) return;
  try {
    await client.cmd(['DEL', stripeEventKey(eventId)]);
  } catch (err) {
    noteUpstashError('tenancy', err);
  }
}

// --- provisioning (checkout.session.completed) ------------------------------

export interface ProvisionFromCheckoutInput {
  tenantId: string; // Stripe customer id
  subscriptionId: string;
  tier: TenantTier;
  orgName: string;
  domainAllowlist: string[]; // already-normalized registrable domains
  subscriptionStatus: SubscriptionStatus;
  /**
   * ISO-8601, present ONLY when this exact checkout event carried Stripe's
   * own consent_collection.terms_of_service acceptance (S19, §3) — never
   * invented, never defaulted. Absent (undefined) means "this checkout
   * didn't tell us", not "not accepted" — see provisionFromCheckout's own
   * accept-and-fill-forward doc comment for what that does to an existing
   * record.
   */
  tosAcceptedAt?: string;
}

/**
 * checkout.session.completed provisioning. If `tenant:<tenantId>` doesn't
 * yet exist, mints a new token and writes both keys. If it DOES exist (a
 * returning customer checking out again, e.g. an upgrade — OR a churned
 * customer resubscribing under the same Stripe customer id) updates
 * tier/domainAllowlist/orgName/subscriptionId/subscriptionStatus in place
 * and KEEPS the existing token's plaintext/hash unchanged — a live embed
 * snippet must not silently break on a plan change.
 *
 * That "must not silently break" promise also has to cover reactivation:
 * updateSubscriptionStatus's revocation path DELetes the `token:<hash>`
 * reverse-index but deliberately leaves the tenant record's `tokenHash`
 * field alone (see that function). So a resubscribing customer lands here
 * with an existing tenant record whose token index may or may not still
 * exist. The token-index SET below is therefore UNCONDITIONAL, not
 * gated on "only for brand-new tenants" — cheap and idempotent when the
 * index is already there (still-active customer, plan change), and the
 * only thing that actually restores a paying customer's embed when it
 * isn't (a churn-then-resubscribe cycle under the same customer id). No
 * new token is minted for reactivation: the customer's original snippet
 * still carries the one plaintext token that hashes to `existing.tokenHash`,
 * so re-pointing that exact hash's index entry is sufficient and doesn't
 * require ever knowing the plaintext again.
 *
 * tosAcceptedAt (S19): "accept-and-fill-forward, never regress set→unset".
 *   - New tenant, input carries consent  -> set it on the fresh record.
 *   - New tenant, input has no consent   -> record exists, field stays unset
 *     (the action panel refuses per resolveTenantAccess below until it's
 *     captured some other way).
 *   - Returning tenant, already accepted -> PRESERVED regardless of what
 *     this checkout carries — a plan change is a different event from ToS
 *     acceptance, and must never clear a previously-set timestamp.
 *   - Returning tenant, never accepted, this checkout DOES carry consent ->
 *     filled in now. Never the other direction (set -> unset).
 *
 * Returns false only when the tenancy database itself is unconfigured or
 * unreachable (the caller decides the HTTP response from that).
 */
export async function provisionFromCheckout(input: ProvisionFromCheckoutInput): Promise<boolean> {
  const client = tenancyClient();
  if (!client) return false;
  try {
    const key = tenantKey(input.tenantId);
    const existing = await getTenantRecord(client, input.tenantId);

    if (existing) {
      const tosAcceptedAt = existing.tosAcceptedAt ?? input.tosAcceptedAt;
      const updated: TenantRecord = {
        ...existing,
        tier: input.tier,
        domainAllowlist: input.domainAllowlist,
        orgName: input.orgName,
        subscriptionId: input.subscriptionId,
        subscriptionStatus: input.subscriptionStatus,
        ...(tosAcceptedAt !== undefined ? { tosAcceptedAt } : {}),
      };
      await client.cmd(['SET', key, JSON.stringify(updated)]);
      // Restore/keep the reverse-index for the UNCHANGED token — see the
      // doc comment above for why this must not be conditional.
      await client.cmd(['SET', tokenIndexKey(existing.tokenHash), input.tenantId]);
      return true;
    }

    const token = mintCapabilityToken();
    const hash = tokenHash(token);
    const record: TenantRecord = {
      tenantId: input.tenantId,
      tokenHash: hash,
      tier: input.tier,
      domainAllowlist: input.domainAllowlist,
      orgName: input.orgName,
      // Self-serve checkout never grants full attribution removal — see
      // this file's header comment (S5a honor-system breadcrumb).
      attribution: 'required',
      createdAt: new Date().toISOString(),
      subscriptionId: input.subscriptionId,
      subscriptionStatus: input.subscriptionStatus,
      ...(input.tosAcceptedAt !== undefined ? { tosAcceptedAt: input.tosAcceptedAt } : {}),
    };
    await client.cmd(['SET', key, JSON.stringify(record)]);
    await client.cmd(['SET', tokenIndexKey(hash), input.tenantId]);
    return true;
  } catch (err) {
    noteUpstashError('tenancy', err);
    return false;
  }
}

// --- lifecycle sync (customer.subscription.updated|deleted) ----------------
// S19 note: this function is DELIBERATELY untouched — tosAcceptedAt is only
// ever set at checkout time (provisionFromCheckout above), never here. See
// this sprint's "constraint S19 must still honor" note: keeping the
// unguarded get->merge->SET race scoped to exactly the two functions it's
// already scoped to today, not spreading it into a third.

/**
 * customer.subscription.updated: map Stripe's status onto the tenant record.
 * active/trialing keep (or RESTORE — see below) the token authorizing.
 * Anything else (past_due, unpaid, canceled, incomplete_expired, and any
 * other Stripe status this codebase doesn't enumerate) is treated as
 * inactive — the status field is updated and the token:<hash> reverse-index
 * key is DELeted immediately (a single-key atomic operation; there is no
 * propagation delay to reason about — revocation is effectively
 * instantaneous at the storage layer).
 *
 * REACTIVATION restores the same index entry (idempotent SET, not just a
 * DEL's mirror image): Stripe's own payment-retry/dunning flow recovers a
 * past_due subscription by emitting exactly this event with status='active'
 * once a retried charge succeeds — no new checkout.session.completed fires
 * for that recovery, so provisionFromCheckout is never in the picture. If
 * this function only ever DELeted on the way out and never restored on the
 * way back in, that (very common — it's Stripe's default dunning behavior)
 * recovery path would leave a paying, active-status customer's embed
 * permanently broken with no event left to fix it. tokenHash itself never
 * changes here, so restoring is a re-SET of the same hash's index entry,
 * not a new token mint — cheap and harmless when the index was never
 * removed in the first place (the common case: no status change at all,
 * or an active→trialing-style move that was never inactive to begin with).
 *
 * No-op (returns true) if no tenant record exists yet for this customer —
 * not this webhook's problem; nothing was ever provisioned, or it's already
 * gone. Returns false only on a tenancy-database failure.
 */
export async function updateSubscriptionStatus(tenantId: string, rawStatus: string): Promise<boolean> {
  const client = tenancyClient();
  if (!client) return false;
  try {
    const existing = await getTenantRecord(client, tenantId);
    if (!existing) return true;

    const isActive = ACTIVE_STATUSES.includes(rawStatus as SubscriptionStatus);
    const knownInactive: SubscriptionStatus[] = ['past_due', 'unpaid', 'canceled'];
    const status: SubscriptionStatus = isActive
      ? (rawStatus as SubscriptionStatus)
      : knownInactive.includes(rawStatus as SubscriptionStatus)
        ? (rawStatus as SubscriptionStatus)
        : 'canceled'; // safe inactive default for any status this union doesn't enumerate

    await client.cmd(['SET', tenantKey(tenantId), JSON.stringify({ ...existing, subscriptionStatus: status })]);
    if (isActive) {
      await client.cmd(['SET', tokenIndexKey(existing.tokenHash), tenantId]);
    } else {
      await client.cmd(['DEL', tokenIndexKey(existing.tokenHash)]);
    }
    return true;
  } catch (err) {
    noteUpstashError('tenancy', err);
    return false;
  }
}

/** customer.subscription.deleted: unconditionally canceled + token revoked. */
export function cancelSubscription(tenantId: string): Promise<boolean> {
  return updateSubscriptionStatus(tenantId, 'canceled');
}

// --- the S19 paid-embed access gate -----------------------------------------

export type TenantAccessResult =
  | { ok: true; tenant: TenantRecord }
  | { ok: false; reason: 'unauthorized' }
  | { ok: false; reason: 'tos_required' };

/**
 * THE shared paid-embed access gate (S19, §1 + §3) — `app/api/script`
 * (the live X-Oravan-Key check) and `app/embed/action-panel/page.tsx` (the
 * render-state resolution) both call this ONE function rather than each
 * re-implementing "no token / bad token / inactive / no ToS on file", so
 * the two call sites can never drift into disagreeing about who's
 * authorized. The domain-allowlist check is NOT here — that's a
 * page-only, best-effort, Referer-based check with no equivalent at the
 * API layer (see the page's own comment for why) — this function only
 * ever answers the token/subscription/ToS question.
 *
 * Deliberately collapses "bad token", "revoked token", and "Upstash
 * momentarily down" into the SAME `unauthorized` outcome — the fail-closed
 * doctrine's own point (lookupTenantByToken's doc comment) is that these
 * must be indistinguishable to the caller, and a finer-grained result here
 * would only help token-probing. `tos_required` is the one deliberately
 * DISTINCT outcome: unlike identity or security kind, "ToS not on file" is
 * actionable and leaks nothing a prober can exploit.
 *
 * A present-but-invalid token is NEVER treated as "absent" — there is no
 * silent downgrade to an anonymous/citizen path here. This function has no
 * concept of an anonymous caller at all; `token === null` is simply one
 * more way to fail closed to `unauthorized`, exactly like a bad or revoked
 * one. Callers that also serve an anonymous path (the script route) decide
 * that branching themselves, before ever calling this function.
 */
export async function resolveTenantAccess(token: string | null): Promise<TenantAccessResult> {
  if (!token) return { ok: false, reason: 'unauthorized' };
  const tenant = await lookupTenantByToken(token);
  if (!tenant) return { ok: false, reason: 'unauthorized' };
  if (!ACTIVE_STATUSES.includes(tenant.subscriptionStatus)) return { ok: false, reason: 'unauthorized' };
  if (!tenant.tosAcceptedAt) return { ok: false, reason: 'tos_required' };
  return { ok: true, tenant };
}

// --- the S20 impression-counting gate (deliberately narrower than resolveTenantAccess) --

/**
 * Active-subscription check only — no ToS gate. Used by lib/impressions.ts's
 * rep-lookup/bill-card token path (S20, §1) and by the tenant read endpoint
 * (app/api/tenant/impressions), NOT by the action panel or /api/script
 * (those two keep calling resolveTenantAccess, unchanged).
 *
 * Why not just reuse resolveTenantAccess: tosAcceptedAt is Stripe Checkout's
 * consent_collection acceptance, gating the one feature that puts
 * AI-generated text in front of a phone call (action panel / /api/script).
 * Rep-lookup and bill-card carry no AI-generated content and have never
 * required ToS. More concretely, the ToS URL is not yet configured in
 * Stripe (see resolveTenantAccess's own PR history) — every tenant
 * provisioned before that lands has tosAcceptedAt unset. Gating impression
 * COUNTING (or a tenant reading their own metering) on it would silently
 * zero out every Pro tenant's white-label numbers until an unrelated Stripe
 * dashboard step is done — the opposite of the honest disclosure this
 * feature exists to provide.
 *
 * Same fail-closed doctrine as lookupTenantByToken: absent token, unknown
 * token, revoked token, and an unreachable tenancy database all collapse to
 * `null` here — never a thrown error, never a distinguishable outcome a
 * prober could use to map token validity.
 */
export async function activeTenantForImpression(token: string | null): Promise<TenantRecord | null> {
  if (!token) return null;
  const tenant = await lookupTenantByToken(token);
  if (!tenant || !ACTIVE_STATUSES.includes(tenant.subscriptionStatus)) return null;
  return tenant;
}

// --- S21 admin-CLI primitives (list / rotate / set-attribution) -------------
//
// scripts/tenant-admin.mjs (lib/tenant-admin.ts) is the only caller of this
// section — an owner-only, interactive CLI (embeds spec §6: "admin CLI
// (list/rotate/revoke tenants)"). `revoke` needs no new code here: it's
// literally cancelSubscription() above, already exported. This section adds
// the two genuinely new primitives (list, rotate) plus one entitlement
// writer (set-attribution) that closes a real gap — no code path before this
// ever set attribution: 'none' (provisionFromCheckout hardcodes 'required'),
// so a hand-negotiated network deal had no way to be recorded at all.

const TENANT_KEY_PREFIX_SEGMENT = 'tenant:';
// Bounded, not "loop until Redis says done": a pathological SCAN response
// (a cursor that never returns to '0', e.g. a mocked or misbehaving backend)
// must not hang an interactive CLI forever. At the tenant counts this
// product will ever see (embeds spec §5: "100 tenants" is the modeled
// ceiling), one page already covers everything in practice — this is a
// safety cap, not a real limit.
const SCAN_MAX_ITERATIONS = 1000;
const SCAN_COUNT_HINT = '100';

/**
 * SCAN, not a maintained `<env>:tenants` index Set — deliberately. A
 * maintained index would need a new SADD in provisionFromCheckout's
 * new-tenant branch, touching the S18 webhook path (already adversarially
 * hardened three times over — see that function's own doc comments) for an
 * owner-tooling feature that doesn't need request-path speed. SCAN is
 * self-healing (no second source of truth to drift) and introduces NO new
 * key shape: it reads the existing, already-registered `tenant:<tenantId>`
 * key by pattern. Net key-namespace-gate impact: none — every function in
 * this section stays inside lib/tenancy.ts (the gate's client-confinement
 * rule only fires on tenancyClient used OUTSIDE this file) and touches only
 * the already-registered `tenant:` key shape.
 */
async function scanTenantIds(client: UpstashClient): Promise<string[]> {
  const prefix = `${keyPrefix()}:${TENANT_KEY_PREFIX_SEGMENT}`;
  const pattern = `${prefix}*`;
  const ids: string[] = [];
  let cursor = '0';
  let iterations = 0;
  do {
    const result = await client.cmd(['SCAN', cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT_HINT]);
    if (!Array.isArray(result) || result.length !== 2 || !Array.isArray(result[1])) break; // malformed reply — stop with whatever's already collected, never throw
    cursor = String(result[0]);
    for (const key of result[1] as unknown[]) {
      if (typeof key === 'string' && key.startsWith(prefix)) ids.push(key.slice(prefix.length));
    }
    iterations++;
  } while (cursor !== '0' && iterations < SCAN_MAX_ITERATIONS);
  return ids;
}

/**
 * Every tenantId currently on file. Owner-tooling only (scripts/tenant-
 * admin.mjs's `list`/`inspect`/`impressions` commands) — no request-serving
 * route calls this. Fails toward an empty list (never throws) on an
 * unconfigured or unreachable tenancy database, same graceful-return style
 * as every other function in this file; the CLI itself is what refuses
 * loudly (lib/tenant-admin.ts's requireTenancyConfigured, backed by
 * lib/upstash.ts's tenancyConfigured()) before ever calling this.
 */
export async function listTenantIds(): Promise<string[]> {
  const client = tenancyClient();
  if (!client) return [];
  try {
    return await scanTenantIds(client);
  } catch (err) {
    noteUpstashError('tenancy', err);
    return [];
  }
}

/**
 * Every tenant record currently on file, fetched with ONE MGET round trip
 * after the SCAN (mirrors lib/impressions.ts's readImpressionsWindow — one
 * batched read, never N sequential GETs). A record that fails to parse
 * (parseTenantRecord returning null) is silently dropped rather than
 * crashing the whole listing — the same parse-or-reject posture
 * parseTenantRecord itself documents.
 */
export async function listTenants(): Promise<TenantRecord[]> {
  const client = tenancyClient();
  if (!client) return [];
  try {
    const ids = await scanTenantIds(client);
    if (ids.length === 0) return [];
    const raw = await client.cmd(['MGET', ...ids.map(tenantKey)]);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((v) => (typeof v === 'string' ? parseTenantRecord(v) : null))
      .filter((t): t is TenantRecord => t !== null);
  } catch (err) {
    noteUpstashError('tenancy', err);
    return [];
  }
}

export interface RotatedToken {
  /** The new plaintext capability token — the CLI shows this exactly once. */
  token: string;
  tokenHash: string;
}

/**
 * Mint a new capability token for an existing tenant, same two primitives
 * (mintCapabilityToken/tokenHash) this file's header comment already named
 * as "the same two primitives a future admin-CLI 'rotate' command would
 * call" — this IS that command's backing function, not new cryptography.
 *
 * Write order matters: new tenant record + new token index are written
 * BEFORE the old index is deleted, so a crash mid-rotation fails toward
 * "the old token still works for one more request" rather than toward a
 * moment where NEITHER token resolves — the same bias toward "a paying
 * customer's embed must not silently break" that provisionFromCheckout and
 * updateSubscriptionStatus already apply to reactivation.
 *
 * Returns null when the tenant doesn't exist or the tenancy database is
 * unconfigured/unreachable — the CLI reports either as "no such tenant" /
 * "rotate failed", never distinguishing further (nothing here is a
 * security-sensitive fail-closed decision like lookupTenantByToken's; it's
 * just "did the write succeed").
 */
export async function rotateCapabilityToken(tenantId: string): Promise<RotatedToken | null> {
  const client = tenancyClient();
  if (!client) return null;
  try {
    const existing = await getTenantRecord(client, tenantId);
    if (!existing) return null;
    const token = mintCapabilityToken();
    const hash = tokenHash(token);
    const updated: TenantRecord = { ...existing, tokenHash: hash };
    await client.cmd(['SET', tenantKey(tenantId), JSON.stringify(updated)]);
    await client.cmd(['SET', tokenIndexKey(hash), tenantId]);
    await client.cmd(['DEL', tokenIndexKey(existing.tokenHash)]);
    return { token, tokenHash: hash };
  } catch (err) {
    noteUpstashError('tenancy', err);
    return null;
  }
}

/**
 * Owner-CLI-only entitlement writer (S21). Writes ONLY the `attribution`
 * metadata field — this wires NO enforcement into any widget (see this
 * file's header comment on the S5a honor-system breadcrumb, still
 * unresolved as of this sprint). Before this function existed, no code path
 * anywhere ever set attribution: 'none' — provisionFromCheckout hardcodes
 * 'required' for every self-serve checkout (S5a: full attribution removal
 * is licensed-partner-only) — so a hand-negotiated Network-tier deal that
 * actually earned attribution removal had no way to be recorded. This
 * closes that recording gap; it does not open an enforcement gap, because
 * there was never any enforcement to begin with.
 */
export async function setAttributionEntitlement(
  tenantId: string,
  attribution: TenantRecord['attribution']
): Promise<boolean> {
  const client = tenancyClient();
  if (!client) return false;
  try {
    const existing = await getTenantRecord(client, tenantId);
    if (!existing) return false;
    await client.cmd(['SET', tenantKey(tenantId), JSON.stringify({ ...existing, attribution })]);
    return true;
  } catch (err) {
    noteUpstashError('tenancy', err);
    return false;
  }
}

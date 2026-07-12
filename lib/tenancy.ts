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
 * stated plainly on /embeds)". This file IS that registry, but S18 does not
 * flip enforcement on — nothing here or in the webhook checks an incoming
 * embed request's token against the `attribution` field before honoring a
 * snippet's data-attribution attribute. That wiring is S19's job (the
 * sprint that reads tenancy from a live embed route). Per the standing
 * append-only rule for decisions.md, don't edit the S5a entry itself; a new
 * dated entry closing the honor-system caveat belongs to whichever PR
 * actually wires the enforcement.
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
}

const VALID_TIERS: TenantTier[] = ['pro', 'nonprofit', 'network'];
const VALID_STATUSES: SubscriptionStatus[] = ['active', 'trialing', 'past_due', 'canceled', 'unpaid'];

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
      const updated: TenantRecord = {
        ...existing,
        tier: input.tier,
        domainAllowlist: input.domainAllowlist,
        orgName: input.orgName,
        subscriptionId: input.subscriptionId,
        subscriptionStatus: input.subscriptionStatus,
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

const ACTIVE_STATUSES: SubscriptionStatus[] = ['active', 'trialing'];

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

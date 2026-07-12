import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * Stripe webhook signature verification + defensive event-field extraction
 * (S18). Pure node:crypto — no `stripe` SDK (zero-new-supply-chain posture,
 * matching S11/S15 precedent: plain-fetch Upstash clients, a hand-rolled
 * PSL). This module touches NO Upstash client and has no env-var/database
 * concerns at all, so it lives outside the key-namespace registry system
 * entirely — scripts/check-key-namespaces.mjs has nothing to say about it.
 *
 * Nothing here trusts a single byte of the request without checking it
 * first: the signature is verified with a constant-time comparison before
 * the body is ever JSON.parse'd, and every field pulled out of a parsed
 * event is a defensive `typeof` guard, matching lib/ratelimit.ts's
 * parseSaltRecord "parse-or-reject" style.
 */

const DEFAULT_TOLERANCE_SEC = 300; // Stripe's own documented default (5 min)

interface ParsedSignatureHeader {
  timestamp: number;
  v1: string;
}

/**
 * Parse a `Stripe-Signature` header: `t=<unix_ts>,v1=<hex_hmac>[,v0=...]`.
 * Only `v1` is ever used (v0 is Stripe's deprecated SHA-1 scheme). Returns
 * null on any malformed shape rather than guessing.
 */
function parseSignatureHeader(header: string | null): ParsedSignatureHeader | null {
  if (typeof header !== 'string' || header.length === 0) return null;
  let timestamp: number | null = null;
  let v1: string | null = null;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && timestamp === null) {
      const n = Number(value);
      if (Number.isFinite(n)) timestamp = n;
    } else if (key === 'v1' && v1 === null) {
      v1 = value;
    }
  }
  if (timestamp === null || v1 === null || v1.length === 0) return null;
  if (!/^[0-9a-f]+$/i.test(v1)) return null; // not hex — can't be a valid HMAC digest
  return { timestamp, v1 };
}

/**
 * Verify a Stripe webhook request: HMAC-SHA256 of `${timestamp}.${rawBody}`
 * under the webhook signing secret, constant-time-compared against the
 * header's `v1`, plus a replay-window check on the timestamp.
 *
 * `rawBody` MUST be the exact bytes Stripe sent (Next.js App Router route
 * handlers give raw-body access via `req.text()` by default — never call
 * `req.json()` first, which would re-serialize and break the signature).
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSec: number = DEFAULT_TOLERANCE_SEC,
  nowSec: number = Math.floor(Date.now() / 1000)
): boolean {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;

  // Replay window BEFORE the expensive HMAC compute — cheap rejection first.
  if (Math.abs(nowSec - parsed.timestamp) > toleranceSec) return false;

  const expectedHex = createHmac('sha256', secret)
    .update(`${parsed.timestamp}.${rawBody}`)
    .digest('hex');
  const expected = Buffer.from(expectedHex, 'hex');
  const provided = Buffer.from(parsed.v1, 'hex');
  // Guard buffer-length equality first: timingSafeEqual throws RangeError on
  // mismatched-length buffers, which would otherwise crash the handler on a
  // malformed/truncated header instead of cleanly rejecting it.
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

// --- minimal, hand-written event shapes (no `stripe` SDK types) ------------

export interface ParsedStripeEvent {
  id: string;
  type: string;
  /** The full parsed JSON body — handlers pick fields out defensively. */
  raw: unknown;
}

/** Parse-or-reject: only after signature + replay checks pass. */
export function parseStripeEvent(rawBody: string): ParsedStripeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) return null;
  if (typeof obj.type !== 'string' || obj.type.length === 0) return null;
  return { id: obj.id, type: obj.type, raw: parsed };
}

function eventObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = (raw as Record<string, unknown>).data;
  if (typeof data !== 'object' || data === null) return null;
  const object = (data as Record<string, unknown>).object;
  if (typeof object !== 'object' || object === null) return null;
  return object as Record<string, unknown>;
}

/**
 * Pull a text-type Checkout custom field's value by key. Stripe's shape:
 * `custom_fields: [{ key, type, text?: { value }, dropdown?: {...} }, ...]`.
 * Only the `text` variant is read (the Stripe Dashboard setup for domain/org
 * name custom fields uses text-type fields — see the PR's arming checklist).
 */
export function extractCustomField(fields: unknown, key: string): string | null {
  if (!Array.isArray(fields)) return null;
  for (const entry of fields) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    if (rec.key !== key) continue;
    const text = rec.text;
    if (typeof text !== 'object' || text === null) continue;
    const value = (text as Record<string, unknown>).value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }
  return null;
}

export interface ExtractedCheckoutSession {
  mode: string | null;
  customer: string | null;
  subscription: string | null;
  tier: string | null;
  domain: string | null;
  orgName: string | null;
  /**
   * ISO-8601, present ONLY when Stripe's own `consent_collection.
   * terms_of_service = 'required'` was configured on the Checkout Session
   * and the customer checked the box (S19, §3). `null` when Stripe's
   * payload carries no consent object at all — e.g. the owner hasn't
   * configured `consent_collection` on that Payment Link yet — NEVER
   * invented, NEVER defaulted to "accepted". lib/tenancy.ts's
   * provisionFromCheckout is the only thing allowed to turn `null` here
   * into a stored value, and it deliberately does nothing with it (leaves
   * tosAcceptedAt unset) rather than guessing.
   */
  tosAcceptedAt: string | null;
}

/**
 * Stripe stamps acceptance under `consent.terms_of_service: 'accepted'`
 * on the Checkout Session object once the customer checks the (Stripe-
 * configured) consent box. There is no separate acceptance TIMESTAMP field
 * in Stripe's payload — accepting IS what causes this webhook to fire in
 * the first place, so the moment this event is processed is the accurate
 * "accepted at" instant, not a guess.
 */
function extractTosAcceptedAt(object: Record<string, unknown>, now: () => string): string | null {
  const consent = object.consent;
  if (typeof consent !== 'object' || consent === null) return null;
  const tos = (consent as Record<string, unknown>).terms_of_service;
  return tos === 'accepted' ? now() : null;
}

/** Defensive field extraction for `checkout.session.completed`. */
export function extractCheckoutSession(
  raw: unknown,
  now: () => string = () => new Date().toISOString()
): ExtractedCheckoutSession | null {
  const object = eventObject(raw);
  if (!object) return null;
  const metadata = object.metadata;
  const tier =
    typeof metadata === 'object' && metadata !== null && typeof (metadata as Record<string, unknown>).tier === 'string'
      ? ((metadata as Record<string, unknown>).tier as string)
      : null;
  return {
    mode: typeof object.mode === 'string' ? object.mode : null,
    customer: typeof object.customer === 'string' ? object.customer : null,
    subscription: typeof object.subscription === 'string' ? object.subscription : null,
    tier,
    domain: extractCustomField(object.custom_fields, 'domain'),
    orgName: extractCustomField(object.custom_fields, 'org_name'),
    tosAcceptedAt: extractTosAcceptedAt(object, now),
  };
}

export interface ExtractedSubscriptionEvent {
  customer: string;
  status: string;
}

/** Defensive field extraction for `customer.subscription.updated|deleted`. */
export function extractSubscriptionEvent(raw: unknown): ExtractedSubscriptionEvent | null {
  const object = eventObject(raw);
  if (!object) return null;
  const customer = object.customer;
  const status = object.status;
  if (typeof customer !== 'string' || customer.length === 0) return null;
  if (typeof status !== 'string' || status.length === 0) return null;
  return { customer, status };
}

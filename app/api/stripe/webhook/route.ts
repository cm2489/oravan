import { NextRequest, NextResponse } from 'next/server';
import { registrableDomain } from '@/lib/embed-referrer';
import {
  extractCheckoutSession,
  extractSubscriptionEvent,
  parseStripeEvent,
  verifyStripeSignature,
} from '@/lib/stripe-webhook';
import { cancelSubscription, claimStripeEvent, provisionFromCheckout, updateSubscriptionStatus } from '@/lib/tenancy';

/*
 * Stripe webhook -> tenancy provisioning (S18). POST only (any other verb
 * falls through to Next's default 405). No `export const runtime` — Node.js
 * is the default here and the given, not a new constraint: node:crypto is
 * required for signature verification and is already load-bearing in
 * lib/ratelimit.ts, and no route in this codebase declares an Edge runtime.
 *
 * Events handled (minimum — see the S18 design doc for the full table):
 *   checkout.session.completed    -> provisionFromCheckout (guarded: only
 *                                     subscription-mode sessions with a
 *                                     subscription id and a recognized
 *                                     metadata.tier act; anything else is a
 *                                     silent no-op, acknowledged 200)
 *   customer.subscription.updated -> updateSubscriptionStatus (active/
 *                                     trialing keep the token; anything else
 *                                     revokes it)
 *   customer.subscription.deleted -> cancelSubscription (unconditional)
 *   anything else                 -> acknowledged, no-op (Stripe's own
 *                                     "return 2xx for events you don't
 *                                     handle" guidance)
 *
 * NOT built here: invoice.payment_failed (out of the task's stated minimum
 * — the coarse past_due-via-subscription.updated handling above already
 * covers the authorization-relevant case). No STRIPE_SECRET_KEY anywhere in
 * this file — the webhook payload itself already carries every field these
 * three events need; see the design doc's §2 for why reaching for it would
 * also collide with the parked constitutional question on persistent
 * tenant identity (a billing-portal "manage subscription" flow).
 *
 * Rate limiting: deliberately NOT added to lib/ratelimit.ts's RouteName
 * union. The caller here is Stripe, authenticated by signature, not an
 * anonymous citizen — hashing Stripe's own infrastructure IPs into the
 * counters database would be a confused application of a privacy mechanism
 * built for public citizen-facing surfaces. Signature verification + the
 * 5-minute replay window + Vercel's platform WAF are the layered defense
 * here.
 */

const RECOGNIZED_TIERS = ['pro', 'nonprofit', 'network'] as const;
type RecognizedTier = (typeof RECOGNIZED_TIERS)[number];

function isRecognizedTier(value: string): value is RecognizedTier {
  return (RECOGNIZED_TIERS as readonly string[]).includes(value);
}

/**
 * Normalize a Checkout custom field's free-text domain entry into zero or
 * more registrable domains. Reuses lib/embed-referrer.ts's registrableDomain
 * (built for exactly this "reduce a domain string to something trustworthy,
 * zero new supply chain" job) by wrapping the bare host in a synthetic
 * https:// URL — that function is a pure string transform with no DB
 * coupling, so importing it here doesn't trip the key-namespace
 * client-confinement gate.
 */
function normalizeDomainList(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const trimmed = part.trim().toLowerCase();
    if (!trimmed) continue;
    const domain = registrableDomain(`https://${trimmed}`);
    if (domain && !out.includes(domain)) out.push(domain);
  }
  return out;
}

let unsetSecretLogged = false;

/** Test seam only — mirrors lib/ratelimit.ts's single-startup-line seam. */
export function __resetStripeWebhookLogForTests(): void {
  unsetSecretLogged = false;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Dark-ship posture (S18) — the ONE deliberate divergence in this route
  // from the rest of the codebase's fail-open doctrine at the config layer:
  // there is no meaningful "degrade" equivalent for signature verification
  // the way there is for rate limiting or caching. The only safe behavior
  // when the secret is absent is to refuse everything outright — no request
  // body read, no tenancy-database client touch, no per-request-varying log
  // line (mirrors logFallbackOnce()'s single-startup-line pattern). Read at
  // request time, not module load, so builds/previews legitimately missing
  // the secret still succeed (matches the counters client's per-call
  // resolution in lib/ratelimit.ts).
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    if (!unsetSecretLogged) {
      unsetSecretLogged = true;
      console.log(
        'stripe webhook: STRIPE_WEBHOOK_SECRET not configured — refusing all requests (expected until the owner arms it)'
      );
    }
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }

  // Raw body, not req.json() first — signature verification needs the exact
  // bytes Stripe sent. Next.js App Router route handlers give raw-body
  // access by default (unlike the old Pages Router's bodyParser:false
  // opt-out), which is a real reason this shape is right for this endpoint.
  const rawBody = await req.text();
  if (!verifyStripeSignature(rawBody, req.headers.get('stripe-signature'), secret)) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  const event = parseStripeEvent(rawBody);
  if (!event) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  // Idempotency: atomic SET NX EX 7d claim before any processing. A
  // duplicate delivery (Stripe's own retries, or two near-simultaneous
  // deliveries racing) returns 200 without reprocessing.
  const claim = await claimStripeEvent(event.id);
  if (claim === 'unavailable') {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
  if (claim === 'duplicate') {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  let ok = true;
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = extractCheckoutSession(event.raw);
      if (
        session?.mode === 'subscription' &&
        session.subscription &&
        session.customer &&
        session.tier &&
        isRecognizedTier(session.tier)
      ) {
        ok = await provisionFromCheckout({
          tenantId: session.customer,
          subscriptionId: session.subscription,
          tier: session.tier,
          orgName: session.orgName ?? '',
          domainAllowlist: normalizeDomainList(session.domain),
          // Checkout doesn't carry the freshly-created subscription's own
          // status; the immediately-following customer.subscription.*
          // event corrects this if the plan actually started in a
          // non-active state (e.g. a trial).
          subscriptionStatus: 'active',
        });
      }
      // Anything that fails the guard (wrong mode, missing subscription,
      // unrecognized/absent tier) is a silent no-op — acknowledged, not an
      // error, per the design's "defends against a stray session type"
      // framing.
      break;
    }
    case 'customer.subscription.updated': {
      const sub = extractSubscriptionEvent(event.raw);
      if (sub) ok = await updateSubscriptionStatus(sub.customer, sub.status);
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = extractSubscriptionEvent(event.raw);
      if (sub) ok = await cancelSubscription(sub.customer);
      break;
    }
    default:
      break; // unhandled event type — acknowledged, nothing to do
  }

  return NextResponse.json({ ok }, { status: ok ? 200 : 500 });
}

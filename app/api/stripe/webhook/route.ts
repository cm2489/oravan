import { NextRequest, NextResponse } from 'next/server';
import { registrableDomain } from '@/lib/embed-referrer';
import {
  extractCheckoutSession,
  extractSubscriptionEvent,
  parseStripeEvent,
  verifyStripeSignature,
} from '@/lib/stripe-webhook';
import {
  cancelSubscription,
  claimStripeEvent,
  provisionFromCheckout,
  releaseStripeEventClaim,
  updateSubscriptionStatus,
} from '@/lib/tenancy';

/*
 * Stripe webhook -> tenancy provisioning (S18). POST only (any other verb
 * falls through to Next's default 405). No `export const runtime` — Node.js
 * is the default here and the given, not a new constraint: node:crypto is
 * required for signature verification and is already load-bearing in
 * lib/ratelimit.ts, and no route in this codebase declares an Edge runtime.
 *
 * Events handled (minimum — see the project records §3,
 * "Tenancy without accounts creep", for the full table):
 *   checkout.session.completed    -> provisionFromCheckout (guarded: only
 *                                     subscription-mode sessions with a
 *                                     subscription id and a recognized
 *                                     metadata.tier act. A session that is
 *                                     not a subscription checkout at all is
 *                                     a silent no-op, acknowledged 200. A
 *                                     session that IS one but carries an
 *                                     absent/unrecognized tier is the
 *                                     opposite — logged, claim released,
 *                                     400 — because that is a paying
 *                                     customer going unprovisioned and a
 *                                     200 would bury it. See the case body.)
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
 * three events need; reaching for it would also collide with the parked
 * constitutional question on persistent tenant identity (a billing-portal
 * "manage subscription" flow) — see the project records (kept out of this repo)
 * §3 again.
 *
 * S19 addition: checkout.session.completed also threads tosAcceptedAt
 * (lib/stripe-webhook.ts's extractCheckoutSession) into provisionFromCheckout
 * — ONLY when Stripe's own consent_collection payload indicates acceptance,
 * never invented, never defaulted. See lib/tenancy.ts's provisionFromCheckout
 * doc comment for the accept-and-fill-forward update-path semantics.
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

/**
 * Render a rejected `metadata.tier` for one log line: printable ASCII only,
 * length-capped, and quoted so leading/trailing whitespace is visible (the
 * difference between "pro" and " pro " is otherwise invisible in a log, and
 * is exactly the kind of Dashboard typo this line exists to diagnose). The
 * sanitizing is not paranoia about the owner — it is that this value arrives
 * over the network inside a webhook payload, and a newline in a log line is
 * a forged log line.
 */
function formatTierForLog(tier: string | null): string {
  if (tier === null) return '(absent)';
  const printable = tier.replace(/[^\x20-\x7e]/g, '').slice(0, 32);
  return printable.length > 0 ? JSON.stringify(printable) : '(unprintable)';
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
  // deliveries racing) returns 200 without reprocessing. If processing
  // itself then fails (see the `!ok` branch below), the claim is released
  // so a genuine Stripe retry isn't told 'duplicate' against a failure it
  // never actually recovered from.
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

      // NOT A SUBSCRIPTION CHECKOUT — a setup-mode session, a one-time
      // payment, or one carrying no subscription/customer id. Stripe
      // legitimately sends these and will keep sending them, so they stay a
      // silent acknowledged no-op ("defends against a stray session type").
      // This half MUST NOT become an error: a non-2xx here would put
      // Stripe's three-day retry schedule behind events that are correctly
      // ignorable, and an endpoint that keeps failing gets disabled — which
      // would break the real provisioning this route exists for.
      if (
        !session ||
        session.mode !== 'subscription' ||
        !session.subscription ||
        !session.customer
      ) {
        break;
      }

      // A REAL subscription checkout whose tier this route cannot recognize
      // — metadata.tier absent, or spelled something other than the exact
      // lowercase list (the live hazard is a Dashboard Payment Link
      // configured with "Pro"). This is a PAYING CUSTOMER, and provisioning
      // them is the entire job of this endpoint, so it must never be the
      // silent 200 it used to be: that answer consumed the 7-day
      // idempotency claim, logged nothing, and left no recovery path — a
      // Dashboard "Resend" (good for 15 days) would hit the claim and be
      // told 'duplicate'. Release the claim, say so in the log, and refuse.
      if (!session.tier || !isRecognizedTier(session.tier)) {
        // Event id + the offending tier ONLY. No customer id, no
        // subscription id, no email — nothing that identifies a person, and
        // the tier is owner-configured plan metadata, not user data. Quoted
        // and sanitized so "Pro" vs "pro" vs " pro " is visible at a glance
        // and a hostile metadata value can't forge log lines.
        console.error(
          `stripe webhook: unrecognized tier ${formatTierForLog(session.tier)} on subscription checkout ${event.id} — not provisioned, claim released, refusing so Stripe retries`
        );
        await releaseStripeEventClaim(event.id);
        // 400, not 500. Stripe retries EVERY non-2xx identically (its docs:
        // "your endpoint previously replied with a non-2xx status code"),
        // so the status buys no difference in recovery — it buys diagnosis.
        // Stripe's own dashboard glosses 4xx as "the destination server
        // can't or won't process the request", which is exactly true here:
        // nothing broke on our side, the payload is unusable as delivered.
        // 500 is reserved, below, for the genuine "processing failed" case,
        // and collapsing the two would make an unprovisionable payload
        // indistinguishable from a transient database failure in the one
        // dashboard the owner debugs from.
        return NextResponse.json({ error: 'unrecognized_tier' }, { status: 400 });
      }

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
        // undefined (not passed) when Stripe's payload carried no
        // consent acceptance — provisionFromCheckout treats that as "this
        // checkout didn't tell us", never as "not accepted".
        ...(session.tosAcceptedAt ? { tosAcceptedAt: session.tosAcceptedAt } : {}),
      });
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

  // A claim was won above, but processing itself failed (a transient
  // Upstash error on the write, not a bad request — we're past every
  // parse/signature/replay guard by this point). Release the claim so
  // Stripe's own retry can actually reprocess this event instead of being
  // told 'duplicate' and giving up against a claim marker that outlives
  // the failure by up to 7 days. See releaseStripeEventClaim's doc comment.
  if (!ok) {
    await releaseStripeEventClaim(event.id);
  }

  return NextResponse.json({ ok }, { status: ok ? 200 : 500 });
}

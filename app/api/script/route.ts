import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import { getBill } from '@/lib/core';
import { callerIp, createRateLimiter, readOravanKey } from '@/lib/ratelimit';
import { contentVersion, createScriptCache } from '@/lib/scriptcache';
import { buildScriptPrompt, SCRIPT_MAX_TOKENS, SCRIPT_MODEL, STANCES } from '@/lib/scriptprompt';
import type { Stance } from '@/lib/types';

/*
 * The only Anthropic-calling endpoint in Oravan. Stateless by design:
 * nothing about the caller is stored. Scripts are cached per
 * (bill, stance, locale, content-version) — shared across all visitors —
 * so popular bills cost one generation total, now across ALL instances
 * (S11: the cache lives in the content-keyed Upstash cache database, with
 * an in-memory fallback when unconfigured).
 *
 * Rate limiting (S11): 8 requests / 10 min per caller — the same limit as
 * always, now enforced with short-lived rate-limit counters in the
 * caller-keyed Upstash counters database (sha256(ip + rotating salt), TTL =
 * the window), durable across instances. See lib/ratelimit.ts for the salt
 * rules and lib/upstash.ts for why counters and cache are two physically
 * separate databases. Unconfigured or unreachable Upstash degrades to the
 * per-instance in-memory limiter — this route never hard-fails on it.
 */

const anthropic = new Anthropic();

const cache = createScriptCache();

const limiter = createRateLimiter({ route: 'script', max: 8, windowSec: 600 });

export async function POST(req: NextRequest) {
  readOravanKey(req.headers); // dormant tenancy hook (S18/S19): recognized, no behavior yet

  const ip = callerIp(req.headers);
  if (await limiter.isLimited(ip)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let body: { slug?: string; stance?: Stance; locale?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const { slug, stance, locale } = body;
  if (!slug || !stance || !STANCES.includes(stance)) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const lang = locale === 'es' ? 'es' : 'en';

  const bill = getBill(slug);
  if (!bill) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Content-version key component (§9.1(d)): a corrected ai_summary changes
  // the version, so a stale script can never be served against it.
  const version = contentVersion(bill.ai_summary ?? bill.title);
  const cached = await cache.get({ slug, stance, lang, version });
  if (cached) return NextResponse.json({ script: cached, cached: true });

  // Prompt builder lives in lib/scriptprompt (shared by other trusted
  // server-side callers of this exact bill/stance/locale shape) so there
  // is only ever one script prompt in the codebase, never a second copy
  // drifting out of sync with this one.
  const prompt = buildScriptPrompt({ bill, stance, lang });

  try {
    const msg = await anthropic.messages.create({
      model: SCRIPT_MODEL,
      max_tokens: SCRIPT_MAX_TOKENS,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: prompt }],
    });
    const script = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
    if (!script) throw new Error('empty');
    await cache.set({ slug, stance, lang, version }, script); // never throws
    return NextResponse.json({ script, cached: false });
  } catch (err) {
    console.error('script generation failed', err);
    return NextResponse.json({ error: 'generation_failed' }, { status: 502 });
  }
}

import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import { getBill } from '@/lib/core';
import { formatCitation } from '@/lib/format';
import { callerIp, createRateLimiter, readRostraKey } from '@/lib/ratelimit';
import { contentVersion, createScriptCache } from '@/lib/scriptcache';
import type { Stance } from '@/lib/types';

/*
 * The only Anthropic-calling endpoint in Rostra. Stateless by design:
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

const STANCES: Stance[] = ['support', 'oppose', 'undecided'];

export async function POST(req: NextRequest) {
  readRostraKey(req.headers); // dormant tenancy hook (S18/S19): recognized, no behavior yet

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

  const citation = formatCitation(bill.bill_type, bill.bill_number);
  // Content-version key component (§9.1(d)): a corrected ai_summary changes
  // the version, so a stale script can never be served against it.
  const version = contentVersion(bill.ai_summary ?? bill.title);
  const cached = await cache.get({ slug, stance, lang, version });
  if (cached) return NextResponse.json({ script: cached, cached: true });

  const stanceLine = {
    support: 'The caller SUPPORTS this bill and urges the member to vote for it.',
    oppose: 'The caller OPPOSES this bill and urges the member to vote against it.',
    undecided:
      "The caller is CONCERNED about this bill and has not settled on support or opposition. The script must register that concern, name the ONE thing that worries them (grounded in the summary), and ask that their concern be noted for the member along with where the member stands - phrased as something for the office to record, never as live questions to the staffer. The staffer only tallies positions; the script must not expect answers or a conversation.",
  }[stance];

  const langLine =
    lang === 'es'
      ? 'Write the script in natural, warm Latin American Spanish (tú form). Use the placeholders [TU NOMBRE] and [TU CIUDAD O CÓDIGO POSTAL].'
      : 'Write the script in plain, warm English at an 8th-grade reading level. Use the placeholders [YOUR NAME] and [YOUR TOWN OR ZIP].';

  const prompt = `Write a 30-second phone script for a constituent calling a member of Congress about this bill.

Bill: ${citation} — ${bill.short_title ?? bill.title}
Plain-language summary: ${bill.ai_summary ?? bill.title}
Current status: ${bill.status}

${stanceLine}

${langLine}

Rules:
- 60-90 words. It must be comfortably readable aloud in 30 seconds.
- Structure: greeting + name placeholder + constituent location placeholder, the bill by its number, the position, ONE concrete reason grounded in the summary, a clear ask, thanks.
- Refer to the bill exactly as "${citation}" - do not alter, translate, or extend that citation.
- Works equally well read to a live staffer or left as a voicemail.
- Strictly nonpartisan tone: no party language, no attacks, no alarmism, no advocacy-group jargon.
- Do not invent facts beyond the summary provided.
- Plain text only: no markdown, no asterisks, no bullet points, no headers.
- Output ONLY the script text, no commentary.`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 520,
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

import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import { getBill } from '@/lib/data';
import { formatCitation } from '@/lib/format';
import type { Stance } from '@/lib/types';

/*
 * The only dynamic endpoint in Rostra. Stateless by design: nothing about
 * the caller is stored. Scripts are cached per (bill, stance, locale) -
 * shared across all visitors - so popular bills cost one generation total.
 */

const anthropic = new Anthropic();

const cache = new Map<string, string>();

// Light per-IP rate limit (in-memory, per instance): 8 requests / 10 min.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 8;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) return true;
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // crude memory cap
  return false;
}

const STANCES: Stance[] = ['support', 'oppose', 'undecided'];

export async function POST(req: NextRequest) {
  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();
  if (rateLimited(ip)) {
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
  const key = `${slug}:${stance}:${lang}`;
  const cached = cache.get(key);
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
    cache.set(key, script);
    return NextResponse.json({ script, cached: false });
  } catch (err) {
    console.error('script generation failed', err);
    return NextResponse.json({ error: 'generation_failed' }, { status: 502 });
  }
}

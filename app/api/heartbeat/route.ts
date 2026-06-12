import { NextRequest, NextResponse } from 'next/server';
import { getBill } from '@/lib/data';
import { addTally, getPulse, heartbeatEnabled } from '@/lib/heartbeat';

/*
 * The movement heartbeat. POST adds one anonymous tally to a bill;
 * GET reads its 7-day pulse. Nothing identifying is stored - see
 * lib/heartbeat.ts for the privacy contract.
 */

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug') ?? '';
  if (!getBill(slug)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!heartbeatEnabled) return NextResponse.json({ pulse7: 0, total: 0, disabled: true });
  try {
    const pulse = await getPulse(slug);
    return NextResponse.json(pulse);
  } catch {
    return NextResponse.json({ pulse7: 0, total: 0, disabled: true });
  }
}

export async function POST(req: NextRequest) {
  let slug = '';
  try {
    slug = (await req.json()).slug ?? '';
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  if (!getBill(slug)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!heartbeatEnabled) return NextResponse.json({ error: 'disabled' }, { status: 503 });

  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();
  try {
    const result = await addTally(slug, ip);
    if (!result.ok) return NextResponse.json({ error: 'rate_limited', ...result }, { status: 429 });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
}

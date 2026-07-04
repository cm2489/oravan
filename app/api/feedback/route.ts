import { NextRequest, NextResponse } from 'next/server';

/*
 * Beta feedback intake -> one GitHub issue in this repo (private tracker).
 * Stateless by design, like every dynamic route here: nothing about the
 * caller is stored or forwarded. The issue contains ONLY what the visitor
 * volunteered - the message, a category, and (if they kept it) a page path.
 * No IP, no user agent, no cookies, no identifiers of any kind.
 *
 * POST, not GET, on purpose - same rule as app/api/district: GET query
 * strings are routinely written to server/CDN/proxy access logs, and POST
 * bodies are not. Feedback text must never land in any log, so it travels
 * only in the body. For the same reason the failure paths below log at most
 * an HTTP status code - never the GitHub response body (it can echo the
 * submitted content back) and never a caught error object.
 *
 * The `website` field is a honeypot: humans never see it, form-filling bots
 * fill it. A filled honeypot gets the same success response as a real
 * submission - and nothing is created - so bots learn nothing.
 */

const GITHUB_ISSUES_URL = 'https://api.github.com/repos/cm2489/rostra/issues';

const CATEGORIES = ['bug', 'feature', 'other'] as const;
type Category = (typeof CATEGORIES)[number];

const MAX_MESSAGE_CHARS = 2000;
const MAX_PAGE_CHARS = 200;
const TITLE_CHARS = 60;

// Light per-IP rate limit (in-memory, per instance), following app/api/script:
// 8 requests / 10 min. The IP is compared and discarded, never stored beyond
// this window and never forwarded anywhere.
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

function createIssue(
  token: string,
  issue: { title: string; body: string; labels?: string[] }
): Promise<Response> {
  return fetch(GITHUB_ISSUES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(issue),
    signal: AbortSignal.timeout(8000),
    cache: 'no-store',
  });
}

export async function POST(req: NextRequest) {
  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();
  if (rateLimited(ip)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let body: { category?: unknown; message?: unknown; page?: unknown; website?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  // Honeypot tripped: acknowledge exactly like a success, create nothing.
  if (body.website) {
    return NextResponse.json({ ok: true });
  }

  const category = CATEGORIES.includes(body.category as Category)
    ? (body.category as Category)
    : null;
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const page =
    typeof body.page === 'string'
      ? body.page.replace(/\s+/g, ' ').trim().slice(0, MAX_PAGE_CHARS)
      : '';
  if (!category || message.length === 0 || message.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const token = process.env.GITHUB_FEEDBACK_TOKEN;
  if (!token) {
    // Intake not configured. Neutral error - no config detail leaks.
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }

  const oneLine = message.replace(/\s+/g, ' ').trim();
  const title = `[beta:${category}] ${
    oneLine.length > TITLE_CHARS ? `${oneLine.slice(0, TITLE_CHARS).trimEnd()}…` : oneLine
  }`;
  const issueBody = [
    `**Category:** ${category}`,
    ...(page ? [`**Page:** ${page}`] : []),
    '',
    message,
  ].join('\n');

  try {
    let res = await createIssue(token, {
      title,
      body: issueBody,
      labels: ['beta-feedback', category],
    });
    if (res.status === 422) {
      // Labels the token can't set (or that don't exist) fail validation;
      // the [beta:<category>] title prefix is the fallback taxonomy.
      res = await createIssue(token, { title, body: issueBody });
    }
    if (!res.ok) {
      console.error('feedback intake failed', res.status); // status code only, never the body
      return NextResponse.json({ error: 'unavailable' }, { status: 502 });
    }
  } catch {
    // Timeout or network failure. Log NOTHING: a caught fetch error can
    // embed the request, and the request contains the feedback text.
    return NextResponse.json({ error: 'unavailable' }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}

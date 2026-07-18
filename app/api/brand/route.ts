import Anthropic from '@anthropic-ai/sdk';
import { after, NextRequest, NextResponse } from 'next/server';
import { createLruCache } from '@/lib/brand-cache';
import {
  extractFromHtml,
  isAllowlistedWebfontUrl,
  mergeCssSignals,
  type BrandCandidates,
} from '@/lib/brand-extract';
import { fetchGuarded, normalizeBrandUrl } from '@/lib/brand-fetch';
import {
  BRAND_MAX_TOKENS,
  BRAND_MODEL,
  buildBrandPrompt,
  finalizeBrandTheme,
  parseBrandResponse,
  type BrandTheme,
} from '@/lib/brandprompt';
import { callerIp, createRateLimiter, createTenantRateLimiter } from '@/lib/ratelimit';
import { noteBrandPreview } from '@/lib/usage';

/*
 * The brand-preview endpoint (brand-preview build): an org considering the
 * white-label tier submits its site URL from /embeds and gets back a theme
 * suggestion in the closed knob set. The SECOND Anthropic-calling endpoint
 * in Oravan (after /api/script) — spend posture below.
 *
 * Stateless by the /api/district doctrine, strengthened: POST so the URL
 * never lands in an access log; the URL is truncated to its ORIGIN inside
 * normalizeBrandUrl (the path never exists past that call); the only cache
 * is a per-instance in-memory LRU (lib/brand-cache — never a database, so
 * the /embeds privacy copy "the address is never stored" is literally
 * true); and NO catch below logs anything, not even the error object — a
 * fetch error can embed the hostname.
 *
 * Spend posture (every $ decision surfaced — orchestrator rule):
 *   - per-IP limiter 5/10min ('brand') — tighter than district's 10,
 *     because every miss spends money (fetch + one BRAND_MODEL call);
 *   - a GLOBAL daily breaker 250/day ('brand-day' via the tenant limiter
 *     keyed by the constant 'brand-global') — unauthenticated spending
 *     endpoint, no cross-user cache to blunt a distributed farm. Worst-case
 *     day ≈ 250 × ~$0.008 ≈ $2 on claude-sonnet-5.
 *   - usage counter (noteBrandPreview) fires via after() on the actual-
 *     spend path only, mirroring /api/script's noteScriptGeneration.
 *
 * Error taxonomy (uniform bodies, nothing caller-specific ever echoed):
 *   400 bad_request        — malformed body/URL, or the SSRF guard refused
 *   429 rate_limited       — either limiter tripped (deliberately not
 *                            distinguished, same rule as /api/script)
 *   502 unavailable        — the site couldn't be fetched (block/timeout/
 *                            TLS/not-HTML) — soft dead-end, the UI says
 *                            "set the colors manually"
 *   502 generation_failed  — Anthropic failed, or its output didn't survive
 *                            the fail-closed validators
 */

const anthropic = new Anthropic();

const limiter = createRateLimiter({ route: 'brand', max: 5, windowSec: 600 });
const dayLimiter = createTenantRateLimiter({ route: 'brand-day', max: 250, windowSec: 86400 });
/** The global-breaker key: a constant, not caller/content material. */
const GLOBAL_BUCKET = 'brand-global';

interface BrandResponse {
  theme: BrandTheme;
  site: { name?: string; logoUrl?: string };
  /**
   * Exact-match hints for the /embeds preview MOCKUP chrome ONLY (Oravan's
   * own page) — never fed to the widget, whose fonts stay on the closed
   * system stacks. webfontHref is re-validated against the font-CDN
   * allowlist here (the trust boundary the client relies on), not just at
   * extraction.
   */
  preview: { fontFamily?: string; webfontHref?: string };
  adjusted: boolean;
}

const cache = createLruCache<BrandResponse>({ max: 100, ttlMs: 15 * 60 * 1000 });

const HTML_FETCH = {
  maxBytes: 1_572_864, // 1.5 MB — truncation is success
  timeoutMs: 8000,
  maxRedirects: 3,
  contentTypes: ['text/html', 'application/xhtml+xml'],
};

const CSS_FETCH = {
  maxBytes: 262_144, // 256 KB per stylesheet, max 2 stylesheets
  timeoutMs: 4000,
  maxRedirects: 2,
  contentTypes: ['text/css'],
};

export async function POST(req: NextRequest) {
  const ip = callerIp(req.headers);
  if ((await limiter.isLimited(ip)) || (await dayLimiter.isLimited(GLOBAL_BUCKET))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let body: { url?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const normalized = normalizeBrandUrl(body.url);
  if (!normalized.ok) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const { origin } = normalized;

  const hit = cache.get(origin);
  if (hit) return NextResponse.json(hit);

  const page = await fetchGuarded(`${origin}/`, HTML_FETCH);
  if (!page.ok) {
    return NextResponse.json({ error: 'unavailable' }, { status: 502 });
  }

  let candidates: BrandCandidates = extractFromHtml(page.text, page.finalUrl);
  for (const stylesheetUrl of candidates.stylesheets) {
    // Same-origin was enforced at extraction; each fetch re-guards anyway.
    // A failed stylesheet is just a skipped signal, never an error.
    const css = await fetchGuarded(stylesheetUrl, CSS_FETCH);
    if (css.ok) candidates = mergeCssSignals(candidates, css.text);
  }

  try {
    const msg = await anthropic.messages.create({
      model: BRAND_MODEL,
      max_tokens: BRAND_MAX_TOKENS,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: buildBrandPrompt(candidates) }],
    });
    const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
    const finalized = finalizeBrandTheme(parseBrandResponse(text));
    if (!finalized) throw new Error('unusable');

    const response: BrandResponse = {
      theme: finalized.theme,
      site: { name: candidates.siteName, logoUrl: candidates.logoUrl },
      preview: {
        fontFamily: candidates.bodyFontFamily,
        webfontHref:
          candidates.webfontHref && isAllowlistedWebfontUrl(candidates.webfontHref)
            ? candidates.webfontHref
            : undefined,
      },
      adjusted: finalized.adjusted,
    };
    cache.set(origin, response);
    // Count only actual spend (this is the cache-miss path by construction);
    // after() so a slow counter write never delays the response.
    after(() => noteBrandPreview());
    return NextResponse.json(response);
  } catch {
    // Log-nothing doctrine: the error object can embed the request context.
    return NextResponse.json({ error: 'generation_failed' }, { status: 502 });
  }
}

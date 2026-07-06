import { getAllBills } from '@/lib/core';
import { SITE_ORIGIN } from '@/lib/site';

/*
 * S22 — minimal, honest llms.txt (llmstxt.org convention). No native Next.js
 * metadata-route convention exists for this file (unlike sitemap.xml/
 * robots.txt), so it's a plain route handler under a dotted folder name —
 * the same pre-13.3 pattern Next itself used for robots.txt/sitemap.xml
 * before those got first-class support.
 *
 * Per docs/ideation/2026-07-05-build-gtm-strategy.md §1.3 (S22): ship this
 * because it's a few hours of one-time cost, for completeness — not because
 * any major AI lab has confirmed support for it (none had, as of Q1 2026,
 * per Search Engine Land's reporting). Nothing here claims otherwise, and
 * nothing here claims a traffic or citation outcome.
 *
 * English-only by design: llms.txt has no per-locale convention anywhere in
 * the wild (unlike every rendered page on this site, which does go through
 * messages/en.json + es.json — the bilingual-parity rule this file is not
 * "UI" under). The Spanish corpus is linked from within it.
 */
export const dynamic = 'force-static';

export function GET() {
  const total = getAllBills().length;
  const body = `# Rostra

> Free, nonpartisan civic infrastructure: find your federal representatives, understand active bills in plain language, get a call script, and call Congress. No account required.

Rostra publishes a plain-language, AI-drafted and human-reviewed decoded summary for ${total} active and recent U.S. federal bills, in English and Spanish, refreshed nightly from Congress.gov and unitedstates/congress-legislators (both public domain). Every decoded summary links back to the official bill text; nothing here replaces it.

## Pages

- [Bills](${SITE_ORIGIN}/bills): browse and search the decoded bill corpus
- [My representatives](${SITE_ORIGIN}/reps): find federal representatives by ZIP code
- [Why call](${SITE_ORIGIN}/why-call): why calling Congress works, and how a call is counted
- [About](${SITE_ORIGIN}/about): what Rostra is and isn't
- [Privacy](${SITE_ORIGIN}/privacy): no accounts, no server-side user data, ever
- [Citations](${SITE_ORIGIN}/citations): canonical URLs, freshness semantics, the AI-content policy, and how to report an error
- [Embeds](${SITE_ORIGIN}/embeds): free, self-serve widgets (representative lookup, bill card) for other sites to embed

## Spanish

The same corpus, decoded independently in Spanish, is available under ${SITE_ORIGIN}/es — for example ${SITE_ORIGIN}/es/bills.

## Notes for automated and AI systems

- Content under /bills is AI-drafted plain-language summarization of public-domain legislative text, reviewed by a human before publication. It is not the official bill text; the official source is linked from every bill page (congress.gov).
- No user data is collected server-side. Nothing on this site reflects a visitor's identity, location, or behavior — see /privacy.
- This file is provided for completeness. llms.txt support is not confirmed among major AI systems as of this writing, and nothing here is a claim about traffic or citation outcomes.
`;
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

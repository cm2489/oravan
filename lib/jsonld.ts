import 'server-only';
/*
 * S22 — structured data for the corpus that already exists. No new content:
 * every field is sourced from lib/core's bill data, lib/freshness's one
 * accessor, and lib/site's SITE_ORIGIN — never invented.
 *
 * The bill-page graph stacks an Article node (always) with a FAQPage node
 * only when bill.ai_sections exists — the decode structure's what/who/why/
 * cost genuinely IS a four-question FAQ, and the question text reuses the
 * exact translated labels DecodedSections already renders (messages/*.json
 * `bill.sec.*`), not new copy.
 *
 * AI-generated content has no ratified schema.org property of its own — no
 * "isAIGenerated" term exists in the vocabulary as of this writing. Rather
 * than invent one, the disclosure rides on schema.org's own generic
 * extension point (`additionalProperty`), honestly named, plus the same
 * human-readable disclaimer the page itself shows next to the decoded
 * content (lib/core/mcp.ts's AI_LABEL_TEXT is the sibling copy for MCP
 * responses; this is the JSON-LD-shaped version of the same disclosure).
 */
import { getTranslations } from 'next-intl/server';
import { absoluteUrl } from './hreflang';
import { formatCitation } from './format';
import { getFreshness } from './freshness';
import { SITE_ORIGIN } from './site';
import type { Bill } from './types';

const ORG_NAME = 'Rostra';
const ORG_ID = `${SITE_ORIGIN}/#organization`;

const AI_DISCLOSURE =
  'AI-drafted plain-language summary, human-reviewed before publication. Not the official bill text — see the linked official source.';

function organizationNode() {
  return {
    '@type': 'Organization',
    '@id': ORG_ID,
    name: ORG_NAME,
    url: SITE_ORIGIN,
  };
}

/** Later of two possibly-null ISO date strings — never invents one that's missing. */
function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Article (+ FAQPage when the decode structure supports it) for one bill
 * page, in the page's own locale. Called from the bill page's server
 * component itself (not generateMetadata — the Metadata API has nowhere to
 * put an arbitrary <script> tag), so this is async and reads translations
 * directly.
 */
export async function buildBillJsonLd(bill: Bill, locale: string, slug: string) {
  const href = `/bills/${slug}`;
  const url = absoluteUrl(locale, href);
  const inLanguage = locale === 'es' ? 'es' : 'en';
  const headline = (bill.ai_headline ?? bill.short_title ?? bill.title).slice(0, 110);
  const description = (bill.ai_summary ?? bill.title).slice(0, 300);
  // Never invented: introduced_date is the closest real anchor to
  // "published," last_action_date/checkedAt (lib/freshness) are the closest
  // real anchors to "modified." Absent when the underlying data is absent.
  const datePublished = bill.introduced_date ?? bill.last_action_date ?? undefined;
  const dateModified = laterOf(bill.last_action_date, getFreshness().checkedAt) ?? datePublished;
  const hasAiContent = Boolean(bill.ai_summary || bill.ai_sections);

  const article: Record<string, unknown> = {
    '@type': 'Article',
    '@id': `${url}#article`,
    mainEntityOfPage: url,
    url,
    headline,
    description,
    inLanguage,
    citation: bill.congress_gov_url
      ? { '@type': 'CreativeWork', name: bill.title, url: bill.congress_gov_url }
      : formatCitation(bill.bill_type, bill.bill_number),
    ...(bill.congress_gov_url ? { isBasedOn: bill.congress_gov_url } : {}),
    publisher: organizationNode(),
    ...(datePublished ? { datePublished } : {}),
    ...(dateModified ? { dateModified } : {}),
    ...(hasAiContent
      ? {
          additionalProperty: {
            '@type': 'PropertyValue',
            name: 'contentDisclosure',
            value: AI_DISCLOSURE,
          },
        }
      : {}),
  };

  const graph: Record<string, unknown>[] = [article];

  const s = bill.ai_sections;
  if (s) {
    const t = await getTranslations({ locale, namespace: 'bill' });
    const qa = (name: string, answer: string | null | undefined) =>
      answer ? { '@type': 'Question', name, acceptedAnswer: { '@type': 'Answer', text: answer } } : null;

    const mainEntity = [
      qa(t('sec.what'), s.what),
      qa(t('sec.who'), s.who),
      qa(t('sec.why'), s.why),
      qa(t('sec.cost'), s.cost),
    ].filter((q): q is NonNullable<typeof q> => q !== null);

    if (mainEntity.length > 0) {
      graph.push({ '@type': 'FAQPage', '@id': `${url}#faq`, mainEntity });
    }
  }

  return { '@context': 'https://schema.org', '@graph': graph };
}

/** Homepage: WebSite + Organization, cheap and reused across locales via translated copy. */
export async function buildSiteJsonLd(locale: string) {
  const t = await getTranslations({ locale, namespace: 'common' });
  const url = absoluteUrl(locale, '/');
  const inLanguage = locale === 'es' ? 'es' : 'en';
  return {
    '@context': 'https://schema.org',
    '@graph': [
      organizationNode(),
      {
        '@type': 'WebSite',
        '@id': `${SITE_ORIGIN}/#website`,
        name: t('appName'),
        description: t('footer.mission'),
        url,
        inLanguage,
        publisher: { '@id': ORG_ID },
      },
    ],
  };
}

/** Rep lookup page: Organization only — cheap, no new copy, same @id as the homepage's. */
export function buildOrganizationJsonLd() {
  return { '@context': 'https://schema.org', '@graph': [organizationNode()] };
}

/*
 * The free, public, keyless "what moved this week" tenant feed (S21;
 * embeds spec §1's feed row: "Reshaped in v1.1 as a free tenant-facing
 * JSON/RSS feed ('what moved this week,' from the existing urgency bands)
 * that powers *their* newsletters with an attribution line").
 *
 * ZERO new scoring/urgency logic: both exports below are thin wrappers over
 * whatsMoving() (lib/core/mcp.ts, built for S10's MCP tool) — the exact same
 * urgency-band pool the homepage "Act now" section and the MCP tool both
 * read (getTopActions), including the same quiet_week/data_stale honesty
 * collapse (lib/freshness-state.ts's emptyStateVerdict). This file adds
 * exactly one piece of genuinely new logic: RSS 2.0 XML escaping/
 * serialization — everything else is reshaping whatsMoving()'s own output
 * plus the existing SOURCE/AI_LABEL_TEXT/LICENSE_* envelope constants.
 *
 * Auth: NONE, deliberately (see the S21 design doc §1). The underlying data
 * is already 100% public — the same corpus the MCP tool, bill pages, and
 * sitemap.xml already expose keylessly — so a token would add an
 * auth/abuse surface protecting nothing, and would break the "no token, no
 * signup, no stored anything" free-tier ethos (embeds spec §3.3) plus make
 * this feed unusable by ordinary RSS-to-newsletter tooling that can't carry
 * bearer tokens through an RSS pipeline.
 *
 * Callers: app/feed/whats-moving.{json,xml}/route.ts (EN) and
 * app/es/feed/whats-moving.{json,xml}/route.ts (ES) — all four are
 * `force-static` (matching app/llms.txt/route.ts exactly), so this module
 * must never read a request object, cookies, or headers. No caller-derived
 * material of any kind ever reaches this file — the four route handlers
 * below take zero arguments beyond a hardcoded locale literal.
 */
import { escapeXml, rfc822 } from './feed-xml';
import { AI_LABEL_TEXT, whatsMoving, type BillTeaserOut, type Locale } from './mcp';

const FEED_TITLE: Record<Locale, string> = {
  en: "What moved in Congress this week — Oravan",
  es: 'Lo que avanzó en el Congreso esta semana — Oravan',
};

const FEED_DESCRIPTION: Record<Locale, string> = {
  en: "Active, plain-language-decoded U.S. federal bills that cleared Oravan's \"act now\" urgency bar in the last 7 days. Free, nonpartisan, no account or sign-up required.",
  es: 'Proyectos de ley federales activos, en lenguaje sencillo, que superaron el umbral de urgencia "actúa ahora" de Oravan en los últimos 7 días. Gratis, sin filiación partidista, sin cuenta ni registro.',
};

// Mandatory per the embeds spec's "powers their newsletters with an
// attribution line" — this is the free, keyless, static feed's ONLY
// attribution mechanism (no token, no tenant config to read a
// brandless/attribution-removed flag from): always present, every payload,
// both formats, both locales. Unlike the paid embed widgets, there is no
// tier at which this line can be removed.
const FEED_ATTRIBUTION: Record<Locale, string> = {
  en: 'Data via Oravan, a free, nonpartisan civic tool.',
  es: 'Datos vía Oravan, una herramienta cívica gratuita y sin filiación partidista.',
};

const QUIET_WEEK_NOTE: Record<Locale, string> = {
  en: 'Quiet week: no bill cleared the urgency bar in this window.',
  es: 'Semana tranquila: ningún proyecto de ley superó el umbral de urgencia en este período.',
};

const DATA_STALE_NOTE: Record<Locale, string> = {
  en: "This list is empty because Oravan's own nightly data sync looks stale, not because Congress is quiet.",
  es: 'Esta lista está vacía porque la sincronización nocturna de datos de Oravan parece desactualizada, no porque el Congreso esté inactivo.',
};

export interface FeedItem {
  slug: string;
  citation: string;
  title: string;
  headline: string | null;
  /** True only when `headline` IS the AI decode — same house rule as the OG cards and the MCP tool. */
  ai_generated: boolean;
  /** Non-removable AI-content disclosure (S5a), present on every AI-generated item, never on a non-AI one. */
  ai_label: string | null;
  status: string;
  status_label: string;
  url: string;
  last_action_date: string | null;
  urgency_score: number;
}

export interface FeedPayload {
  title: string;
  description: string;
  link: string;
  generated_at: string;
  days: number;
  quiet_week: boolean;
  data_stale: boolean;
  source: string;
  license: string;
  /** Channel-level AI disclosure — null only when NO item in this payload carries AI content. */
  ai_label: string | null;
  attribution: string;
  items: FeedItem[];
}

function shapeItem(bill: BillTeaserOut, locale: Locale): FeedItem {
  return {
    slug: bill.slug,
    citation: bill.citation,
    title: bill.title,
    headline: bill.headline,
    ai_generated: bill.ai_generated,
    ai_label: bill.ai_generated ? AI_LABEL_TEXT[locale] : null,
    status: bill.status,
    status_label: bill.status_label,
    url: bill.url,
    last_action_date: bill.last_action_date,
    urgency_score: bill.urgency_score,
  };
}

/** The JSON feed payload: app/feed/whats-moving.json and app/es/feed/whats-moving.json. */
export function buildFeedPayload(locale: Locale): FeedPayload {
  const moving = whatsMoving({ days: 7 }, locale);
  return {
    title: FEED_TITLE[locale],
    description: FEED_DESCRIPTION[locale],
    link: moving.meta.canonical_url,
    generated_at: moving.meta.as_of,
    days: moving.days,
    quiet_week: moving.quiet_week,
    data_stale: moving.data_stale,
    source: moving.meta.source,
    license: moving.meta.license,
    ai_label: moving.meta.ai_label,
    attribution: FEED_ATTRIBUTION[locale],
    items: moving.bills.map((b) => shapeItem(b, locale)),
  };
}

/** The RSS 2.0 feed: app/feed/whats-moving.xml and app/es/feed/whats-moving.xml. */
export function buildFeedRss(locale: Locale): string {
  const payload = buildFeedPayload(locale);
  const languageTag = locale === 'es' ? 'es' : 'en-us';

  const statusNote = payload.data_stale
    ? DATA_STALE_NOTE[locale]
    : payload.quiet_week
      ? QUIET_WEEK_NOTE[locale]
      : null;

  // Channel-level attribution/source/license/AI-disclosure: RSS 2.0 has no
  // standard element for any of these, and this feed deliberately ships
  // plain vanilla RSS 2.0 (no custom namespaces) so ordinary newsletter
  // RSS-to-email tooling can consume it with zero special-casing — so they
  // ride in the channel <description> as additional sentences, same
  // pattern the JSON payload uses as separate fields.
  const channelDescriptionParts = [
    payload.description,
    payload.attribution,
    `Source: ${payload.source}`,
    `License: ${payload.license}`,
    payload.ai_label ? `AI content: ${payload.ai_label}` : null,
    statusNote,
  ].filter((p): p is string => Boolean(p));

  const itemsXml = payload.items
    .map((item) => {
      const itemTitle = item.headline ? `${item.citation}: ${item.headline}` : `${item.citation}: ${item.title}`;
      const descriptionParts = [item.headline ?? item.title, item.ai_label].filter((p): p is string => Boolean(p));
      return [
        '<item>',
        `<title>${escapeXml(itemTitle)}</title>`,
        `<link>${escapeXml(item.url)}</link>`,
        `<guid isPermaLink="true">${escapeXml(item.url)}</guid>`,
        `<pubDate>${rfc822(item.last_action_date, payload.generated_at)}</pubDate>`,
        `<description>${escapeXml(descriptionParts.join(' — '))}</description>`,
        '</item>',
      ].join('');
    })
    .join('');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '<channel>',
    `<title>${escapeXml(payload.title)}</title>`,
    `<link>${escapeXml(payload.link)}</link>`,
    `<description>${escapeXml(channelDescriptionParts.join(' '))}</description>`,
    `<language>${languageTag}</language>`,
    `<lastBuildDate>${rfc822(null, payload.generated_at)}</lastBuildDate>`,
    '<generator>Oravan</generator>',
    itemsXml,
    '</channel>',
    '</rss>',
  ].join('');
}

import type { Locale } from './mcp';

/*
 * THE FEED CHANNEL'S FIELD LABELS (2026-11-25). The Spanish feed printed them
 * in English ("Source:", "License:", "AI content:"), which an outside review
 * of the Spanish edition read as untranslated copy. They live in code for the
 * reason lib/core/feed.ts gives for every feed string: the feed routes are
 * `force-static` and have no message catalogue to read from. A module of its
 * own so a unit test can read it without the corpus loaders behind feed.ts.
 */
const CHANNEL_LABELS: Record<Locale, { source: string; license: string; ai: string }> = {
  en: { source: 'Source:', license: 'License:', ai: 'AI content:' },
  es: { source: 'Fuente:', license: 'Licencia:', ai: 'Contenido de IA:' },
};

/** The channel description's source, license and AI-disclosure sentences, labeled in the feed's language. */
export function channelFieldParts(
  locale: Locale,
  fields: { source: string; license: string; ai_label: string | null }
): string[] {
  const l = CHANNEL_LABELS[locale];
  return [
    `${l.source} ${fields.source}`,
    `${l.license} ${fields.license}`,
    ...(fields.ai_label ? [`${l.ai} ${fields.ai_label}`] : []),
  ];
}

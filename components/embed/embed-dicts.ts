import en from '@/messages/en.json';
import es from '@/messages/es.json';

/*
 * THE EMBED WIDGETS' COPY, PICKED ON THE SERVER (2026-09-28).
 *
 * The three widgets (components/embed/*Widget.tsx) have no next-intl
 * provider — their route has no [locale] segment — so they used to import
 * messages/en.json and messages/es.json whole, and the bundler put both
 * catalogs, every namespace, into the widgets' shared client chunk. When the
 * glossary grew to 134 terms in both languages that chunk grew by 70 KB of
 * definitions no widget shows (measured: 200.1 KB → 270.1 KB, the largest
 * chunk in the build).
 *
 * So the catalogs stay on the server: app/embed/layout.tsx picks the
 * namespaces the widgets read, in both languages (the in-widget EN/ES toggle
 * needs both), and hands them down once through EmbedDictsProvider. A
 * namespace a widget reads and this list misses is a type error, not a
 * blank string: the widgets are typed against `EmbedDict`.
 *
 * Nothing in the embed's partner promises changes (CLAUDE.md rule 12): the
 * copy arrives in the page's own response, from the same origin, exactly as
 * the rendered HTML already does.
 */
export const EMBED_NAMESPACES = [
  'bill',
  'bills',
  'common',
  'embed',
  'freshness',
  'home',
  'og',
  'reps',
] as const;

type Catalog = typeof en;
export type EmbedDict = Pick<Catalog, (typeof EMBED_NAMESPACES)[number]>;
export type EmbedLocale = 'en' | 'es';
export type EmbedDicts = Record<EmbedLocale, EmbedDict>;

function pick(catalog: Catalog): EmbedDict {
  return Object.fromEntries(EMBED_NAMESPACES.map((ns) => [ns, catalog[ns]])) as EmbedDict;
}

export function embedDicts(): EmbedDicts {
  return { en: pick(en), es: pick(es) };
}

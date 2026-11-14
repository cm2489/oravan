import { getTranslations } from 'next-intl/server';
import { routing } from '@/i18n/routing';

/*
 * Locale-aware PWA manifest (S6 persona gate, 2026-07-07). Next's static
 * app/manifest.ts convention receives no request locale, so a single file
 * could only ever ship one language - a bilingual-parity violation the whole
 * panel flagged (a Spanish user installing from /es got an English name +
 * description on their home screen). This route handler resolves the locale
 * from the path segment instead, so /en/manifest.webmanifest and
 * /es/manifest.webmanifest each carry their own copy, sourced from
 * messages/*.json like every other user-facing string. Each [locale] layout
 * links to its own via generateMetadata's `manifest` field.
 *
 * The path carries a dot, so proxy.ts's matcher excludes it from next-intl's
 * middleware - locale here comes from the literal segment, never a redirect.
 */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale });

  const manifest = {
    name: t('common.appName'),
    short_name: t('common.appName'),
    description: t('manifest.description'),
    // Install from /es opens the Spanish app; default locale keeps the root.
    start_url: locale === routing.defaultLocale ? '/' : `/${locale}`,
    display: 'standalone',
    // Live tokens from app/globals.css (--color-paper / --color-ink). These
    // were left at the retired Field Notebook values (#F3ECDD / #2A2318) when
    // the design refresh landed, so the install splash and the Android status
    // bar still rendered the old cream-and-brown identity.
    // theme_color is the masthead band's green (--color-go-deep), so the
    // phone's status bar runs straight into the band (owner's look, 2026-11-13).
    background_color: '#fcfaf4', // --color-paper
    theme_color: '#133f2d', // --color-go-deep
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };

  return Response.json(manifest, {
    headers: { 'content-type': 'application/manifest+json' },
  });
}

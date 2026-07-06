/*
 * S22 — one shared canonical/hreflang builder for every page type.
 *
 * PR #30 gave the bill detail page a canonical + language alternates, but
 * every other page type (home, /bills, /reps, /about, /privacy, /terms,
 * /why-call, /impact) shipped with none at all — not "slightly wrong," just
 * absent. This is the fix, generalized: given a locale and the bare href a
 * next-intl <Link>/getPathname call would take ('/', '/bills',
 * '/bills/hr-5582-119', ...), it returns Next's Metadata['alternates']
 * shape with:
 *   - canonical: this page's own absolute URL
 *   - languages.en / languages.es: both locales' absolute URLs (reciprocal
 *     and self-referential by construction — the current page always
 *     appears in its own language map, and the other locale's page,
 *     built the same way, always points back)
 *   - languages['x-default']: routing.ts's defaultLocale ('en') — the
 *     version search engines should serve a visitor whose language matches
 *     neither alternate
 *
 * tests/hreflang.spec.ts crawls a representative sample of built pages and
 * asserts absoluteness + reciprocity so this can't silently regress.
 */
import type { Metadata } from 'next';
import { getPathname } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { SITE_ORIGIN } from './site';

export function absoluteUrl(locale: string, href: string): string {
  const path = getPathname({ locale, href });
  // Next's own Metadata resolution collapses a bare "/" to the origin with
  // no trailing slash for canonical/alternate <link> tags — see
  // resolveAbsoluteUrlWithPathname in next/dist/lib/metadata/resolvers/
  // resolve-url.js (`result.pathname === '/' ... ? result.origin : ...`).
  // Matching that rule here, in the one shared builder, keeps the page's
  // own <head> tags, app/sitemap.ts, and lib/jsonld.ts's `url` fields
  // byte-identical for the site root instead of quietly disagreeing on a
  // trailing slash only the root path can trigger.
  return path === '/' ? SITE_ORIGIN : `${SITE_ORIGIN}${path}`;
}

export function hreflangAlternates(locale: string, href: string): Metadata['alternates'] {
  const languages: Record<string, string> = Object.fromEntries(
    routing.locales.map((l) => [l, absoluteUrl(l, href)])
  );
  return {
    canonical: absoluteUrl(locale, href),
    languages: { ...languages, 'x-default': absoluteUrl(routing.defaultLocale, href) },
  };
}

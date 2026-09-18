'use client';

import { useTranslations } from 'next-intl';

/*
 * THAT DIRECTIVE IS LOAD-BEARING — it is what keeps the whole site static.
 *
 * Next wraps every [locale] route in `<Suspense fallback={<Loading />}>`, and
 * when it renders that fallback, `setRequestLocale(locale)` — which the layout
 * and every page do call — has not populated next-intl's per-request locale
 * cache. (Instrumenting next-intl's fallback on a full build put this
 * component at the TOP of every stack, with no layout frame above it, so the
 * fallback is evidently rendered in a pass rooted here rather than inside the
 * layout's. The frames are the measurement; the pass is the inference.)
 *
 * As a SERVER component, `useTranslations` therefore fell through to
 * next-intl's last-resort path, which reads the locale off a request header
 * (next-intl's RequestLocale: `getCachedRequestLocale() || headers().get(...)`).
 * `headers()` is a dynamic API, so the boundary opted its whole segment into
 * dynamic rendering — and because this file sits at the ROOT of [locale], that
 * was every HTML page on the site. Measured on the production build of
 * 2026-09-18: every [locale] route was marked `ƒ`, and of the ~6,000 pages
 * that should have been in `.next/prerender-manifest.json` not one was — it
 * held 10 non-image entries, all of them feeds and metadata files, and no page
 * at all — while README principle 2 went on promising statically generated
 * pages. One file, 6,004 header reads, the entire static-first claim.
 *
 * As a CLIENT component nothing about the rendered markup changes — the
 * skeleton is still server-rendered into the static HTML with its label
 * already translated (`Loading…` / `Cargando…`), because the Suspense boundary
 * sits inside the layout's `NextIntlClientProvider` — but the locale now
 * arrives through that provider's context instead of through a request header,
 * and the page prerenders.
 *
 * Pinned by tests/static-rendering.spec.ts. If a translation is ever needed
 * here from the server instead, it must come from a source that does not
 * resolve the locale at request time.
 */
export default function Loading() {
  const t = useTranslations('common');
  return (
    <div className="mx-auto max-w-5xl px-4 py-12" role="status" aria-label={t('loading')}>
      {/* `wash` is the recessed ground — the same one a disabled control and
          an inset note stand on, so a placeholder never reads as content. */}
      <div className="h-9 w-64 animate-pulse rounded-control bg-wash" />
      <div className="mt-3 h-5 w-full max-w-read animate-pulse rounded-control bg-wash" />
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-48 animate-pulse rounded-control bg-wash" />
        ))}
      </div>
      <span className="sr-only">{t('loading')}</span>
    </div>
  );
}

'use client';

import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { isAllowlistedWebfontUrl } from '@/lib/webfont-allowlist';

/*
 * The /embeds live-preview host-page mockup (brand-preview build). Renders a
 * realistic fake page — newsroom article, library/civic page, advocacy
 * action page, or a generic site — painted in the TENANT's exact colors and
 * typeface, with the real embed widget (passed as children) sitting in
 * context. This is the answer to "it should look like an example on one of
 * their pages," not a bare widget on an Oravan card.
 *
 * Exact-match rules, and why they differ from the widget:
 *  - This chrome is Oravan's OWN /embeds page, so it may use the tenant's
 *    EXACT colors (no AA gating — it's a preview of their page) and load
 *    their EXACT webfont. That's fine here precisely because it is NOT the
 *    cross-origin widget iframe, whose zero-third-party-request promise the
 *    widget keeps by staying on the closed system-font stacks.
 *  - The widget iframe nested in `children` is unchanged: it renders with
 *    the validated, AA-gated theme. So if a tenant's real colors fail AA,
 *    the surrounding mock page shows their exact colors while the widget
 *    inside shows the accessible fallback — the honest real-world outcome.
 *
 * The webfont <link> is host-allowlisted twice (route + here) so this can
 * only ever load a stylesheet from a known font CDN, never arbitrary
 * third-party CSS from the submitted URL.
 */

export type MockupArchetype = 'generic' | 'newsroom' | 'library' | 'advocacy';

export const MOCKUP_ARCHETYPES: MockupArchetype[] = ['generic', 'newsroom', 'library', 'advocacy'];

export interface HostPageMockupProps {
  archetype: MockupArchetype;
  surface: string;
  ink: string;
  accent: string;
  fontFamily?: string;
  webfontHref?: string;
  siteName?: string;
  logoUrl?: string;
  children: ReactNode;
}

export function HostPageMockup({
  archetype,
  surface,
  ink,
  accent,
  fontFamily,
  webfontHref,
  siteName,
  logoUrl,
  children,
}: HostPageMockupProps) {
  const t = useTranslations('embeds');

  // Load the tenant's exact webfont for the mockup chrome (allowlisted only).
  useEffect(() => {
    if (!webfontHref || !isAllowlistedWebfontUrl(webfontHref)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = webfontHref;
    link.dataset.oravanMockupFont = '1';
    document.head.appendChild(link);
    return () => {
      link.remove();
    };
  }, [webfontHref]);

  const muted = `color-mix(in srgb, ${ink} 62%, ${surface})`;
  const hairline = `color-mix(in srgb, ${ink} 16%, transparent)`;
  const faintFill = `color-mix(in srgb, ${accent} 10%, transparent)`;

  const rootStyle: CSSProperties = {
    backgroundColor: surface,
    color: ink,
    fontFamily: fontFamily || 'system-ui, sans-serif',
  };

  const name = siteName?.trim() || t('mockupFallbackSite');

  const masthead = (
    <header
      className="flex items-center gap-3 px-5 py-3"
      style={{ borderBottom: `2px solid ${accent}` }}
    >
      {logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- external, unconfigurable host; a plain img is the point (never proxied/re-hosted)
        <img src={logoUrl} alt="" className="h-7 w-7 shrink-0 object-contain" />
      )}
      <span className="truncate text-base font-bold tracking-tight">{name}</span>
      <span className="ml-auto shrink-0 text-[0.65rem] uppercase tracking-widest" style={{ color: muted }}>
        {t('mockupSimulated')}
      </span>
    </header>
  );

  const widgetSlot = (
    <div className="rounded-lg" style={{ border: `1px solid ${hairline}`, overflow: 'hidden' }}>
      {children}
    </div>
  );

  let body: ReactNode;
  if (archetype === 'newsroom') {
    body = (
      <article className="px-5 py-4">
        <p className="text-[0.7rem] font-bold uppercase tracking-widest" style={{ color: accent }}>
          {t('mockupNewsKicker')}
        </p>
        <h2 className="mt-1 text-2xl font-bold leading-tight">{t('mockupNewsHeadline')}</h2>
        <p className="mt-1 text-xs" style={{ color: muted }}>
          {t('mockupNewsByline')}
        </p>
        <p className="mt-3 text-sm leading-relaxed">{t('mockupNewsBody1')}</p>
        <figure className="my-4">
          {widgetSlot}
          <figcaption className="mt-1 text-[0.7rem]" style={{ color: muted }}>
            {t('mockupWidgetCaption')}
          </figcaption>
        </figure>
        <p className="text-sm leading-relaxed">{t('mockupNewsBody2')}</p>
      </article>
    );
  } else if (archetype === 'library') {
    body = (
      <div className="px-5 py-4">
        <h2 className="text-xl font-bold">{t('mockupLibraryHeading')}</h2>
        <p className="mt-2 text-sm leading-relaxed">{t('mockupLibraryBody')}</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_minmax(0,20rem)]">
          <div className="space-y-2 text-sm leading-relaxed" style={{ color: muted }}>
            <p style={{ color: ink }} className="font-semibold">
              {t('mockupLibrarySidebarHeading')}
            </p>
            <p>{t('mockupLibraryBody2')}</p>
          </div>
          <aside className="rounded-lg p-2" style={{ backgroundColor: faintFill }}>
            {widgetSlot}
            <p className="mt-1 text-[0.7rem]" style={{ color: muted }}>
              {t('mockupWidgetCaption')}
            </p>
          </aside>
        </div>
      </div>
    );
  } else if (archetype === 'advocacy') {
    body = (
      <div className="px-5 py-5 text-center">
        <h2 className="text-2xl font-extrabold" style={{ color: accent }}>
          {t('mockupAdvocacyHeading')}
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed">{t('mockupAdvocacyBody')}</p>
        <div className="mx-auto mt-4 max-w-md text-left">{widgetSlot}</div>
        <p className="mt-2 text-[0.7rem]" style={{ color: muted }}>
          {t('mockupWidgetCaption')}
        </p>
      </div>
    );
  } else {
    body = (
      <div className="px-5 py-4">
        <h2 className="text-xl font-bold">{t('mockupGenericHeading')}</h2>
        <p className="mt-2 text-sm leading-relaxed">{t('mockupGenericBody')}</p>
        <div className="my-4">{widgetSlot}</div>
        <p className="text-sm leading-relaxed" style={{ color: muted }}>
          {t('mockupGenericBody2')}
        </p>
      </div>
    );
  }

  return (
    <div
      className="overflow-hidden rounded-card border border-line"
      style={rootStyle}
      // Illustrative preview chrome — not a live region, and clearly labeled.
      aria-label={t('mockupRegionLabel', { name })}
      role="group"
    >
      {masthead}
      {body}
    </div>
  );
}

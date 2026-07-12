import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { after } from 'next/server';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { billSlug, getBill, localizeBill } from '@/lib/core';
import { formatCitation } from '@/lib/format';
import { registrableDomain } from '@/lib/embed-referrer';
import { noteImpression } from '@/lib/impressions';
import {
  FONT_VALUES,
  RADIUS_VALUES,
  safeAccent,
  safeAttribution,
  safeBrandless,
  safeFontKey,
  safeRadiusKey,
  type FontKey,
  type RadiusKey,
} from '@/lib/embed-theme';
import { resolveTenantAccess } from '@/lib/tenancy';
import { ActionPanelWidget, type ActionPanelBillData } from '@/components/embed/ActionPanelWidget';

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ brandless?: string }>;
}): Promise<Metadata> {
  const { brandless } = await searchParams;
  return {
    title: safeBrandless(brandless) ? 'Action panel' : 'Oravan — action panel',
    robots: { index: false, follow: false },
  };
}

function normalizeLocale(value: string | undefined): 'en' | 'es' {
  return value === 'es' ? 'es' : 'en';
}

type EmbedLocale = 'en' | 'es';
const DICTS: Record<EmbedLocale, typeof en> = { en, es };

interface EmbedThemeInput {
  accent?: string;
  radiusKey: RadiusKey;
  fontKey: FontKey;
}

/*
 * The action-panel embed (S19, paid tier only). Same theming/locale
 * conventions as rep-lookup (S13) and bill-card (S14) - see those files'
 * header comments - but this is the FIRST embed page that gates on a
 * tenant token before rendering anything interactive. Every non-live state
 * below is resolved server-side, before the client widget ever mounts, so
 * a bad/missing/revoked token, an inactive subscription, missing ToS
 * acceptance, or an unauthorized domain each render honest, on-brand,
 * never-blank copy - never a crash, never a silent fallback to the free
 * citizen flow (see lib/tenancy.ts's resolveTenantAccess doc comment for
 * why a present-but-invalid token is never treated as absent).
 *
 * Auth checks run BEFORE the bill lookup on purpose: a stranger without a
 * working token learns nothing about which slugs exist in this widget's
 * gated context, even though bill existence is separately public on the
 * citizen site's own /bills/[slug] pages.
 */
export default async function ActionPanelEmbedPage({
  searchParams,
}: {
  searchParams: Promise<{
    locale?: string;
    slug?: string;
    token?: string;
    accent?: string;
    radius?: string;
    font?: string;
    brandless?: string;
    attribution?: string;
  }>;
}) {
  const { locale: localeParam, slug, token, accent, radius, font, brandless, attribution } = await searchParams;
  const locale = normalizeLocale(localeParam);
  const t = DICTS[locale];
  const brandlessFlag = safeBrandless(brandless);
  const theme: EmbedThemeInput = {
    accent: safeAccent(accent),
    radiusKey: safeRadiusKey(radius),
    fontKey: safeFontKey(font),
  };

  const access = await resolveTenantAccess(token ?? null);
  if (!access.ok) {
    return (
      <ActionPanelMessage locale={locale} theme={theme} brandless={brandlessFlag}>
        {access.reason === 'tos_required' ? (
          <p className="re-note" role="alert">
            {t.embed.actionPanelTosRequired}
          </p>
        ) : (
          <p className="re-note" role="alert">
            {t.embed.actionPanelUnauthorizedTitle}{' '}
            <a className="re-link" href="/embeds" target="_blank" rel="noopener noreferrer">
              {t.embed.actionPanelUnauthorizedLink} ↗
            </a>
          </p>
        )}
      </ActionPanelMessage>
    );
  }

  // Domain allowlist: best-effort, page-only (see this file's header
  // comment on why the API layer can't meaningfully check this). Referer
  // ABSENT -> allow (cannot enforce). Referer present but its registrable
  // domain isn't in a NON-EMPTY allowlist -> block. An empty allowlist
  // means the tenant hasn't configured one yet -> no restriction to check.
  const { tenant } = access;
  if (tenant.domainAllowlist.length > 0) {
    const referer = (await headers()).get('referer');
    if (referer) {
      const domain = registrableDomain(referer);
      if (!domain || !tenant.domainAllowlist.includes(domain)) {
        return (
          <ActionPanelMessage locale={locale} theme={theme} brandless={brandlessFlag}>
            <p className="re-error" role="alert">
              {t.embed.actionPanelDomainNotAuthorized}
            </p>
          </ActionPanelMessage>
        );
      }
    }
  }

  const raw = typeof slug === 'string' && slug.length > 0 ? getBill(slug) : undefined;
  const bill = raw ? localizeBill(raw, locale) : null;
  if (!bill) {
    return (
      <ActionPanelMessage locale={locale} theme={theme} brandless={brandlessFlag}>
        <p className="re-error" role="alert">
          {t.embed.billNotFound}
        </p>
      </ActionPanelMessage>
    );
  }

  const billData: ActionPanelBillData = {
    slug: billSlug(bill),
    citation: formatCitation(bill.bill_type, bill.bill_number),
    headline: bill.ai_headline,
    officialTitle: bill.short_title ?? bill.title,
  };

  // S20 (F6): count an impression only on this fully-authorized live-render
  // branch — after ok:true, the domain check, and a real bill are all
  // confirmed. Every refusal branch above (unauthorized/tos_required/
  // domain-blocked/bill-not-found) returns before reaching here, so it never
  // counts — crediting a broken installation's impressions would be the
  // opposite of honest disclosure. Scheduled via after() so a slow/failed
  // write can never delay this response (lib/impressions.ts never throws).
  after(() => noteImpression(tenant.tenantId));

  return (
    <ActionPanelWidget
      initialLocale={locale}
      token={token!}
      bill={billData}
      theme={theme}
      brandless={brandlessFlag}
      attribution={safeAttribution(attribution)}
    />
  );
}

/** Shared server-rendered chrome for every non-live (refusal) state. */
function ActionPanelMessage({
  locale,
  theme,
  brandless,
  children,
}: {
  locale: EmbedLocale;
  theme: EmbedThemeInput;
  brandless: boolean;
  children: React.ReactNode;
}) {
  const t = DICTS[locale];
  const themeStyle: React.CSSProperties = {
    ...(theme.accent ? { ['--oravan-accent' as string]: theme.accent } : {}),
    ['--oravan-radius' as string]: RADIUS_VALUES[theme.radiusKey],
    ['--oravan-font' as string]: FONT_VALUES[theme.fontKey],
  };
  return (
    <main className="re-root" lang={locale} style={themeStyle}>
      <div className="re-header">
        <p className="bc-citation">{brandless ? '' : t.common.appName}</p>
      </div>
      {children}
    </main>
  );
}

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { after } from 'next/server';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { billSlug, getBill, localizeBill } from '@/lib/core';
import { endedDecision, statusKeyFor } from '@/lib/journey';
import { formatCitation } from '@/lib/format';
import { registrableDomain } from '@/lib/embed-referrer';
import { noteImpression } from '@/lib/impressions';
import {
  resolveEmbedTheme,
  safeAttribution,
  safeBrandless,
  type ResolvedEmbedTheme,
} from '@/lib/embed-theme';
import { resolveTenantAccess } from '@/lib/tenancy';
import { EMBEDS_PAGES_PUBLIC } from '@/lib/site';
import { ActionPanelWidget, type ActionPanelBillData } from '@/components/embed/ActionPanelWidget';
import { EmbedThemeStyle } from '@/components/embed/EmbedThemeStyle';

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
    surface?: string;
    ink?: string;
    mode?: string;
    radius?: string;
    font?: string;
    brandless?: string;
    attribution?: string;
  }>;
}) {
  const { locale: localeParam, slug, token, accent, surface, ink, mode, radius, font, brandless, attribution } =
    await searchParams;
  const locale = normalizeLocale(localeParam);
  const t = DICTS[locale];
  const brandlessFlag = safeBrandless(brandless);
  const theme = resolveEmbedTheme({ accent, surface, ink, mode, radius, font });

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
            {/* /embeds is hidden until embeds come back (lib/site.ts
                EMBEDS_PAGES_PUBLIC, 2026-09-28); until then the plans
                sentence lives on /partners, so the link goes there rather
                than to a 404. */}
            <a
              className="re-link"
              href={EMBEDS_PAGES_PUBLIC ? '/embeds' : '/partners'}
              target="_blank"
              rel="noopener noreferrer"
            >
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

  /*
   * A BILL OF AN ENDED CONGRESS HAS NO CALL TO MAKE (stage 3 of the
   * new-Congress work, 2026-11-13; page 1, rule 6). The panel would offer a
   * stance and a script for a decision no chamber can make any more, and the
   * script route refuses it (409 `ended`), so the widget is not mounted: the
   * partner's page shows the bill's citation, its official title and the
   * approved sentence instead, in the same message frame as the other
   * no-panel states. No AI-written words are printed in this frame (the
   * official title is the record's), so it carries no AI label; system
   * fonts, zero cookies and zero third-origin requests are the frame's own.
   * The ended list is empty until the January 2027 switch, so today no bill
   * takes this path.
   *
   * THE SETTLED STATE IS LEFT AS IT IS here on purpose: reading it would
   * change what partners see today, and this stage changes nothing while the
   * list is empty. A settled bill's script is already refused by the route
   * (409 `settled`); CLAUDE.md rule 6 still names this gap.
   */
  const ended = endedDecision(bill);
  if (ended) {
    const lines =
      ended.kind === 'law'
        ? [t.bill.settled.law, t.bill.ended.lawLine]
        : ended.kind === 'presented'
          ? [t.bill.ended.presented]
          : ended.kind === 'decided'
            ? [t.bills.status[statusKeyFor(bill) as keyof typeof t.bills.status], t.bill.ended.statusLong]
            : [t.bill.ended.note];
    return (
      <ActionPanelMessage locale={locale} theme={theme} brandless={brandlessFlag}>
        <div data-ended-panel={ended.kind}>
          <p className="bc-citation">{formatCitation(bill.bill_type, bill.bill_number)}</p>
          <p className="re-title">{bill.short_title ?? bill.title}</p>
          {lines.map((line) => (
            <p key={line} className="re-note" data-ended-note="">
              {line}
            </p>
          ))}
        </div>
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
    <>
      <EmbedThemeStyle theme={theme} />
      <ActionPanelWidget
        initialLocale={locale}
        token={token!}
        bill={billData}
        brandless={brandlessFlag}
        attribution={safeAttribution(attribution)}
      />
    </>
  );
}

/**
 * Shared server-rendered chrome for every non-live (refusal) state. Renders
 * its own EmbedThemeStyle: refusal iframes never resize (no client widget
 * mounts), so the :root-level style tag is the only thing keeping the whole
 * fixed-height frame — including the band below this short content — on the
 * tenant's palette.
 */
function ActionPanelMessage({
  locale,
  theme,
  brandless,
  children,
}: {
  locale: EmbedLocale;
  theme: ResolvedEmbedTheme;
  brandless: boolean;
  children: React.ReactNode;
}) {
  const t = DICTS[locale];
  return (
    <>
      <EmbedThemeStyle theme={theme} />
      <main className="re-root" lang={locale}>
        <div className="re-header">
          <p className="bc-citation">{brandless ? '' : t.common.appName}</p>
        </div>
        {children}
      </main>
    </>
  );
}

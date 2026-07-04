import { ImageResponse } from 'next/og';
import { getFormatter, getTranslations } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { billSlug, getAllBills, getBill, localizeBill } from '@/lib/data';
import { formatCitation } from '@/lib/format';
import syncState from '@/data/sync-state.json';

/*
 * Per-bill share card (WhatsApp/iMessage/Slack previews). Same brand idiom as
 * the locale-level card (app/[locale]/opengraph-image.tsx): ink-navy ground,
 * booth-gold accents, system sans.
 *
 * Hard rules for this surface: a forwarded card is a redistribution surface,
 * so it never carries AllSides/lean labels (settled decision) and no advocacy
 * copy — citation, headline, status, freshness only. The AI headline is
 * labeled in-image so the disclosure travels with the picture.
 */

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Rostra';

// Same param set as the page: 2 locales x every bill, prerendered at build.
export function generateStaticParams() {
  return routing.locales.flatMap((locale) =>
    getAllBills().map((b) => ({ locale, id: billSlug(b) }))
  );
}

// Satori has no ellipsis-on-overflow across wrapped lines; trim in JS instead.
const clamp = (s: string, max = 140) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

export default async function OgImage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  const raw = getBill(id);
  // Unknown slug: fall back to a brand-only card rather than erroring the route.
  const bill = raw ? localizeBill(raw, locale) : undefined;

  const t = await getTranslations({ locale, namespace: 'og' });
  const tAll = await getTranslations({ locale });
  const format = await getFormatter({ locale });

  // Freshness: data/sync-state.json `lastRun` is when the nightly sync last
  // refreshed the corpus (statuses refresh every run) — the honest "as of".
  const asOf = t('dataAsOf', {
    date: format.dateTime(new Date(syncState.lastRun), { year: 'numeric', month: 'long', day: 'numeric' }),
  });

  // Label the headline as AI only when it IS the AI headline; the official
  // title fallback (rare: decode pending) must not be marked as AI content.
  const isAiHeadline = Boolean(bill?.ai_headline);
  const headline = bill ? (bill.ai_headline ?? bill.short_title ?? bill.title) : 'Rostra';

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 72,
          background: '#11182E',
          color: '#FAF6EE',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <div
            style={{
              width: 60,
              height: 60,
              borderRadius: 14,
              background: '#E8A317',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 34,
            }}
          >
            📞
          </div>
          <div style={{ fontSize: 44, fontWeight: 700, letterSpacing: -1 }}>Rostra</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {bill && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 34 }}>
              <span style={{ color: '#F2B33D', fontWeight: 700 }}>
                {formatCitation(bill.bill_type, bill.bill_number)}
              </span>
              <span style={{ color: 'rgba(250,246,238,0.5)' }}>·</span>
              <span style={{ color: 'rgba(250,246,238,0.88)', fontWeight: 600 }}>
                {tAll(`bills.status.${bill.status}`)}
              </span>
            </div>
          )}
          <div
            style={{
              marginTop: 22,
              fontSize: 58,
              fontWeight: 700,
              lineHeight: 1.15,
              letterSpacing: -1,
            }}
          >
            {clamp(headline)}
          </div>
          {isAiHeadline && (
            <div style={{ display: 'flex', marginTop: 30 }}>
              <div
                style={{
                  display: 'flex',
                  border: '3px solid #F2B33D',
                  color: '#F2B33D',
                  borderRadius: 999,
                  padding: '10px 26px',
                  fontSize: 27,
                  fontWeight: 600,
                }}
              >
                {t('aiDecoded')}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', fontSize: 26, color: 'rgba(250,246,238,0.7)' }}>{asOf}</div>
      </div>
    ),
    size
  );
}

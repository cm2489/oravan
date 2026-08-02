import { ImageResponse } from 'next/og';
import { getTranslations } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { billSlug, getAllBills, getBill, localizeBill } from '@/lib/core';
import { formatCitation } from '@/lib/format';
import { dataAsOfString } from '@/lib/freshness';
import { markDataUri, wordmarkDataUri, WORDMARK_RATIO } from '@/lib/og-brand';

/*
 * Per-bill share card (WhatsApp/iMessage/Slack previews). Same brand idiom as
 * the locale-level card (app/[locale]/opengraph-image.tsx): ink ground,
 * MONOCHROME paper lockup (`go` is 2.75:1 on ink and never carries the mark
 * there), `go-bright` as the single dark-ground accent, system sans. Re-keyed
 * to variant B 2026-08-02 — this card shipped the retired Field Notebook
 * palette for a month after the #104 refresh, so every forwarded bill link
 * previewed in the old identity while the site card previewed in the new one.
 * Palette literals restated because Satori resolves no CSS vars; keep in
 * lockstep with globals.css (--color-ink, --color-paper, --color-go-bright).
 *
 * Hard rules for this surface: a forwarded card is a redistribution surface,
 * so it never carries AllSides/lean labels (settled decision) and no advocacy
 * copy — citation, headline, status, freshness only. The AI headline is
 * labeled in-image so the disclosure travels with the picture — drawn as the
 * on-dark AI chip (paper outline, stamp radius scaled ~2x for the 1200px
 * canvas), never a pill: nothing in Oravan is a pill, this surface included.
 */

const INK = '#16191b'; // --color-ink
const PAPER = '#ffffff'; // --color-paper
const GO_BRIGHT = '#5fd39a'; // --color-go-bright — the dark-ground green
const PAPER_SOFT = 'rgba(255,255,255,0.86)';
const PAPER_MUTE = 'rgba(255,255,255,0.7)';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Oravan';

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

  // Freshness: the shared stamp helper (lib/freshness.ts) renders the honest
  // "as of" from getFreshness().checkedAt — KTD-1's single code path for
  // every freshness claim, on-site and on this forwarded card alike.
  const asOf = await dataAsOfString(locale);

  // Label the headline as AI only when it IS the AI headline; the official
  // title fallback (rare: decode pending) must not be marked as AI content.
  const isAiHeadline = Boolean(bill?.ai_headline);
  const headline = bill ? (bill.ai_headline ?? bill.short_title ?? bill.title) : 'Oravan';

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
          background: INK,
          color: PAPER,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <img src={markDataUri(PAPER)} width={60} height={60} alt="" />
          <img src={wordmarkDataUri(PAPER)} width={Math.round(44 * WORDMARK_RATIO)} height={44} alt="" />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {bill && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 34 }}>
              <span style={{ color: GO_BRIGHT, fontWeight: 700 }}>
                {formatCitation(bill.bill_type, bill.bill_number)}
              </span>
              <span style={{ color: PAPER_MUTE }}>·</span>
              <span style={{ color: PAPER_SOFT, fontWeight: 600 }}>
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
                  border: `3px solid ${PAPER}`,
                  color: PAPER,
                  borderRadius: 6,
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

        <div style={{ display: 'flex', fontSize: 26, color: PAPER_MUTE }}>{asOf}</div>
      </div>
    ),
    size
  );
}

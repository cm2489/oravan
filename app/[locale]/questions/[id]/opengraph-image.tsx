import { ImageResponse } from 'next/og';
import { getTranslations } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { getMoment, getMoments } from '@/lib/moments';
import { momentDek } from '@/lib/moments-ui';

// Same local helper the page itself declares (page.tsx:28) — the {en,es}
// pair type is inline there too, so there is nothing shared to import.
const localeText = (l: { en: string; es: string }, locale: string): string =>
  locale === 'es' ? l.es : l.en;
import { markDataUri, wordmarkDataUri, WORDMARK_RATIO } from '@/lib/og-brand';

/*
 * Per-question share card (Wave B ruling #3, 2026-08-04). Same variant-B
 * idiom as the site and bill cards: ink ground, MONOCHROME paper lockup
 * (`go` is 2.75:1 on ink and never carries the mark there), `go-bright` as
 * the single accent, system sans, the UNBOXED AI label. Palette literals
 * restated because Satori resolves no CSS vars; keep in lockstep with
 * globals.css (--color-ink, --color-paper, --color-go-bright).
 *
 * A forwarded card is a redistribution surface: question name, dek, vehicle
 * count — no advocacy copy, no lean labels. The dek is AI-drafted summary
 * text, so the AI label travels in-image, exactly as on the bill cards.
 * With this card live, the page's twitter metadata claims
 * summary_large_image again (the Wave-A honest-half fix reverted in the
 * same commit that makes the claim true).
 */

const INK = '#16191b'; // --color-ink
const PAPER = '#ffffff'; // --color-paper
const GO_BRIGHT = '#5fd39a'; // --color-go-bright — the dark-ground green
const PAPER_SOFT = 'rgba(255,255,255,0.86)';
const PAPER_MUTE = 'rgba(255,255,255,0.7)';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Oravan';

// Live + settled both prerender (settled pages still render and get shared);
// retired ids fall through to the brand-only card, mirroring the page's 404
// posture without erroring the image route.
export function generateStaticParams() {
  return routing.locales.flatMap((locale) =>
    getMoments()
      .filter((m) => m.state !== 'retired')
      .map((m) => ({ locale, id: m.id }))
  );
}

const clamp = (s: string, max = 120) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

export default async function OgImage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  const moment = getMoment(id);
  const live = moment && moment.state !== 'retired' ? moment : null;

  const t = await getTranslations({ locale, namespace: 'og' });
  const tAll = await getTranslations({ locale });

  const name = live ? localeText(live.name, locale) : 'Oravan';
  const dek = live ? momentDek(localeText(live.summary, locale)) : '';
  const vehicleCount = live ? live.vehicles.length : 0;

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
          <img
            src={wordmarkDataUri(PAPER)}
            width={Math.round(44 * WORDMARK_RATIO)}
            height={44}
            alt=""
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {live && (
            <div
              style={{
                display: 'flex',
                color: GO_BRIGHT,
                fontSize: 30,
                fontWeight: 700,
                letterSpacing: 2,
                textTransform: 'uppercase',
              }}
            >
              {tAll('moments.kicker')}
            </div>
          )}
          <div
            style={{
              marginTop: 20,
              fontSize: 62,
              fontWeight: 700,
              lineHeight: 1.12,
              letterSpacing: -1,
            }}
          >
            {clamp(name)}
          </div>
          {dek && (
            <div
              style={{
                marginTop: 22,
                fontSize: 32,
                lineHeight: 1.35,
                color: PAPER_SOFT,
                maxWidth: 980,
              }}
            >
              {clamp(dek, 140)}
            </div>
          )}
          {live && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 28 }}>
              <div
                style={{
                  display: 'flex',
                  background: PAPER,
                  color: INK,
                  borderRadius: 6,
                  padding: '4px 12px',
                  fontSize: 24,
                  fontWeight: 800,
                  letterSpacing: 1.2,
                }}
              >
                {tAll('home.aiMarker')}
              </div>
              <div
                style={{
                  display: 'flex',
                  color: PAPER_SOFT,
                  fontSize: 24,
                  fontWeight: 700,
                  letterSpacing: 2,
                  textTransform: 'uppercase',
                }}
              >
                {t('aiDrafted')}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', fontSize: 26, color: PAPER_MUTE }}>
          {live ? tAll('moments.cardVehicleCount', { count: vehicleCount }) : ''}
        </div>
      </div>
    ),
    size
  );
}

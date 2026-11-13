import { ImageResponse } from 'next/og';
import { markDataUri, wordmarkDataUri, WORDMARK_RATIO } from '@/lib/og-brand';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Oravan';

const TAGLINES: Record<string, { tag: string; sub: string }> = {
  en: { tag: 'Your line to Congress', sub: 'Read bills in plain words and call your members of Congress.' },
  es: { tag: 'Tu línea con el Congreso', sub: 'Lee proyectos de ley en palabras claras y llama a tus miembros del Congreso.' },
};

// Palette is the live token set from app/globals.css, restated as literals because
// Satori resolves neither CSS vars nor currentColor (see lib/og-brand.ts). Keep in
// lockstep with globals.css: --color-go-deep, --color-paper, --color-go-bright.
//
// The ground is the masthead band's green, cream lockup on it, as at the top of
// every page (the owner's look, 2026-11-13: "dark green strip, cream logo"). The
// lockup is MONOCHROME: paper on go-deep is 11.32:1, while `go` (#1d5e43) on
// go-deep is 1.54:1 and must never carry the mark. `go-bright` is spent on the
// tagline only (6.61:1 on go-deep); the soft paper line is 8.82:1. Computed
// with lib/contrast.ts.
const BAND = '#133f2d'; // --color-go-deep — the masthead band's green (owner's look, 2026-11-13)
const PAPER = '#fcfaf4'; // --color-paper
const GO_BRIGHT = '#7fd3a2'; // --color-go-bright — the dark-ground green
const PAPER_SOFT = 'rgba(252,250,244,0.86)';

export default async function OgImage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const { tag, sub } = TAGLINES[locale] ?? TAGLINES.en;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: 80,
          background: BAND,
          color: PAPER,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
          <img src={markDataUri(PAPER)} width={88} height={88} alt="" />
          <img src={wordmarkDataUri(PAPER)} width={Math.round(72 * WORDMARK_RATIO)} height={72} alt="" />
        </div>
        <div style={{ marginTop: 36, fontSize: 48, color: GO_BRIGHT, fontWeight: 600 }}>{tag}</div>
        <div style={{ marginTop: 16, fontSize: 32, color: PAPER_SOFT }}>{sub}</div>
      </div>
    ),
    size
  );
}

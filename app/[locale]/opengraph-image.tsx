import { ImageResponse } from 'next/og';
import { markDataUri, wordmarkDataUri, WORDMARK_RATIO } from '@/lib/og-brand';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Oravan';

const TAGLINES: Record<string, { tag: string; sub: string }> = {
  en: { tag: 'Your line to Congress', sub: 'Find your reps. Understand the bills. Make the call.' },
  es: { tag: 'Tu línea con el Congreso', sub: 'Encuentra a tus representantes. Entiende los proyectos de ley. Haz la llamada.' },
};

// Palette is the live token set from app/globals.css, restated as literals because
// Satori resolves neither CSS vars nor currentColor (see lib/og-brand.ts). Keep in
// lockstep with globals.css: --color-ink, --color-paper, --color-go-bright.
//
// The lockup is MONOCHROME on this dark ground, matching the footer's treatment:
// `go` (#0f6c4a) sits at 2.75:1 on ink and must never carry the mark there. The
// dark-ground green token, `go-bright`, is spent on the tagline only (10.3:1 on ink).
const INK = '#16191b'; // --color-ink
const PAPER = '#ffffff'; // --color-paper
const GO_BRIGHT = '#5fd39a'; // --color-go-bright — the dark-ground green
const PAPER_SOFT = 'rgba(255,255,255,0.86)';

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
          background: INK,
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

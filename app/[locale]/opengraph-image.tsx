import { ImageResponse } from 'next/og';
import { markDataUri, wordmarkDataUri, WORDMARK_RATIO } from '@/lib/og-brand';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Oravan';

const TAGLINES: Record<string, { tag: string; sub: string }> = {
  en: { tag: 'Your line to Congress', sub: 'Find your reps. Understand the bills. Make the call.' },
  es: { tag: 'Tu línea con el Congreso', sub: 'Encuentra a tus representantes. Entiende las leyes. Haz la llamada.' },
};

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
          background: '#1B1611',
          color: '#F3ECDD',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
          <img src={markDataUri('#D9B65C')} width={88} height={88} alt="" />
          <img src={wordmarkDataUri('#F3ECDD')} width={Math.round(72 * WORDMARK_RATIO)} height={72} alt="" />
        </div>
        <div style={{ marginTop: 36, fontSize: 48, color: '#D9B65C', fontWeight: 600 }}>{tag}</div>
        <div style={{ marginTop: 16, fontSize: 32, color: 'rgba(243,236,221,0.85)' }}>{sub}</div>
      </div>
    ),
    size
  );
}

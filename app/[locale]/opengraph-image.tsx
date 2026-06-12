import { ImageResponse } from 'next/og';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Cabina';

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
          background: '#11182E',
          color: '#FAF6EE',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <div
            style={{
              width: 88,
              height: 88,
              borderRadius: 20,
              background: '#E8A317',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 52,
            }}
          >
            📞
          </div>
          <div style={{ fontSize: 96, fontWeight: 700, letterSpacing: -2 }}>Cabina</div>
        </div>
        <div style={{ marginTop: 36, fontSize: 48, color: '#F2B33D', fontWeight: 600 }}>{tag}</div>
        <div style={{ marginTop: 16, fontSize: 32, color: 'rgba(250,246,238,0.85)' }}>{sub}</div>
      </div>
    ),
    size
  );
}

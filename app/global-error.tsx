'use client';

/*
 * Last-resort boundary for a throw in the ROOT layout, above the locale
 * provider. It replaces the whole document, so it must supply its own <html>
 * and <body> and cannot read messages — NextIntlClientProvider lives below it
 * and is, by definition, not mounted when this renders.
 *
 * English-only is therefore a structural constraint, not an oversight or a
 * bilingual-parity exception: there is no locale to read here. Styles are
 * inline for the same reason — a root-layout failure may mean the stylesheet
 * never attached. Colors are the live tokens (--color-ink, --color-paper),
 * restated as literals because no CSS variables are guaranteed at this point.
 *
 * app/[locale]/error.tsx is the boundary users will actually see; this one is
 * the net under the net.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Digest only — never the message, which can carry user-entered text.
  if (typeof window !== 'undefined') {
    console.error('[oravan] root error', error.digest ?? '(no digest)');
  }

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          background: '#ffffff',
          color: '#16191b',
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
        }}
      >
        <main style={{ maxWidth: '33rem' }} role="alert">
          <h1 style={{ fontSize: '1.75rem', fontWeight: 800, margin: 0 }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: '1.05rem', lineHeight: 1.6, color: '#4a544e' }}>
            Oravan hit an unexpected error. Reloading usually fixes it.
          </p>
          <p style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={reset}
              style={{
                minHeight: '3rem',
                padding: '0 1.5rem',
                borderRadius: '8px',
                border: '2px solid #0f6c4a',
                background: '#0f6c4a',
                color: '#ffffff',
                fontWeight: 700,
                fontSize: '1rem',
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages --
                global-error replaces the entire document when the root layout
                itself has thrown. next/link depends on router context that is
                not guaranteed to be alive at that point, so a full page load
                is the correct — and only reliable — escape hatch here. */}
            <a
              href="/"
              style={{
                minHeight: '3rem',
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0 1.5rem',
                borderRadius: '8px',
                border: '2px solid #16191b',
                color: '#16191b',
                fontWeight: 700,
                textDecoration: 'none',
              }}
            >
              Go home
            </a>
          </p>
        </main>
      </body>
    </html>
  );
}

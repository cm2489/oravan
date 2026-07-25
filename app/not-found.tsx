/*
 * Root 404 — the net for paths that never resolve to a locale segment at all
 * (e.g. /this-does-not-exist). Unknown *in-app* slugs like /bills/nope are
 * caught by app/[locale]/not-found.tsx instead, which keeps the header, footer
 * and reviewed bilingual copy.
 *
 * This file sits ABOVE the locale layout, so there is no html/body around it
 * and no NextIntlClientProvider to read messages from. It therefore supplies
 * its own document and is English-only — a structural constraint of where it
 * lives, not a bilingual-parity exception. Same reasoning as app/global-error.tsx.
 *
 * Styles are inline for the same reason: no guarantee the stylesheet attached.
 * Colors are the live tokens (--color-paper, --color-ink, --color-ink-2, --color-go).
 */
import Link from 'next/link';

export default function RootNotFound() {
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
        <main style={{ maxWidth: '33rem' }}>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 800, margin: 0 }}>Page not found</h1>
          <p style={{ fontSize: '1.05rem', lineHeight: 1.6, color: '#4a544e' }}>
            That page doesn&rsquo;t exist, but your representatives do.
          </p>
          <p>
            <Link
              href="/"
              style={{
                minHeight: '3rem',
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0 1.5rem',
                borderRadius: '8px',
                border: '2px solid #0f6c4a',
                background: '#0f6c4a',
                color: '#ffffff',
                fontWeight: 700,
                textDecoration: 'none',
              }}
            >
              Go home
            </Link>
          </p>
        </main>
      </body>
    </html>
  );
}

import type { Metadata } from 'next';
import { Besley, Libre_Franklin } from 'next/font/google';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { SITE_ORIGIN } from '@/lib/site';
import { Header } from '@/components/Header';
import { LocalePreferenceNote } from '@/components/LocalePreferenceNote';
import { Footer } from '@/components/Footer';
import '../globals.css';

/**
 * Two voices, both self-hosted at build by next/font (never a third-party
 * font link — see CLAUDE.md).
 *
 * Libre Franklin is Oravan's OWN voice: every heading, label, control and line
 * of UI, in both languages. It is `--font-sans`, so it is the default.
 *
 * Besley is the READING voice, and it is spent on exactly two things: a bill's
 * AI-decoded prose and the words a caller says aloud — English and Spanish
 * alike. It is exposed as `--font-reading` and is deliberately NOT mapped to a
 * display token. There is no `font-display` in this system; headings are
 * Franklin. Reach for `font-reading` only on decoded prose or a spoken script.
 *
 * Both are variable fonts (one wght axis), so no `weight` array is passed and
 * the whole 400-900 range ships in one file. `latin` covers every Spanish
 * glyph the product sets (a-acute through n-tilde, inverted marks).
 * Italics are NOT loaded: nothing in the system sets italic type, and adding
 * the italic face would double the reading voice's payload.
 */
const franklin = Libre_Franklin({
  subsets: ['latin'],
  variable: '--font-franklin',
  display: 'swap',
});
const besley = Besley({
  subsets: ['latin'],
  variable: '--font-besley',
  display: 'swap',
});

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'common' });
  return {
    // Absolute base for social-crawler URLs (og:image and friends): link
    // previews fetch from the wild, so relative URLs are useless to them.
    metadataBase: new URL(SITE_ORIGIN),
    title: { default: `${t('appName')} — ${t('tagline')}`, template: `%s — ${t('appName')}` },
    description: t('footer.mission'),
    // Per-locale PWA manifest (app/[locale]/manifest.webmanifest/route.ts) so
    // install chrome ships in the page's own language, not English-only.
    manifest: `/${locale}/manifest.webmanifest`,
    // Soft-public launch (2026-07-08): the citizen-site noindex gate is lifted —
    // pages default to indexable. The embed routes keep their PERMANENT noindex
    // (app/embed/layout.tsx), and robots.ts already keeps crawling open so the
    // sitemap activates immediately. No announcement rides on this deploy.
    // Build identity for post-deploy verification: the data-sync workflows
    // poll production for the SHA they just pushed (scripts/verify-deploy.mjs).
    // Vercel sets VERCEL_GIT_COMMIT_SHA at build time, deploy-hook builds included.
    other: { 'oravan-build': process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev' },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'common' });

  /* data-scroll-behavior="smooth" tells Next.js that app/globals.css sets
     `scroll-behavior: smooth` on <html>, so the router turns it off while it
     resets the scroll position on a page change. In the Next.js version this
     app runs, the router does that ONLY when this attribute is present
     (next/dist/shared/lib/router/utils/disable-smooth-scroll.js). Without it,
     a link followed from a scrolled-down page glided the new page up to the
     top, and a click made during that glide landed on whatever had moved
     under the pointer: a Big Question's vehicle link, or a bill page's "Part
     of a bigger question" link, could be clicked and go nowhere
     (tests/moments.spec.ts, flaky under load). In-page #anchor jumps keep
     the smooth scroll, which is what the CSS rule is for. */
  return (
    <html
      lang={locale}
      data-scroll-behavior="smooth"
      className={`${franklin.variable} ${besley.variable}`}
    >
      <body className="min-h-dvh flex flex-col">
        {/* For the curious who open devtools: the no-trackers claim, verifiable */}
        <script
          dangerouslySetInnerHTML={{
            __html: `console.log("%cOravan","font-size:16px;font-weight:bold","— your voice, carried. No analytics, no trackers, no account: check the Network tab, it's quiet in here. Code: https://github.com/cm2489/oravan");`,
          }}
        />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:bg-ink focus:text-paper focus:px-4 focus:py-2 focus:rounded-control"
        >
          {t('skipToContent')}
        </a>
        <NextIntlClientProvider>
          <Header />
          {/* Client-side language suggestion for Spanish-preferring browsers
              on the EN locale — see the component for why this is not a
              server redirect (localeDetection: false is deliberate). */}
          <LocalePreferenceNote />
          <main id="main" className="flex-1 pb-24 md:pb-0">
            {children}
          </main>
          <Footer />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

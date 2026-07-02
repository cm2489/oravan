import type { Metadata } from 'next';
import { Bricolage_Grotesque, Public_Sans } from 'next/font/google';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import '../globals.css';

const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-display' });
const body = Public_Sans({ subsets: ['latin'], variable: '--font-body' });

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
    title: { default: `${t('appName')} — ${t('tagline')}`, template: `%s — ${t('appName')}` },
    description: t('footer.mission'),
    // LAUNCH GATE: remove once the name/domain is locked - keeps the unbranded
    // test deployment out of search indexes during the feedback phase.
    robots: { index: false, follow: false },
    // Build identity for post-deploy verification: the data-sync workflows
    // poll production for the SHA they just pushed (scripts/verify-deploy.mjs).
    // Vercel sets VERCEL_GIT_COMMIT_SHA at build time, deploy-hook builds included.
    other: { 'rostra-build': process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev' },
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

  return (
    <html lang={locale} className={`${display.variable} ${body.variable}`}>
      <body className="min-h-dvh flex flex-col">
        {/* For the curious who open devtools: the no-trackers claim, verifiable */}
        <script
          dangerouslySetInnerHTML={{
            __html: `console.log("%cRostra","font-size:16px;font-weight:bold","— the platform where citizens addressed power. No analytics, no trackers, no account: check the Network tab, it's quiet in here. Code: https://github.com/cm2489/rostra");`,
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
          <main id="main" className="flex-1 pb-24 md:pb-0">
            {children}
          </main>
          <Footer />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

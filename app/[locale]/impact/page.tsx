import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { hreflangAlternates } from '@/lib/hreflang';
import ImpactPageClient from './ImpactPageClient';

// generateMetadata can only run in a Server Component module — this page's
// content is entirely client-rendered from localStorage (no server data to
// read), so the client component moved to its own file and this thin server
// wrapper carries metadata + hreflang. Before this pass /impact had no
// generateMetadata at all (a 'use client' page can't export one in the same
// module), so it had zero title override and zero hreflang alternates.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'impact' });
  return { title: t('title'), alternates: hreflangAlternates(locale, '/impact') };
}

export default async function ImpactPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <ImpactPageClient />;
}

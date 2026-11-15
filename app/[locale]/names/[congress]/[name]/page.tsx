import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { BillCard } from '@/components/BillCard';
import { Chip } from '@/components/system';
import { routing } from '@/i18n/routing';
import { getAllBills, getBill, teaserFor } from '@/lib/core';
import { hreflangAlternates } from '@/lib/hreflang';
import { sharedNamePages, sharedNamePath, type SharedNamePage } from '@/lib/shared-names';

/*
 * THE PAGE FOR A SHARED NAME (DRAFT, 2026-11-15; waits for the owner to see
 * it). His card 193, Nov 14, 2026, 9:13 PM ET: "Build the small page for
 * shared names, so a name never breaks." The card showed him, for
 * oravan.org/laken-riley-act: "a short page listing S. 5 and H.R. 29, each
 * linking to its own page, with no call button."
 *
 * HOW A READER GETS HERE: a name two or more bills Oravan tracks make.
 * proxy.ts answers it with a 307 to /names/<congress>/<name> (lib/short-address.ts,
 * nameAddressTarget). The Congress is in the address, so the page is stable
 * and the same name in two Congresses has two pages.
 *
 * WHAT IT PRINTS, AND NOTHING MORE (hard rules 3, 4, 6): the short title as
 * the record writes it (in English, marked lang="en": the record's words);
 * one plain sentence that more than one bill Oravan tracks has a short title
 * making this name; the order rule; then each bill as the site's own bill card
 * (components/BillCard: its number, its status in the site's wording, the
 * decoded headline, else the record's title) with its chamber and, when its
 * spelling differs from the others, its own short title. The AI label sits
 * above the list whenever a card shows a decoded headline, as on /bills. No
 * call button, no stance, no member lookup, no coverage, no relation between
 * the bills (data/related-bills.json is not on this branch, so the page says
 * nothing about how they relate rather than guess).
 *
 * THE ORDER is mechanical: House bills, then Senate bills; inside each
 * chamber bills, joint, concurrent, then simple resolutions; then by number
 * (lib/shared-names.ts). The page says so.
 *
 * STATIC (hard rule 2): one page per reachable shared name, in both
 * languages, prerendered from the committed data; dynamicParams is false, so
 * any other address here is the normal not-found. While data/short-titles.json
 * does not exist there are no such pages. NOINDEX: an aid for a typed or
 * shared name, it must not compete with the bill pages in search; it is in no
 * sitemap or feed and uses the site's default share image.
 *
 * Its strings live under `namesPage` in messages/*.json and are left out of
 * the browser's message payload (i18n/client-messages.ts): nothing on the
 * client reads them, and leaving them in would change every page on the site.
 */

export const dynamicParams = false;

function pageFor(congress: string, name: string): SharedNamePage | undefined {
  return sharedNamePages(getAllBills()).find((p) => String(p.congress) === congress && p.name === name);
}

export function generateStaticParams() {
  const pages = sharedNamePages(getAllBills());
  return routing.locales.flatMap((locale) =>
    pages.map((p) => ({ locale, congress: String(p.congress), name: p.name })),
  );
}

/** Every distinct spelling of the record's short title among the bills, in code-point order. */
function spellings(page: SharedNamePage): string[] {
  return [...new Set(page.bills.flatMap((b) => b.titles))].sort();
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; congress: string; name: string }>;
}): Promise<Metadata> {
  const { locale, congress, name } = await params;
  const page = pageFor(congress, name);
  if (!page) notFound();
  const t = await getTranslations({ locale, namespace: 'namesPage' });
  return {
    title: t('metaTitle', { title: spellings(page).join(' / ') }),
    alternates: hreflangAlternates(locale, sharedNamePath(page.congress, page.name)),
    robots: { index: false, follow: true },
  };
}

export default async function SharedNamePage({
  params,
}: {
  params: Promise<{ locale: string; congress: string; name: string }>;
}) {
  const { locale, congress, name } = await params;
  setRequestLocale(locale);
  const page = pageFor(congress, name);
  if (!page) notFound();
  const t = await getTranslations({ locale });
  const titles = spellings(page);
  const rows = page.bills
    .map((b) => {
      const raw = getBill(b.slug);
      return raw ? { bill: b, teaser: teaserFor(raw, locale) } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const anyHeadline = rows.some((r) => r.teaser.headline);

  return (
    <div className="mx-auto max-w-5xl px-4 pt-12 pb-16">
      <p className="text-xs font-bold tracking-[0.06em] text-ink-2 uppercase">{t('namesPage.eyebrow')}</p>
      <h1 className="mt-2 text-h1-bill font-extrabold break-words text-ink">
        {titles.map((title, i) => (
          <span key={title}>
            {i > 0 && <span aria-hidden> / </span>}
            <span lang="en">{title}</span>
          </span>
        ))}
      </h1>
      <p className="mt-2 text-sm text-ink-2">{t('namesPage.recordWords', { count: titles.length })}</p>
      <p className="mt-4 max-w-read text-lede text-ink-2">
        {t('namesPage.intro', { count: rows.length, congress: page.congress })}
      </p>
      <p className="mt-3 max-w-read text-sm text-ink-2">{t('namesPage.order')}</p>
      {anyHeadline && (
        <p className="mt-5">
          <Chip tone="ai" marker={t('common.aiMarker')} className="max-w-read">
            {t('bills.aiNote')}
          </Chip>
        </p>
      )}
      <ul className="mt-6 grid gap-4 md:grid-cols-2" aria-label={t('namesPage.listLabel')}>
        {rows.map(({ bill, teaser }) => (
          <li key={bill.slug}>
            <p className="mb-1.5 text-sm text-ink-2">
              {t(`votes.chamber.${bill.chamber}`)}
              {titles.length > 1 && (
                <>
                  {' · '}
                  {t('namesPage.ownTitle')} <q lang="en">{bill.titles.join(' / ')}</q>
                </>
              )}
            </p>
            <BillCard bill={teaser} />
          </li>
        ))}
      </ul>
    </div>
  );
}

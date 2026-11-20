import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { BillCard } from '@/components/BillCard';
import { MomentStatusLine } from '@/components/MomentStatusLine';
import { Chip } from '@/components/system';
import { routing } from '@/i18n/routing';
import { getAllBills, getBill, teaserFor } from '@/lib/core';
import { chamberSession, rungFor } from '@/lib/docket';
import { dataAsOfString } from '@/lib/freshness';
import { hreflangAlternates } from '@/lib/hreflang';
import { sharedNamePages, sharedNamePath, sharedNameStanding, type SharedNamePage } from '@/lib/shared-names';

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
 * spelling differs from the others, its own short title.
 *
 * WHERE EACH BILL STANDS NOW (the owner's note of Nov 15, 2026: a link opened
 * days later, after the Senate voted and the bill went to the House). Above
 * each card: the record's own "where it stands" line with its date (the line
 * a Big Question's vehicle cards print for twin bills), and, only while the
 * bill page's own floor gate holds a live floor fact for it, that fact's
 * chip with its date (lib/shared-names.ts sharedNameStanding). With no live
 * floor fact on any listed bill there is no tag and no sentence about one.
 * The page prints the data's age (hard rule 6). The ORDER stays mechanical:
 * the line and the tag say which bill is moving, so the order never has to.
 * Under the line the card prints no status label (BillCard `showStatus`),
 * since the two could read as contradicting each other, except for a bill
 * whose Congress has ended: its line is the record's own dated words and its
 * card prints "Ended" or the outcome, as the bill page does; while a chamber is
 * out, a line that would sound live is the record's own words instead
 * (lib/shared-names.ts). The outline is h1, an h2 for each chamber's group,
 * then the cards' h3s; two spellings of the title are heard with "or". The AI label sits
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
 * languages, prerendered from the committed data. Any other address here is
 * the normal not-found, inside the locale boundary: the bills/[id] posture,
 * `dynamicParams = true` + notFound() (with `false`, Next answers above the
 * locale boundary, so /es got the bare English not-found, and the proxy ran
 * twice for one visit: measured 2026-11-15). While data/short-titles.json
 * does not exist there are no such pages. NOINDEX: an aid for a typed or
 * shared name, it must not compete with the bill pages in search; it is in no
 * sitemap or feed and uses the site's default share image.
 *
 * Its strings live under `namesPage` in messages/*.json and are left out of
 * the browser's message payload (i18n/client-messages.ts): nothing on the
 * client reads them, and leaving them in would change every page on the site.
 */

export const dynamicParams = true;

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
  const format = await getFormatter({ locale });
  const dataAsOf = await dataAsOfString(locale);
  const titles = spellings(page);
  const rows = page.bills
    .map((b) => {
      const raw = getBill(b.slug);
      if (!raw) return null;
      // The bill page's own reading: the chamber's announcement only while it is live (rungFor), then billFloorBand.
      const rung = rungFor(raw, b.slug);
      const announced = rung.tier === 't0' ? rung.announced : null;
      const standing = sharedNameStanding(raw, announced ? { chamber: announced.chamber, published: announced.published } : null, {
        sessionOf: (c) => chamberSession(c),
      });
      return { bill: b, teaser: teaserFor(raw, locale, rung), standing };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const anyHeadline = rows.some((r) => r.teaser.headline);
  const anyFloor = rows.some((r) => r.standing.floor);
  // A date-only string: format in UTC or it reads a day early.
  const day = (d: string) => format.dateTime(new Date(d), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

  return (
    <div className="mx-auto max-w-5xl px-4 pt-12 pb-16">
      <p className="text-xs font-bold tracking-[0.06em] text-ink-2 uppercase">{t('namesPage.eyebrow')}</p>
      <h1 className="mt-2 text-h1-bill font-extrabold break-words text-ink">
        {titles.map((title, i) => (
          <span key={title}>
            {/* Seen as a slash; heard as "or", so a screen reader does not run the two spellings together. */}
            {i > 0 && (
              <>
                <span aria-hidden> / </span>
                <span className="sr-only">{` ${t('namesPage.titleOr')} `}</span>
              </>
            )}
            <span lang="en">{title}</span>
          </span>
        ))}
      </h1>
      <p className="mt-2 text-sm text-ink-2">{t('namesPage.recordWords', { count: titles.length })}</p>
      <p className="mt-4 max-w-read text-lede text-ink-2">
        {t('namesPage.intro', { count: rows.length, congress: page.congress })}
      </p>
      <p className="mt-3 max-w-read text-sm text-ink-2">{t('namesPage.order')}</p>
      <p className="mt-3 max-w-read text-sm text-ink-2" data-testid="names-standing-note">
        {t('namesPage.standing')}
        {anyFloor && <> {t('namesPage.standingFloor')}</>} {dataAsOf}.
      </p>
      {anyHeadline && (
        <p className="mt-5">
          <Chip tone="ai" marker={t('common.aiMarker')} className="max-w-read">
            {t('bills.aiNote')}
          </Chip>
        </p>
      )}
      <ul className="mt-6 grid gap-4 md:grid-cols-2" aria-label={t('namesPage.listLabel')}>
        {rows.map(({ bill, teaser, standing }, i) => {
          // THE OUTLINE: h1, then an h2 for each chamber's group (the first card of each
          // chamber carries it, styled exactly as the plain label it replaces), then the
          // cards' h3s. The order puts every House bill before every Senate bill.
          const ChamberLabel = i === 0 || rows[i - 1].bill.chamber !== bill.chamber ? 'h2' : 'span';
          return (
            <li key={bill.slug}>
              <div className="mb-1.5 text-sm text-ink-2">
                <ChamberLabel className="inline">{t(`votes.chamber.${bill.chamber}`)}</ChamberLabel>
                {titles.length > 1 && (
                  <>
                    {' · '}
                    {t('namesPage.ownTitle')}{' '}
                    {bill.titles.map((title, j) => (
                      <span key={title}>
                        {/* As in the heading: seen as a slash, heard as "or". */}
                        {j > 0 && (
                          <>
                            <span aria-hidden> / </span>
                            <span className="sr-only">{` ${t('namesPage.titleOr')} `}</span>
                          </>
                        )}
                        <q lang="en">{title}</q>
                      </span>
                    ))}
                  </>
                )}
              </div>
              {standing.floor && (
                <p className="mb-2" data-testid="names-floor-tag">
                  <Chip tone="floor" dateLabel={day(standing.floor.date)}>
                    {t(standing.floor.key)}
                  </Chip>
                </p>
              )}
              <MomentStatusLine line={standing.line} className="mb-3" />
              {/* The line above says where the bill stands, more precisely than the card's
                  status label could, so the card prints none (the Big Question cards' rule).
                  EXCEPT once the bill's Congress has ended: then the line is the record's own
                  words and the card prints its label, "Ended" or the outcome, exactly as the
                  bill page and every other card do (lib/shared-names.ts sharedNameStanding). */}
              <BillCard bill={teaser} showStatus={standing.ended !== null} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

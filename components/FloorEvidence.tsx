import { ExternalLink } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { coversDisplay } from '@/lib/docket';
import type { FloorSignalSource } from '@/lib/docket';

/*
 * THE CHAMBER'S OWN SENTENCE, QUOTED — the inside of FloorVotePanel's
 * `evidence` slot, on the `announced` kind and nowhere else.
 *
 * ONE COPY, TWO SURFACES (2026-08-12). This was inline JSX on the homepage
 * crown, and the bill page had no announced band at all — the seam #218's
 * verifier disclosed. Giving the bill page its own copy of a claim-bearing,
 * quote-carrying block would have created exactly the divergence this product
 * keeps paying for: two surfaces reading one record and printing two different
 * attributions of it. So the block moved here whole, and both callers render
 * the identical markup from the identical fields.
 *
 * WHAT IT MAY AND MAY NOT DO:
 *   · the QUOTE is ENGLISH VERBATIM in both locales (owner ruling V4) and
 *     carries `lang="en"` so a screen reader switches voice for it. Everything
 *     framing it — the lead-in, the document's name, the coverage phrase, the
 *     link text, the checked-at stamp — is localized.
 *   · the same rule governs `covers_label`, which is the SOURCE's own printed
 *     schedule sentence ("8 a.m., Thursday, August 13"). Verbatim, English,
 *     never re-formatted. `coversDisplay` decides label-vs-derived-date; when
 *     the document printed no label the ISO date is formatted in the reader's
 *     locale as before.
 *   · it NEVER claims a scheduled vote date. Every date printed here belongs
 *     to a document: the announcement's publication day, the schedule's own
 *     coverage sentence, and the hour we last re-read the source.
 *
 * The keys live under `home.*` because that is where the crown introduced them
 * and where docs/es-review-2026-08-packet.md has them queued for review; they
 * are read through the untyped root translator so the bill page shares the
 * strings rather than growing a second, drifting set.
 */
export interface FloorEvidenceAnnouncement {
  quote: string;
  url: string;
  /** The announcing document's own publication date, YYYY-MM-DD. */
  published: string;
  covers: string | null;
  coversLabel: string | null;
  source: FloorSignalSource;
}

export async function FloorEvidence({
  announcement,
  checkedAt,
}: {
  announcement: FloorEvidenceAnnouncement;
  /** data/floor-signals.json's `_meta.fetched_at` — critic A-1's "as of". */
  checkedAt: string | null;
}) {
  const t = await getTranslations('home');
  const format = await getFormatter();

  /* UTC, for the same reason every other bare `YYYY-MM-DD` on this site is
     formatted in UTC: parsed as UTC midnight and rendered in a negative-offset
     zone it prints the day before, and a dated claim beside amber has to be
     the right day. The checked-at stamp is a full instant and keeps its own
     zone, printed, because a bare hour that might be anyone's afternoon is
     worse than no hour at all. */
  const day = (iso: string) =>
    format.dateTime(new Date(iso), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  const instant = (iso: string) =>
    format.dateTime(new Date(iso), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });

  const covers = coversDisplay(announcement);

  return (
    <>
      <span className="mb-1 block text-2xs font-extrabold tracking-[0.1em] text-go-pale uppercase not-italic">
        {t('evidenceLead')}
      </span>
      <span lang="en">{`“${announcement.quote}”`}</span>
      <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-sm text-go-pale">
        <span>
          {t(
            announcement.source === 'daily-digest'
              ? 'evidenceSourceDigest'
              : 'evidenceSourceWeekly'
          )}
          {' · '}
          <span className="tabular-nums">{day(announcement.published)}</span>
          {covers ? ' · ' : ''}
          {covers?.verbatim ? (
            /* The document's own words for the meeting it covers. English,
               unformatted, and marked as such — the ISO derivation beside it
               is ours, and this is the sentence it was derived FROM. */
            <span lang="en">{t('evidenceCovers', { date: covers.label })}</span>
          ) : covers ? (
            <span className="tabular-nums">{t('evidenceCovers', { date: day(covers.iso) })}</span>
          ) : null}
        </span>
        {/* External, same convention as every other link out to the official
            record on this site (the bill page's "View the official record"):
            new tab, noopener. */}
        <a
          href={announcement.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-paper underline underline-offset-4 hover:decoration-[3px]"
        >
          {t('evidenceLink')}
          <ExternalLink className="h-4 w-4 flex-none" aria-hidden />
        </a>
        {checkedAt && (
          <span className="tabular-nums">
            {t('floorCheckedAt', { date: instant(checkedAt) })}
          </span>
        )}
      </span>
    </>
  );
}

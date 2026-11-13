import { ExternalLink } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { glossaryTag } from '@/components/glossary-tags';
import { chamberNextMeeting, floorSessionSource, floorSignalsCheckedAt } from '@/lib/docket';
import type { Chamber } from '@/lib/journey';

/*
 * WHAT STANDS WHERE THE GREEN BAND WOULD HAVE (owner rulings D1+D2,
 * 2026-08-15) — the bill page's answer when the record's floor fact is true
 * and the chamber is not meeting.
 *
 * THE PROBLEM IT ANSWERS. `billFloorBand` still reads the fact (a placement, a
 * pending motion) and the page still prints the stronger status label off it —
 * the record has not changed and neither has what it says. What HAS changed is
 * the tense the full-bleed green band speaks in: "a vote of the full Senate is
 * still ahead of this bill" is a claim about right now, and through a period
 * when the chamber gavels in and straight back out nothing is ahead of
 * anything. So the loud band stands down and this takes its slot.
 *
 * RULED PAPER, NOT A SECOND GROUND (owner ruling D2, in his words: the note is
 * "ruled paper, never a new full-bleed ground"). One full-width block bounded
 * by hairline rules on the page's own paper, in ink. No amber — amber is spent
 * on ONE dated floor fact and this is the absence of one. No green either: the
 * green ground is the product's single data-gated loudness and a second
 * full-bleed ground on the same page would take meaning away from it, which is
 * exactly the trade FloorVotePanel's header forbids. A quieter thing in the
 * loud thing's place is the whole design.
 *
 * WHAT IT MAY SAY, AND THE THREE HARD COPY RULES IT SHIPS UNDER:
 *   · the NEXT MEETING is printed as the Daily Digest's OWN label ("1:30 p.m.,
 *     Monday, August 17"), verbatim and `lang="en"` in both locales — ruling
 *     V4, the same treatment `coversDisplay` gets in components/FloorEvidence
 *     .tsx. Our derived ISO date is the fallback, formatted in the reader's
 *     locale, and only when the document printed no label of its own.
 *   · never the word "recess", in either language. The file does not carry
 *     that fact: `_meta.in_session` says a chamber's program is pro forma, and
 *     "recess" is a different, longer claim about the calendar.
 *   · never a duration — no "for N days", no month a chamber returns in. The
 *     digest names ONE next meeting and this prints that and stops.
 *
 * WHY "PRO FORMA" IS THE HONEST WORD, and why the two claims cannot drift:
 * both come out of ONE block of ONE document. scripts/floor-signals-parse.mjs
 * reads the digest's "Next Meeting of the SENATE" heading for the label and
 * the "Program for {Weekday}:" sentences under it for the verdict, and calls a
 * chamber out of session only when EVERY sentence of that block is pro forma
 * (`sessionFromProgram`). So "the next meeting is a pro forma session" is the
 * document's own sentence about the same meeting, not our inference across two.
 *
 * IT RENDERS NOTHING WHEN IT CANNOT SAY THAT HONESTLY. With no label and no
 * derived date — which is the state of the COMMITTED file until the next
 * hourly run rewrites it, and the permanent fail-safe after that — the page
 * shows NO band at all rather than half a claim. The bill's status label is
 * derived from `billFloorBand`, not from this component, so it is untouched by
 * that path: the reader still learns from the page what the record says.
 */
export async function FloorRecessNote({ chamber }: { chamber: Chamber }) {
  const t = await getTranslations();
  const format = await getFormatter();

  const meeting = chamberNextMeeting(chamber);
  const label = meeting?.label ?? null;
  const iso = meeting?.iso ?? null;
  // The honest sentence needs a meeting to name. Without one there is nothing
  // to print but an assertion, so print nothing (see the header).
  if (!label && !iso) return null;

  const source = floorSessionSource();
  const checkedAt = floorSignalsCheckedAt();

  /* UTC, for the reason every bare `YYYY-MM-DD` on this site is formatted in
     UTC: parsed as UTC midnight and rendered in a negative-offset zone it
     prints the day before. The checked-at stamp is a full instant and keeps
     its own zone, printed — same treatment as FloorEvidence. */
  const day = (value: string) =>
    format.dateTime(new Date(value), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  const instant = (value: string) =>
    format.dateTime(new Date(value), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });

  return (
    /* Full-width, so it is a direct child of the full-width main and takes the
       slot the full-bleed band would have — with its own inner max-width
       wrapper, the same parent contract FloorVotePanel states. The rules are
       hairlines (1.5px), not the band's 3px: this is the page's quietest
       structural mark, not its loudest. */
    <div className="border-y-[1.5px] border-line-strong bg-paper py-6 md:py-8">
      <div className="mx-auto max-w-5xl px-4">
        <p className="max-w-read text-md text-ink">
          {t.rich(chamber === 'senate' ? 'bill.floor.recessSenate' : 'bill.floor.recessHouse', {
            /* The VALUE is a string and the SPAN is a tag, because next-intl's
               ICU arguments take strings, numbers and dates only — a React
               element may reach a message solely as a tag handler. Which of
               the two the sentence is carrying is decided here, once: the
               document's own printed line, English and unformatted (ruling
               V4), or our ISO derivation as the fallback, formatted in the
               reader's locale and never marked English. */
            meeting: label ?? day(iso!),
            when: label
              ? function VerbatimMeeting(chunks) {
                  return <span lang="en">{chunks}</span>;
                }
              : function DerivedMeeting(chunks) {
                  return <span className="tabular-nums">{chunks}</span>;
                },
            term: glossaryTag('pro-forma-session'),
          })}
        </p>

        {/* THE ATTRIBUTION, in the same order and from the same fields as the
            announced band's: the document, its own publication date, a link
            out to it, and the hour we last re-read it. Every piece is
            conditional — a claim we can make without them is still a claim we
            can make, and none of them is the sentence itself. */}
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
          <span>
            {t('home.evidenceSourceDigest')}
            {source?.published ? ' · ' : ''}
            {source?.published && <span className="tabular-nums">{day(source.published)}</span>}
          </span>
          {source?.url && (
            /* External, same convention as every other link out to the
               official record on this site: new tab, noopener. */
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline underline-offset-4 visited:text-go-deep hover:text-go-deep"
            >
              {t('home.evidenceLink')}
              <ExternalLink className="h-4 w-4 flex-none" aria-hidden />
            </a>
          )}
          {checkedAt && (
            <span className="tabular-nums">
              {t('home.floorCheckedAt', { date: instant(checkedAt) })}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

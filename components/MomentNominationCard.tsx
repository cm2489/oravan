import type { ReactNode } from 'react';
import { PhoneCall } from 'lucide-react';
import { useTranslations, useFormatter } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Chip } from '@/components/system';
import type { NominationStatus } from '@/lib/core/nominations';
import { isSignalFresh } from '@/lib/signal-window';

/**
 * A Moment's SENATE NOMINATION vehicle card — MomentVehicleCard's sibling, and
 * deliberately not its generalization.
 *
 * WHY THIS IS A SECOND COMPONENT. The two prop sets barely overlap: a
 * nomination has no issue tags, no news coverage count, no bill status, no
 * AI-decoded headline, and its CTA does not land on /bills/[slug]. Every one
 * of those would have become an optional prop, and MomentVehicleCard's own
 * header argues its amber mark from a premise — "whether a BILL is standing on
 * the floor calendar" — that is not a fact about this record at all. A union
 * prop type on one component would have been two components wearing one name,
 * with a header true of only half its renders.
 *
 * ── WHAT IT SHOWS, AND WHY EACH THING IS ALLOWED ──────────────────────────
 *
 * THE HEADLINE IS THE GOVERNMENT'S OWN SENTENCE, verbatim. Congress.gov's
 * `description` already names the person, the post, and whom they would
 * replace, in one plain English sentence — so unlike a bill, there is nothing
 * here for a decode to make readable, and Oravan does not write one (see
 * lib/nomination-script.ts's header for the full reasoning). `noDecodeNote`
 * says that out loud on the card, because every other card on these surfaces
 * carries a decode and an unexplained absence reads as a gap in our pipeline
 * rather than as a choice.
 *
 * That sentence also stays ENGLISH on /es, like the article titles in
 * data/coverage.json and for the same reason (README, "Known v1 caveats"): it
 * is a government-sourced value, and translating it would put Oravan's words
 * inside quotation marks that belong to the Senate. `noDecodeNote` is what
 * makes that legible to a Spanish reader instead of broken.
 *
 * ── THE AMBER LAW, TRANSLATED TO THIS RECORD ──────────────────────────────
 *
 * MomentVehicleCard spends amber on exactly one fact: a bill standing on the
 * floor calendar, with the date it got there printed. The nomination analogue
 * is the Senate EXECUTIVE Calendar — and the analogy holds only when the
 * record prints a calendar NUMBER.
 *
 * So the chip fires on `execCalendarNumber !== null` AND a fresh signal date,
 * never on `status === 'exec_calendar'` alone. The Senate writes "Calendar No.
 * DESK" for a placement it has not numbered yet, and it writes a
 * Privileged-Nomination placement with no number at all; lib/nomination-status.mjs
 * returns null for both. Printing "Calendar No. DESK" beside a real Senate
 * claim is nonsense, and printing an unqualified "On the Executive Calendar"
 * over an unnumbered placement over-claims. Both fail the same law the bill
 * card states as "no date, no amber" (lib/journey.ts:21-47).
 *
 * The chip REPLACES the status label for that card, exactly as it does on the
 * bill card: one fact, one mark.
 *
 * GREEN is spent on the action. The CTA is the same filled `go` button the
 * bill card carries, at the same weight, so a mixed grid never reads as
 * recommending one vehicle over another.
 */
export function MomentNominationCard({
  slug,
  citation,
  description,
  organization,
  status,
  lastActionDate,
  receivedDate,
  execCalendarNumber,
  role,
  ctaLabel,
  noDecodeNote,
}: {
  /** The `pn-…` corpus slug (lib/core/nominations.ts nominationSlug). */
  slug: string;
  /** Congress.gov's own citation, e.g. "PN852-1". */
  citation: string;
  /** Congress.gov's description sentence, VERBATIM and English in both
   *  locales. Null for the 14 civilian records that carry none — the card
   *  falls back to the citation and the receiving body, which is all the
   *  record gives, rather than inventing a headline. */
  description: string | null;
  organization: string | null;
  /** The derived status (lib/nomination-status.mjs). `unclassified` has its
   *  own neutral, chamber-free label — the honest verdict when no rule
   *  matched the Senate's sentence, never a fallthrough to a raw slug. */
  status: NominationStatus;
  lastActionDate: string | null;
  receivedDate: string | null;
  /** The Executive Calendar number, when the record prints one. NULL is the
   *  amber gate — see the header. */
  execCalendarNumber: number | null;
  /** The both-directions confirm/don't-confirm framing, already localized. */
  role: string;
  ctaLabel: string;
  /** "Oravan does not rewrite nominations…" — already localized. */
  noDecodeNote: string;
}) {
  const t = useTranslations();
  const format = useFormatter();

  // date-only strings => UTC, or a certifying date prints a day early for
  // every US viewer — and a printed date is the whole reason amber is allowed.
  const fmt = (d: string) =>
    format.dateTime(new Date(d), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });

  // The gate: the NUMBER earns the mark, the printed date earns the amber, and
  // the date has to still be inside the 14-day window this page publishes to
  // the reader a few hundred pixels below ("Why this Moment exists").
  const onExecCalendar = execCalendarNumber !== null && isSignalFresh(lastActionDate);

  // Separators ride at the END of the preceding chunk, so a wrapped line can
  // never start with a floating "·" (the /es long-status failure shape).
  const meta: { key: string; node: ReactNode }[] = [
    { key: 'cite', node: <span className="tabular-nums normal-case">{citation}</span> },
  ];
  if (!onExecCalendar) meta.push({ key: 'status', node: t(`nominations.status.${status}`) });
  if (organization) meta.push({ key: 'org', node: organization });

  return (
    <article className="flex flex-col rounded-control border border-line-strong bg-paper p-5">
      {onExecCalendar && (
        <p className="mb-3">
          <Chip tone="urgent" dateLabel={fmt(lastActionDate!)}>
            {t('nominations.onExecCalendar', { number: execCalendarNumber })}
          </Chip>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-tight font-bold tracking-[0.06em] text-ink-2 uppercase">
        {meta.map((part, i) => (
          <span key={part.key} className="whitespace-nowrap">
            {part.node}
            {i < meta.length - 1 && <span aria-hidden> ·</span>}
          </span>
        ))}
      </div>
      <h3 className="mt-2 text-lg leading-tight font-bold text-ink">
        <Link
          href={`/nominations/${slug}`}
          className="hover:underline hover:decoration-go hover:decoration-[3px]"
        >
          {description ?? t('nominations.untitled', { citation })}
        </Link>
      </h3>
      {/* The absence of a decode, stated where the decode would have been. */}
      <p className="mt-2 max-w-read text-xs text-ink-2">{noDecodeNote}</p>
      <p className="mt-3 max-w-read border-t border-line pt-3 text-sm text-ink-2">{role}</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-ink-2">
        {receivedDate && (
          <span>
            {t('nominations.sentToSenate', { date: fmt(receivedDate) })}
            {!onExecCalendar && lastActionDate && <span aria-hidden> ·</span>}
          </span>
        )}
        {!onExecCalendar && lastActionDate && (
          // Year included — see components/BillCard.tsx: a bare month/day on a
          // corpus that reaches back to January reads as an upcoming date.
          <span>{t('bills.updated', { date: fmt(lastActionDate) })}</span>
        )}
      </div>
      <p className="mt-auto pt-5">
        <Link
          href={`/nominations/${slug}`}
          className="ring-gap inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-go bg-go px-5 font-bold text-paper transition-colors hover:border-go-deep hover:bg-go-deep"
        >
          <PhoneCall className="h-4 w-4" aria-hidden />
          {ctaLabel}
        </Link>
      </p>
    </article>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import {
  answerFor,
  positionOf,
  seatCode,
  type FallbackReason,
  type FinderAnswer,
  type FinderMember,
  type HouseSeat,
} from '@/lib/house-finder';
import type { District, VotePosition } from '@/lib/types';
import { AddressForm } from './AddressForm';
import { VacantSeatCard } from './VacantSeatCard';

/*
 * FIND YOUR HOUSE MEMBER'S VOTE — VERSION B, the street-address finder.
 *
 * The owner, 2026-09-29, reviewing the settled box on /bills/hconres-89-119
 * with a ZIP that spans more than one House district: "Great edge case on the
 * house district/zip situation here. This would be a use of a subtle yellow
 * button (I know color comes later) but there should be a way for them to find
 * those votes in this box here. Can you build that for me? Mock up two
 * versions of how this could look." This is one of the two versions; the
 * other lists every candidate district's member at once.
 *
 * WHAT THE READER SEES, in the House vote's group of the settled panel:
 *   1. One line (the ZIP spans N House districts, so the street address
 *      decides) and a subtle amber button, "Find your House member's vote".
 *   2. Pressed: the /reps street-address field opens right here
 *      (components/AddressForm.tsx in its panel mode), focused, with its own
 *      privacy line, a Cancel and a "show every member instead" escape.
 *   3. Matched: exactly one member, beside the position data/votes.json
 *      records for them on this House roll call ("No recorded vote" when the
 *      roll call lists them nowhere), and "Change address".
 *   4. Not answered (the geocoder is down, or the district route's rate limit
 *      tripped): every seat the ZIP spans, each member beside their own
 *      recorded position, with one line saying why, and "Try the address
 *      again".
 *
 * PRIVACY (page 1, rule 1: "A street address travels only in a POST body and
 * is never stored or logged."). The address goes once, in the body of
 * POST /api/district, exactly as on /reps, and lives only in the form's own
 * state while the form is open. The DERIVED district is kept in this
 * component's memory and nowhere else — not localStorage, not the URL — so a
 * reload forgets it. That is narrower than /reps, which puts the derived
 * district in its own URL (?district=TX-10); the one place this finder does
 * the same is the link it offers when the address lands outside the ZIP's
 * districts, and that link is /reps's own refined view, opened by a click.
 *
 * AMBER, AND THE LAW IT BENDS. app/globals.css's COLOR LAW spends `urgent` on
 * exactly one fact, a bill standing on the floor calendar. The owner asked for
 * this button in yellow in his own words (above), and page 2
 * (docs/current-direction.md, 2026-09-26: "yellow … marks only what you can
 * act on") already points that way; the tokens are rebuilt later ("I know
 * color comes later"). So the amber here is a light fill on a control that
 * still carries its own line-strong edge (3.24:1 on paper) and ink text: it is
 * found by its edge and its words, never by being yellow, and it prints no
 * floor claim. No test enforces the one-fact law on bill pages (searched
 * 2026-09-29: only the embed specs check for this colour, and no embed renders
 * this panel).
 */

/** The subtle amber control: a light `urgent` fill, a line-strong edge, ink
 *  text, the 8px control radius, 44px tall, and the global two-tone focus
 *  ring (app/globals.css :focus-visible). Deeper amber and an ink edge on
 *  hover — "half-lamp on hover" (docs/current-direction.md, 2026-09-27). */
const AMBER =
  'inline-flex min-h-11 items-center gap-2 rounded-control border-[1.5px] border-line-strong bg-urgent/30 px-4 py-2 text-left text-sm font-bold text-ink hover:border-ink hover:bg-urgent/60';

/** The panel's quiet control (components/SettledPanel.tsx GHOST). */
const GHOST =
  'inline-flex min-h-11 items-center gap-1.5 rounded-control border-[1.5px] border-line-strong px-3 py-2 text-sm font-semibold text-ink hover:border-ink';

type View =
  | { step: 'closed' }
  | { step: 'asking' }
  | { step: 'answered'; answer: FinderAnswer }
  | { step: 'fallback'; reason: FallbackReason };

export function SettledHouseFinder({
  zip,
  seats,
  positions,
}: {
  /** The saved ZIP the reps lookup answered for. */
  zip: string;
  /** lib/house-finder.ts `houseSeats`: one per district the ZIP spans. */
  seats: HouseSeat[];
  /** The House roll call's positions, bioguide → position (data/votes.json). */
  positions: Record<string, VotePosition> | null;
}) {
  const t = useTranslations('bill.houseFinder');
  const [view, setView] = useState<View>({ step: 'closed' });
  const openRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  // Where focus goes once the next view has rendered: back to the amber
  // button after Cancel, onto the answer after a lookup. Never on page load.
  const focusNext = useRef<'open' | 'result' | null>(null);

  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === 'open') openRef.current?.focus();
    if (target === 'result') resultRef.current?.focus();
  }, [view]);

  const go = (next: View, focus: 'open' | 'result' | null) => {
    focusNext.current = focus;
    setView(next);
  };

  const onFound = (d: District) => go({ step: 'answered', answer: answerFor(seats, d) }, 'result');
  const onUnavailable = (reason: 'unavailable' | 'rateLimited') => go({ step: 'fallback', reason }, 'result');

  const split = <p className="mt-1 max-w-note text-sm text-ink-2">{t('split', { count: seats.length })}</p>;

  return (
    <div data-house-finder={view.step}>
      {view.step === 'closed' && (
        <>
          {split}
          <button
            ref={openRef}
            type="button"
            onClick={() => go({ step: 'asking' }, null)}
            className={`mt-3 ${AMBER}`}
            data-house-finder-open=""
          >
            <MapPin className="h-4 w-4 flex-none" aria-hidden />
            {t('open')}
          </button>
        </>
      )}

      {view.step === 'asking' && (
        <>
          {split}
          <div className="mt-3">
            <AddressForm
              zip={zip}
              panel={{
                onFound,
                onUnavailable,
                notFoundText: t('notFound'),
                children: (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" className={GHOST} onClick={() => go({ step: 'closed' }, 'open')}>
                      {t('cancel')}
                    </button>
                    <button
                      type="button"
                      className={GHOST}
                      onClick={() => go({ step: 'fallback', reason: 'chosen' }, 'result')}
                      data-house-finder-show-all=""
                    >
                      {t('showAll')}
                    </button>
                  </div>
                ),
              }}
            />
          </div>
        </>
      )}

      {view.step === 'answered' && (
        <div ref={resultRef} tabIndex={-1} className="outline-none" data-house-finder-answer={view.answer.kind}>
          <Answer answer={view.answer} zip={zip} positions={positions} />
          <button type="button" className={`mt-2 ${GHOST}`} onClick={() => go({ step: 'asking' }, null)}>
            {t('change')}
          </button>
        </div>
      )}

      {view.step === 'fallback' && (
        <div ref={resultRef} tabIndex={-1} className="outline-none" data-house-finder-fallback={view.reason}>
          <p className="mt-1 max-w-note text-sm text-ink-2">
            {t('fallback', { reason: view.reason, count: seats.length, zip })}
          </p>
          <ul className="mt-1 divide-y divide-line">
            {seats.map((seat) =>
              seat.member ? (
                <MemberRow
                  key={seatCode(seat)}
                  member={seat.member}
                  code={seatCode(seat)}
                  position={positionOf(positions, seat.member.bioguide)}
                />
              ) : (
                <VacantRow key={seatCode(seat)} code={seatCode(seat)} />
              )
            )}
          </ul>
          <button type="button" className={`mt-2 ${GHOST}`} onClick={() => go({ step: 'asking' }, null)}>
            {t('tryAgain')}
          </button>
        </div>
      )}
    </div>
  );
}

function Answer({
  answer,
  zip,
  positions,
}: {
  answer: FinderAnswer;
  zip: string;
  positions: Record<string, VotePosition> | null;
}) {
  const t = useTranslations('bill.houseFinder');
  if (answer.kind === 'outside') {
    const code = seatCode(answer.district);
    return (
      <>
        <p className="mt-1 max-w-note text-sm text-ink-2">{t('outside', { district: code, zip })}</p>
        {/* /reps's own refined view trusts the geocoder over the ZIP map and
            says so (reps.refinedOutsideZip); the district rides in that URL
            exactly as AddressForm puts it there on /reps. */}
        <Link
          href={`/reps?zip=${zip}&district=${answer.district.state}-${answer.district.district}`}
          className="inline-flex min-h-11 items-center text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
        >
          {t('outsideLink', { district: code })}
        </Link>
      </>
    );
  }
  const { seat } = answer;
  const code = seatCode(seat);
  return (
    <>
      <p className="mt-1 max-w-note text-sm text-ink-2">{t('found', { district: code })}</p>
      {seat.member ? (
        <ul className="mt-1">
          <MemberRow member={seat.member} code={code} position={positionOf(positions, seat.member.bioguide)} />
        </ul>
      ) : (
        // A vacant seat: the same card the call panel and /reps show.
        <div className="mt-2">
          <VacantSeatCard />
        </div>
      )}
    </>
  );
}

/** One member beside their recorded position — the settled panel's own row. */
function MemberRow({ member, code, position }: { member: FinderMember; code: string; position: VotePosition | null }) {
  const t = useTranslations('bill.settled');
  const tVotes = useTranslations('votes');
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-x-4 py-1"
      data-vote-delegate={member.bioguide}
      data-house-seat={code}
    >
      <Link
        href={`/reps/${member.bioguide}`}
        className="inline-flex min-h-11 items-center text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
      >
        {member.name} ({code})
      </Link>
      <span className="text-sm text-ink-2" data-settled-position={position ?? 'none'}>
        {position ? <b className="font-extrabold text-ink">{tVotes(`position.${position}`)}</b> : t('noRecordedVote')}
      </span>
    </li>
  );
}

/** A vacant seat in the every-seat list: its code and /reps's own words. */
function VacantRow({ code }: { code: string }) {
  const tReps = useTranslations('reps');
  return (
    <li className="flex min-h-11 flex-wrap items-center gap-x-2 py-1 text-sm text-ink-2" data-house-seat={code}>
      <span className="font-semibold text-ink">{code}</span>
      <span>{tReps('vacantSeat')}</span>
    </li>
  );
}

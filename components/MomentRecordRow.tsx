import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import type { StatusWord } from '@/lib/status-word';

/*
 * A SETTLED VEHICLE ON A BIG QUESTION: THE RECORD, AND A WAY TO READ IT
 * (wireframes v2, 2026-09-29, question-multi.html, "Settled · kept as the
 * record"; page 1, rule 6: a settled decision shows no call apparatus).
 *
 * One row per measure the record has settled: its citation, one status word
 * from the closed set (lib/status-word.ts), the record's outcome sentence,
 * and "Read the bill". No headline, no yes-or-no line and no call button:
 * those belong to a decision still open, and a row that offered them would
 * promise a call the bill page no longer makes (its record-only panel,
 * owner, 2026-09-28, Q9 "a").
 *
 * Nothing here is AI-written — the citation, the word and the sentence are
 * the record's, mapped to fixed copy — so the row carries no AI label.
 * The word is text in small ink capitals, never a colour (rule 3).
 */

/* The question page's content link: green means go, and a link goes
   somewhere. 44px tall on its own line (rule 7). */
const READ_LINK =
  'inline-flex min-h-11 items-center gap-2 text-sm font-bold text-ink underline transition-colors hover:decoration-[3px]';

export function MomentRecordRow({
  slug,
  identifier,
  word,
  wordLabel,
  outcome,
  explainer,
  readLabel,
}: {
  slug: string;
  identifier: string;
  /** Which of the five words (a data hook for tests; the label is `wordLabel`). */
  word: StatusWord;
  /** The word, already localized (`bills.statusWord.*`). */
  wordLabel: string;
  /** The record's outcome: the settled box's sentence, or, where the record
   *  settles nothing the bill page reads (a settled question's still-open
   *  vehicle), the vehicle's own status line. */
  outcome: ReactNode;
  /** What an adopted concurrent resolution can and cannot do
   *  (components/ConcurrentExplainer.tsx), under the outcome. */
  explainer?: ReactNode;
  /** "Read the bill", already localized. */
  readLabel: string;
}) {
  return (
    <li data-record-row={slug} className="border-t border-line py-4">
      <p className="flex flex-wrap items-center gap-x-2 text-xs leading-tight font-bold tracking-[0.06em] text-ink-2 uppercase">
        <span className="tabular-nums normal-case">
          {identifier}
          <span aria-hidden> ·</span>
        </span>
        <span data-status-word={word} className="text-ink">
          {wordLabel}
        </span>
      </p>
      <div className="mt-2 max-w-read text-sm text-ink">{outcome}</div>
      {explainer && <div className="mt-2">{explainer}</div>}
      <p className="mt-1">
        <Link href={`/bills/${slug}`} className={READ_LINK}>
          {readLabel}
          <span className="sr-only"> {identifier}</span>
        </Link>
      </p>
    </li>
  );
}

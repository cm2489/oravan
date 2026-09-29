import { getBill, localizeBill } from './core';
import { chamberSession, rungFor } from './docket';
import { formatCitation } from './format';
import { lastFailedVote, liveCallTarget, settledDecision, type LiveCallTarget } from './journey';
import { settledDecisionDate } from './settled-votes';

/*
 * THE BILL PAGE'S CALL PANEL, AS PROPS (wireframes v2, 2026-09-29,
 * question-single.html; UX question Q6 answered "b").
 *
 * A Big Question that runs through exactly one bill still open to a decision
 * carries that bill's call panel on the question page itself, "the same
 * component as the bill page" (Q5 a, one call route, inline). Same component
 * is not enough on its own: the panel's routing line ("This bill is in the
 * Senate's hands right now…"), its member order and its "The last attempt
 * failed…" line all come from props the bill page computes from the record.
 * This is that computation, in one place, so the question page hands
 * ActionPanel exactly what /bills/[id] hands it:
 *
 *   identifier    the citation (lib/format.ts formatCitation);
 *   title         the decoded headline, else the short title, else the
 *                 official title, in the page's locale;
 *   recordLabels  both locales' call-log labels, built by the bill page's
 *                 rule (the headline, prefixed with the citation unless the
 *                 headline already names it, joined by a middot);
 *   liveTarget    lib/journey.ts liveCallTarget over the record and the
 *                 chamber's own announcement (lib/docket.ts rungFor, T0 only),
 *                 with the announcing chamber's session (chamberSession);
 *   lastAttempt   the owner's pick (a), 2026-09-29: a failed procedural vote
 *                 keeps the call, with one sentence naming the chamber, the
 *                 record's tally and the record's date (lastFailedVote,
 *                 settledDecisionDate, `bill.lastAttempt`).
 *
 * THE BILL PAGE IS NOT CHANGED BY THIS FILE. app/[locale]/bills/[id]/page.tsx
 * still computes the same values inline (its comments above `liveTarget` and
 * `lastAttempt` carry the reasoning), because other work was restructuring
 * that page on 2026-09-29. The two are held together by
 * tests/question-pages.spec.ts, which renders both pages and compares the
 * panels' text, and by tests/bill-call-panel.unit.spec.ts. Moving the bill
 * page onto this helper is a follow-up, stated in the PR.
 *
 * NULL WHEN THERE IS NO PANEL TO DRAW: an unknown slug, or a decision the
 * record already settled (lib/journey.ts settledDecision: a law, a rejected
 * passage vote, an adopted concurrent resolution). A settled decision shows
 * no call apparatus (page 1, rule 6), so the caller never mounts the panel.
 */

export interface BillCallPanelProps {
  slug: string;
  identifier: string;
  title: string;
  recordLabels: { en: string; es: string };
  liveTarget: LiveCallTarget | null;
  lastAttempt: string | null;
}

/** The two things the page supplies: its translator (for `bill.lastAttempt`)
 *  and its long-date formatter (the bill page's `fmtDate`: year, long month,
 *  day, in UTC because the record's dates are calendar days). */
export interface BillCallPanelDeps {
  t: (key: string, values?: Record<string, string | number>) => string;
  fmtDate: (isoDay: string) => string;
}

// Headlines often already name the bill; don't repeat the citation (the same
// rule ActionPanel's call-log labels and the bill page's share text use).
const norm = (x: string) => x.toLowerCase().replace(/[.\s]/g, '');

export function billCallPanelProps(
  slug: string,
  locale: string,
  { t, fmtDate }: BillCallPanelDeps,
  now: number = Date.now()
): BillCallPanelProps | null {
  const raw = getBill(slug);
  if (!raw) return null;
  const bill = localizeBill(raw, locale);
  const settled = settledDecision(bill);
  if (settled) return null;

  const citation = formatCitation(bill.bill_type, bill.bill_number);
  const recordLabelFor = (l: string) => {
    const b = localizeBill(raw, l);
    const dt = b.ai_headline ?? b.short_title ?? b.title;
    return norm(dt).includes(norm(citation)) ? dt : `${citation} · ${dt}`;
  };

  const rung = rungFor(bill, slug, now);
  const announcement = rung.tier === 't0' ? rung.announced : null;
  const liveTarget = liveCallTarget(
    bill,
    announcement
      ? {
          chamber: announcement.chamber,
          published: announcement.published,
          session: chamberSession(announcement.chamber, now),
        }
      : null
  );

  const settledDate = settledDecisionDate(bill);
  const failedVote = lastFailedVote(bill);
  const lastAttempt = failedVote
    ? t('bill.lastAttempt', {
        procedure: failedVote.procedure,
        chamber: failedVote.chamber === 'house' ? 'House' : 'Senate',
        tally: failedVote.tally ? 'yes' : 'none',
        yeas: failedVote.tally?.yeas ?? 0,
        nays: failedVote.tally?.nays ?? 0,
        hasDate: settledDate ? 'yes' : 'none',
        date: settledDate ? fmtDate(settledDate) : '',
      })
    : null;

  return {
    slug,
    identifier: citation,
    title: bill.ai_headline ?? bill.short_title ?? bill.title,
    recordLabels: { en: recordLabelFor('en'), es: recordLabelFor('es') },
    liveTarget,
    lastAttempt,
  };
}

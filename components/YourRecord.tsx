'use client';

import { useState } from 'react';
import { PhoneCall, MessageCircle, Voicemail, Trash2, ArrowRight } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { eraseAll, recordHref, removeCall, removeRead, useCalls, usePrefs, useReads } from '@/lib/local';

/*
 * YOUR RECORD — the reader's own calls, topics and reading, and the way to
 * erase them, all read from this browser and nowhere else.
 *
 * WHERE IT LIVES (owner, UX question Q4 answered "b + c", wireframes v2,
 * reps.html, 2026-09-29): inside the Reps tab, under "Your members" and the
 * bills worth a call — "your record lives here, with Your members, then Your
 * calls, then Erase my data. The call panel's 'See your record' link lands on
 * Your calls." So this is one component with two homes: the Reps tab
 * (app/[locale]/reps/page.tsx), where topics and reading are FOLDED rows
 * between Your calls and Erase, and /record, which still answers every old
 * link and the error boundary's escape hatch (app/[locale]/error.tsx), where
 * the same rows start open because nothing sits above them. One component,
 * so the two can never say different things about the same device.
 *
 * THE ORDER IS THE WIREFRAME'S: Your calls, then What you follow and What
 * you've read (Claude's placement on reps.html, "two folded rows between Your
 * calls and Erase"), then Erase my data. Calls lead because on the Reps tab
 * they are what the call panel's "See your record" link comes to see.
 *
 * `#your-calls` is that link's anchor (components/ActionPanel.tsx). The
 * section is always rendered, empty or not, so the anchor always lands.
 *
 * TAGS ARE INK, NEVER GREEN. The topic chips below navigate; navigating is
 * not an action, and green is spent on the call — the same colour law that
 * governs BillsBrowser's filter rail.
 *
 * EVERY ROW HERE CAME OUT OF localStorage. There is no server that holds any
 * of it, which is why each part says so in its own words instead of leaning
 * on one global promise at the top of the page.
 */

/* The topic chip, as a link: BillsBrowser's own FILTER_OFF idiom (rounded-
   stamp, line-strong edge, ink-2 text) at the 44px touch floor. */
const TOPIC_CHIP =
  'inline-flex min-h-11 shrink-0 items-center rounded-stamp border border-line-strong bg-paper px-4 text-sm font-semibold text-ink-2 no-underline transition-colors hover:border-ink hover:bg-wash hover:text-ink';

/* Read rows and call rows are the same object in two tenses — one row idiom,
   declared once, so they cannot drift apart as either list changes. */
const ROW =
  'flex items-start justify-between gap-3 rounded-control border border-line-strong bg-paper p-4';
/* The row's link is the row's first line, not a word in a sentence, so it
   takes the 44px floor (rule 7): min-h-11 with the text centred in it. */
const ROW_LINK = 'inline-flex min-h-11 items-center font-semibold hover:underline underline-offset-2';
const ROW_DELETE =
  'flex min-h-12 min-w-12 shrink-0 items-center justify-center rounded-control p-2.5 text-ink-2 hover:bg-wash hover:text-ink';

/* A folded row: the site's disclosure idiom (RepCard's "Local offices"),
   with the section's own heading as its label. */
const FOLD_SUMMARY = 'flex min-h-11 cursor-pointer flex-wrap items-baseline gap-x-2 py-2 select-none';

export function YourRecord({ standalone = false }: { standalone?: boolean }) {
  const locale = useLocale();
  const t = useTranslations('impact');
  const tBill = useTranslations('bill');
  const tBills = useTranslations('bills');
  const tCat = useTranslations('categories');
  const format = useFormatter();
  const calls = useCalls();
  const reads = useReads();
  const prefs = usePrefs();
  const [confirming, setConfirming] = useState(false);
  const [erased, setErased] = useState(false);
  const interests = prefs.interests ?? [];
  const hasAnything = calls.length > 0 || reads.length > 0 || !!prefs.zip || interests.length > 0;

  function onErase() {
    eraseAll();
    setConfirming(false);
    setErased(true);
  }

  const contacts = calls.filter((c) => c.outcome === 'contact').length;
  const voicemails = calls.filter((c) => c.outcome === 'voicemail').length;
  const day = (iso: string) =>
    format.dateTime(new Date(iso), { month: 'short', day: 'numeric', year: 'numeric' });
  // The row label in the language the record is being READ in, not the one
  // the interaction happened in (2026-08-04 walkthrough P1: /es/record
  // printed stored English titles verbatim). Rows written before both
  // labels were captured fall back to the interaction-time label.
  const rowLabel = (r: { billLabel: string; labelEn?: string; labelEs?: string }) =>
    (locale === 'es' ? r.labelEs : r.labelEn) ?? r.billLabel;

  return (
    <div data-your-record="">
      {/* 1. YOUR CALLS — what the call panel's "See your record" comes to
             see, so it leads and is always here, empty or not. */}
      <section id="your-calls" aria-labelledby="history" className="scroll-mt-4">
        <h2 id="history" className="text-h2 font-extrabold">
          {t('historyTitle')}
        </h2>
        {calls.length > 0 ? (
          <>
            <dl className="mt-4 grid grid-cols-3 gap-3">
              {[
                { icon: PhoneCall, label: t('calls', { count: calls.length }), value: calls.length },
                { icon: MessageCircle, label: t('contacts', { count: contacts }), value: contacts },
                { icon: Voicemail, label: t('voicemails', { count: voicemails }), value: voicemails },
              ].map(({ icon: Icon, label, value }) => (
                // THE LABEL STAYS INSIDE ITS BOX (rule 7, 320px reflow;
                // found 2026-09-29 verifying #387). Three boxes to a row
                // leave "Conversations" / "Conversaciones" wider than the
                // box at 320 and 360, and "Conversaciones" crossing the
                // border at 390, where the next box painted over its last
                // letters. So the one long word may hyphenate — only at a
                // break with four letters each side, so "Llamadas hechas"
                // and "Mensajes de voz" still wrap at their spaces — and
                // below 360px the box gives up half its side padding.
                // overflow-wrap: anywhere is the last resort for a browser
                // with no hyphenation dictionary for the page's language.
                <div
                  key={label}
                  className="rounded-control border border-line-strong bg-paper px-2 py-4 text-center min-[22.5rem]:px-4"
                  data-record-stat=""
                >
                  <Icon className="mx-auto h-5 w-5 text-ink-2" aria-hidden />
                  <dd className="mt-1 text-h3 font-extrabold tabular-nums">{value}</dd>
                  <dt className="text-xs font-medium text-ink-2 hyphens-auto [-webkit-hyphenate-limit-after:4] [-webkit-hyphenate-limit-before:4] [hyphenate-limit-chars:auto_4_4] [overflow-wrap:anywhere]">
                    {label}
                  </dt>
                </div>
              ))}
            </dl>
            <ul className="mt-4 space-y-3">
              {calls.map((c) => (
                <li key={c.at} className={ROW}>
                  <div>
                    {/* recordHref, never a hardcoded /bills/: a call logged on a
                        nomination page stores that nomination's `pn-…` slug in
                        the same field, and this row linked every one of them to
                        a bill page that does not exist. */}
                    <Link href={recordHref(c.billSlug)} className={ROW_LINK}>
                      {rowLabel(c)}
                    </Link>
                    <p className="mt-1 text-sm text-ink-2">
                      {c.repName} · {tBill(`outcome.${c.outcome}`)} · {day(c.at)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeCall(c.at)}
                    aria-label={t('deleteRecord')}
                    title={t('deleteRecord')}
                    className={ROW_DELETE}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="mt-2 max-w-read" data-record-empty="">
            <p className="font-semibold text-ink">{t('emptyTitle')}</p>
            <p className="mt-1 text-sm text-ink-2">{t('emptyBody')}</p>
            {/* On the Reps tab the bills worth a call sit right above; on the
                standalone page nothing does, so it keeps its way onward. */}
            {standalone && (
              <Link
                href="/bills"
                className="mt-2 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-ink underline underline-offset-4"
              >
                {t('emptyCta')}
                <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
              </Link>
            )}
          </div>
        )}
      </section>

      {/* 2. WHAT YOU FOLLOW — the saved topics, shown as what they are: a
             list this device kept. Each chip goes to /bills, which opens
             already filtered by these same interests (BillsBrowser reads
             them from this very store), so a tap lands on the bills the
             chip names. */}
      {interests.length > 0 && (
        <section className="mt-8 border-t border-line" aria-labelledby="follows" data-record-follows="">
          <details open={standalone}>
            <summary className={FOLD_SUMMARY}>
              <h2 id="follows" className="text-h3 font-extrabold">
                {t('followTitle')}
              </h2>
              <span className="text-sm text-ink-2 tabular-nums">{t('followCount', { count: interests.length })}</span>
            </summary>
            <ul className="mt-2 flex flex-wrap gap-2">
              {interests.map((cat) => (
                <li key={cat}>
                  <Link href="/bills" className={TOPIC_CHIP}>
                    {tCat(cat)}
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-3 max-w-note text-xs text-ink-2">{tBills('interestsNote')}</p>
            <p className="mt-3">
              <Link
                href="/bills"
                className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-go visited:text-go-deep hover:text-go-deep hover:underline"
              >
                {t('followCta')}
                <ArrowRight className="h-4 w-4 flex-none" aria-hidden />
              </Link>
            </p>
          </details>
        </section>
      )}

      {/* 3. WHAT YOU'VE READ — newest first, each row removable on its own.
             The per-item delete is not a convenience: a record you cannot
             edit is a record kept ON you rather than FOR you. */}
      {reads.length > 0 && (
        <section
          className={`border-t border-line ${interests.length > 0 ? '' : 'mt-8'}`}
          aria-labelledby="reads"
          data-record-reads=""
        >
          <details open={standalone}>
            <summary className={FOLD_SUMMARY}>
              <h2 id="reads" className="text-h3 font-extrabold">
                {t('readsTitle')}
              </h2>
              <span className="text-sm text-ink-2 tabular-nums">{t('readsCount', { count: reads.length })}</span>
            </summary>
            <ul className="mt-2 space-y-3">
              {reads.map((r) => (
                <li key={r.billSlug} className={ROW}>
                  <div>
                    {/* Reads are bill-only today — components/ReadReceipt.tsx is
                        mounted on the bill page and nowhere else — so this is
                        the same routing rule applied to a field that cannot
                        currently carry a `pn-` slug. Routed through the shared
                        helper anyway: the two record types share one stored
                        field shape, and the day a nomination page mounts a read
                        receipt this row should not be the thing that 404s. */}
                    <Link href={recordHref(r.billSlug)} className={ROW_LINK}>
                      {rowLabel(r)}
                    </Link>
                    <p className="mt-1 text-sm text-ink-2 tabular-nums">{day(r.at)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeRead(r.billSlug)}
                    aria-label={t('deleteRead')}
                    title={t('deleteRead')}
                    className={ROW_DELETE}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-3 max-w-note text-xs text-ink-2">{t('readsNote')}</p>
          </details>
        </section>
      )}

      {/* 4. ERASE MY DATA. ERASE FLOW FOCUS + ANNOUNCEMENT (Phase-1 P1). Two
          focus drops fixed: opening the confirm unmounted the trigger (focus
          fell to <body>), so the confirm button takes focus on mount;
          confirming unmounted both buttons, so focus moves to the status
          line. The status <p role=status> is ALWAYS mounted and filled on
          erase — a live region that mounts with its text is the classic
          pattern screen readers fail to announce. */}
      {(hasAnything || erased) && (
        <section className="mt-8 rounded-control bg-wash p-6" aria-labelledby="erase" data-record-erase="">
          <h2 id="erase" className="text-h3 font-extrabold">
            {t('eraseTitle')}
          </h2>
          <p className="mt-1 max-w-note text-sm text-ink-2">{t('eraseBody')}</p>
          {!confirming ? (
            !erased && (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="mt-4 inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-ink bg-paper px-4 py-2.5 font-bold text-ink hover:bg-wash"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                {t('erase')}
              </button>
            )
          ) : (
            <div className="mt-4">
              <p className="max-w-note text-sm font-medium">{t('eraseConfirm')}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  ref={(el) => el?.focus()}
                  onClick={onErase}
                  className="ring-gap inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-ink bg-ink-deep px-4 py-2.5 font-bold text-paper"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                  {t('confirmErase')}
                </button>
                {/* Cancel takes bg-paper: its border-line-strong edge sat
                    directly on the wash panel at 2.97:1 — the exact
                    enabled-control case the contrast ledger marks FAIL
                    (line-strong needs paper on at least one side). */}
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="min-h-12 rounded-control border-2 border-line-strong bg-paper px-4 py-2.5 font-bold text-ink hover:border-ink"
                >
                  {t('cancel')}
                </button>
              </div>
            </div>
          )}
          <p
            className="mt-3 text-sm font-medium"
            role="status"
            tabIndex={-1}
            ref={(el) => {
              if (erased && el && document.activeElement === document.body) el.focus();
            }}
          >
            {erased ? t('erased') : ''}
          </p>
        </section>
      )}
    </div>
  );
}

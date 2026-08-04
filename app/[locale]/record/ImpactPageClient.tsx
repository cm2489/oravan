'use client';

import { useState } from 'react';
import { PhoneCall, MessageCircle, Voicemail, Trash2, ArrowRight } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { eraseAll, removeCall, removeRead, useCalls, usePrefs, useReads } from '@/lib/local';

/*
 * THE CIVIC RECORD (repositioning spec §4). Formerly "Your impact", which
 * counted only calls — so a reader who had followed three topics and read a
 * dozen decodes was told they had done nothing. The page now reads in the
 * order the product actually works: what you follow, what you've read, then
 * what you did about it.
 *
 * CALLS STAY THIRD AND STAY WHOLE. Third is not a demotion — the stat trio,
 * the history list and the erase block are the surfaces they already were,
 * in the position the arc puts them: the outcome, after the two sections
 * that lead to it. Demote, never bury.
 *
 * TAGS ARE INK, NEVER GREEN. The topic chips below navigate; navigating is
 * not an action, and green is spent on the call — the same color law that
 * governs BillsBrowser's filter rail.
 *
 * EVERY ROW HERE CAME OUT OF localStorage. There is no server that holds any
 * of it, which is why each section says so in its own words instead of
 * leaning on one global promise at the top of the page.
 */

/* The topic chip, as a link: BillsBrowser's own FILTER_OFF idiom (rounded-
   stamp, line-strong edge, ink-2 text) at the 44px touch floor. */
const TOPIC_CHIP =
  'inline-flex min-h-11 shrink-0 items-center rounded-stamp border border-line-strong bg-paper px-4 text-sm font-semibold text-ink-2 no-underline transition-colors hover:border-ink hover:bg-wash hover:text-ink';

/* Read rows and call rows are the same object in two tenses — one row idiom,
   declared once, so they cannot drift apart as either list changes. */
const ROW =
  'flex items-start justify-between gap-3 rounded-control border border-line-strong bg-paper p-4';
const ROW_LINK = 'font-semibold hover:underline underline-offset-2';
const ROW_DELETE =
  'flex min-h-12 min-w-12 shrink-0 items-center justify-center rounded-control p-2.5 text-ink-2 hover:bg-wash hover:text-ink';

export default function ImpactPageClient() {
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
    // max-w-5xl + text-h1-bill: the sitewide rail and the sitewide title
    // rung — every sibling page (bills, reps, moments, embeds) titles at
    // text-h1-bill; bare text-h1 belongs to the home hero alone. This page
    // ran max-w-3xl + text-h2 from its first commit — the only surface off
    // the grid, flagged P1 in the 2026-08-01 critique. Widening the rail
    // obliges the reading caps below: prose takes max-w-read / max-w-note
    // per DESIGN.md's measure tokens so no line runs the new width; record
    // rows and the stat cards keep the full rail like every listing surface.
    <div className="mx-auto max-w-5xl px-4 py-12">
      <h1 className="text-h1-bill font-extrabold text-ink">{t('title')}</h1>
      <p className="mt-2 max-w-read text-ink-2">{t('sub')}</p>

      {/* 1. WHAT YOU FOLLOW — the saved topics, shown as what they are: a
             list this device kept. Each chip goes to /bills, which opens
             already filtered by these same interests (BillsBrowser reads
             them from this very store), so a tap lands on the bills the
             chip names. */}
      {interests.length > 0 && (
        <section className="mt-10" aria-labelledby="follows">
          <h2 id="follows" className="text-h3 font-extrabold">
            {t('followTitle')}
          </h2>
          <ul className="mt-4 flex flex-wrap gap-2">
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
        </section>
      )}

      {/* 2. WHAT YOU'VE READ — newest first, each row removable on its own.
             The per-item delete is not a convenience: a record you cannot
             edit is a record kept ON you rather than FOR you. */}
      {reads.length > 0 && (
        <section className="mt-10" aria-labelledby="reads">
          <h2 id="reads" className="text-h3 font-extrabold">
            {t('readsTitle')}
          </h2>
          <ul className="mt-4 space-y-3">
            {reads.map((r) => (
              <li key={r.billSlug} className={ROW}>
                <div>
                  <Link href={`/bills/${r.billSlug}`} className={ROW_LINK}>
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
        </section>
      )}

      {/* 3. YOUR CALLS — the celebrated outcome, kept whole, in third place. */}
      {calls.length > 0 && (
        <dl className="mt-10 grid grid-cols-3 gap-3">
          {[
            { icon: PhoneCall, label: t('calls', { count: calls.length }), value: calls.length },
            { icon: MessageCircle, label: t('contacts', { count: contacts }), value: contacts },
            { icon: Voicemail, label: t('voicemails', { count: voicemails }), value: voicemails },
          ].map(({ icon: Icon, label, value }) => (
            <div
              key={label}
              className="rounded-control border border-line-strong bg-paper p-4 text-center"
            >
              <Icon className="mx-auto h-5 w-5 text-ink-2" aria-hidden />
              <dd className="mt-1 text-h3 font-extrabold tabular-nums">{value}</dd>
              <dt className="text-xs font-medium text-ink-2">{label}</dt>
            </div>
          ))}
        </dl>
      )}

      {calls.length === 0 && !erased && (
        <div className="mt-10 rounded-control border border-line-strong bg-paper p-8 text-center">
          <h2 className="text-h3 font-extrabold">{t('emptyTitle')}</h2>
          <p className="mx-auto mt-2 max-w-read text-ink-2">{t('emptyBody')}</p>
          <Link
            href="/bills"
            className="ring-gap mt-5 inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-go bg-go px-5 py-3 font-bold text-paper no-underline hover:border-go-deep hover:bg-go-deep"
          >
            {t('emptyCta')}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      )}

      {calls.length > 0 && (
        <section className="mt-10" aria-labelledby="history">
          <h2 id="history" className="text-h3 font-extrabold">
            {t('historyTitle')}
          </h2>
          <ul className="mt-4 space-y-3">
            {calls.map((c) => (
              <li key={c.at} className={ROW}>
                <div>
                  <Link href={`/bills/${c.billSlug}`} className={ROW_LINK}>
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
        </section>
      )}

      {/* ERASE FLOW FOCUS + ANNOUNCEMENT (Phase-1 P1). Two focus drops
          fixed: opening the confirm unmounted the trigger (focus fell to
          <body>), so the confirm button takes focus on mount; confirming
          unmounted both buttons, so focus moves to the status line. The
          status <p role=status> is now ALWAYS mounted and filled on erase —
          a live region that mounts with its text is the classic pattern
          screen readers fail to announce. */}
      {(hasAnything || erased) && (
        <section className="mt-12 rounded-control bg-wash p-6">
          <h2 className="text-h3 font-extrabold">{t('eraseTitle')}</h2>
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

'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import { MessageSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/navigation';

/*
 * Beta feedback button + dialog (native <dialog>: focus trap, Escape, and
 * focus return come from the platform). The message goes to /api/feedback
 * via POST body - never a query string - and the issue it creates contains
 * only what the visitor typed here.
 *
 * Context by consent: the current page path is prefilled INSIDE the textarea
 * as ordinary deletable text, not attached invisibly. Deleting the line is
 * all it takes to withhold it.
 *
 * Renders nothing until React has mounted, deliberately (same reasoning as
 * AddressForm): the form is useless without JS (fetch-based), and never
 * existing pre-hydration means a native form submit - which would put the
 * message in a GET query string - is impossible.
 *
 * Bot friction, both invisible to humans: a honeypot field ("website") that
 * only bots fill, and a minimum-open-time hold before the request is sent.
 */

const MIN_OPEN_MS = 3000;

const CATEGORIES = ['bug', 'feature', 'other'] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_LABEL: Record<Category, string> = {
  bug: 'categoryBug',
  feature: 'categoryFeature',
  other: 'categoryOther',
};

type Status = 'idle' | 'incomplete' | 'sending' | 'success' | 'rateLimited' | 'error';

/** True only after hydration - the server snapshot is false, the client's true. */
const useHydrated = () =>
  useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

export function FeedbackDialog() {
  const t = useTranslations('feedback');
  const pathname = usePathname();
  const hydrated = useHydrated();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openedAtRef = useRef(0);
  const [category, setCategory] = useState<Category | null>(null);
  const [message, setMessage] = useState('');
  const [website, setWebsite] = useState(''); // honeypot - humans never see it
  const [status, setStatus] = useState<Status>('idle');

  if (!hydrated) return null;

  const prefill = `${t('pagePrefix')}${pathname}\n\n`;

  function open() {
    if (status === 'success') {
      // Last submission went through: start the next one fresh.
      setCategory(null);
      setMessage(prefill);
      setWebsite('');
      setStatus('idle');
    } else if (message === '') {
      setMessage(prefill);
    }
    openedAtRef.current = Date.now();
    dialogRef.current?.showModal();
  }

  function close() {
    dialogRef.current?.close();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (status === 'sending') return;
    const clean = message.trim();
    if (!category || clean.length === 0) {
      setStatus('incomplete');
      return;
    }
    setStatus('sending');
    // Bot friction: a human takes longer than 3 seconds from open to send.
    // Hold the request until the dialog has been open at least that long.
    const remaining = MIN_OPEN_MS - (Date.now() - openedAtRef.current);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, message: clean, website }),
      });
      if (res.ok) {
        setStatus('success');
        return;
      }
      setStatus(res.status === 429 ? 'rateLimited' : 'error');
    } catch {
      setStatus('error');
    }
  }

  const error =
    status === 'incomplete'
      ? t('errorIncomplete')
      : status === 'rateLimited'
        ? t('errorRateLimited')
        : status === 'error'
          ? t('errorGeneric')
          : null;

  return (
    <>
      <button
        type="button"
        onClick={open}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-control border-2 border-ink/15 bg-surface px-4 text-sm font-semibold text-ink hover:border-ink/40"
      >
        <MessageSquare className="h-4 w-4" aria-hidden />
        {t('trigger')}
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby="feedback-title"
        onClose={() => {
          // Closing keeps an unsent draft for a reopen; transient states reset.
          if (status !== 'success') setStatus('idle');
        }}
        className="m-auto w-[min(92vw,32rem)] max-h-[85dvh] overflow-y-auto rounded-card border border-line bg-surface p-6 text-ink shadow-lift backdrop:bg-night/60"
      >
        <h2 id="feedback-title" className="font-display text-2xl font-bold">
          {t('title')}
        </h2>

        {status === 'success' ? (
          <div>
            <p role="status" className="mt-3 rounded-control bg-moss-soft p-4 text-moss">
              {t('success')}
            </p>
            <button
              type="button"
              onClick={close}
              className="mt-4 inline-flex min-h-[44px] items-center rounded-control bg-ink px-5 font-semibold text-paper hover:bg-night active:translate-y-px"
            >
              {t('close')}
            </button>
          </div>
        ) : (
          <form onSubmit={submit} noValidate>
            <p className="mt-1 text-sm text-ink-soft">{t('intro')}</p>

            <fieldset className="mt-4">
              <legend className="text-sm font-semibold">{t('categoryLegend')}</legend>
              <div className="mt-1">
                {CATEGORIES.map((value) => (
                  <label key={value} className="flex min-h-[44px] items-center gap-3">
                    <input
                      type="radio"
                      name="category"
                      value={value}
                      checked={category === value}
                      onChange={() => setCategory(value)}
                      className="h-5 w-5 accent-ink"
                    />
                    {t(CATEGORY_LABEL[value])}
                  </label>
                ))}
              </div>
            </fieldset>

            <label htmlFor="feedback-message" className="mt-4 block text-sm font-semibold">
              {t('messageLabel')}
            </label>
            <textarea
              id="feedback-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={2000}
              rows={5}
              disabled={status === 'sending'}
              aria-describedby={error ? 'feedback-error feedback-notice' : 'feedback-notice'}
              aria-invalid={!!error}
              className="mt-1 w-full rounded-control border-2 border-ink/20 bg-paper p-3 leading-relaxed focus:border-ink"
            />
            <p id="feedback-notice" className="mt-1 text-sm text-ink-faint">
              {t('notice')}
            </p>

            {/* Honeypot: visually removed and out of the a11y tree + tab order.
                Only form-filling bots reach it; hardcoded English is deliberate
                (never user-facing in either language). */}
            <div aria-hidden="true" className="absolute left-[-9999px] h-px w-px overflow-hidden">
              <label>
                Website
                <input
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </label>
            </div>

            {error && (
              <p id="feedback-error" role="alert" className="mt-2 text-sm font-medium text-clay">
                {error}
              </p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={status === 'sending'}
                className="inline-flex min-h-[44px] items-center rounded-control bg-ink px-5 font-semibold text-paper hover:bg-night active:translate-y-px disabled:opacity-60"
              >
                {status === 'sending' ? t('sending') : t('send')}
              </button>
              <button
                type="button"
                onClick={close}
                className="inline-flex min-h-[44px] items-center rounded-control border border-ink/25 px-4 font-semibold hover:border-ink/60"
              >
                {t('cancel')}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}

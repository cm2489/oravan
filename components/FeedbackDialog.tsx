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
 *
 * ---------------------------------------------------------------------------
 * DESIGN NOTES
 *
 * The trigger is drawn in `currentColor` on purpose. It lives inside the site
 * footer, and the footer is the page's back cover - it may be a paper block
 * or an ink enamel ground depending on the shell. Inheriting its ground's own
 * text tone means the button reads at 7.87:1 on paper (ink-2) and 10.82:1 on
 * the ink ground (ink-pale) without this file having to know which it landed
 * on. Focus is retuned by the ground's own `.on-dark`, so the ring follows too.
 *
 * The chosen category takes the `tint` ground, because `tint` means YOURS -
 * what the visitor picked or wrote - and this is the one control on the page
 * where that is literally true. The native radio keeps carrying the state
 * (accent-ink); the tint is a second signal on top of it, never the only one.
 *
 * Neither the failure nor the success block is carried by color. Both are
 * opened by a 3px ink rule on `wash`; the failure adds a bold uppercase label
 * in the alert tone plus aria-invalid and role="alert", the success is
 * role="status". `go` and `alert` are 1.19:1 apart in luminance, so a
 * green-vs-red read would be invisible to a deuteranope - which is exactly
 * why the rule and the label come first and the hue comes third.
 *
 * In-flight controls take a real :disabled state - `wash` ground, line-strong
 * edge (legal here: 1.4.11 exempts inactive components), ink-2 text at 7.23:1
 * - instead of an opacity dim, which would drag every pair below AA at once.
 */

const MIN_OPEN_MS = 3000;

const CATEGORIES = ['bug', 'feature', 'partnership', 'other'] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_LABEL: Record<Category, string> = {
  bug: 'categoryBug',
  feature: 'categoryFeature',
  partnership: 'categoryPartnership',
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

const DISABLED = 'disabled:cursor-not-allowed disabled:border-line-strong disabled:bg-wash disabled:text-ink-2';

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

  const sending = status === 'sending';
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
        className="inline-flex min-h-11 items-center gap-2 rounded-control border-2 border-current px-4 text-sm font-bold underline-offset-4 hover:underline hover:decoration-2"
      >
        <MessageSquare className="h-4 w-4 shrink-0" aria-hidden />
        {t('trigger')}
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby="feedback-title"
        onClose={() => {
          // Closing keeps an unsent draft for a reopen; transient states reset.
          if (status !== 'success') setStatus('idle');
        }}
        /* The dialog carries its OWN focus tones rather than inheriting them.
           Its ground is always paper, but its trigger can sit anywhere — the
           footer's ink ground included — and an `.on-dark` ancestor would
           otherwise hand this paper panel a paper-coloured ring, i.e. an
           invisible one. Self-sufficient here means the component cannot be
           broken by where it is mounted. */
        className="m-auto max-h-[85dvh] w-[min(92vw,32rem)] overflow-y-auto rounded-control border-2 border-ink bg-paper p-6 text-ink backdrop:bg-ink/60 [--focus-gap:var(--color-paper)] [--focus:var(--color-ink)]"
      >
        <h2 id="feedback-title" className="text-h2 font-extrabold">
          {t('title')}
        </h2>

        {status === 'success' ? (
          <div>
            <p
              role="status"
              className="mt-4 max-w-note border-t-[3px] border-ink bg-wash p-4 text-sm font-semibold text-ink"
            >
              {t('success')}
            </p>
            <button
              type="button"
              onClick={close}
              className="ring-gap mt-4 inline-flex min-h-12 items-center rounded-control border-2 border-go bg-go px-6 font-bold text-paper hover:border-go-deep hover:bg-go-deep"
            >
              {t('close')}
            </button>
          </div>
        ) : (
          <form onSubmit={submit} noValidate>
            <p className="mt-2 max-w-note text-sm text-ink-2">{t('intro')}</p>

            <fieldset className="mt-4">
              <legend className="text-sm font-bold">{t('categoryLegend')}</legend>
              <div className="mt-2 grid gap-0.5">
                {CATEGORIES.map((value) => (
                  <label
                    key={value}
                    className="flex min-h-11 cursor-pointer items-center gap-3 rounded-control px-3 text-md has-[:checked]:bg-tint has-[:checked]:font-semibold"
                  >
                    <input
                      type="radio"
                      name="category"
                      value={value}
                      checked={category === value}
                      onChange={() => setCategory(value)}
                      className="h-5 w-5 shrink-0 accent-ink"
                    />
                    {t(CATEGORY_LABEL[value])}
                  </label>
                ))}
              </div>
            </fieldset>

            <label htmlFor="feedback-message" className="mt-4 block text-sm font-bold">
              {t('messageLabel')}
            </label>
            <textarea
              id="feedback-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={2000}
              rows={5}
              disabled={sending}
              aria-describedby={error ? 'feedback-error feedback-notice' : 'feedback-notice'}
              aria-invalid={!!error}
              className={`mt-2 w-full rounded-control p-4 text-md leading-body text-ink ${DISABLED} ${
                error
                  ? 'border-[3px] border-ink bg-wash'
                  : 'border-2 border-ink bg-paper enabled:hover:border-go-deep'
              }`}
            />
            <p id="feedback-notice" className="mt-2 max-w-note text-sm text-ink-2">
              {/* Partnership is a business inquiry, not anonymous citizen
                  feedback: it invites an opt-in contact method (so a reply is
                  possible) instead of the default "don't include personal
                  details / we can't reply." */}
              {category === 'partnership' ? t('noticePartnership') : t('notice')}
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
              <p
                id="feedback-error"
                role="alert"
                className="mt-3 max-w-note border-t-[3px] border-ink bg-wash p-4 text-sm font-semibold text-ink"
              >
                <b className="mb-0.5 block text-2xs font-extrabold tracking-[0.1em] text-alert uppercase">
                  {t('errorLabel')}
                </b>
                {error}
              </p>
            )}

            <div className="mt-6 flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={sending}
                className={`ring-gap inline-flex min-h-12 items-center rounded-control border-2 border-go bg-go px-6 font-bold text-paper enabled:hover:border-go-deep enabled:hover:bg-go-deep ${DISABLED}`}
              >
                {sending ? t('sending') : t('send')}
              </button>
              <button
                type="button"
                onClick={close}
                className="inline-flex min-h-12 items-center rounded-control border-2 border-ink px-5 font-bold text-ink hover:bg-ink hover:text-paper"
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

'use client';

import { useState, useSyncExternalStore } from 'react';
import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';

/*
 * Optional split-ZIP refinement: a street address, sent once via POST to
 * /api/district, narrows a multi-district ZIP to the visitor's single House
 * district. Progressive enhancement only - the all-candidates view is the
 * default and every failure falls back to it.
 *
 * Renders nothing until React has mounted, deliberately: the form is useless
 * without JS (fetch-based), and never existing pre-hydration means a native
 * form submit - which would put the address in a GET query string - is
 * impossible. The address lives in component state only; it is never written
 * to localStorage, a URL, or anywhere else. Only the derived district
 * ("NY-12") goes into the query string for the refined view.
 *
 * IN-FLIGHT IS A REAL DISABLED STATE, not a dimmed one: opacity would drag
 * every pair below AA at once. A checking control takes the `wash` ground and
 * a `line-strong` edge - the one place that pairing is legal, because 1.4.11
 * exempts inactive components - plus `ink-2` text at 7.23:1 and
 * cursor-not-allowed. The status line beside it is `role="status"`, so the
 * wait is announced rather than only drawn.
 *
 * FAILURE IS NEVER CARRIED BY COLOR (go and alert are 1.19:1 apart): a 3px
 * ink rule, a bold uppercase label, aria-invalid and role="alert" all fire
 * before the alert tone does.
 */

type Status = 'idle' | 'checking' | 'invalid' | 'notFound' | 'unavailable' | 'rateLimited';

const ERROR_KEY = {
  invalid: 'addressInvalid',
  notFound: 'addressNotFound',
  unavailable: 'refineUnavailable',
  rateLimited: 'refineRateLimited',
} as const;

/** True only after hydration - the server snapshot is false, the client's true. */
const useHydrated = () =>
  useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

const FIELD_BASE =
  'min-h-12 w-full min-w-0 rounded-control px-4 py-3 text-md text-ink placeholder:text-ink-2 disabled:cursor-not-allowed disabled:border-line-strong disabled:bg-wash disabled:text-ink-2';

export function AddressForm({ zip }: { zip: string }) {
  const t = useTranslations('reps');
  const router = useRouter();
  const hydrated = useHydrated();
  const [address, setAddress] = useState('');
  const [status, setStatus] = useState<Status>('idle');

  if (!hydrated) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const clean = address.trim();
    if (clean.length < 3) {
      setStatus('invalid');
      return;
    }
    setStatus('checking');
    try {
      const res = await fetch('/api/district', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: clean, zip }),
      });
      if (res.ok) {
        const { state, district } = (await res.json()) as { state: string; district: number };
        router.push(`/reps?zip=${zip}&district=${state}-${district}`);
        return; // stay in 'checking' until the refined view replaces us
      }
      setStatus(res.status === 404 ? 'notFound' : res.status === 429 ? 'rateLimited' : 'unavailable');
    } catch {
      setStatus('unavailable');
    }
  }

  const error = status === 'idle' || status === 'checking' ? null : t(ERROR_KEY[status]);
  const checking = status === 'checking';

  return (
    <section
      aria-labelledby="refine-title"
      className="mt-6 max-w-xl rounded-control border-[1.5px] border-line-strong bg-paper p-5"
    >
      <h2 id="refine-title" className="text-lg font-extrabold">
        {t('refineTitle')}
      </h2>
      <form onSubmit={submit} className="@container mt-4" noValidate>
        <label htmlFor="street-address" className="block text-sm font-bold">
          {t('addressLabel')}
        </label>
        <div className="mt-2 grid gap-2 @min-[30rem]:grid-cols-[minmax(0,1fr)_auto]">
          <input
            id="street-address"
            name="street-address"
            type="text"
            autoComplete="street-address"
            placeholder={t('addressPlaceholder')}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            disabled={checking}
            aria-invalid={!!error}
            aria-describedby={error ? 'address-error' : 'address-help'}
            className={
              error
                ? `${FIELD_BASE} border-[3px] border-ink bg-wash`
                : `${FIELD_BASE} border-2 border-ink bg-paper enabled:hover:border-go-deep`
            }
          />
          <button
            type="submit"
            disabled={checking}
            className="ring-gap inline-flex min-h-12 items-center justify-center gap-2 rounded-control border-2 border-go bg-go px-6 py-3 font-bold text-paper enabled:hover:border-go-deep enabled:hover:bg-go-deep disabled:cursor-not-allowed disabled:border-line-strong disabled:bg-wash disabled:text-ink-2"
          >
            {t('refineCta')}
            <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
          </button>
        </div>
        {error ? (
          <p
            id="address-error"
            role="alert"
            className="mt-3 max-w-note border-t-[3px] border-ink bg-wash p-4 text-sm font-semibold text-ink"
          >
            <b className="mb-0.5 block text-2xs font-extrabold tracking-[0.1em] text-alert uppercase">
              {t('errorLabel')}
            </b>
            {error}
          </p>
        ) : (
          <p id="address-help" role="status" className="mt-3 max-w-note text-sm text-ink-2">
            {checking ? t('refineChecking') : t('refinePrivacy')}
          </p>
        )}
      </form>
    </section>
  );
}

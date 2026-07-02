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

  return (
    <div className="mt-4 max-w-xl rounded-card border border-line bg-surface p-5 shadow-lift">
      <p className="font-medium">{t('refineTitle')}</p>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-2" noValidate>
        <label htmlFor="street-address" className="text-sm font-semibold">
          {t('addressLabel')}
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id="street-address"
            name="street-address"
            type="text"
            autoComplete="street-address"
            placeholder={t('addressPlaceholder')}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            disabled={status === 'checking'}
            aria-invalid={!!error}
            aria-describedby={error ? 'address-error' : 'address-help'}
            className="w-full max-w-xs rounded-control border-2 border-ink/20 bg-surface px-4 py-3 focus:border-ink"
          />
          <button
            type="submit"
            disabled={status === 'checking'}
            className="inline-flex items-center gap-2 rounded-control bg-ink px-5 py-3 font-semibold text-paper hover:bg-night active:translate-y-px disabled:opacity-60"
          >
            {t('refineCta')}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {error ? (
          <p id="address-error" role="alert" className="text-sm font-medium text-clay">
            {error}
          </p>
        ) : (
          <p id="address-help" role="status" className="text-sm text-ink-faint">
            {status === 'checking' ? t('refineChecking') : t('refinePrivacy')}
          </p>
        )}
      </form>
    </div>
  );
}

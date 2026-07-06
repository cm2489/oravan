'use client';

import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { setPrefs, usePrefs } from '@/lib/local';

export function ZipForm({ autoFocus = false }: { autoFocus?: boolean }) {
  const t = useTranslations('home');
  const router = useRouter();
  const prefs = usePrefs();
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const zip = typed ?? prefs.zip ?? '';

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Read the field's live DOM value via FormData rather than trusting
    // `zip` (the React state mirror) alone. A fill dispatched right as the
    // page hydrates can land its native `input` event before this form's
    // onChange listener attaches - and unlike `click`, React doesn't queue
    // and replay `input`/`change` events once hydration catches up, so
    // `typed` can stay stuck at its pre-hydration value (null) even though
    // the field's actual DOM value is already correct. The submit click
    // itself IS replayed, so `submit` still runs - just with stale state -
    // and a correctly-typed ZIP got silently rejected as invalid. FormData
    // reads what's actually in the field at the moment of submission, so
    // this is correct regardless of whether `typed` caught up yet.
    const raw = new FormData(e.currentTarget).get('zip');
    const clean = (typeof raw === 'string' ? raw : zip).trim();
    if (!/^\d{5}$/.test(clean)) {
      setError(t('zipInvalid'));
      return;
    }
    setError(null);
    setPrefs({ zip: clean });
    router.push(`/reps?zip=${clean}`);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 max-w-md" noValidate>
      <label htmlFor="zip" className="text-sm font-semibold">
        {t('zipLabel')}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="zip"
          name="zip"
          inputMode="numeric"
          maxLength={5}
          autoComplete="postal-code"
          autoFocus={autoFocus}
          placeholder={t('zipPlaceholder')}
          value={zip}
          onChange={(e) => setTyped(e.target.value)}
          aria-invalid={!!error}
          aria-describedby={error ? 'zip-error' : 'zip-help'}
          className="w-36 rounded-control border-2 border-ink/20 bg-surface px-4 py-3 text-lg tracking-wide focus:border-ink"
        />
        <button
          type="submit"
          className="inline-flex items-center gap-2 rounded-control bg-ink px-5 py-3 font-semibold text-paper hover:bg-night active:translate-y-px"
        >
          {t('zipCta')}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {error ? (
        <p id="zip-error" role="alert" className="text-sm font-medium text-clay">
          {error}
        </p>
      ) : (
        <p id="zip-help" className="text-sm text-ink-faint">
          {t('zipHelp')}
        </p>
      )}
    </form>
  );
}

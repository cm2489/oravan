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

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const clean = zip.trim();
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
      <div className="flex gap-2">
        <input
          id="zip"
          name="zip"
          inputMode="numeric"
          autoComplete="postal-code"
          autoFocus={autoFocus}
          placeholder={t('zipPlaceholder')}
          value={zip}
          onChange={(e) => setTyped(e.target.value)}
          aria-invalid={!!error}
          aria-describedby={error ? 'zip-error' : 'zip-help'}
          className="w-36 rounded-control border-2 border-ink/20 bg-white px-4 py-3 text-lg tracking-wide focus:border-ink"
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

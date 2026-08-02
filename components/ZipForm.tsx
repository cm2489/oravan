'use client';

import { useId, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter, getPathname } from '@/i18n/navigation';
import type { routing } from '@/i18n/routing';
import { setPrefs, usePrefs } from '@/lib/local';

/*
 * The ZIP field is the funnel's front door and it renders at three very
 * different widths - the home hero, the /reps prompt, and the bill page's
 * "Make your call" rail. So the row is a CONTAINER query, not a viewport one:
 * it stacks whenever THIS FORM is narrow, which is the only width that
 * actually decides whether two controls fit side by side. A viewport query
 * would leave the rail's 22rem copy rendering a two-track grid on a desktop.
 *
 * FAILURE IS NEVER CARRIED BY COLOR. `go` and `alert` sit 1.19:1 apart in
 * luminance, so a red-vs-green read is unavailable to a deuteranope. The
 * error block is therefore opened by a 3px ink rule, led by a bold uppercase
 * label, and wired with aria-invalid + role="alert"; the alert tone on the
 * label is the third signal, never the first. The field itself thickens to a
 * 3px ink edge and drops to the `wash` ground - both shape changes, not hues.
 *
 * IDS ARE PER-INSTANCE (useId), not the literal "zip". On a bill page this
 * form renders TWICE at once when no ZIP is saved - in the call rail and again
 * inside the call dialog - and a hardcoded id made both `label[for]`s resolve
 * to the FIRST #zip in document order. The dialog's own input was then left
 * with no accessible name at all (and `aria-describedby` pointed at the other
 * instance's help text), so the "never a dead end" recovery path was unlabeled
 * for anyone using a screen reader. `name` stays "zip" - FormData reads it,
 * and each instance is its own <form>, so names need no uniquing.
 */

const FIELD_BASE =
  'min-h-12 w-full rounded-control px-4 py-3 text-lg text-ink tabular-nums placeholder:text-ink-2';

export function ZipForm({
  autoFocus = false,
  onSaved,
}: {
  autoFocus?: boolean;
  /**
   * In-panel resolution (the bill page's call rail + call dialog): when
   * present, a valid submit saves the ZIP and hands it to the caller INSTEAD
   * of navigating to /reps — "the panel scrolls, the call stays". The home
   * hero and /reps instances pass nothing and keep navigating (funnel I2's
   * ZIP-first path is pinned on exactly that).
   */
  onSaved?: (zip: string) => void;
}) {
  const t = useTranslations('home');
  const uid = useId();
  const fieldId = `zip-${uid}`;
  const errorId = `zip-error-${uid}`;
  const helpId = `zip-help-${uid}`;
  const router = useRouter();
  const locale = useLocale();
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
    if (onSaved) {
      onSaved(clean);
      return;
    }
    router.push(`/reps?zip=${clean}`);
  }

  return (
    // PROGRESSIVE ENHANCEMENT: `action` + `method` are what make this form work
    // before hydration and with JS off. Without them the browser GETs the
    // current URL, and the home page never reads `?zip=` — so a correctly typed
    // ZIP vanished and the funnel's front door was a dead end. `submit` still
    // calls preventDefault(), so nothing changes for a hydrated visitor; the
    // field's `name="zip"` already produces exactly the query /reps expects.
    <form
      onSubmit={submit}
      action={getPathname({ locale: locale as (typeof routing)['locales'][number], href: '/reps' })}
      method="get"
      className="@container max-w-[30rem]"
      noValidate
    >
      <label htmlFor={fieldId} className="block text-sm font-bold">
        {t('zipLabel')}
      </label>
      {/* one grid, two full-bleed rows while the form is narrow: no ragged
          right edge on a phone or in the bill rail */}
      <div className="mt-2 grid gap-2 @min-[26rem]:grid-cols-[9.5rem_minmax(0,1fr)]">
        <input
          id={fieldId}
          name="zip"
          inputMode="numeric"
          maxLength={5}
          autoComplete="postal-code"
          autoFocus={autoFocus}
          placeholder={t('zipPlaceholder')}
          value={zip}
          onChange={(e) => setTyped(e.target.value)}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : helpId}
          className={
            error
              ? `${FIELD_BASE} border-[3px] border-ink bg-wash`
              : `${FIELD_BASE} border-2 border-ink bg-paper hover:border-go-deep`
          }
        />
        <button
          type="submit"
          className="ring-gap inline-flex min-h-12 items-center justify-center gap-2 rounded-control border-2 border-go bg-go px-6 py-3 font-bold text-paper hover:border-go-deep hover:bg-go-deep active:border-go-deep active:bg-go-deep"
        >
          {t('zipCta')}
          <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
        </button>
      </div>
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="mt-3 max-w-note border-t-[3px] border-ink bg-wash p-4 text-sm font-semibold text-ink"
        >
          <b className="mb-0.5 block text-2xs font-extrabold tracking-[0.1em] text-alert uppercase">
            {t('zipErrorLabel')}
          </b>
          {error}
        </p>
      ) : (
        <p id={helpId} className="mt-3 max-w-note text-sm text-ink-2">
          {t('zipHelp')}
        </p>
      )}
    </form>
  );
}

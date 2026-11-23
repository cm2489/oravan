'use client';

import { useActionState, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter, getPathname } from '@/i18n/navigation';
import type { routing } from '@/i18n/routing';
import { savedZip, setPrefs, useErasures, usePrefs } from '@/lib/local';
import { lookupMembers } from '@/lib/members-action';

/*
 * The ZIP field is the funnel's front door and it renders at three very
 * different widths - the home hero, the /reps prompt, and the bill page's
 * "Make your call" rail. So the row is a CONTAINER query, not a viewport one:
 * it stacks whenever THIS FORM is narrow, which is the only width that
 * actually decides whether two controls fit side by side. A viewport query
 * would leave the rail's 22rem copy rendering a two-track grid on a desktop.
 *
 * FAILURE IS NEVER CARRIED BY COLOR. `go` and `alert` sit 1.24:1 apart in
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

type ZipFormProps = {
  autoFocus?: boolean;
  /**
   * The native form's action, when the page already holds the members
   * lookup's state (components/RepsLookup.tsx on /reps passes its own, so
   * the page has exactly one useActionState for lookupMembers and a no-JS
   * submit's answer lands in it). Every other instance makes its own: the
   * same server action with the same permalink, so a no-JS submit from the
   * home hero or a bill page lands on /reps with the members.
   */
  formAction?: (form: FormData) => void;
  /**
   * The submit's visual weight. 'primary' (default) is the filled lamp
   * every other instance has. 'secondary' is what the home hero passes
   * (2026-09-24, finding B3): the hero keeps exactly ONE lamp, and under
   * "Truth-first, call-next" (CLAUDE.md) that is the jump to what is moving,
   * not the field that asks for a ZIP. Since the UI audit fixes of
   * 2026-11-22 (finding F7) 'secondary' is the site's filled ink button
   * (as on the error screen and Your record), not an ink outline on paper:
   * the outline was the field's own treatment, so on a phone the pair read
   * as two input boxes. Paper on ink 16.50, on ink-2 (hover) 7.56; the
   * `ring-gap` stack is the one in docs/accessibility.md. Keys, behaviour
   * and the ZIP-first funnel path are untouched by the tone.
   */
  submitTone?: 'primary' | 'secondary';
  /**
   * Field and submit side by side at EVERY width (the home hero, 2026-09-24).
   * A ZIP is five digits, so the field never needs a full row; putting the
   * submit beside it keeps the hero's lowest control clear of the phone
   * thumb bar on short screens (390×664 in tests/home-fold.spec.ts). Other
   * instances keep the container-query stacking below.
   *
   * The inline row is also too narrow for the full submit label ("Find my
   * representatives" wrapped to two lines at 390px), so it prints
   * `home.zipCtaShort` ("Find my reps" / "Buscar mis reps"), the header's
   * own short word for the members page. Every stacked instance (/reps, the
   * bill rail, the call dialog) keeps `home.zipCta`.
   */
  inline?: boolean;
  /**
   * In-panel resolution (the bill page's call rail + call dialog): when
   * present, a valid submit saves the ZIP and hands it to the caller INSTEAD
   * of navigating to /reps — "the panel scrolls, the call stays". The home
   * hero and /reps instances pass nothing and keep navigating (funnel I2's
   * ZIP-first path is pinned on exactly that).
   */
  onSaved?: (zip: string) => void;
};

/*
 * THE ZIP NEVER GOES IN AN ADDRESS (owner, 2026-11-12; CLAUDE.md rule 1).
 * With JavaScript on, a valid submit saves the ZIP in this browser
 * (lib/local.ts) and then either hands it to `onSaved` or opens bare /reps,
 * which looks up the saved ZIP itself (components/RepsLookup.tsx). With
 * JavaScript off, or before hydration, the browser submits the form natively:
 * its action is the members lookup (lib/members-action.ts) with the permalink
 * /reps (or /es/reps), so it POSTs the field to that page and the server
 * renders the members from the request body. Either way the ZIP is in no web
 * address, so it is in no request log, history entry or shared link.
 */
export function ZipForm(props: ZipFormProps) {
  if (props.formAction) return <ZipFormBody {...props} formAction={props.formAction} />;
  return <ZipFormWithLookup {...props} />;
}

/** An instance away from /reps: its own handle on the lookup, posting to /reps. */
function ZipFormWithLookup(props: ZipFormProps) {
  const locale = useLocale();
  const [, formAction] = useActionState(lookupMembers, null, repsPermalink(locale));
  return <ZipFormBody {...props} formAction={formAction} />;
}

/** The members page in this locale: /reps, or /es/reps. */
export function repsPermalink(locale: string): string {
  return getPathname({ locale: locale as (typeof routing)['locales'][number], href: '/reps' });
}

function ZipFormBody({
  autoFocus = false,
  onSaved,
  submitTone = 'primary',
  inline = false,
  formAction,
}: ZipFormProps & { formAction: (form: FormData) => void }) {
  const t = useTranslations('home');
  const uid = useId();
  const fieldId = `zip-${uid}`;
  const errorId = `zip-error-${uid}`;
  const helpId = `zip-help-${uid}`;
  const router = useRouter();
  const prefs = usePrefs();
  // What was typed, with the erase count it was typed under (lib/local.ts):
  // an erase, here or in another tab, empties the field (2026-11-19).
  const erasures = useErasures();
  const [typedAt, setTypedAt] = useState<{ value: string; erasures: number } | null>(null);
  const typed = typedAt && typedAt.erasures === erasures ? typedAt.value : null;
  const setTyped = (value: string) => setTypedAt({ value, erasures });
  const [error, setError] = useState<string | null>(null);
  const zip = typed ?? prefs.zip ?? '';
  const fieldRef = useRef<HTMLInputElement>(null);

  /*
   * THE FIELD'S AUTOFOCUS NEVER MOVES THE PAGE (2026-10-06). On a client-side
   * arrival React focuses an `autoFocus` field itself, in the same commit that
   * inserts it, so before the browser has laid it out. WebKit then scrolls to
   * the focused field at its NEXT rendering update, not at once. The router
   * has already scrolled to the page's #hash by then (the call panel's "See
   * your record" lands on /reps#your-calls, under this form), so the late
   * scroll threw the page back to the top. With a saved ZIP the page goes
   * straight on to its members (2026-09-29 to 2026-11-12, by a navigation to
   * /reps?zip=), and that navigation scrolled to Your calls again; but when
   * the late scroll came after it rather than before, the page still ended at
   * the top. That race is why
   * tests/reps-record.spec.ts failed about one CI run in five.
   *
   * So, once the field is laid out, focus is taken off and put back with
   * preventScroll. Measured in WebKit: that cancels the late scroll and keeps
   * the focus, while preventScroll on a field not yet laid out does not (the
   * page still jumps). The field is focused, as before, and where the page
   * sits is left to the router.
   *
   * A field that came with the server HTML is left alone. On a full page load
   * the browser's own autofocus focuses it (and already skips a page opened
   * at a #hash), or the reader has tapped it and may be typing, and hydration
   * runs this effect too: a blur then could close a phone's keyboard under
   * the reader's fingers. Only the server render writes the `autofocus`
   * attribute; React's client render never does, so the attribute is what
   * tells the two apart.
   */
  /*
   * A ZIP TYPED BEFORE THE PAGE WOKE IS KEPT (2026-11-19, PR #521). The
   * server renders this field empty: it cannot know the saved ZIP. A reader
   * who types before the page's JavaScript has started (a slow phone, a busy
   * machine) puts a value in the field that React leaves in place when it
   * takes the page over, but nothing tells this component, and the first
   * render that reads the saved ZIP (`prefs.zip` below, right after) wrote
   * the saved ZIP over it. Enter then saved and looked up the OLD ZIP: on
   * /reps?change=1 the reader typed 10001 and got 78501 back
   * (tests/zip-typed-before-hydration.spec.ts).
   *
   * And the saved ZIP used to arrive one task AFTER the page woke (the
   * store's first read in the browser waits for the page's effects), so for
   * that moment the field stood empty and took keys, and then the saved ZIP
   * landed on whatever was being typed. Measured on CI under load
   * (2026-11-19): typing in that gap went into a field the saved ZIP had just
   * filled, and Enter sent the saved ZIP.
   *
   * So, as the field is first mounted and before anything else can happen:
   * a value in it that is not the one rendered (`defaultValue` holds the
   * rendered one) is what the reader typed, and it is kept as typed; an
   * empty field gets the saved ZIP now, in the same step, not one task later,
   * selected when the field already has focus (below).
   * A field mounted after the page woke already holds what it should, and
   * nothing changes.
   */
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    if (field.value !== field.defaultValue) setTyped(field.value);
    else if (field.value === '') {
      const saved = savedZip();
      if (!saved) return;
      setTyped(saved);
      // Already focused (its autofocus, or a tap) while it stood empty: the
      // reader may be about to type, so the saved ZIP arrives selected, and
      // what they type replaces it rather than landing after five digits
      // (the field takes five). Measured on CI (2026-11-19): a field
      // selected while empty, then filled, took no keys at all.
      if (document.activeElement === field) {
        field.value = saved;
        field.select();
      }
    }
    // Once, when the field first mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!autoFocus || !field || document.activeElement !== field) return;
    if (field.hasAttribute('autofocus')) return; // from the server HTML (see above)
    field.getBoundingClientRect(); // lay the field out first (see above)
    field.blur();
    field.focus({ preventScroll: true });
  }, [autoFocus]);

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
    // Bare /reps: the ZIP was saved just above, and the page looks it up
    // from there, in a POST body (components/RepsLookup.tsx).
    router.push('/reps');
  }

  return (
    // PROGRESSIVE ENHANCEMENT: the server-action `action` is what makes this
    // form work before hydration and with JS off. React renders it as a
    // native POST to /reps (the permalink) carrying the field and the
    // action's id, so the ZIP rides in the body and /reps renders the members
    // from it (see above). Without an action the browser would submit to the
    // current page, which reads no ZIP, and the funnel's front door would be
    // a dead end. `submit` calls preventDefault(), so a hydrated visitor's
    // submit never reaches the action here.
    <form onSubmit={submit} action={formAction} className="@container max-w-[30rem]" noValidate>
      <label htmlFor={fieldId} className="block text-sm font-bold">
        {t('zipLabel')}
      </label>
      {/* one grid, two full-bleed rows while the form is narrow: no ragged
          right edge on a phone or in the bill rail */}
      <div
        className={
          inline
            ? 'mt-2 grid grid-cols-[8.5rem_minmax(0,1fr)] gap-2'
            : 'mt-2 grid gap-2 @min-[26rem]:grid-cols-[9.5rem_minmax(0,1fr)]'
        }
      >
        <input
          ref={fieldRef}
          id={fieldId}
          data-zip-field=""
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
          className={
            submitTone === 'secondary'
              ? 'ring-gap inline-flex min-h-12 items-center justify-center gap-2 rounded-control border-2 border-ink bg-ink px-4 py-2 font-bold text-paper hover:bg-ink-2 active:bg-ink-2'
              : 'ring-edge inline-flex min-h-12 items-center justify-center gap-2 rounded-control border-2 border-ink bg-urgent px-6 py-3 font-bold text-ink hover:bg-urgent-deep active:bg-urgent-deep'
          }
        >
          {inline ? t('zipCtaShort') : t('zipCta')}
          {/* At 320px the inline row leaves the submit 144px, and the arrow
              is what would push the short label onto a second line. It is
              decoration, so under 360px it steps out. */}
          <ArrowRight
            className={`h-4 w-4 shrink-0 ${inline ? 'max-[22.5rem]:hidden' : ''}`}
            aria-hidden
          />
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

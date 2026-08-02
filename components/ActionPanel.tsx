'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Copy, Ear, Moon, Phone, RotateCcw, Sparkles, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { upsertCall, useCalls, usePrefs } from '@/lib/local';
import type { CallOutcome, Legislator, Stance } from '@/lib/types';
import { OfficeHoursNote } from './OfficeHoursNote';
import { ZipForm } from './ZipForm';

/*
 * THE CALL RAIL — a control panel, not a card.
 *
 * On the desk it is a sticky panel that holds the height of the window: an
 * ink title bar, a body that scrolls on its own, and a FOOT that sits
 * OUTSIDE that scroll area. The foot is where the call lives, so the call
 * can never be scrolled away from. Below the desk breakpoint the same
 * markup is simply in flow, in the read -> pick -> edit -> call order.
 *
 * COLOR LAW inside this panel:
 *   go     the dial, and only the dial (plus the stance card's chosen edge,
 *          which IS an action control).
 *   tint   YOURS — the stance you picked, the outcome you logged. Never a
 *          status, never decoration.
 *   ink    everything else, including every ground and every edge.
 *   alert  failure only, and never the sole carrier: every failure here
 *          also has a 3px rule, a bold label and role="alert".
 *
 * The `#act` id and `data-call-cta` are load-bearing: FloatingCallButton
 * links to the first and stands down whenever the second is on screen.
 */

interface Props {
  slug: string;
  identifier: string;
  title: string;
}

const STANCES: Stance[] = ['support', 'oppose', 'undecided'];
const OUTCOMES: CallOutcome[] = ['contact', 'voicemail', 'unavailable'];

/** The panel's own inner radius: an 8px box with a 2px edge. Geometry, not a third radius. */
const INNER_RADIUS = 'calc(var(--radius-control)-2px)';

/** Quiet, hand-sized control on paper. `line-strong` edges need paper on one side. */
const GHOST =
  'inline-flex min-h-11 items-center gap-1.5 rounded-control border-[1.5px] border-line-strong px-3 py-2 text-sm font-semibold text-ink hover:border-ink';

function telHref(phone: string) {
  return `tel:+1${phone.replace(/\D/g, '')}`;
}

/** Failure, expressed three ways: a 3px rule, a bold label, and role="alert". */
function Failure({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-control border-l-[3px] border-alert bg-wash px-4 py-3 text-sm"
    >
      {children}
    </div>
  );
}

export function ActionPanel({ slug, identifier, title }: Props) {
  const t = useTranslations('bill');
  const locale = useLocale();

  const [stance, setStance] = useState<Stance | null>(null);
  // One draft per stance: switching stances never destroys the user's edits.
  const [drafts, setDrafts] = useState<Partial<Record<Stance, string>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<'generic' | 'rate' | null>(null);
  const [reps, setReps] = useState<Legislator[]>([]);
  const [repsError, setRepsError] = useState(false);
  const prefs = usePrefs();
  const zip = prefs.zip ?? null;
  const [copied, setCopied] = useState<string | null>(null);
  const [scriptCopied, setScriptCopied] = useState(false);
  const [loggedOutcomes, setLoggedOutcomes] = useState<Record<string, CallOutcome>>({});
  // Call modal: native <dialog> (focus trap, background inert, and Escape
  // come from the platform - same idiom as FeedbackDialog). startCallRef is
  // the trigger focus returns to when the dialog closes.
  const dialogRef = useRef<HTMLDialogElement>(null);
  const startCallRef = useRef<HTMLButtonElement>(null);
  const callTitleRef = useRef<HTMLHeadingElement>(null);
  const stanceRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // The dialog is mounted ONLY while open (see render below). Mounting it
  // whenever a script exists would put a second copy of the script, the
  // office-hours note, and the rep dial buttons in the (hidden) DOM, so a
  // getByText for any of those matches twice — the call-action/flow e2e specs
  // caught exactly that. openCallModal flips this; an effect drives showModal()
  // once the element is in the tree, and onClose unmounts it again.
  const [callOpen, setCallOpen] = useState(false);
  const callCount = useCalls().length;

  // The drafting wait gets product-specific rotating lines, not a frozen spinner.
  const [genLine, setGenLine] = useState<1 | 2 | 3>(1);
  useEffect(() => {
    if (!loading) return;
    const id = setInterval(() => setGenLine((g) => (g === 3 ? 1 : ((g + 1) as 1 | 2 | 3))), 3200);
    return () => clearInterval(id);
  }, [loading]);

  const script = stance ? (drafts[stance] ?? '') : '';
  const setScript = (text: string) => {
    if (stance) setDrafts((d) => ({ ...d, [stance]: text }));
  };

  const fetchReps = useCallback(() => {
    if (!zip) return;
    fetch(`/api/reps?zip=${zip}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        setReps(d.reps);
        setRepsError(false);
      })
      .catch(() => setRepsError(true));
  }, [zip]);

  useEffect(fetchReps, [fetchReps]);

  async function generate(s: Stance) {
    setStance(s);
    setError(null);
    if (drafts[s]) return; // a draft (possibly user-edited) already exists - restore, don't regenerate
    setGenLine(1); // restart the rotating lines for this generation
    setLoading(true);
    try {
      const res = await fetch('/api/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, stance: s, locale }),
      });
      if (res.status === 429) {
        setError('rate');
        return;
      }
      if (!res.ok) {
        setError('generic');
        return;
      }
      const data = await res.json();
      setDrafts((d) => ({ ...d, [s]: data.script }));
    } catch {
      setError('generic');
    } finally {
      setLoading(false);
    }
  }

  function copyNumber(phone: string) {
    navigator.clipboard?.writeText(phone).then(() => {
      setCopied(phone);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  function copyScript() {
    navigator.clipboard?.writeText(script).then(() => {
      setScriptCopied(true);
      setTimeout(() => setScriptCopied(false), 2000);
    });
  }

  function logOutcome(rep: Legislator, outcome: CallOutcome) {
    if (!stance) return;
    // Headlines often already name the bill; don't repeat the citation.
    const norm = (x: string) => x.toLowerCase().replace(/[.\s]/g, '');
    const billLabel = norm(title).includes(norm(identifier)) ? title : `${identifier} · ${title}`;
    upsertCall({
      billSlug: slug,
      billLabel,
      repBioguide: rep.bioguide,
      repName: rep.name,
      stance,
      outcome,
      at: new Date().toISOString(),
    });
    setLoggedOutcomes((prev) => ({ ...prev, [rep.bioguide]: outcome }));
  }

  function openCallModal() {
    setCallOpen(true);
  }

  function closeCallModal() {
    dialogRef.current?.close();
  }

  // Once callOpen mounts the <dialog>, open it modally (focus trap + inert come
  // from showModal). Every close path — the ✕/edit/backdrop handlers call
  // .close(), Escape closes it natively — fires onClose, which unmounts it.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (callOpen && dlg && !dlg.open) {
      dlg.showModal();
      // First focus lands on the dialog's title, not the Close button: a
      // screen reader at the highest-anxiety moment should hear "Make the
      // call" and then the reassurance, never "Close" first (2026-07 a11y
      // critique).
      callTitleRef.current?.focus();
    }
  }, [callOpen]);

  return (
    <section
      aria-labelledby="act"
      data-call-cta
      className="flex min-h-0 w-full flex-col rounded-control border-2 border-ink bg-paper min-[62rem]:max-h-full"
    >
      {/* A real h2, not a styled <p>: the panel's own name has to be in the
          outline, or "Place your call" reads as a subsection of the decoded
          column's heading — a heading in the other column, about another
          thing. */}
      <h2
        id="act"
        className="flex-none bg-ink-deep px-5 py-3 text-xs font-bold tracking-[0.06em] text-paper uppercase leading-tight"
        style={{ borderRadius: `${INNER_RADIUS} ${INNER_RADIUS} 0 0` }}
      >
        {t('actTitle')}
      </h2>

      {/* The body scrolls; the foot below does not. The alpha ramp on the
          last 28px says "this continues" — it is a mask on real content, not
          a painted band — and it lifts while anything inside is focused so a
          focus ring is never dimmed. */}
      <div className="grid min-h-0 content-start gap-6 p-4 md:p-6 min-[62rem]:overflow-y-auto min-[62rem]:[mask-image:linear-gradient(to_bottom,#000_calc(100%-28px),transparent_100%)] min-[62rem]:[scrollbar-gutter:stable] min-[62rem]:has-[:focus-visible]:[mask-image:none]">
        <div>
          <p className="max-w-note text-sm text-ink-2">{t('actSub')}</p>
        </div>

        {/* Step 1 - stance. A real radio group, not three independent toggles:
            exactly one stance can be active, and 2026-07's a11y critique found
            aria-pressed here misdescribes that contract to screen readers.
            Roving tabindex + arrow keys per the WAI-ARIA radio pattern; arrows
            select as they move, same as clicking. */}
        <fieldset>
          <legend className="text-lg font-bold text-ink">{t('stanceQ')}</legend>
          <div role="radiogroup" aria-label={t('stanceQ')} className="mt-3 grid gap-2">
            {STANCES.map((s, i) => (
              <button
                key={s}
                ref={(el) => {
                  stanceRefs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={stance === s}
                tabIndex={(stance ?? STANCES[0]) === s ? 0 : -1}
                onClick={() => generate(s)}
                onKeyDown={(e) => {
                  let next: number | null = null;
                  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % STANCES.length;
                  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + STANCES.length) % STANCES.length;
                  if (next != null) {
                    e.preventDefault();
                    stanceRefs.current[next]?.focus();
                    generate(STANCES[next]);
                  }
                }}
                disabled={loading}
                className={`flex min-h-12 items-center gap-2 rounded-control border-2 px-4 py-3 text-left text-md font-bold transition-colors disabled:cursor-not-allowed disabled:border-line-strong disabled:bg-wash disabled:text-ink-2 ${
                  stance === s
                    ? 'border-go bg-tint text-go-deep'
                    : 'border-line-strong bg-paper text-ink hover:border-ink'
                }`}
              >
                {/* Never colour alone: the chosen card also carries a check
                    and aria-checked. */}
                {stance === s && <Check className="h-4 w-4 flex-none" aria-hidden />}
                {t(`stance.${s}`)}
              </button>
            ))}
          </div>
          {/* Honest expectations: a concern is logged, not debated - keeps the
              "no debate, no quiz" promise true for this stance too. */}
          {stance === 'undecided' && (
            <p className="mt-3 max-w-note text-sm text-ink-2" role="status">
              {t('concernNote')}
            </p>
          )}
        </fieldset>

        {/* Step 2 - script */}
        {loading && (
          <div role="status">
            <p className="flex items-center gap-2 text-ink-2">
              <Sparkles className="h-4 w-4 flex-none animate-pulse" aria-hidden />
              {t(`generating${genLine}`)}
            </p>
            <p className="mt-0.5 text-sm text-ink-2">{t('generatingHint')}</p>
            <div className="mt-2 h-[6px] max-w-note overflow-hidden rounded-stamp bg-line">
              <div className="shimmer h-full w-1/3 rounded-stamp bg-go" />
            </div>
          </div>
        )}
        {error && (
          <Failure>
            <span className="font-bold text-alert">
              {error === 'rate' ? t('rateLimited') : t('scriptError')}
            </span>
            {error !== 'rate' && stance && (
              <button type="button" onClick={() => generate(stance)} className={GHOST}>
                <RotateCcw className="h-4 w-4 flex-none" aria-hidden />
                {t('retry')}
              </button>
            )}
          </Failure>
        )}
        {script && (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-lg font-bold text-ink">{t('scriptTitle')}</h3>
            </div>
            {/* The AI label rides with the draft, above it, every time. */}
            <p className="mt-1 text-sm font-semibold text-ink-2">{t('scriptDisclaimer')}</p>
            <p className="mt-1 max-w-note text-sm text-ink-2">{t('scriptHint')}</p>
            {/* The words a caller says aloud take the reading voice, in both
                languages — and `tint` because the draft is now YOURS. */}
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              rows={8}
              aria-label={t('scriptTitle')}
              className="mt-3 w-full rounded-control border-2 border-ink bg-paper p-4 font-reading text-lg text-ink"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={copyScript} className={GHOST}>
                {scriptCopied ? (
                  <Check className="h-4 w-4 flex-none" aria-hidden />
                ) : (
                  <Copy className="h-4 w-4 flex-none" aria-hidden />
                )}
                {scriptCopied ? t('scriptCopied') : t('copyScript')}
              </button>
            </div>
            {/* Announce the copy confirmation without moving focus - same idiom
                as SharePanel's copy-link status region. Covers the modal's own
                copy button too, since both share this scriptCopied state. */}
            <span role="status" aria-live="polite" className="sr-only">
              {scriptCopied ? t('scriptCopied') : ''}
            </span>
          </div>
        )}

        {/* Step 3 - call */}
        {script && (
          <div className="border-t-[1.5px] border-line pt-4">
            <h3 className="text-lg font-bold text-ink">{t('callTitle')}</h3>

            <div className="mt-3 grid gap-3">
              <div className="flex gap-2 border-t-[1.5px] border-line pt-3 text-sm">
                <Ear className="h-5 w-5 shrink-0 text-ink-2" aria-hidden />
                <div className="max-w-note">
                  <p className="font-bold text-ink">{t('hearFirstTitle')}</p>
                  <p className="mt-0.5 text-ink-2">{t('hearFirstBody')}</p>
                </div>
              </div>
              {/* Voicemail is a black enamel sign, never green: saturated
                  green is reserved for going somewhere, and a panel that only
                  reassures is not going anywhere. */}
              <div className="on-dark flex gap-2 rounded-control bg-ink-deep p-4 text-sm">
                <Moon className="h-5 w-5 shrink-0 text-ink-pale" aria-hidden />
                <div className="max-w-note">
                  <p className="font-bold text-paper">{t('afterHoursTitle')}</p>
                  <p className="mt-0.5 leading-dark tracking-dark text-ink-pale">
                    {t('afterHoursBody')}
                  </p>
                </div>
              </div>
              <OfficeHoursNote />
            </div>
            <p className="mt-3 max-w-note text-sm text-ink-2">{t('staffNote')}</p>
            <Link
              href="/why-call"
              className="mt-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-go underline visited:text-go-deep hover:text-go-deep"
            >
              <BookOpen className="h-4 w-4 flex-none" aria-hidden />
              {t('whyLink')}
            </Link>

            {repsError && (
              <div className="mt-4">
                <Failure>
                  <span className="font-bold text-alert">{t('repsError')}</span>
                  <button type="button" onClick={fetchReps} className={GHOST}>
                    <RotateCcw className="h-4 w-4 flex-none" aria-hidden />
                    {t('retry')}
                  </button>
                </Failure>
              </div>
            )}

            {!zip && (
              <div className="mt-4 rounded-control border-[1.5px] border-line-strong bg-paper p-4">
                <p className="mb-3 text-sm font-semibold text-ink">{t('needZip')}</p>
                <ZipForm />
              </div>
            )}

            {reps.length > 0 && (
              <p className="mt-4 max-w-note font-semibold text-ink">
                {reps.some((r) => r.type === 'sen') ? t('callWho') : t('callWhoOne')}
              </p>
            )}
            <ul className="mt-3 grid list-none gap-3">
              {reps.map((rep) => {
                const logged = loggedOutcomes[rep.bioguide];
                return (
                  <li
                    key={rep.bioguide}
                    className="rounded-control border-[1.5px] border-line-strong p-4"
                  >
                    <p className="font-bold text-ink">{rep.name}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {rep.phone && (
                        <>
                          <a
                            href={telHref(rep.phone)}
                            className="ring-gap inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-go bg-go px-4 py-2.5 font-bold text-paper no-underline tabular-nums hover:border-go-deep hover:bg-go-deep"
                          >
                            <Phone className="h-4 w-4 flex-none" aria-hidden />
                            {rep.phone}
                          </a>
                          <button
                            type="button"
                            onClick={() => copyNumber(rep.phone!)}
                            className={GHOST}
                          >
                            {copied === rep.phone ? (
                              <Check className="h-4 w-4 flex-none" aria-hidden />
                            ) : (
                              <Copy className="h-4 w-4 flex-none" aria-hidden />
                            )}
                            {copied === rep.phone ? t('copied') : t('copy')}
                          </button>
                        </>
                      )}
                      {rep.offices.slice(0, 2).map((o, i) => (
                        <a key={i} href={telHref(o.phone!)} className={`${GHOST} tabular-nums`}>
                          <Phone className="h-3.5 w-3.5 flex-none" aria-hidden />
                          {o.city} · {o.phone}
                        </a>
                      ))}
                    </div>

                    {/* Step 4 - outcome (one record per rep; re-tap changes it) */}
                    <div className="mt-3">
                      <p className="text-sm font-semibold text-ink-2">
                        {t('outcomeQ')}
                        {logged && <span className="ml-1 font-normal">{t('outcomeChange')}</span>}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {OUTCOMES.map((o) => (
                          <button
                            key={o}
                            type="button"
                            onClick={() => logOutcome(rep, o)}
                            aria-pressed={logged === o}
                            className={`inline-flex min-h-11 items-center gap-1.5 rounded-stamp border px-3 py-2 text-sm font-semibold ${
                              logged === o
                                ? 'pop border-ink bg-tint text-ink'
                                : 'border-line-strong text-ink-2 hover:border-ink hover:text-ink'
                            }`}
                          >
                            {logged === o && <Check className="h-4 w-4 flex-none" aria-hidden />}
                            {t(`outcome.${o}`)}
                          </button>
                        ))}
                      </div>

                      {/* The payoff lands where the tap happened, not below the
                          fold — and on `tint`, because the record is yours. */}
                      {logged && (
                        <div
                          className="mt-3 flex items-start gap-3 rounded-control bg-tint px-4 py-3"
                          role="status"
                        >
                          <svg
                            aria-hidden
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="draw-check mt-0.5 h-6 w-6 flex-none text-ink"
                          >
                            <circle cx="12" cy="12" r="9" />
                            <path d="m8.5 12.5 2.5 2.5 5-6" />
                          </svg>
                          <div className="max-w-note">
                            <p className="font-semibold text-ink">
                              {callCount === 1
                                ? t('loggedFirst')
                                : callCount === 5
                                  ? t('loggedFifth')
                                  : callCount === 10
                                    ? t('loggedTenth')
                                    : t('outcomeLogged')}{' '}
                              <Link
                                href="/record"
                                className="font-semibold text-go-deep underline"
                              >
                                {t('viewImpact')}
                              </Link>
                            </p>
                            {/* PERSISTENT on-device reassurance: it must NOT vanish on
                                the 1st/5th/10th call, when a first-timer — the moment
                                the milestone fires — is most anxious about where the
                                position they just logged actually went. Kept as its own
                                always-rendered line, never folded into a milestone. */}
                            <p className="mt-1 text-sm text-ink-2">{t('savedOnDevice')}</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {/* THE FOOT — outside the scrolling body, so the call can never be
          scrolled away from. It appears the moment there is a script to read
          from, and never before: offering a dial with nothing to say is the
          thing that makes a first-time caller hang up. */}
      {script && (
        <div
          className="flex-none border-t-2 border-ink bg-paper p-3"
          style={{ borderRadius: `0 0 ${INNER_RADIUS} ${INNER_RADIUS}` }}
        >
          <p className="mb-2 hidden text-2xs font-bold tracking-[0.08em] text-ink-2 uppercase min-[62rem]:block">
            {t('footNote')}
          </p>
          <button
            ref={startCallRef}
            type="button"
            onClick={openCallModal}
            className="ring-gap flex min-h-12 w-full items-center justify-center gap-2 rounded-control border-2 border-go bg-go px-6 py-3 font-bold text-paper hover:border-go-deep hover:bg-go-deep"
          >
            <Phone className="h-4 w-4 flex-none" aria-hidden />
            {t('startCall')}
          </button>
        </div>
      )}

      {/* Call mode: the V2 composition in a focused overlay. A deliberate
          modal - the call is a mode in real life too; nothing else matters
          while the phone is ringing. */}
      {script && callOpen && (
        <dialog
          ref={dialogRef}
          aria-label={t('callTitle')}
          onClose={() => {
            setCallOpen(false);
            startCallRef.current?.focus();
          }}
          onClick={(e) => e.target === dialogRef.current && closeCallModal()}
          className="m-auto max-h-[85dvh] w-[min(92vw,42rem)] overflow-y-auto rounded-control border-2 border-ink bg-paper p-5 backdrop:bg-ink/70 md:p-6"
        >
          <div className="flex items-start justify-between gap-3">
            <h3 ref={callTitleRef} tabIndex={-1} className="text-h3 font-extrabold text-ink outline-none">
              {t('callTitle')}
            </h3>
            <button type="button" onClick={closeCallModal} className={GHOST}>
              <X className="h-4 w-4 flex-none" aria-hidden />
              {t('closeBig')}
            </button>
          </div>

          {/* Pre-dial beat: a calm moment between "script ready" and
              dialing - never a gate in front of the tel: links below, just
              what a first-time caller most needs to hear, or a lighter
              reminder for everyone after that. Voicemail is framed as a
              fully legitimate first choice, not an apologetic fallback -
              offices tally it exactly like a live call (S7 / docs/ideation
              §5). */}
          <div className="on-dark mt-4 flex gap-2 rounded-control bg-ink-deep p-4 text-sm">
            <Moon className="h-5 w-5 shrink-0 text-ink-pale" aria-hidden />
            <div className="max-w-note">
              <p className="font-bold text-paper">
                {callCount === 0 ? t('firstCallTitle') : t('preDialTitle')}
              </p>
              <p className="mt-0.5 leading-dark tracking-dark text-ink-pale">
                {callCount === 0 ? t('firstCallBody') : t('preDialBody')}
              </p>
              {/* The core persuasion, one tap from the highest-anxiety moment
                  (2026-07 critique round 2): every pre-call surface links
                  /why-call in-flow. Navigating away closes the mode - that is
                  the reader's own call to make. */}
              <Link
                href="/why-call"
                className="mt-2 inline-flex min-h-11 items-center gap-1.5 font-semibold text-go-bright underline"
              >
                <BookOpen className="h-4 w-4 flex-none" aria-hidden />
                {t('whyLink')}
              </Link>
            </div>
          </div>
          <div className="mt-3">
            <OfficeHoursNote />
          </div>

          {/* The words said aloud: reading voice, on `tint`, because this is
              yours to read from. */}
          <p className="mt-5 rounded-control bg-tint p-4 font-reading text-lg whitespace-pre-wrap text-ink">
            {script}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={closeCallModal}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-ink underline"
            >
              {t('editScript')}
            </button>
            <button type="button" onClick={copyScript} className={GHOST}>
              {scriptCopied ? (
                <Check className="h-4 w-4 flex-none" aria-hidden />
              ) : (
                <Copy className="h-4 w-4 flex-none" aria-hidden />
              )}
              {scriptCopied ? t('scriptCopied') : t('copyScript')}
            </button>
          </div>

          {reps.length > 0 && (
            <div className="mt-5 grid gap-2">
              {reps.map(
                (rep) =>
                  rep.phone && (
                    <a
                      key={rep.bioguide}
                      href={telHref(rep.phone)}
                      className="ring-gap flex min-h-12 items-center justify-between gap-3 rounded-control border-2 border-go bg-go px-4 py-3 font-bold text-paper no-underline hover:border-go-deep hover:bg-go-deep"
                    >
                      <span className="inline-flex items-center gap-2">
                        <Phone className="h-4 w-4 flex-none" aria-hidden />
                        {rep.name}
                      </span>
                      <span className="text-sm tabular-nums">{rep.phone}</span>
                    </a>
                  )
              )}
            </div>
          )}

          {/* Never a dead end (2026-07 critique, top consensus P0): with no
              saved ZIP the modal used to show a script and zero numbers. The
              ZIP mini-form lives IN the mode now, and the Capitol switchboard
              is the universal fallback that needs no ZIP at all. */}
          {reps.length === 0 && (
            <div className="mt-5 grid gap-3">
              {repsError && (
                <Failure>
                  <span className="font-bold text-alert">{t('repsError')}</span>
                  <button type="button" onClick={fetchReps} className={GHOST}>
                    <RotateCcw className="h-4 w-4 flex-none" aria-hidden />
                    {t('retry')}
                  </button>
                </Failure>
              )}
              {!zip && (
                <div className="rounded-control border-[1.5px] border-line-strong bg-paper p-4">
                  <p className="mb-3 text-sm font-semibold text-ink">{t('needZip')}</p>
                  <ZipForm />
                </div>
              )}
              <div className="rounded-control border-[1.5px] border-line-strong p-4">
                <p className="max-w-note text-sm text-ink-2">{t('switchboardNote')}</p>
                <a
                  href="tel:+12022243121"
                  className="ring-gap mt-2 inline-flex min-h-12 flex-wrap items-center gap-2 rounded-control border-2 border-go bg-go px-4 py-3 font-bold text-paper no-underline hover:border-go-deep hover:bg-go-deep"
                >
                  <Phone className="h-4 w-4 flex-none" aria-hidden />
                  {t('switchboard')}
                  <span className="text-sm tabular-nums">(202) 224-3121</span>
                </a>
              </div>
            </div>
          )}
        </dialog>
      )}
    </section>
  );
}

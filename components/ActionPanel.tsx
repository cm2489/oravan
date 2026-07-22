'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Copy, Ear, Moon, Phone, RotateCcw, Sparkles, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { upsertCall, useCalls, usePrefs } from '@/lib/local';
import type { CallOutcome, Legislator, Stance } from '@/lib/types';
import { OfficeHoursNote } from './OfficeHoursNote';
import { ZipForm } from './ZipForm';

interface Props {
  slug: string;
  identifier: string;
  title: string;
}

const STANCES: Stance[] = ['support', 'oppose', 'undecided'];
const OUTCOMES: CallOutcome[] = ['contact', 'voicemail', 'unavailable'];

function telHref(phone: string) {
  return `tel:+1${phone.replace(/\D/g, '')}`;
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
    <section aria-labelledby="act" data-call-cta className="mt-12 rounded-card border-2 border-ink bg-surface p-6 md:p-8 shadow-lift">
      <h2 id="act" className="font-display text-3xl font-bold">
        {t('actTitle')}
      </h2>
      <p className="mt-1 text-ink-soft">{t('actSub')}</p>

      {/* Step 1 - stance. A real radio group, not three independent toggles:
          exactly one stance can be active, and 2026-07's a11y critique found
          aria-pressed here misdescribes that contract to screen readers.
          Roving tabindex + arrow keys per the WAI-ARIA radio pattern; arrows
          select as they move, same as clicking. */}
      <fieldset className="mt-6">
        <legend className="font-semibold">{t('stanceQ')}</legend>
        <div role="radiogroup" aria-label={t('stanceQ')} className="mt-3 flex flex-wrap gap-2">
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
              className={`rounded-control border-2 px-4 py-3 font-semibold transition-transform disabled:opacity-50 active:translate-y-px ${
                stance === s
                  ? 'border-ink bg-ink text-paper'
                  : 'border-ink/20 bg-surface hover:border-ink/50'
              }`}
            >
              {t(`stance.${s}`)}
            </button>
          ))}
        </div>
        {/* Honest expectations: a concern is logged, not debated - keeps the
            "no debate, no quiz" promise true for this stance too. */}
        {stance === 'undecided' && (
          <p className="mt-3 max-w-prose text-sm text-ink-soft" role="status">{t('concernNote')}</p>
        )}
      </fieldset>

      {/* Step 2 - script */}
      {loading && (
        <div className="mt-6" role="status">
          <p className="flex items-center gap-2 text-ink-soft">
            <Sparkles className="h-4 w-4 flex-none animate-pulse" aria-hidden />
            {t(`generating${genLine}`)}
          </p>
          <p className="mt-0.5 text-sm text-ink-faint">{t('generatingHint')}</p>
          <div className="mt-2 h-1 max-w-md overflow-hidden rounded-full bg-paper-deep">
            <div className="shimmer h-full w-1/3 rounded-full bg-brass" />
          </div>
        </div>
      )}
      {error && (
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-control bg-clay-soft px-4 py-3 text-sm" role="alert">
          <span className="font-medium">{error === 'rate' ? t('rateLimited') : t('scriptError')}</span>
          {error !== 'rate' && stance && (
            <button
              type="button"
              onClick={() => generate(stance)}
              className="inline-flex items-center gap-1.5 rounded-control border border-ink/30 bg-surface px-3 py-1.5 font-semibold hover:border-ink/60"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              {t('retry')}
            </button>
          )}
        </div>
      )}
      {script && (
        <div className="mt-6">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h3 className="font-display text-xl font-bold">{t('scriptTitle')}</h3>
            <p className="rounded-full bg-brass-soft px-3 py-1 text-xs font-medium text-ink">
              {t('scriptDisclaimer')}
            </p>
          </div>
          <p className="mt-1 text-sm text-ink-soft">{t('scriptHint')}</p>
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={7}
            aria-label={t('scriptTitle')}
            className="mt-3 w-full rounded-control border-2 border-ink/20 bg-paper p-4 leading-relaxed focus:border-ink"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={copyScript}
              className="inline-flex items-center gap-1.5 rounded-control border border-ink/20 px-3.5 py-2.5 text-sm font-medium hover:border-ink/50"
            >
              {scriptCopied ? <Check className="h-4 w-4 text-moss" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
              {scriptCopied ? t('scriptCopied') : t('copyScript')}
            </button>
            <button
              ref={startCallRef}
              type="button"
              onClick={openCallModal}
              className="inline-flex items-center gap-2 rounded-control bg-brass px-4 py-2.5 font-semibold text-paper transition-transform hover:bg-brass-deep active:translate-y-px"
            >
              <Phone className="h-4 w-4" aria-hidden />
              {t('startCall')}
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
          className="m-auto max-h-[85dvh] w-[min(92vw,42rem)] overflow-y-auto rounded-card bg-surface p-5 shadow-lift backdrop:bg-night/70 md:p-7"
        >
          <div className="flex items-start justify-between gap-3">
            <h3 ref={callTitleRef} tabIndex={-1} className="font-display text-2xl font-bold outline-none">
              {t('callTitle')}
            </h3>
            <button
              type="button"
              onClick={closeCallModal}
              className="inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-control border border-ink/25 px-3 py-2 text-sm font-semibold hover:border-ink/60"
            >
              <X className="h-4 w-4" aria-hidden />
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
          <div className="mt-4 flex gap-2 rounded-control bg-brass-soft p-4 text-sm">
            <Moon className="h-5 w-5 shrink-0 text-ink-soft" aria-hidden />
            <div>
              <p className="font-semibold">{callCount === 0 ? t('firstCallTitle') : t('preDialTitle')}</p>
              <p className="mt-0.5 text-ink-soft">{callCount === 0 ? t('firstCallBody') : t('preDialBody')}</p>
            </div>
          </div>
          <div className="mt-3">
            <OfficeHoursNote />
          </div>

          <p className="mt-5 whitespace-pre-wrap rounded-control bg-paper p-4 font-display text-xl font-semibold leading-relaxed md:text-2xl">
            {script}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={closeCallModal}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-ink-soft underline underline-offset-4"
            >
              {t('editScript')}
            </button>
            <button
              type="button"
              onClick={copyScript}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-ink/20 px-3 py-2.5 text-sm font-medium hover:border-ink/50"
            >
              {scriptCopied ? <Check className="h-4 w-4 text-moss" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
              {scriptCopied ? t('scriptCopied') : t('copyScript')}
            </button>
          </div>

          {reps.length > 0 && (
            <div className="mt-5 space-y-2">
              {reps.map(
                (rep) =>
                  rep.phone && (
                    <a
                      key={rep.bioguide}
                      href={telHref(rep.phone)}
                      className="flex items-center justify-between gap-3 rounded-control bg-ink px-4 py-3.5 font-semibold text-paper transition-transform hover:bg-night active:translate-y-px"
                    >
                      <span className="inline-flex items-center gap-2">
                        <Phone className="h-4 w-4" aria-hidden />
                        {rep.name}
                      </span>
                      <span className="font-mono text-sm text-brass-bright">{rep.phone}</span>
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
            <div className="mt-5 space-y-3">
              {repsError && (
                <div className="flex flex-wrap items-center gap-3 rounded-control bg-clay-soft px-4 py-3 text-sm" role="alert">
                  <span className="font-medium">{t('repsError')}</span>
                  <button
                    type="button"
                    onClick={fetchReps}
                    className="inline-flex items-center gap-1.5 rounded-control border border-ink/30 bg-surface px-3 py-1.5 font-semibold hover:border-ink/60"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                    {t('retry')}
                  </button>
                </div>
              )}
              {!zip && (
                <div className="rounded-control border border-line bg-paper p-4">
                  <p className="mb-3 text-sm font-medium">{t('needZip')}</p>
                  <ZipForm />
                </div>
              )}
              <div className="rounded-control border border-line p-4">
                <p className="text-sm text-ink-soft">{t('switchboardNote')}</p>
                <a
                  href="tel:+12022243121"
                  className="mt-2 inline-flex flex-wrap items-center gap-2 rounded-control bg-ink px-4 py-3 font-semibold text-paper transition-transform hover:bg-night active:translate-y-px"
                >
                  <Phone className="h-4 w-4" aria-hidden />
                  {t('switchboard')}
                  <span className="font-mono text-sm text-brass-bright">(202) 224-3121</span>
                </a>
              </div>
            </div>
          )}
        </dialog>
      )}

      {/* Step 3 - call */}
      {script && (
        <div className="mt-8">
          <h3 className="font-display text-xl font-bold">{t('callTitle')}</h3>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="flex gap-2 rounded-control bg-brass-soft p-4 text-sm">
              <Ear className="h-5 w-5 shrink-0 text-ink-soft" aria-hidden />
              <div>
                <p className="font-semibold">{t('hearFirstTitle')}</p>
                <p className="mt-0.5 text-ink-soft">{t('hearFirstBody')}</p>
              </div>
            </div>
            <div className="flex gap-2 rounded-control bg-brass-soft p-4 text-sm">
              <Moon className="h-5 w-5 shrink-0 text-ink-soft" aria-hidden />
              <div>
                <p className="font-semibold">{t('afterHoursTitle')}</p>
                <p className="mt-0.5 text-ink-soft">{t('afterHoursBody')}</p>
              </div>
            </div>
            <div className="sm:col-span-2">
              <OfficeHoursNote />
            </div>
          </div>
          <p className="mt-3 text-sm text-ink-soft">{t('staffNote')}</p>
          <Link
            href="/why-call"
            className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold underline underline-offset-4"
          >
            <BookOpen className="h-4 w-4" aria-hidden />
            {t('whyLink')}
          </Link>

          {repsError && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-control bg-clay-soft px-4 py-3 text-sm" role="alert">
              <span className="font-medium">{t('repsError')}</span>
              <button
                type="button"
                onClick={fetchReps}
                className="inline-flex items-center gap-1.5 rounded-control border border-ink/30 bg-surface px-3 py-1.5 font-semibold hover:border-ink/60"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                {t('retry')}
              </button>
            </div>
          )}

          {!zip && (
            <div className="mt-4 rounded-control border border-line bg-paper p-4">
              <p className="mb-3 text-sm font-medium">{t('needZip')}</p>
              <ZipForm />
            </div>
          )}

          {reps.length > 0 && (
            <p className="mt-4 font-medium">
              {reps.some((r) => r.type === 'sen') ? t('callWho') : t('callWhoOne')}
            </p>
          )}
          <ul className="mt-3 space-y-3">
            {reps.map((rep) => {
              const logged = loggedOutcomes[rep.bioguide];
              return (
                <li key={rep.bioguide} className="rounded-control border border-line p-4">
                  <p className="font-semibold">{rep.name}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {rep.phone && (
                      <>
                        <a
                          href={telHref(rep.phone)}
                          className="inline-flex items-center gap-2 rounded-control bg-ink px-4 py-2.5 font-semibold text-paper transition-transform hover:bg-night active:translate-y-px"
                        >
                          <Phone className="h-4 w-4" aria-hidden />
                          {rep.phone}
                        </a>
                        <button
                          type="button"
                          onClick={() => copyNumber(rep.phone!)}
                          className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-ink/20 px-3 py-2.5 text-sm font-medium hover:border-ink/50"
                        >
                          {copied === rep.phone ? (
                            <Check className="h-4 w-4 text-moss" aria-hidden />
                          ) : (
                            <Copy className="h-4 w-4" aria-hidden />
                          )}
                          {copied === rep.phone ? t('copied') : t('copy')}
                        </button>
                      </>
                    )}
                    {rep.offices.slice(0, 2).map((o, i) => (
                      <a
                        key={i}
                        href={telHref(o.phone!)}
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-ink/20 px-3 py-2.5 text-sm font-medium hover:border-ink/50"
                      >
                        <Phone className="h-3.5 w-3.5" aria-hidden />
                        {o.city} · {o.phone}
                      </a>
                    ))}
                  </div>

                  {/* Step 4 - outcome (one record per rep; re-tap changes it) */}
                  <div className="mt-3">
                    <p className="text-sm font-medium text-ink-soft">
                      {t('outcomeQ')}
                      {logged && <span className="ml-1 text-ink-faint">{t('outcomeChange')}</span>}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {OUTCOMES.map((o) => (
                        <button
                          key={o}
                          type="button"
                          onClick={() => logOutcome(rep, o)}
                          aria-pressed={logged === o}
                          className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 py-2.5 text-sm font-medium ${
                            logged === o
                              ? 'pop border-moss bg-moss-soft text-ink'
                              : 'border-ink/20 hover:bg-paper-deep'
                          }`}
                        >
                          {logged === o && <Check className="h-4 w-4 text-moss" aria-hidden />}
                          {t(`outcome.${o}`)}
                        </button>
                      ))}
                    </div>

                    {/* The payoff lands where the tap happened, not below the fold */}
                    {logged && (
                      <div className="mt-3 flex items-start gap-3 rounded-control bg-moss-soft px-4 py-3" role="status">
                        <svg
                          aria-hidden
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="draw-check mt-0.5 h-6 w-6 flex-none text-moss"
                        >
                          <circle cx="12" cy="12" r="9" />
                          <path d="m8.5 12.5 2.5 2.5 5-6" />
                        </svg>
                        <div>
                          <p className="font-medium">
                            {callCount === 1
                              ? t('loggedFirst')
                              : callCount === 5
                                ? t('loggedFifth')
                                : callCount === 10
                                  ? t('loggedTenth')
                                  : t('outcomeLogged')}{' '}
                            <Link href="/impact" className="underline underline-offset-2">
                              {t('viewImpact')}
                            </Link>
                          </p>
                          {/* PERSISTENT on-device reassurance: it must NOT vanish on
                              the 1st/5th/10th call, when a first-timer — the moment
                              the milestone fires — is most anxious about where the
                              position they just logged actually went. Kept as its own
                              always-rendered line, never folded into a milestone. */}
                          <p className="mt-1 text-sm text-ink-soft">{t('savedOnDevice')}</p>
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
    </section>
  );
}

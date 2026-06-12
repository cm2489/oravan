'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Copy, Ear, Expand, Moon, Phone, RotateCcw, Sparkles, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { upsertCall, useCalls, usePrefs } from '@/lib/local';
import type { CallOutcome, Legislator, Stance } from '@/lib/types';
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
  const zip = usePrefs().zip ?? null;
  const [copied, setCopied] = useState<string | null>(null);
  const [scriptCopied, setScriptCopied] = useState(false);
  const [bigType, setBigType] = useState(false);
  const [loggedOutcomes, setLoggedOutcomes] = useState<Record<string, CallOutcome>>({});
  const closeBigRef = useRef<HTMLButtonElement>(null);
  const callCount = useCalls().length;

  // The drafting wait gets product-specific rotating lines, not a frozen spinner.
  const [genLine, setGenLine] = useState<1 | 2 | 3>(1);
  useEffect(() => {
    if (!loading) return;
    setGenLine(1);
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

  // Big-type mode: Esc closes, focus moves to the close button.
  useEffect(() => {
    if (!bigType) return;
    closeBigRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setBigType(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bigType]);

  async function generate(s: Stance) {
    setStance(s);
    setError(null);
    if (drafts[s]) return; // a draft (possibly user-edited) already exists - restore, don't regenerate
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


  return (
    <section aria-labelledby="act" className="mt-12 rounded-card border-2 border-ink bg-white p-6 md:p-8 shadow-lift">
      <h2 id="act" className="font-display text-3xl font-bold">
        {t('actTitle')}
      </h2>
      <p className="mt-1 text-ink-soft">{t('actSub')}</p>

      {/* Step 1 - stance */}
      <fieldset className="mt-6">
        <legend className="font-semibold">{t('stanceQ')}</legend>
        <div className="mt-3 flex flex-wrap gap-2">
          {STANCES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => generate(s)}
              aria-pressed={stance === s}
              disabled={loading}
              className={`rounded-control border-2 px-4 py-3 font-semibold transition-transform disabled:opacity-50 active:translate-y-px ${
                stance === s
                  ? 'border-ink bg-ink text-paper'
                  : 'border-ink/20 bg-white hover:border-ink/50'
              }`}
            >
              {t(`stance.${s}`)}
            </button>
          ))}
        </div>
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
            <div className="shimmer h-full w-1/3 rounded-full bg-booth" />
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
              className="inline-flex items-center gap-1.5 rounded-control border border-ink/30 bg-white px-3 py-1.5 font-semibold hover:border-ink/60"
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
            <p className="rounded-full bg-booth-soft px-3 py-1 text-xs font-medium text-ink">
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
              type="button"
              onClick={() => setBigType(true)}
              className="inline-flex items-center gap-1.5 rounded-control border border-ink/20 px-3.5 py-2.5 text-sm font-medium hover:border-ink/50"
            >
              <Expand className="h-4 w-4" aria-hidden />
              {t('bigType')}
            </button>
          </div>
        </div>
      )}

      {/* Big-type "hold this up" reading mode */}
      {bigType && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('scriptTitle')}
          className="fixed inset-0 z-50 overflow-y-auto bg-paper p-6 md:p-12"
        >
          <button
            ref={closeBigRef}
            type="button"
            onClick={() => setBigType(false)}
            className="fixed top-4 right-4 inline-flex items-center gap-1.5 rounded-control bg-ink px-4 py-2.5 font-semibold text-paper"
          >
            <X className="h-4 w-4" aria-hidden />
            {t('closeBig')}
          </button>
          <p className="mx-auto mt-12 max-w-2xl whitespace-pre-wrap font-display text-2xl md:text-4xl font-semibold leading-snug md:leading-snug">
            {script}
          </p>
          {/* The number lives with the script so the call can start from here */}
          {reps.length > 0 && (
            <div className="mx-auto mt-10 flex max-w-2xl flex-wrap gap-2 pb-12">
              {reps.map(
                (rep) =>
                  rep.phone && (
                    <a
                      key={rep.bioguide}
                      href={telHref(rep.phone)}
                      className="inline-flex items-center gap-2 rounded-control bg-ink px-4 py-3 font-semibold text-paper transition-transform hover:bg-night active:translate-y-px"
                    >
                      <Phone className="h-4 w-4" aria-hidden />
                      {rep.last} · {rep.phone}
                    </a>
                  )
              )}
            </div>
          )}
        </div>
      )}

      {/* Step 3 - call */}
      {script && (
        <div className="mt-8">
          <h3 className="font-display text-xl font-bold">{t('callTitle')}</h3>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="flex gap-2 rounded-control bg-booth-soft p-4 text-sm">
              <Ear className="h-5 w-5 shrink-0 text-ink-soft" aria-hidden />
              <div>
                <p className="font-semibold">{t('hearFirstTitle')}</p>
                <p className="mt-0.5 text-ink-soft">{t('hearFirstBody')}</p>
              </div>
            </div>
            <div className="flex gap-2 rounded-control bg-booth-soft p-4 text-sm">
              <Moon className="h-5 w-5 shrink-0 text-ink-soft" aria-hidden />
              <div>
                <p className="font-semibold">{t('afterHoursTitle')}</p>
                <p className="mt-0.5 text-ink-soft">{t('afterHoursBody')}</p>
              </div>
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
                className="inline-flex items-center gap-1.5 rounded-control border border-ink/30 bg-white px-3 py-1.5 font-semibold hover:border-ink/60"
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
                          className="inline-flex items-center gap-1.5 rounded-control border border-ink/20 px-3 py-2.5 text-sm font-medium hover:border-ink/50"
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
                        className="inline-flex items-center gap-1.5 rounded-control border border-ink/20 px-3 py-2.5 text-sm font-medium hover:border-ink/50"
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
                          className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2.5 text-sm font-medium ${
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

'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pause, Play } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PhoneScene } from './PhoneScene';

/*
 * "How a call works" — a self-contained animated walkthrough of the product's
 * real flow (decode → stance → script → call → logged), told as a phone-frame
 * mock. First-party by construction: no video, no third-party requests, no
 * animation libraries — a handful of React timers and the CSS in
 * walkthrough.module.css.
 *
 * Accessibility contract:
 * - The phone visuals are decorative (aria-hidden). The story lives in the
 *   visible per-scene captions, which screen readers get too.
 * - Auto-advance pauses on hover AND on keyboard focus anywhere inside; a real
 *   play/pause button satisfies WCAG 2.2.2 regardless of pointer.
 * - The caption region is aria-live only while paused, so auto-advance never
 *   spams screen readers.
 * - prefers-reduced-motion: starts PAUSED, never auto-advances on its own
 *   (pressing play is an explicit request), and globals.css collapses all
 *   scene animation. Manual navigation via the labeled step dots always works.
 */

export const SCENES = ['decode', 'stance', 'script', 'call', 'logged'] as const;
export type SceneKey = (typeof SCENES)[number];

/** Per-scene hold (ms): long enough to read the caption, short enough to feel alive. */
const HOLD: Record<SceneKey, number> = {
  decode: 5600,
  stance: 5600,
  script: 6800,
  call: 6000,
  logged: 6400,
};

/* Live prefers-reduced-motion, SSR-safe: the server (and the no-JS case)
   assumes reduced — i.e. renders the paused state. */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
function subscribeReducedMotion(onChange: () => void) {
  const mq = window.matchMedia(REDUCED_MOTION_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
function useReducedMotion() {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => true
  );
}

export function CallWalkthrough() {
  const t = useTranslations('walkthrough');

  const [scene, setScene] = useState(0);
  // null = follow the motion preference (reduced ⇒ paused); pressing the
  // toggle is an explicit override either way.
  const [userPaused, setUserPaused] = useState<boolean | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const reducedMotion = useReducedMotion();

  const playing = userPaused === null ? !reducedMotion : !userPaused;
  const advancing = playing && !hovered && !focused;

  useEffect(() => {
    if (!advancing) return;
    const id = setTimeout(() => setScene((s) => (s + 1) % SCENES.length), HOLD[SCENES[scene]]);
    return () => clearTimeout(id);
  }, [advancing, scene]);

  const key = SCENES[scene];

  return (
    <div
      data-walkthrough
      role="group"
      aria-label={t('label')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
      className="flex flex-col items-center gap-8 md:flex-row md:gap-12"
    >
      {/* The phone is scenery; the captions beside it tell the real story.
          key={key} remounts the scene so its CSS choreography replays. */}
      <div aria-hidden className="w-56 flex-none select-none sm:w-60">
        <div className="rounded-[2.25rem] bg-night p-2 shadow-lift">
          <div className="relative aspect-[9/18] overflow-hidden rounded-[1.75rem] bg-paper">
            <span className="absolute left-1/2 top-2 z-10 h-1.5 w-14 -translate-x-1/2 rounded-full bg-ink/15" />
            <PhoneScene key={key} scene={key} />
          </div>
        </div>
      </div>

      <div className="min-w-0 max-w-prose">
        <div aria-live={advancing ? 'off' : 'polite'} aria-atomic="true">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            {t('stepOf', { step: scene + 1, total: SCENES.length })}
          </p>
          <h3 className="mt-1 font-display text-2xl font-bold">{t(`scenes.${key}.title`)}</h3>
          <p className="mt-2 leading-relaxed text-ink-soft">{t(`scenes.${key}.body`)}</p>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setUserPaused(playing)}
            aria-label={playing ? t('pause') : t('play')}
            className="inline-flex h-11 w-11 items-center justify-center rounded-control border border-ink/20 hover:border-ink/50"
          >
            {playing ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
          </button>
          <div className="flex items-center">
            {SCENES.map((s, i) => (
              <button
                key={s}
                type="button"
                onClick={() => setScene(i)}
                aria-label={t('stepDot', { step: i + 1, total: SCENES.length, title: t(`scenes.${s}.title`) })}
                aria-current={i === scene ? 'step' : undefined}
                className="group inline-flex h-11 w-11 items-center justify-center"
              >
                <span
                  className={`h-2.5 w-2.5 rounded-full transition-all ${
                    i === scene ? 'bg-booth ring-4 ring-booth-soft' : 'bg-line group-hover:bg-ink-faint'
                  }`}
                />
              </button>
            ))}
          </div>
        </div>

        <p className="mt-3 text-xs text-ink-faint">{t('sampleNote')}</p>
      </div>
    </div>
  );
}

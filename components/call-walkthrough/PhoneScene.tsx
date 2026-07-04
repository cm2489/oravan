import { Check, Phone, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import styles from './walkthrough.module.css';
import type { SceneKey } from './CallWalkthrough';

/*
 * The five phone-screen compositions. Purely decorative — the parent renders
 * them inside an aria-hidden frame, and the visible captions next to the phone
 * tell the same story. Every string still goes through messages/ (bilingual
 * parity applies to what sighted users read, too).
 *
 * Demo content is a real, deliberately innocuous bill: H.R. 1787, the
 * Roberto Clemente Commemorative Coin Act (119th) — commemorative, no cost to
 * taxpayers, no partisan valence. Its copy is frozen from data/bills.json +
 * data/bills-es.json into messages/ so the client never bundles the corpus.
 *
 * Choreography is stagger-by-CSS: elements share the .enter keyframe with
 * per-element animation delays, so a scene needs no timers of its own.
 */

const delay = (s: number) => ({ animationDelay: `${s}s` });

export function PhoneScene({ scene }: { scene: SceneKey }) {
  const t = useTranslations();

  if (scene === 'decode') {
    return (
      <Screen>
        <div className={`${styles.enter} rounded-lg border border-line bg-surface p-2.5 shadow-lift`} style={delay(0.1)}>
          <p className="flex items-center gap-1.5 text-[9px] font-semibold text-ink-faint">
            <span className="font-mono">{t('walkthrough.phone.billId')}</span>
            <span>·</span>
            <span className="uppercase tracking-wide">{t('bills.status.committee')}</span>
          </p>
          <p className="mt-1 font-display text-[11px] font-bold leading-snug">
            {t('walkthrough.phone.billHeadline')}
          </p>
          <p
            className={`${styles.enter} mt-1.5 inline-flex items-center gap-1 rounded-full bg-booth-soft px-1.5 py-0.5 text-[8px] font-semibold`}
            style={delay(0.6)}
          >
            <Sparkles className="h-2.5 w-2.5" />
            {t('walkthrough.phone.decodedChip')}
          </p>
          <p className={`${styles.enter} mt-1.5 text-[9px] leading-snug text-ink-soft`} style={delay(1)}>
            {t('walkthrough.phone.billTldr')}
          </p>
        </div>
      </Screen>
    );
  }

  if (scene === 'stance') {
    return (
      <Screen>
        <p className={`${styles.enter} text-[11px] font-bold`} style={delay(0.1)}>
          {t('bill.stanceQ')}
        </p>
        <div className="mt-2 flex flex-col gap-1.5">
          {/* The demo taps one option to show the flow — the caption says the choice is yours. */}
          <div
            className={`${styles.select} relative rounded-md border-2 border-ink/20 bg-surface px-2 py-1.5 text-[10px] font-semibold`}
            style={delay(2.4)}
          >
            {t('bill.stance.support')}
            <span className="absolute right-2 top-1/2 h-9 w-9 -translate-y-1/2">
              <span className={styles.tap} style={delay(1.2)} />
            </span>
          </div>
          <div
            className={`${styles.enter} rounded-md border-2 border-ink/20 bg-surface px-2 py-1.5 text-[10px] font-semibold`}
            style={delay(0.3)}
          >
            {t('bill.stance.oppose')}
          </div>
          <div
            className={`${styles.enter} rounded-md border-2 border-ink/20 bg-surface px-2 py-1.5 text-[10px] font-semibold`}
            style={delay(0.45)}
          >
            {t('bill.stance.undecided')}
          </div>
        </div>
      </Screen>
    );
  }

  if (scene === 'script') {
    return (
      <Screen>
        <div className={`${styles.enter} rounded-lg border border-line bg-surface p-2.5 shadow-lift`} style={delay(0.1)}>
          <p className="font-display text-[11px] font-bold">{t('bill.scriptTitle')}</p>
          {/* The label beat: the AI disclaimer draws the eye before anything gets read aloud. */}
          <span className={`${styles.beat} mt-1.5 inline-block rounded-full`} style={delay(2.2)}>
            <span
              className={`${styles.enter} inline-block rounded-full bg-booth-soft px-1.5 py-0.5 text-[8px] font-semibold`}
              style={delay(0.6)}
            >
              {t('bill.scriptDisclaimer')}
            </span>
          </span>
          <p className={`${styles.enter} mt-1.5 rounded-md bg-paper p-1.5 text-[9px] leading-relaxed`} style={delay(1)}>
            {t('walkthrough.phone.scriptSnippet')}
          </p>
        </div>
      </Screen>
    );
  }

  if (scene === 'call') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-night p-3 text-center text-paper">
        <p className={`${styles.enter} text-[11px] font-semibold`} style={delay(0.1)}>
          {t('walkthrough.phone.callee')}
        </p>
        <div className="grid justify-items-center text-[9px]">
          <span className={`${styles.fadeOut} col-start-1 row-start-1 text-paper/70`} style={delay(2.6)}>
            {t('walkthrough.phone.dialing')}
          </span>
          <span className={`${styles.fadeIn} col-start-1 row-start-1 font-medium text-booth-bright`} style={delay(2.6)}>
            {t('walkthrough.phone.connected')}
          </span>
        </div>
        <div className="relative mt-2 h-12 w-12">
          <span className={`${styles.pulse} flex h-12 w-12 items-center justify-center rounded-full bg-moss`}>
            <Phone className="h-5 w-5" />
          </span>
          <span className="absolute inset-0">
            <span className={styles.tap} style={delay(1)} />
          </span>
        </div>
        <p className={`${styles.fadeIn} font-mono text-[9px] text-paper/60`} style={delay(3.2)}>
          0:27
        </p>
      </div>
    );
  }

  // logged
  return (
    <Screen className="items-center justify-center gap-1.5 text-center">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="draw-check h-10 w-10 text-moss"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12.5 2.5 2.5 5-6" />
      </svg>
      <p className={`${styles.enter} font-display text-[12px] font-bold`} style={delay(0.3)}>
        {t('walkthrough.phone.loggedTitle')}
      </p>
      <p
        className={`${styles.enter} inline-flex items-center gap-1 rounded-full border border-moss bg-moss-soft px-2 py-0.5 text-[9px] font-medium`}
        style={delay(0.6)}
      >
        <Check className="h-2.5 w-2.5 text-moss" />
        {t('bill.outcome.contact')}
      </p>
      <p className={`${styles.enter} text-[8px] text-ink-faint`} style={delay(0.9)}>
        {t('walkthrough.phone.savedLocal')}
      </p>
    </Screen>
  );
}

/** Shared light-screen chrome: a whisper of app header, then the scene. */
function Screen({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const t = useTranslations();
  return (
    <div className="flex h-full flex-col p-3 pt-6">
      <p className="flex items-center gap-1 pb-2 text-[9px] font-bold text-ink-soft">
        <span className="h-1.5 w-1.5 rounded-full bg-booth" />
        {t('common.appName')}
      </p>
      <div className={`flex min-h-0 flex-1 flex-col ${className}`}>{children}</div>
    </div>
  );
}

import { Check, Phone, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { OravanWordmark } from '@/components/brand/OravanWordmark';
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
 *
 * COLOR: this is a miniature of the real product, so it obeys the same law.
 * `go` only on the dial. `tint` only on what the demo caller chose or was
 * handed. Ink for everything else, including the AI label.
 */

const delay = (s: number) => ({ animationDelay: `${s}s` });

/** The AI mark, at phone-mock scale: ink outline, 3px cap, never amber. */
const MINI_CHIP =
  'inline-flex items-center gap-1 rounded-stamp border border-ink px-1.5 py-0.5 text-[8px] font-bold text-ink';

export function PhoneScene({ scene }: { scene: SceneKey }) {
  const t = useTranslations();

  if (scene === 'decode') {
    return (
      <Screen>
        <div
          className={`${styles.enter} rounded-control border-[1.5px] border-line-strong bg-paper p-2.5`}
          style={delay(0.1)}
        >
          <p className="flex items-center gap-1.5 text-[9px] font-bold text-ink-2">
            <span className="tabular-nums">{t('walkthrough.phone.billId')}</span>
            <span>·</span>
            <span className="tracking-[0.06em] uppercase">{t('bills.status.committee')}</span>
          </p>
          <p className="mt-1 text-[11px] font-bold text-ink leading-tight">
            {t('walkthrough.phone.billHeadline')}
          </p>
          <p className={`${styles.enter} mt-1.5 ${MINI_CHIP}`} style={delay(0.6)}>
            <Sparkles className="h-2.5 w-2.5" />
            {t('walkthrough.phone.decodedChip')}
          </p>
          {/* The decoded words take the reading voice, here as everywhere. */}
          <p
            className={`${styles.enter} mt-1.5 font-reading text-[9px] text-ink-2 leading-tight`}
            style={delay(1)}
          >
            {t('walkthrough.phone.billTldr')}
          </p>
        </div>
      </Screen>
    );
  }

  if (scene === 'stance') {
    return (
      <Screen>
        <p className={`${styles.enter} text-[11px] font-bold text-ink`} style={delay(0.1)}>
          {t('bill.stanceQ')}
        </p>
        <div className="mt-2 flex flex-col gap-1.5">
          {/* The demo taps one option to show the flow — the caption says the choice is yours. */}
          <div
            className={`${styles.select} relative rounded-control border-2 border-line-strong bg-paper px-2 py-1.5 text-[10px] font-bold text-ink`}
            style={delay(2.4)}
          >
            {t('bill.stance.support')}
            <span className="absolute top-1/2 right-2 h-9 w-9 -translate-y-1/2">
              <span className={styles.tap} style={delay(1.2)} />
            </span>
          </div>
          <div
            className={`${styles.enter} rounded-control border-2 border-line-strong bg-paper px-2 py-1.5 text-[10px] font-bold text-ink`}
            style={delay(0.3)}
          >
            {t('bill.stance.oppose')}
          </div>
          <div
            className={`${styles.enter} rounded-control border-2 border-line-strong bg-paper px-2 py-1.5 text-[10px] font-bold text-ink`}
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
        <div
          className={`${styles.enter} rounded-control border-[1.5px] border-line-strong bg-paper p-2.5`}
          style={delay(0.1)}
        >
          <p className="text-[11px] font-bold text-ink">{t('bill.scriptTitle')}</p>
          {/* The label beat: the AI disclaimer draws the eye before anything gets read aloud. */}
          <span className={`${styles.beat} mt-1.5 inline-block`} style={delay(2.2)}>
            <span className={`${styles.enter} ${MINI_CHIP}`} style={delay(0.6)}>
              {t('bill.scriptDisclaimer')}
            </span>
          </span>
          {/* Yours to read from: `tint`, in the reading voice. */}
          <p
            className={`${styles.enter} mt-1.5 rounded-stamp bg-tint p-1.5 font-reading text-[9px] text-ink`}
            style={delay(1)}
          >
            {t('walkthrough.phone.scriptSnippet')}
          </p>
        </div>
      </Screen>
    );
  }

  if (scene === 'call') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-ink-deep p-3 text-center text-paper">
        <p className={`${styles.enter} text-[11px] font-bold`} style={delay(0.1)}>
          {t('walkthrough.phone.callee')}
        </p>
        <div className="grid justify-items-center text-[9px]">
          <span className={`${styles.fadeOut} col-start-1 row-start-1 text-ink-pale`} style={delay(2.6)}>
            {t('walkthrough.phone.dialing')}
          </span>
          <span
            className={`${styles.fadeIn} col-start-1 row-start-1 font-semibold text-go-bright`}
            style={delay(2.6)}
          >
            {t('walkthrough.phone.connected')}
          </span>
        </div>
        <div className="relative mt-2 h-12 w-12">
          <span
            className={`${styles.pulse} flex h-12 w-12 items-center justify-center rounded-control bg-go`}
          >
            <Phone className="h-5 w-5" />
          </span>
          <span className="absolute inset-0">
            <span className={styles.tap} style={delay(1)} />
          </span>
        </div>
        <p className={`${styles.fadeIn} text-[9px] text-ink-pale tabular-nums`} style={delay(3.2)}>
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
        className="draw-check h-10 w-10 text-ink"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12.5 2.5 2.5 5-6" />
      </svg>
      <p className={`${styles.enter} text-[12px] font-bold text-ink`} style={delay(0.3)}>
        {t('walkthrough.phone.loggedTitle')}
      </p>
      {/* The logged outcome is the caller's own record: `tint`, ink text. */}
      <p
        className={`${styles.enter} inline-flex items-center gap-1 rounded-stamp border border-ink bg-tint px-2 py-0.5 text-[9px] font-semibold text-ink`}
        style={delay(0.6)}
      >
        <Check className="h-2.5 w-2.5" />
        {t('bill.outcome.voicemail')}
      </p>
      <p className={`${styles.enter} text-[8px] text-ink-2`} style={delay(0.9)}>
        {t('walkthrough.phone.savedLocal')}
      </p>
    </Screen>
  );
}

/** Shared light-screen chrome: a whisper of app header, then the scene. */
function Screen({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="flex h-full flex-col p-3 pt-6">
      <p className="flex items-center gap-1 pb-2 text-ink-2">
        {/* Ink, not go: `go` means GO, and a wordmark bullet is not going anywhere. */}
        <span className="h-1.5 w-1.5 rounded-stamp bg-ink" />
        <OravanWordmark className="h-2.5 w-auto" />
      </p>
      <div className={`flex min-h-0 flex-1 flex-col ${className}`}>{children}</div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * A floating "Make the call" button that keeps the primary action reachable
 * anywhere on a long bill page — but stands down whenever another call CTA (the
 * inline prompt, or the action panel) is on screen, so two identical buttons are
 * never visible at once. It defers to every element marked [data-call-cta].
 *
 * While hidden it's inert: not clickable and out of the tab order. The fade is
 * neutralized under prefers-reduced-motion by the global rule in globals.css.
 *
 * RESTING STATE IS HIDDEN, and that is load-bearing. Server-side there is no
 * viewport to measure, so the honest initial answer is "a CTA may already be
 * on screen" — the observer settles it on the first frame after mount. The
 * alternative (start shown) makes the button paint at full size and then fade
 * out 300ms later on every page where a CTA IS on screen at the top, which on
 * the desk layout is every desktop bill page: the sticky call rail sits in the
 * first row. Deferring costs a fade-in where the button is genuinely wanted;
 * the other way round costs a green flash where it is not.
 */
export function FloatingCallButton({ href = '#act' }: { href?: string }) {
  const t = useTranslations('bill');
  const label = t('actTitle');
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    const targets = Array.from(document.querySelectorAll('[data-call-cta]'));
    // Nothing to defer to: reveal, rather than staying inert forever. (With
    // the resting state shown this branch could be a bare return.)
    if (targets.length === 0) {
      setHidden(false);
      return;
    }
    const onScreen = new Set<Element>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) onScreen.add(e.target);
        else onScreen.delete(e.target);
      }
      setHidden(onScreen.size > 0);
    });
    targets.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <a
      href={href}
      data-floating-call
      aria-label={label}
      aria-hidden={hidden}
      tabIndex={hidden ? -1 : 0}
      className={`ring-gap fixed right-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-go bg-go px-5 py-4 font-bold text-paper no-underline transition-all duration-300 hover:border-go-deep hover:bg-go-deep md:bottom-6 ${
        hidden ? 'pointer-events-none translate-y-3 opacity-0' : 'opacity-100'
      }`}
    >
      {/* Label at every width (2026-07 critique, unanimous): an icon-only
          circle is ambiguous for exactly the nervous first-timer the
          product serves — readable as "support line" or "dials immediately".

          Shape law: this is a button-scale control, so it is rounded-control
          (8px), never a pill. Elevation law: the system has no shadow — the
          2px `go` edge (6.43:1 on paper) is what lifts it off the page. */}
      <Phone className="h-5 w-5 flex-none" aria-hidden />
      <span>{label}</span>
    </a>
  );
}

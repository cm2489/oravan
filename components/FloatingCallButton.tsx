'use client';

import { useEffect, useRef, useState } from 'react';
import { Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * The same query Tailwind's `min-[62rem]:` utilities compile to: the width at
 * which the bill page becomes two columns (DESIGN.md structural constraint 1).
 */
const DESK = '(min-width: 62rem)';

/**
 * HOLD ZONES: while any part of one of these is on screen above the button's
 * own bottom edge, the button stays down. Each is a place a floating button
 * must never be drawn over:
 *
 *   [data-call-hold]  the bill's title block. The button waits until the
 *                     reader has scrolled past it, so it never sits over the
 *                     first screen's own words (B1-2, 2026-09-25: at 390x844 it
 *                     covered "55-second read · 5 questions answered below" on
 *                     hr-5634 and the chamber's quote on s-4668 at scroll 0).
 *   .on-go            the green enamel panel. It carries its own call (its
 *                     headline and its white CTA both link to the rail), so a
 *                     second green button over it is two calls at once, and a
 *                     green edge on go-deep is 1.52:1.
 *   main ~ footer     the site footer. At the page foot the button used to
 *                     park over the footer's last lines for good, because
 *                     nothing scrolls further.
 */
const HOLD = '[data-call-hold], .on-go, main ~ footer';

/**
 * A floating "Make the call" button that keeps the primary action reachable
 * through a long bill page ON A PHONE — but stands down whenever another call
 * CTA (the inline prompt, or the action panel) is on screen, so two identical
 * buttons are never visible at once. It defers to every element marked
 * [data-call-cta] once that element has risen into the visible screen above the
 * button, and to every hold zone above the moment any of it is on screen.
 *
 * PHONE LAYOUT ONLY (B1-2, 2026-09-25). At 62rem and up the page is two
 * columns and the sticky rail beside the reading column is the call; the
 * button there only ever doubled a call already on screen (measured at
 * 1440x900 on s-4668: over the green panel at scroll 0 and 180, beside the
 * panel's own white CTA). It is `display:none` there, and its state says
 * hidden too, so a test reading aria-hidden and a reader see the same thing.
 *
 * While hidden it's inert: not clickable and out of the tab order. The fade is
 * neutralized under prefers-reduced-motion by the global rule in globals.css.
 *
 * RESTING STATE IS HIDDEN, and that is load-bearing. Server-side there is no
 * viewport to measure, so the honest initial answer is "a CTA may already be
 * on screen" — the observers settle it on the first frame after mount. The
 * alternative (start shown) makes the button paint at full size and then fade
 * out 300ms later on every page where it must not show at the top, which is
 * now every bill page: the title block is always on screen at scroll 0.
 */
export function FloatingCallButton({ href = '#act' }: { href?: string }) {
  const t = useTranslations('bill');
  const label = t('actTitle');
  const [hidden, setHidden] = useState(true);
  const ref = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const fab = ref.current;
    if (!fab) return;
    const desk = window.matchMedia(DESK);
    const targets = Array.from(document.querySelectorAll('[data-call-cta]'));
    const holds = Array.from(document.querySelectorAll(HOLD));
    const ctaOnScreen = new Set<Element>();
    const holdOnScreen = new Set<Element>();

    // Every path answers "should the button be down?" from a CALLBACK — an
    // observer entry, a media-query change, or the next frame — never
    // synchronously in the effect body (`react-hooks/set-state-in-effect`: a
    // bare setHidden() here is a cascading render).
    const settle = () => setHidden(desk.matches || ctaOnScreen.size > 0 || holdOnScreen.size > 0);

    /*
     * "ON SCREEN" FOR A CTA MEANS THE PART OF THE SCREEN A READER CAN SEE (B2,
     * 2026-09-24). The observer used to watch the whole viewport, so the call
     * panel counted as on screen the moment its top edge slid in UNDER the
     * fixed bottom nav and under this button — where nobody could see or
     * reach it. Measured on webkit-mobile at 390x844: the button stood down
     * with no call surface visible at all, and on a short decode that dead
     * window opened while the reader was still in the decoded answers.
     *
     * So the root is shrunk by the strip this button itself stands in: its
     * own resolved `bottom` offset (which already clears the nav and the
     * safe-area inset), plus its height, plus an 8px gap. It yields only once
     * a call surface has risen ABOVE its top edge — and by the same
     * arithmetic, while it is showing, any panel below sits inside that strip,
     * where only the panel's title bar fits (the first control is well below
     * it; tests/bill-call-rail.spec.ts sweeps for overlap). Recomputed on
     * resize, because the offset changes at `md`.
     *
     * HOLD ZONES read the screen from its top down to the button's own
     * BOTTOM edge: a zone holds the moment any of it reaches the button or
     * rises above it, and not while it is still tucked under the thumb bar
     * below. For the footer that places the hand-off over the page's blank
     * foot — the bill page's own `pb-16` (64px) is taller than the button
     * (62px), which is the spacer that keeps the last line of content from
     * ever sitting under it (tests/bill-call-rail.spec.ts checks the foot).
     */
    let io: IntersectionObserver | null = null;
    let holdIo: IntersectionObserver | null = null;
    const observe = () => {
      io?.disconnect();
      holdIo?.disconnect();
      ctaOnScreen.clear();
      holdOnScreen.clear();
      const offset = parseFloat(getComputedStyle(fab).bottom) || 0;
      const strip = Math.ceil(offset + fab.offsetHeight + 8);
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) ctaOnScreen.add(e.target);
            else ctaOnScreen.delete(e.target);
          }
          settle();
        },
        { rootMargin: `0px 0px -${strip}px 0px` }
      );
      targets.forEach((el) => io?.observe(el));
      holdIo = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) holdOnScreen.add(e.target);
            else holdOnScreen.delete(e.target);
          }
          settle();
        },
        { rootMargin: `0px 0px -${Math.floor(offset)}px 0px` }
      );
      holds.forEach((el) => holdIo?.observe(el));
    };
    observe();

    // Nothing observed at all: no observer will ever call back, so settle on
    // the next frame rather than staying inert forever.
    const frame =
      targets.length === 0 && holds.length === 0 ? requestAnimationFrame(settle) : 0;

    window.addEventListener('resize', observe);
    desk.addEventListener('change', settle);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', observe);
      desk.removeEventListener('change', settle);
      io?.disconnect();
      holdIo?.disconnect();
    };
  }, []);

  return (
    <a
      ref={ref}
      href={href}
      data-floating-call
      aria-label={label}
      aria-hidden={hidden}
      tabIndex={hidden ? -1 : 0}
      className={`ring-gap fixed right-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-paper bg-go px-5 py-4 font-bold text-paper no-underline transition-all duration-300 hover:bg-go-deep md:bottom-6 min-[62rem]:hidden ${
        hidden ? 'pointer-events-none translate-y-3 opacity-0' : 'opacity-100'
      }`}
    >
      {/* Label at every width (2026-07 critique, unanimous): an icon-only
          circle is ambiguous for exactly the nervous first-timer the
          product serves — readable as "support line" or "dials immediately".

          Shape law: this is a button-scale control, so it is rounded-control
          (8px), never a pill. Elevation law: the system has no shadow — the
          `go` fill against the page (6.43:1 on paper) is what lifts it.

          THE EDGE IS PAPER (B1-2, 2026-09-25), on every ground. It used to be
          `go`, which is 6.43:1 on paper but 1.52:1 on the go-deep panel — a
          1.4.11 fail wherever the button crossed the band. A paper edge is
          invisible on paper (the fill does the work there, at the same
          6.43:1), 9.75:1 on go-deep and 17.66:1 on ink, and it is already the
          exact border `ring-gap` swaps in on focus, so resting and focused
          states now share one stack. */}
      <Phone className="h-5 w-5 flex-none" aria-hidden />
      <span>{label}</span>
    </a>
  );
}

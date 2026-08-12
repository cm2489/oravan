'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { glossaryHref, type GlossaryTermId } from '@/lib/glossary';

/*
 * THE IN-PLACE GLOSSARY TERM (issue #181, owner ruling "do both": a /glossary
 * page AND an explainer on the term where it is used).
 *
 * It wraps a procedural term wherever that term is already written into a
 * hand-authored UI string. The explainer is ONE string per term per language
 * (`glossary.terms.<id>.body`) — this box and the page read the same key, so
 * the short version can never drift from the long one, because there is no
 * short version.
 *
 * ── A LINK WITH A HOVERCARD, NOT A DISCLOSURE BUTTON ───────────────────────
 *
 * REDESIGNED 2026-08-12 on the owner's review of PR #217, in his words: "I'd
 * like a box to pop up when a user hovers over a term instead of having it
 * redirect them to the glossary section. They can still click in if they want
 * to but a hover text would be better so it's not as distracting."
 *
 * It shipped first as a click-to-open <button> disclosure, and that read as a
 * demand: every glossed term in a sentence was a control the reader had to
 * decide about. So the term is now a plain LINK to its own glossary entry —
 * clicking or tapping simply goes there, which is what a reader who wants the
 * whole thing expects — and the explainer arrives on hover without being
 * asked for.
 *
 * THREE WAYS IN, AND ONE OF THEM IS DELIBERATELY MISSING:
 *
 *   POINTER — a mouse hover opens the box after HOVER_OPEN_MS. The delay is
 *     the whole point of the redesign: a sentence with two glossed terms in it
 *     must not strobe boxes at someone whose pointer is only passing through.
 *   KEYBOARD — focus opens it immediately, with no delay, because focus is
 *     deliberate. A keyboard user must never be the one who loses the
 *     explainer; that is the failure mode that makes hover UI inaccessible.
 *   TOUCH — nothing. A touch device HAS no hover, and the industry workaround
 *     (first tap opens, second tap follows) breaks the one interaction a
 *     phone user already understands. Tapping the term navigates to the full
 *     entry, which is strictly more than the box would have given them. The
 *     pointer handlers below gate on `pointerType === 'mouse'` so a synthetic
 *     touch-generated pointerenter can never open a box the finger is
 *     covering anyway.
 *
 * ── WCAG 1.4.13 (Content on Hover or Focus), clause by clause ──────────────
 *
 *   DISMISSIBLE — Escape closes it and does NOT move the pointer or the
 *     focus. It also latches: `suppressedRef` keeps it shut while the pointer
 *     stays put, so it cannot spring straight back under a stationary cursor.
 *     The latch clears the moment the pointer leaves or focus moves on.
 *   HOVERABLE — the pointer can travel into the box. The box is a DOM
 *     descendant of the same wrapper the handlers sit on, and crossing the
 *     PANEL_GAP between term and box is covered by HOVER_CLOSE_MS, so the
 *     journey never closes what it is heading for.
 *   PERSISTENT — it stays until the pointer leaves, focus moves, or Escape.
 *     Nothing times it out.
 *
 * ARIA: `aria-describedby` while open, and nothing else. This is a link with a
 * description, not a disclosure — `aria-expanded` would be a lie about what
 * activating it does (it navigates). The box carries `role="tooltip"`, and it
 * holds NO interactive content, which is what makes a description the honest
 * wiring: see the "Full glossary" note below.
 *
 * NO `aria-label`, and no visually-hidden "— what this means" suffix. The
 * first breaks WCAG 2.5.3 (the visible term must be IN the accessible name);
 * the second injects "cloture — plain words explainer" into the middle of a
 * read-aloud sentence at every occurrence.
 *
 * ── THE BOX HOLDS NO LINK, ON PURPOSE ──────────────────────────────────────
 *
 * The first build put a "Full glossary →" link at the foot of the panel. With
 * the term itself now linking to the same anchor that is two links to one
 * place, in a box whose reason for existing is to be less distracting. Dropping
 * it also makes the ARIA honest: content reachable only by pointer travel is a
 * trap for anyone who cannot travel, and a box with nothing to operate is a
 * description in the plain sense of the word. `glossary.fullGlossary` was
 * retired from both message catalogs in the same change.
 *
 * ── SHAPE, COLOUR, MOTION (DESIGN.md) ──────────────────────────────────────
 *
 * INK ONLY. Not amber: `urgent` is spent on ONE dated floor fact with the date
 * printed beside it, and a glossary entry is by construction dateless. Not
 * `go` either, and that is the one place this departs from the letter of the
 * colour law now that the trigger is a real link — see the PR body. The
 * precedent it follows is already shipped: `moments.partOf` and the nomination
 * page's parent-moment links are real Links drawn in ink with an underline,
 * because an annotation on a word is not the page's action. Green on every
 * glossed term would also be the opposite of "less distracting".
 *
 * SHAPE: the box is hand-sized, so `rounded-control` (8px). The term is a run
 * of text with no ground and no border, so it takes NO radius at all. No third
 * radius is introduced, and `rounded-hair` stays where it belongs (the focus
 * indicator, from globals.css, unchanged).
 *
 * MOTION: the box does not animate in, at all. DESIGN.md's motion law allows
 * background/border/colour/text-decoration to ease at 150ms and says nothing
 * else moves, so there is no entrance transition to suppress and
 * `prefers-reduced-motion` needs no separate path — content is readable at 0ms
 * in both modes, the strictest reading of the motion contract's clauses 1 and
 * 4. HOVER_OPEN_MS is an intent filter, not an animation: it decides WHETHER
 * to show the box, and reduced-motion has nothing to say about that.
 *
 * TOUCH TARGET: the term is deliberately NOT inflated to 44px. It is a link
 * sitting inline inside a sentence, which is DESIGN.md's stated exemption
 * ("inflating it breaks the line") and WCAG 2.5.8's own Inline exception.
 */

/** Kept clear of either viewport edge when the box is nudged back on screen. */
const EDGE_GUTTER = 16;
/** Between the term and the box below it. */
const PANEL_GAP = 8;
/** Pointer dwell before the box opens — an intent filter, so a sentence with
 *  two glossed terms does not strobe at a passing cursor. */
const HOVER_OPEN_MS = 200;
/** Grace after the pointer leaves, so travelling the PANEL_GAP into the box
 *  never closes the thing being travelled to (WCAG 1.4.13, Hoverable). */
const HOVER_CLOSE_MS = 150;

export function GlossaryTerm({ id, children }: { id: GlossaryTermId; children?: ReactNode }) {
  const t = useTranslations('glossary');
  const [open, setOpen] = useState(false);
  /*
   * THE BOX IS VIEWPORT-POSITIONED, AND MEASURED — not `absolute` under the
   * term, which is what it was first built as and what did not work.
   *
   * An absolutely-positioned box inherits its column's left edge, so near the
   * right of a narrow screen it hangs off; clamping it back needs JS either
   * way, because CSS cannot measure the viewport from inside an inline flow.
   * But the clamp is not enough: measured in WebKit at 320px, the box added
   * 95px to `documentElement.scrollWidth` EVEN WHEN its own rect sat fully
   * inside the viewport (16 → 304 of 320), because an out-of-flow box still
   * contributes to its ancestor's scrollable overflow. That is a horizontal
   * scrollbar on a page whose suite asserts there is none, and WCAG 1.4.10 is
   * specified at exactly that width.
   *
   * `position: fixed` takes it out of the document's scroll overflow
   * altogether. The cost is that it no longer travels with the page, so the
   * effect below re-places it on scroll and resize.
   */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const reactId = useId();
  const panelId = `glossary-${id}-${reactId}`;
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLAnchorElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set by Escape. Keeps the box shut while the pointer or the focus has not
   *  moved, so a dismissal under a stationary cursor actually sticks. */
  const suppressedRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  /* One writer for both pieces of state. Closing forgets the measured position
     too, so a reopen is placed against the term's CURRENT coordinates rather
     than flashing at wherever it stood last time. */
  const setOpenState = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setPos(null);
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // WCAG 1.4.13, Dismissible: Escape closes it without the pointer or the
  // focus having to move, and the latch keeps it closed until one of them
  // does. Bound only while open, so it never eats an Escape meant for
  // something else.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // An Escape aimed at this box must not also close a dialog further up.
      e.stopPropagation();
      clearTimers();
      suppressedRef.current = true;
      setOpenState(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, clearTimers, setOpenState]);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const rect = trigger.getBoundingClientRect();
      const doc = document.documentElement;
      // Measured while the box is still `visibility: hidden` — it is laid out,
      // just not painted, so both dimensions are already real.
      const { offsetWidth: width, offsetHeight: height } = panel;

      // Left-aligned to the term, then pulled back inside whichever edge it
      // would have crossed. `Math.max` last so a box wider than the viewport
      // still starts at the gutter rather than off the left.
      const left = Math.max(
        EDGE_GUTTER,
        Math.min(rect.left, doc.clientWidth - width - EDGE_GUTTER)
      );

      /* FLIPS ABOVE THE TERM when there is no room under it. On a phone the
         thumb bar owns the bottom of the screen and sits above this box (z-40
         vs z-30, deliberately — a permanent navigation bar must not be
         covered), so a box opened low would be half unreadable. It only flips
         when the space above genuinely fits it; otherwise it stays below and
         the page scrolls, which is still better than a box clipped at the
         top. */
      const below = rect.bottom + PANEL_GAP;
      const above = rect.top - PANEL_GAP - height;
      const fitsBelow = below + height + EDGE_GUTTER <= doc.clientHeight;
      setPos({ top: !fitsBelow && above >= EDGE_GUTTER ? above : below, left });
    };
    place();
    // Viewport-positioned, so it has to follow its own term when the page
    // moves under it. Capture phase catches scrolls inside any scrolling
    // ancestor, not just the document.
    window.addEventListener('scroll', place, { capture: true, passive: true });
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, { capture: true });
      window.removeEventListener('resize', place);
    };
  }, [open]);

  /* MOUSE ONLY. A touch generates a synthetic pointerenter, and honouring it
     would open a box under the finger that just asked to navigate. */
  const onPointerEnter = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (suppressedRef.current || open) return;
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => setOpenState(true), HOVER_OPEN_MS);
  };

  const onPointerLeave = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    // The pointer moved: an earlier Escape has served its purpose.
    suppressedRef.current = false;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpenState(false), HOVER_CLOSE_MS);
  };

  /* Keyboard arrival opens it immediately — no delay, because focus is
     deliberate. `:focus-visible` so a mouse click on the term (which is
     navigating away) does not flash a box on its way out. React's onFocus
     bubbles, so this also covers focus landing anywhere inside the box. */
  const onFocus = () => {
    if (suppressedRef.current) return;
    if (!triggerRef.current?.matches(':focus-visible')) return;
    clearTimers();
    setOpenState(true);
  };

  const onBlur = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && wrapRef.current?.contains(next)) return;
    suppressedRef.current = false;
    clearTimers();
    setOpenState(false);
  };

  return (
    /* `inline-block` rather than `inline`: an inline box that wraps across two
       lines fragments its containing block, and the measured geometry then
       reads the wrong fragment. `max-w-full` keeps the atomic box inside its
       column at 320px.

       The handlers sit on the WRAPPER, not the term, because the box is a DOM
       descendant of it — that is what lets the pointer travel into the box
       without pointerleave firing (WCAG 1.4.13, Hoverable). */
    <span
      ref={wrapRef}
      className="relative inline-block max-w-full"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <Link
        ref={triggerRef}
        href={glossaryHref(id)}
        aria-describedby={open ? panelId : undefined}
        /* No weight change: bolding every glossed term would speckle the
           sentence. The dotted rule carries the affordance, and `text-ink`
           against the `text-ink-2` prose around it is the second, non-colour
           signal. `decoration-ink-2` is 7.87:1 on paper — far over 1.4.11's
           3:1 for the thing that makes a control findable. */
        className="text-ink underline decoration-ink-2 decoration-dotted underline-offset-4 hover:decoration-ink"
      >
        {children ?? t(`terms.${id}.term`)}
      </Link>

      {open && (
        <span
          ref={panelRef}
          id={panelId}
          role="tooltip"
          /* Hidden for exactly one frame, until the effect above has measured
             where it goes — never painted at the wrong place first. */
          style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
          /* A <span> with `block`, not a <div>: these render inside <p> and
             <li> elements, and a block-level child of a <p> closes the
             paragraph in the parser and desynchronises hydration.
             `normal-case` / `tracking-normal` / `whitespace-normal` reset the
             uppercase tracked chrome this can be used inside (the nomination
             page's provenance line, a Big Question's card meta) — the box is
             prose wherever it opens. */
          /* The width's underscores are load-bearing: a Tailwind arbitrary
             value renders spaces from `_`, and CSS `calc()` REQUIRES
             whitespace around its minus. Written `calc(100vw-2rem)` the whole
             declaration is invalid, silently dropped, and the box sizes to its
             content. */
          className="fixed z-30 block w-[min(var(--measure-note),calc(100vw_-_2rem))] rounded-control border-2 border-ink bg-paper p-4 text-left text-sm font-normal tracking-normal whitespace-normal text-ink normal-case"
        >
          <span className="block text-2xs leading-tight font-extrabold tracking-[0.1em] text-ink-2 uppercase">
            {t(`terms.${id}.term`)}
          </span>
          <span className="mt-2 block">{t(`terms.${id}.body`)}</span>
        </span>
      )}
    </span>
  );
}

/*
 * The `glossaryTag` rich-text helper deliberately does NOT live in this file.
 * Everything exported from a 'use client' module is a client reference, so a
 * server component calling it gets "Attempted to call glossaryTag() from the
 * server" at render time rather than a build error. It lives in
 * components/glossary-tags.tsx, which has no directive and can therefore be
 * called on the server — RENDERING a client component from a server component
 * is fine, CALLING a client export is not.
 */

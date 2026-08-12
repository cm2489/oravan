'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { glossaryHref, type GlossaryTermId } from '@/lib/glossary';

/*
 * THE IN-PLACE GLOSSARY TRIGGER (issue #181, owner ruling "do both": a
 * /glossary page AND a popover on the term where it is used).
 *
 * It wraps a procedural term wherever that term is already written into a
 * hand-authored UI string, and opens a small panel carrying the same plain-
 * words explainer the page prints, plus a link to that term's section. The
 * explainer is ONE string per term per language (`glossary.terms.<id>.body`) —
 * the popover and the page read the same key, so the short version can never
 * drift from the long one, because there is no short version.
 *
 * ── WHY IT IS A DISCLOSURE BUTTON AND NOT A TOOLTIP ────────────────────────
 *
 * The issue's own a11y constraint: "if tooltips, they must be keyboard-
 * reachable and screen-reader-sane; a plain linked page has none of those
 * risks." A hover tooltip has all of them — no keyboard path, no touch path,
 * and it carries a LINK, which a tooltip may never do (a user cannot move a
 * pointer into something that disappears on mouseout).
 *
 * So this is the ordinary disclosure pattern instead: a real <button> whose
 * accessible name is the term, `aria-expanded` for its state, and the panel
 * rendered as a sibling in reading order — a screen reader meets the
 * explainer in the DOM right where the sentence used it, whether or not the
 * button was ever pressed. `aria-describedby` points at the panel WHILE OPEN
 * ONLY: pointing at an element that is not rendered is a dangling reference,
 * and the disclosure state is what makes the description true.
 *
 * NO `aria-label`, and no visually-hidden "— what this means" suffix. Both
 * were tried on paper and both lose: the first breaks WCAG 2.5.3 (the visible
 * term must be IN the accessible name), and the second injects "cloture — plain
 * words explainer" into the middle of a read-aloud sentence at every
 * occurrence. "cloture, button, collapsed" is what the disclosure pattern is
 * supposed to say, and it is enough.
 *
 * ── DISMISSAL ──────────────────────────────────────────────────────────────
 *
 * Escape closes AND returns focus to the trigger (a keyboard user must never
 * be dropped at the top of the document). A pointer press or a focus move
 * anywhere outside the wrapper closes WITHOUT stealing focus — closing is not
 * a reason to yank a caret out of wherever the user just went.
 *
 * ── SHAPE, COLOUR, MOTION (DESIGN.md) ──────────────────────────────────────
 *
 * INK ONLY. Not amber: `urgent` is spent on ONE dated floor fact with the date
 * printed beside it, and a glossary entry is by construction dateless — it is
 * static mechanics, not a claim about any bill. Not `go` either: green is
 * spent on actions and content links, and the trigger is an annotation on a
 * word, not somewhere to go. The panel's own link is ink-underlined for the
 * same reason the "Part of a bigger question" links are.
 *
 * SHAPE: the panel is hand-sized, so `rounded-control` (8px). The trigger is a
 * run of text with no ground and no border, so it takes NO radius at all. No
 * third radius is introduced, and `rounded-hair` stays where it belongs (the
 * focus indicator, which comes from globals.css, unchanged).
 *
 * MOTION: the panel does not animate in, at all. DESIGN.md's motion law allows
 * background/border/colour/text-decoration to ease at 150ms and says nothing
 * else moves, so there is no entrance transition to suppress and
 * `prefers-reduced-motion` needs no separate path here — content is readable
 * at 0ms in both modes, which is the strictest reading of the motion
 * contract's clauses 1 and 4. The trigger's underline colour is the one thing
 * that eases, and globals.css already collapses that under reduced motion.
 *
 * TOUCH TARGET: the trigger is deliberately NOT inflated to 44px. It is a
 * control sitting inline inside a sentence, which is DESIGN.md's stated
 * exemption ("inflating it breaks the line") and WCAG 2.5.8's own Inline
 * exception. Inflating it would either break the line box or overlap the
 * neighbouring lines' targets, which is worse for touch, not better. The
 * panel's link is NOT inline in a sentence and does take `min-h-11`.
 */

/** Kept clear of either viewport edge when the panel is nudged back on screen. */
const EDGE_GUTTER = 16;
/** Between the term and the panel below it. */
const PANEL_GAP = 8;

export function GlossaryTerm({ id, children }: { id: GlossaryTermId; children?: ReactNode }) {
  const t = useTranslations('glossary');
  const [open, setOpen] = useState(false);
  /*
   * THE PANEL IS VIEWPORT-POSITIONED, AND MEASURED — not `absolute` under the
   * trigger, which is what it was first built as and what did not work.
   *
   * An absolutely-positioned panel inherits its column's left edge, so near
   * the right of a narrow screen it hangs off; clamping it back needs JS
   * either way, because CSS cannot measure the viewport from inside an inline
   * flow. But the clamp is not enough: measured in WebKit at 320px, the panel
   * added 95px to `documentElement.scrollWidth` EVEN WHEN its own rect sat
   * fully inside the viewport (16 → 304 of 320), because an out-of-flow box
   * still contributes to its ancestor's scrollable overflow. That is a
   * horizontal scrollbar on a page whose suite asserts there is none, and
   * WCAG 1.4.10 is specified at exactly that width.
   *
   * `position: fixed` takes it out of the document's scroll overflow
   * altogether. The cost is that it no longer travels with the page, so the
   * effect below re-places it on scroll and resize.
   */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const reactId = useId();
  const panelId = `glossary-${id}-${reactId}`;
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);

  /* One writer for both pieces of state. Closing forgets the measured
     position too, so a reopen is placed against the trigger's CURRENT
     coordinates rather than flashing at wherever it stood last time. */
  const setOpenState = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setPos(null);
  }, []);

  const close = useCallback(
    (refocus: boolean) => {
      setOpenState(false);
      if (refocus) triggerRef.current?.focus();
    },
    [setOpenState]
  );

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Stop here: an Escape aimed at this panel must not also close a dialog
      // or a details element further up the tree.
      e.stopPropagation();
      close(true);
    };
    const onOutside = (e: Event) => {
      const target = e.target as Node | null;
      if (target && wrapRef.current?.contains(target)) return;
      setOpenState(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('focusin', onOutside);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('focusin', onOutside);
    };
  }, [open, close, setOpenState]);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const rect = trigger.getBoundingClientRect();
      const doc = document.documentElement;
      // Measured while the panel is still `visibility: hidden` — it is laid
      // out, just not painted, so both dimensions are already real.
      const { offsetWidth: width, offsetHeight: height } = panel;

      // Left-aligned to the term, then pulled back inside whichever edge it
      // would have crossed. `Math.max` last so a panel wider than the viewport
      // still starts at the gutter rather than off the left.
      const left = Math.max(
        EDGE_GUTTER,
        Math.min(rect.left, doc.clientWidth - width - EDGE_GUTTER)
      );

      /* FLIPS ABOVE THE TERM when there is no room under it. On a phone the
         thumb bar owns the bottom of the screen and sits above this panel
         (z-40 vs z-30, deliberately — a permanent navigation bar must not be
         covered), so a panel opened low would be half unreadable. It only
         flips when the space above genuinely fits it; otherwise it stays
         below and the page scrolls, which is still better than a panel
         clipped at the top. */
      const below = rect.bottom + PANEL_GAP;
      const above = rect.top - PANEL_GAP - height;
      const fitsBelow = below + height + EDGE_GUTTER <= doc.clientHeight;
      setPos({ top: !fitsBelow && above >= EDGE_GUTTER ? above : below, left });
    };
    place();
    // The panel is viewport-positioned, so it has to follow its own trigger
    // when the page moves under it. Capture phase catches scrolls inside any
    // scrolling ancestor, not just the document.
    window.addEventListener('scroll', place, { capture: true, passive: true });
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, { capture: true });
      window.removeEventListener('resize', place);
    };
  }, [open]);

  return (
    /* `inline-block` rather than `inline`: an inline box that wraps across two
       lines fragments its containing block, and `top-full` then measures the
       wrong fragment. `max-w-full` keeps the atomic box inside its column at
       320px. */
    <span ref={wrapRef} className="relative inline-block max-w-full">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-describedby={open ? panelId : undefined}
        onClick={() => setOpenState(!open)}
        /* No weight change: bolding every glossed term would speckle the
           sentence. The dotted rule carries the affordance, and `text-ink`
           against the `text-ink-2` prose around it is the second, non-colour
           signal. `decoration-ink-2` is 7.87:1 on paper — far over 1.4.11's
           3:1 for the thing that makes a control findable. */
        className="cursor-pointer text-left text-ink underline decoration-ink-2 decoration-dotted underline-offset-4 hover:decoration-ink"
      >
        {children ?? t(`terms.${id}.term`)}
      </button>

      {open && (
        <span
          ref={panelRef}
          id={panelId}
          /* Hidden for exactly one frame, until the effect below has measured
             where it goes — never painted at the wrong place first. */
          style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
          /* A <span> with `block`, not a <div>: these render inside <p> and
             <li> elements, and a block-level child of a <p> closes the
             paragraph in the parser and desynchronises hydration.
             `normal-case` / `tracking-normal` / `whitespace-normal` reset the
             uppercase tracked chrome this can be used inside (the nomination
             page's provenance line, a Big Question's card meta) — the panel is
             prose wherever it opens. */
          /* The width's underscores are load-bearing: a Tailwind arbitrary
             value renders spaces from `_`, and CSS `calc()` REQUIRES
             whitespace around its minus. Written `calc(100vw-2rem)` the whole
             declaration is invalid, silently dropped, and the panel sizes to
             its content. */
          className="fixed z-30 block w-[min(var(--measure-note),calc(100vw_-_2rem))] rounded-control border-2 border-ink bg-paper p-4 text-left text-sm font-normal tracking-normal whitespace-normal text-ink normal-case"
        >
          <span className="block text-2xs leading-tight font-extrabold tracking-[0.1em] text-ink-2 uppercase">
            {t(`terms.${id}.term`)}
          </span>
          <span className="mt-2 block">{t(`terms.${id}.body`)}</span>
          <Link
            href={glossaryHref(id)}
            className="mt-3 inline-flex min-h-11 items-center font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
          >
            {t('fullGlossary')} →
          </Link>
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

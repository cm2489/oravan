'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Chip } from '@/components/system/Chip';

/*
 * THE IN-PLACE DEFINITION — a term you can hover, tap, click or tab to, and
 * that never takes you anywhere.
 *
 * REDESIGNED 2026-09-28 on the owner's note on the UX inventory (C05): "I'd
 * actually rather not click through to the glossary page. Hover should still
 * work and be quick … and clicking on the word should just do the same action
 * and not redirect." Until then the term was a link to /glossary#id with a
 * hover box, so a click or a tap left the page — the one thing he said a
 * reader should never have to do to learn a word.
 *
 * So the term is a BUTTON now, and every way in opens the same box in place:
 *
 *   HOVER (mouse) — opens after HOVER_OPEN_MS, closes HOVER_CLOSE_MS after the
 *     pointer leaves. See the two constants for the numbers and why.
 *   CLICK / TAP — opens the same box and PINS it: it stays when the pointer
 *     leaves, and closes on a second click or tap of the term, a click or tap
 *     anywhere else, Escape, or focus moving on. A click on a box that hover
 *     already opened just pins it, so a click never makes the box vanish
 *     under the reader's eyes, and a click or tap INSIDE the box never
 *     closes it (even where the browser moves focus off the term to do it).
 *     A tap on a phone is a click; there is no hover step to get past.
 *   KEYBOARD — focus opens it at once (focus is deliberate, so no delay);
 *     Enter or Space pins it; Escape closes it and leaves focus on the term;
 *     Tab moves on and closes it.
 *
 * Only one box is open at a time: opening one closes whichever other box is
 * open, so a pinned box can never be left behind under a new one.
 *
 * ── ARIA: A DISCLOSURE THAT ALSO DESCRIBES ────────────────────────────────
 *
 * `aria-expanded` is honest now, because activating the term toggles a panel
 * in place (it used to navigate, which is why it was once forbidden here).
 * `aria-controls` names the panel while it exists. `aria-describedby` points
 * at the definition's body, then its AI label, while open, so a screen reader
 * reads the definition and says who drafted it when focus lands on the term,
 * without a second step. The panel follows the term in the DOM, so a reader
 * browsing by line meets it next.
 * The accessible name stays the visible word (WCAG 2.5.3): no aria-label, and
 * no hidden "— definition" suffix read into the middle of every sentence.
 *
 * WCAG 1.4.13 (content on hover or focus) still holds clause by clause:
 * DISMISSIBLE by Escape without moving pointer or focus (and latched, so it
 * does not spring back under a stationary cursor); HOVERABLE, because the box
 * is a DOM descendant of the wrapper that owns the pointer handlers and the
 * close grace covers the gap between term and box; PERSISTENT, because
 * nothing times it out.
 *
 * ── 44PX WITHOUT BREAKING THE LINE ───────────────────────────────────────
 *
 * The term sits inside a sentence, but a button renders as an atomic inline
 * box, so the inline exemption that covered the old link does not reach it
 * (tests/bill-a11y.spec.ts sweeps every button on a bill page). The button is
 * therefore a real 44x44 box — `min-h-11 min-w-11` — with negative block
 * margins of (44px − one line) / 2, so the line it sits in keeps its height
 * and the word keeps its baseline. The hit area reaches a little into the
 * lines above and below, which is the point of it on a phone.
 *
 * ── MOTION ───────────────────────────────────────────────────────────────
 *
 * The box does not animate, at all: it is readable the frame it opens, in
 * both motion modes, so `prefers-reduced-motion` needs no separate path. The
 * hover delay is an intent filter (whether to open), not an animation.
 *
 * ── WHAT THIS FILE IS HANDED ─────────────────────────────────────────────
 *
 * Four strings and the visible words, all resolved on the server by
 * components/GlossaryTerm.tsx: the term, its definition, and the AI label's
 * caption and mark. This file imports no glossary data and no messages (only
 * the presentational Chip): a page ships the definitions it prints and
 * nothing else, and the client provider no longer carries `glossary.terms`
 * at all (i18n/client-messages.ts).
 *
 * The AI label heads every box, under the term's name (the site's own
 * unboxed `Chip tone="ai"` caption, the one the bill page prints at first
 * contact), and `aria-describedby` names it after the definition, so a
 * screen reader hears the label wherever it hears the words it labels
 * (CLAUDE.md rule 4: "Every AI-written word is labeled where it first
 * appears"). It is plain text, not a link: the box is a description, not a
 * dialog, and a link in it would put a second tab stop behind every glossed
 * word. The link to the AI-content policy lives at the top of /glossary.
 */

/** Kept clear of either viewport edge when the box is nudged back on screen. */
const EDGE_GUTTER = 16;
/** Between the term and the box. */
const PANEL_GAP = 8;
/**
 * Pointer dwell before the box opens: 130ms (it was 200ms).
 *
 * Why this number: a pointer skimming a line of text crosses a word in well
 * under 100ms, so anything shorter strobes a box at every glossed word the
 * cursor passes over — and a decoded answer can carry several. Around 100ms
 * is also where a response stops reading as instant (the long-standing 0.1s
 * figure for direct manipulation), and the hand has usually been still for a
 * beat before a reader expects anything, so 130ms after the pointer ARRIVES
 * lands inside what feels immediate. 200ms read as a lag the owner noticed.
 */
const HOVER_OPEN_MS = 130;
/**
 * Grace after the pointer leaves: 150ms. Long enough to cross the 8px gap
 * into the box on a diagonal without it closing (WCAG 1.4.13, Hoverable);
 * short enough that moving on to the next term does not leave two boxes up —
 * and opening another term closes this one immediately anyway.
 */
const HOVER_CLOSE_MS = 150;

/** The one box open on the page, if any, keyed by its owner's React id.
 *  Opening another closes it. */
let openBox: { owner: string; close: () => void } | null = null;

export function GlossaryPopover({
  termId,
  label,
  body,
  aiNote,
  aiMarker,
  lang,
  children,
}: {
  termId: string;
  label: string;
  body: string;
  /** The AI label's caption and its mark ("AI" / "IA"), localized on the
   *  server. Two short strings rather than a finished node: a page can mark
   *  dozens of terms, and every instance's props ride in the page payload. */
  aiNote: string;
  aiMarker: string;
  /** The page's language, for the box: the term may sit inside `lang="en"`. */
  lang: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  /*
   * VIEWPORT-POSITIONED AND MEASURED, as the hover box always was: an
   * absolutely-positioned box still adds to its ancestors' scrollable
   * overflow (measured once at 95px of horizontal scroll at 320px), and
   * `position: fixed` takes it out of the document's overflow altogether.
   * The cost is that it has to follow its term on scroll and resize.
   */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const reactId = useId();
  const panelId = `glossary-${termId}-${reactId}`;
  const bodyId = `${panelId}-body`;
  const noteId = `${panelId}-note`;
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A click, tap or Enter pinned it: it stays when the pointer leaves. */
  const pinnedRef = useRef(false);
  /** Set by Escape. Keeps it shut while pointer and focus stay put. */
  const suppressedRef = useRef(false);
  /** A press (mouse, pen or touch) is down inside the term or its box. */
  const pressingRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  const close = useCallback(() => {
    clearTimers();
    pinnedRef.current = false;
    setOpen(false);
    setPos(null);
    if (openBox?.owner === reactId) openBox = null;
  }, [clearTimers, reactId]);

  const show = useCallback(
    (pin: boolean) => {
      clearTimers();
      if (openBox && openBox.owner !== reactId) openBox.close();
      openBox = { owner: reactId, close };
      if (pin) pinnedRef.current = true;
      setOpen(true);
    },
    [clearTimers, close, reactId]
  );

  useEffect(
    () => () => {
      clearTimers();
      if (openBox?.owner === reactId) openBox = null;
    },
    [clearTimers, reactId]
  );

  // Escape closes it without the pointer or the focus having to move, and the
  // latch keeps it closed until one of them does. Bound only while open, so it
  // never eats an Escape meant for something else.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // An Escape aimed at this box must not also close a dialog further up.
      e.stopPropagation();
      suppressedRef.current = true;
      close();
    };
    // A click or tap anywhere outside the term and its box closes it. Capture
    // phase, so a control that stops propagation still dismisses it.
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      close();
    };
    // Focus landing anywhere else closes it too. This covers the Tab that
    // follows a click on the box's text: that click already moved focus off
    // the term (see onBlur), so no blur is left to fire when the reader moves on.
    const onFocusIn = (e: FocusEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      close();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const rect = trigger.getBoundingClientRect();
      const doc = document.documentElement;
      // Measured while the box is still `visibility: hidden` — laid out, just
      // not painted, so both dimensions are already real.
      const { offsetWidth: width, offsetHeight: height } = panel;
      // Left-aligned to the term, then pulled back inside whichever edge it
      // would cross; `Math.max` last so a box wider than the viewport still
      // starts at the gutter rather than off the left.
      const left = Math.max(EDGE_GUTTER, Math.min(rect.left, doc.clientWidth - width - EDGE_GUTTER));
      /* FLIPS ABOVE THE TERM when there is no room under it: on a phone the
         thumb bar owns the bottom of the screen and sits above this box (z-40
         vs z-30, deliberately — a permanent navigation bar must not be
         covered). It flips only when the space above genuinely fits it.
         WHEN NEITHER SIDE FITS — a long entry opened from mid-screen on a
         phone, more common since every box carries its AI label — it is
         pulled up until its bottom edge is back on screen, over the term
         rather than off the bottom of the viewport. */
      const below = rect.bottom + PANEL_GAP;
      const above = rect.top - PANEL_GAP - height;
      const fitsBelow = below + height + EDGE_GUTTER <= doc.clientHeight;
      const fitsAbove = above >= EDGE_GUTTER;
      const top = fitsBelow
        ? below
        : fitsAbove
          ? above
          : Math.max(EDGE_GUTTER, Math.min(below, doc.clientHeight - height - EDGE_GUTTER));
      setPos({ top, left });
    };
    place();
    window.addEventListener('scroll', place, { capture: true, passive: true });
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, { capture: true });
      window.removeEventListener('resize', place);
    };
  }, [open]);

  /* MOUSE ONLY for hover. A touch fires a synthetic pointerenter just before
     its click; honouring it would race the tap. The tap is the click. */
  const onPointerEnter = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (suppressedRef.current || open) return;
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => show(false), HOVER_OPEN_MS);
  };

  const onPointerLeave = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    // The pointer moved: an earlier Escape has served its purpose.
    suppressedRef.current = false;
    if (pinnedRef.current) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(close, HOVER_CLOSE_MS);
  };

  /* Click, tap, Enter, Space: open and pin. A second activation of a pinned
     box closes it — the only way a click ever closes one. */
  const onClick = () => {
    suppressedRef.current = false;
    if (open && pinnedRef.current) close();
    else show(true);
  };

  /* Keyboard arrival opens it immediately. `:focus-visible` so a mouse click
     (which focuses the button in some browsers) is left to onClick. */
  const onFocus = (e: ReactFocusEvent) => {
    if (e.target !== triggerRef.current) return;
    if (suppressedRef.current || open) return;
    if (!triggerRef.current?.matches(':focus-visible')) return;
    show(false);
  };

  /* A press inside the term or its box is reading, not leaving. Chrome
     focuses a button on click, so a keyboard-pinned or clicked term holds
     focus, and a click on the box's plain text then blurs it to <body>
     (relatedTarget null). Without this, that click would close the box it
     landed in. Cleared when the press ends, wherever that is. */
  const onPointerDown = () => {
    pressingRef.current = true;
    const release = () => {
      pressingRef.current = false;
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', release, true);
    };
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
  };

  const onBlur = (e: ReactFocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && wrapRef.current?.contains(next)) return;
    suppressedRef.current = false;
    if (pressingRef.current) return;
    close();
  };

  return (
    /* The handlers sit on the WRAPPER, not the term, because the box is a DOM
       descendant of it — that is what lets the pointer travel into the box
       without pointerleave firing (WCAG 1.4.13, Hoverable). */
    <span
      ref={wrapRef}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-describedby={open ? `${bodyId} ${noteId}` : undefined}
        data-glossary-term={termId}
        onClick={onClick}
        /* Drawn exactly as the linked term was — ink, dotted underline, no
           weight change — so the page looks the same; only what a click does
           changed. `[text-transform:inherit]` because the preflight resets a
           button's case, and a term inside the uppercase meta lines (the
           nomination provenance line) must keep theirs. The negative block
           margin is the 44px box's other half; see the header. */
        className="inline-flex min-h-11 min-w-11 max-w-full -my-[calc((2.75rem_-_1lh)/2)] cursor-pointer items-center justify-center text-left align-baseline text-ink underline decoration-ink-2 decoration-dotted underline-offset-4 [text-transform:inherit] hover:decoration-ink"
      >
        {children}
      </button>

      {open && (
        <span
          ref={panelRef}
          id={panelId}
          lang={lang}
          data-glossary-panel={termId}
          /* Hidden for exactly one frame, until the effect above has measured
             where it goes — never painted at the wrong place first. */
          style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
          /* A <span> with `block`, not a <div>: these render inside <p> and
             <li>, and a block-level child of a <p> closes the paragraph in the
             parser. `normal-case` / `tracking-normal` / `whitespace-normal`
             reset the uppercase tracked chrome this can open inside — the box
             is prose wherever it opens. The width's underscores are
             load-bearing: CSS calc() needs whitespace around its minus. */
          className="fixed z-30 block w-[min(var(--measure-note),calc(100vw_-_2rem))] rounded-control border-2 border-ink bg-paper p-4 text-left text-sm font-normal tracking-normal whitespace-normal text-ink normal-case"
        >
          <span className="block text-2xs leading-tight font-extrabold tracking-[0.1em] text-ink-2 uppercase">
            {label}
          </span>
          {/* The AI label, quiet: the same unboxed caption the bill page
              prints at first contact, under the term's name and ABOVE the
              words it labels — so it is on screen whenever the box is, even
              where a phone's thumb bar covers the box's last lines. */}
          <span id={noteId} data-glossary-ai-note className="mt-1.5 block">
            <Chip tone="ai" marker={aiMarker}>
              {aiNote}
            </Chip>
          </span>
          <span id={bodyId} className="mt-2 block">
            {body}
          </span>
        </span>
      )}
    </span>
  );
}

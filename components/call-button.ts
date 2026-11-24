/*
 * THE ONE CALL-BUTTON STYLE (wireframes v2, 2026-09-29: "One call-button
 * style: outlined, the same as the Call tab").
 *
 * Every control whose job is "call" wears this: "Read + call" (the Call hub,
 * both Big Question card kinds and the "Still open" rail), the "Make the call"
 * float, the DC-number and switchboard buttons in a bill's call panel, and the
 * DC button on a rep card. They share ONE string, here, so the colour pass
 * later changes it in one place. (The phone bar's Call tab wore it too until
 * the owner took that tab off the bar, 2026-11-24.)
 *
 * Built only from existing tokens: a 2px ink edge, the control radius, a paper
 * fill and ink type, which is the site's outlined-button idiom already
 * (components/BillsBrowser.tsx).
 * Hover inverts to an ink fill, the same idiom. Ink (#1c1b18) on paper
 * (#fcfaf4) computes to 16.50:1, and paper on ink is the same pair, so both
 * states clear AA with room (WCAG 2 relative luminance, recomputed 2026-09-30
 * for the warm-paper palette).
 * Focus is the
 * global `:focus-visible` ring (app/globals.css): a 3px ink outline 2px off
 * the edge, so the ring never touches the 2px border. That is why this string
 * carries no `ring-gap`, which exists for FILLED controls.
 *
 * Only the look lives here. Size, padding and layout stay with each caller,
 * because a "Read + call" button and a display-size phone number are not the
 * same box.
 */
export const CALL_BUTTON =
  'rounded-control border-2 border-ink bg-paper font-bold text-ink no-underline hover:bg-ink hover:text-paper';


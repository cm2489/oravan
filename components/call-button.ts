/*
 * THE ONE CALL-BUTTON STYLE (wireframes v2, 2026-09-29: "One call-button
 * style: outlined, the same as the Call tab").
 *
 * Every control whose job is "call" wears this: the Call tab and the desktop
 * Call link (components/Header.tsx), "Read + call" (the Call hub and both Big
 * Question card kinds), the "Make the call" float, the DC-number and
 * switchboard buttons in a bill's call panel, and the DC button on a rep card.
 * Page 2's own line is that the Call tab and the call buttons "share one token
 * set", so they share ONE string, here, and the colour pass later changes it in
 * one place rather than in eight.
 *
 * Built only from existing tokens: a 2px ink edge, the control radius, a paper
 * fill and ink type, which is the site's outlined-button idiom already
 * (components/ZipForm.tsx `submitTone="secondary"`, components/BillsBrowser.tsx).
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
 * because a 56px thumb-bar cell and a display-size phone number are not the
 * same box.
 */
export const CALL_BUTTON =
  'rounded-control border-2 border-ink bg-paper font-bold text-ink no-underline hover:bg-ink hover:text-paper';

/** The "you are here" state of a call control that is also a nav item (the
 *  Call tab on /call): the ink fill every other current nav item uses. */
export const CALL_BUTTON_CURRENT =
  'rounded-control border-2 border-ink bg-ink font-bold text-paper no-underline';

/*
 * THE LAYOUT SYSTEM (layout pass 2026-11-28). One set of grid strings so
 * every page uses the same columns. Page shell: `mx-auto w-full max-w-page px-4`.
 * Prose inside any of these stays at max-w-read (528) or max-w-desk (608).
 */

/** The desk: a reading column of up to 38rem (608) and a rail that takes the
 *  rest, never under 22.5rem (360). 1216 → 608 | 64 | 544; 960 (a 992
 *  window) → 536 | 64 | 360. Bill, nomination, question and /call pages. */
export const DESK_COLS =
  'min-[62rem]:grid-cols-[minmax(0,var(--measure-desk))_minmax(22.5rem,1fr)] min-[62rem]:gap-x-16';

/** Cards: one column on a phone, two from sm, three from xl.
 *  1216 → 3 × 394.67 (gap 16); 992 → 2 × 488. */
export const CARD_GRID = 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3';

/** A list page's title row: title + lede left, the page's small print
 *  right. 1216 → 688 | 48 | 480; 992 → 464 | 48 | 480. */
export const INTRO_ROW =
  'lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:items-end lg:gap-x-12';

/** Main column + a 22rem side column (My reps). 1216 → 816 | 48 | 352. */
export const SIDE_ROW = 'lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-x-12';

/** Two equal blocks side by side. 1216 → 576 | 64 | 576. */
export const PAIR_ROW = 'lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-16';

/** A long document: a title column beside a 33rem text column.
 *  1216 → 624 | 64 | 528; 992 → 400 | 64 | 528. */
export const DOC_ROW = 'lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,33rem)] lg:gap-x-16';

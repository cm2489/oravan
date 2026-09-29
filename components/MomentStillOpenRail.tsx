import { PhoneCall } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { CALL_BUTTON } from '@/components/call-button';
import { MomentStatusLine } from '@/components/MomentStatusLine';
import type { StatusLine } from '@/lib/moment-status.mjs';

/*
 * THE DESK'S "STILL OPEN TO A CALL" RAIL (wireframes v2, 2026-09-29,
 * question-multi.html, desktop frame): on a Big Question with several open
 * vehicles, the reading column holds the full cards and this sticky rail
 * holds the short version — each open measure's citation, where it stands on
 * the record, and "Read + call" onto that bill's own panel. It keeps a way to
 * call beside the column at every scroll depth on the desk, the job the call
 * panel's rail does on a bill page (rule 8: demote the call, never bury it).
 *
 * DESK ONLY. On a phone the column's own "Still open" list is the list, and a
 * second copy under it would only add length, so the page renders this rail
 * `hidden` below the desk breakpoint (display: none, out of the
 * accessibility tree too).
 *
 * Nothing here is AI-written: the citation and the status line are the
 * record's, mapped to fixed copy (lib/moment-status.mjs), so there is no AI
 * label. The button wears the one shared call style (components/
 * call-button.ts), like every "Read + call".
 */

export interface StillOpenRailItem {
  key: string;
  identifier: string;
  statusLine: StatusLine;
  href: string;
  ctaLabel: string;
  /** Screen-reader words after the label ("about H.Con.Res. 93"). */
  ctaContext: string;
}

export function MomentStillOpenRail({
  heading,
  items,
}: {
  /** "Still open to a call", already localized. */
  heading: string;
  items: StillOpenRailItem[];
}) {
  return (
    <section
      aria-labelledby="still-open-rail"
      data-still-open-rail
      className="flex min-h-0 w-full flex-col border-t-[3px] border-ink pt-4 min-[62rem]:max-h-full"
    >
      <h2 id="still-open-rail" className="flex-none text-h3 font-extrabold text-ink">
        {heading}
      </h2>
      {/* CAPPED AT THE WINDOW, SCROLLING INSIDE ITSELF (the call panel's own
          idiom, components/ActionPanel.tsx). The rail is sticky, and a sticky
          box taller than the window keeps its bottom below the fold until the
          column ends: at 1440×900 the Iran question's seventh "Read + call"
          (S.J.Res. 172) was off screen at every scroll depth short of the
          column's last section, and focusing it by keyboard left the focus
          ring out of view (rule 7). The page caps the rail's wrapper at the
          window's height; this list takes what is left and scrolls, and a
          focused link scrolls it into view. The 28px alpha ramp says "this
          continues" and lifts while a link inside is focused, so no focus ring
          is ever dimmed; the 8px of padding each side (cancelled by the
          negative margin, so nothing moves) keeps the focus ring's 5px
          inside the scroll box's clip at the sides, and 12px of scroll
          padding does the same above and below a link scrolled into view. */}
      <ul className="mt-3 min-h-0 list-none min-[62rem]:-mx-2 min-[62rem]:scroll-py-3 min-[62rem]:overflow-y-auto min-[62rem]:px-2 min-[62rem]:[mask-image:linear-gradient(to_bottom,#000_calc(100%-28px),transparent_100%)] min-[62rem]:[scrollbar-gutter:stable] min-[62rem]:has-[:focus-visible]:[mask-image:none]">
        {items.map((item) => (
          <li key={item.key} className="border-t border-line py-3">
            <p className="text-xs leading-tight font-bold tracking-[0.06em] text-ink-2 tabular-nums">
              {item.identifier}
            </p>
            <MomentStatusLine line={item.statusLine} className="mt-1" />
            <p className="mt-2">
              <Link href={item.href} className={`inline-flex min-h-11 items-center gap-2 px-4 ${CALL_BUTTON}`}>
                <PhoneCall className="h-4 w-4" aria-hidden />
                {item.ctaLabel}
                <span className="sr-only"> {item.ctaContext}</span>
              </Link>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

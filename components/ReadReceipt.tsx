'use client';

import { useEffect } from 'react';
import { upsertRead } from '@/lib/local';

/*
 * THE READ RECEIPT — the writer behind "What you've read" on the civic
 * record. It renders nothing: the bill page is a reading surface, and a
 * visible "you have read this" badge on the page you are currently reading
 * is noise at best and a nudge at worst.
 *
 * WHY IT LIVES IN THE READING COLUMN, and not in the layout: the record is
 * of bills read, so the write belongs to the element that carries the
 * decode. Mounted once per bill page; `upsertRead` is keyed by slug, so a
 * second visit updates the timestamp instead of adding a row.
 *
 * WHAT IT DOES NOT DO: nothing here leaves the device. There is no beacon,
 * no server call, and no scroll/dwell measurement — a mount is the whole
 * signal, and it is written to `oravan.reads` in this browser only.
 *
 * WHY THE WRITE IS DEFERRED A TICK, and not done inline in the effect:
 * `upsertRead` is a synchronous `localStorage.setItem` plus a notify() that
 * wakes every useSyncExternalStore subscriber on the page (the action
 * panel's prefs and calls, among others). Doing that inside the mount
 * commit puts storage work on the bill page's hydration critical path, and
 * the bill page is a page people CLICK while it is still hydrating — the
 * moment backlink, the rail, the tabs. Measured on this branch before the
 * deferral: tests/moments.spec.ts's click-through loop (webkit-mobile, 4
 * workers, retries off) failed 2 of 20 runs against 0 of 20 on the same
 * commit without this component. Nothing on screen depends on the write, so
 * it costs nothing to let hydration finish first.
 *
 * The cleanup matters for the same reason it exists at all: a visitor who
 * lands and leaves inside one tick never read anything, and should not get
 * a row.
 */
export function ReadReceipt({
  slug,
  label,
  labels,
}: {
  slug: string;
  label: string;
  /** Both locales' labels, captured at write time so the record can render
   *  in whichever language it is later read in — see lib/local.ts. */
  labels: { en: string; es: string };
}) {
  useEffect(() => {
    const id = window.setTimeout(() => {
      upsertRead({
        billSlug: slug,
        billLabel: label,
        labelEn: labels.en,
        labelEs: labels.es,
        at: new Date().toISOString(),
      });
    }, 0);
    return () => window.clearTimeout(id);
  }, [slug, label, labels]);

  return null;
}

'use client';

import { useEffect } from 'react';
import { claimCallTab, releaseCallTab } from '@/lib/call-tab';

/**
 * Tells the header's Call tab where to go on this page (lib/call-tab.ts).
 * Renders nothing. A page that has its own call panel, or a list of open
 * bills, renders one of these; every other page renders none and the tab
 * goes to the Call hub.
 *
 * `href` is either an in-page anchor ("#act") or a locale-relative path
 * ("/bills/s-4668-119#act"); the header resolves the locale for a path.
 */
export function CallTabTarget({ href }: { href: string }) {
  useEffect(() => {
    const token = claimCallTab(href);
    return () => releaseCallTab(token);
  }, [href]);
  return null;
}

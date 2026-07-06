import 'server-only';
import { getFormatter, getTranslations } from 'next-intl/server';
import syncState from '@/data/sync-state.json';
import { getAllBills } from './core';

/*
 * KTD-1: freshness is three named timestamps from one accessor.
 * data/sync-state.json holds a cursor high-water mark (`lastSync`,
 * deliberately weeks old during the decode-backlog drain - see
 * docs/solutions/bare-date-cursor-400.md), a last-successful-run time
 * (`lastRun`), and the corpus's newest `last_action_date` - they can
 * disagree by roughly a month. Collapsing them into a single timestamp
 * either claims false freshness or false staleness, so every "as of" /
 * staleness claim on the site reads `checkedAt` from here - no surface
 * reads data/sync-state.json (or scans data/bills.json for the newest
 * action) directly.
 */
export interface Freshness {
  /** Last successful nightly sync run - the honest "we checked" timestamp,
   *  and the value behind every "Data as of {date}" stamp on the site. */
  checkedAt: string;
  /** Cursor high-water mark: how far the sync has fully processed through. */
  completeThrough: string;
  /** Newest `last_action_date` across the corpus. */
  newestAction: string;
}

// The corpus is a static import, so its newest action date can't change
// within a build/server process - scan once, not once per SSG page.
let newestActionCache: string | null = null;

function newestAction(): string {
  if (newestActionCache === null) {
    let newest = '';
    for (const b of getAllBills()) {
      if (b.last_action_date && b.last_action_date > newest) newest = b.last_action_date;
    }
    newestActionCache = newest;
  }
  return newestActionCache;
}

export function getFreshness(): Freshness {
  return {
    checkedAt: syncState.lastRun,
    completeThrough: syncState.lastSync,
    newestAction: newestAction(),
  };
}

/**
 * The one rendering of the "Data as of {date}" claim (localized via the
 * shared `freshness.dataAsOf` key). Every server surface that stamps the
 * page - bill pages, the bills listing, the homepage, the per-bill OG card -
 * calls this instead of assembling the string itself, so the phrasing and
 * date format can never drift between surfaces.
 */
export async function dataAsOfString(locale: string): Promise<string> {
  const t = await getTranslations({ locale, namespace: 'freshness' });
  const format = await getFormatter({ locale });
  return t('dataAsOf', {
    date: format.dateTime(new Date(getFreshness().checkedAt), {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
  });
}

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { BAND_SIZES, CATEGORIES, type UrgencyBand } from '@/lib/taxonomy';
import { setPrefs, usePrefs } from '@/lib/local';
import type { FreshnessSignals } from '@/lib/freshness-state';
import type { FeedTeaser } from '@/lib/types';
import { BillCard } from './BillCard';
import { UrgencyEmptyState } from './UrgencyEmptyState';

const BANDS: UrgencyBand[] = ['now', 'moving', 'radar'];

/* Curated-first: each band initially shows at most a "now" band's worth of
   cards - so the lead "Act now" band always renders whole - and the rest
   stays one "Show all" away. Derived from BAND_SIZES so the two can't drift. */
const BAND_CAP = BAND_SIZES.now;

export function BillsBrowser({ bills, freshness }: { bills: FeedTeaser[]; freshness: FreshnessSignals }) {
  const t = useTranslations();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Partial<Record<UrgencyBand, boolean>>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" focuses search from anywhere; Escape clears it while it's focused.
  // Both live on one window listener - element-level Escape proved unreliable
  // across engines for type=search inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      if (e.key === 'Escape' && el === searchRef.current) {
        setQuery('');
        searchRef.current?.blur();
        return;
      }
      if (e.key !== '/') return;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Saved interests double as the starting filter; toggles persist back.
  const { interests } = usePrefs();
  const active = useMemo(() => interests ?? [], [interests]);

  function toggle(cat: string) {
    const next = active.includes(cat) ? active.filter((c) => c !== cat) : [...active, cat];
    setPrefs({ interests: next });
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bills.filter((b) => {
      if (active.length && !b.tags.some((tag) => active.includes(tag))) return false;
      if (!q) return true;
      return (
        b.title.toLowerCase().includes(q) ||
        (b.headline ?? '').toLowerCase().includes(q) ||
        b.identifier.toLowerCase().includes(q) ||
        // The placeholder promises topic search - match localized tag names
        b.tags.some((tag) => t(`categories.${tag}`).toLowerCase().includes(q))
      );
    });
  }, [bills, query, active, t]);

  const byBand = useMemo(() => {
    const groups: Record<UrgencyBand, FeedTeaser[]> = { now: [], moving: [], radar: [] };
    for (const b of filtered) groups[b.band].push(b);
    return groups;
  }, [filtered]);

  // Lead the chip rail with the topics that actually have bills, so a tap
  // rarely lands on an empty filter. Ranked across the full corpus, so the
  // order stays put as the user filters instead of reshuffling underfoot.
  const orderedCategories = useMemo(() => {
    const count = new Map<string, number>();
    for (const b of bills) for (const tag of b.tags) count.set(tag, (count.get(tag) ?? 0) + 1);
    return [...CATEGORIES].sort((a, b) => (count.get(b) ?? 0) - (count.get(a) ?? 0));
  }, [bills]);

  return (
    <div>
      <div className="mt-6">
        <label htmlFor="bill-search" className="sr-only">
          {t('bills.searchLabel')}
        </label>
        <div className="relative max-w-xl">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-faint" aria-hidden />
          <input
            ref={searchRef}
            id="bill-search"
            type="search"
            placeholder={t('bills.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-control border-2 border-ink/15 bg-surface py-3 pl-12 pr-12 focus:border-ink"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('bills.clearSearch')}
              className="absolute right-1.5 top-1/2 inline-flex min-h-[44px] min-w-[44px] -translate-y-1/2 items-center justify-center rounded-control text-ink-faint hover:text-ink"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          ) : (
            <kbd
              aria-hidden
              className="absolute right-4 top-1/2 hidden -translate-y-1/2 rounded border border-line bg-paper px-1.5 py-0.5 font-mono text-xs text-ink-faint md:block"
            >
              /
            </kbd>
          )}
        </div>
      </div>

      {/* One scrollable row on mobile (no chip wall), wrapping rail on desktop */}
      <div
        className="mt-4 flex gap-2 overflow-x-auto -mx-4 px-4 pb-1 sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible"
        role="group"
        aria-label={t('bills.all')}
      >
        <button
          type="button"
          onClick={() => setPrefs({ interests: [] })}
          aria-pressed={active.length === 0}
          className={`inline-flex min-h-[44px] shrink-0 items-center rounded-full px-4 text-sm font-medium border ${
            active.length === 0
              ? 'bg-ink text-paper border-ink'
              : 'bg-surface border-line text-ink-soft hover:border-ink/40'
          }`}
        >
          {t('bills.all')}
        </button>
        {orderedCategories.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => toggle(cat)}
            aria-pressed={active.includes(cat)}
            className={`inline-flex min-h-[44px] shrink-0 items-center rounded-full px-4 text-sm font-medium border ${
              active.includes(cat)
                ? 'bg-ink text-paper border-ink'
                : 'bg-surface border-line text-ink-soft hover:border-ink/40'
            }`}
          >
            {t(`categories.${cat}`)}
          </button>
        ))}
      </div>

      <p className="mt-2 text-xs text-ink-faint">{t('bills.interestsNote')}</p>

      <p className="mt-4 text-sm text-ink-faint" aria-live="polite">
        {t('bills.showingCount', { shown: filtered.length, total: bills.length })}
      </p>

      {filtered.length === 0 && (
        <div className="mt-8">
          <p className="text-ink-soft">{t('bills.noResults')}</p>
          {(query.trim() !== '' || active.length > 0) && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setPrefs({ interests: [] });
              }}
              className="mt-4 inline-flex min-h-[44px] items-center rounded-control border-2 border-ink/15 bg-surface px-4 font-semibold hover:border-ink/40"
            >
              {t('bills.clearFilters')}
            </button>
          )}
        </div>
      )}

      {BANDS.map((band) => {
        const all = byBand[band];
        if (all.length === 0) {
          // Only "Act now" gets an honest empty message, and only when the
          // visitor is looking at the real, unfiltered feed — a search or
          // topic filter emptying this band is ordinary filtering, not a
          // quiet-week/data-stale claim (KTD-2, AE3). An entirely empty
          // corpus is a data problem, not a quiet week — no claim there
          // either (the generic noResults block already covers it).
          const unfiltered = query.trim() === '' && active.length === 0 && bills.length > 0;
          if (band !== 'now' || !unfiltered) return null;
          return (
            <section key={band} className="mt-10" aria-labelledby={`band-${band}`}>
              <h2 id={`band-${band}`} className="font-display text-2xl font-bold">
                {t(`bills.band.${band}`)}
              </h2>
              <p className="mt-0.5 text-sm text-ink-soft">{t(`bills.bandSub.${band}`)}</p>
              <div className="mt-4">
                <UrgencyEmptyState {...freshness} />
              </div>
            </section>
          );
        }
        const isOpen = !!expanded[band];
        const visible = isOpen ? all : all.slice(0, BAND_CAP);
        return (
          <section key={band} className="mt-10" aria-labelledby={`band-${band}`}>
            <h2 id={`band-${band}`} className="font-display text-2xl font-bold">
              {t(`bills.band.${band}`)}
            </h2>
            <p className="mt-0.5 text-sm text-ink-soft">{t(`bills.bandSub.${band}`)}</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {visible.map((b) => (
                <BillCard key={b.slug} bill={b} />
              ))}
            </div>
            {!isOpen && all.length > BAND_CAP && (
              <button
                type="button"
                onClick={() => setExpanded((e) => ({ ...e, [band]: true }))}
                className="mt-4 w-full rounded-control border-2 border-ink/15 bg-surface px-4 py-3 font-semibold hover:border-ink/40"
              >
                {t('bills.showAll', { count: all.length })}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

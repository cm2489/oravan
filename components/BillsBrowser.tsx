'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { BAND_SIZES, CATEGORIES, type UrgencyBand } from '@/lib/taxonomy';
import { setPrefs, usePrefs } from '@/lib/local';
import { matchMoments, type MomentSearchTeaser } from '@/lib/moments-ui';
import { Chip } from './system';
import type { FreshnessSignals } from '@/lib/freshness-state';
import type { FeedTeaser } from '@/lib/types';
import { BillCard } from './BillCard';
import { UrgencyEmptyState } from './UrgencyEmptyState';

const BANDS: UrgencyBand[] = ['now', 'moving', 'radar'];

/* Curated-first: each band initially shows at most a "now" band's worth of
   cards - so the lead "Act now" band always renders whole - and the rest
   stays one "Show all" away. Derived from BAND_SIZES so the two can't drift. */
const BAND_CAP = BAND_SIZES.now;

/* THE PAGE'S SPINE. Two rule weights, and the difference between them is the
   band hierarchy made visible before it is read: the lead band is opened by
   the full 3px ink rule the reference spends on a section that asks for
   something, the other two by a decorative hairline. `line` is legal here and
   only here — as a SEPARATOR (1.37:1). It is never a component edge. */
const BAND_RULE: Record<UrgencyBand, string> = {
  now: 'border-t-[3px] border-ink',
  moving: 'border-t border-line',
  radar: 'border-t border-line',
};

/* One ghost-button idiom, used by both of this surface's secondary controls.
   Ink, never green: green means GO and is spent on the call itself. */
const GHOST_BTN =
  'inline-flex min-h-12 items-center justify-center rounded-control border-2 border-ink bg-paper px-5 text-sm font-bold text-ink transition-colors hover:bg-ink hover:text-paper';

/* Topic filters are TAGS, and a tag is ink in every state — rest, hover,
   pressed. Never green (pressing a filter goes nowhere) and never `tint`
   (the color law names topic tags as the one thing `tint` may never be, even
   though a pressed filter is genuinely "yours"). Small mark => 3px. */
const FILTER_CHIP =
  'inline-flex min-h-11 shrink-0 items-center rounded-stamp border px-4 text-sm font-semibold transition-colors';
const FILTER_ON = 'border-ink bg-ink text-paper';
const FILTER_OFF = 'border-line-strong bg-paper text-ink-2 hover:border-ink hover:bg-wash hover:text-ink';

/* A stable empty default: an inline `[]` would be a new array every render
   and would churn the memo below on every keystroke. */
const NO_MOMENTS: MomentSearchTeaser[] = [];

export function BillsBrowser({
  bills,
  freshness,
  moments = NO_MOMENTS,
}: {
  bills: FeedTeaser[];
  freshness: FreshnessSignals;
  /** Live moments this search may pin, pre-localized by the server page.
      Optional: the embed and any other caller renders the browser unchanged. */
  moments?: MomentSearchTeaser[];
}) {
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
    // Bare bill-number lookup (2026-08 benchmark steal, from GovTrack +
    // 5calls — it is how journalists and staffers arrive): "HR 6500",
    // "h.r.6500" and "H.R. 6500" all match the citation by comparing both
    // sides with dots/spaces stripped. Guarded on the query actually
    // containing a digit so ordinary word searches never take the
    // punctuation-stripped path ("care" must not match "S. 2071 · CARE").
    const qCite = /\d/.test(q) ? q.replace(/[.\s]/g, '') : null;
    return bills.filter((b) => {
      if (active.length && !b.tags.some((tag) => active.includes(tag))) return false;
      if (!q) return true;
      return (
        b.title.toLowerCase().includes(q) ||
        (b.headline ?? '').toLowerCase().includes(q) ||
        b.identifier.toLowerCase().includes(q) ||
        (qCite !== null && b.identifier.toLowerCase().replace(/[.\s]/g, '').includes(qCite)) ||
        // The placeholder promises topic search - match localized tag names
        b.tags.some((tag) => t(`categories.${tag}`).toLowerCase().includes(q))
      );
    });
  }, [bills, query, active, t]);

  /* The pinned moments, computed OUTSIDE `filtered` on purpose: a moment is
     never injected into the bill list and never counted in it. The two answers
     stay separate objects, which is what keeps the count line honest. */
  const pinned = useMemo(() => matchMoments(query, moments), [query, moments]);

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

  // The honest decode count for the trust line: bills carrying an AI
  // headline in this payload (2,572 of 2,574 at the time of writing — never
  // "every bill", because the corpus genuinely holds undecoded stragglers).
  const decodedCount = useMemo(() => bills.filter((b) => b.headline).length, [bills]);

  return (
    <div>
      <div className="mt-8">
        <label htmlFor="bill-search" className="sr-only">
          {t('bills.searchLabel')}
        </label>
        <div className="relative max-w-xl">
          <Search
            className="pointer-events-none absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2 text-ink-2"
            aria-hidden
          />
          <input
            ref={searchRef}
            id="bill-search"
            type="search"
            placeholder={t('bills.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-h-12 w-full rounded-control border-2 border-line-strong bg-paper py-3 pr-12 pl-12 text-md text-ink transition-colors placeholder:text-ink-2 hover:border-ink focus:border-ink"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('bills.clearSearch')}
              className="absolute top-1/2 right-1 inline-flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center rounded-control text-ink-2 transition-colors hover:text-ink"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          ) : (
            // decorative, aria-hidden: `line` is a separator tone and is legal
            // on a mark that carries no meaning of its own
            <kbd
              aria-hidden
              className="absolute top-1/2 right-4 hidden -translate-y-1/2 rounded-stamp border border-line bg-wash px-1.5 py-0.5 text-2xs text-ink-2 md:block"
            >
              /
            </kbd>
          )}
        </div>
        {/* The corpus, stated at the point of first input (2026-08 benchmark
            steal — VOTE411 proves the inline pattern; GovTrack's no-summary
            small bills and months-late digests are the foil). The count is
            LIVE (bills with a decode in this very payload), never a
            hardcoded claim that drifts from the data. */}
        <p className="mt-2 max-w-note text-sm text-ink-2">
          {t('bills.searchTrust', { decoded: decodedCount })}
        </p>
      </div>

      {/* One scrollable row on mobile (no chip wall), wrapping rail on desktop */}
      <div
        className="mt-4 -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
        role="group"
        aria-label={t('bills.all')}
      >
        <button
          type="button"
          onClick={() => setPrefs({ interests: [] })}
          aria-pressed={active.length === 0}
          className={`${FILTER_CHIP} ${active.length === 0 ? FILTER_ON : FILTER_OFF}`}
        >
          {t('bills.all')}
        </button>
        {orderedCategories.map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => toggle(cat)}
            aria-pressed={active.includes(cat)}
            className={`${FILTER_CHIP} ${active.includes(cat) ? FILTER_ON : FILTER_OFF}`}
          >
            {t(`categories.${cat}`)}
          </button>
        ))}
      </div>

      <p className="mt-3 text-xs text-ink-2">{t('bills.interestsNote')}</p>

      {/* THE PINNED QUESTION (spec §7.3). Above the count, and outside it.
          Three rules hold this row honest:
            1. It is not a bill result. The aria-live count below still says
               how many BILLS matched — a pin that inflated that number would
               be answering a question the reader didn't ask with a number
               they can't check. "ukraine" can legitimately read
               "0 bills" and still show this row.
            2. No vehicle bill is force-injected into the list underneath. The
               moment's own page is where its bills live; the browser keeps
               showing exactly what the corpus matched.
            3. Aliases are never printed. The reader matched on "shutdown";
               what they see is the neutral name we chose and the dek.

          DARK ENAMEL, NOT GREEN — the homepage strip's idiom, and for the
          same reason (owner decision, 2026-07-24): green is spent on the call
          itself and is data-earned, and a search match is not a floor-calendar
          fact. Ink enamel buys the weight without spending it. */}
      {pinned.length > 0 && (
        <ul className="mt-6 list-none">
          {pinned.map((m) => (
            <li key={m.id} className="mt-3 first:mt-0">
              <Link
                href={`/questions/${m.id}`}
                className="on-dark group flex min-h-12 flex-col items-start gap-x-3 gap-y-2 rounded-control bg-ink-deep px-5 py-4 text-paper no-underline sm:flex-row sm:flex-wrap sm:items-baseline"
              >
                <Chip tone="tag" ground="ink" className="shrink-0">
                  {t('moments.searchPinLabel')}
                </Chip>
                <span className="text-lg font-bold group-hover:underline group-hover:decoration-go-bright group-hover:decoration-[3px]">
                  {m.name}
                </span>
                {/* AI-drafted, like every other dek — the page already carries
                    the AI chip above the feed, which is the same first contact. */}
                <span className="max-w-note text-sm text-ink-pale">{m.dek}</span>
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-go-bright underline underline-offset-4 group-hover:text-paper">
                  {t('moments.searchPinCta')}
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-sm text-ink-2" aria-live="polite">
        {t('bills.showingCount', { shown: filtered.length, total: bills.length })}
      </p>

      {filtered.length === 0 && (
        <div className="mt-8">
          <p className="max-w-read text-ink-2">{t('bills.noResults')}</p>
          {(query.trim() !== '' || active.length > 0) && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setPrefs({ interests: [] });
              }}
              className={`mt-4 ${GHOST_BTN}`}
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
            <section key={band} className={`mt-12 pt-4 ${BAND_RULE[band]}`} aria-labelledby={`band-${band}`}>
              <h2 id={`band-${band}`} className="text-h2 font-extrabold text-ink">
                {t(`bills.band.${band}`)}
              </h2>
              <p className="mt-2 max-w-read text-sm text-ink-2">{t(`bills.bandSub.${band}`)}</p>
              <div className="mt-6">
                <UrgencyEmptyState {...freshness} />
              </div>
            </section>
          );
        }
        const isOpen = !!expanded[band];
        const visible = isOpen ? all : all.slice(0, BAND_CAP);
        return (
          <section key={band} className={`mt-12 pt-4 ${BAND_RULE[band]}`} aria-labelledby={`band-${band}`}>
            <h2 id={`band-${band}`} className="text-h2 font-extrabold text-ink">
              {t(`bills.band.${band}`)}
            </h2>
            <p className="mt-2 max-w-read text-sm text-ink-2">{t(`bills.bandSub.${band}`)}</p>
            {/* Only "Deciding now" cards carry the 2px ink border (the
                ActionPanel's own treatment) — the urgency hierarchy the bands
                exist for, visible before it's read (2026-07 critique round 2). */}
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              {visible.map((b) => (
                <BillCard key={b.slug} bill={b} emphasis={band === 'now'} />
              ))}
            </div>
            {/* A DISCLOSURE, never an unmounting button (Phase-1 P1): the
                old {!isOpen && <button>} unmounted itself on activation,
                dropping keyboard focus to <body> at the top of a 246-screen
                band. Staying mounted keeps focus where the user put it,
                aria-expanded names the state, and the flipped label restores
                the collapse path the old control never had. */}
            {all.length > BAND_CAP && (
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setExpanded((e) => ({ ...e, [band]: !isOpen }))}
                className={`mt-6 ${GHOST_BTN}`}
              >
                {isOpen ? t('bills.showFewer') : t('bills.showAll', { count: all.length })}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

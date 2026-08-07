'use client';

import { useId, useState, useSyncExternalStore } from 'react';
import { ChevronDown, ExternalLink, Info } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { COVERAGE_AGE_NOTE_DAYS, freshnessAgeDays } from '@/lib/freshness-state';
import type { CoverageArticle, CoverageTier, Lean } from '@/lib/types';

/*
 * The "Read" section: real third-party articles about a bill, each tagged with
 * the outlet's lean (third-party AllSides rating, never Oravan's).
 *
 * A table wants a grid: one column edge for the outlet, one for the lean, and
 * every headline starting on the same vertical. Ruled paper, no card — the
 * page changes shape exactly once, and that once is the green floor-vote
 * band, not this.
 *
 * NONPARTISAN BY CONSTRUCTION: lean is conveyed by a text label plus a
 * neutral 3-segment position glyph (`ink` for the active segment, `line` for
 * the rest). Never red/blue, never `go`, never a party-coded hue in either
 * language. The snippet preview is revealed on hover/focus (desktop) and by
 * an explicit disclosure button (touch + keyboard), which also pins it open.
 */

const LEAN_POSITION: Record<Lean, 0 | 1 | 2> = { left: 0, center: 1, right: 2 };

// Same hydration gate as StalenessNote/MomentQuietNote: false on the server
// and the hydration render, true after — no state in an effect, no mismatch.
const emptySubscribe = () => () => {};
const useHydrated = () =>
  useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );

/**
 * The newest `publishedAt` across a bill's stored articles, or null when none
 * of them carries a usable date. Null prints no age line at all — a missing
 * date must never be rendered as a recent one. Dates are stored as
 * `YYYY-MM-DD` (scripts/sync-coverage.mjs slices the API timestamp), so the
 * string compare is the date compare.
 */
function newestPublishedAt(articles: CoverageArticle[]): string | null {
  let newest: string | null = null;
  for (const { publishedAt } of articles) {
    if (!publishedAt || !Number.isFinite(new Date(publishedAt).getTime())) continue;
    if (newest === null || publishedAt > newest) newest = publishedAt;
  }
  return newest;
}

export function CoverageSection({ articles, tier }: { articles: CoverageArticle[]; tier: CoverageTier }) {
  const t = useTranslations('coverage');
  const format = useFormatter();
  const locale = useLocale();
  // No coverage -> render nothing (the graceful-empty path).
  if (articles.length === 0) return null;

  const newestAt = newestPublishedAt(articles);

  return (
    <section aria-labelledby="coverage-heading" className="pt-8 md:pt-12">
      <h2 id="coverage-heading" className="text-h2 font-extrabold text-ink">
        {t('heading')}
      </h2>
      <p className="mt-2 max-w-read text-ink-2">{t('subhead')}</p>
      {/* THE AGE OF WHAT THIS SECTION IS ACTUALLY SHOWING.
          The bill page prints a "Data as of" stamp ~20 lines above this
          section, and that stamp tracks the Congress.gov BILL sync — it says
          nothing about when these articles were gathered, and a reader has no
          way to tell the two dates apart. So the section states its own age,
          from the dates already stored on the articles: one line, one date,
          the same shape as the tracker's "Last action" line above it. */}
      {newestAt && (
        <p className="mt-2 max-w-note text-sm text-ink-2">
          <span className="font-semibold text-ink">{t('newestLabel')}:</span>{' '}
          <time dateTime={newestAt} className="tabular-nums">
            {format.dateTime(new Date(newestAt), {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              timeZone: 'UTC',
            })}
          </time>
          <CoverageAgeNote newestAt={newestAt} />
        </p>
      )}
      {/* ES readers land on a predominantly English press corpus; flag it up
          front so a language switch isn't a surprise after the click (S6). */}
      {locale === 'es' && <p className="mt-2 max-w-read text-sm text-ink-2">{t('foreignLanguageNote')}</p>}

      {tier === 'one_sided' && (
        <p className="mt-4 flex max-w-read items-start gap-2 rounded-control bg-wash p-3 text-sm text-ink">
          <Info className="mt-0.5 h-4 w-4 flex-none text-ink-2" aria-hidden />
          <span>{t('oneSidedNote')}</span>
        </p>
      )}

      <ul className="mt-6 list-none">
        {articles.map((article, i) => (
          <CoverageRow key={`${article.url}-${i}`} article={article} />
        ))}
      </ul>

      <p className="mt-4 max-w-note text-sm text-ink-2">{t('leanNote')}</p>
    </section>
  );
}

/*
 * The age caveat, built on StalenessNote's pattern (R2 / KTD-2) and for the
 * same reason: this is one of ~1,000 statically generated pages, so a verdict
 * baked at build time would freeze at the moment of the deploy and an article
 * set would keep reading as recent forever. It is re-diffed against the
 * VISITOR's clock and renders nothing pre-hydration, so the prerendered HTML
 * never carries a clock-dependent claim. One line, one date — the caveat
 * continues the sentence the date is already in rather than opening a second.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY: anything about what the press has
 * published. Re-checked as of #158: scripts/sync-coverage.mjs now reaches
 * COVERAGE_TOP_N (600) eligible bills a night out of ~2,500 — half the budget
 * in pure urgency order, half rotating through whatever has gone longest
 * without a look (the `_checkedAt` map) — carries every bill it doesn't reach
 * forward untouched, and stops early when the news API's daily quota runs out.
 * That rotation means every bill eventually gets a turn, which the earlier
 * urgency-only selection did not; it does NOT mean any given bill was looked
 * at recently, and it never means the collection is exhaustive (a night keeps
 * at most COVERAGE_PER_BILL articles that clear the Haiku relevance gate). So
 * "no newer coverage exists" remains a claim this pipeline cannot support.
 * "Newer coverage may exist that we haven't collected" is the strongest true
 * version, and it is the same shape as freshness.staleNote's "newer activity
 * in Congress may not be shown yet".
 */
function CoverageAgeNote({ newestAt }: { newestAt: string }) {
  const t = useTranslations('coverage');
  const hydrated = useHydrated();

  if (!hydrated || freshnessAgeDays(newestAt) <= COVERAGE_AGE_NOTE_DAYS) return null;

  return <span role="status"> — {t('ageNote')}</span>;
}

function CoverageRow({ article }: { article: CoverageArticle }) {
  const t = useTranslations('coverage');
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const snippet = article.snippet ?? '';
  const hasSnippet = snippet.length > 0;

  return (
    <li className="group grid gap-1 border-t-[1.5px] border-line py-3 md:grid-cols-[11rem_9rem_minmax(0,1fr)_2.75rem] md:items-baseline md:gap-4">
      <p className="text-sm font-bold text-ink">{article.source}</p>
      <LeanChip lean={article.lean ?? null} />
      <div className="min-w-0">
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('openArticle', { source: article.source })}
          className="inline-flex min-h-11 items-start gap-1.5 font-semibold text-ink underline decoration-line-strong underline-offset-4 visited:text-ink-2 hover:text-go-deep hover:decoration-go"
        >
          <span>{article.title}</span>
          <ExternalLink className="mt-1 h-4 w-4 flex-none" aria-hidden />
        </a>
        {article.publishedAt && (
          <p className="text-xs text-ink-2 tabular-nums">
            {format.dateTime(new Date(article.publishedAt), {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              timeZone: 'UTC',
            })}
          </p>
        )}
        {/* THE SNIPPET IS THE OUTLET'S VOICE, AND IS SET AS SUCH.
            It used to render as a bare paragraph of page body copy — so a
            reader-directed line like "Let's keep the pressure on" read as
            Oravan's own sentence on a nonpartisan surface (pre-launch audit
            2026-07-25, constitution-02). It is now a real <blockquote>: the
            quotation marks come from the message file (so Spanish gets its
            own «…»), the outlet is named beside the sentence in a <cite>,
            and `cite=` carries the source URL for anything reading the DOM.
            No new rule, no panel, no tint — the mark is typographic, which
            is the whole reason this section is ruled paper and not cards. */}
        {hasSnippet && (
          <blockquote
            id={panelId}
            cite={article.url}
            className={`max-w-read text-sm text-ink-2 ${
              open
                ? 'mt-2 block'
                : 'hidden md:group-hover:mt-2 md:group-hover:block md:group-focus-within:mt-2 md:group-focus-within:block'
            }`}
          >
            <p>
              {t('snippetQuote', { text: snippet })}{' '}
              {/* No `whitespace-nowrap`: a long domain
                  ("economictimes.indiatimes.com") must be allowed to wrap
                  rather than push the row wide at 320px. */}
              <cite className="font-semibold break-words not-italic">
                {t('snippetAttribution', { source: article.source })}
              </cite>
            </p>
          </blockquote>
        )}
      </div>

      {hasSnippet && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={panelId}
          className="inline-flex h-11 w-11 flex-none items-center justify-center rounded-control text-ink-2 hover:bg-wash hover:text-ink"
        >
          <span className="sr-only">{t('preview')}</span>
          <ChevronDown
            className={`h-5 w-5 transition-transform md:group-hover:rotate-180 ${open ? 'rotate-180' : ''}`}
            aria-hidden
          />
        </button>
      )}
    </li>
  );
}

/** Neutral lean chip: text label + a 3-segment position glyph. Never
 *  color-coded. `lean: null` = AllSides has no rating for the outlet — all
 *  three segments stay muted and the label says so, because absence must
 *  never be readable as "center". */
function LeanChip({ lean }: { lean: Lean | null }) {
  const t = useTranslations('coverage');
  const position = lean ? LEAN_POSITION[lean] : null;

  return (
    <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-2">
      <span aria-hidden className="flex flex-none items-center gap-0.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`h-2.5 w-1 rounded-stamp ${i === position ? 'bg-ink' : 'bg-line'}`}
          />
        ))}
      </span>
      {lean ? t(`lean.${lean}`) : t('lean.unrated')}
    </p>
  );
}

'use client';

import { useId, useState } from 'react';
import { ChevronDown, ExternalLink, Info } from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import type { CoverageArticle, CoverageTier, Lean } from '@/lib/types';

/*
 * The "Read" section: real third-party articles about a bill, each tagged with
 * the outlet's lean (third-party AllSides rating, never Oravan's). Nonpartisan:
 * no stance, no party colors. Lean is shown by text label + a neutral 3-segment
 * position glyph (left/center/right), never by color. The snippet preview is
 * the delight moment — revealed on hover/focus (desktop) and by an explicit
 * disclosure button (touch + keyboard), which also pins it open.
 */

const LEAN_POSITION: Record<Lean, 0 | 1 | 2> = { left: 0, center: 1, right: 2 };

export function CoverageSection({ articles, tier }: { articles: CoverageArticle[]; tier: CoverageTier }) {
  const t = useTranslations('coverage');
  const locale = useLocale();
  // No coverage -> render nothing (the graceful-empty path).
  if (articles.length === 0) return null;

  return (
    <section
      aria-labelledby="coverage-heading"
      className="mt-8 rounded-card border border-line bg-paper-deep p-6 md:p-8"
    >
      <h2 id="coverage-heading" className="font-display text-2xl font-bold">
        {t('heading')}
      </h2>
      <p className="mt-1 max-w-prose text-ink-soft">{t('subhead')}</p>
      {/* ES readers land on a predominantly English press corpus; flag it up
          front so a language switch isn't a surprise after the click (S6). */}
      {locale === 'es' && (
        <p className="mt-2 text-sm text-ink-faint">{t('foreignLanguageNote')}</p>
      )}

      {tier === 'one_sided' && (
        <p className="mt-4 flex items-start gap-2 rounded-control bg-brass-soft p-3 text-sm text-ink">
          <Info className="mt-0.5 h-4 w-4 flex-none text-ink-soft" aria-hidden />
          <span>{t('oneSidedNote')}</span>
        </p>
      )}

      <ul className="mt-5 border-t border-line">
        {articles.map((article, i) => (
          <CoverageRow key={`${article.url}-${i}`} article={article} />
        ))}
      </ul>

      <p className="mt-5 max-w-prose text-xs font-medium text-ink-faint">{t('leanNote')}</p>
    </section>
  );
}

function CoverageRow({ article }: { article: CoverageArticle }) {
  const t = useTranslations('coverage');
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const hasSnippet = Boolean(article.snippet);

  return (
    <li className="group border-b border-line py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('openArticle', { source: article.source })}
            className="inline-flex items-start gap-1.5 font-semibold leading-snug underline-offset-4 hover:underline"
          >
            <span>{article.title}</span>
            <ExternalLink className="mt-0.5 h-4 w-4 flex-none text-ink-faint" aria-hidden />
          </a>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-faint">
            <span className="font-medium">{article.source}</span>
            {article.publishedAt && (
              <>
                <span aria-hidden>·</span>
                <span>
                  {format.dateTime(new Date(article.publishedAt), {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    timeZone: 'UTC',
                  })}
                </span>
              </>
            )}
            {/* Always render: a missing chip is ambiguous between "center"
                and "unrated" and reads as selective labeling (2026-07
                critique, unanimous). Unrated outlets say so explicitly. */}
            <LeanChip lean={article.lean ?? null} />
          </p>
        </div>

        {hasSnippet && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={panelId}
            className="inline-flex h-11 w-11 flex-none items-center justify-center rounded-control text-ink-soft hover:bg-surface"
          >
            <span className="sr-only">{t('preview')}</span>
            <ChevronDown
              className={`h-5 w-5 transition-transform md:group-hover:rotate-180 ${open ? 'rotate-180' : ''}`}
              aria-hidden
            />
          </button>
        )}
      </div>

      {hasSnippet && (
        <p
          id={panelId}
          className={`max-w-prose text-sm leading-relaxed text-ink-soft ${
            open ? 'mt-2 block' : 'hidden md:group-hover:mt-2 md:group-hover:block md:group-focus-within:mt-2 md:group-focus-within:block'
          }`}
        >
          {article.snippet}
        </p>
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
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2 py-0.5 text-xs font-medium text-ink-soft">
      <span aria-hidden className="flex items-center gap-0.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`h-2.5 w-1 rounded-sm ${i === position ? 'bg-ink' : 'bg-line'}`}
          />
        ))}
      </span>
      {lean ? t(`lean.${lean}`) : t('lean.unrated')}
    </span>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { SITE_ORIGIN } from '@/lib/site';
import type { BillStatus } from '@/lib/types';

/*
 * The bill-card embed widget (S14): one bill, by slug, read-only. Same
 * design choices as RepLookupWidget (S13) and for the same reasons — see
 * that file's header comment: direct messages/*.json import instead of
 * next-intl (this route has no [locale] segment and no
 * NextIntlClientProvider to read from), stateless per pageview, an
 * always-visible EN/ES toggle a host can default but never remove.
 *
 * House rule (AI-label-travels): bill.headline is already null when the
 * corpus has no AI decode for this bill (lib/core's localizeBill never
 * invents one) — the chip only ever renders alongside a real AI headline,
 * never next to the bare official title.
 */

type EmbedLocale = 'en' | 'es';

const DICTS: Record<EmbedLocale, typeof en> = { en, es };

export interface BillCardData {
  slug: string;
  citation: string;
  headline: string | null;
  officialTitle: string;
  status: BillStatus;
}

/** next-intl-style `{token}` interpolation, without pulling in next-intl. */
function format(template: string, vars: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match
  );
}

export function BillCardWidget({
  initialLocale,
  bill,
  dataAsOf,
  brandless = false,
  attribution = 'on',
}: {
  initialLocale: EmbedLocale;
  bill: BillCardData | null;
  /** ISO timestamp from lib/freshness's getFreshness().checkedAt. */
  dataAsOf: string;
  /** Removes the Oravan name from chrome (never the AI-integrity chip). */
  brandless?: boolean;
  /** 'none' hides the Powered-by footer — licensed partners only (see /embeds docs). */
  attribution?: 'on' | 'none';
}) {
  const [locale, setLocale] = useState<EmbedLocale>(initialLocale);
  const rootRef = useRef<HTMLElement>(null);
  const t = DICTS[locale];

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  // Auto-resize: same ResizeObserver -> postMessage contract public/embed.js
  // already listens for (see RepLookupWidget) — `widget: 'bill-card'` is
  // the only thing that differs, so the loader's per-widget filter matches.
  useEffect(() => {
    if (typeof window === 'undefined' || window.self === window.top) return; // not framed
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const report = () => {
      window.parent.postMessage(
        {
          source: 'oravan-embed',
          type: 'resize',
          widget: 'bill-card',
          height: Math.ceil(el.getBoundingClientRect().height),
        },
        '*'
      );
    };
    const observer = new ResizeObserver(report);
    observer.observe(el);
    report();
    return () => observer.disconnect();
  }, []);

  // Theming lives entirely at :root now (EmbedThemeStyle, rendered by the
  // page) — no tenant-supplied value ever reaches a style prop here.
  const localeToggle = (
    <div role="group" aria-label={t.embed.languageLabel} className="re-row" style={{ gap: 4 }}>
      {(['en', 'es'] as const).map((l) => (
        <button
          key={l}
          type="button"
          className="re-btn re-toggle"
          aria-pressed={locale === l}
          onClick={() => setLocale(l)}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );

  if (!bill) {
    return (
      <main ref={rootRef} className="bc-root" lang={locale}>
        <div className="re-header">
          {/* Brandless chrome drops the app-name fallback, not the layout */}
          <p className="bc-citation">{brandless ? '' : t.common.appName}</p>
          {localeToggle}
        </div>
        <p className="re-error" role="alert">
          {t.embed.billNotFound}
        </p>
      </main>
    );
  }

  const displayHeadline = bill.headline ?? bill.officialTitle;
  const siteBase = `${SITE_ORIGIN}${locale === 'es' ? '/es' : ''}`;
  const billUrl = `${siteBase}/bills/${bill.slug}`;
  const dataAsOfText = format(t.freshness.dataAsOf, {
    date: new Intl.DateTimeFormat(locale === 'es' ? 'es' : 'en', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(new Date(dataAsOf)),
  });

  return (
    <main ref={rootRef} className="bc-root" lang={locale}>
      <div className="re-header">
        <p className="bc-citation">{bill.citation}</p>
        {localeToggle}
      </div>

      <article className="bc-card">
        <p className="bc-status">{t.bills.status[bill.status]}</p>
        <h1 className="bc-headline">{displayHeadline}</h1>
        {bill.headline && <span className="bc-chip-ai">{t.og.aiDecoded}</span>}
        <p className="bc-freshness">{dataAsOfText}</p>
      </article>

      {attribution === 'on' && (
        <p className="re-footer">
          <a className="re-link" href={billUrl} target="_blank" rel="noopener noreferrer">
            {t.embed.poweredBy} ↗
          </a>
        </p>
      )}
    </main>
  );
}

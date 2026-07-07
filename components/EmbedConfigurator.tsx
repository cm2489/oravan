'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { SITE_ORIGIN } from '@/lib/site';
import { safeAccent, type FontKey, type RadiusKey } from '@/lib/embed-theme';
import type { FeedTeaser } from '@/lib/types';

/*
 * S16 — the public embed configurator (docs/ideation/2026-07-05-build-gtm-
 * strategy.md §1.3 S16; product surface spec'd in docs/ideation/2026-07-02-
 * embeds-spec.md §3.3: "the public configurator page (pick widget, pick
 * bill, pick locale, copy the snippet) is the entire onboarding"). Pure
 * client composition — no accounts, no server round-trip of its own; the
 * only network activity is the live-preview <iframe> itself loading the
 * real embed route, exactly what a tenant's own page would do once they
 * paste the snippet below.
 *
 * This is a NEW component, deliberately outside components/embed/* — it
 * consumes the shipped widgets and lib/embed-theme's exported validators
 * from the outside (the same contract any third-party host page gets), and
 * never reaches into widget internals or public/embed.js (S15 owns that
 * concurrently). Reusing lib/embed-theme's exact enums/validators (rather
 * than re-declaring the radius/font options here) means this configurator
 * can never drift out of sync with what the server actually accepts.
 *
 * Theming note (a real, current gap - not fixed here, see the S16 report):
 * only the bill-card widget accepts --oravan-accent/-radius/-font today;
 * components/embed/RepLookupWidget.tsx has no theme prop at all, and
 * public/embed.js's WIDGET_PARAM_ATTRS map has no 'rep-lookup' entry, so the
 * loader wouldn't even forward theme data-attributes for it. The theme
 * controls below are therefore only shown for the bill-card widget - this
 * reflects what's actually shipped, not an aspiration.
 */

type WidgetType = 'rep-lookup' | 'bill-card';
type ConfigLocale = 'en' | 'es';

const DEFAULT_ACCENT = '#82632a'; // matches the widget CSS's own var(--oravan-accent, #82632a) fallback
const DEFAULT_HEIGHT = 480; // mirrors public/embed.js's own DEFAULT_HEIGHT
const MAX_RESULTS = 25;

const RADIUS_KEYS: RadiusKey[] = ['sharp', 'soft', 'round'];
const FONT_KEYS: FontKey[] = ['system', 'serif'];

export function EmbedConfigurator({ bills }: { bills: FeedTeaser[] }) {
  const t = useTranslations('embeds');
  const rawTargetId = useId();
  const targetId = `oravan-embed-${rawTargetId.replace(/[^a-zA-Z0-9]/g, '')}`;

  const [widget, setWidget] = useState<WidgetType>('rep-lookup');
  const [locale, setLocale] = useState<ConfigLocale>('en');
  const [billQuery, setBillQuery] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const [accentInput, setAccentInput] = useState(DEFAULT_ACCENT);
  const [radius, setRadius] = useState<RadiusKey>('soft');
  const [font, setFont] = useState<FontKey>('system');
  const [brandless, setBrandless] = useState(false);
  const [copied, setCopied] = useState(false);
  const [previewHeight, setPreviewHeight] = useState(DEFAULT_HEIGHT);

  // A malformed accent never reaches the preview/snippet - same fail-closed
  // rule lib/embed-theme.ts's safeAccent enforces server-side; this just
  // means the configurator's own live preview can't diverge from what the
  // server would actually render for the exact same input.
  const accent = safeAccent(accentInput) ?? DEFAULT_ACCENT;

  const filteredBills = useMemo(() => {
    const q = billQuery.trim().toLowerCase();
    const pool = q
      ? bills.filter(
          (b) =>
            b.identifier.toLowerCase().includes(q) ||
            b.title.toLowerCase().includes(q) ||
            (b.headline ?? '').toLowerCase().includes(q)
        )
      : bills;
    return pool.slice(0, MAX_RESULTS);
  }, [bills, billQuery]);

  const selectedBill = slug ? (bills.find((b) => b.slug === slug) ?? null) : null;

  // Reset the preview's own height at the moment the user picks a new
  // widget/bill (not via an effect keyed on [widget, slug] - setState
  // synchronously inside an effect body just to mirror a prop/state change
  // is the exact anti-pattern React's own hooks lint flags; doing it in the
  // event handler that already changes widget/slug is both simpler and
  // avoids the extra render). The widget's own ResizeObserver reports the
  // real height again within a frame of the new iframe mounting (see the
  // `key={previewSrc}` below, which forces a fresh iframe/mount per widget).
  function selectWidget(next: WidgetType) {
    setWidget(next);
    setPreviewHeight(DEFAULT_HEIGHT);
  }

  function selectBill(next: string) {
    setSlug(next);
    setPreviewHeight(DEFAULT_HEIGHT);
  }

  // Same postMessage contract public/embed.js's loader listens for
  // (docs comment in that file: {source:'oravan-embed', type:'resize',
  // widget, height}) - consumed here exactly as any real host page would.
  // The preview iframe is same-origin (see previewSrc below), so the origin
  // check pins to THIS deployment - never the production constant, which
  // would make the preview depend on (and leak views to) a different host.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as
        | { source?: string; type?: string; widget?: string; height?: number }
        | null
        | undefined;
      if (!data || data.source !== 'oravan-embed' || data.type !== 'resize') return;
      if (data.widget !== widget) return;
      const height = Number(data.height);
      if (height > 0) setPreviewHeight(height);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [widget]);

  const previewSrc = useMemo(() => {
    if (widget === 'bill-card' && !slug) return null;
    const params = new URLSearchParams({ locale });
    if (widget === 'bill-card' && slug) params.set('slug', slug);
    // S5a: both widgets take the same three validated theme params.
    params.set('accent', accent);
    params.set('radius', radius);
    params.set('font', font);
    if (brandless) params.set('brandless', '1');
    // Relative on purpose: the live preview must show THIS deployment's
    // widget (localhost, preview deploys, prod alike). Only the copy-paste
    // snippet below carries the absolute production origin.
    return `/embed/${widget}?${params.toString()}`;
  }, [widget, locale, slug, accent, radius, font, brandless]);

  const snippet = useMemo(() => {
    if (widget === 'bill-card' && !slug) return null;
    const attrs = [
      `data-oravan-widget="${widget}"`,
      `data-target="${targetId}"`,
      `data-locale="${locale}"`,
    ];
    if (widget === 'bill-card' && slug) attrs.push(`data-slug="${slug}"`);
    attrs.push(`data-accent="${accent}"`);
    attrs.push(`data-radius="${radius}"`);
    attrs.push(`data-font="${font}"`);
    if (brandless) attrs.push(`data-brandless="1"`);
    return [
      `<div id="${targetId}"></div>`,
      `<script src="${SITE_ORIGIN}/embed.js"`,
      ...attrs.map((a) => `        ${a}`),
      `></script>`,
    ].join('\n');
  }, [widget, targetId, locale, slug, accent, radius, font, brandless]);

  async function copySnippet() {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can refuse (permissions, insecure context) - the
      // snippet's own <pre> stays selectable text either way, so there's
      // always a manual fallback; nothing to surface as an error state.
    }
  }

  return (
    <div className="mt-8">
      <h2 className="font-display text-2xl font-bold">{t('configuratorHeading')}</h2>

      {/* min-w-0 on both columns: grid items default to min-width:auto, so
          the snippet <pre>'s long unbreakable lines would otherwise widen
          the column past the viewport on mobile (observed: 53px of
          horizontal page scroll) instead of scrolling inside their own
          overflow-x-auto box. */}
      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0 space-y-6">
          <fieldset>
            <legend className="text-sm font-semibold">{t('widgetLegend')}</legend>
            <div className="mt-2 space-y-2">
              {(
                [
                  ['rep-lookup', t('widgetRepLookup'), t('widgetRepLookupHint')],
                  ['bill-card', t('widgetBillCard'), t('widgetBillCardHint')],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  key={value}
                  className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-control border border-line bg-surface p-3 has-[:checked]:border-ink has-[:checked]:bg-paper-deep"
                >
                  <input
                    type="radio"
                    name="oravan-widget-type"
                    value={value}
                    checked={widget === value}
                    onChange={() => selectWidget(value)}
                    className="mt-1 h-5 w-5 accent-brass"
                  />
                  <span>
                    <span className="block font-semibold">{label}</span>
                    <span className="block text-sm text-ink-soft">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-sm font-semibold">{t('localeLegend')}</legend>
            <div className="mt-2 flex gap-2">
              {(['en', 'es'] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  aria-pressed={locale === l}
                  onClick={() => setLocale(l)}
                  className={`min-h-[44px] flex-1 rounded-control border px-3 text-sm font-semibold ${
                    locale === l
                      ? 'border-ink bg-ink text-paper'
                      : 'border-line bg-surface text-ink hover:border-ink/40'
                  }`}
                >
                  {l === 'en' ? t('localeEn') : t('localeEs')}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-ink-soft">{t('localeNote')}</p>
          </fieldset>

          {widget === 'bill-card' && (
            <div>
              <label htmlFor="oravan-bill-search" className="text-sm font-semibold">
                {t('billPickerLabel')}
              </label>
              <input
                id="oravan-bill-search"
                type="search"
                role="searchbox"
                aria-label={t('billSearchLabel')}
                placeholder={t('billSearchPlaceholder')}
                value={billQuery}
                onChange={(e) => setBillQuery(e.target.value)}
                className="mt-2 min-h-[44px] w-full rounded-control border border-line bg-surface px-3 text-base"
              />
              <p className="mt-1 text-xs text-ink-soft">
                {selectedBill
                  ? `${selectedBill.identifier} — ${selectedBill.headline ?? selectedBill.title}`
                  : t('billNoneSelected')}
              </p>
              <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded-control border border-line">
                {filteredBills.length === 0 && (
                  <li className="p-3 text-sm text-ink-soft">{t('billNoResults')}</li>
                )}
                {filteredBills.map((b) => (
                  <li key={b.slug}>
                    <button
                      type="button"
                      onClick={() => selectBill(b.slug)}
                      aria-pressed={slug === b.slug}
                      className={`flex min-h-[44px] w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                        slug === b.slug ? 'bg-paper-deep font-semibold' : 'hover:bg-paper-deep'
                      }`}
                    >
                      <span className="shrink-0 font-mono text-xs text-ink-soft">
                        {b.identifier}
                      </span>
                      <span className="truncate">{b.headline ?? b.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-ink-faint">
                {t('billResultsNote', { shown: filteredBills.length, total: bills.length })}
              </p>
            </div>
          )}

          {/* S5a: both widgets take the same theme params, so no more gate */}
          {(
            <fieldset>
              <legend className="text-sm font-semibold">{t('themeLegend')}</legend>
              <div className="mt-2 grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="oravan-accent" className="text-sm font-medium">
                    {t('accentLabel')}
                  </label>
                  <div className="mt-1 flex min-h-[44px] items-center gap-2">
                    <input
                      id="oravan-accent"
                      type="color"
                      value={accent}
                      onChange={(e) => setAccentInput(e.target.value)}
                      className="h-11 w-14 cursor-pointer rounded-control border border-line bg-surface"
                    />
                    <span className="font-mono text-sm text-ink-soft">{accent}</span>
                  </div>
                </div>
                <div>
                  <label htmlFor="oravan-radius" className="text-sm font-medium">
                    {t('radiusLabel')}
                  </label>
                  <select
                    id="oravan-radius"
                    value={radius}
                    onChange={(e) => setRadius(e.target.value as RadiusKey)}
                    className="mt-1 min-h-[44px] w-full rounded-control border border-line bg-surface px-3 text-sm"
                  >
                    {RADIUS_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {t(
                          key === 'sharp'
                            ? 'radiusSharp'
                            : key === 'round'
                              ? 'radiusRound'
                              : 'radiusSoft'
                        )}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="oravan-font" className="text-sm font-medium">
                    {t('fontLabel')}
                  </label>
                  <select
                    id="oravan-font"
                    value={font}
                    onChange={(e) => setFont(e.target.value as FontKey)}
                    className="mt-1 min-h-[44px] w-full rounded-control border border-line bg-surface px-3 text-sm"
                  >
                    {FONT_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {t(key === 'serif' ? 'fontSerif' : 'fontSystem')}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </fieldset>
          )}

          <fieldset>
            <legend className="text-sm font-semibold">{t('whiteLabelLegend')}</legend>
            <label className="mt-2 flex min-h-[44px] items-center gap-3 text-sm font-medium">
              <input
                type="checkbox"
                checked={brandless}
                onChange={(e) => setBrandless(e.target.checked)}
                className="h-5 w-5 rounded-control border-line accent-brass"
              />
              {t('whiteLabelBrandless')}
            </label>
            <p className="mt-1 text-xs text-ink-soft">{t('whiteLabelNote')}</p>
          </fieldset>
        </div>

        <div className="min-w-0 space-y-6">
          <div>
            <h3 className="font-display text-lg font-bold">{t('previewHeading')}</h3>
            <div className="mt-2 overflow-hidden rounded-card border border-line bg-paper-deep">
              {previewSrc ? (
                <iframe
                  key={previewSrc}
                  src={previewSrc}
                  title={t('previewHeading')}
                  style={{ width: '100%', height: previewHeight, border: 0, display: 'block' }}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                />
              ) : (
                <p className="p-6 text-sm text-ink-soft">{t('previewPending')}</p>
              )}
            </div>
          </div>

          <div>
            <h3 className="font-display text-lg font-bold">{t('snippetHeading')}</h3>
            <p className="mt-1 text-sm text-ink-soft">{t('snippetHint')}</p>
            {snippet ? (
              <>
                <pre className="mt-2 overflow-x-auto rounded-control border border-line bg-night p-4 text-xs text-paper">
                  <code>{snippet}</code>
                </pre>
                <button
                  type="button"
                  onClick={copySnippet}
                  className="mt-3 inline-flex min-h-[44px] items-center rounded-control bg-ink px-5 font-semibold text-paper hover:bg-night active:translate-y-px"
                >
                  {copied ? t('copied') : t('copySnippet')}
                </button>
                <span aria-live="polite" className="sr-only">
                  {copied ? t('copied') : ''}
                </span>
              </>
            ) : (
              <p className="mt-2 rounded-control border border-line bg-paper-deep p-4 text-sm text-ink-soft">
                {t('snippetPending')}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

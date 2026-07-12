'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { FONT_VALUES, RADIUS_VALUES, type FontKey, type RadiusKey } from '@/lib/embed-theme';
import { officeHoursStatus } from '@/lib/office-hours';
import { SITE_ORIGIN } from '@/lib/site';
import type { Legislator, Stance } from '@/lib/types';

/*
 * The action-panel embed widget (S19, paid tier only): adapted from
 * components/ActionPanel.tsx, compressed, with deliberate cuts — see the
 * S19 design doc for the full reasoning. Same direct messages/*.json
 * import pattern as RepLookupWidget/BillCardWidget (this route has no
 * [locale] segment, no NextIntlClientProvider) — copy for the stance
 * picker, the script review step, and the loading/error states is REUSED
 * VERBATIM from the `bill` namespace, never duplicated into a parallel
 * `embed.actionPanel.*` set, so the two surfaces can never drift apart the
 * way the MCP envelope once drifted from the site's own labels.
 *
 * What's cut relative to the citizen flow, and why (S19 design §4):
 *   - No outcome logging (no contact/voicemail/unavailable buttons, no
 *     "view your impact" link, no call counter) — a cross-origin iframe's
 *     storage is partitioned per (host page, embed origin) under every
 *     major browser's storage-partitioning story, so even a naive
 *     localStorage write here would be inconsistent-by-construction, not
 *     just unreliable. rep-lookup/bill-card already made this exact call
 *     ("embeds are stateless per pageview") — this follows the same rule,
 *     not a new exception. A link-out to the canonical bill page (new tab)
 *     covers anyone who wants the full logged-impact experience.
 *   - No <dialog> call mode. A single always-visible inline pre-dial note
 *     sits between the script and the tel: links instead — simpler focus
 *     management inside a cross-origin iframe, and the print ORDER (script
 *     -> tel: links, never simultaneous) is what actually creates the
 *     required "editable review step before any tel: affordance", not the
 *     modal.
 *   - ZIP is asked for explicitly (F2 — ZIP only, never an address field):
 *     an embedded widget has no persisted preference to read the way the
 *     citizen site's lib/local.ts does.
 */

type EmbedLocale = 'en' | 'es';
const DICTS: Record<EmbedLocale, typeof en> = { en, es };
const STANCES: Stance[] = ['support', 'oppose', 'undecided'];
const GENERATING_KEYS = ['generating1', 'generating2', 'generating3'] as const;

export interface ActionPanelBillData {
  slug: string;
  citation: string;
  headline: string | null;
  officialTitle: string;
}

export interface ActionPanelTheme {
  accent?: string;
  radiusKey: RadiusKey;
  fontKey: FontKey;
}

function telHref(phone: string) {
  return `tel:+1${phone.replace(/\D/g, '')}`;
}

// Office-hours status depends on the visitor's real clock — same hydration
// gate components/OfficeHoursNote.tsx uses, reimplemented locally since
// that component is coupled to next-intl's useTranslations and this route
// has no NextIntlClientProvider to read from.
const emptySubscribe = () => () => {};
function useHydrated() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

export function ActionPanelWidget({
  initialLocale,
  token,
  bill,
  theme,
  brandless = false,
  attribution = 'on',
}: {
  initialLocale: EmbedLocale;
  /** Held in component state, sent ONLY as the X-Oravan-Key header — never re-appended to a URL. */
  token: string;
  bill: ActionPanelBillData;
  theme: ActionPanelTheme;
  /** Removes the Oravan name from chrome (never the AI-integrity chip). */
  brandless?: boolean;
  /** 'none' hides the Powered-by footer — licensed partners only (see /embeds docs). */
  attribution?: 'on' | 'none';
}) {
  const [locale, setLocale] = useState<EmbedLocale>(initialLocale);
  const t = DICTS[locale];
  const rootRef = useRef<HTMLElement>(null);
  const hydrated = useHydrated();

  const [stance, setStance] = useState<Stance | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<Stance, string>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<'generic' | 'rate' | null>(null);
  const [genLine, setGenLine] = useState<1 | 2 | 3>(1);

  const [zipInput, setZipInput] = useState('');
  const [zip, setZip] = useState<string | null>(null);
  const [zipInvalid, setZipInvalid] = useState(false);
  const [reps, setReps] = useState<Legislator[]>([]);
  const [repsError, setRepsError] = useState(false);

  const script = stance ? (drafts[stance] ?? '') : '';

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    if (!loading) return;
    const id = setInterval(() => setGenLine((g) => (g === 3 ? 1 : ((g + 1) as 1 | 2 | 3))), 3200);
    return () => clearInterval(id);
  }, [loading]);

  // Auto-resize: same ResizeObserver -> postMessage contract public/embed.js
  // already listens for (RepLookupWidget/BillCardWidget) — 'action-panel' is
  // the only thing that differs.
  useEffect(() => {
    if (typeof window === 'undefined' || window.self === window.top) return;
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const report = () => {
      window.parent.postMessage(
        {
          source: 'oravan-embed',
          type: 'resize',
          widget: 'action-panel',
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

  // zipValue is threaded through explicitly rather than read from the `zip`
  // state variable: submitZip calls generate() in the SAME tick as its own
  // setZip(clean), and React state updates aren't visible until the next
  // render - reading `zip` here would see the STALE (pre-submit) value and
  // wrongly bail out on the very submission that was supposed to unblock it.
  async function generate(s: Stance, zipValue: string | null) {
    setStance(s);
    setError(null);
    if (drafts[s]) return; // a draft (possibly user-edited) already exists - restore, don't regenerate
    if (!zipValue) return; // wait for ZIP entry (F2) before spending a generation
    setGenLine(1);
    setLoading(true);
    try {
      const res = await fetch('/api/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Oravan-Key': token },
        body: JSON.stringify({ slug: bill.slug, stance: s, locale }),
      });
      if (res.status === 429) {
        setError('rate');
        return;
      }
      if (!res.ok) {
        setError('generic');
        return;
      }
      const data = (await res.json()) as { script: string };
      setDrafts((d) => ({ ...d, [s]: data.script }));
    } catch {
      setError('generic');
    } finally {
      setLoading(false);
    }
  }

  function fetchReps(z: string) {
    fetch(`/api/reps?zip=${z}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { reps: Legislator[] }) => {
        setReps(d.reps);
        setRepsError(false);
      })
      .catch(() => setRepsError(true));
  }

  function submitZip(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const raw = new FormData(e.currentTarget).get('zip');
    const clean = (typeof raw === 'string' ? raw : zipInput).trim();
    if (!/^\d{5}$/.test(clean)) {
      setZipInvalid(true);
      return;
    }
    setZipInvalid(false);
    setZip(clean);
    fetchReps(clean);
    if (stance && !drafts[stance]) void generate(stance, clean);
  }

  const siteBase = `${SITE_ORIGIN}${locale === 'es' ? '/es' : ''}`;

  const themeStyle: CSSProperties = {
    ...(theme.accent ? { ['--oravan-accent' as string]: theme.accent } : {}),
    ['--oravan-radius' as string]: RADIUS_VALUES[theme.radiusKey],
    ['--oravan-font' as string]: FONT_VALUES[theme.fontKey],
  };

  const displayHeadline = bill.headline ?? bill.officialTitle;
  const officeHours = hydrated ? officeHoursStatus() : null;

  return (
    <main ref={rootRef} className="re-root" lang={locale} style={themeStyle}>
      <div className="re-header">
        <p className="bc-citation">{brandless ? '' : t.common.appName}</p>
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
      </div>

      <p className="bc-citation">{bill.citation}</p>
      <h1 className="bc-headline">{displayHeadline}</h1>

      {/* Step 1 - stance */}
      <fieldset className="ap-fieldset" style={{ marginTop: 16 }}>
        <legend className="ap-legend">{t.bill.stanceQ}</legend>
        <div className="re-row">
          {STANCES.map((s) => (
            <button
              key={s}
              type="button"
              className="re-btn re-toggle"
              aria-pressed={stance === s}
              disabled={loading}
              onClick={() => void generate(s, zip)}
            >
              {t.bill.stance[s]}
            </button>
          ))}
        </div>
        {stance === 'undecided' && (
          <p className="re-note" role="status">
            {t.bill.concernNote}
          </p>
        )}
      </fieldset>

      {/* Step 2 - ZIP (F2: ZIP only, never an address field in any iframe) */}
      <form onSubmit={submitZip} className="re-row" style={{ marginTop: 16 }} noValidate>
        <div className="re-field">
          <label htmlFor="ap-zip" className="re-label">
            {t.home.zipLabel}
          </label>
          <input
            id="ap-zip"
            name="zip"
            inputMode="numeric"
            maxLength={5}
            autoComplete="postal-code"
            placeholder={t.home.zipPlaceholder}
            defaultValue={zipInput}
            onChange={(e) => setZipInput(e.target.value)}
            aria-invalid={zipInvalid}
            aria-describedby={zipInvalid ? 'ap-zip-error' : undefined}
            className="re-input"
          />
        </div>
        <button type="submit" className="re-btn">
          {t.home.zipCta}
        </button>
      </form>
      {zipInvalid && (
        <p id="ap-zip-error" role="alert" className="re-error">
          {t.home.zipInvalid}
        </p>
      )}
      {stance && !zip && !zipInvalid && (
        <p className="re-note" role="status">
          {t.bill.needZip}
        </p>
      )}

      {/* Step 3 - generate */}
      {loading && (
        <div style={{ marginTop: 16 }} role="status">
          <p className="re-row" style={{ gap: 6 }}>
            {t.bill[GENERATING_KEYS[genLine - 1]]}
          </p>
          <p className="re-note" style={{ marginTop: 4 }}>
            {t.bill.generatingHint}
          </p>
        </div>
      )}
      {error && (
        <div className="re-error" role="alert" style={{ marginTop: 16 }}>
          <span>{error === 'rate' ? t.bill.rateLimited : t.bill.scriptError}</span>
          {error !== 'rate' && stance && (
            <>
              {' '}
              <button type="button" className="re-btn re-toggle" onClick={() => void generate(stance, zip)}>
                {t.bill.retry}
              </button>
            </>
          )}
        </div>
      )}

      {/* Step 4 - review. The AI-disclosure chip renders immediately
          adjacent to the script, NEVER gated behind brandless/theme params
          — the "label travels with the content" rule (S14 precedent). */}
      {script && (
        <div style={{ marginTop: 16 }}>
          <div className="re-header" style={{ marginBottom: 6 }}>
            <h2 className="re-title">{t.bill.scriptTitle}</h2>
            <span className="bc-chip-ai">{t.bill.scriptDisclaimer}</span>
          </div>
          <p className="re-note" style={{ marginTop: 0 }}>
            {t.bill.scriptHint}
          </p>
          <textarea
            value={script}
            onChange={(e) => setDrafts((d) => (stance ? { ...d, [stance]: e.target.value } : d))}
            rows={6}
            aria-label={t.bill.scriptTitle}
            className="ap-textarea"
          />
        </div>
      )}

      {/* Step 5 - call. Pre-dial note is ALWAYS visible inline (never a
          modal) between the script and the tel: links - the print order,
          not a dialog, is what enforces "review before any tel:
          affordance" inside a cross-origin iframe. */}
      {script && (
        <div style={{ marginTop: 20 }}>
          <h2 className="re-title">{t.bill.callTitle}</h2>
          <div className="re-note" role="status">
            <p style={{ fontWeight: 600, margin: 0 }}>{t.bill.preDialTitle}</p>
            <p style={{ margin: '4px 0 0' }}>{t.bill.preDialBody}</p>
            {officeHours && (
              <p style={{ margin: '8px 0 0' }}>
                {officeHours === 'open' ? t.bill.officeHoursOpenBody : t.bill.officeHoursClosedBody}
              </p>
            )}
          </div>

          {repsError && (
            <div className="re-error" role="alert" style={{ marginTop: 12 }}>
              {t.bill.repsError}
            </div>
          )}

          {reps.length > 0 && (
            <div style={{ marginTop: 12 }}>
              {reps.map(
                (rep) =>
                  rep.phone && (
                    <a key={rep.bioguide} href={telHref(rep.phone)} className="re-phone" style={{ marginTop: 8 }}>
                      <span>{rep.name}</span>
                      <span>{rep.phone}</span>
                    </a>
                  )
              )}
            </div>
          )}
        </div>
      )}

      {attribution === 'on' && (
        <p className="re-footer">
          <a className="re-link" href={`${siteBase}/bills/${bill.slug}`} target="_blank" rel="noopener noreferrer">
            {t.embed.actionPanelSeeImpact} ↗
          </a>
        </p>
      )}
    </main>
  );
}

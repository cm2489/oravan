'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import { SITE_ORIGIN } from '@/lib/site';
import type { Legislator } from '@/lib/types';

/*
 * The rep-lookup embed widget (S13): ZIP in, representatives out. Deliberately
 * NOT next-intl - this page lives outside app/[locale] (no URL locale
 * segment; see app/embed/layout.tsx), so it reads the same messages/*.json
 * files directly and picks a dict by a locale that lives in component state,
 * driven by an always-visible EN/ES toggle (bilingual parity is
 * constitutional - a host page can set the *default* locale via the
 * `?locale=` query param, but can never remove Spanish).
 *
 * ZIP-ONLY, hard rule (F2, docs/ideation/2026-07-05-build-gtm-strategy.md):
 * street-address refinement never renders in this iframe. A split ZIP shows
 * every candidate district's reps (senators are unaffected either way,
 * exactly like the main /reps page's graceful fallback) plus a link-out to
 * the main site's private AddressForm flow, opened in a new tab.
 *
 * Stateless per pageview by design (spec §2.3): no localStorage, no prefs,
 * nothing survives a reload - every render is driven by component state and
 * the initial `?zip=`/`?locale=` the host page supplied.
 */

type EmbedLocale = 'en' | 'es';

const DICTS: Record<EmbedLocale, typeof en> = { en, es };

const DELEGATE_JURISDICTIONS = new Set(['DC', 'PR', 'GU', 'VI', 'AS', 'MP']);

function telHref(phone: string) {
  return `tel:+1${phone.replace(/\D/g, '')}`;
}

type Status = 'idle' | 'loading' | 'notFound' | 'error';

export function RepLookupWidget({
  initialLocale,
  initialZip,
}: {
  initialLocale: EmbedLocale;
  initialZip: string | null;
}) {
  const [locale, setLocale] = useState<EmbedLocale>(initialLocale);
  const [zipInput, setZipInput] = useState(initialZip ?? '');
  const [zip, setZip] = useState<string | null>(null);
  const [reps, setReps] = useState<Legislator[] | null>(null);
  const [multiDistrict, setMultiDistrict] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const rootRef = useRef<HTMLElement>(null);

  const t = DICTS[locale];

  // The widget's own <html lang> - this route has no locale URL segment,
  // so nothing else keeps it in sync with the in-widget toggle.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const lookup = useCallback(async (value: string) => {
    setStatus('loading');
    setZip(value);
    try {
      const res = await fetch(`/api/reps?zip=${value}`);
      if (!res.ok) {
        setReps(null);
        setStatus('error');
        return;
      }
      const data = (await res.json()) as { reps: Legislator[]; multiDistrict: boolean };
      if (data.reps.length === 0) {
        // /api/reps always answers 200 - an unmatched ZIP is an empty list,
        // not an HTTP error (same contract the main /reps page reads).
        setReps(null);
        setStatus('notFound');
        return;
      }
      setReps(data.reps);
      setMultiDistrict(data.multiDistrict);
      setStatus('idle');
    } catch {
      setReps(null);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (!initialZip) return;
    // Deferred a tick so lookup()'s setState calls land outside this
    // effect's own synchronous commit (react-hooks/set-state-in-effect) -
    // the same reasoning ActionPanel's fetchReps satisfies for free by
    // only setting state inside a fetch .then(), not before it.
    const id = setTimeout(() => void lookup(initialZip), 0);
    return () => clearTimeout(id);
    // Runs once for the host-page-supplied initial ZIP only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-resize: report height to the parent frame (public/embed.js) on every
  // content change, via ResizeObserver rather than manual call sites so it
  // can never drift out of sync with what actually renders.
  useEffect(() => {
    if (typeof window === 'undefined' || window.self === window.top) return; // not framed
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const report = () => {
      window.parent.postMessage(
        {
          source: 'rostra-embed',
          type: 'resize',
          widget: 'rep-lookup',
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

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Read the field's live DOM value via FormData, not the React state
    // mirror alone - a fill landing right at hydration can otherwise leave
    // state stale (see components/ZipForm.tsx's ac74d1c fix for the same
    // race) and reject a correctly-typed ZIP.
    const raw = new FormData(e.currentTarget).get('zip');
    const clean = (typeof raw === 'string' ? raw : zipInput).trim();
    if (!/^\d{5}$/.test(clean)) {
      setStatus('error');
      setReps(null);
      return;
    }
    void lookup(clean);
  }

  const siteBase = `${SITE_ORIGIN}${locale === 'es' ? '/es' : ''}`;

  return (
    <main ref={rootRef} className="re-root" lang={locale}>
      <div className="re-header">
        <h1 className="re-title">{t.embed.frameTitle}</h1>
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

      <form onSubmit={submit} className="re-row" noValidate>
        <div className="re-field">
          <label htmlFor="re-zip" className="re-label">
            {t.home.zipLabel}
          </label>
          <input
            id="re-zip"
            name="zip"
            inputMode="numeric"
            maxLength={5}
            autoComplete="postal-code"
            placeholder={t.home.zipPlaceholder}
            defaultValue={zipInput}
            onChange={(e) => setZipInput(e.target.value)}
            aria-invalid={status === 'error'}
            aria-describedby={status === 'error' ? 're-zip-error' : undefined}
            className="re-input"
          />
        </div>
        <button type="submit" className="re-btn">
          {t.home.zipCta}
        </button>
      </form>

      {status === 'error' && (
        <p id="re-zip-error" role="alert" className="re-error">
          {t.home.zipInvalid}
        </p>
      )}
      {status === 'loading' && (
        <p role="status" className="re-note">
          {t.common.loading}
        </p>
      )}
      {status === 'notFound' && (
        <p role="alert" className="re-error">
          {t.reps.zipNotFound}
        </p>
      )}

      {multiDistrict && status === 'idle' && zip && (
        <div className="re-note">
          <p style={{ fontWeight: 600, margin: '0 0 4px' }}>{t.embed.multiDistrictTitle}</p>
          <p style={{ margin: 0 }}>{t.embed.multiDistrictBody}</p>
          <p style={{ margin: '8px 0 0' }}>
            <a
              className="re-link"
              href={`${siteBase}/reps?zip=${zip}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t.embed.openFullLookup} ↗
            </a>
          </p>
        </div>
      )}

      {status === 'idle' &&
        reps &&
        reps.map((rep) => {
          const role =
            rep.type === 'sen'
              ? t.reps.senator
              : DELEGATE_JURISDICTIONS.has(rep.state)
                ? t.reps.delegate
                : t.reps.representative;
          const party =
            rep.party && ['Democrat', 'Republican', 'Independent'].includes(rep.party)
              ? t.reps.party[rep.party as 'Democrat' | 'Republican' | 'Independent']
              : rep.party;
          const place =
            rep.type === 'rep' && rep.district != null ? `${rep.state}-${rep.district}` : rep.state;

          return (
            <article key={rep.bioguide} className="re-card">
              <p className="re-meta">
                {role} · {party} · {place}
              </p>
              <p className="re-name">{rep.name}</p>
              {rep.url && (
                <p style={{ margin: '2px 0 0' }}>
                  <a className="re-link" href={rep.url} target="_blank" rel="noopener noreferrer">
                    {t.reps.website} ↗
                  </a>
                </p>
              )}
              {rep.phone && (
                <a href={telHref(rep.phone)} className="re-phone">
                  <span>{t.reps.dcOffice}</span>
                  <span>{rep.phone}</span>
                </a>
              )}
              {rep.offices.length > 0 && (
                <details style={{ marginTop: 10 }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem' }}>
                    {t.reps.localOffices} ({rep.offices.length})
                  </summary>
                  <ul style={{ margin: '4px 0 0', padding: 0, listStyle: 'none' }}>
                    {rep.offices.map((o, i) => (
                      <li key={i}>
                        <a href={telHref(o.phone!)} className="re-office">
                          <span>
                            {o.city}
                            {o.state ? `, ${o.state}` : ''}
                          </span>
                          <span>{o.phone}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </article>
          );
        })}

      {status === 'idle' && !zip && <p className="re-note">{t.reps.noZip}</p>}

      <p className="re-footer">
        <a className="re-link" href={siteBase} target="_blank" rel="noopener noreferrer">
          {t.embed.poweredBy} ↗
        </a>
      </p>
    </main>
  );
}

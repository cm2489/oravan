'use client';

import { useState, useSyncExternalStore } from 'react';
import { Check, Link as LinkIcon, MessageCircle, Share2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

/*
 * Share a bill page. The URL is always the canonical, slug-only page URL
 * (built server-side from lib/site.ts): no query params, no stance, no
 * locale-tracking params — a shared link must say nothing about the person
 * who shared it. Native share sheet when the browser has one; otherwise a
 * copy-link button plus a plain WhatsApp anchor (user-initiated navigation).
 * No third-party share SDKs, widgets, or scripts, ever.
 */

interface Props {
  /** Canonical slug-only URL for this bill page. */
  url: string;
  /** Neutral share text: citation + headline. */
  text: string;
}

const btn =
  'inline-flex min-h-[44px] items-center gap-1.5 rounded-control border border-ink/20 px-3.5 py-2.5 text-sm font-medium hover:border-ink/50';

// Browser capability, resolved hydration-safely (same pattern as lib/local.ts):
// the server renders 'ssr', the client re-renders once with the real answer.
// Until then (and without JS at all) only the WhatsApp anchor shows — the one
// option that works as plain HTML. The copy button needs the clipboard API,
// so it only appears once hydration proves JS is running.
const noop = () => () => {};
function useShareMode(): 'ssr' | 'native' | 'fallback' {
  return useSyncExternalStore(
    noop,
    () => (typeof navigator.share === 'function' ? 'native' : 'fallback'),
    () => 'ssr'
  );
}

export function SharePanel({ url, text }: Props) {
  const t = useTranslations('bill.share');
  const mode = useShareMode();
  const [copied, setCopied] = useState(false);

  function share() {
    navigator.share({ title: text, text, url }).catch(() => {
      // User dismissed the sheet - nothing to do.
    });
  }

  function copyLink() {
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const waHref = `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`;

  return (
    <div role="group" aria-label={t('label')} className="mt-4 flex flex-wrap items-center gap-2">
      {mode === 'native' && (
        <button type="button" onClick={share} className={btn}>
          <Share2 className="h-4 w-4" aria-hidden />
          {t('share')}
        </button>
      )}
      {mode === 'fallback' && (
        <button type="button" onClick={copyLink} className={btn}>
          {copied ? <Check className="h-4 w-4 text-moss" aria-hidden /> : <LinkIcon className="h-4 w-4" aria-hidden />}
          {copied ? t('copied') : t('copyLink')}
        </button>
      )}
      {mode !== 'native' && (
        <a href={waHref} target="_blank" rel="noopener noreferrer" className={btn}>
          <MessageCircle className="h-4 w-4" aria-hidden />
          {t('whatsapp')}
        </a>
      )}
      {/* Announce the copy confirmation without moving focus */}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? t('copied') : ''}
      </span>
    </div>
  );
}

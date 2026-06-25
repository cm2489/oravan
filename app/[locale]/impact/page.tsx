'use client';

import { useState } from 'react';
import { PhoneCall, MessageCircle, Voicemail, Trash2, ArrowRight } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { eraseAll, removeCall, useCalls, usePrefs } from '@/lib/local';

export default function ImpactPage() {
  const t = useTranslations('impact');
  const tBill = useTranslations('bill');
  const format = useFormatter();
  const calls = useCalls();
  const prefs = usePrefs();
  const [confirming, setConfirming] = useState(false);
  const [erased, setErased] = useState(false);
  const hasAnything = calls.length > 0 || !!prefs.zip || !!prefs.interests?.length;

  function onErase() {
    eraseAll();
    setConfirming(false);
    setErased(true);
  }

  const contacts = calls.filter((c) => c.outcome === 'contact').length;
  const voicemails = calls.filter((c) => c.outcome === 'voicemail').length;

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="font-display text-4xl font-bold">{t('title')}</h1>
      <p className="mt-2 text-ink-soft">{t('sub')}</p>

      {calls.length > 0 && (
      <dl className="mt-8 grid grid-cols-3 gap-3">
        {[
          { icon: PhoneCall, label: t('calls', { count: calls.length }), value: calls.length },
          { icon: MessageCircle, label: t('contacts', { count: contacts }), value: contacts },
          { icon: Voicemail, label: t('voicemails', { count: voicemails }), value: voicemails },
        ].map(({ icon: Icon, label, value }) => (
          <div key={label} className="rounded-card border border-line bg-surface p-4 text-center shadow-lift">
            <Icon className="mx-auto h-5 w-5 text-booth" aria-hidden />
            <dd className="mt-1 font-display text-3xl font-bold">{value}</dd>
            <dt className="text-xs font-medium text-ink-soft">{label}</dt>
          </div>
        ))}
      </dl>
      )}

      {calls.length === 0 && !erased && (
        <div className="mt-10 rounded-card border border-line bg-surface p-8 text-center shadow-lift">
          <h2 className="font-display text-xl font-bold">{t('emptyTitle')}</h2>
          <p className="mt-2 text-ink-soft">{t('emptyBody')}</p>
          <Link
            href="/bills"
            className="mt-5 inline-flex items-center gap-2 rounded-control bg-ink px-5 py-3 font-semibold text-paper hover:bg-night"
          >
            {t('emptyCta')}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      )}

      {calls.length > 0 && (
        <section className="mt-10" aria-labelledby="history">
          <h2 id="history" className="font-display text-2xl font-bold">
            {t('historyTitle')}
          </h2>
          <ul className="mt-4 space-y-3">
            {calls.map((c) => (
              <li key={c.at} className="flex items-start justify-between gap-3 rounded-card border border-line bg-surface p-4 shadow-lift">
                <div>
                  <Link href={`/bills/${c.billSlug}`} className="font-semibold hover:underline underline-offset-2">
                    {c.billLabel}
                  </Link>
                  <p className="mt-1 text-sm text-ink-soft">
                    {c.repName} · {tBill(`outcome.${c.outcome}`)} ·{' '}
                    {format.dateTime(new Date(c.at), { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => removeCall(c.at)}
                  aria-label={t('deleteRecord')}
                  title={t('deleteRecord')}
                  className="shrink-0 rounded-control p-2.5 text-ink-faint hover:bg-clay-soft hover:text-clay"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(hasAnything || erased) && (
        <section className="mt-12 rounded-card border border-clay/30 bg-clay-soft p-6">
          <h2 className="font-display text-xl font-bold">{t('eraseTitle')}</h2>
          <p className="mt-1 text-sm text-ink-soft">{t('eraseBody')}</p>
          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="mt-4 inline-flex items-center gap-2 rounded-control border-2 border-clay px-4 py-2.5 font-semibold text-clay hover:bg-clay hover:text-paper"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              {t('erase')}
            </button>
          ) : (
            <div className="mt-4">
              <p className="text-sm font-medium">{t('eraseConfirm')}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onErase}
                  className="inline-flex items-center gap-2 rounded-control bg-clay px-4 py-2.5 font-semibold text-paper hover:opacity-90"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                  {t('confirmErase')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded-control border-2 border-ink/20 px-4 py-2.5 font-semibold hover:border-ink/50"
                >
                  {t('cancel')}
                </button>
              </div>
            </div>
          )}
          {erased && (
            <p className="mt-3 text-sm font-medium" role="status">
              {t('erased')}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

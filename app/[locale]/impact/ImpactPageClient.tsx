'use client';

import { useState } from 'react';
import { PhoneCall, MessageCircle, Voicemail, Trash2, ArrowRight } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { eraseAll, removeCall, useCalls, usePrefs } from '@/lib/local';

export default function ImpactPageClient() {
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
      <h1 className="text-h2 font-extrabold text-ink">{t('title')}</h1>
      <p className="mt-2 text-ink-2">{t('sub')}</p>

      {calls.length > 0 && (
      <dl className="mt-8 grid grid-cols-3 gap-3">
        {[
          { icon: PhoneCall, label: t('calls', { count: calls.length }), value: calls.length },
          { icon: MessageCircle, label: t('contacts', { count: contacts }), value: contacts },
          { icon: Voicemail, label: t('voicemails', { count: voicemails }), value: voicemails },
        ].map(({ icon: Icon, label, value }) => (
          <div key={label} className="rounded-control border border-line-strong bg-paper p-4 text-center">
            <Icon className="mx-auto h-5 w-5 text-ink-2" aria-hidden />
            <dd className="mt-1 text-h3 font-extrabold tabular-nums">{value}</dd>
            <dt className="text-xs font-medium text-ink-2">{label}</dt>
          </div>
        ))}
      </dl>
      )}

      {calls.length === 0 && !erased && (
        <div className="mt-10 rounded-control border border-line-strong bg-paper p-8 text-center">
          <h2 className="text-h3 font-extrabold">{t('emptyTitle')}</h2>
          <p className="mt-2 text-ink-2">{t('emptyBody')}</p>
          <Link
            href="/bills"
            className="ring-gap mt-5 inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-go bg-go px-5 py-3 font-bold text-paper no-underline hover:border-go-deep hover:bg-go-deep"
          >
            {t('emptyCta')}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      )}

      {calls.length > 0 && (
        <section className="mt-10" aria-labelledby="history">
          <h2 id="history" className="text-h3 font-extrabold">
            {t('historyTitle')}
          </h2>
          <ul className="mt-4 space-y-3">
            {calls.map((c) => (
              <li key={c.at} className="flex items-start justify-between gap-3 rounded-control border border-line-strong bg-paper p-4">
                <div>
                  <Link href={`/bills/${c.billSlug}`} className="font-semibold hover:underline underline-offset-2">
                    {c.billLabel}
                  </Link>
                  <p className="mt-1 text-sm text-ink-2">
                    {c.repName} · {tBill(`outcome.${c.outcome}`)} ·{' '}
                    {format.dateTime(new Date(c.at), { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => removeCall(c.at)}
                  aria-label={t('deleteRecord')}
                  title={t('deleteRecord')}
                  className="flex min-h-12 min-w-12 shrink-0 items-center justify-center rounded-control p-2.5 text-ink-2 hover:bg-wash hover:text-ink"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(hasAnything || erased) && (
        <section className="mt-12 rounded-control bg-wash p-6">
          <h2 className="text-h3 font-extrabold">{t('eraseTitle')}</h2>
          <p className="mt-1 text-sm text-ink-2">{t('eraseBody')}</p>
          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="mt-4 inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-ink bg-paper px-4 py-2.5 font-bold text-ink hover:bg-wash"
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
                  className="ring-gap inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-ink bg-ink-deep px-4 py-2.5 font-bold text-paper"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                  {t('confirmErase')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="min-h-12 rounded-control border-2 border-line-strong px-4 py-2.5 font-bold text-ink hover:border-ink"
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

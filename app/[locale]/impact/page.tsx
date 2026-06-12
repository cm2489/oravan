'use client';

import { useState } from 'react';
import { PhoneCall, MessageCircle, Voicemail, Trash2, ArrowRight } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { eraseAll, useCalls } from '@/lib/local';

export default function ImpactPage() {
  const t = useTranslations('impact');
  const tBill = useTranslations('bill');
  const format = useFormatter();
  const calls = useCalls();
  const [erased, setErased] = useState(false);

  function onErase() {
    if (!window.confirm(t('eraseConfirm'))) return;
    eraseAll();
    setErased(true);
  }

  const contacts = calls.filter((c) => c.outcome === 'contact').length;
  const voicemails = calls.filter((c) => c.outcome === 'voicemail').length;

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="font-display text-4xl font-bold">{t('title')}</h1>
      <p className="mt-2 text-ink-soft">{t('sub')}</p>

      <dl className="mt-8 grid grid-cols-3 gap-3">
        {[
          { icon: PhoneCall, label: t('calls'), value: calls.length },
          { icon: MessageCircle, label: t('contacts'), value: contacts },
          { icon: Voicemail, label: t('voicemails'), value: voicemails },
        ].map(({ icon: Icon, label, value }) => (
          <div key={label} className="rounded-card border border-line bg-white p-4 text-center shadow-lift">
            <Icon className="mx-auto h-5 w-5 text-booth" aria-hidden />
            <dd className="mt-1 font-display text-3xl font-bold">{value}</dd>
            <dt className="text-xs font-medium text-ink-soft">{label}</dt>
          </div>
        ))}
      </dl>

      {calls.length === 0 && !erased && (
        <div className="mt-10 rounded-card border border-line bg-white p-8 text-center shadow-lift">
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
            {calls.map((c, i) => (
              <li key={i} className="rounded-card border border-line bg-white p-4 shadow-lift">
                <Link href={`/bills/${c.billSlug}`} className="font-semibold hover:underline underline-offset-2">
                  {c.billLabel}
                </Link>
                <p className="mt-1 text-sm text-ink-soft">
                  {c.repName} · {tBill(`outcome.${c.outcome}`)} ·{' '}
                  {format.dateTime(new Date(c.at), { month: 'short', day: 'numeric', year: 'numeric' })}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-12 rounded-card border border-clay/30 bg-clay-soft p-6">
        <h2 className="font-display text-xl font-bold">{t('eraseTitle')}</h2>
        <p className="mt-1 text-sm text-ink-soft">{t('eraseBody')}</p>
        <button
          type="button"
          onClick={onErase}
          className="mt-4 inline-flex items-center gap-2 rounded-control border-2 border-clay px-4 py-2.5 font-semibold text-clay hover:bg-clay hover:text-white"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
          {t('erase')}
        </button>
        {erased && (
          <p className="mt-3 text-sm font-medium" role="status">
            {t('erased')}
          </p>
        )}
      </section>
    </div>
  );
}

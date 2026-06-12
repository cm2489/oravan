import Image from 'next/image';
import { Phone, Globe } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { portraitUrl } from '@/lib/data';
import type { Legislator } from '@/lib/types';

function telHref(phone: string) {
  return `tel:+1${phone.replace(/\D/g, '')}`;
}

export function RepCard({ rep }: { rep: Legislator }) {
  const t = useTranslations('reps');
  const role = rep.type === 'sen' ? t('senator') : t('representative');
  const party = rep.party && ['Democrat', 'Republican', 'Independent'].includes(rep.party)
    ? t(`party.${rep.party as 'Democrat' | 'Republican' | 'Independent'}`)
    : rep.party;

  return (
    <article className="rounded-card border border-line bg-white p-5 shadow-lift">
      <div className="flex gap-4">
        <Image
          src={portraitUrl(rep.bioguide)}
          alt=""
          width={72}
          height={88}
          className="h-22 w-18 shrink-0 rounded-lg object-cover bg-paper-deep"
        />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            {role} · {party} · {rep.state}
          </p>
          <h3 className="mt-1 font-display text-xl font-bold leading-tight">{rep.name}</h3>
          {rep.url && (
            <a
              href={rep.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-sm text-ink-soft underline underline-offset-2 hover:text-ink"
            >
              <Globe className="h-3.5 w-3.5" aria-hidden />
              {t('website')}
            </a>
          )}
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {rep.phone && (
          <a
            href={telHref(rep.phone)}
            className="flex items-center justify-between gap-3 rounded-control bg-ink px-4 py-3 font-semibold text-paper hover:bg-night"
          >
            <span className="inline-flex items-center gap-2">
              <Phone className="h-4 w-4" aria-hidden />
              {t('dcOffice')}
            </span>
            <span className="font-mono text-sm">{rep.phone}</span>
          </a>
        )}
        {rep.offices.length > 0 && (
          <details className="rounded-control border border-line bg-paper px-4 py-3">
            <summary className="cursor-pointer font-semibold text-sm select-none">
              {t('localOffices')} ({rep.offices.length})
            </summary>
            <ul className="mt-2 space-y-1.5">
              {rep.offices.map((o, i) => (
                <li key={i}>
                  <a
                    href={telHref(o.phone!)}
                    className="flex items-center justify-between gap-3 text-sm py-1.5 hover:underline underline-offset-2"
                  >
                    <span>{o.city}{o.state ? `, ${o.state}` : ''}</span>
                    <span className="font-mono text-ink-soft">{o.phone}</span>
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </article>
  );
}

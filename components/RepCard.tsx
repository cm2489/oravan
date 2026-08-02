import Image from 'next/image';
import { Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { portraitUrl } from '@/lib/core';
import type { Legislator } from '@/lib/types';

function telHref(phone: string) {
  return `tel:+1${phone.replace(/\D/g, '')}`;
}

/** Jurisdictions whose House member is a non-voting delegate (resident commissioner for PR). */
const DELEGATE_JURISDICTIONS = new Set(['DC', 'PR', 'GU', 'VI', 'AS', 'MP']);

/*
 * One card, one dial. The DC number is the only saturated green on this card
 * because it is the only thing on it you GO anywhere by pressing - the
 * official-website link and every local number stay ink, so the green keeps
 * meaning "this is the action" rather than "this is a link".
 *
 * PARTY IS PLAIN INK TEXT and always will be. It sits in the same ink-2 meta
 * line as the role and the state, at the same weight, with no fill, no edge
 * and no glyph. Nonpartisan by construction is a rendering rule here, not
 * just an editorial one - there is no branch in this file that can reach a
 * party-keyed color.
 *
 * The portrait frame is a `wash` square at the mark radius with the member's
 * initials behind the photo. Those initials are aria-hidden: the name is the
 * h3 six pixels away, so announcing them again (or hanging a role="img"
 * label on them) would make a screen reader read the same person twice. The
 * photo itself is alt="" for the same reason - it is decorative next to a
 * name it cannot add to.
 */
export function RepCard({ rep }: { rep: Legislator }) {
  const t = useTranslations('reps');
  const role =
    rep.type === 'sen'
      ? t('senator')
      : DELEGATE_JURISDICTIONS.has(rep.state)
        ? t('delegate')
        : t('representative');
  const party = rep.party && ['Democrat', 'Republican', 'Independent'].includes(rep.party)
    ? t(`party.${rep.party as 'Democrat' | 'Republican' | 'Independent'}`)
    : rep.party;
  const initials = `${rep.first?.[0] ?? ''}${rep.last?.[0] ?? ''}`.toUpperCase();

  return (
    <article className="rounded-control border-[1.5px] border-line-strong bg-paper p-5">
      <div className="flex gap-4">
        <span className="relative flex h-22 w-18 shrink-0 items-center justify-center overflow-hidden rounded-stamp border-[1.5px] border-line-strong bg-wash">
          {initials && (
            <span aria-hidden="true" className="text-md font-extrabold text-ink-2">
              {initials}
            </span>
          )}
          <Image
            src={portraitUrl(rep.bioguide)}
            alt=""
            width={72}
            height={88}
            className="absolute inset-0 h-full w-full object-cover"
          />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-[0.04em] text-ink-2">
            {role} · {party} · {rep.state}
          </p>
          <h3 className="mt-1 text-xl font-extrabold">{rep.name}</h3>
          {rep.url && (
            <a
              href={rep.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex min-h-11 items-center text-sm text-ink-2 underline underline-offset-2 hover:text-ink"
            >
              {t('website')}
            </a>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-2">
        {rep.phone && (
          <a
            href={telHref(rep.phone)}
            className="ring-gap flex min-h-12 items-center justify-between gap-3 rounded-control border-2 border-go bg-go px-4 py-3 font-bold text-paper no-underline hover:border-go-deep hover:bg-go-deep"
          >
            <span className="inline-flex items-center gap-2">
              <Phone className="h-4 w-4 shrink-0" aria-hidden />
              {t('dcOffice')}
            </span>
            {/* whitespace-nowrap: the number must never break mid-number.
                Under the longer ES label ("Oficina en Washington") at narrow
                widths it is the LABEL that wraps to a second line, never
                "202-225-" / "8050". */}
            <span className="text-sm whitespace-nowrap tabular-nums">{rep.phone}</span>
          </a>
        )}
        {rep.offices.length > 0 && (
          <details className="border-t border-line pt-2">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-bold select-none">
              {t('localOffices')} ({rep.offices.length})
            </summary>
            <ul className="mt-1">
              {rep.offices.map((o, i) => (
                <li key={i} className="border-t border-line first:border-t-0">
                  <a
                    href={telHref(o.phone!)}
                    className="flex min-h-11 items-center justify-between gap-3 text-sm text-ink underline-offset-2 hover:underline"
                  >
                    <span>{o.city}{o.state ? `, ${o.state}` : ''}</span>
                    <span className="tabular-nums text-ink-2">{o.phone}</span>
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

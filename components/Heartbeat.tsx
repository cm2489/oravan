'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

/*
 * The bill's pulse: an EKG line that beats while people are calling.
 * Cold-start rule: render nothing below PULSE_FLOOR so silence reads as
 * neutral, never as "nobody cares." Animation dies under reduced motion
 * (global rule); the count text always carries the meaning.
 */

const PULSE_FLOOR = 3;

export function Heartbeat({ slug }: { slug: string }) {
  const t = useTranslations('bill');
  const [pulse, setPulse] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/heartbeat?slug=${slug}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && !cancelled) setPulse(d.pulse7 ?? 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (pulse < PULSE_FLOOR) return null;

  // Faster beat with more calls, capped so it never reads as alarm.
  const beatSeconds = Math.max(1.1, 2.2 - Math.log10(1 + pulse) * 0.5);

  return (
    <p className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-moss">
      <svg
        aria-hidden
        viewBox="0 0 48 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="ekg h-4 w-12"
        style={{ ['--beat' as string]: `${beatSeconds}s` }}
      >
        <path d="M1 9h12l3-6 5 11 4-8 2 3h20" />
      </svg>
      {t('pulseLabel', { count: pulse })}
    </p>
  );
}

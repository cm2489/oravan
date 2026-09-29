'use client';

import { useTranslations } from 'next-intl';
import { YourRecord } from '@/components/YourRecord';

/*
 * THE CIVIC RECORD, STANDALONE. Since 2026-09-29 the record lives in the Reps
 * tab (owner, UX question Q4 "b + c"; wireframes v2, reps.html), and the call
 * panel's "See your record" lands there, on Your calls. This page stays for
 * every link already out in the world and for the error boundary's escape
 * hatch (app/[locale]/error.tsx, tests/record.spec.ts), and it renders the
 * very same record (components/YourRecord.tsx), with its folded rows open
 * because nothing sits above them here.
 *
 * max-w-5xl + text-h1-bill: the sitewide rail and the sitewide title rung —
 * every sibling page titles at text-h1-bill; bare text-h1 belongs to the home
 * hero alone. Prose takes max-w-read / max-w-note so no line runs the width.
 */
export default function ImpactPageClient() {
  const t = useTranslations('impact');
  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <h1 className="text-h1-bill font-extrabold text-ink">{t('title')}</h1>
      <p className="mt-2 max-w-read text-ink-2">{t('sub')}</p>
      <div className="mt-10">
        <YourRecord standalone />
      </div>
    </div>
  );
}

import { getTranslations } from 'next-intl/server';

/*
 * THE PANEL FOR A BILL OF AN ENDED CONGRESS — what stands where the call panel
 * stands once the bill's Congress has ended before Congress finished it
 * (stage 3 of the new-Congress work, 2026-11-13). The owner decided on Nov 12,
 * 2026 to keep the 119th Congress's bills "as an archive marked 'ended'", and
 * approved the wording printed here the same day.
 *
 * Read by lib/journey.ts `endedDecision`, which answers null for every bill
 * until a Congress is on the ended list (lib/congress.mjs ENDED_CONGRESSES,
 * empty until the January 2027 switch). So today this component never renders.
 *
 * Two kinds reach it:
 *   ended      the approved note: the bill ended with that Congress, and can
 *              only move again as a new bill in a new Congress;
 *   presented  both chambers passed it before the Congress ended and the
 *              record holds no signature yet: the approved "does not yet show
 *              what the president did" line.
 * A law and a decided bill keep the record-only panel (components/
 * SettledPanel.tsx); the page adds the law's small line there.
 *
 * NO CALL APPARATUS (page 1, rule 6: a settled decision shows no call
 * apparatus, and an ended bill is the same in that respect): no stance, no
 * script, no dial, no phone number, no ZIP prompt. How members voted stays on
 * the page, in the vote record under the reading column.
 *
 * It keeps the call panel's silhouette and its `#act` anchor, exactly as the
 * record-only panel does, with the record-only panel's own title ("No call to
 * make") and its tokens: no new colour.
 */

/** The call panel's title-bar geometry (components/ActionPanel.tsx). */
const INNER_RADIUS = 'calc(var(--radius-control)-2px)';

export async function EndedPanel({ kind, text }: { kind: 'ended' | 'presented'; text: string }) {
  const t = await getTranslations('bill');
  return (
    <section aria-labelledby="act" data-ended-panel={kind} className="w-full rounded-control border-2 border-ink bg-paper">
      <h2
        id="act"
        className="bg-ink-deep px-5 py-3 text-xs leading-tight font-bold tracking-[0.06em] text-paper uppercase"
        style={{ borderRadius: `${INNER_RADIUS} ${INNER_RADIUS} 0 0` }}
      >
        {t('settled.title')}
      </h2>
      <div className="p-4 md:p-6">
        <p className="max-w-note text-lg font-bold text-ink" data-ended-note="">
          {text}
        </p>
      </div>
    </section>
  );
}

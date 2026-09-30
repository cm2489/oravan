import { getFormatter, getTranslations } from 'next-intl/server';
import type { RollCall } from '@/lib/types';

/*
 * THE FLOOR ITEM'S LATEST VOTE (Home option B, v2 wireframe 2026-09-29: the
 * week's lead block carries "Latest vote · Senate · Sep 24 · Roll call 243",
 * the vote, a bar and the tally; "Vote bar kept (owner, 2026-09-26)").
 *
 * THE RECORD, QUOTED (Constitution v2, rule 6). The wireframe's own line
 * paraphrased the roll call ("End debate on the bill: 74–25, agreed to · 60
 * needed"). This prints what data/votes.json holds and nothing else: the
 * question and the result verbatim, in English on both locales and marked
 * `lang="en"` (the same way components/VoteRecord.tsx prints them), and the
 * record's own tally. "60 needed" is not in the stored record, so it is not
 * printed.
 *
 * THE BAR IS ONE NEUTRAL METER, NEVER A COLOUR PER POSITION. A vote position
 * is words, never a colour (tests/nonpartisan-render.unit.spec.ts; rule 3):
 * so the bar is a single fill — the Yea share of the roll call — on a track,
 * both in the panel's own paper tints, and it is aria-hidden. The tally under
 * it, in the record's four words, is the information.
 *
 * It sits inside the green enamel panel (components/system/FloorVotePanel.tsx
 * `aside`), so its text uses the panel's pale ink, 8.26:1 on go-deep.
 */
const POSITIONS = ['yea', 'nay', 'present', 'notVoting'] as const;

export async function HomeLatestVote({ rollCall }: { rollCall: RollCall }) {
  const t = await getTranslations('home');
  const tVotes = await getTranslations('votes');
  const format = await getFormatter();
  const date = format.dateTime(new Date(rollCall.date), {
    month: 'short',
    day: 'numeric',
    // A bare YYYY-MM-DD: formatted in UTC or it reads a day early.
    timeZone: 'UTC',
  });
  const { totals } = rollCall;
  const counted = totals.yea + totals.nay + totals.present + totals.notVoting;
  const share = counted > 0 ? Math.round((totals.yea / counted) * 1000) / 10 : 0;
  const shown = POSITIONS.filter((p) => p === 'yea' || p === 'nay' || totals[p] > 0);

  return (
    <div data-latest-vote={rollCall.id} className="grid gap-2 text-sm leading-dark text-go-pale">
      <p className="font-semibold tabular-nums">
        {t('latestVote', { chamber: rollCall.chamber, date, roll: rollCall.roll })}
      </p>
      <p className="text-paper">
        <span className="text-go-pale">{tVotes('asRecorded')}:</span>{' '}
        <q lang="en" className="font-semibold">
          {rollCall.question}
        </q>{' '}
        · <span lang="en">{rollCall.result}</span>
      </p>
      <span aria-hidden="true" className="mt-1 block h-3 w-full overflow-hidden rounded-hair bg-paper/25">
        <span className="block h-full bg-paper" style={{ width: `${share}%` }} />
      </span>
      <p className="tabular-nums">
        {shown.map((p, i) => (
          <span key={p}>
            {i > 0 && ' · '}
            {tVotes(`position.${p}`)} {totals[p]}
          </span>
        ))}
      </p>
    </div>
  );
}

import { useTranslations } from 'next-intl';
import { partyTotalsLine } from '@/lib/party-totals';
import type { RollCallTotals } from '@/lib/types';

/*
 * ONE LINE: HOW EACH PARTY VOTED ON ONE ROLL CALL, AS THE RECORD COUNTS IT.
 *
 *   Republicans 4 yes, 47 no, 2 not voting · Democrats 44 yes, 1 no · Independents 2 yes
 *   Republicanos: 4 sí, 47 no, 2 no votaron · Demócratas: 44 sí, 1 no · Independientes: 2 sí
 *
 * The owner's card l12 (2026-09-29), about the party counts PR #363 lets
 * through the Big Questions lint: "Show me these. I don't see them." It sits
 * under a roll call's tally on the bill page's vote record
 * (components/VoteRecord.tsx) and under each vote group's heading in the
 * settled box (components/SettledPanel.tsx), and nowhere else.
 *
 * WHAT IT PRINTS. The record's own counts (data/votes.json `totalsByParty`),
 * party by party, largest group first (lib/party-totals.ts says why), each
 * position only when at least one member holds it, in the record's order.
 * The party name is the plain group name for the record's letter; a letter
 * with no name in the messages prints as the record writes it. The line is
 * built by lib/party-totals.ts `partyTotalsLine`, which the unit test drives
 * with the real messages in both languages.
 *
 * WHAT IT NEVER DOES (CLAUDE.md rule 3): no colour, no icon, no weight or
 * order that depends on WHICH party a group is. Every group is the same ink
 * text; tests/nonpartisan-render.unit.spec.ts scans this file for a partisan
 * colour or a class chosen by party. No member is named here, and no party is
 * said to have "sided", "won" or "blocked" anything: counts only.
 *
 * Renders nothing when the roll call carries no count by party.
 *
 * Usable from a server component (the vote record) and a client component
 * (the settled box): it only reads translations and props.
 */

export function PartyTotals({
  totals,
  muted = false,
  className = '',
}: {
  /** The roll call's `totalsByParty`. */
  totals: Record<string, RollCallTotals> | null | undefined;
  /** Secondary ink, to sit under a secondary-ink heading (the settled box). */
  muted?: boolean;
  className?: string;
}) {
  const t = useTranslations('partyTotals');
  const line = partyTotalsLine(totals, (key, values) => t(key, values));
  if (!line) return null;
  return (
    <p className={`text-sm tabular-nums ${muted ? 'text-ink-2' : 'text-ink'} ${className}`} data-vote-party-totals="">
      {line}
    </p>
  );
}

import { sitePolicy } from './ended-state.mjs';

/*
 * THE MESSAGES THAT EXIST ONLY FOR THE ENDED STATE, AND WHEN THE BROWSER GETS
 * THEM (stage 3 of the new-Congress work, 2026-11-13).
 *
 * The approved ended wording (`bill.ended.*`, and "Ended" / "Terminado" under
 * `bills.status.ended` and `bills.statusWord.ended`) lives in messages/en.json
 * and es.json like every other string. But the site's layout hands a message
 * catalog to the browser on every page (i18n/client-messages.ts), and the
 * embeds hand both languages' dictionaries to theirs (components/embed/
 * embed-dicts.ts). Shipped today, those sentences would sit in the raw page
 * source of the whole site ("This bill ended with the 119th Congress on
 * January 3, 2027…") months before anything has ended, readable by anyone or
 * any machine that reads the HTML. So:
 *
 *   - the site's browser catalog leaves these keys out while no Congress is on
 *     the ended list (lib/ended-state.mjs sitePolicy), and carries them once
 *     one is: the one browser reader is a bill card's status label
 *     (components/BillCard.tsx, components/NewsLens.tsx), which can read
 *     `bills.status.ended` only then;
 *   - the embeds' dictionaries never carry them: the bill-card widget's long
 *     label is computed on the server and passed in (app/embed/bill-card),
 *     and the action-panel embed's ended frame is rendered on the server.
 *
 * The same holds for the member pages' changeover wording (members who leave,
 * #487): "Served in the {chamber} until January 3, 2027." is printed only for
 * a member whose last day is the ended Congress's (lib/departed-members.ts
 * servedLine, which needs `memberTurnover()`, null while nothing has ended),
 * and the new-member line "No recorded votes yet on a bill Oravan tracks." only
 * when `showsNoVotesYet` allows it (also null-turnover false). Both are
 * rendered on the server, so no browser reads them. What the sixteen mid-term
 * record pages show today (`departedServedOn`, `departedChamber`, `formerRole`,
 * `crumbRecord`) is NOT in this list: those pages display it now.
 * `votesNoneYet` is the superseded first wording, kept in the catalog for the
 * record and shown by no page at all.
 *
 * Server-rendered text reads the full catalog through next-intl as before.
 * tests/bill-rail.unit.spec.ts and tests/ended-member-messages.unit.spec.ts
 * pin both halves.
 */
export const ENDED_ONLY_KEYS = [
  'bill.ended',
  'bills.status.ended',
  'bills.statusWord.ended',
  'rep.departedServed',
  'rep.votesNoneYet',
  'rep.votesNoneYetTracked',
] as const;

type Json = { [key: string]: unknown };

/** A copy of `catalog` without the ENDED_ONLY_KEYS, every other key in its
 *  original order (so the result serializes exactly as a catalog that never
 *  had them). */
export function withoutEndedMessages<T extends Json>(catalog: T): T {
  const out: Json = { ...catalog };
  for (const path of ENDED_ONLY_KEYS) {
    const [top, ...rest] = path.split('.');
    const leaf = rest.pop()!;
    // Copy every container on the path before deleting from it.
    const parent: Json = (out[top] = { ...(out[top] as Json) });
    let node: Json = parent;
    for (const key of rest) node = node[key] = { ...(node[key] as Json) };
    delete node[leaf];
  }
  return out as T;
}

/** The site's browser catalog: without the ended-only keys unless a Congress
 *  has ended. */
export function browserMessagesFor<T extends Json>(catalog: T, anyEnded = sitePolicy().ended.length > 0): T {
  return anyEnded ? catalog : withoutEndedMessages(catalog);
}

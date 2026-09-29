/**
 * The ONE thing Oravan's AI writers may say about a political party: how many
 * of its members voted a given way on a recorded vote, copied from that roll
 * call's own count by party (data/votes.json `totalsByParty`, lib/votes-core.mjs).
 * Nothing else — no party as an actor, no motive, no stance, no reaction.
 *
 * WHY (2026-09-29, the owner's card l12, delegated: "You handle the rule
 * change. This is not that big of a deal to me, I just need it to work.").
 * "Every Democrat and 4 Republicans voted yes" is a fact of the record, and
 * PR #363 teaches the rule-3 lint (lib/moments-gate.mjs `lintForbidden`) to
 * let exactly that shape through while still refusing a party named any other
 * way. The prompts of scripts/moment-updates.mjs (both of them) and
 * scripts/moment-draft.mjs said "Never name a political party"; this module is
 * the one place their party rule, and the figures it points at, now come from.
 *
 * THE PROMPT OFFERS WHAT THE GATE ACCEPTS, AND NO MORE. `partyCountsPassLint`
 * asks the live lint whether the canonical count sentences below pass, in
 * both languages. Until #363 is on the same tree, they do not, and every
 * writer keeps "Never name a political party" and is shown no party figures:
 * telling a model it may write a sentence the lint then throws away would
 * cost the nightly its summaries (a rejected summary leaves the previous one
 * standing) and its one-liners (a rejected line falls back to the raw
 * record). Once #363 is merged, the same code offers the counts with no
 * further change. Merge order therefore cannot break a night.
 *
 * Pure: no I/O, no clock. Pinned by tests/party-count-rule.unit.spec.ts.
 */
import { lintForbidden } from './moments-gate.mjs';

/** The record's party letters this module can name, in the plain group name
 *  a prompt uses. A letter not listed here is never offered to a writer. */
export const PARTY_GROUP_NAME = { R: 'Republicans', D: 'Democrats', I: 'independents' };

const POSITIONS = [
  ['yea', 'Yeas'],
  ['nay', 'Nays'],
  ['present', 'Present'],
  ['notVoting', 'Not Voting'],
];

/**
 * The sentence shapes the rule allows, one per language and form, with N and M
 * standing for the record's numbers. The prompt shows them with the letters,
 * so a model has no sample number to copy; the probe `partyCountsPassLint`
 * runs them with numbers filled in (PARTY_COUNT_EXAMPLES), so the prompt can
 * never recommend a shape the lint refuses.
 */
export const PARTY_COUNT_SHAPES = {
  en: ['N Republicans and M Democrats voted yes', 'Republicans: N yea, M nay'],
  es: ['N republicanos y M demócratas votaron a favor', 'republicanos: N a favor, M en contra'],
};
const fill = (shape) => shape.replace(/\bN\b/g, '4').replace(/\bM\b/g, '43');
/** The shapes with numbers in them: what the probe asks the lint about. */
export const PARTY_COUNT_EXAMPLES = {
  en: PARTY_COUNT_SHAPES.en.map(fill),
  es: PARTY_COUNT_SHAPES.es.map(fill),
};

/** True when the rule-3 lint on this tree lets every example through. */
export function partyCountsPassLint() {
  return ['en', 'es'].every((lang) => PARTY_COUNT_EXAMPLES[lang].every((s) => lintForbidden(`${s}.`, lang).length === 0));
}

/**
 * One roll call's count by party as prompt text, the record's numbers
 * verbatim, largest group first (the order the page prints, lib/party-totals.ts):
 *   by party, the record's own count: Republicans (R) Yeas 4, Nays 49, Present 0, Not Voting 0; Democrats (D) …
 * Empty string when the roll call carries none, or none this module can name.
 *
 * @param {Record<string, { yea: number, nay: number, present: number, notVoting: number }> | null | undefined} totalsByParty
 */
export function partyTotalsPromptText(totalsByParty) {
  const groups = Object.entries(totalsByParty ?? {})
    .filter(([party]) => Object.hasOwn(PARTY_GROUP_NAME, party))
    .map(([party, c]) => ({ party, c, size: POSITIONS.reduce((n, [k]) => n + (Number(c?.[k]) || 0), 0) }))
    .filter((g) => g.size > 0)
    .sort((a, b) => b.size - a.size || (a.party < b.party ? -1 : a.party > b.party ? 1 : 0));
  if (groups.length === 0) return '';
  return `by party, the record's own count: ${groups
    .map((g) => `${PARTY_GROUP_NAME[g.party]} (${g.party}) ${POSITIONS.map(([k, label]) => `${label} ${Number(g.c[k]) || 0}`).join(', ')}`)
    .join('; ')}`;
}

/** The rule as it has always read, for a writer that may name no party. */
export const NEVER_NAME_A_PARTY = '- Never name a political party, in either language.';

/**
 * The prompt's party rule, as one bullet.
 *
 * @param {{ figures: string, allowed?: boolean }} opts
 *   `figures` names where the "by party" figures sit in THIS prompt (e.g.
 *   'the "by party" figures of that roll call in the record above'); an empty
 *   string means this prompt shows none, and then no party may be named.
 *   `allowed` defaults to what the lint on this tree accepts; tests pass it.
 */
export function partyRule({ figures, allowed = partyCountsPassLint() }) {
  if (!allowed || !figures) return NEVER_NAME_A_PARTY;
  const [enA, enB] = PARTY_COUNT_SHAPES.en;
  const [esA, esB] = PARTY_COUNT_SHAPES.es;
  return (
    `- Never name a political party, with ONE exception: how many members of a party voted a given way on a recorded vote, copied exactly from ${figures}, in one of these forms only (N and M stand for those figures) — EN "${enA}" or "${enB}"; ES "${esA}" or "${esB}". ` +
    'A party appears ONLY inside such a count: never as the subject of anything else, never without its number ("Republicans voted no" is refused), never with a motive, stance, strategy or reaction, and never as "GOP" or "Democratic Party". A count those figures do not give is not written.'
  );
}

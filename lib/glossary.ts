/*
 * THE GLOSSARY REGISTRY — ids, sections, sources, and the URL math. No JSX,
 * no messages (issue #181; expanded 2026-09-28, UX inventory C05/G13).
 *
 * Congress runs on a vocabulary that nothing on the page explains: a bill is
 * "placed on the Senate Legislative Calendar under General Orders", a
 * nomination is "reported by committee", a floor fight is a cloture motion on
 * a motion to proceed. This module is what a server page, the in-place
 * popover, the /glossary page and the tests all agree on.
 *
 * THE DATA lives in lib/glossary-terms.ts (one row per term: id, section,
 * official source, auto-marking phrases). THE PROSE lives in messages/en.json
 * + messages/es.json under `glossary.terms.<id>`, like every other
 * user-facing string (CLAUDE.md rule 5).
 *
 * THE ID IS THE ANCHOR. `#cloture` is a URL someone can paste into a message,
 * so the id doubles as the page's `<section id>`. That makes an id a PUBLIC,
 * PERMANENT string: renaming one breaks every link anybody ever sent.
 * tests/glossary.unit.spec.ts pins the exact list for that reason — a rename
 * is a decision, not a refactor, and new terms are appended.
 *
 * WHAT AN ENTRY MAY SAY (issue #181's constraints, kept for the expansion):
 * 2–4 sentences of plain-words MECHANICS, never stakes, never who-wins
 * framing, no dates, no predictions, and no example that implies a vote date.
 * The calendar entries carry that last one explicitly — being on a calendar
 * schedules nothing. One entry names months, and only because its mechanic IS
 * a fixed calendar span: `fiscal-year` (October 1 to September 30). That is
 * the one exemption the copy test allows.
 */
import { GLOSSARY_ENTRIES, type GlossaryCategory } from './glossary-terms';

export { GLOSSARY_ENTRIES, type GlossaryCategory };

export type GlossaryTermId = (typeof GLOSSARY_ENTRIES)[number]['id'];
export type GlossaryEntry = (typeof GLOSSARY_ENTRIES)[number];

/**
 * Every id, in registry order: the first twelve exactly as they shipped
 * (anchors people may already have sent), then the 2026-09-28 expansion.
 */
export const GLOSSARY_TERM_IDS: readonly GlossaryTermId[] = GLOSSARY_ENTRIES.map((e) => e.id);

/**
 * The /glossary page's sections, in the order it prints them: what happens on
 * the floor first, because that is where the record's vocabulary is densest,
 * and the people and seats last.
 */
export const GLOSSARY_CATEGORIES: readonly GlossaryCategory[] = [
  'floor',
  'committees',
  'lawmaking',
  'votes',
  'budget',
  'nominations',
  'people',
];

const BY_ID = new Map<string, GlossaryEntry>(GLOSSARY_ENTRIES.map((e) => [e.id, e]));

/** One term's row. Typed ids only, so a lookup can never miss. */
export function glossaryEntry(id: GlossaryTermId): GlossaryEntry {
  return BY_ID.get(id)!;
}

/** The page's own path. One constant, so the footer, the sitemap and the
 *  tests cannot drift apart. */
export const GLOSSARY_PATH = '/glossary';

/** The locale-relative href for one term's section, for anything that links
 *  INTO the page (an inline term no longer does — it opens in place). Passed
 *  to the `Link` from `@/i18n/navigation`, which adds the `/es` prefix. */
export function glossaryHref(id: GlossaryTermId): string {
  return `${GLOSSARY_PATH}#${id}`;
}

/** Narrowing guard for code reading an id out of untyped data (a message key
 *  scan in a test, a status→term map). */
export function isGlossaryTermId(value: string): value is GlossaryTermId {
  return BY_ID.has(value);
}

/*
 * A NOMINATION STATUS LABEL THAT IS ITSELF A TERM.
 *
 * Some of `nominations.status.*` are not a description OF a procedural term —
 * they ARE one, word for word ("Reported by committee", "On the Executive
 * Calendar", "Confirmed by the Senate", "Returned to the President" — the last
 * is the Senate's own wording under Rule XXXI). Those get wrapped whole rather
 * than tagged mid-sentence, which is why the message strings stay untouched.
 *
 * Every other status stays plain text — including `floor` ("Senate floor
 * activity"), `scheduled` and `hearing` ("Committee hearing held"), which are
 * Oravan's own summaries of a stage rather than the Senate's name for a thing.
 *
 * Shared by app/[locale]/nominations/[slug]/page.tsx (the provenance line) and
 * components/MomentNominationCard.tsx (the card's meta line), so the same
 * status can never be glossed on one surface and bare on the other.
 */
export const NOMINATION_STATUS_TERMS: Readonly<Record<string, GlossaryTermId>> = {
  reported: 'reported-by-committee',
  exec_calendar: 'executive-calendar',
  confirmed: 'confirmation',
  returned: 'returned-nomination',
};

/*
 * THE NEAR-MISS, WRITTEN DOWN SO NOBODY HELPFULLY WIRES IT.
 *
 * `bill.journey.nowConference` reads "both chambers are reconciling their
 * versions", and the only English word it shares with `budget-reconciliation`
 * is a coincidence. That sentence is a CONFERENCE — two chambers settling the
 * differences between two texts of one bill. Budget reconciliation is a
 * special procedure begun by a budget resolution that caps Senate debate.
 * Linking one to the other would hand a reader a confident explanation of
 * something that is not happening, which is worse than no link at all. The
 * automatic marking never matches it either: `budget-reconciliation` only
 * matches "budget reconciliation", "reconciliation bill" and "reconciliation
 * process" (tests/glossary.unit.spec.ts pins that the sentence stays bare).
 *
 * Same rule caught two more on the 2026-08-12 sweep of the strings #220 and
 * #222 added: `nowPassedStale` / `nowPassedBackStale` name no procedural term,
 * and `backTrailerStates` describes Article V ratification — a real procedure,
 * and one the glossary covers only inside `joint-resolution`, so it stays
 * unwired. Absence is a finding; an approximate link is a claim.
 */

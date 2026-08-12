/*
 * THE PROCEDURAL GLOSSARY — the registry, and nothing else (issue #181).
 *
 * Congress runs on a vocabulary that nothing on the page explains: a bill is
 * "placed on the Senate Legislative Calendar under General Orders", a
 * nomination is "reported by committee", a floor fight is a cloture motion on
 * a motion to proceed. Until this file existed, every occurrence of one of
 * those needed an ad-hoc inline gloss written into the surrounding sentence,
 * or it shipped as jargon (the `annual-defense-policy` summary carries such a
 * gloss today, which is what opened the issue).
 *
 * WHAT LIVES HERE AND WHAT DOES NOT. This module holds the ID list and the URL
 * math — pure data, no JSX, no messages — so a server page, a client popover
 * and a test can all agree on the same eleven ids without any of them
 * importing the others' concerns. The PROSE lives in messages/en.json +
 * messages/es.json under `glossary.terms.<id>`, exactly like every other
 * user-facing string (CLAUDE.md's bilingual hard rule), and is pinned in both
 * languages by tests/glossary.unit.spec.ts.
 *
 * THE ID IS THE ANCHOR. `#cloture` is a URL someone can paste into a message,
 * and the issue names that form specifically, so the id doubles as the page's
 * `<section id>` and as the fragment `glossaryHref` builds. That makes an id a
 * PUBLIC, PERMANENT string: renaming one breaks every link anybody ever sent.
 * tests/glossary.unit.spec.ts pins the exact list for that reason — a rename
 * is a decision, not a refactor.
 *
 * WHAT AN ENTRY MAY SAY (issue #181's constraints, verbatim): 2–4 sentences of
 * plain-words MECHANICS, never stakes, never who-wins framing, no dates, no
 * predictions, and no example that implies a vote date. The calendar entries
 * carry that last one explicitly — being on a calendar schedules nothing, and
 * DESIGN.md's open printed-date ruling is the reason a glossary entry is the
 * wrong place to imply otherwise.
 */

/**
 * The first batch, in the order the page prints them: the Senate's debate
 * machinery, then the calendars, then the committee and drafting terms, then
 * the two special procedures. Ordered by how a reader meets them, not
 * alphabetically — alphabetical would open on "amendment in the nature of a
 * substitute", which is the least likely thing anyone arrived asking about.
 *
 * `germaneness` is in the issue's list under "as they come up" and is NOT in
 * this batch — see the PR body for why it was left for the next one.
 */
export const GLOSSARY_TERM_IDS = [
  'cloture',
  'unanimous-consent',
  'motion-to-proceed',
  'cloture-on-the-motion-to-proceed',
  'legislative-calendar',
  'union-calendar',
  'executive-calendar',
  'reported-by-committee',
  'amendment-in-the-nature-of-a-substitute',
  'budget-reconciliation',
  'cra-disapproval',
] as const;

export type GlossaryTermId = (typeof GLOSSARY_TERM_IDS)[number];

/** The page's own path. One constant, so the footer, the sitemap, the popover
 *  link and the tests cannot drift apart. */
export const GLOSSARY_PATH = '/glossary';

/** The locale-relative href for one term's section. Passed to the `Link` from
 *  `@/i18n/navigation`, which is what adds the `/es` prefix — never hand-built
 *  here, or the Spanish popover would link out of its own locale. */
export function glossaryHref(id: GlossaryTermId): string {
  return `${GLOSSARY_PATH}#${id}`;
}

/** Narrowing guard for code reading an id out of untyped data (a message key
 *  scan in a test, a status→term map). Cheap, and it keeps the cast out of the
 *  call sites. */
export function isGlossaryTermId(value: string): value is GlossaryTermId {
  return (GLOSSARY_TERM_IDS as readonly string[]).includes(value);
}

/*
 * A NOMINATION STATUS LABEL THAT IS ITSELF A TERM.
 *
 * Two of `nominations.status.*` are not a description OF a procedural term —
 * they ARE one, word for word ("Reported by committee", "On the Executive
 * Calendar"). Those get wrapped whole rather than tagged mid-sentence, which
 * is why the message strings stay untouched: no rich-text tag, no change to
 * what the Spanish reviewer sees, and no third caller of these keys can be
 * broken by a tag it does not handle.
 *
 * Every other status stays plain text — including `floor` ("Senate floor
 * activity") and `scheduled`, which are Oravan's own summaries of a stage
 * rather than the Senate's name for a thing.
 *
 * Shared by app/[locale]/nominations/[slug]/page.tsx (the provenance line) and
 * components/MomentNominationCard.tsx (the card's meta line), so the same
 * status can never be glossed on one surface and bare on the other.
 */
export const NOMINATION_STATUS_TERMS: Readonly<Record<string, GlossaryTermId>> = {
  reported: 'reported-by-committee',
  exec_calendar: 'executive-calendar',
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
 * something that is not happening, which is worse than no link at all.
 *
 * Same rule caught two more on the 2026-08-12 sweep of the strings #220 and
 * #222 added: `nowPassedStale` / `nowPassedBackStale` name no procedural term,
 * and `backTrailerStates` describes Article V ratification — a real procedure,
 * and one this batch has no entry for. Absence is a finding; an approximate
 * link is a claim.
 */

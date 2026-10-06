import { createElement, type ReactNode } from 'react';

/*
 * A card's heading text: the decoded headline when there is one, else the
 * record's own title.
 *
 * The decoded headline is in the page's language, so it is left unmarked. The
 * record's title is English on /es too (ruling V4: a translated quote is a
 * paraphrase in quotation marks), so when a card falls back to it the text is
 * marked `lang="en"`. A screen reader then switches voice instead of reading
 * English words with Spanish pronunciation (CLAUDE.md rule 7). The floor and
 * vote cards on /today mark the same fallback inline; the bill-card family
 * goes through this one component so a card cannot forget to.
 *
 * The wrapper is an inline `span` with no class, and no stylesheet in this
 * repo is keyed on `lang`, so nothing a reader sees changes.
 *
 * A .ts file with `createElement`, not a .tsx file: the unit project's loader
 * compiles JSX for Playwright's own component runner, which cannot be rendered
 * with react-dom/server, and tests/card-title-lang.unit.spec.ts renders this.
 */
export function HeadlineOrTitle({ headline, title }: { headline: string | null; title: string }): ReactNode {
  return headline ?? createElement('span', { lang: 'en' }, title);
}

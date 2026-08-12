import type { ReactNode } from 'react';
import { GlossaryTerm } from '@/components/GlossaryTerm';
import type { GlossaryTermId } from '@/lib/glossary';

/*
 * next-intl rich-text tag handlers for the glossary, so a message can carry
 * the link INSIDE its own sentence instead of beside it:
 *
 *   t.rich('moments.howMadeRule2', { cloture: glossaryTag('cloture') })
 *
 * ── WHY THIS IS ITS OWN FILE, AND NOT A SECOND EXPORT FROM GlossaryTerm.tsx ──
 *
 * That file carries 'use client', which makes EVERY one of its exports a
 * client reference — including a plain helper. A server component importing
 * `glossaryTag` from there builds cleanly and then throws at render:
 * "Attempted to call glossaryTag() from the server but glossaryTag is on the
 * client." (Observed on /questions before this split; the page 500'd in both
 * locales.) The distinction is calling versus rendering: a server component
 * may RENDER `<GlossaryTerm>` freely — that is just an element — but it may
 * not CALL a function that lives on the client.
 *
 * So this module has no directive. It is imported by server components, runs
 * on the server, and the only thing it produces is JSX naming the client
 * component — exactly what the boundary is for.
 *
 * ── THE TAG NAME IS THE CALL SITE'S, NOT THE TERM'S ─────────────────────────
 *
 * `glossaryTag` maps one handler to one term, and the message decides what to
 * call the tag. The two are not always the same word: components/
 * BillJourney.tsx opens a single `<floorCalendar>` tag whose term depends on
 * which calendar the record actually named, and builds its own handler rather
 * than using this one.
 */
export function glossaryTag(id: GlossaryTermId) {
  // Named rather than an arrow: eslint's react/display-name reads any
  // JSX-returning function as a component definition, and an anonymous one is
  // an error. It is a chunk handler, not a component — the name is for the
  // linter and the React devtools stack, nothing else.
  return function GlossaryTagChunk(chunks: ReactNode) {
    return <GlossaryTerm id={id}>{chunks}</GlossaryTerm>;
  };
}

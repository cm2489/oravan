import { Fragment, type ReactNode } from 'react';
import { GlossaryTerm } from '@/components/GlossaryTerm';
import type { GlossaryTermId } from '@/lib/glossary';
import { splitGlossaryTerms, type GlossaryLocale } from '@/lib/glossary-match';

/*
 * next-intl rich-text tag handlers for the glossary, so a message can carry
 * the term INSIDE its own sentence instead of beside it:
 *
 *   t.rich('moments.howMadeRule2', { cloture: glossaryTag('cloture') })
 *
 * …and, since 2026-09-28, the automatic marking of terms that are already in
 * a sentence: `glossify` for a plain string, `glossifyRich` for what
 * `t.rich` returns.
 *
 * ── WHY THIS IS ITS OWN FILE, WITH NO DIRECTIVE ──────────────────────────────
 *
 * Every export of a 'use client' file is a client reference, so a server
 * component CALLING a helper from one throws at render ("Attempted to call
 * glossaryTag() from the server" — observed on /questions once; the page 500'd
 * in both locales). This module has no directive: it is imported by server
 * components, runs on the server, and produces JSX naming components.
 *
 * ── THE TAG NAME IS THE CALL SITE'S, NOT THE TERM'S ─────────────────────────
 *
 * `glossaryTag` maps one handler to one term, and the message decides what to
 * call the tag. components/BillJourney.tsx opens a single `<floorCalendar>`
 * tag whose term depends on which calendar the record actually named, and
 * builds its own handler rather than using this one.
 */
export function glossaryTag(id: GlossaryTermId) {
  // Named rather than an arrow: eslint's react/display-name reads any
  // JSX-returning function as a component definition, and an anonymous one is
  // an error. It is a chunk handler, not a component.
  return function GlossaryTagChunk(chunks: ReactNode) {
    return <GlossaryTerm id={id}>{chunks}</GlossaryTerm>;
  };
}

/**
 * `glossaryTag`, bound to one section's `seen`: the chunk is marked only when
 * the term is not already marked in that section, and marking it records it.
 * For hand-wired labels that share a section with automatically marked text
 * (the tally line under a roll call on /today).
 */
export function glossaryTagOnce(id: GlossaryTermId, seen: Set<GlossaryTermId>) {
  return function GlossaryTagOnceChunk(chunks: ReactNode) {
    if (seen.has(id)) return <>{chunks}</>;
    seen.add(id);
    return <GlossaryTerm id={id}>{chunks}</GlossaryTerm>;
  };
}

/**
 * Mark the glossary terms already present in `text` (lib/glossary-match.ts
 * has the rules). `seen` is the caller's, one Set per section: a term marked
 * once in a section stays plain the next time. `locale` is the language the
 * TEXT is in — the record's own English lines are matched as English on /es
 * too, while the definition that opens is always in the page's language.
 */
export function glossify(text: string, locale: GlossaryLocale, seen: Set<GlossaryTermId>): ReactNode {
  const parts = splitGlossaryTerms(text, locale, seen);
  if (parts.length === 1 && typeof parts[0] === 'string') return parts[0];
  return parts.map((part, i) =>
    typeof part === 'string' ? (
      <Fragment key={i}>{part}</Fragment>
    ) : (
      <GlossaryTerm key={i} id={part.id}>
        {part.text}
      </GlossaryTerm>
    )
  );
}

/**
 * The same, over what `t.rich` returns: its top-level strings are marked, and
 * every element — a tag's own chunk, a link, a styled span — is passed through
 * untouched. Never descending into an element is what keeps a mark out of
 * links and out of another term.
 */
export function glossifyRich(
  node: ReactNode,
  locale: GlossaryLocale,
  seen: Set<GlossaryTermId>
): ReactNode {
  if (typeof node === 'string') return glossify(node, locale, seen);
  if (!Array.isArray(node)) return node;
  return node.map((child, i) =>
    typeof child === 'string' ? <Fragment key={`g${i}`}>{glossify(child, locale, seen)}</Fragment> : child
  );
}

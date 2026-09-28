import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { GlossaryPopover } from '@/components/GlossaryPopover';
import type { GlossaryTermId } from '@/lib/glossary';

/*
 * ONE GLOSSED TERM, resolved on the server (issue #181; reworked 2026-09-28).
 *
 * The term and its definition are ONE string each per language
 * (`glossary.terms.<id>.term` / `.body`), read here and handed to the client
 * popover as plain props. The /glossary page reads the same keys, so the short
 * version can never drift from the long one, because there is no short
 * version.
 *
 * ── WHY THIS HALF HAS NO 'use client' ────────────────────────────────────
 *
 * It used to be the client component, reading `useTranslations('glossary')`
 * in the browser — which meant every page shipped every definition in its
 * message payload whether it showed one or not. With the glossary grown from
 * twelve entries to well over a hundred, that is tens of kilobytes on every
 * page for nothing. Resolved here, a page carries only the definitions it
 * actually marks, and i18n/client-messages.ts drops `glossary.terms` from
 * the client provider entirely.
 *
 * The cost is the same rule components/glossary-tags.tsx already lives by:
 * this may be RENDERED only from server components. A 'use client' module
 * that imported it would run `useTranslations('glossary')` in the browser
 * against a provider that no longer has the terms, and throw
 * (tests/glossary.unit.spec.ts pins that no client module imports it).
 *
 * `children` are the words as they appear in the sentence (a message's own
 * tagged words, or the record's own text); without them the entry's own term
 * name is printed.
 *
 * `lang` is the PAGE's language, stamped on the definition box: a term can sit
 * inside the record's English (`lang="en"` on /es), and a Spanish definition
 * opening in there would otherwise be read aloud in an English voice.
 *
 * ── THE AI LABEL IN EVERY BOX (CLAUDE.md rule 4) ─────────────────────────
 *
 * "Every AI-written word is labeled where it first appears." The definitions
 * were drafted by AI from the official page cited under each on /glossary, and
 * for most readers this box is where one first appears. So every box carries
 * the site's own AI mark (the unboxed `Chip tone="ai"` caption the bill page
 * uses at first contact). Its caption and mark are read here and handed down
 * as two more strings. It is plain text, not a link: the box is a
 * description, not a dialog, and a link inside it would put a second tab stop
 * behind every glossed word (tests/glossary.spec.ts pins that the box holds
 * nothing to operate). The link to the AI-content policy lives at the top of
 * /glossary instead.
 */
export function GlossaryTerm({ id, children }: { id: GlossaryTermId; children?: ReactNode }) {
  const t = useTranslations('glossary');
  const tc = useTranslations('common');
  const locale = useLocale();
  const label = t(`terms.${id}.term`);
  return (
    <GlossaryPopover
      termId={id}
      label={label}
      body={t(`terms.${id}.body`)}
      aiNote={t('aiNote')}
      aiMarker={tc('aiMarker')}
      lang={locale}
    >
      {children ?? label}
    </GlossaryPopover>
  );
}

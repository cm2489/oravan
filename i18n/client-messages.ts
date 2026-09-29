import type { AbstractIntlMessages } from 'next-intl';

/*
 * WHAT THE BROWSER'S MESSAGE PROVIDER CARRIES — everything except the
 * glossary's definitions.
 *
 * `<NextIntlClientProvider>` with no `messages` prop serialises the whole
 * catalog into every page's payload, so client components can call
 * `useTranslations`. The glossary's `terms` block is the one part no client
 * component reads: since 2026-09-28 every definition is resolved on the
 * server (components/GlossaryTerm.tsx) and handed to the popover as props.
 * Left in, it would ride along on every page — well over a hundred entries
 * in each language, on thousands of prerendered pages — for nothing.
 *
 * The rest of `glossary` (the page chrome) stays: dropping less than we could
 * is safe, dropping something a client component reads is a runtime throw.
 * tests/glossary.unit.spec.ts pins both halves.
 */
export function clientMessages(messages: AbstractIntlMessages): AbstractIntlMessages {
  const glossary = messages.glossary;
  if (!glossary || typeof glossary !== 'object') return messages;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { terms, ...chrome } = glossary as AbstractIntlMessages;
  return { ...messages, glossary: chrome };
}

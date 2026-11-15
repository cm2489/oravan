import type { AbstractIntlMessages } from 'next-intl';
import { browserMessagesFor } from '@/lib/ended-messages';

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
 *
 * Also left out while no Congress has ended: the strings that exist only for
 * the ended state (lib/ended-messages.ts, 2026-11-13). And always left out:
 * `namesPage`, the shared-name page's strings, read only on the server.
 */
export function clientMessages(messages: AbstractIntlMessages): AbstractIntlMessages {
  // `namesPage` (2026-11-15, the shared-name page, app/[locale]/names): read only
  // on the server, by that page. Left in, it would ride along on every page and
  // change every prerendered page on the site for nothing.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { namesPage, ...rest } = messages;
  const withoutEnded = browserMessagesFor(rest);
  const glossary = withoutEnded.glossary;
  if (!glossary || typeof glossary !== 'object') return withoutEnded;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { terms, ...chrome } = glossary as AbstractIntlMessages;
  return { ...withoutEnded, glossary: chrome };
}

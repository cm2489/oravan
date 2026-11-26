import type { ReactNode } from 'react';

/**
 * THE RECORD'S OWN ENGLISH WORDS, INSIDE A PAGE (2026-11-25).
 *
 * Some lines on a page are the official record's own sentence, printed
 * unchanged in both editions (owner ruling V4; page 1 rule 6: the record is
 * quoted, never narrated): the Daily Digest's "12 noon, Friday, November 27",
 * a bill's last action ("Rules Committee Resolution H. Res. 1665 Reported to
 * House…"). They are marked `lang="en"` so a screen reader reads them as
 * English (rule 7).
 *
 * An outside review of the Spanish edition read those lines as English left
 * untranslated. So on the Spanish edition they are also set off in Spanish
 * quotation marks, «…», outside the English span: the reader sees a quotation
 * from the record, and the marks are read as Spanish punctuation. The English
 * edition prints them as before, with no marks.
 */
export function RecordWords({
  locale,
  children,
  className,
}: {
  locale: string;
  children: ReactNode;
  className?: string;
}) {
  const words = (
    <span lang="en" className={className}>
      {children}
    </span>
  );
  return locale === 'es' ? <>«{words}»</> : words;
}

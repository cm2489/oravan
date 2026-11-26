/** Congress-style display citation from bill type + number, e.g. "S.J.Res. 99". */
const TYPE_LABELS: Record<string, string> = {
  hr: 'H.R.',
  s: 'S.',
  hres: 'H.Res.',
  sres: 'S.Res.',
  hjres: 'H.J.Res.',
  sjres: 'S.J.Res.',
  hconres: 'H.Con.Res.',
  sconres: 'S.Con.Res.',
};

export function formatCitation(billType: string, billNumber: number): string {
  return `${TYPE_LABELS[billType.toLowerCase()] ?? billType.toUpperCase()} ${billNumber}`;
}

/**
 * Shortens `text` to at most `max` characters at a word boundary, never inside
 * a word (2026-11-25, the outside reviews of the Spanish edition, which read
 * "…horas extras federale"). `ellipsis` is added only where the surface
 * already printed one; it counts toward `max`. Trailing commas, colons and
 * dashes are dropped before it. A single word longer than half the room is
 * the one case still cut mid-word, so a short result never stands in for a
 * long title.
 */
export function cutAtWord(text: string, max: number, ellipsis = ''): string {
  if (text.length <= max) return text;
  const room = Math.max(1, max - ellipsis.length);
  // One character past the room: if it is a space, the room ends on a whole word.
  const span = text.slice(0, room + 1);
  const space = span.search(/\s\S*$/);
  const head = space > room / 2 ? span.slice(0, space) : text.slice(0, room);
  return head.replace(/[\s,;:–—-]+$/u, '') + ellipsis;
}

/*
 * US CONVENTIONS FOR BOTH EDITIONS (2026-11-25). The Spanish edition is
 * written for Spanish speakers in the United States, so its numbers and
 * times follow es-US: "323,972,953,000" and "12:00 p.m. EST", not the "es"
 * forms "323.972.953.000" and "12:00 GMT-5" an outside review read. next-intl
 * formats with the route's own locale ("es"), and its locale also drives the
 * site's links, so it stays "es"; the places where the two differ in print
 * (grouped counts, clock times with a zone) format through these helpers.
 */
export function intlLocale(locale: string): 'es-US' | 'en-US' {
  return locale === 'es' ? 'es-US' : 'en-US';
}

/** A count, grouped the US way in both editions ("3,392"). */
export function formatCount(n: number, locale: string): string {
  return new Intl.NumberFormat(intlLocale(locale)).format(n);
}

/** A full instant with its clock time and zone ("27 nov 2026, 12:00 p.m. EST"),
 *  in the server's zone as next-intl's formatter used. `year: false` drops the year. */
export function formatInstant(value: string | Date, locale: string, { year = true }: { year?: boolean } = {}): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    ...(year ? { year: 'numeric' as const } : {}),
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
}

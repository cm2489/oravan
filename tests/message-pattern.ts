/*
 * FIND A RENDERED SENTENCE BY ITS MESSAGE KEY, NOT BY ITS WORDS.
 *
 * Specs assert copy through `messages/*.json` so a wording change never
 * reddens a test whose promise is unchanged. Most keys can be matched as-is;
 * this helper is for the ones carrying an argument the spec does not own — a
 * formatted date, a word count — where the page's rendering of that argument
 * is not what the test is about.
 *
 * `messagePattern(m.votes.coverage)` → /Roll-call votes recorded since .+?\./
 * `messagePattern(m.bill.tldrMeta, { count: 5 })` pins `{count}` and leaves
 * `{seconds}` open.
 *
 * Plain `{arg}` placeholders only. A select, a plural or a rich tag is refused
 * loudly rather than matched loosely: those have their own words inside the
 * braces, and a wildcard over them would stop asserting anything.
 */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function messagePattern(
  message: string,
  fixed: Record<string, string | number> = {}
): RegExp {
  if (/\{\s*\w+\s*,/.test(message) || /<\w+>/.test(message)) {
    throw new Error(`messagePattern: plain {arg} placeholders only — got ${JSON.stringify(message)}`);
  }
  const parts = message.split(/\{(\w+)\}/);
  const source = parts
    .map((part, i) => {
      if (i % 2 === 0) return escape(part);
      return part in fixed ? escape(String(fixed[part])) : '.+?';
    })
    .join('');
  return new RegExp(source);
}

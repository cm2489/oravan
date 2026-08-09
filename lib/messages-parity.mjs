/**
 * The bilingual parity rule, import-free, so the unit suite can exercise it
 * without running the gate's file I/O — same split as
 * lib/rollover-tripwire.mjs / scripts/check-rollover-tripwire.mjs and
 * lib/moments-gate.mjs / scripts/check-moments.mjs. The CLI wrapper is
 * scripts/check-messages-parity.mjs.
 *
 * Two halves:
 *
 *   1. KEYS. messages/en.json and messages/es.json must expose exactly the
 *      same flattened key set. A key present in one locale and not the other
 *      crashes (or silently anglicizes) the other locale at runtime.
 *
 *   2. ICU ARGUMENTS. For every shared key, the two messages must take the
 *      same set of placeholder names. The key check alone cannot see inside a
 *      value, so "Browse all {count} active bills" / "Explorar proyectos
 *      activos" was full parity by the old gate and a silently degraded
 *      Spanish string in production — the number simply stops being said, in
 *      the language with no second reviewer. The reverse is louder and worse:
 *      an argument only ES names has no caller passing it, and next-intl
 *      throws on the ES render.
 *
 * What half 2 deliberately does NOT compare is the ARGUMENT TYPE. English
 * "119th Congress" needs `{congress, selectordinal, ...}` and Spanish
 * "Congreso 119" does not; bill.congressLabel ships exactly that pair and it
 * is correct in both languages. The names are what a caller must pass and so
 * what has to match; the grammar around them is the translator's.
 */

const SUBMESSAGE_TYPES = new Set(['plural', 'select', 'selectordinal']);

/**
 * Every placeholder name an ICU message takes.
 *
 * A regex over /\{(\w+)\}/ would have been shorter and wrong: it cannot see
 * `{count, plural, one {# bill} other {# bills}}` (reports nothing), it reads
 * the option keywords of a select as arguments, and it counts `'{'` — an
 * ICU-escaped literal brace — as a placeholder. So this walks the string.
 *
 * What it deliberately does NOT collect: `#` inside a plural (it refers to
 * the enclosing argument, which is already recorded) and plural/select option
 * keywords (`one`, `other`, `=2`, `female`) — those are ICU syntax, not
 * values a caller has to pass.
 *
 * @param {string} message
 * @returns {Set<string>}
 */
export function icuArguments(message) {
  const found = new Set();
  const n = message.length;
  let i = 0;

  /*
   * ICU apostrophe rules, which matter because English copy is full of them:
   * `''` is one literal apostrophe, and a `'` immediately before a syntax
   * character opens a quoted literal running to the next `'`. A lone `'`
   * (the "don't" case) is just a character. Getting this wrong in the
   * permissive direction invents arguments out of quoted braces; getting it
   * wrong in the strict direction swallows the rest of the message and every
   * real argument after it goes silently unseen.
   */
  const skipQuote = () => {
    if (message[i + 1] === "'") {
      i += 2;
      return;
    }
    if (/[{}#|<]/.test(message[i + 1] ?? '')) {
      i += 2;
      while (i < n && message[i] !== "'") i++;
      i++; // the closing quote, or past the end
      return;
    }
    i++;
  };

  const parseMessage = (depth) => {
    while (i < n) {
      const c = message[i];
      if (c === "'") skipQuote();
      else if (c === '}' && depth > 0) return; // the caller consumes this brace
      else if (c === '{') {
        i++;
        parseArgument(depth);
      } else i++;
    }
  };

  const parseArgument = (depth) => {
    while (i < n && /\s/.test(message[i])) i++;
    const start = i;
    while (i < n && !/[,}\s]/.test(message[i])) i++;
    const name = message.slice(start, i);
    if (name) found.add(name);

    while (i < n && /\s/.test(message[i])) i++;
    let type = '';
    if (message[i] === ',') {
      i++;
      while (i < n && /\s/.test(message[i])) i++;
      const typeStart = i;
      while (i < n && !/[,}\s]/.test(message[i])) i++;
      type = message.slice(typeStart, i);
    }

    if (SUBMESSAGE_TYPES.has(type)) {
      // `key {submessage}` pairs (plus `offset:N`) until the closing brace.
      // Each submessage is a full message and can nest more arguments.
      while (i < n) {
        while (i < n && /[\s,]/.test(message[i])) i++;
        if (i >= n || message[i] === '}') break;
        if (message[i] === '{') {
          i++;
          parseMessage(depth + 1);
          i++; // the submessage's closing brace
          continue;
        }
        while (i < n && !/[{}\s,]/.test(message[i])) i++; // an option keyword
      }
      i++; // this argument's closing brace
      return;
    }

    // A simple or typed argument ({n}, {n, number, ::percent}): skip to its
    // own closing brace, counting nesting and honoring quotes.
    let level = 1;
    while (i < n && level > 0) {
      if (message[i] === "'") skipQuote();
      else {
        if (message[i] === '{') level++;
        else if (message[i] === '}') level--;
        i++;
      }
    }
  };

  parseMessage(0);
  return found;
}

/** Flattened `a.b.c` -> value, for every leaf in a messages document. */
export function flattenMessages(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const at = `${prefix}${k}`;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenMessages(v, `${at}.`, out);
    else out.set(at, v);
  }
  return out;
}

/**
 * Both halves of the gate over two already-parsed documents.
 * @returns {string[]} human-readable violations; empty means parity.
 */
export function checkParity(enDoc, esDoc) {
  const en = flattenMessages(enDoc);
  const es = flattenMessages(esDoc);
  const violations = [];

  for (const k of en.keys()) {
    if (!es.has(k)) violations.push(`messages key "${k}" exists in en.json but not es.json`);
  }
  for (const k of es.keys()) {
    if (!en.has(k)) violations.push(`messages key "${k}" exists in es.json but not en.json`);
  }

  for (const [key, enValue] of en) {
    const esValue = es.get(key);
    if (typeof enValue !== 'string' || typeof esValue !== 'string') continue;
    const enArgs = icuArguments(enValue);
    const esArgs = icuArguments(esValue);
    const missingInEs = [...enArgs].filter((a) => !esArgs.has(a)).sort();
    const missingInEn = [...esArgs].filter((a) => !enArgs.has(a)).sort();
    if (missingInEs.length) {
      violations.push(
        `messages key "${key}": es.json drops ICU argument(s) ${missingInEs.map((a) => `{${a}}`).join(', ')} that en.json takes — the Spanish string silently stops saying it. en: ${JSON.stringify(enValue)} / es: ${JSON.stringify(esValue)}`
      );
    }
    if (missingInEn.length) {
      violations.push(
        `messages key "${key}": es.json takes ICU argument(s) ${missingInEn.map((a) => `{${a}}`).join(', ')} that en.json does not — no caller passes them, so next-intl throws on the ES render. en: ${JSON.stringify(enValue)} / es: ${JSON.stringify(esValue)}`
      );
    }
  }
  return violations;
}

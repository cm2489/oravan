/**
 * Bilingual parity gate (CLAUDE.md hard rule) — CLI wrapper. The rule itself
 * lives import-free in lib/messages-parity.mjs (same split as
 * check-rollover-tripwire.mjs / check-moments.mjs); this file does the file
 * I/O, the self-test fixtures, and the exit code.
 *
 *   node scripts/check-messages-parity.mjs [--self-test]
 *
 * Checks messages/en.json against messages/es.json on two axes: the flattened
 * KEY SETS (a key in one locale and not the other breaks that locale at
 * runtime) and, for every shared key, the set of ICU ARGUMENT NAMES the two
 * messages take. The second half is why --self-test exists: it is a
 * hand-written tokenizer, and a tokenizer that has quietly stopped parsing
 * finds nothing and reports parity. Stdlib only.
 */
import { readFileSync } from 'node:fs';
import { checkParity, flattenMessages, icuArguments } from '../lib/messages-parity.mjs';

/*
 * Seeded divergences. Every one of these is a shape the KEY check cannot see,
 * and most are shapes a naive /\{(\w+)\}/ scan would miss or mis-read — which
 * is the whole reason the tokenizer is hand-written.
 */
const SEEDED = [
  {
    what: 'a plain placeholder dropped from the Spanish string',
    en: { a: 'Browse all {count} active bills' },
    es: { a: 'Explorar todos los proyectos activos' },
  },
  {
    what: 'a placeholder the Spanish string invents (next-intl throws: nobody passes it)',
    en: { a: 'Last action' },
    es: { a: 'Última acción: {date}' },
  },
  {
    what: 'an argument that only ever appears INSIDE a plural submessage',
    en: { a: '{count, plural, one {# bill from {state}} other {# bills from {state}}}' },
    es: { a: '{count, plural, one {# proyecto} other {# proyectos}}' },
  },
  {
    what: 'the whole plural wrapper dropped, taking its argument with it',
    en: { a: '{count, plural, =2 {two} other {#}} districts' },
    es: { a: 'varios distritos' },
  },
  {
    what: 'a nested namespace, so the walk has to recurse to find it',
    en: { deep: { deeper: { a: 'Step {n} of {total}' } } },
    es: { deep: { deeper: { a: 'Paso {n}' } } },
  },
  {
    what: 'a select whose option keywords must NOT be mistaken for the missing argument',
    en: { a: '{chamber, select, house {House} senate {Senate} other {Congress}} — {bill}' },
    es: { a: '{chamber, select, house {Cámara} senate {Senado} other {Congreso}}' },
  },
  {
    what: 'a typed argument (skipping its style must not swallow the next placeholder)',
    en: { a: '{share, number, ::percent} of {total}' },
    es: { a: '{share, number, ::percent} del total' },
  },
  {
    what: 'an argument dropped from a string that still has other arguments (the partial case)',
    en: { a: 'Step {n} of {total}: {title}' },
    es: { a: 'Paso {n}: {title}' },
  },
];

/*
 * Clean pairs that must NOT trip the gate — the false-positive shapes: an
 * ICU-escaped literal brace, an apostrophe in ordinary copy, a legitimately
 * reordered argument list, a plural whose `#` is not an argument, and the
 * ordinal-vs-cardinal pair the real corpus actually ships. A gate that reds
 * on correct Spanish gets weakened by whoever hits it next, which is how a
 * rule stops being a rule.
 */
const CLEAN = [
  {
    what: 'same arguments, different order (Spanish syntax reorders freely)',
    en: { a: '{state} district {district}' },
    es: { a: 'Distrito {district} de {state}' },
  },
  {
    what: 'an ICU-escaped literal brace is not a placeholder',
    en: { a: "Use '{'name'}' in the template, {who}" },
    es: { a: "Use '{'name'}' en la plantilla, {who}" },
  },
  {
    what: "a lone apostrophe in ordinary copy doesn't swallow the rest of the message",
    en: { a: "Congress isn't done with {bill}" },
    es: { a: 'El Congreso no ha terminado con {bill}' },
  },
  {
    what: '`#` inside a plural is the enclosing argument, not a new one',
    en: { a: '{count, plural, one {# bill} other {# bills}}' },
    es: { a: '{count, plural, one {# proyecto} other {# proyectos}}' },
  },
  {
    what: 'an English ordinal against a Spanish cardinal — SAME argument, different grammar (bill.congressLabel ships exactly this)',
    en: { a: '{congress, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} Congress' },
    es: { a: 'Congreso {congress}' },
  },
];

function selfTest() {
  for (const { what, en, es } of SEEDED) {
    if (checkParity(en, es).length === 0) {
      console.error(`::error::check-messages-parity self-test: seeded divergence NOT caught — ${what}`);
      process.exit(1);
    }
  }
  for (const { what, en, es } of CLEAN) {
    const v = checkParity(en, es);
    if (v.length) {
      console.error(
        `::error::check-messages-parity self-test: false positive on correct copy — ${what}\n  ${v.join('\n  ')}`
      );
      process.exit(1);
    }
  }
  console.log(
    `check-messages-parity self-test passed: all ${SEEDED.length} seeded violations caught, ${CLEAN.length} clean pairs pass.`
  );
  process.exit(0);
}

if (process.argv.includes('--self-test')) selfTest();

const enDoc = JSON.parse(readFileSync('messages/en.json', 'utf8'));
const esDoc = JSON.parse(readFileSync('messages/es.json', 'utf8'));

const violations = checkParity(enDoc, esDoc);
if (violations.length) {
  for (const v of violations) console.error(`::error::${v}`);
  process.exit(1);
}

const flat = flattenMessages(enDoc);
const withArgs = [...flat].filter(([, v]) => typeof v === 'string' && icuArguments(v).size > 0).length;
console.log(
  `EN/ES message parity holds: ${flat.size} keys, and the ${withArgs} message(s) carrying ICU arguments take the same arguments in both languages.`
);

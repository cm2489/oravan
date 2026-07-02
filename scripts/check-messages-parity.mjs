/**
 * Bilingual parity gate (CLAUDE.md hard rule): messages/en.json and
 * messages/es.json must expose exactly the same key set. A key present in
 * one locale and not the other crashes (or silently anglicizes) the other
 * locale at runtime — fail CI before that ships. Stdlib only.
 */
import { readFileSync } from 'node:fs';

const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? flatten(v, `${prefix}${k}.`)
      : [`${prefix}${k}`]
  );

const en = new Set(flatten(JSON.parse(readFileSync('messages/en.json', 'utf8'))));
const es = new Set(flatten(JSON.parse(readFileSync('messages/es.json', 'utf8'))));

const onlyEn = [...en].filter((k) => !es.has(k));
const onlyEs = [...es].filter((k) => !en.has(k));

if (onlyEn.length || onlyEs.length) {
  for (const k of onlyEn) console.error(`::error::messages key "${k}" exists in en.json but not es.json`);
  for (const k of onlyEs) console.error(`::error::messages key "${k}" exists in es.json but not en.json`);
  process.exit(1);
}
console.log(`EN/ES message keys are in parity (${en.size} keys)`);

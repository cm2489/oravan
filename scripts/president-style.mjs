/**
 * "The president" over the committed corpus — the one-off sweep and its audit.
 *
 *   node scripts/president-style.mjs            # counts only, writes nothing
 *   node scripts/president-style.mjs --audit    # every change and every skip
 *   node scripts/president-style.mjs --write    # apply to the files below
 *   node scripts/president-style.mjs --check    # exit 1 if anything would change
 *   node scripts/president-style.mjs --json out.json   # the full report, for a PR body
 *   node scripts/president-style.mjs --messages [--audit|--write|--check]
 *                                               # the same, over messages/*.json
 *
 * Owner, 2026-09-29: "It's 'the president' just FYI for all future copy
 * (correct any other copy but first find the rules of how and when
 * 'president' is capitalized". The rule is docs/copy-style.md; the normalizer
 * is lib/president-style.mjs. This file only decides WHICH fields are
 * Oravan's own words and walks them. Everything else is the record's, and is
 * never opened:
 *
 *   data/bills.json         ai_headline, ai_summary, ai_sections.* (and the
 *                           cost chips). NOT title, short_title,
 *                           last_action_text, status_basis_text, news_query.
 *   data/bills-es.json      headline, summary, sections.*
 *   data/headlines-v2.json  en, es (the one-off headline set merge-headlines
 *                           reads)
 *   data/moments.json       name, summary, vehicles[].role. NOT aliases (search
 *                           terms) or context_refs[].title (other publishers'
 *                           titles).
 *   data/moment-updates.json  updates[].text, summary_revisions[].text. NOT
 *                           record.* — the government's own sentence, which
 *                           the record-class text quotes inside “…” anyway.
 *
 * Not swept, on purpose: data/nominations.json (every string is the Senate's),
 * data/coverage.json and data/press-names.json (other publishers' headlines),
 * data/votes.json (the clerks' records). messages/*.json have their own mode
 * (--messages), which rewrites only the changed strings so the files' hand-kept
 * formatting survives; tests/president-style.unit.spec.ts fails when a message
 * string would change.
 *
 * Every write preserves the file's own formatting (no indent for the three
 * big corpus files, two spaces and a trailing newline for the Moments files),
 * so the diff is the words and nothing else.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizePresidentStyle } from '../lib/president-style.mjs';

/**
 * @typedef {{ file: string, path: string, lang: 'en'|'es', before: string, after: string, rules: string[] }} FieldChange
 * @typedef {{ file: string, path: string, lang: 'en'|'es', match: string, reason: string }} FieldSkip
 * @typedef {{ changes: FieldChange[], skipped: FieldSkip[], kept: FieldSkip[] }} Report
 */

/** @returns {Report} */
function emptyReport() {
  return { changes: [], skipped: [], kept: [] };
}

/**
 * Normalize one field in place on `holder[key]`, recording what happened.
 *
 * @param {Report} report
 * @param {string} file
 * @param {string} path
 * @param {Record<string, any>} holder
 * @param {string | number} key
 * @param {'en'|'es'} lang
 * @param {string[]} titles
 */
function sweepField(report, file, path, holder, key, lang, titles) {
  const value = holder?.[key];
  if (typeof value !== 'string') return;
  const r = normalizePresidentStyle(value, lang, { titles });
  for (const s of r.skipped) report.skipped.push({ file, path, lang, match: s.match, reason: s.reason });
  for (const k of r.kept) report.kept.push({ file, path, lang, match: k.match, reason: k.reason });
  if (r.text !== value) {
    report.changes.push({ file, path, lang, before: value, after: r.text, rules: r.changes.map((c) => c.rule) });
    holder[key] = r.text;
  }
}

/**
 * A decode's sections object, string fields and chips alike.
 *
 * @param {Report} report @param {string} file @param {string} path
 * @param {Record<string, any> | null | undefined} sections @param {'en'|'es'} lang @param {string[]} titles
 */
function sweepSections(report, file, path, sections, lang, titles) {
  if (!sections || typeof sections !== 'object') return;
  for (const [k, v] of Object.entries(sections)) {
    if (typeof v === 'string') sweepField(report, file, `${path}.${k}`, sections, k, lang, titles);
    else if (Array.isArray(v)) v.forEach((_, i) => sweepField(report, file, `${path}.${k}[${i}]`, v, i, lang, titles));
  }
}

/** @param {Record<string, any>} b */
export function billSlug(b) {
  return `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();
}

/** @param {Record<string, any>} b @returns {string[]} */
function titlesOf(b) {
  return [b?.title, b?.short_title].filter((t) => typeof t === 'string');
}

/**
 * Sweep every file's Oravan-written fields, in memory. Pure over its inputs
 * (they are mutated in place and returned); the CLI below does the I/O.
 *
 * @param {{ bills: any[], billsEs: Record<string, any>, headlines: Record<string, any>, moments: Record<string, any>, momentUpdates: Record<string, any> }} files
 * @returns {Report}
 */
export function sweepCorpus(files) {
  const report = emptyReport();
  const titleBySlug = new Map(files.bills.map((b) => [billSlug(b), titlesOf(b)]));

  for (const b of files.bills) {
    const slug = billSlug(b);
    const titles = titlesOf(b);
    sweepField(report, 'data/bills.json', `${slug}.ai_headline`, b, 'ai_headline', 'en', titles);
    sweepField(report, 'data/bills.json', `${slug}.ai_summary`, b, 'ai_summary', 'en', titles);
    sweepSections(report, 'data/bills.json', `${slug}.ai_sections`, b.ai_sections, 'en', titles);
  }

  for (const [slug, e] of Object.entries(files.billsEs)) {
    sweepField(report, 'data/bills-es.json', `${slug}.headline`, e, 'headline', 'es', []);
    sweepField(report, 'data/bills-es.json', `${slug}.summary`, e, 'summary', 'es', []);
    sweepSections(report, 'data/bills-es.json', `${slug}.sections`, e?.sections, 'es', []);
  }

  for (const [slug, h] of Object.entries(files.headlines)) {
    sweepField(report, 'data/headlines-v2.json', `${slug}.en`, h, 'en', 'en', titleBySlug.get(slug) ?? []);
    sweepField(report, 'data/headlines-v2.json', `${slug}.es`, h, 'es', 'es', []);
  }

  for (const [id, m] of Object.entries(files.moments)) {
    const titles = (m?.vehicles ?? []).flatMap((/** @type {any} */ v) => titleBySlug.get(v?.slug) ?? []);
    for (const lang of /** @type {const} */ (['en', 'es'])) {
      sweepField(report, 'data/moments.json', `${id}.name.${lang}`, m?.name, lang, lang, titles);
      sweepField(report, 'data/moments.json', `${id}.summary.${lang}`, m?.summary, lang, lang, titles);
      (m?.vehicles ?? []).forEach((/** @type {any} */ v, /** @type {number} */ i) =>
        sweepField(report, 'data/moments.json', `${id}.vehicles[${i}].role.${lang}`, v?.role, lang, lang, titles),
      );
    }
  }

  for (const [id, entry] of Object.entries(files.momentUpdates)) {
    if (id.startsWith('_') || !entry || typeof entry !== 'object') continue;
    for (const lang of /** @type {const} */ (['en', 'es'])) {
      (entry.updates ?? []).forEach((/** @type {any} */ u, /** @type {number} */ i) =>
        sweepField(report, 'data/moment-updates.json', `${id}.updates[${i}](${u?.id}).text.${lang}`, u?.text, lang, lang, titleBySlug.get(u?.vehicle) ?? []),
      );
      (entry.summary_revisions ?? []).forEach((/** @type {any} */ r, /** @type {number} */ i) => {
        const titles = Object.keys(r?.grounded_in?.vehicle_statuses ?? {}).flatMap((s) => titleBySlug.get(s) ?? []);
        sweepField(report, 'data/moment-updates.json', `${id}.summary_revisions[${i}](${r?.id}).text.${lang}`, r?.text, lang, lang, titles);
      });
    }
  }
  return report;
}

/**
 * messages/<lang>.json, restyled by exact string replacement on the RAW file
 * so its hand-kept formatting survives byte for byte. Returns the new text
 * and what changed; refuses (throws) if a changed string is not unique in the
 * file, because then a replacement could land on the wrong key.
 *
 * @param {string} raw
 * @param {'en'|'es'} lang
 * @returns {{ raw: string, changes: Array<{ path: string, before: string, after: string }>, skipped: Array<{ path: string, match: string, reason: string }> }}
 */
export function sweepMessagesRaw(raw, lang) {
  const parsed = JSON.parse(raw);
  /** @type {Array<{ path: string, before: string, after: string }>} */
  const changes = [];
  /** @type {Array<{ path: string, match: string, reason: string }>} */
  const skipped = [];
  /** @param {any} o @param {string} p */
  const walk = (o, p) => {
    if (typeof o === 'string') {
      const r = normalizePresidentStyle(o, lang);
      for (const s of r.skipped) skipped.push({ path: p, match: s.match, reason: s.reason });
      if (r.text !== o) changes.push({ path: p, before: o, after: r.text });
    } else if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) walk(v, p ? `${p}.${k}` : k);
    }
  };
  walk(parsed, '');
  let out = raw;
  for (const c of changes) {
    const needle = JSON.stringify(c.before);
    const count = out.split(needle).length - 1;
    if (count !== 1) throw new Error(`messages/${lang}.json ${c.path}: the string occurs ${count} times — fix it by hand`);
    out = out.replace(needle, () => JSON.stringify(c.after));
  }
  return { raw: out, changes, skipped };
}

/**
 * The sentences that differ between two versions of one field, paired. The
 * normalizer never adds or removes sentence punctuation, so the split lines
 * up; if it ever did not, the whole field is the pair.
 *
 * @param {string} before @param {string} after
 * @returns {Array<[string, string]>}
 */
export function sentencePairs(before, after) {
  const split = (/** @type {string} */ s) => s.split(/(?<=[.!?])\s+|\n+/);
  const a = split(before);
  const b = split(after);
  if (a.length !== b.length) return [[before, after]];
  /** @type {Array<[string, string]>} */
  const out = [];
  a.forEach((s, i) => {
    if (s !== b[i]) out.push([s, b[i]]);
  });
  return out;
}

const FILES = {
  bills: { path: 'data/bills.json', indent: 0, newline: false },
  billsEs: { path: 'data/bills-es.json', indent: 0, newline: false },
  headlines: { path: 'data/headlines-v2.json', indent: 0, newline: false },
  moments: { path: 'data/moments.json', indent: 2, newline: true },
  momentUpdates: { path: 'data/moment-updates.json', indent: 2, newline: true },
};

/**
 * `--messages`: the site copy instead of the corpus. Same flags.
 *
 * @param {{ write: boolean, audit: boolean, check: boolean }} flags
 */
function mainMessages({ write, audit, check }) {
  let pending = 0;
  for (const lang of /** @type {const} */ (['en', 'es'])) {
    const path = `messages/${lang}.json`;
    const r = sweepMessagesRaw(readFileSync(path, 'utf8'), lang);
    pending += r.changes.length;
    if (audit) {
      for (const c of r.changes) console.log(`CHANGE ${path} ${c.path}\n  - ${c.before}\n  + ${c.after}`);
      for (const s of r.skipped) console.log(`SKIP   ${path} ${s.path}: "${s.match}" — ${s.reason}`);
    }
    console.log(`  ${path}: ${r.changes.length} string(s) to restyle, ${r.skipped.length} left to the editor`);
    if (write && r.changes.length) {
      writeFileSync(path, r.raw);
      console.log(`  wrote ${path}`);
    }
  }
  if (check && pending) {
    console.error(`::error::president-style: ${pending} message string(s) do not follow docs/copy-style.md — run node scripts/president-style.mjs --messages --write`);
    process.exitCode = 1;
  }
}

/** @param {string[]} argv */
async function main(argv) {
  const write = argv.includes('--write');
  const audit = argv.includes('--audit');
  const check = argv.includes('--check');
  const jsonAt = argv.indexOf('--json');
  const jsonPath = jsonAt >= 0 ? argv[jsonAt + 1] : null;
  if (argv.includes('--messages')) {
    console.log('president-style (site copy):');
    mainMessages({ write, audit, check });
    return;
  }

  /** @type {Record<string, any>} */
  const loaded = {};
  /** @type {Record<string, string>} */
  const raw = {};
  for (const [key, f] of Object.entries(FILES)) {
    raw[key] = readFileSync(f.path, 'utf8');
    loaded[key] = JSON.parse(raw[key]);
    // Refuse to rewrite a file whose formatting this script would not
    // reproduce byte-for-byte: the diff must be the words and nothing else.
    const again = JSON.stringify(loaded[key], null, f.indent || undefined) + (f.newline ? '\n' : '');
    if (again !== raw[key]) throw new Error(`${f.path}: formatting is not what this script writes back — refusing`);
  }
  const report = sweepCorpus(/** @type {any} */ (loaded));

  /** @type {Record<string, number>} */
  const perFile = {};
  for (const c of report.changes) perFile[c.file] = (perFile[c.file] ?? 0) + 1;
  /** @type {Record<string, number>} */
  const perFileEdits = {};
  for (const c of report.changes) perFileEdits[c.file] = (perFileEdits[c.file] ?? 0) + c.rules.length;

  if (audit) {
    for (const c of report.changes) {
      for (const [a, b] of sentencePairs(c.before, c.after)) {
        console.log(`CHANGE ${c.file} ${c.path} [${c.rules.join('; ')}]\n  - ${a}\n  + ${b}`);
      }
    }
    for (const s of report.skipped) console.log(`SKIP   ${s.file} ${s.path}: "${s.match}" — ${s.reason}`);
  }
  console.log('president-style:');
  for (const f of Object.values(FILES)) {
    console.log(`  ${f.path}: ${perFile[f.path] ?? 0} field(s), ${perFileEdits[f.path] ?? 0} edit(s)`);
  }
  console.log(`  skipped as ambiguous: ${report.skipped.length}; left alone by rule (quotes, names): ${report.kept.length}`);

  if (jsonPath) writeFileSync(jsonPath, JSON.stringify({ perFile, perFileEdits, ...report }, null, 2));

  if (write) {
    for (const [key, f] of Object.entries(FILES)) {
      if (!perFile[f.path]) continue;
      writeFileSync(f.path, JSON.stringify(loaded[key], null, f.indent || undefined) + (f.newline ? '\n' : ''));
      console.log(`  wrote ${f.path}`);
    }
  }
  if (check && report.changes.length) {
    console.error(`::error::president-style: ${report.changes.length} field(s) do not follow docs/copy-style.md — run node scripts/president-style.mjs --audit`);
    process.exitCode = 1;
  }
}

// Run-directly guard without `import.meta`: Playwright transpiles an imported
// .mjs to CJS, where `import.meta` cannot be parsed (scripts/moment-candidates.mjs
// has the full note), and tests/president-style.unit.spec.ts imports this file.
if (/(^|\/)president-style\.mjs$/.test(process.argv[1] ?? '') && /(^|\/)scripts\//.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

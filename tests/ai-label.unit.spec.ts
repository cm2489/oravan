import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { AI_LABEL_MAX_WORDS, aiLabelWordCount } from '../components/system/ai-label';

/*
 * PINS the AI label's two forms (UI audit 2026-09-25, finding F1).
 *
 * `Chip tone="ai"` sets its text in tracked capitals — a LABEL voice. Five
 * surfaces had fed it whole disclosure sentences (50–280 characters), which
 * shipped as 5–8 lines of capitals: the exact "bold-uppercase disclosure
 * paragraph" the owner demoted to "quiet marker + small caption" on
 * 2026-08-01. The rule now has two halves, and this file pins both:
 *
 *   1. THE BUDGET. Every `<Chip tone="ai">` in app/ and components/ prints a
 *      message key of at most AI_LABEL_MAX_WORDS words in BOTH en.json and
 *      es.json. The key is resolved through the translator the call site
 *      actually uses (`getTranslations('home')` → `home.*`), so a label that
 *      grows in Spanish only is still caught. A child that is not a message
 *      key cannot be measured, so it fails too.
 *   2. THE CAPTIONS. The disclosures that were migrated render through
 *      `AiNote` — the mark plus a sentence-case caption — so none of them
 *      can drift back into a chip one call site at a time.
 *
 * The scanner is proven against seeded fixtures first (the repo's
 * `--self-test` idiom), so a broken regex fails loudly instead of passing an
 * empty scan silently.
 */

type Messages = typeof en;
const LOCALES: [string, Messages][] = [
  ['en', en],
  ['es', es as unknown as Messages],
];

function lookup(messages: Messages, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    messages
  );
}

/** `const t = await getTranslations('ns')`, `useTranslations('ns')`,
 *  `getTranslations({ locale, namespace: 'ns' })`, or no namespace at all. */
const BINDING =
  /const\s+(\w+)\s*=\s*(?:await\s+)?(?:getTranslations|useTranslations)\(\s*(?:'([^']*)'|"([^"]*)"|\{[^}]*?namespace:\s*'([^']*)'[^}]*\})?\s*\)/g;

function bindingsOf(src: string) {
  const out: { name: string; ns: string; at: number }[] = [];
  for (const m of src.matchAll(BINDING)) {
    out.push({ name: m[1], ns: m[2] ?? m[3] ?? m[4] ?? '', at: m.index ?? 0 });
  }
  return out;
}

/** Resolve `{fn('key')}` at `at` to a full message path, through the nearest
 *  preceding binding of `fn` in the same file. null when it is not that shape. */
function resolveKey(src: string, expr: string, at: number): string | null {
  const m = /^\{\s*(\w+)\(\s*['"]([\w.]+)['"]\s*\)\s*\}$/.exec(expr.trim());
  if (!m) return null;
  const [, fn, key] = m;
  const binding = bindingsOf(src)
    .filter((b) => b.name === fn && b.at < at)
    .sort((a, b) => b.at - a.at)[0];
  if (!binding) return null;
  return binding.ns ? `${binding.ns}.${key}` : key;
}

type Finding = { file: string; problem: string };

/** Every `<Chip … tone="ai" …>children</Chip>` in one source file. */
function scanChips(file: string, src: string): { keys: string[]; findings: Finding[] } {
  const keys: string[] = [];
  const findings: Finding[] = [];
  const open = /<Chip\b([^>]*)>/g;
  for (const m of src.matchAll(open)) {
    if (!/\btone=["']ai["']/.test(m[1])) continue;
    const start = (m.index ?? 0) + m[0].length;
    const end = src.indexOf('</Chip>', start);
    const children = src.slice(start, end);
    const key = resolveKey(src, children, m.index ?? 0);
    if (!key) {
      findings.push({ file, problem: `ai chip children are not a single message key: ${children.trim().slice(0, 60)}` });
      continue;
    }
    keys.push(key);
    for (const [locale, messages] of LOCALES) {
      const value = lookup(messages, key);
      if (typeof value !== 'string') {
        findings.push({ file, problem: `${key} is not a string in ${locale}.json` });
      } else if (aiLabelWordCount(value) > AI_LABEL_MAX_WORDS) {
        findings.push({
          file,
          problem: `${key} (${locale}) is ${aiLabelWordCount(value)} words — over the ${AI_LABEL_MAX_WORDS}-word ai-chip budget; a sentence goes in AiNote`,
        });
      }
    }
  }
  return { keys, findings };
}

/** Every message key an `<AiNote>` prints, as children or as its label. */
function scanNotes(src: string): string[] {
  const keys: string[] = [];
  for (const m of src.matchAll(/<AiNote\b([^>]*?)(\/?)>/g)) {
    const at = m.index ?? 0;
    const label = /label=(\{\s*\w+\(\s*['"][\w.]+['"]\s*\)\s*\})/.exec(m[1]);
    if (label) {
      const k = resolveKey(src, label[1], at);
      if (k) keys.push(k);
    }
    if (m[2] === '/') continue;
    const start = at + m[0].length;
    const end = src.indexOf('</AiNote>', start);
    const k = resolveKey(src, src.slice(start, end), at);
    if (k) keys.push(k);
  }
  return keys;
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

const ROOT = join(__dirname, '..');
const SOURCES = [...tsxFiles(join(ROOT, 'app')), ...tsxFiles(join(ROOT, 'components'))].map((path) => ({
  file: relative(ROOT, path),
  src: readFileSync(path, 'utf8'),
}));

/** The disclosures migrated off the chip on 2026-09-25. Each is a sentence
 *  (over budget in at least one locale), so each must stay a caption. */
const CAPTIONS = [
  'bills.aiNote',
  'moments.aiNote',
  'moments.vehiclesAiNote',
  'moments.updates.timelineAiChip',
  'moments.aiVerify',
  'rep.aiNote',
  'home.aiReviewed',
  'bill.aiLabel',
];

test.describe('the scanner, against seeded fixtures (self-test)', () => {
  test('counts words, not separators', () => {
    expect(aiLabelWordCount('AI-decoded')).toBe(1);
    expect(aiLabelWordCount('Decoded by AI · checked against the record')).toBe(7);
    expect(aiLabelWordCount('Traducido por IA — verificado')).toBe(4);
  });

  test('flags a sentence fed to the ai chip, through a namespaced translator', () => {
    const src = `const t = await getTranslations('bills');\n<Chip tone="ai" marker={t('x')}>\n  {t('aiNote')}\n</Chip>`;
    const { keys, findings } = scanChips('fixture.tsx', src);
    expect(keys).toEqual(['bills.aiNote']);
    expect(findings.length).toBe(2); // over budget in en AND es
  });

  test('passes a short label, and resolves the nearest binding of the translator', () => {
    const src = `const t = await getTranslations('home');\nfunction B() { const t = useTranslations();\n<Chip tone="ai" marker={t('common.aiMarker')}>{t('bill.aiChip')}</Chip> }`;
    expect(scanChips('fixture.tsx', src)).toEqual({ keys: ['bill.aiChip'], findings: [] });
  });

  test('fails an ai chip whose children are not a message key', () => {
    const src = `<Chip tone="ai" marker="AI">{someVariable}</Chip>`;
    expect(scanChips('fixture.tsx', src).findings.length).toBe(1);
  });

  test('ignores every other chip tone', () => {
    const src = `const t = useTranslations('bills');\n<Chip tone="tag">{t('aiNote')}</Chip>`;
    expect(scanChips('fixture.tsx', src)).toEqual({ keys: [], findings: [] });
  });

  test('reads AiNote keys from children and from the label prop', () => {
    const src = `const t = await getTranslations();\n<AiNote marker={t('common.aiMarker')} label={t('bill.aiChip')}>{t('moments.aiVerify')}</AiNote>\n<AiNote marker={t('common.aiMarker')} label={t('moments.updates.summaryAiChip')} />`;
    expect(scanNotes(src).sort()).toEqual(['bill.aiChip', 'moments.aiVerify', 'moments.updates.summaryAiChip']);
  });
});

test.describe('the tree', () => {
  test(`every <Chip tone="ai"> prints a label of at most ${AI_LABEL_MAX_WORDS} words, in both locales`, () => {
    const findings = SOURCES.flatMap(({ file, src }) => scanChips(file, src).findings);
    expect(findings).toEqual([]);
  });

  test('every migrated disclosure is a sentence, and renders through AiNote', () => {
    const noteKeys = new Set(SOURCES.flatMap(({ src }) => scanNotes(src)));
    const chipKeys = new Set(SOURCES.flatMap(({ file, src }) => scanChips(file, src).keys));
    for (const key of CAPTIONS) {
      const longest = Math.max(
        ...LOCALES.map(([, messages]) => aiLabelWordCount(String(lookup(messages, key) ?? '')))
      );
      expect(longest, `${key} should be over the chip budget in some locale`).toBeGreaterThan(AI_LABEL_MAX_WORDS);
      expect(noteKeys.has(key), `${key} renders through AiNote`).toBe(true);
      expect(chipKeys.has(key), `${key} never renders through the ai chip`).toBe(false);
    }
  });
});

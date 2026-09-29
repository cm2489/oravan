import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * The beta feedback option is OFF (owner, 2026-09-28: "remove the feedback
 * option for now"). Pure Node — no page, no server. This pins the removal:
 * no route accepts a submission, no page code sends one, and no copy in
 * either language still sends a reader to the form. Corrections and
 * questions go to the public contact address the site already listed.
 *
 * To bring the option back, revert the change that wrote this file: the
 * revert restores the dialog, the route, the strings and their original
 * tests together.
 */

const ROOT = join(__dirname, '..');
const CONTACT = 'hello@oravan.org';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [full] : [];
  });
}

test('no route accepts a feedback submission', () => {
  expect(existsSync(join(ROOT, 'app', 'api', 'feedback'))).toBe(false);
  expect(existsSync(join(ROOT, 'components', 'FeedbackDialog.tsx'))).toBe(false);
});

test('no page or component code sends anything to /api/feedback', () => {
  const offenders = [...sourceFiles(join(ROOT, 'app')), ...sourceFiles(join(ROOT, 'components'))].filter(
    (file) => /['"`]\/api\/feedback/.test(readFileSync(file, 'utf8'))
  );
  expect(offenders).toEqual([]);
});

/** Every string in a messages tree, with its dotted key. */
function strings(node: unknown, prefix = ''): [string, string][] {
  if (typeof node === 'string') return [[prefix, node]];
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => strings(v, prefix ? `${prefix}.${k}` : k));
  }
  return [];
}

const POINTER = {
  en: /beta feedback|feedback (link|button|form|dialog)/i,
  es: /(enlace|bot[oó]n) de comentarios|comentarios de la beta/i,
};

for (const [locale, m] of [
  ['en', en],
  ['es', es],
] as const) {
  test(`${locale}: no copy points a reader to the removed feedback option`, () => {
    expect(Object.keys(m)).not.toContain('feedback');
    const hits = strings(m).filter(([, s]) => POINTER[locale].test(s));
    expect(hits).toEqual([]);
  });

  test(`${locale}: corrections and inquiries point to the public contact address`, () => {
    expect(m.citations.correctionBody).toContain(CONTACT);
    expect(m.citations.correctionLinkText).toContain(CONTACT);
    expect(m.about.accountabilityBody).toContain(CONTACT);
    expect(m.partners.licensingBody).toContain(CONTACT);
  });
}

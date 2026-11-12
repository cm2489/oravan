import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * /privacy names every outside service that handles something from a visit
 * (owner's decision 49, option a, 2026-11-11). This spec pins three things:
 * the page renders exactly the entries the catalogs carry, each entry names
 * its service in BOTH languages, and the section carries its date in both.
 *
 * A service is named by the words a reader would search for. Company names
 * stay as they are in Spanish; the Census Bureau is the one name each
 * language spells its own way.
 */

const PAGE = readFileSync(join(process.cwd(), 'app/[locale]/privacy/page.tsx'), 'utf8');

type ServiceKey =
  | 'servicesVercel'
  | 'servicesAnthropic'
  | 'servicesUpstash'
  | 'servicesCensus'
  | 'servicesGitHub'
  | 'servicesStripe';

const SERVICES: Record<ServiceKey, { en: string; es: string }> = {
  servicesVercel: { en: 'Vercel', es: 'Vercel' },
  servicesAnthropic: { en: 'Anthropic', es: 'Anthropic' },
  servicesUpstash: { en: 'Upstash', es: 'Upstash' },
  servicesCensus: { en: 'U.S. Census Bureau', es: 'Oficina del Censo de EE. UU.' },
  servicesGitHub: { en: 'GitHub', es: 'GitHub' },
  servicesStripe: { en: 'Stripe', es: 'Stripe' },
};

/** The service list the page renders, read from its source (a page module exports only what Next.js expects). */
function pageServices(): string[] {
  const list = PAGE.match(/const PRIVACY_SERVICES = \[([^\]]+)\] as const/);
  expect(list, 'the privacy page lists its services in one literal PRIVACY_SERVICES array').not.toBeNull();
  return [...list![1].matchAll(/'(services\w+)'/g)].map((m) => m[1]);
}

test('the page renders exactly the services this spec pins, each through t.rich', () => {
  expect([...pageServices()].sort()).toEqual(Object.keys(SERVICES).sort());
  expect(PAGE).toMatch(/PRIVACY_SERVICES\.map\(\(s\) =>/);
  expect(PAGE).toMatch(/t\.rich\(s, \{ strong \}\)/);
  for (const key of ['servicesTitle', 'servicesIntro', 'lastUpdated']) {
    expect(PAGE, key).toContain(`t('${key}')`);
  }
});

for (const [locale, catalog] of [
  ['en', en],
  ['es', es],
] as const) {
  const privacy = catalog.privacy as Record<string, string>;
  const t = createTranslator({ locale, messages: catalog, namespace: 'privacy' });

  test(`${locale}: every service the page names is named, in bold, in its own entry`, () => {
    for (const key of Object.keys(SERVICES) as ServiceKey[]) {
      const names = SERVICES[key];
      expect(typeof privacy[key], `${locale} privacy.${key}`).toBe('string');
      const bold = [...privacy[key].matchAll(/<strong>(.*?)<\/strong>/g)].map((m) => m[1]);
      expect(bold, `${locale} privacy.${key} bolds the service's name and nothing else`).toHaveLength(1);
      expect(bold[0], `${locale} privacy.${key}`).toContain(names[locale]);
      // next-intl parses the tag (an ICU apostrophe before `<` would print it as text).
      const plain = t.markup(key, { strong: (chunks) => chunks });
      expect(plain, `${locale} privacy.${key}`).toContain(names[locale]);
      expect(plain, `${locale} privacy.${key}`).not.toMatch(/</);
    }
  });

  test(`${locale}: the section has its heading, its framing sentence and a dated last-updated line`, () => {
    for (const key of ['servicesTitle', 'servicesIntro', 'lastUpdated']) {
      expect(typeof privacy[key], `${locale} privacy.${key}`).toBe('string');
      expect(privacy[key], `${locale} privacy.${key}`).not.toMatch(/</);
    }
    expect(privacy.lastUpdated).toMatch(/\b20\d\d\b/);
  });

  test(`${locale}: no entry calls anything anonymous`, () => {
    for (const key of [...Object.keys(SERVICES), 'servicesIntro']) {
      expect(privacy[key], `${locale} privacy.${key}`).not.toMatch(/anonym|anónim/i);
    }
  });
}

test('both languages carry the same last-updated date', () => {
  // 'November 11, 2026' and '11 de noviembre de 2026': compare day and year.
  const nums = (s: string) => (s.match(/\d+/g) ?? []).sort();
  expect(nums(es.privacy.lastUpdated)).toEqual(nums(en.privacy.lastUpdated));
});

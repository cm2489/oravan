import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { DONATE_URL } from '../lib/site';

/*
 * §6 donate wiring guard. The full "lit" state (DONATE_URL set) can't be
 * exercised as a real e2e test in this suite - Playwright Test compiles
 * every .tsx file (including component sources, not just spec files)
 * through its own component-testing JSX runtime, which produces inert
 * `{ __pw_type, ... }` objects instead of real React elements - so
 * react-dom/server can't render Oravan's own components here, and a
 * second `next build` under a different constant is out of scope for a
 * single test run (see tests/donate.spec.ts for what IS exercised live:
 * today's real "dark" behavior). This test instead pins the two
 * requirements that make flipping DONATE_URL a genuine one-line change:
 * the constant is null today, and every gated surface reads that exact
 * constant with no separate flag to keep in sync.
 *
 * History: the HCB fiscal-sponsorship application was denied 2026-07-15
 * (teen-builds-only policy), so the former DonateSupport section and its
 * fiscal-sponsor/tax-deductibility claims were retired - the last test
 * below pins that no such claim ever returns to user-facing copy while
 * the project has no sponsor behind it.
 */

test.describe('DONATE_URL wiring (§6)', () => {
  test('is dark today: null, not merely falsy or empty-string', () => {
    expect(DONATE_URL).toBeNull();
  });

  test('Footer gates its funding line and Donate link on the DONATE_URL default, not a hardcoded value', () => {
    const src = readFileSync('components/Footer.tsx', 'utf8');
    expect(src).toContain("import { DONATE_URL } from '@/lib/site'");
    // Prop defaults to the real constant - production call sites (`<Footer />`,
    // no prop) render exactly what DONATE_URL says; the prop only exists so
    // tests can inject a fixture value without a second build.
    expect(src).toMatch(/donateUrl\s*=\s*DONATE_URL/);
    expect(src).toContain('{donateUrl &&');
    // Dark today = the founder-funded line; lit = the supporters line + CTA.
    expect(src).toContain("t('footer.funding')");
    expect(src).toContain("t('footer.fundingLive')");
    expect(src).toContain("t('footer.fundingCta')");
    expect(src).toContain('target="_blank"');
    expect(src).toContain('rel="noopener noreferrer"');
  });

  test('the About page gates its support ask on the same DONATE_URL constant - no second flag', () => {
    const page = readFileSync('app/[locale]/about/page.tsx', 'utf8');
    expect(page).toContain("import { DONATE_URL } from '@/lib/site'");
    expect(page).toContain('{DONATE_URL && (');
    expect(page).toContain("t('fundingSupportBody')");
    expect(page).toContain("t('fundingSupportCta')");
    expect(page).toContain('target="_blank"');
    expect(page).toContain('rel="noopener noreferrer"');
    // Never an iframe or a payment field on Oravan's own infra (§6, hard rule).
    expect(page).not.toMatch(/<iframe/i);
    expect(page).not.toMatch(/<input/i);
    expect(page).not.toMatch(/<form/i);
  });

  test('no partisan-rail processor is named anywhere near the donate surfaces (§6 hard exclusion)', () => {
    const forbidden = /actblue|winred|anedot/i;
    for (const file of [
      'lib/site.ts',
      'components/Footer.tsx',
      'app/[locale]/about/page.tsx',
    ]) {
      expect(readFileSync(file, 'utf8')).not.toMatch(forbidden);
    }
    for (const messages of ['messages/en.json', 'messages/es.json']) {
      expect(readFileSync(messages, 'utf8')).not.toMatch(forbidden);
    }
  });

  test('no fiscal-sponsor / 501(c)(3) / nonprofit-rail claim survives in user-facing messages (HCB denied 2026-07-15)', () => {
    // Affirmative-claim markers only: the truthful "not tax-deductible"
    // disclosure in about.fundingSupportBody is required copy, so a blanket
    // "tax-deductible" match would false-positive on the negation.
    const forbidden = /fiscal sponsor|patrocinador fiscal|501\s*\(\s*c\s*\)|hack\s*foundation|hack\s*club|hackclub/i;
    for (const messages of ['messages/en.json', 'messages/es.json']) {
      expect(readFileSync(messages, 'utf8')).not.toMatch(forbidden);
    }
  });
});

import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { CALL_PANEL_ANCHOR, STILL_OPEN_ID, isInPageTarget, questionHasPanel } from '../lib/call-tab';
import { CALL_BUTTON } from '../components/call-button';

/*
 * THE BARS AND THE CALL ANCHORS, PINNED WITHOUT A BROWSER.
 *
 * Three things here are decisions rather than plumbing, and each has a pin:
 *   1. the bars' ORDER — Home · Bills · Big Questions · Reps on the phone
 *      (owner, 2026-11-24, his pick on the mock-up card "The phone bar: which
 *      tabs stay?": "Four tabs: Home · Bills · Big Questions · Reps"), Today
 *      in Congress · Bills · Big Questions · My reps on the row nav (owner,
 *      2026-09-29: "'Today in Congress' needs to come first on the header",
 *      scope "Desktop only") — with Call, "My record" and "Why call?" on
 *      neither;
 *   2. NO CALL-TAB TARGET IS LEFT — the Call tab left the phone bar on
 *      2026-11-24, so no page declares where it goes and the per-page target
 *      store is gone (lib/call-tab.ts keeps only the in-page call anchors);
 *   3. ONE CALL STYLE — every call control reads the same string.
 * The browser half (the bar's text and the footer's door to the hub) is in
 * tests/call-hub.spec.ts; the bar's measurements at 320px and 390px are in
 * tests/header-phone-label.spec.ts.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Every .ts/.tsx/.mjs source under the app's own folders. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sources(rel));
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(rel);
  }
  return out;
}

test.describe('the in-page call anchors (lib/call-tab.ts)', () => {
  test('the anchors are the panel heading and a stable list id', () => {
    expect(CALL_PANEL_ANCHOR).toBe('#act');
    expect(STILL_OPEN_ID).toBe('still-open');
  });

  test('in-page anchors are told apart from routes', () => {
    expect(isInPageTarget('#act')).toBe(true);
    expect(isInPageTarget('#still-open')).toBe(true);
    expect(isInPageTarget('/call')).toBe(false);
    expect(isInPageTarget('/bills/s-4668-119#act')).toBe(false);
  });

  /*
   * A Big Question carries the call panel itself exactly when it runs through
   * one open bill (wireframes v2, 2026-09-29, Q6 b); several open, or one open
   * nomination, get the "Still open" list instead.
   */
  test('one open bill → the call panel on the question page itself', () => {
    expect(questionHasPanel(['bill'])).toBe(true);
  });
  test('several open, one open nomination, or nothing open → no panel on the page', () => {
    expect(questionHasPanel(['bill', 'bill'])).toBe(false);
    expect(questionHasPanel(['bill', 'nomination'])).toBe(false);
    expect(questionHasPanel(['nomination'])).toBe(false);
    expect(questionHasPanel([])).toBe(false);
  });
});

test.describe('the bars (components/Header.tsx)', () => {
  const header = read('components/Header.tsx');

  function blockOf(constName: 'TABS' | 'LINKS'): string {
    const block = new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\] as const;`).exec(header);
    expect(block, `${constName} must stay a literal array in Header.tsx`).not.toBeNull();
    return block![1];
  }
  const keysOf = (constName: 'TABS' | 'LINKS') =>
    [...blockOf(constName).matchAll(/key: '([a-zA-Z]+)'/g)].map((m) => m[1]);

  test('phone bar: Home · Bills · Big Questions · Reps', () => {
    expect(keysOf('TABS')).toEqual(['home', 'bills', 'moments', 'reps']);
  });

  test('row nav: Today in Congress · Bills · Big Questions · My reps (the lockup is Home, the switch follows)', () => {
    expect(keysOf('LINKS')).toEqual(['today', 'bills', 'moments', 'reps']);
  });

  test('Today is on the row nav only; Call, the record and "Why call?" on neither', () => {
    const links = blockOf('LINKS');
    const tabs = blockOf('TABS');
    expect(links).toMatch(/href: '\/today'/);
    expect(tabs).not.toMatch(/href: '\/today'/);
    for (const block of [links, tabs]) {
      expect(block).not.toMatch(/key: 'call'/);
      expect(block).not.toMatch(/href: '\/call'/);
      expect(block).not.toMatch(/href: '\/record'/);
      expect(block).not.toMatch(/href: '\/why-call'/);
    }
    // No call control left in the header, and no per-page target read.
    expect(header).not.toMatch(/data-call-tab|CALL_BUTTON|useSyncExternalStore|lib\/call-tab/);
  });

  test('the Big Questions tab prints the full label, on one line; the others the short one', () => {
    // Owner, 2026-11-23: "Does that give it more room for the full text in the
    // bar?"; 2026-11-24: "Four tabs: Home · Bills · Big Questions · Reps".
    expect(en.common.nav.moments).toBe('Big Questions');
    expect(es.common.nav.moments).toBe('Grandes preguntas');
    expect(header).toContain("const TAB_FULL_LABEL: ReadonlySet<string> = new Set(['moments']);");
    expect(header).toContain('TAB_FULL_LABEL.has(key) ? t(`nav.${key}`) : t(`navShort.${key}`)');
    expect(header).toContain('tabLabel(key)');
    const bar = header.slice(header.indexOf('data-thumb-bar'));
    expect(bar).toContain('<span data-tab-label className="whitespace-nowrap">');
    // Content-sized tabs, never an equal grid, each at least 44px each way.
    // 4px on every side and a full-pill tab, so the current tab's lozenge is
    // concentric with the bar's rounded ends (owner, 2026-11-24: "The button
    // overlaps the container on home and reps.").
    expect(bar).toContain('<ul className="flex p-1">');
    expect(bar).toMatch(/justify-center gap-0\.5 rounded-full px-1\.5 /);
    expect(bar).toContain('<li key={key} className="flex flex-auto">');
    expect(bar).toMatch(/className=\{`flex min-h-11 min-w-11 flex-1 /);
    expect(bar).not.toMatch(/grid-cols-/);
    // The row nav's short labels and Today's, in both languages.
    expect(en.common.navShort.moments).toBe('Questions');
    expect(es.common.navShort.moments).toBe('Preguntas');
    expect(en.common.nav.today).toBe(en.today.title);
    expect(es.common.nav.today).toBe(es.today.title);
    expect(en.common.navShort.today).toBe('Today');
    expect(es.common.navShort.today).toBe('Hoy');
  });

  test('the Call tab’s own labels are gone from both languages; the footer’s door to the hub stays', () => {
    for (const m of [en, es]) {
      expect(m.common.nav).not.toHaveProperty('call');
      expect(m.common.nav).not.toHaveProperty('tabQuestions');
      expect(m.common.navShort).not.toHaveProperty('call');
    }
    expect(en.common.footer.callHub).toBe(en.call.title);
    expect(es.common.footer.callHub).toBe(es.call.title);
    expect(read('components/Footer.tsx')).toContain("{ href: '/call', key: 'footer.callHub' }");
  });
});

test.describe('no page declares a Call-tab target any more', () => {
  test('the target component and its store are gone, and nothing names them', () => {
    const all = [...sources('app'), ...sources('components'), ...sources('lib')];
    for (const f of all) {
      const src = read(f);
      expect(src, f).not.toMatch(/\bCallTabTarget\b|\bclaimCallTab\b|\breleaseCallTab\b|\bcallTabTarget\b/);
      expect(src, f).not.toMatch(/\bquestionCallTarget\b|\bCALL_HUB_PATH\b|\bsubscribeCallTab\b/);
    }
    expect(all).not.toContain(join('components', 'CallTabTarget.tsx'));
  });

  test('the question page still prints the "Still open" heading under its own id', () => {
    const src = read('app/[locale]/questions/[id]/page.tsx');
    expect(src).toContain('const vehicles = questionVehicles(moment);');
    expect(src).toContain('const openVehicles = vehicles.filter((v) => v.open);');
    expect(src).toContain('{panel && (');
    expect(src).toContain('<ActionPanel {...panel} />');
    expect(src).toContain('<h3 id={STILL_OPEN_ID}');
  });
});

test.describe('one call style (components/call-button.ts)', () => {
  test('outlined: a 2px ink edge, the control radius, a paper fill, ink type', () => {
    for (const cls of ['rounded-control', 'border-2', 'border-ink', 'bg-paper', 'text-ink', 'font-bold']) {
      expect(CALL_BUTTON.split(' ')).toContain(cls);
    }
    // No green fill left on a call control, and no ring-gap (that mechanism
    // is for FILLED controls — app/globals.css).
    expect(CALL_BUTTON).not.toMatch(/\bbg-go\b|\bring-gap\b/);
  });

  test('every call control named in the wireframe index reads the shared string', () => {
    const users = [
      'app/[locale]/call/page.tsx',
      'components/MomentVehicleCard.tsx',
      'components/MomentNominationCard.tsx',
      'components/FloatingCallButton.tsx',
      'components/ActionPanel.tsx',
      'components/RepCard.tsx',
    ];
    for (const f of users) expect(read(f), f).toContain('CALL_BUTTON');
  });
});

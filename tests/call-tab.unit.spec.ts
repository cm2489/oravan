import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../messages/en.json';
import es from '../messages/es.json';
import {
  CALL_HUB_PATH,
  callTabServerSnapshot,
  callTabSnapshot,
  claimCallTab,
  isInPageTarget,
  questionCallTarget,
  releaseCallTab,
  subscribeCallTab,
} from '../lib/call-tab';
import { CALL_BUTTON, CALL_BUTTON_CURRENT } from '../components/call-button';

/*
 * THE CALL TAB, PINNED WITHOUT A BROWSER (owner, 2026-09-29, "nav 1").
 *
 * Three things here are decisions rather than plumbing, and each has a pin:
 *   1. the bar's ORDER — Home · Bills · Call · Questions · Reps on the phone,
 *      Bills · Call · Big Questions · My reps on the row nav — with Today and
 *      "My record" off both;
 *   2. WHERE THE TAB GOES — the page declares it (lib/call-tab.ts), and a
 *      stale declaration can never outlive its page;
 *   3. ONE CALL STYLE — every call control reads the same string.
 * The browser half (the tab really lands on #act, the hub renders) is in
 * tests/call-hub.spec.ts.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

test.describe('the declared target (lib/call-tab.ts)', () => {
  test('nothing declared means the hub, on the server and in the browser', () => {
    expect(callTabServerSnapshot()).toBeNull();
    expect(callTabSnapshot()).toBeNull();
    expect(CALL_HUB_PATH).toBe('/call');
  });

  test('a claim sets the target and notifies; its release clears it', () => {
    let calls = 0;
    const off = subscribeCallTab(() => {
      calls += 1;
    });
    const token = claimCallTab('#act');
    expect(callTabSnapshot()).toBe('#act');
    releaseCallTab(token);
    expect(callTabSnapshot()).toBeNull();
    expect(calls).toBe(2);
    off();
  });

  test("an old page's release never wipes the new page's claim (client-side navigation order)", () => {
    const oldPage = claimCallTab('#act');
    const newPage = claimCallTab('/bills/s-1-119#act');
    // React may run the old page's cleanup AFTER the new page's effect.
    releaseCallTab(oldPage);
    expect(callTabSnapshot()).toBe('/bills/s-1-119#act');
    releaseCallTab(newPage);
    expect(callTabSnapshot()).toBeNull();
  });

  test('in-page anchors are told apart from routes', () => {
    expect(isInPageTarget('#act')).toBe(true);
    expect(isInPageTarget('#vehicles-h')).toBe(true);
    expect(isInPageTarget('/call')).toBe(false);
    expect(isInPageTarget('/bills/s-4668-119#act')).toBe(false);
  });
});

test.describe('a Big Question picks its Call target from its callable vehicles', () => {
  test('one open bill → that bill’s own panel', () => {
    expect(questionCallTarget(['/bills/s-4668-119#act'], '#vehicles-h')).toBe('/bills/s-4668-119#act');
  });
  test('several open bills → the list on the page', () => {
    expect(questionCallTarget(['/bills/a#act', '/bills/b#act'], '#vehicles-h')).toBe('#vehicles-h');
  });
  test('nothing open → null, and the tab goes to the hub', () => {
    expect(questionCallTarget([], '#vehicles-h')).toBeNull();
  });
});

test.describe('the bar (components/Header.tsx)', () => {
  const header = read('components/Header.tsx');

  function keysOf(constName: 'TABS' | 'LINKS'): string[] {
    const block = new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\] as const;`).exec(header);
    expect(block, `${constName} must stay a literal array in Header.tsx`).not.toBeNull();
    return [...block![1].matchAll(/key: '([a-zA-Z]+)'/g)].map((m) => m[1]);
  }

  test('phone bar: Home · Bills · Call · Questions · Reps', () => {
    expect(keysOf('TABS')).toEqual(['home', 'bills', 'call', 'moments', 'reps']);
  });

  test('row nav: Bills · Call · Big Questions · My reps (the lockup is Home, the switch follows)', () => {
    expect(keysOf('LINKS')).toEqual(['bills', 'call', 'moments', 'reps']);
  });

  test('Today, the record and "Why call?" are off both navs', () => {
    expect(header).not.toMatch(/href: '\/today'/);
    expect(header).not.toMatch(/href: '\/record'/);
    expect(header).not.toMatch(/href: '\/why-call'/);
  });

  test('the labels exist in both languages, and the short Spanish one is the wireframe’s', () => {
    expect(en.common.nav.call).toBe('Call');
    expect(en.common.navShort.call).toBe('Call');
    expect(es.common.nav.call).toBe('Llamar');
    expect(es.common.navShort.call).toBe('Llamar');
  });
});

test.describe('pages declare the target under the same condition as their panel', () => {
  test('bill page: #act exactly when the call panel renders, never on a settled record', () => {
    const src = read('app/[locale]/bills/[id]/page.tsx');
    // The panel's own branch…
    expect(src).toContain('{settled && settledOutcome ? (');
    // …and the declaration, negated on the same two names.
    expect(src).toContain('{!(settled && settledOutcome) && <CallTabTarget href="#act" />}');
  });

  test('nomination page: #act exactly when the rail is the call panel', () => {
    const src = read('app/[locale]/nominations/[slug]/page.tsx');
    expect(src).toContain('{closed || noScript ? (');
    expect(src).toContain('{!(closed || noScript) && <CallTabTarget href="#act" />}');
  });

  test('question page: reads the cards’ own keys, then questionCallTarget', () => {
    const src = read('app/[locale]/questions/[id]/page.tsx');
    expect(src).toContain("const callTabHref = questionCallTarget(callableHrefs, '#vehicles-h');");
    expect(src).toContain('nominationCtaKey(nomination, isSettled || line.terminal)');
    expect(src).toContain('billCtaKey(isSettled || line.terminal || settledDecision(raw) !== null)');
    // The anchor it points at is the section heading the cards sit under.
    expect(src).toContain('id="vehicles-h"');
  });

  test('a member page and the hub itself declare nothing (the table sends both to /call)', () => {
    expect(read('app/[locale]/reps/[bioguide]/page.tsx')).not.toContain('CallTabTarget');
    expect(read('app/[locale]/call/page.tsx')).not.toContain('CallTabTarget');
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
    expect(CALL_BUTTON_CURRENT.split(' ')).toEqual(expect.arrayContaining(['bg-ink', 'text-paper', 'border-ink']));
  });

  test('every call control named in the wireframe index reads the shared string', () => {
    const users = [
      'components/Header.tsx',
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

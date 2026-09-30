import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../messages/en.json';
import es from '../messages/es.json';
import {
  CALL_HUB_PATH,
  CALL_PANEL_ANCHOR,
  STILL_OPEN_ANCHOR,
  STILL_OPEN_ID,
  callTabServerSnapshot,
  callTabSnapshot,
  claimCallTab,
  isInPageTarget,
  questionCallTarget,
  questionHasPanel,
  releaseCallTab,
  subscribeCallTab,
} from '../lib/call-tab';
import { CALL_BUTTON, CALL_BUTTON_CURRENT } from '../components/call-button';

/*
 * THE CALL TAB, PINNED WITHOUT A BROWSER (owner, 2026-09-29, "nav 1").
 *
 * Three things here are decisions rather than plumbing, and each has a pin:
 *   1. the bar's ORDER — Home · Bills · Call · Big Questions · Reps on the
 *      phone, Today in Congress · Bills · Big Questions · My reps on the row
 *      nav (owner, 2026-09-29: "'Today in Congress' needs to come first on
 *      the header", scope "Desktop only") — with "My record" off both;
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
    expect(isInPageTarget('#still-open')).toBe(true);
    expect(isInPageTarget('/call')).toBe(false);
    expect(isInPageTarget('/bills/s-4668-119#act')).toBe(false);
  });
});

/*
 * WHERE A BIG QUESTION SENDS THE CALL TAB (wireframes v2, 2026-09-29; the
 * index's "Where the Call tab goes"): its own call panel when it runs through
 * one open bill (Q6 b — the panel is on the question page now, not a click
 * away on the bill's), its "Still open" list when it runs through several
 * (Claude's ruling 8), and the hub when nothing is open.
 */
test.describe('a Big Question picks its Call target from its callable vehicles', () => {
  test('the anchors are the panel heading and a stable list id', () => {
    expect(CALL_PANEL_ANCHOR).toBe('#act');
    expect(STILL_OPEN_ID).toBe('still-open');
    expect(STILL_OPEN_ANCHOR).toBe('#still-open');
  });
  test('one open bill → the call panel on the question page itself', () => {
    expect(questionHasPanel(['bill'])).toBe(true);
    expect(questionCallTarget(['bill'])).toBe('#act');
  });
  test('several open → the "Still open" list on the page, never one bill’s panel', () => {
    expect(questionHasPanel(['bill', 'bill'])).toBe(false);
    expect(questionCallTarget(['bill', 'bill'])).toBe('#still-open');
    expect(questionCallTarget(['bill', 'nomination'])).toBe('#still-open');
  });
  test('one open nomination → the list: no nomination panel is drawn on a question page', () => {
    expect(questionHasPanel(['nomination'])).toBe(false);
    expect(questionCallTarget(['nomination'])).toBe('#still-open');
  });
  test('nothing open → null, and the tab goes to the hub', () => {
    expect(questionHasPanel([])).toBe(false);
    expect(questionCallTarget([])).toBeNull();
  });
});

test.describe('the bar (components/Header.tsx)', () => {
  const header = read('components/Header.tsx');

  function keysOf(constName: 'TABS' | 'LINKS'): string[] {
    const block = new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\] as const;`).exec(header);
    expect(block, `${constName} must stay a literal array in Header.tsx`).not.toBeNull();
    return [...block![1].matchAll(/key: '([a-zA-Z]+)'/g)].map((m) => m[1]);
  }

  function blockOf(constName: 'TABS' | 'LINKS'): string {
    return new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\] as const;`).exec(header)![1];
  }

  test('phone bar: Home · Bills · Call · Big Questions · Reps', () => {
    expect(keysOf('TABS')).toEqual(['home', 'bills', 'call', 'moments', 'reps']);
  });

  test('row nav: Today in Congress · Bills · Big Questions · My reps (the lockup is Home, the switch follows)', () => {
    // Owner, 2026-09-29, typed: the header's Call item removed, "Today in
    // Congress" first; scope "Desktop only".
    expect(keysOf('LINKS')).toEqual(['today', 'bills', 'moments', 'reps']);
  });

  test('Today is on the row nav only, Call on the thumb bar only; the record and "Why call?" on neither', () => {
    const links = blockOf('LINKS');
    const tabs = blockOf('TABS');
    expect(links).toMatch(/href: '\/today'/);
    expect(tabs).not.toMatch(/href: '\/today'/);
    expect(tabs).toMatch(/key: 'call'/);
    expect(links).not.toMatch(/key: 'call'/);
    for (const block of [links, tabs]) {
      expect(block).not.toMatch(/href: '\/record'/);
      expect(block).not.toMatch(/href: '\/why-call'/);
    }
  });

  test('the labels exist in both languages, and the short Spanish one is the wireframe’s', () => {
    expect(en.common.nav.call).toBe('Call');
    expect(en.common.navShort.call).toBe('Call');
    expect(es.common.nav.call).toBe('Llamar');
    expect(es.common.navShort.call).toBe('Llamar');
    // The row nav's Today item (owner, 2026-09-29), matching the page's own title.
    expect(en.common.nav.today).toBe(en.today.title);
    expect(es.common.nav.today).toBe(es.today.title);
    expect(en.common.navShort.today).toBe('Today');
    expect(es.common.navShort.today).toBe('Hoy');
    // The desktop door to the Call hub, matching the hub's own title.
    expect(en.common.footer.callHub).toBe(en.call.title);
    expect(es.common.footer.callHub).toBe(es.call.title);
    // The thumb bar's own Big Questions label; the row nav's short label stays.
    expect(en.common.tab.moments).toBe('Big Questions');
    expect(en.common.navShort.moments).toBe('Questions');
    expect(es.common.navShort.moments).toBe('Preguntas');
    expect(header).toContain('tabLabel(key)');
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

  test('question page: reads the cards’ own keys, then questionCallTarget, under the panel’s own condition', () => {
    const src = read('app/[locale]/questions/[id]/page.tsx');
    // The cards' keys, through the one helper the lists are built from…
    expect(src).toContain('const vehicles = questionVehicles(moment);');
    expect(src).toContain('const openVehicles = vehicles.filter((v) => v.open);');
    const ui = read('lib/moments-ui.ts');
    expect(ui).toContain('nominationCtaKey(nomination, isSettled || s.line.terminal)');
    expect(ui).toContain('billCtaKey(isSettled || s.line.terminal || settledDecision(bill) !== null)');
    // …then the target, never pointing at a panel that did not render…
    expect(src).toContain(
      'const callTabHref = questionHasPanel(callableKinds) && !panel ? null : questionCallTarget(callableKinds);'
    );
    expect(src).toContain('{panel && (');
    expect(src).toContain('<ActionPanel {...panel} />');
    // …and the list anchor is the "Still open" heading's own id.
    expect(src).toContain('<h3 id={STILL_OPEN_ID}');
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

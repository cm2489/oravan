import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { billSlug, getAllBills, getAllLegislators } from '../lib/core';
import { questionHasPanel } from '../lib/call-tab';
import { settledDecision } from '../lib/journey';
import { getMoments } from '../lib/moments';
import { questionVehicles } from '../lib/moments-ui';
import { briefWindow, daySummary, shiftDate } from '../lib/today';
import { MEMBER_VOTES_MAX_BILLS, memberVotesByBill } from '../lib/votes';
import { callableBillSlug } from './corpus-samples';

/*
 * "BEFORE" PICTURES AND MEASUREMENTS FOR THE LAYOUT REVIEW (2026-11-28). The
 * owner says every page leaves far too much empty space on a laptop; before
 * the layout is rebuilt, this spec records how each page type looks and fills
 * the screen today. Not a gate: the one check per page is that it loaded
 * (response ok, an h1 visible). Nothing about the layout can fail it.
 *
 * For each page it writes, into ui-fixes-shots/ (uploaded by every e2e shard
 * as `ui-fixes-shots-<shard>`; every file name starts with `layout-`):
 *   - a first-screen picture and a full-page picture, and
 *   - a JSON file of measurements (see `measure` below), and
 *   - for the pages in MID_PAGES, in webkit-desktop at 1440x900 only, one
 *     more screen with the window scrolled to y=1400 (`-mid.png`),
 * at 1280x800 and 1440x900 in webkit-desktop, and at the phone's own
 * viewport (390 wide) in webkit-mobile. webkit-320 runs only @reflow tests,
 * and none here carries the tag.
 *
 * Animations are stopped for the pictures with Playwright's own
 * `animations: 'disabled'`; the page itself is not changed.
 *
 * Delete with the layout review.
 */

const SHOTS = path.join(process.cwd(), 'ui-fixes-shots');
/** A full-page picture taller than this is cut here, so one very long page cannot stall a shard. */
const MAX_FULL_HEIGHT = 16_000;

// The Big Question: the funding deadline if it is live; otherwise the live
// question with the most content (its entry's size), then any non-retired one.
const QUESTION = (() => {
  const shown = getMoments().filter((m) => m.state !== 'retired');
  const live = shown.filter((m) => m.state === 'live');
  const pool = live.length > 0 ? live : shown;
  const named = pool.find((m) => m.id === 'government-funding-deadline');
  if (named) return named.id;
  return [...pool].sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0]?.id ?? null;
})();

// The bill: H.R. 8800 when it is decoded and still open (so its call panel
// shows); otherwise the call-flow specs' own open, decoded bill.
const BILL = (() => {
  const named = getAllBills().find((b) => billSlug(b) === 'hr-8800-119');
  if (named?.ai_sections && settledDecision(named) === null) return billSlug(named);
  try {
    return callableBillSlug();
  } catch {
    return null;
  }
})();

// The busiest dated brief: the date in the brief window whose page prints the
// most roll-call cards. /today/{date} prints two days, that date and the day
// before (lib/today.ts buildBrief), each day's roll calls read through the
// same dayOf that daySummary counts. Ties go to the newer date. Null when no
// page in the window prints a roll call.
const TODAY_BUSY = (() => {
  try {
    let best: string | null = null;
    let most = 0;
    for (const date of briefWindow()) {
      const cards = daySummary(date).votes + daySummary(shiftDate(date, -1)).votes;
      if (cards > most) {
        best = date;
        most = cards;
      }
    }
    return best;
  } catch {
    return null;
  }
})();

// A live Big Question with exactly one open bill, so the page carries the
// bill's own call panel rather than the "Still open" list: the page's own
// test (questionVehicles' `open`, then questionHasPanel). College athletes
// when it qualifies.
const QUESTION_ONE = (() => {
  try {
    const live = getMoments().filter((m) => m.state === 'live');
    const onePanel = (m: (typeof live)[number]) =>
      questionHasPanel(questionVehicles(m).filter((v) => v.open).map((v) => v.kind));
    const named = live.find((m) => m.id === 'paying-college-athletes' && onePanel(m));
    return (named ?? live.find(onePanel))?.id ?? null;
  } catch {
    return null;
  }
})();

// A sitting senator whose page lists the most votes. The member page prints
// one row (the newest vote) per bill, newest MEMBER_VOTES_MAX_BILLS bills
// (components/MemberVotes.tsx over lib/votes.ts memberVotesByBill); ties go
// to more bills on file, then the bioguide id, so the pick is stable.
const MEMBER = (() => {
  try {
    const ranked = getAllLegislators()
      .filter((l) => l.type === 'sen')
      .map((l) => {
        const bills = memberVotesByBill(l.bioguide).length;
        return { id: l.bioguide, shown: Math.min(bills, MEMBER_VOTES_MAX_BILLS), bills };
      })
      .sort((a, b) => b.shown - a.shown || b.bills - a.bills || a.id.localeCompare(b.id));
    return ranked[0]?.id ?? null;
  } catch {
    return null;
  }
})();

const PAGES: { name: string; path: string | null }[] = [
  { name: 'home-en', path: '/' },
  { name: 'today-en', path: '/today' },
  { name: 'today-busy-en', path: TODAY_BUSY ? `/today/${TODAY_BUSY}` : null },
  { name: 'questions-en', path: '/questions' },
  { name: 'question-en', path: QUESTION ? `/questions/${QUESTION}` : null },
  { name: 'question-one-en', path: QUESTION_ONE ? `/questions/${QUESTION_ONE}` : null },
  { name: 'bills-en', path: '/bills' },
  { name: 'bill-en', path: BILL ? `/bills/${BILL}` : null },
  { name: 'reps-en', path: '/reps' },
  { name: 'member-en', path: MEMBER ? `/reps/${MEMBER}` : null },
  { name: 'glossary-en', path: '/glossary' },
  { name: 'privacy-en', path: '/privacy' },
  { name: 'terms-en', path: '/terms' },
  { name: 'citations-en', path: '/citations' },
  { name: 'call-en', path: '/call' },
  { name: 'about-en', path: '/about' },
  { name: 'home-es', path: '/es' },
  { name: 'today-es', path: '/es/today' },
  { name: 'question-es', path: QUESTION ? `/es/questions/${QUESTION}` : null },
  { name: 'bill-es', path: BILL ? `/es/bills/${BILL}` : null },
];

const DESKTOP_SIZES = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];

/** Pages that also get a mid-page picture in webkit-desktop at 1440x900, so a
 *  reviewer can see what stays in view (a sticky call panel or list) halfway
 *  down. Taken after the other pictures, with the window scrolled to MID_Y. */
const MID_PAGES = new Set(['bill-en', 'bill-es', 'question-en', 'member-en']);
const MID_SIZE = { width: 1440, height: 900 };
const MID_Y = 1400;

/**
 * Measurements of the page as it stands, scrolled to the top. Runs in the
 * browser, so it must not reach anything outside itself.
 *
 * "Fill" samples a COLS x ROWS grid over the first screen. A point counts as
 * filled when the topmost element there (document.elementsFromPoint()[0]):
 *   - has a non-empty text node of its own whose boxes contain the point, or
 *   - is an image, an SVG (or a shape inside one), a picture, video, canvas
 *     or a form control, or
 *   - has a background colour, or a visible border, that differs from the
 *     page's background.
 * A rough measure for a reviewer, not a gate.
 */
function measure() {
  const COLS = 48;
  const ROWS = 30;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const clear = (c: string) => c === 'transparent' || /(,|\/)\s*0(\.0+)?\s*\)$/.test(c);
  const bgOf = (el: Element) => getComputedStyle(el).backgroundColor;
  // The page background: body's, else html's, else the browser's white.
  const pageBg = [document.body, document.documentElement].map(bgOf).find((c) => !clear(c)) ?? 'rgb(255, 255, 255)';
  const MEDIA = new Set(['IMG', 'SVG', 'PICTURE', 'VIDEO', 'CANVAS', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA']);

  const ownTextAt = (el: Element, x: number, y: number) => {
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
      }
    }
    return false;
  };

  const marked = (el: Element) => {
    const s = getComputedStyle(el);
    if (!clear(s.backgroundColor) && s.backgroundColor !== pageBg) return true;
    return (['Top', 'Right', 'Bottom', 'Left'] as const).some((side) => {
      const width = parseFloat(s.getPropertyValue(`border-${side.toLowerCase()}-width`));
      const style = s.getPropertyValue(`border-${side.toLowerCase()}-style`);
      const color = s.getPropertyValue(`border-${side.toLowerCase()}-color`);
      return width > 0 && style !== 'none' && style !== 'hidden' && !clear(color) && color !== pageBg;
    });
  };

  const filled = (x: number, y: number) => {
    const top = document.elementsFromPoint(x, y)[0];
    if (!top || top === document.documentElement || top === document.body) return false;
    if (MEDIA.has(top.tagName.toUpperCase()) || top instanceof SVGElement) return true;
    return ownTextAt(top, x, y) || marked(top);
  };

  // Columns 0-15 are the left third, 16-31 the middle, 32-47 the right.
  const hits = [0, 0, 0];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (filled(((col + 0.5) * vw) / COLS, ((row + 0.5) * vh) / ROWS)) hits[Math.floor((col * 3) / COLS)]++;
    }
  }
  const perThird = (ROWS * COLS) / 3;
  const round = (n: number) => Math.round(n * 1000) / 1000;

  // The left-most and right-most x of visible text, in page coordinates:
  // over the whole page and over the first screen. Boxes of 1px or less are
  // visually hidden text (sr-only), not something a reader sees.
  let left = Infinity;
  let right = -Infinity;
  let firstLeft = Infinity;
  let firstRight = -Infinity;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!node.textContent?.trim() || !parent || getComputedStyle(parent).visibility !== 'visible') continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      if (r.width <= 1 || r.height <= 1) continue;
      left = Math.min(left, r.left + window.scrollX);
      right = Math.max(right, r.right + window.scrollX);
      if (r.bottom > 0 && r.top < vh) {
        firstLeft = Math.min(firstLeft, r.left);
        firstRight = Math.max(firstRight, r.right);
      }
    }
  }
  const finite = (n: number) => (Number.isFinite(n) ? Math.round(n) : null);

  const main = document.querySelector('main, [role="main"]');
  const box = main?.getBoundingClientRect();

  return {
    viewport: { width: vw, height: vh },
    scrollHeight: document.documentElement.scrollHeight,
    main: box
      ? {
          x: Math.round(box.left + window.scrollX),
          y: Math.round(box.top + window.scrollY),
          width: Math.round(box.width),
          height: Math.round(box.height),
        }
      : null,
    text: { left: finite(left), right: finite(right), firstScreenLeft: finite(firstLeft), firstScreenRight: finite(firstRight) },
    firstScreenFill: {
      grid: `${COLS}x${ROWS}`,
      whole: round((hits[0] + hits[1] + hits[2]) / (ROWS * COLS)),
      leftThird: round(hits[0] / perThird),
      middleThird: round(hits[1] / perThird),
      rightThird: round(hits[2] / perThird),
    },
    pageBackground: pageBg,
  };
}

/** Open the page, check it loaded, then write its two pictures and its measurements. */
async function record(page: Page, info: TestInfo, name: string, url: string) {
  const res = await page.goto(url);
  expect(res, `${url} answered`).not.toBeNull();
  expect(res!.ok(), `${url} loaded (status ${res!.status()})`).toBe(true);
  await expect(page.locator('h1').first(), `${url} shows an h1`).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo(0, 0));

  mkdirSync(SHOTS, { recursive: true });
  const { width, height } = page.viewportSize()!;
  const base = path.join(SHOTS, `layout-${info.project.name}-${name}-${width}x${height}`);

  const m = await page.evaluate(measure);
  await page.screenshot({ path: `${base}-first.png`, animations: 'disabled' });
  // The browser refuses a picture taller than 32,767 device pixels, and the
  // phone project draws 3 device pixels per CSS pixel: cap by that too.
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
  const maxFull = Math.min(MAX_FULL_HEIGHT, Math.floor(32_000 / dpr));
  const fullHeight = Math.min(m.scrollHeight, maxFull);
  await page.screenshot({
    path: `${base}-full.png`,
    fullPage: true,
    clip: { x: 0, y: 0, width, height: fullHeight },
    animations: 'disabled',
  });
  writeFileSync(
    `${base}.json`,
    JSON.stringify(
      { page: url, project: info.project.name, ...m, fullPicture: { height: fullHeight, cut: m.scrollHeight > maxFull } },
      null,
      2
    ) + '\n'
  );

  // The mid-page picture: one screen with the window scrolled to MID_Y (or as
  // far as the page goes). The site scrolls smoothly (app/globals.css), so the
  // jump is instant, then the page gets up to a second to be there. It never
  // fails on where the page ended up; the picture shows whatever is on screen.
  if (info.project.name === 'webkit-desktop' && MID_PAGES.has(name) && width === MID_SIZE.width && height === MID_SIZE.height) {
    await page.evaluate(async (y) => {
      window.scrollTo({ top: y, behavior: 'instant' });
      const target = Math.min(y, document.documentElement.scrollHeight - window.innerHeight);
      for (let i = 0; i < 60 && Math.abs(window.scrollY - target) > 1; i++) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      // Two more frames, so scroll observers (the floating call button) answer.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, MID_Y);
    await page.screenshot({ path: `${base}-mid.png`, animations: 'disabled' });
  }
}

for (const { name, path: url } of PAGES) {
  test(`layout before-pictures: ${name}`, async ({ page }, info) => {
    test.skip(url === null, `no ${name} page in the committed corpus today`);
    test.setTimeout(120_000);
    if (info.project.name === 'webkit-desktop') {
      for (const size of DESKTOP_SIZES) {
        await page.setViewportSize(size);
        await record(page, info, name, url!);
      }
    } else {
      // webkit-mobile: the phone's own viewport (390 wide).
      await record(page, info, name, url!);
    }
  });
}

import { expect, test, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';
import en from '../messages/en.json';
import { contrastRatio } from '../lib/contrast';
import { datedChipClass } from '../components/system/Chip';
import { callableBillSlug } from './corpus-samples';
import { mockScriptApiFailure } from './helpers';

/*
 * COLOUR IN EVERY STATE, MEASURED IN THE BROWSER (rule 7; the owner's look,
 * 2026-11-13).
 *
 * tests/contrast.unit.spec.ts proves the ledger's token pairs. This spec
 * proves the pages: it drives the real states (hover, keyboard focus,
 * visited, a picked stance, an error, a disabled or busy control) and
 * measures what is on screen.
 *
 *   TEXT (4.5:1): the computed `color` of every text-bearing element in the
 *   control, composited over the computed backgrounds behind it.
 *   BOUNDARY (3:1): the computed border colour of the control against the
 *   ground outside it.
 *   FOCUS RING (3:1): read from a screenshot, not from styles, because what
 *   a ring touches depends on paint order (a stamp drawn over it, a
 *   neighbouring cell). Every pixel of the ring's colour inside the ring's
 *   band is a ring pixel; each colour it borders (taken where two pixels in
 *   a row agree, so anti-aliased corners are not counted) must clear 3:1
 *   against the ring.
 *   VISITED: browsers hide :visited from getComputedStyle on purpose, so the
 *   visited colour is the token its `visited:text-*` class names, read from
 *   :root.
 *
 * Every ratio is lib/contrast.ts's. The lowest per state is written to
 * test-results/colour-states/<project>.json and printed.
 */

type Rgb = [number, number, number];
type Check = { kind: 'text' | 'boundary' | 'ring' | 'visited'; ratio: number; need: number; what: string };

/** The screenshot as raw RGBA, decoded in Node (sharp is already the repo's
 *  image tool, scripts/gen-app-icons.mjs): an embed's CSP rightly refuses a
 *  data: image, so the page cannot decode it. */
async function decode(png: Buffer): Promise<{ width: number; height: number; data: Buffer }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

const hex = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Page-side helpers, installed before every navigation. */
const HELPERS = `
window.__cs = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const parse = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = 'rgba(0,0,0,0)'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (t, b) => [0, 1, 2].map((i) => t[i] * t[3] + b[i] * (1 - t[3])).concat(1);
  const bgOf = (el) => {
    const stack = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) { stack.push(c); if (c[3] >= 0.999) break; }
    }
    let base = [255, 255, 255, 1];
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return base.slice(0, 3);
  };
  const visible = (n) => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.opacity !== '0' && !(s.position === 'absolute' && r.width <= 1); };
  const ownText = (n) => [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
  return {
    text(el) {
      const out = [];
      for (const n of [el, ...el.querySelectorAll('*')]) {
        if (!ownText(n) || !visible(n)) continue;
        const bg = bgOf(n); const fg = over(parse(getComputedStyle(n).color), bg.concat(1));
        out.push({ fg: fg.slice(0, 3), bg, what: (n.textContent || '').trim().slice(0, 40) });
      }
      return out;
    },
    boundary(el) {
      const s = getComputedStyle(el);
      if (s.borderTopStyle === 'none' || parseFloat(s.borderTopWidth) === 0) return null;
      const ground = bgOf(el.parentElement);
      return { fg: over(parse(s.borderTopColor), ground.concat(1)).slice(0, 3), bg: ground };
    },
    ring(el) {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { color: parse(s.outlineColor).slice(0, 3), style: s.outlineStyle, width: parseFloat(s.outlineWidth), offset: parseFloat(s.outlineOffset), rect: [r.x, r.y, r.width, r.height], focusVisible: el.matches(':focus-visible') };
    },
    token(name) { return parse(getComputedStyle(document.documentElement).getPropertyValue('--color-' + name)).slice(0, 3); },
    bg(el) { return bgOf(el); },
  };
})();
`;

const results: { state: string; lowest: Record<string, number>; checks: Check[] }[] = [];

async function textChecks(page: Page, loc: Locator, label: string): Promise<Check[]> {
  const rows = (await loc.evaluate((el) => (window as unknown as { __cs: { text: (e: Element) => unknown } }).__cs.text(el))) as {
    fg: Rgb;
    bg: Rgb;
    what: string;
  }[];
  return rows.map((r) => ({ kind: 'text', ratio: contrastRatio(hex(r.fg), hex(r.bg)), need: 4.5, what: `${label}: "${r.what}" ${hex(r.fg)} on ${hex(r.bg)}` }));
}

async function boundaryCheck(page: Page, loc: Locator, label: string): Promise<Check[]> {
  const b = (await loc.evaluate((el) => (window as unknown as { __cs: { boundary: (e: Element) => unknown } }).__cs.boundary(el))) as {
    fg: Rgb;
    bg: Rgb;
  } | null;
  return b ? [{ kind: 'boundary', ratio: contrastRatio(hex(b.fg), hex(b.bg)), need: 3, what: `${label}: edge ${hex(b.fg)} on ${hex(b.bg)}` }] : [];
}

/**
 * What a focus ring touches, from the screenshot's pixels. A ring pixel is a
 * pixel inside the ring's band (outline-offset to offset + width outside the
 * box) within 10 of the ring's colour; each neighbouring colour counts where
 * the next pixel out agrees with it (so anti-aliased corners are skipped) and
 * it occurs at least twice.
 */
function ringTouches(
  img: { width: number; height: number; data: Buffer },
  ring: { color: Rgb; width: number; offset: number; rect: [number, number, number, number] },
  clip: { x: number; y: number },
  scale: number
): { ringPixels: number; touches: Rgb[] } {
  const px = (i: number, j: number): Rgb => {
    const k = (j * img.width + i) * 4;
    return [img.data[k], img.data[k + 1], img.data[k + 2]];
  };
  const near = (a: Rgb, b: Rgb, t: number) => Math.abs(a[0] - b[0]) <= t && Math.abs(a[1] - b[1]) <= t && Math.abs(a[2] - b[2]) <= t;
  const [rx, ry, rw, rh] = ring.rect;
  const inner = ring.offset;
  const outer = ring.offset + ring.width;
  const inBand = (i: number, j: number) => {
    const X = (i + 0.5) / scale + clip.x;
    const Y = (j + 0.5) / scale + clip.y;
    const inOuter = X >= rx - outer && X <= rx + rw + outer && Y >= ry - outer && Y <= ry + rh + outer;
    const inInner = X > rx - inner && X < rx + rw + inner && Y > ry - inner && Y < ry + rh + inner;
    return inOuter && !inInner;
  };
  const touches = new Map<string, number>();
  let ringPixels = 0;
  for (let j = 0; j < img.height; j++)
    for (let i = 0; i < img.width; i++) {
      if (!inBand(i, j) || !near(px(i, j), ring.color, 10)) continue;
      ringPixels++;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = [i + di, j + dj];
        const b = [i + 2 * di, j + 2 * dj];
        if (b[0] < 0 || b[1] < 0 || b[0] >= img.width || b[1] >= img.height) continue;
        const n1 = px(a[0], a[1]);
        if (near(n1, ring.color, 10)) continue;
        if (!near(n1, px(b[0], b[1]), 6)) continue;
        const k = n1.join(',');
        touches.set(k, (touches.get(k) ?? 0) + 1);
      }
    }
  return { ringPixels, touches: [...touches.entries()].filter(([, n]) => n >= 2).map(([k]) => k.split(',').map(Number) as Rgb) };
}

/**
 * A control's label contrast read from the screen: the most common colour
 * inside the control (3px in from its edge, so its border is left out) is
 * the ground; the label is the most common colour among the tenth of
 * pixels farthest from it in luminance (solid glyph strokes at 2x).
 */
async function pixelTextRatio(page: Page, loc: Locator): Promise<number> {
  const box = (await loc.boundingBox())!;
  const scale = await page.evaluate(() => window.devicePixelRatio);
  const img = await decode(await page.screenshot({ clip: box, scale: 'device' }));
  const inset = Math.ceil(3 * scale);
  const lum = (p: Rgb) => {
    const f = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]);
  };
  const px: Rgb[] = [];
  for (let j = inset; j < img.height - inset; j++)
    for (let i = inset; i < img.width - inset; i++) {
      const k = (j * img.width + i) * 4;
      px.push([img.data[k], img.data[k + 1], img.data[k + 2]]);
    }
  const mode = (list: Rgb[]) => {
    const n = new Map<string, number>();
    for (const p of list) n.set(p.join(','), (n.get(p.join(',')) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number) as Rgb;
  };
  const ground = mode(px);
  const lg = lum(ground);
  const far = [...px].sort((a, b) => Math.abs(lum(b) - lg) - Math.abs(lum(a) - lg)).slice(0, Math.max(10, Math.floor(px.length / 10)));
  return contrastRatio(hex(ground), hex(mode(far)));
}

/** Focus by keyboard modality, then measure the ring from a screenshot. */
async function ringCheck(page: Page, loc: Locator, label: string): Promise<Check[]> {
  // Arrive as a keyboard user would, so the focus is :focus-visible: a key
  // press then focus; else Tab away and back; else Tab in from the control
  // before it. The first that the engine counts as keyboard focus wins.
  const visible = () => loc.evaluate((el) => el === document.activeElement && el.matches(':focus-visible'));
  const ways = [
    async () => {
      await page.keyboard.press('Shift');
      await loc.focus();
    },
    async () => {
      await loc.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
    },
    async () => {
      await loc.evaluate((el) => {
        const all = [...document.querySelectorAll<HTMLElement>('a[href], button, summary, input, select, textarea, [tabindex="0"]')].filter(
          (n) => n.offsetParent !== null && !(n as HTMLButtonElement).disabled
        );
        all[all.indexOf(el as HTMLElement) - 1]?.focus();
      });
      await page.keyboard.press('Tab');
    },
  ];
  for (const way of ways) {
    await way();
    if (await visible()) break;
  }
  await page.waitForTimeout(250);
  const ring = (await loc.evaluate((el) => (window as unknown as { __cs: { ring: (e: Element) => unknown } }).__cs.ring(el))) as {
    color: Rgb;
    style: string;
    width: number;
    offset: number;
    rect: [number, number, number, number];
    focusVisible: boolean;
  };
  expect(ring.focusVisible, `${label}: keyboard focus is :focus-visible`).toBe(true);
  expect(ring.style, `${label}: a visible focus ring`).not.toBe('none');
  const pad = ring.offset + ring.width + 6;
  const clip = { x: Math.max(0, ring.rect[0] - pad), y: Math.max(0, ring.rect[1] - pad), width: ring.rect[2] + 2 * pad, height: ring.rect[3] + 2 * pad };
  const scale = await page.evaluate(() => window.devicePixelRatio);
  const shot = await page.screenshot({ clip, scale: 'device' });
  const res = ringTouches(await decode(shot), ring, clip, scale);
  expect(res.ringPixels, `${label}: ring pixels found on screen`).toBeGreaterThan(0);
  return res.touches.map((t) => ({ kind: 'ring', ratio: contrastRatio(hex(ring.color), hex(t)), need: 3, what: `${label}: ring ${hex(ring.color)} touches ${hex(t)}` }));
}

async function visitedCheck(page: Page, loc: Locator, label: string): Promise<Check[]> {
  const cls = (await loc.getAttribute('class')) ?? '';
  const m = /(?:^|\s)visited:text-([a-z0-9-]+)/.exec(cls);
  if (!m) return [];
  const [fg, bg] = (await loc.evaluate(
    (el, name) => {
      const cs = (window as unknown as { __cs: { token: (n: string) => unknown; bg: (e: Element) => unknown } }).__cs;
      return [cs.token(name), cs.bg(el)];
    },
    m[1]
  )) as [Rgb, Rgb];
  return [{ kind: 'visited', ratio: contrastRatio(hex(fg), hex(bg)), need: 4.5, what: `${label}: visited ${m[1]} ${hex(fg)} on ${hex(bg)}` }];
}

function record(state: string, checks: Check[]) {
  expect(checks.length, `${state}: something was measured`).toBeGreaterThan(0);
  const lowest: Record<string, number> = {};
  for (const c of checks) lowest[c.kind] = Math.min(lowest[c.kind] ?? Infinity, Math.round(c.ratio * 100) / 100);
  results.push({ state, lowest, checks });
  for (const c of checks) expect.soft(c.ratio, c.what).toBeGreaterThanOrEqual(c.need);
}

async function hover(page: Page, loc: Locator) {
  await loc.scrollIntoViewIfNeeded();
  await loc.hover();
  await page.waitForTimeout(250);
}

test.use({ deviceScaleFactor: 2, contextOptions: { reducedMotion: 'reduce' } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: HELPERS });
});

test.afterAll(async ({}, info) => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync('test-results/colour-states', { recursive: true });
  writeFileSync(`test-results/colour-states/${info.project.name}-${info.workerIndex}.json`, JSON.stringify(results, null, 1));
  for (const r of results) console.log(`[colour-states] ${info.project.name} ${r.state} ${JSON.stringify(r.lowest)}`);
});

test.describe('colour in every state', () => {
  test('bill page: stance picked, stance hover, script error, disclosure toggle', async ({ page }) => {
    test.setTimeout(60_000);
    await mockScriptApiFailure(page, 503, {});
    await page.goto(`/bills/${callableBillSlug()}`);
    const support = page.getByRole('radio', { name: en.bill.stance.support });
    const oppose = page.getByRole('radio', { name: en.bill.stance.oppose });
    await support.scrollIntoViewIfNeeded();
    await hover(page, oppose);
    record('stance, hover (half lamp)', [...(await textChecks(page, oppose, 'oppose hover')), ...(await boundaryCheck(page, oppose, 'oppose hover'))]);
    record('stance, keyboard focus', await ringCheck(page, oppose, 'oppose focus'));
    await support.click();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    await expect(page.getByRole('alert').first()).toBeVisible();
    record('stance, selected (lamp)', [...(await textChecks(page, support, 'support picked')), ...(await boundaryCheck(page, support, 'support picked'))]);
    record('call panel, script error', await textChecks(page, page.getByRole('alert').first(), 'script error'));

    // The walkthrough's toggle: the dated stamp overlaps its top edge, so its
    // ring runs under the stamp (the review of 2026-11-13 measured 2.18 there
    // before the stamp took its halo).
    const toggle = page.locator('main summary', { hasText: en.walkthrough.disclosure }).first();
    await toggle.scrollIntoViewIfNeeded();
    record('disclosure toggle, rest', await textChecks(page, toggle, 'toggle rest'));
    await hover(page, toggle);
    record('disclosure toggle, hover', await textChecks(page, toggle, 'toggle hover'));
    await page.mouse.move(0, 0);
    record('disclosure toggle, keyboard focus', await ringCheck(page, toggle, 'toggle focus'));
  });

  test('the floor panel: its green button and its links, at rest, hover and focus', async ({ page }) => {
    await page.goto('/');
    const cta = page.locator('[data-crown] a[data-call-cta]').first();
    test.skip((await cta.count()) === 0, 'a quiet week: no floor panel on the home page today');
    const href = await cta.getAttribute('href');
    for (const path of ['/', href!]) {
      await page.goto(path);
      const button = page.locator('[data-crown] a[data-call-cta]').first();
      await button.scrollIntoViewIfNeeded();
      record(`floor panel button, rest (${path === '/' ? 'home' : 'bill page'})`, [
        ...(await textChecks(page, button, 'panel button')),
        ...(await boundaryCheck(page, button, 'panel button')),
        ...(await textChecks(page, page.locator('[data-crown]').first(), 'panel text')),
      ]);
      await hover(page, button);
      record(`floor panel button, hover (${path === '/' ? 'home' : 'bill page'})`, [
        ...(await textChecks(page, button, 'panel button hover')),
        ...(await boundaryCheck(page, button, 'panel button hover')),
      ]);
      await page.mouse.move(0, 0);
      record(`floor panel button, keyboard focus (${path === '/' ? 'home' : 'bill page'})`, await ringCheck(page, button, 'panel button focus'));
    }
  });

  test('members lookup: ZIP error; the split-ZIP address form at rest, busy and failed', async ({ page }) => {
    await page.goto('/reps');
    const zip = page.locator('input[name="zip"]').first();
    await zip.fill('12');
    await zip.press('Enter');
    const zipForm = page.locator('form:has(input[name="zip"])').first();
    await expect(zip).toHaveAttribute('aria-invalid', 'true');
    record('ZIP box, error', [...(await textChecks(page, zipForm, 'zip error')), ...(await boundaryCheck(page, zip, 'zip field invalid'))]);
    const zipButton = zipForm.locator('button[type="submit"]');
    await hover(page, zipButton);
    record('yellow button, hover', [...(await textChecks(page, zipButton, 'zip button hover')), ...(await boundaryCheck(page, zipButton, 'zip button hover'))]);
    await page.mouse.move(0, 0);
    record('yellow button, keyboard focus', await ringCheck(page, zipButton, 'zip button focus'));

    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/api/district', async (route) => {
      await held;
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    });
    await zip.fill('10001');
    await zip.press('Enter');
    const form = page.locator('form[novalidate]:not(:has(input[name="zip"]))').first();
    await expect(form).toBeVisible();
    const button = form.locator('button[type="submit"]');
    record('address form, rest', [...(await textChecks(page, form, 'address rest')), ...(await boundaryCheck(page, button, 'address button'))]);
    await form.locator('input').first().fill('1 Example Street');
    await button.click();
    await expect(button).toBeDisabled();
    record('address form, busy (disabled button)', await textChecks(page, form, 'address busy'));
    release();
    await expect(button).toBeEnabled();
    await expect(form.getByRole('alert').first()).toBeVisible();
    record('address form, failed', [...(await textChecks(page, form, 'address failed')), ...(await boundaryCheck(page, button, 'address button after failure'))]);
  });

  test('links in text on cream, wash, tint and stone: rest, hover, focus, visited', async ({ page }) => {
    // Up to five pages to find, then four states per ground: longer than the
    // default 30s on a phone profile.
    test.setTimeout(120_000);
    /*
     * STABLE BY CONSTRUCTION (CI, 2026-11-14: "Element is not attached to the
     * DOM" on webkit-mobile). A link is found once by what it is, its href
     * and its text, and found again the same way after every navigation,
     * once the page has settled; nothing is held across a load and nothing
     * is put into a box React owns, because a client re-render (slower on
     * CI's runners than on a fast Mac) drops a foreign node.
     *
     *   cream  the first underlined text link in a paragraph of /about;
     *   stone  the floor panel's first underlined link on the home page,
     *          when the week has a floor panel;
     *   wash, tint  no page offers a text link on these today, so the cream
     *          link's own classes are measured inside a page made of the
     *          site's own stylesheet and `bg-wash` / `bg-tint` boxes, which
     *          React does not own.
     */
    const settle = async (path: string) => {
      await page.goto(path, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => document.readyState === 'complete');
    };
    type Target = { ground: string; path: string; scope: string; href: string; text: string };
    const describe = (scope: string) =>
      page.evaluate((sel) => {
        const a = [...document.querySelectorAll<HTMLAnchorElement>(`${sel} a[href]`)].find((n) => {
          const r = n.getBoundingClientRect();
          return getComputedStyle(n).textDecorationLine.includes('underline') && r.width > 2 && r.height > 2 && (n.textContent ?? '').trim();
        });
        return a ? { href: a.getAttribute('href')!, text: (a.textContent ?? '').trim().slice(0, 30) } : null;
      }, scope);
    const targets: Target[] = [];
    await settle('/about');
    const cream = await describe('main p');
    expect(cream, 'a text link in a paragraph of /about').toBeTruthy();
    targets.push({ ground: 'paper', path: '/about', scope: 'main p', ...cream! });
    await settle('/');
    const stone = await describe('[data-crown]');
    if (stone) targets.push({ ground: 'stone', path: '/', scope: '[data-crown]', ...stone });
    const find = (t: Target) => page.locator(`${t.scope} a[href="${t.href}"]`).filter({ hasText: t.text }).first();

    for (const t of targets) {
      await settle(t.path);
      await find(t).scrollIntoViewIfNeeded();
      record(`text link on ${t.ground}, rest`, [...(await textChecks(page, find(t), `link ${t.ground}`)), ...(await visitedCheck(page, find(t), `link ${t.ground}`))]);
      await hover(page, find(t));
      record(`text link on ${t.ground}, hover`, await textChecks(page, find(t), `link ${t.ground} hover`));
      await page.mouse.move(0, 0);
      record(`text link on ${t.ground}, keyboard focus`, await ringCheck(page, find(t), `link ${t.ground} focus`));
    }

    // Wash and tint: the cream link's classes, on the site's own stylesheet.
    await settle('/about');
    const creamLink = find(targets[0]);
    const classes = (await creamLink.getAttribute('class')) ?? '';
    const sheets = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((l) => l.href)
    );
    expect(sheets.length, 'the site stylesheet').toBeGreaterThan(0);
    await page.setContent(
      `<!doctype html><html><head>${sheets.map((h) => `<link rel="stylesheet" href="${h}">`).join('')}</head>` +
        `<body><main>` +
        ['wash', 'tint']
          .map((g) => `<div class="bg-${g} p-6"><p>Words around <a data-ground="${g}" href="#${g}" class="${classes}">a link on ${g}</a> in a sentence.</p></div>`)
          .join('') +
        `</main></body></html>`,
      { waitUntil: 'load' }
    );
    for (const g of ['wash', 'tint']) {
      const link = page.locator(`a[data-ground="${g}"]`);
      await expect(link).toBeVisible();
      record(`text link on ${g}, rest (the cream link's classes on a ${g} box)`, await textChecks(page, link, `link ${g}`));
      await hover(page, link);
      record(`text link on ${g}, hover`, await textChecks(page, link, `link ${g} hover`));
      await page.mouse.move(0, 0);
      record(`text link on ${g}, keyboard focus`, await ringCheck(page, link, `link ${g} focus`));
    }
  });

  test('visited: a bill page link that keeps a visited colour', async ({ page }) => {
    await page.goto(`/bills/${callableBillSlug()}`);
    const link = page.locator('main a[class*="visited:text-"]').first();
    test.skip((await link.count()) === 0, 'no visited-coloured link on this bill page');
    record('text link, visited', await visitedCheck(page, link, 'bill page link'));
  });

  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`embeds, the SELECTED toggle on hover, ${scheme}`, () => {
      test.use({ colorScheme: scheme });
      for (const locale of ['en', 'es'] as const) {
        for (const [name, path] of [
          ['bill card', `/embed/bill-card?locale=${locale}&slug=` + callableBillSlug()],
          ['members lookup', `/embed/rep-lookup?locale=${locale}`],
        ] as const) {
          test(`${name} (${locale}): the selected language keeps its label on hover, read from pixels`, async ({ page }) => {
            // The review of f5d7a114: hovering the already-selected toggle
            // swapped its fill for the faint hover tint while the label
            // stayed accent-ink, 1.25:1 in dark mode (1.17 in light on main).
            await page.goto(path, { waitUntil: 'networkidle' });
            const pressed = page.locator('.re-toggle[aria-pressed="true"]').first();
            await expect(pressed).toHaveText(locale.toUpperCase());
            await hover(page, pressed);
            const ratio = await pixelTextRatio(page, pressed);
            record(`embed ${name} (${scheme}, ${locale}), selected toggle on hover`, [
              { kind: 'text', ratio, need: 4.5, what: `${name} ${locale} ${scheme}: selected toggle label on hover, from pixels` },
            ]);
          });
        }
      }
    });

    test.describe(`embeds, ${scheme}`, () => {
      test.use({ colorScheme: scheme });
      for (const [name, path] of [
        ['bill card', '/embed/bill-card?locale=es&slug=' + callableBillSlug()],
        ['members lookup', '/embed/rep-lookup?locale=es'],
        ['action panel', '/embed/action-panel?locale=es&slug=' + callableBillSlug()],
      ] as const) {
        test(`${name}: text, the language toggles and their focus rings`, async ({ page }) => {
          await page.goto(path);
          const root = page.locator('main').first();
          record(`embed ${name} (${scheme}), text`, await textChecks(page, root, `${name} text`));
          const toggles = page.locator('.re-toggle[aria-pressed]');
          test.skip((await toggles.count()) < 2, 'this state shows no language toggle');
          const pressed = page.locator('.re-toggle[aria-pressed="true"]').first();
          const other = page.locator('.re-toggle[aria-pressed="false"]').first();
          record(`embed ${name} (${scheme}), selected toggle`, [...(await textChecks(page, pressed, 'pressed')), ...(await boundaryCheck(page, pressed, 'pressed'))]);
          await hover(page, other);
          record(`embed ${name} (${scheme}), toggle hover`, await textChecks(page, other, 'toggle hover'));
          await page.mouse.move(0, 0);
          record(`embed ${name} (${scheme}), toggle focus beside the selected one`, await ringCheck(page, other, 'toggle focus'));
        });
      }
    });
  }
});

/*
 * THE FLOOR LABEL'S BOX (A.3 of the owner's-look review, 2026-11-13). The
 * `floor` tone draws its grey outline as an inset shadow, so it must take
 * exactly the box of the `urgent` chip it stands in for. No page renders a
 * floor label in every day's data, so both are built from the component's
 * own class function and placed side by side on a real page, with the site's
 * own CSS.
 */
test('a floor label has the same box as a lamp label, to the pixel @reflow', async ({ page }) => {
  // Chip's own markup: its shell (datedChipClass) around the two spans it
  // always renders, the claim and the bold printed date.
  const chip = (tone: 'urgent' | 'floor') =>
    `<span class="${datedChipClass(tone)}"><span>On the House floor schedule</span><span class="font-extrabold">Nov 4, 2026</span></span>`;
  const urgent = chip('urgent');
  const floor = chip('floor');
  await page.goto('/about');
  const boxes = await page.evaluate(
    ([u, f]) => {
      const host = document.createElement('div');
      host.innerHTML = `<div data-cs="u">${u}</div><div data-cs="f">${f}</div>`;
      document.querySelector('main')!.prepend(host);
      const box = (k: string) => {
        const r = document.querySelector(`[data-cs="${k}"] > span`)!.getBoundingClientRect();
        return [r.width, r.height];
      };
      const fs = getComputedStyle(document.querySelector('[data-cs="f"] > span')!);
      return { u: box('u'), f: box('f'), border: fs.borderTopWidth, shadow: fs.boxShadow };
    },
    [urgent, floor]
  );
  expect(boxes.f, 'the floor label is exactly as big as the lamp label').toEqual(boxes.u);
  expect(boxes.border).toBe('0px');
  expect(boxes.shadow).toContain('inset');
});

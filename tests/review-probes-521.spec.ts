import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { referenceBill } from './corpus-fixtures';
import { mockScriptApi } from './helpers';

/*
 * REVIEWER PROBES FOR PR #521 (throwaway, never merged). Runs only when
 * REVIEW_PROBES is set, so the ordinary suite skips this file. Every line
 * starting "PROBE" in the log is evidence for the review.
 */
test.skip(!process.env.REVIEW_PROBES, 'reviewer probes run only in the probe workflow');

type M = typeof en;
const OLD = '78501';
const NEW = '10001';
const ADDRESS = '742 Probe Lane';
const NY12 = JSON.stringify({ state: 'NY', district: 12 });

const log = (...parts: unknown[]) =>
  console.log(`PROBE [${test.info().project.name}] ${test.info().title} ::`, ...parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))));

const isLookup = (r: Request) => r.method() === 'POST' && /\/reps$/.test(new URL(r.url()).pathname);

/** Every request this page makes from now on, with its body. */
function record(page: Page) {
  const out: { method: string; url: string; body: string }[] = [];
  page.on('request', (r) => {
    const url = r.url();
    if (/\/_next\/static\//.test(url) || /\.(png|svg|ico|woff2?|css)(\?|$)/.test(url)) return;
    out.push({ method: r.method(), url: url.replace(/^https?:\/\/[^/]+/, ''), body: (r.postData() ?? '').slice(0, 400) });
  });
  return out;
}
const carries = (reqs: { url: string; body: string }[], zip: string) => reqs.filter((r) => r.url.includes(zip) || r.body.includes(zip));

async function seed(page: Page, zip: string) {
  await page.addInitScript((prefs: string) => {
    if (window.name.includes('probe-seeded')) return;
    window.name += ' probe-seeded';
    localStorage.setItem('oravan.prefs', prefs);
  }, JSON.stringify({ zip }));
}

async function eraseMyData(page: Page, m: M = en, expectDone = true) {
  const erase = page.locator('[data-record-erase]');
  await erase.getByRole('button', { name: m.impact.erase }).click();
  await erase.getByRole('button', { name: m.impact.confirmErase }).click();
  if (expectDone) await expect(erase.getByRole('status')).toHaveText(m.impact.erased);
}

/** What a /reps tab shows now: the ZIP line, the field, the "looking up" line, storage. */
async function repsState(page: Page) {
  return page.evaluate(() => {
    const line = document.querySelector('[data-zip-line]')?.textContent ?? null;
    const field = document.querySelector<HTMLInputElement>('[data-zip-field]');
    const looking = document.querySelector('[data-saved-zip-lookup]')?.textContent ?? null;
    let stored: string | null = null;
    try {
      stored = JSON.parse(localStorage.getItem('oravan.prefs') ?? 'null')?.zip ?? null;
    } catch {
      stored = 'unreadable';
    }
    const entry = (window.history.state as Record<string, unknown> | null)?.oravanMembers ?? null;
    return { line, field: field ? field.value : null, looking, stored, entry };
  });
}

/** Tell a tab it is back: focus, visible, and a synthetic persisted pageshow. */
async function wake(page: Page) {
  await page.bringToFront();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
}

/* ---------------------------------------------------------------- (i) */

const FLOWS: { name: string; expect: string | null; act: (b: Page) => Promise<void> }[] = [
  { name: 'erase', expect: null, act: async (b) => eraseMyData(b) },
  {
    name: 'erase then save 10001',
    expect: NEW,
    act: async (b) => {
      await eraseMyData(b);
      await b.goto('/');
      await b.getByRole('textbox', { name: en.home.zipLabel }).fill(NEW);
      await b.getByRole('button', { name: en.home.zipCta }).click();
      await expect(b.locator('[data-zip-line]')).toContainText(NEW);
    },
  },
  {
    name: 'change to 10001 without erasing',
    expect: NEW,
    act: async (b) => {
      await b.goto('/reps?change=1');
      const f = b.getByRole('textbox', { name: en.home.zipLabel });
      await f.fill(NEW);
      await f.press('Enter');
      await expect(b.locator('[data-zip-line]')).toContainText(NEW);
    },
  },
  {
    name: 'erase then save 78501 again',
    expect: OLD,
    act: async (b) => {
      await eraseMyData(b);
      await b.goto('/');
      await b.getByRole('textbox', { name: en.home.zipLabel }).fill(OLD);
      await b.getByRole('button', { name: en.home.zipCta }).click();
      await expect(b.locator('[data-zip-line]')).toContainText(OLD);
    },
  },
];

for (const flow of FLOWS) {
  test(`(i) two tabs, A shows 78501, B: ${flow.name}`, async ({ context }) => {
    const a = await context.newPage();
    await seed(a, OLD);
    await a.goto('/reps');
    await expect(a.locator('[data-zip-line]')).toContainText(OLD);
    const b = await context.newPage();
    await b.goto('/record');
    const sentA = record(a);
    await flow.act(b);
    const before = await repsState(a);
    await wake(a);
    // Settle: the tab must come to match storage.
    await expect
      .poll(async () => {
        const s = await repsState(a);
        if (s.stored !== flow.expect) return `storage ${s.stored}`;
        if (s.line && !s.line.includes(flow.expect ?? '@@')) return `shows ${s.line}`;
        if (s.looking) return `stuck looking: ${s.looking}`;
        if (!s.line && s.field === null) return 'no form and no members';
        if (!s.line && flow.expect === null && s.field !== '') return `field holds ${s.field}`;
        return 'ok';
      }, { timeout: 8000 })
      .toBe('ok');
    const after = await repsState(a);
    log({ before, after, requestsFromA: sentA });
    const stale = flow.expect === OLD ? [] : carries(sentA, OLD);
    expect(stale, 'A sent the erased or replaced ZIP').toEqual([]);
    expect(sentA.filter((r) => r.method === 'POST').length, 'A storm').toBeLessThanOrEqual(2);
  });
}

/* My own suspicion: A's arrival lookup is out when B erases; B then saves the
   same ZIP again. Does A end on "Looking up 78501…" with no form? */
test('(i-b) two tabs: A arrival lookup held, B erases, then B saves 78501 again', async ({ context }) => {
  const a = await context.newPage();
  await seed(a, OLD);
  let held!: Route;
  const caught = new Promise<void>((ok) => {
    void a.route('**/reps', (route) => {
      if (!isLookup(route.request()) || held) return route.continue();
      held = route;
      ok();
    });
  });
  await a.goto('/reps');
  await caught;
  await expect(a.locator('[data-saved-zip-lookup]')).toBeVisible();
  const b = await context.newPage();
  await b.goto('/record');
  await eraseMyData(b);
  await expect(a.locator('[data-saved-zip-lookup]')).toHaveCount(0);
  const answered = a.waitForEvent('requestfinished', isLookup);
  await held.continue();
  await answered;
  await b.goto('/');
  await b.getByRole('textbox', { name: en.home.zipLabel }).fill(OLD);
  await b.getByRole('button', { name: en.home.zipCta }).click();
  await expect(b.locator('[data-zip-line]')).toContainText(OLD);
  await wake(a);
  await a.waitForTimeout(1500); // observation window only
  const s = await repsState(a);
  log(s);
  expect(s.looking, 'A is stuck on the "looking up" line with no form').toBeNull();
  expect(s.field !== null || s.line !== null, 'A has a form or members').toBe(true);
});

/* --------------------------------------------------------------- (ii) */

async function hold3s(page: Page, match: (r: Request) => boolean): Promise<{ caught: Promise<void> }> {
  let caughtOk!: () => void;
  const caught = new Promise<void>((ok) => (caughtOk = ok));
  let n = 0;
  await page.route('**/*', async (route) => {
    if (!match(route.request()) || n++ > 0) return route.fallback();
    caughtOk();
    await new Promise((r) => setTimeout(r, 3000));
    await route.fallback();
  });
  return { caught };
}

for (const [prefix, m] of [
  ['', en],
  ['/es', es],
] as const) {
  test(`(ii) ${prefix || '/en'} arrival lookup held 3s, erase during it`, async ({ page }) => {
    await seed(page, OLD);
    const { caught } = await hold3s(page, isLookup);
    await page.goto(`${prefix}/reps`);
    await caught;
    const sent = record(page);
    await eraseMyData(page, m);
    await page.waitForEvent('requestfinished', isLookup);
    await page.waitForTimeout(300);
    const s = await repsState(page);
    log(s, sent);
    expect(s.line).toBeNull();
    expect(s.field).toBe('');
    expect(s.entry).toBeNull();
    await page.reload();
    await expect(page.getByText(m.reps.noZip)).toBeVisible();
    expect(carries(sent, OLD)).toEqual([]);
  });
}

test('(ii) typed ZIP lookup held 3s, erase during it', async ({ page }) => {
  await page.goto('/reps');
  const { caught } = await hold3s(page, isLookup);
  const f = page.getByRole('textbox', { name: en.home.zipLabel });
  await f.fill(OLD);
  await f.press('Enter');
  await caught;
  const sent = record(page);
  await eraseMyData(page);
  await page.waitForEvent('requestfinished', isLookup);
  await page.waitForTimeout(300);
  const s = await repsState(page);
  log(s, sent);
  expect(s.line).toBeNull();
  expect(s.field).toBe('');
  await page.reload();
  await expect(page.getByText(en.reps.noZip)).toBeVisible();
  expect(carries(sent, OLD)).toEqual([]);
});

test('(ii) street-address check held 3s, erase during it', async ({ page }) => {
  await seed(page, NEW);
  await page.route('**/api/district', async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.fulfill({ status: 200, contentType: 'application/json', body: NY12 });
  });
  await page.goto('/reps');
  await expect(page.getByLabel(en.reps.addressLabel)).toBeVisible();
  await page.getByLabel(en.reps.addressLabel).fill(ADDRESS);
  const district = page.waitForRequest('**/api/district');
  await page.getByRole('button', { name: en.reps.refineCta }).click();
  await district;
  const sent = record(page);
  await eraseMyData(page);
  await page.waitForEvent('requestfinished', (r) => r.url().endsWith('/api/district'));
  await page.waitForTimeout(500);
  const s = await repsState(page);
  log(s, sent);
  expect(s.line).toBeNull();
  expect(carries(sent, NEW)).toEqual([]);
  expect(sent.filter((r) => r.body.includes(ADDRESS) || r.url.includes('Probe'))).toEqual([]);
});

test('(ii) "Show all districts" lookup held 3s, erase during it', async ({ page }) => {
  await seed(page, NEW);
  await page.route('**/api/district', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: NY12 }));
  await page.goto('/reps');
  await page.getByLabel(en.reps.addressLabel).fill(ADDRESS);
  await page.getByRole('button', { name: en.reps.refineCta }).click();
  const showAll = page.getByRole('link', { name: /Show all districts/ });
  await expect(showAll).toBeVisible();
  const { caught } = await hold3s(page, isLookup);
  await showAll.click();
  await caught;
  const sent = record(page);
  await eraseMyData(page);
  await page.waitForEvent('requestfinished', isLookup);
  await page.waitForTimeout(300);
  const s = await repsState(page);
  log(s, sent);
  expect(s.line).toBeNull();
  expect(s.entry).toBeNull();
  await page.reload();
  await page.goBack().catch(() => null);
  await page.waitForTimeout(800);
  log('after reload and Back', await repsState(page), sent);
  expect(carries(sent, NEW)).toEqual([]);
});

/* -------------------------------------------------------------- (iii) */

const isScript = (url: string) => /\/_next\/static\/.*\.js(\?.*)?$/.test(url);
async function holdScripts(page: Page): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  await page.route((url) => isScript(url.toString()), async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

for (const [prefix, m] of [
  ['', en],
  ['/es', es],
] as const) {
  test(`(iii) ${prefix || '/en'} home WITH a saved ZIP: a ZIP typed before the page wakes`, async ({ page }) => {
    await seed(page, OLD);
    const release = await holdScripts(page);
    const sent = record(page);
    await page.goto(`${prefix}/`, { waitUntil: 'commit' });
    const field = page.getByRole('textbox', { name: m.home.zipLabel });
    await field.fill(NEW);
    release();
    await page.waitForTimeout(4000); // observation window: the lookup answers and the hero may swap
    const shown = await page.evaluate(() => ({
      savedBlock: document.querySelector('[data-saved-zip]')?.getAttribute('data-saved-zip') ?? null,
      field: document.querySelector<HTMLInputElement>('[data-zip-field]')?.value ?? null,
      stored: JSON.parse(localStorage.getItem('oravan.prefs') ?? 'null')?.zip ?? null,
    }));
    log({ shown, sent: sent.filter((r) => r.method === 'POST' || r.url.includes('/api/')) });
    // Report only: the author's admitted gap.
    expect(true).toBe(true);
  });
}

test('(iii) /reps?change=1 with a saved ZIP: field focused by keyboard before wake: what is selected', async ({ page }) => {
  await seed(page, OLD);
  const release = await holdScripts(page);
  await page.goto('/reps?change=1', { waitUntil: 'commit' });
  const field = page.getByRole('textbox', { name: en.home.zipLabel });
  await field.waitFor();
  const focusedBefore = await page.evaluate(() => document.activeElement?.getAttribute('name') ?? document.activeElement?.tagName);
  release();
  await page.waitForFunction(() => {
    const f = document.querySelector('[data-zip-field]');
    return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps$'));
  });
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => {
    const f = document.querySelector<HTMLInputElement>('[data-zip-field]')!;
    return { value: f.value, focused: document.activeElement === f, selStart: f.selectionStart, selEnd: f.selectionEnd };
  });
  log({ focusedBefore, after });
  await page.keyboard.type(NEW);
  await expect(field).toHaveValue(NEW);
});

/* --------------------------------------------------------------- (iv) */

const failRemove = (key: string) => {
  const orig = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function (this: Storage, k: string) {
    if (k === key) throw new DOMException('probe: refused', 'SecurityError');
    return orig.call(this, k);
  };
};
const blockNow = () => {
  for (const name of ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const) {
    (Storage.prototype as unknown as Record<string, unknown>)[name] = () => {
      throw new DOMException('probe: blocked', 'SecurityError');
    };
  }
};

for (const where of ['/reps', '/record'] as const) {
  test(`(iv) ${where}: erase while oravan.prefs will not go`, async ({ page }) => {
    await seed(page, OLD);
    await page.addInitScript(failRemove, 'oravan.prefs');
    await page.goto(where);
    if (where === '/reps') await expect(page.locator('[data-zip-line]')).toContainText(OLD);
    else await expect(page.locator('[data-record-erase]')).toBeVisible();
    await eraseMyData(page, en, false);
    await page.waitForTimeout(300);
    const box = page.locator('[data-record-erase]');
    const shown = await page.evaluate(() => ({
      status: document.querySelector('[data-record-erase] [role=status]')?.textContent ?? null,
      focus: document.activeElement?.textContent?.trim().slice(0, 60) ?? null,
      zipLine: document.querySelector('[data-zip-line]')?.textContent ?? null,
      stored: localStorage.getItem('oravan.prefs'),
    }));
    expect(shown.status).not.toBe(en.impact.erased);
    await expect(box.getByRole('button', { name: en.impact.erase })).toBeVisible();
    const sent = record(page);
    await page.reload();
    await page.waitForTimeout(2500);
    log({ shown, afterReload: where === '/reps' ? await repsState(page) : null, sentOnReload: carries(sent, OLD) });
  });

  test(`(iv) ${where}: storage blocked mid-visit, then erase`, async ({ page }) => {
    await seed(page, OLD);
    await page.goto(where);
    if (where === '/reps') await expect(page.locator('[data-zip-line]')).toContainText(OLD);
    else await expect(page.locator('[data-record-erase]')).toBeVisible();
    await page.evaluate(blockNow);
    await page.addInitScript(blockNow);
    await eraseMyData(page, en, false);
    await page.waitForTimeout(300);
    const box = page.locator('[data-record-erase]');
    const shown = await page.evaluate(() => ({
      status: document.querySelector('[data-record-erase] [role=status]')?.textContent ?? null,
      focus: document.activeElement?.textContent?.trim().slice(0, 60) ?? null,
      zipLine: document.querySelector('[data-zip-line]')?.textContent ?? null,
    }));
    expect(shown.status).not.toBe(en.impact.erased);
    expect(shown.zipLine).toBeNull();
    await expect(box.getByRole('button', { name: en.impact.erase })).toBeVisible();
    const sent = record(page);
    await page.reload();
    await page.waitForTimeout(2500);
    log({ shown, sentOnReload: carries(sent, OLD) });
    expect(carries(sent, OLD)).toEqual([]);
  });
}

/* ---------------------------------------------------------------- (4) */

test('(4) the street address travels once, in a POST body, and is nowhere after', async ({ page }) => {
  await seed(page, NEW);
  const sent = record(page);
  await page.route('**/api/district', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: NY12 }));
  await page.goto('/reps');
  await page.getByLabel(en.reps.addressLabel).fill(ADDRESS);
  await page.getByRole('button', { name: en.reps.refineCta }).click();
  await expect(page.getByRole('link', { name: /Show all districts/ })).toBeVisible();
  await page.reload();
  await page.waitForTimeout(1500);
  await page.goBack().catch(() => null);
  await page.waitForTimeout(1000);
  const withAddress = sent.filter((r) => r.body.includes('Probe') || decodeURIComponent(r.url).includes('Probe'));
  const where = await page.evaluate(() => {
    const all: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) all[localStorage.key(i)!] = localStorage.getItem(localStorage.key(i)!)!;
    return { ls: JSON.stringify(all), ss: sessionStorage.length, cookie: document.cookie, state: JSON.stringify(window.history.state), name: window.name, url: location.href };
  });
  log({ withAddress, where });
  expect(withAddress.map((r) => `${r.method} ${r.url}`)).toEqual(['POST /api/district']);
  expect(withAddress[0].url).not.toContain('Probe');
  for (const v of Object.values(where)) expect(String(v)).not.toContain('Probe');
});

/* ---------------------------------------------------------------- (vi) */

for (const [prefix, m] of [
  ['', en],
  ['/es', es],
] as const) {
  test(`(vi) ${prefix || '/en'} ordinary visit: ZIP -> members -> bill -> script, requests counted`, async ({ page }) => {
    await mockScriptApi(page);
    const sent = record(page);
    await page.goto(`${prefix}/`);
    await page.getByRole('textbox', { name: m.home.zipLabel }).fill(OLD);
    await page.getByRole('button', { name: m.home.zipCta }).click();
    await expect(page.locator('[data-zip-line]')).toContainText(OLD);
    const atReps = sent.filter((r) => r.method === 'POST' || r.url.startsWith('/api/')).length;
    await page.goto(`${prefix}/bills/${referenceBill().slug}`);
    const stance = page.getByRole('radio', { name: m.bill.stance.support });
    await expect(async () => {
      const req = page.waitForRequest('**/api/script', { timeout: 3000 });
      await stance.click();
      await req;
    }).toPass({ timeout: 30_000 });
    await expect(page.getByRole('textbox', { name: m.bill.scriptTitle })).toBeVisible();
    const api = sent.filter((r) => r.method === 'POST' || r.url.startsWith('/api/'));
    log({ atReps, api: api.map((r) => `${r.method} ${r.url} ${r.body.includes(OLD) ? '(zip in body)' : ''}`) });
    expect(api.filter((r) => isLookupLike(r)).length).toBe(1);
    expect(api.filter((r) => r.url.startsWith('/api/reps')).length).toBeLessThanOrEqual(1);
  });
}
function isLookupLike(r: { method: string; url: string }) {
  return r.method === 'POST' && /\/reps$/.test(r.url);
}


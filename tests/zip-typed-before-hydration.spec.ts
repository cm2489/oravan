import { expect, test, type Page, type Route } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * A ZIP TYPED BEFORE THE PAGE WAKES IS THE ZIP THAT IS SENT (2026-11-19, PR #521).
 *
 * The ZIP field (components/ZipForm.tsx) is filled in from the saved ZIP, and
 * the server cannot know that ZIP: it renders the field empty. A reader who
 * types into it before the page's JavaScript has started (a slow phone, a
 * busy machine) used to lose what they typed. Once the page started, React
 * left the typed value in place, and then wrote the saved ZIP over it
 * (React 19 keeps a value typed before hydration, but nothing tells the
 * component it is there). Enter then saved and looked up the OLD ZIP. On
 * /reps?change=1 ("Change ZIP code") that is the whole point of the page.
 *
 * Found by tests/erase-reach.spec.ts's two-tab cases, which failed about one
 * run in four under a loaded machine (the checker's round 5): the second tab
 * typed 10001 on /reps?change=1 and showed "ZIP code 78501".
 *
 * Here the page's scripts are held back until the field is filled, so the
 * typing lands before the page wakes every time, not one run in four.
 */

const SAVED = '78501';
const TYPED = '10001';
const isScript = (url: string) => /\/_next\/static\/.*\.js(\?.*)?$/.test(url);

/** Holds every script of the page until `release` is called. */
async function holdScripts(page: Page): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  await page.route(
    (url) => isScript(url.toString()),
    async (route: Route) => {
      await gate;
      await route.continue();
    }
  );
  return release;
}

/** The field React has taken over, and every effect of that first render run. */
async function awake(page: Page) {
  await page.waitForFunction(() => {
    const f = document.querySelector('[data-zip-field]');
    return !!f && Object.keys(f).some((k) => k.startsWith('__reactProps$'));
  });
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 50))))
  );
}

async function save(page: Page, zip: string) {
  await page.addInitScript((prefs: string) => {
    if (window.name.includes('e2e-seeded')) return;
    window.name += ' e2e-seeded';
    localStorage.setItem('oravan.prefs', prefs);
  }, JSON.stringify({ zip }));
}

/** Which of the two ZIPs each members lookup carried, in order. */
function lookups(page: Page): string[] {
  const zips: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !/\/reps$/.test(new URL(r.url()).pathname)) return;
    const body = r.postData() ?? '';
    for (const zip of [SAVED, TYPED]) if (body.includes(zip)) zips.push(zip);
  });
  return zips;
}

for (const [prefix, m] of [
  ['', en],
  ['/es', es],
] as const) {
  test(`${prefix || '/en'}/reps?change=1 with a ZIP saved: a new ZIP typed before the page wakes is kept, saved and looked up`, async ({ page }) => {
    await save(page, SAVED);
    const release = await holdScripts(page);
    const sent = lookups(page);
    await page.goto(`${prefix}/reps?change=1`, { waitUntil: 'commit' });
    const field = page.getByRole('textbox', { name: m.home.zipLabel });
    await field.fill(TYPED);
    release();
    await awake(page);
    await expect(field).toHaveValue(TYPED);
    await field.press('Enter');
    await expect(page.locator('[data-zip-line]')).toContainText(TYPED);
    await expect(page.locator('main')).not.toContainText(SAVED);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('oravan.prefs') ?? '{}').zip)).toBe(TYPED);
    expect(sent).not.toContain(SAVED);
  });
}

/* The field had focus while it stood empty, and the saved ZIP arrived as the
   page woke: it arrives selected, so the next keys replace it. (A driver's
   fill selects the empty field, then types: on CI the typing landed on the
   five saved digits and went nowhere, 2026-11-19.) */
test('/reps?change=1 with a ZIP saved: a field focused before the page wakes gets the saved ZIP selected, and typing replaces it', async ({ page }) => {
  await save(page, SAVED);
  const release = await holdScripts(page);
  const sent = lookups(page);
  await page.goto('/reps?change=1', { waitUntil: 'commit' });
  const field = page.getByRole('textbox', { name: en.home.zipLabel });
  await field.waitFor();
  await field.evaluate((el: HTMLInputElement) => {
    el.focus();
    el.select();
  });
  release();
  await awake(page);
  await expect(field).toHaveValue(SAVED);
  await page.keyboard.insertText(TYPED);
  await expect(field).toHaveValue(TYPED);
  await field.press('Enter');
  await expect(page.locator('[data-zip-line]')).toContainText(TYPED);
  expect(sent).not.toContain(SAVED);
});

test('/reps with no ZIP saved: a ZIP typed before the page wakes is kept and looked up', async ({ page }) => {
  const release = await holdScripts(page);
  const sent = lookups(page);
  await page.goto('/reps', { waitUntil: 'commit' });
  const field = page.getByRole('textbox', { name: en.home.zipLabel });
  await field.fill(TYPED);
  release();
  await awake(page);
  await expect(field).toHaveValue(TYPED);
  await field.press('Enter');
  await expect(page.locator('[data-zip-line]')).toContainText(TYPED);
  expect(sent).toEqual([TYPED]);
});

test('the home page with no ZIP saved: a ZIP typed before the page wakes is kept and saved', async ({ page }) => {
  const release = await holdScripts(page);
  await page.goto('/', { waitUntil: 'commit' });
  const field = page.getByRole('textbox', { name: en.home.zipLabel });
  await field.fill(TYPED);
  release();
  await awake(page);
  await expect(field).toHaveValue(TYPED);
  await field.press('Enter');
  await expect(page).toHaveURL(/\/reps$/);
  await expect(page.locator('[data-zip-line]')).toContainText(TYPED);
});

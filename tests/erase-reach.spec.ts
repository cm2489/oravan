import { expect, test, type Page, type Request } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { referenceBill } from './corpus-fixtures';
import { mockScriptApi } from './helpers';

/*
 * WHAT AN ERASE REACHES, AND EVERY WAY OFF THE ERROR SCREEN (2026-11-18).
 *
 * Two defects, found together (PR #521):
 *
 * 1. The error screen (app/[locale]/error.tsx) asked the app that had just
 *    crashed to render again. On /reps with a saved ZIP, the crashing page's
 *    own members lookup answers behind the screen, and from then on the next
 *    render of the router's root fails (React #310): "Try again", "Go home",
 *    the header's links, Back, and the erase each took the whole document
 *    down to the framework's "This page couldn't load". Every way out is now a
 *    full page load.
 *
 * 2. The members page keeps the ZIP it showed in this tab's history entries
 *    (lib/members-entry.ts), and an erase reached only the entry it stood on:
 *    Back, a reload after "Erase my data", or another open tab sent the
 *    erased ZIP to the lookup and showed the members again. Every entry now
 *    carries a tag kept in this browser's storage (lib/local.ts), an erase
 *    deletes the tag, and an entry without the current tag reads as empty.
 *
 * NOTHING HERE WAITS ON TIME. Each step waits on the event it is about: the
 * lookup's answer (`requestfinished`), the new document (`load`), a heading.
 *
 * THE FORCED CRASH stands in for one caused by stored data, and the erase
 * removes that cause, so it fires once per TAB: `window.name` survives the
 * reload an erase makes, in this tab only, and needs no storage (one case
 * runs with storage refused).
 */

const ZIP = '78501';
const PREFS = JSON.stringify({ zip: ZIP });

const LOCALES = [
  ['', en],
  ['/es', es],
] as const;

type M = typeof en;

/** Throw once, in this tab, from the next store subscription on a path that matches. */
const ARM = (pattern: string) => {
  if (window.name.includes('e2e-crashed')) return;
  const re = new RegExp(pattern);
  const add = window.addEventListener.bind(window);
  let armed = true;
  window.addEventListener = function (this: Window, type: string, ...rest: unknown[]) {
    if (type === 'storage' && armed && re.test(window.location.pathname)) {
      armed = false;
      window.name += ' e2e-crashed';
      throw new Error('e2e: forced client crash');
    }
    return (add as unknown as (...a: unknown[]) => void)(type, ...rest);
  } as unknown as typeof window.addEventListener;
};
const REPS_PATH = '(^|/)reps/?$';

/** A saved ZIP, planted once per tab before the first paint. */
async function seedZipOnce(page: Page) {
  await page.addInitScript((prefs: string) => {
    if (window.name.includes('e2e-seeded')) return;
    window.name += ' e2e-seeded';
    localStorage.setItem('oravan.prefs', prefs);
  }, PREFS);
}

/** Every request that carries the ZIP, in its address or its body. */
function zipSends(page: Page): Request[] {
  const sent: Request[] = [];
  page.on('request', (r) => {
    if (r.url().includes(ZIP) || (r.postData() ?? '').includes(ZIP)) sent.push(r);
  });
  return sent;
}

const isLookup = (r: Request) => r.method() === 'POST' && /\/reps$/.test(new URL(r.url()).pathname);

function navLink(page: Page, m: M, key: 'reps' | 'bills' | 'moments') {
  return page
    .getByRole('navigation', { name: m.common.nav.primaryLabel })
    .getByRole('link', { name: new RegExp(`^(${m.common.nav[key]}|${m.common.navShort[key]})$`) });
}

/** /reps, crashed by its own first store subscription, with its lookup answered behind the screen. */
async function crashRepsWithLookupAnswered(page: Page, prefix: string, m: M) {
  await seedZipOnce(page);
  await page.addInitScript(ARM, REPS_PATH);
  const answered = page.waitForEvent('requestfinished', isLookup);
  await page.goto(`${prefix}/reps`);
  await expect(page.getByRole('heading', { level: 1, name: m.errorBoundary.title })).toBeVisible();
  await answered;
}

async function expectWorkingMembers(page: Page, m: M) {
  await expect(page.getByRole('heading', { level: 1, name: m.reps.membersHeading })).toBeVisible();
  await expect(page.locator('[data-zip-line]')).toContainText(ZIP);
}

async function expectPromptOnly(page: Page, m: M) {
  await expect(page.getByRole('heading', { level: 1, name: m.reps.membersHeading })).toBeVisible();
  await expect(page.getByText(m.reps.noZip)).toBeVisible();
  await expect(page.getByRole('textbox', { name: m.home.zipLabel })).toHaveValue('');
  await expect(page.locator('[data-zip-line]')).toHaveCount(0);
}

for (const [prefix, m] of LOCALES) {
  const label = prefix || '/en';

  test(`${label}: "Try again" on the Reps error screen reloads onto a working page`, async ({ page }) => {
    await crashRepsWithLookupAnswered(page, prefix, m);
    const fresh = page.waitForEvent('load');
    await page.getByRole('button', { name: m.errorBoundary.retry }).click();
    await fresh;
    // The saved ZIP is untouched (no erase), so the page looks it up: a
    // lookup that answers and renders is the proof the app works again.
    await expectWorkingMembers(page, m);
  });

  test(`${label}: "Go home" on the Reps error screen loads the home page, and the app works`, async ({ page }) => {
    await crashRepsWithLookupAnswered(page, prefix, m);
    const fresh = page.waitForEvent('load');
    await page.getByRole('link', { name: m.errorBoundary.home }).click();
    await fresh;
    await expect(page).toHaveURL(new RegExp(`^https?://[^/]+${prefix}/?$`));
    await expect(page.getByRole('heading', { level: 1, name: m.home.heroTitle })).toBeVisible();
    // A client-side walk and a lookup: the router renders again.
    await navLink(page, m, 'reps').click();
    await expectWorkingMembers(page, m);
  });

  test(`${label}: the header's links and Back on the Reps error screen load whole pages`, async ({ page }) => {
    await crashRepsWithLookupAnswered(page, prefix, m);
    const fresh = page.waitForEvent('load');
    await navLink(page, m, 'bills').click();
    await fresh;
    await expect(page.getByRole('heading', { level: 1, name: m.bills.title })).toBeVisible();

    // Back to the page that crashed works.
    await page.goBack();
    await expect(page).toHaveURL(/\/reps$/);
    await expectWorkingMembers(page, m);
  });
}

test('Back after a client-side walk, from the error screen, loads the page it goes to', async ({ page }) => {
  await seedZipOnce(page);
  await page.goto('/');
  await expect(page.locator('[data-saved-zip]')).toHaveAttribute('data-saved-zip', ZIP);
  await page.evaluate(ARM, REPS_PATH);
  const answered = page.waitForEvent('requestfinished', isLookup);
  await navLink(page, en, 'reps').click();
  await expect(page.getByRole('heading', { level: 1, name: en.errorBoundary.title })).toBeVisible();
  await answered;
  const fresh = page.waitForEvent('load');
  await page.goBack();
  await fresh;
  await expect(page.getByRole('heading', { level: 1, name: en.home.heroTitle })).toBeVisible();
  await expect(page.locator('[data-saved-zip]')).toHaveAttribute('data-saved-zip', ZIP);
});

/*
 * THE REVIEWER'S STEPS: the members are on screen at /reps, the visitor walks
 * to /record, it crashes, they erase, then press Back. Before: the erased ZIP
 * was sent to the lookup and the members and the ZIP were on screen again.
 */
test('Back after an erase: the earlier entry sends nothing and shows nothing', async ({ page }) => {
  await seedZipOnce(page);
  await page.goto('/reps');
  await expectWorkingMembers(page, en);

  // A client-side walk to the record (the app's own router), crashing there.
  await page.evaluate(ARM, '(^|/)record/?$');
  await page.evaluate(() => (window as unknown as { next: { router: { push(h: string): void } } }).next.router.push('/record'));
  await expect(page.getByRole('heading', { level: 1, name: en.errorBoundary.title })).toBeVisible();
  await page.getByRole('button', { name: en.errorBoundary.erase }).click();
  const fresh = page.waitForEvent('load');
  await page.getByRole('button', { name: en.impact.confirmErase }).click();
  await fresh;
  await expect(page.getByRole('heading', { level: 1, name: en.impact.title })).toBeVisible();

  // Back to the members' entry. Next.js keeps its router state in each
  // entry, so this Back is its own client-side restore, not a page load.
  const sent = zipSends(page);
  await page.goBack();
  await expect(page).toHaveURL(/\/reps$/);
  await expectPromptOnly(page, en);
  expect(sent.map((r) => `${r.method()} ${r.url()}`)).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('oravan.entry'))).toBeNull();
});

/*
 * After an erase and its reload, the app is the app: two client-side walks,
 * then Back and Forward over both, and every page renders. (Where Back puts
 * the scroll is not asserted: with no crash at all it already varies by
 * hundreds of pixels on webkit-mobile from one run to the next; PR #521
 * reports it measured with and without the erase.)
 */
test('after an erase, Back and Forward across two client-side walks render every page', async ({ page }) => {
  await crashRepsWithLookupAnswered(page, '', en);
  await page.getByRole('button', { name: en.errorBoundary.erase }).click();
  const fresh = page.waitForEvent('load');
  await page.getByRole('button', { name: en.impact.confirmErase }).click();
  await fresh;
  await expectPromptOnly(page, en);

  await navLink(page, en, 'bills').click();
  await expect(page.getByRole('heading', { level: 1, name: en.bills.title })).toBeVisible();
  await navLink(page, en, 'moments').click();
  await expect(page).toHaveURL(/\/questions$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/bills$/);
  await expect(page.getByRole('heading', { level: 1, name: en.bills.title })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/reps$/);
  await expectPromptOnly(page, en);
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: en.bills.title })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/questions$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: /couldn/ })).toHaveCount(0);
});

/*
 * THE RECORD'S OWN "Erase my data", on /reps. Before: the members and the ZIP
 * stayed on screen and in the entry, and a reload sent the ZIP again.
 */
test('"Erase my data" on /reps takes the members off the screen; reload and Back send nothing', async ({ page }) => {
  await seedZipOnce(page);
  await page.goto('/reps'); // entry 1: the members, tagged
  await expectWorkingMembers(page, en);
  await navLink(page, en, 'bills').click(); // entry 2
  await expect(page.getByRole('heading', { level: 1, name: en.bills.title })).toBeVisible();
  await navLink(page, en, 'reps').click(); // entry 3: the members again
  await expectWorkingMembers(page, en);

  const erase = page.locator('[data-record-erase]');
  await erase.getByRole('button', { name: en.impact.erase }).click();
  await erase.getByRole('button', { name: en.impact.confirmErase }).click();
  await expect(erase.getByRole('status')).toHaveText(en.impact.erased);
  await expectPromptOnly(page, en);
  // Focus stays on the erase's confirmation, on screen; the prompt does not
  // take it, and the page shrinking above does not leave it out of view.
  await expect(erase.getByRole('status')).toBeFocused();
  await expect(erase.getByRole('status')).toBeInViewport();

  const sent = zipSends(page);
  await page.reload();
  await expectPromptOnly(page, en);
  await page.goBack(); // entry 2
  await expect(page.getByRole('heading', { level: 1, name: en.bills.title })).toBeVisible();
  await page.goBack(); // entry 1, written by the document before the reload
  await expect(page).toHaveURL(/\/reps$/);
  await expectPromptOnly(page, en);
  expect(sent.map((r) => `${r.method()} ${r.url()}`)).toEqual([]);
});

/*
 * A LOOKUP STILL ON ITS WAY WHEN THE ERASE COMES: its answer is for a ZIP
 * that no longer exists here, so it is neither shown nor remembered in the
 * entry. A lookup made after the erase is shown as usual.
 */
test('a lookup answering after "Erase my data" is dropped; the next one shows', async ({ page }) => {
  await seedZipOnce(page);
  const held: import('@playwright/test').Route[] = [];
  let release!: () => void;
  const caught = new Promise<void>((ok) => (release = ok));
  await page.route('**/reps', async (route) => {
    if (!isLookup(route.request()) || held.length > 0) return route.continue();
    held.push(route);
    release();
  });
  await page.goto('/reps'); // the saved ZIP's lookup goes out, and is held
  await caught;
  const erase = page.locator('[data-record-erase]');
  await erase.getByRole('button', { name: en.impact.erase }).click();
  await erase.getByRole('button', { name: en.impact.confirmErase }).click();
  await expect(erase.getByRole('status')).toHaveText(en.impact.erased);
  // Still on its way: the line naming the saved ZIP has already given way.
  await expectPromptOnly(page, en);
  await expect(page.getByText(ZIP)).toHaveCount(0);

  const answered = page.waitForEvent('requestfinished', isLookup);
  await held[0].continue();
  await answered;
  await expectPromptOnly(page, en);
  expect(await page.evaluate(() => window.history.state?.oravanMembers ?? null)).toBeNull();

  const zip = page.getByRole('textbox', { name: en.home.zipLabel });
  await zip.fill(ZIP);
  await zip.press('Enter');
  await expectWorkingMembers(page, en);
});

/*
 * BACK BETWEEN TWO OF THE MEMBERS PAGE'S OWN ENTRIES (one document, the page
 * stays mounted and reads the entry Back lands on): after an erase, the
 * earlier entry's ZIP is not looked up.
 */
test('after "Erase my data", Back to an earlier members entry on the same page sends nothing', async ({ page }) => {
  const FIRST = '10001';
  await seedZipOnce(page);
  await page.goto('/reps'); // entry 1: the saved ZIP's members, tagged
  await expectWorkingMembers(page, en);
  // Reloaded, so the tag already exists when the page opens: Back must read
  // the tag as it is NOW (after the erase), not as it was then.
  await page.reload();
  await expectWorkingMembers(page, en);
  await page.getByRole('link', { name: en.reps.changeZip }).click(); // entry 2
  const zip = page.getByRole('textbox', { name: en.home.zipLabel });
  await zip.fill(FIRST);
  await zip.press('Enter');
  await expect(page.locator('[data-zip-line]')).toContainText(FIRST);

  const erase = page.locator('[data-record-erase]');
  await erase.getByRole('button', { name: en.impact.erase }).click();
  await erase.getByRole('button', { name: en.impact.confirmErase }).click();
  await expect(erase.getByRole('status')).toHaveText(en.impact.erased);
  await expectPromptOnly(page, en);

  const sent: string[] = [];
  page.on('request', (r) => {
    if (isLookup(r)) sent.push(r.postData() ?? '');
  });
  await page.goBack();
  await expect(page).toHaveURL(/\/reps$/);
  await expectPromptOnly(page, en);
  await page.goForward();
  await expectPromptOnly(page, en);
  expect(sent).toEqual([]);
});

/*
 * A link opened in a new tab from the error screen (Cmd/Ctrl-click) is the
 * browser's to open: this tab stays where it is.
 */
test('a modified click on a link on the error screen leaves this tab alone', async ({ page, context }) => {
  await crashRepsWithLookupAnswered(page, '', en);
  const opened = context.waitForEvent('page');
  await navLink(page, en, 'bills').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await opened;
  await expect(page).toHaveURL(/\/reps$/);
  await expect(page.getByRole('heading', { level: 1, name: en.errorBoundary.title })).toBeVisible();
});

/*
 * ANOTHER OPEN TAB. What it has already painted cannot be reached from here;
 * what it sends and shows after a reload or Back can, and must be nothing.
 */
test('erase in one tab: Back and reload in another send nothing and show nothing', async ({ page, context }) => {
  await seedZipOnce(page);
  await page.goto('/reps');
  await expectWorkingMembers(page, en);

  const other = await context.newPage(); // same browser: same storage, own history
  await other.goto('/reps');
  await expectWorkingMembers(other, en);
  await navLink(other, en, 'bills').click();
  await expect(other.getByRole('heading', { level: 1, name: en.bills.title })).toBeVisible();

  const erase = page.locator('[data-record-erase]');
  await erase.getByRole('button', { name: en.impact.erase }).click();
  await erase.getByRole('button', { name: en.impact.confirmErase }).click();
  await expect(erase.getByRole('status')).toHaveText(en.impact.erased);

  const sent = zipSends(other);
  await other.goBack(); // a client-side Back, in the other tab's own app
  await expectPromptOnly(other, en);
  await other.reload();
  await expectPromptOnly(other, en);
  expect(sent.map((r) => `${r.method()} ${r.url()}`)).toEqual([]);
});

/*
 * AN ENTRY FROM BEFORE TAGS. A tab left open across the deploy holds an
 * entry with the ZIP and no tag. Read safely, it is nothing: the saved ZIP
 * (storage) still answers, and the entry's own ZIP is never sent.
 */
test('an entry written before tags is ignored; the saved ZIP still answers', async ({ page }) => {
  await seedZipOnce(page);
  await page.goto('/reps');
  await expectWorkingMembers(page, en);
  const OTHER = '10001';
  await page.evaluate((zip) => {
    window.history.replaceState({ ...window.history.state, oravanMembers: { zip } }, '');
  }, OTHER);
  const bodies: string[] = [];
  page.on('request', (r) => {
    if (isLookup(r)) bodies.push(r.postData() ?? '');
  });
  const answered = page.waitForEvent('requestfinished', isLookup);
  await page.reload();
  await answered;
  await expectWorkingMembers(page, en);
  expect(bodies.some((b) => b.includes(ZIP))).toBe(true);
  expect(bodies.some((b) => b.includes(OTHER))).toBe(false);

  // And with no saved ZIP, the untagged entry alone sends nothing at all.
  await page.evaluate(() => localStorage.removeItem('oravan.prefs'));
  await page.evaluate((zip) => {
    window.history.replaceState({ ...window.history.state, oravanMembers: { zip } }, '');
  }, OTHER);
  bodies.length = 0;
  await page.reload();
  await expectPromptOnly(page, en);
  expect(bodies).toEqual([]);
});

/*
 * STORAGE REFUSED (Safari blocking all site data): the ZIP lives in memory
 * for the visit (lib/local.ts), and the escape hatch still recovers.
 */
test('storage refused: the erase on the error screen still recovers onto a working page', async ({ page }) => {
  await page.addInitScript(() => {
    for (const name of ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const) {
      Object.defineProperty(Storage.prototype, name, {
        value: () => {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
    }
  });
  await page.goto('/reps');
  const zip = page.getByRole('textbox', { name: en.home.zipLabel });
  await zip.fill(ZIP);
  await zip.press('Enter');
  await expectWorkingMembers(page, en);

  await page.evaluate(ARM, '(^|/)record/?$');
  await page.evaluate(() => (window as unknown as { next: { router: { push(h: string): void } } }).next.router.push('/record'));
  await expect(page.getByRole('heading', { level: 1, name: en.errorBoundary.title })).toBeVisible();
  await page.getByRole('button', { name: en.errorBoundary.erase }).click();
  const fresh = page.waitForEvent('load');
  await page.getByRole('button', { name: en.impact.confirmErase }).click();
  await fresh;
  await expect(page.getByRole('heading', { level: 1, name: en.impact.title })).toBeVisible();

  await page.goto('/reps');
  await expectPromptOnly(page, en);
});

/* ------------------------------------------------------------------------
 * THE SECOND RE-CHECK (2026-11-18, PR #521): four more ways the erased ZIP
 * came back, and the error screen's in-page links. Each case below failed on
 * head 4ae57583. ZIP 10001 spans several districts, so its page offers the
 * street-address check; the check's answer is always made up here
 * (`/api/district` is answered by the test, never by a real service).
 * ---------------------------------------------------------------------- */

const SPLIT = '10001';
const ADDRESS = '100 Example Street';
const NY12 = JSON.stringify({ state: 'NY', district: 12 });

async function seedOnce(page: Page, zip: string) {
  await page.addInitScript((prefs: string) => {
    if (window.name.includes('e2e-seeded')) return;
    window.name += ' e2e-seeded';
    localStorage.setItem('oravan.prefs', prefs);
  }, JSON.stringify({ zip }));
}

/** Every request after this point that carries `zip` in its address or body. */
function sendsOf(page: Page, zip: string): string[] {
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes(zip) || (r.postData() ?? '').includes(zip)) sent.push(`${r.method()} ${r.url()}`);
  });
  return sent;
}

async function eraseMyData(page: Page, m: M = en) {
  const erase = page.locator('[data-record-erase]');
  await erase.getByRole('button', { name: m.impact.erase }).click();
  await erase.getByRole('button', { name: m.impact.confirmErase }).click();
  await expect(erase.getByRole('status')).toHaveText(m.impact.erased);
}

/** Nothing of the ZIP left in this tab's storage or its current entry. */
async function expectNothingKept(page: Page) {
  expect(
    await page.evaluate(() => [
      localStorage.getItem('oravan.prefs'),
      localStorage.getItem('oravan.entry'),
      (window.history.state as Record<string, unknown> | null)?.oravanMembers ?? null,
    ])
  ).toEqual([null, null, null]);
}

async function expectSplitPromptOnly(page: Page) {
  await expectPromptOnly(page, en);
  await expect(page.getByText('Daniel S. Goldman')).toHaveCount(0);
  await expect(page.getByLabel(en.reps.addressLabel)).toHaveCount(0);
}

/* A: the street-address check is still out when the visitor erases. Its
   answer must not send the ZIP and district on to the lookup, show them,
   or write them into history under a new tag. */
test('A: an erase while the street-address check is out: its answer sends nothing and shows nothing', async ({ page }) => {
  await seedOnce(page, SPLIT);
  let held!: import('@playwright/test').Route;
  const caught = new Promise<void>((ok) => {
    void page.route('**/api/district', (route) => {
      held = route;
      ok();
    });
  });
  await page.goto('/reps');
  await expect(page.getByText('Daniel S. Goldman').first()).toBeVisible();
  await page.getByLabel(en.reps.addressLabel).fill(ADDRESS);
  await page.getByRole('button', { name: en.reps.refineCta }).click();
  await caught;
  await eraseMyData(page);

  const sent = sendsOf(page, SPLIT);
  const answered = page.waitForEvent('requestfinished', (r) => r.url().endsWith('/api/district'));
  await held.fulfill({ status: 200, contentType: 'application/json', body: NY12 });
  await answered;
  await expectSplitPromptOnly(page);
  await expectNothingKept(page);
  await page.reload();
  await expectSplitPromptOnly(page);
  expect(sent).toEqual([]);
});

/* B: another tab's own saved-ZIP lookup is still out when this tab erases. */
test('B: two tabs: a lookup out in the other tab when this one erases is dropped there', async ({ context }) => {
  const here = await context.newPage();
  await here.goto('/record');
  await here.evaluate((zip) => localStorage.setItem('oravan.prefs', JSON.stringify({ zip })), ZIP);

  const other = await context.newPage();
  let held!: import('@playwright/test').Route;
  const caught = new Promise<void>((ok) => {
    void other.route('**/reps', (route) => {
      if (!isLookup(route.request()) || held) return route.continue();
      held = route;
      ok();
    });
  });
  await other.goto('/reps');
  await caught;

  await here.reload();
  await eraseMyData(here);
  // The other tab learns of the erase at once: its "looking up" line goes.
  await expectPromptOnly(other, en);

  const sent = sendsOf(other, ZIP);
  const answered = other.waitForEvent('requestfinished', isLookup);
  await held.continue();
  await answered;
  await expectPromptOnly(other, en);
  await expectNothingKept(other);
  await other.reload();
  await expectPromptOnly(other, en);
  expect(sent).toEqual([]);
});

/* C: the other tab already shows a ZIP of several districts. The erase here
   takes the members and the address form off its screen at once, so it
   cannot send the erased ZIP with an address. */
test('C: two tabs: the other tab drops a shown multi-district ZIP at once, and sends nothing after', async ({ context }) => {
  const other = await context.newPage();
  await other.route('**/api/district', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: NY12 }));
  await other.goto('/reps');
  const zip = other.getByRole('textbox', { name: en.home.zipLabel });
  await zip.fill(SPLIT);
  await zip.press('Enter');
  await expect(other.getByText('Daniel S. Goldman').first()).toBeVisible();
  await expect(other.getByLabel(en.reps.addressLabel)).toBeVisible();

  const here = await context.newPage();
  await here.goto('/record');
  const sent = sendsOf(other, SPLIT);
  await eraseMyData(here);

  await expectSplitPromptOnly(other);
  await expectNothingKept(other);
  await other.reload();
  await expectSplitPromptOnly(other);
  expect(sent).toEqual([]);
});

/* D: an old /reps?zip= link, a walk away, an erase, then Back twice. The
   router draws the old link's members from its own memory, with no request:
   they must not show, and must not be written into history again. */
for (const [prefix, m] of LOCALES) {
  test(`D ${prefix || '/en'}: an old /reps?zip= link, then an erase, then Back twice shows nothing`, async ({ page }) => {
    await page.goto(`${prefix}/reps?zip=${ZIP}`);
    await expect(page.locator('[data-zip-line]')).toContainText(ZIP);
    await expect(page).toHaveURL(new RegExp(`${prefix}/reps$`));
    await expect.poll(() => page.evaluate(() => Boolean(window.history.state?.oravanMembers))).toBe(true);
    await page.locator('main a[href*="/bills/"]').first().click();
    await expect(page).toHaveURL(/\/bills\//);
    await page.evaluate((to) => (window as unknown as { next: { router: { push(h: string): void } } }).next.router.push(to), `${prefix}/record`);
    await expect(page).toHaveURL(new RegExp(`${prefix}/record$`));
    await eraseMyData(page, m);

    const sent = sendsOf(page, ZIP);
    await page.goBack();
    await expect(page).toHaveURL(/\/bills\//);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${prefix}/reps$`));
    await expectPromptOnly(page, m);
    await expectNothingKept(page);
    await page.reload();
    await expectPromptOnly(page, m);
    expect(sent).toEqual([]);
  });
}

/* The back/forward cache: a page that slept through an erase made elsewhere
   is shown again (`pageshow`, persisted). Playwright's WebKit never restores
   a page that way, so the event is fired here by hand, after removing the
   keys as another page's erase would (which, in the same document, raises
   no `storage` event: exactly what a sleeping page hears). */
test('a page shown again from the back/forward cache after an erase elsewhere drops the members, sends nothing', async ({ page }) => {
  await seedZipOnce(page);
  await page.goto('/reps');
  await expectWorkingMembers(page, en);
  const sent = sendsOf(page, ZIP);
  await page.evaluate(() => {
    for (const k of ['oravan.prefs', 'oravan.calls', 'oravan.reads', 'oravan.entry']) localStorage.removeItem(k);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expectPromptOnly(page, en);
  await page.reload();
  await expectPromptOnly(page, en);
  expect(sent).toEqual([]);
});

/* The home page's "your members" block (components/HeroSavedZip.tsx) and the
   bill page's call panel (components/ActionPanel.tsx) hold the members too. */
test('two tabs: the home page in the other tab drops its members when this tab erases', async ({ context }) => {
  const other = await context.newPage();
  await other.goto('/record');
  await other.evaluate((zip) => localStorage.setItem('oravan.prefs', JSON.stringify({ zip })), ZIP);
  await other.goto('/');
  await expect(other.locator('[data-saved-zip]')).toHaveAttribute('data-saved-zip', ZIP);

  const here = await context.newPage();
  await here.goto('/record');
  await eraseMyData(here);
  await expect(other.locator('[data-saved-zip]')).toHaveCount(0);
  await expect(other.getByRole('textbox', { name: en.home.zipLabel }).first()).toBeVisible();
});

test("two tabs: a bill page's members lookup out in the other tab when this one erases is not shown", async ({ context }) => {
  const other = await context.newPage();
  await mockScriptApi(other); // a stance asks for a script: never a real one here
  await other.goto('/record');
  await other.evaluate((zip) => localStorage.setItem('oravan.prefs', JSON.stringify({ zip })), ZIP);
  const bill = `/bills/${referenceBill().slug}`;
  let held!: import('@playwright/test').Route;
  const caught = new Promise<void>((ok) => {
    void other.route('**/api/reps', (route) => {
      if (held) return route.continue();
      held = route;
      ok();
    });
  });
  await other.goto(bill);
  await caught;
  // The members show once a stance is picked: pick one while they load.
  await other.getByRole('radio', { name: en.bill.stance.support }).click();

  const here = await context.newPage();
  await here.goto('/record');
  await eraseMyData(here);
  const answered = other.waitForEvent('requestfinished', (r) => r.url().endsWith('/api/reps'));
  await held.continue();
  await answered;
  // The panel asks for a ZIP again, and no member's call button is there.
  await expect(other.getByRole('textbox', { name: en.home.zipLabel }).first()).toBeVisible();
  await expect(other.locator('[data-rep-name]')).toHaveCount(0);
});

/* The error screen: "Skip to content" and any in-page link stay in the page. */
test('the error screen: an in-page link and Back over it stay on this page, without a reload', async ({ page }) => {
  await crashRepsWithLookupAnswered(page, '', en);
  await page.evaluate(() => {
    (window as unknown as { __doc: number }).__doc = 1;
    document.querySelector('article[role=alert]')!.insertAdjacentHTML('beforeend', '<a id="in-page" href="#main">x</a>');
  });
  const sameDoc = () => page.evaluate(() => (window as unknown as { __doc?: number }).__doc === 1);
  const skip = page.getByRole('link', { name: en.common.skipToContent });
  await skip.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);
  await page.locator('#in-page').click();
  await page.goBack();
  await expect(page).toHaveURL(/\/reps$/);
  await expect(page.getByRole('heading', { level: 1, name: en.errorBoundary.title })).toBeVisible();
  expect(await sameDoc(), 'no reload').toBe(true);
  await expect(page.getByRole('heading', { level: 1, name: /couldn/ })).toHaveCount(0);
});

/* After the error screen's erase and reload: the erase's own confirmation is
   said and focused, once. */
for (const [prefix, m] of LOCALES) {
  for (const where of ['reps', 'record'] as const) {
    test(`${prefix || '/en'}/${where}: after the error screen's erase, the confirmation is said and focused, once`, async ({ page }) => {
      await seedZipOnce(page);
      await page.addInitScript(ARM, `(^|/)${where}/?$`);
      await page.goto(`${prefix}/${where}`);
      await page.getByRole('button', { name: m.errorBoundary.erase }).click();
      const fresh = page.waitForEvent('load');
      await page.getByRole('button', { name: m.impact.confirmErase }).click();
      await fresh;
      const notice = page.locator('[data-erased-notice]');
      await expect(notice).toHaveText(m.impact.erased);
      await expect(notice).toHaveAttribute('role', 'status');
      await expect(notice).toBeFocused();
      expect(await page.evaluate(() => Object.keys(window.history.state ?? {}))).not.toContain('oravanErased');
      // Said once: a reload does not say it again, and nothing else was kept.
      await page.reload();
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(notice).toHaveCount(0);
    });
  }
}

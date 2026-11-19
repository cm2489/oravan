import { expect, test, type Page, type Request } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

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

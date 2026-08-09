import { expect, test, type Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';

/*
 * THE CIVIC RECORD HAS TO SURVIVE ITS OWN STORAGE.
 *
 * localStorage is the only persistence this product has, and it is a shared
 * namespace on the visitor's own machine: an interrupted write, a quota
 * eviction mid-string, another tab of an older build, or a curious visitor
 * with the devtools open can all leave one unreadable row behind. Before the
 * fix these specs pin, `oravan.calls` was validated with `Array.isArray`
 * alone — so `[null]` was "valid", and ImpactPageClient's own
 * `calls.filter(c => c.outcome === 'contact')` threw on the first row and
 * took the whole page down. `oravan.reads` had the identical hole.
 *
 * Two claims are under test here, and only the second one is about crashing:
 *
 *  1. A corrupt row does not take the page down.
 *  2. A corrupt row does not take the OTHER ROWS down with it. Rejecting the
 *     whole array on one bad element would trade a crash for silent data
 *     loss — a reader's civic record wiped to protect them from a render
 *     error is not a fix. The store is filtered, never discarded.
 *
 * The escape-hatch spec at the bottom pins something the product had been
 * SAYING with nothing behind it — see its own comment.
 */

/* A row of each kind that this device can read, for the "the good rows
   survive" half. The slugs are corpus fixtures the sibling specs already
   pin (tests/flow.spec.ts); a corpus refresh that breaks one breaks both. */
const CALL = {
  billSlug: 'sjres-99-119',
  billLabel: 'S.J.Res. 99 · a readable call row',
  repBioguide: 'D000399',
  repName: 'Monica De La Cruz',
  stance: 'support',
  outcome: 'contact',
  at: '2026-07-01T12:00:00.000Z',
};
const CALL_2 = {
  ...CALL,
  billSlug: 'hr-6500-119',
  billLabel: 'H.R. 6500 · a second readable call row',
  at: '2026-07-02T12:00:00.000Z',
};
const READ = {
  billSlug: 'sjres-99-119',
  billLabel: 'S.J.Res. 99 · a readable read row',
  at: '2026-07-01T12:00:00.000Z',
};

/*
 * A HYDRATION PROBE, and why every assertion here needs one.
 *
 * /record is a client component whose stores read empty on the server, so
 * its own <h1> and its empty state are in the STATIC HTML — present long
 * before any localStorage row has been looked at. Asserting "the h1 is here
 * and the boundary is not" against that HTML passes on a page that is about
 * to crash, and it did: on the pre-fix tree three of these eight cases went
 * green purely by outrunning hydration. A followed topic renders ONLY from
 * the client store, so waiting for it is proof that the client render
 * completed rather than that the server's did.
 */
const HYDRATION_PROBE = { 'oravan.prefs': JSON.stringify({ interests: ['health'] }) };

/** Plant the stored strings BEFORE the app's first paint. `page.evaluate`
 *  after a `goto` would prove less: the page would already have rendered
 *  once from a healthy store, and the bug is a first-render bug. */
async function seed(page: Page, entries: Record<string, string>) {
  await page.addInitScript((e: Record<string, string>) => {
    for (const [k, v] of Object.entries(e)) localStorage.setItem(k, v);
  }, entries);
}

const read = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

for (const locale of ['en', 'es'] as const) {
  const m = locale === 'en' ? en : es;
  const RECORD = locale === 'es' ? '/es/record' : '/record';

  for (const key of ['oravan.calls', 'oravan.reads'] as const) {
    test(`${locale}: a corrupt row in ${key} does not brick the civic record`, async ({ page }) => {
      await seed(page, { ...HYDRATION_PROBE, [key]: '[null]' });
      await page.goto(RECORD);

      await expect(page.getByRole('heading', { name: m.impact.followTitle })).toBeVisible();
      // The page's own title, not the boundary's. Asserting the absence of
      // the boundary alone would pass on a blank document.
      await expect(page.getByRole('heading', { level: 1, name: m.impact.title })).toBeVisible();
      await expect(page.getByText(m.errorBoundary.title)).toHaveCount(0);
    });
  }

  test(`${locale}: every non-array shape in either store falls back instead of throwing`, async ({
    page,
  }) => {
    // All four are syntactically valid JSON that sailed through the old
    // `as T` cast: the module comment's own list, now pinned end to end.
    // (Each pass re-registers the seed; init scripts run in registration
    // order, so the newest write for a key is the one the page sees.)
    for (const raw of ['null', '5', '"x"', '{}']) {
      await seed(page, { ...HYDRATION_PROBE, 'oravan.calls': raw, 'oravan.reads': raw });
      await page.goto(RECORD);
      await expect(page.getByRole('heading', { name: m.impact.followTitle })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: m.impact.title })).toBeVisible();
      await expect(page.getByText(m.errorBoundary.title)).toHaveCount(0);
    }
  });
}

test('one unreadable row is dropped; the readable ones around it still render', async ({ page }) => {
  await seed(page, {
    'oravan.calls': JSON.stringify([CALL, null, CALL_2]),
    'oravan.reads': JSON.stringify([READ, { billSlug: 'x' }, null]),
  });
  await page.goto('/record');

  const history = page.locator('section[aria-labelledby="history"]');
  await expect(history.getByText(CALL.billLabel)).toBeVisible();
  await expect(history.getByText(CALL_2.billLabel)).toBeVisible();
  // Two rows in, two rows out — the null between them is simply not there.
  await expect(history.locator('li')).toHaveCount(2);

  const reads = page.locator('section[aria-labelledby="reads"]');
  await expect(reads.getByText(READ.billLabel)).toBeVisible();
  // The half-written row carried no label and no timestamp — it is gone,
  // and it did not take the row above it with it.
  await expect(reads.locator('li')).toHaveCount(1);
});

/*
 * THE REPAIR IS PERMANENT, not per-render. Every writer builds its next
 * value from the snapshot (`upsertCall`, `removeCall`, `upsertRead`,
 * `removeRead`), so the first write after a filtered read persists the
 * cleaned list — the bad row is gone from the device, not just from this
 * paint. Deleting one row is the cheapest writer to drive from the UI.
 */
test('the next write persists the filtered list, so the bad row is gone for good', async ({
  page,
}) => {
  await seed(page, { 'oravan.calls': JSON.stringify([CALL, null, CALL_2]) });
  await page.goto('/record');

  const history = page.locator('section[aria-labelledby="history"]');
  await history
    .locator('li')
    .filter({ hasText: CALL.billLabel })
    .getByRole('button', { name: en.impact.deleteRecord })
    .click();

  await expect(history.getByText(CALL.billLabel)).toHaveCount(0);
  expect(JSON.parse((await read(page, 'oravan.calls')) ?? 'null')).toEqual([CALL_2]);
});

/*
 * THE ESCAPE HATCH — the half of this that was a broken promise rather than
 * a crash.
 *
 * `errorBoundary.body` told the reader that erasing their saved data on the
 * civic record page could clear a persistent error. That advice is circular
 * exactly when it is needed: if the page that throws IS /record, the header
 * link goes straight back to the throw and `reset()` re-renders the same
 * tree. There was no exit. The boundary now carries the erase control
 * itself, and this spec is what stops the copy from drifting back into a
 * claim with nothing behind it.
 *
 * FORCING THE BOUNDARY WITHOUT RELYING ON A BUG. The trigger below is
 * deliberately not a corrupt row: this test has to keep working after every
 * storage shape lib/local.ts can survive is survivable. `subscribe()` is the
 * one line of the local-store path that runs outside a try/catch —
 * `window.addEventListener('storage', cb)`, called from
 * useSyncExternalStore's effect — and an effect throw lands in the same
 * boundary a render throw does. It is poisoned exactly ONCE: a trigger that
 * kept firing would make the retry fail for its own reason and prove
 * nothing about recovery.
 *
 * AND IT ASKS FIRST. The boundary's erase used to be a one-click wipe, which
 * is the worst place on the site for one: this boundary fires most often for
 * reasons that are not stored data at all (a chunk fetch that 404s after a
 * deploy), so the copy's own advice would talk a reader into destroying a
 * real civic record to fix something a reload fixes. It now runs the exact
 * two-step /record runs, reusing /record's own strings — the cases below
 * click through both steps, and the case after them pins that ONE click
 * still leaves the device untouched.
 *
 * IT IS ARMED FOR THE RECORD ROUTE, not for "whichever storage listener
 * registers next". Every surface that reads the local store subscribes
 * through this same line — the home hero's ZipForm does it at hydration — so
 * a trigger that fired on the first subscribe anywhere was really a race,
 * and the header-nav case below lost it whenever the crash was installed
 * before the home page finished hydrating. Measured on this tree
 * (2026-08-07): `page.goto('/')` resolves 20-40ms BEFORE ZipForm subscribes,
 * so the home page swallowed the one armed crash — and React recovers from a
 * hydration-time effect throw by re-rendering the tree, silently, with no
 * boundary rendered anywhere. /record then loaded in perfect health and the
 * spec failed on a missing boundary. That is the CI red on PR #164, and it
 * was never a CI-only fault: 2 of 10 runs failed locally at 4 workers, and
 * 20 of 20 failed run serially, where nothing slows the paste down.
 *
 * Reading `location.pathname` makes WHERE the crash lands a property of the
 * trigger instead of a property of the timing — 20 of 20 serial runs land it
 * on /record after the change. The two `goto` cases above are unaffected
 * (they are already on /record when the page hydrates), and the recipe below
 * is unchanged for a human, who still pastes this on any page and clicks
 * through.
 */
const CRASH_ONCE_ON_RECORD_SUBSCRIBE = () => {
  const add = window.addEventListener.bind(window);
  let armed = true;
  // /record and /es/record — the civic record in either locale, and nothing else.
  const onRecordPage = () => /(^|\/)record\/?$/.test(window.location.pathname);
  window.addEventListener = function (this: Window, type: string, ...rest: unknown[]) {
    if (type === 'storage' && armed && onRecordPage()) {
      armed = false;
      throw new Error('e2e: forced client crash');
    }
    return (add as unknown as (...a: unknown[]) => void)(type, ...rest);
  } as unknown as typeof window.addEventListener;
};

for (const locale of ['en', 'es'] as const) {
  const m = locale === 'en' ? en : es;
  const RECORD = locale === 'es' ? '/es/record' : '/record';

  test(`${locale}: the error boundary can erase this device's saved data, and recovers`, async ({
    page,
  }) => {
    await seed(page, {
      'oravan.calls': JSON.stringify([CALL]),
      'oravan.prefs': JSON.stringify({ zip: '78501', interests: ['health'] }),
    });
    await page.addInitScript(CRASH_ONCE_ON_RECORD_SUBSCRIBE);
    await page.goto(RECORD);

    // The dead end, reproduced: the broken page IS the page the old copy
    // sent the reader to.
    await expect(page.getByRole('heading', { level: 1, name: m.errorBoundary.title })).toBeVisible();

    // Two steps, the same two /record uses — and the second one is the record
    // page's own button, in this locale, which is what makes "reuse, don't
    // re-translate" a fact rather than a claim in the source comment.
    await page.getByRole('button', { name: m.errorBoundary.erase }).click();
    await expect(page.getByText(m.impact.eraseConfirm)).toBeVisible();
    await page.getByRole('button', { name: m.impact.confirmErase }).click();

    // Recovered onto the real page, with the device wiped — the promise the
    // copy makes, end to end.
    await expect(page.getByRole('heading', { level: 1, name: m.impact.title })).toBeVisible();
    expect(
      await page.evaluate(() =>
        ['oravan.reads', 'oravan.calls', 'oravan.prefs'].map((k) => localStorage.getItem(k))
      )
    ).toEqual([null, null, null]);
  });
}

/*
 * THE SAME DEAD END, ARRIVED AT THE WAY A READER ARRIVES AT IT: the crash
 * lands on a CLIENT-SIDE navigation out of the header, which is precisely the
 * route the old copy prescribed ("erase your saved data on the My record
 * page"). Worth its own case because it is also the recipe a human follows to
 * see this by hand — paste the crash into the console on any page, then click
 * the record link in the nav — and a hand-off recipe that has never been run
 * is a guess. The paste survives the page it is pasted on precisely because
 * the trigger is armed for /record (see its comment): on any other page it
 * hands every `storage` listener straight through, so a reader can arm it
 * wherever they happen to be standing.
 */
test('the escape hatch is there when the crash arrives via the header nav', async ({ page }) => {
  await seed(page, { 'oravan.prefs': JSON.stringify({ zip: '78501' }) });
  await page.goto('/');
  // The home page's hydration probe. The seeded ZIP reaches this field only
  // from the client store, so the field carrying it is proof the hero has
  // hydrated — which is what makes the next line "a console paste on a
  // settled page" rather than a claim about it. `goto` alone does NOT get
  // there: it resolves 20-40ms before this page's own subscribe, which is
  // what the sentence that used to sit on this line got wrong.
  await expect(page.getByLabel(en.home.zipLabel)).toHaveValue('78501');
  await page.evaluate(CRASH_ONCE_ON_RECORD_SUBSCRIBE);

  // Both navs are in the DOM and exactly one is ever displayed (Header.tsx's
  // "TWO NAVS, ONE AT A TIME"), so a role query resolves the visible one:
  // the row nav on desktop, the thumb bar on mobile.
  await page
    .getByRole('navigation', { name: en.common.nav.primaryLabel })
    .getByRole('link', {
      name: new RegExp(`^(${en.common.nav.impact}|${en.common.navShort.impact})$`),
    })
    .click();

  await expect(page.getByRole('heading', { level: 1, name: en.errorBoundary.title })).toBeVisible();
  await page.getByRole('button', { name: en.errorBoundary.erase }).click();
  await page.getByRole('button', { name: en.impact.confirmErase }).click();
  await expect(page.getByRole('heading', { level: 1, name: en.impact.title })).toBeVisible();
});

/*
 * THE PANIC BUTTON ASKS FIRST — the half of the escape hatch that is about
 * NOT losing data.
 *
 * A single click used to be the whole flow, and the boundary is exactly
 * where that is most expensive: it renders for any client throw, and the
 * commonest one on a static site has nothing to do with localStorage (a
 * chunk fetch that 404s against a build that just replaced this one). A
 * reader following the on-screen advice then wipes every call they have
 * logged, everything they have read, their ZIP and their topics — to fix a
 * problem that a reload fixes and an erase does not.
 *
 * Three claims, in the order they matter: one interaction destroys nothing;
 * the question that appears is the one /record asks, word for word, so the
 * reader is told the same thing about the same irreversible act wherever
 * they meet it; and backing out leaves the device whole and the escape hatch
 * still reachable.
 */
test('the boundary erase takes two interactions, and cancelling leaves the record intact', async ({
  page,
}) => {
  const stored = {
    'oravan.calls': JSON.stringify([CALL]),
    'oravan.prefs': JSON.stringify({ zip: '78501', interests: ['health'] }),
  };
  await seed(page, stored);
  await page.addInitScript(CRASH_ONCE_ON_RECORD_SUBSCRIBE);
  await page.goto('/record');
  await expect(page.getByRole('heading', { level: 1, name: en.errorBoundary.title })).toBeVisible();

  // INTERACTION ONE: the destructive-looking button. It must ask, not act.
  await page.getByRole('button', { name: en.errorBoundary.erase }).click();
  await expect(page.getByText(en.impact.eraseConfirm)).toBeVisible();
  expect(
    await page.evaluate(() =>
      ['oravan.calls', 'oravan.prefs'].map((k) => localStorage.getItem(k))
    ),
    'one click must not have touched the device'
  ).toEqual([stored['oravan.calls'], stored['oravan.prefs']]);
  // Still on the boundary, too: asking is not recovering.
  await expect(page.getByRole('heading', { level: 1, name: en.errorBoundary.title })).toBeVisible();

  // CANCEL: the way out of the way out. Nothing erased, hatch still open.
  await page.getByRole('button', { name: en.impact.cancel }).click();
  await expect(page.getByText(en.impact.eraseConfirm)).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      ['oravan.calls', 'oravan.prefs'].map((k) => localStorage.getItem(k))
    ),
    'cancelling must leave the record exactly as it was'
  ).toEqual([stored['oravan.calls'], stored['oravan.prefs']]);
  await expect(page.getByRole('button', { name: en.errorBoundary.erase })).toBeVisible();
});

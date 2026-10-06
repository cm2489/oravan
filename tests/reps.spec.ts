import { expect, test, type Page } from '@playwright/test';
import { districtsForZip, repsForDistrict } from '../lib/core';
import { seedZip } from './helpers';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import es from '../messages/es.json';
import specialElections from '../data/special-elections.json';

/*
 * Copy is read BY KEY (reps.*), formatted the way the page formats it; the
 * member names and the house.gov URL are record facts and stay literal.
 */
const t = createTranslator({ locale: 'en', messages: en, namespace: 'reps' });
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/*
 * A SAVED ZIP OPENS /reps ON YOUR MEMBERS (owner, UX question Q8 answered "a",
 * 2026-09-28: "The Reps tab opens on your members, with 'Change ZIP'. The ZIP
 * is kept only on the device and sent only to the stateless lookup").
 * components/SavedZipLookup.tsx reads the saved ZIP in the browser and
 * replaces bare /reps with /reps?zip=<ZIP>; "Change ZIP code" goes to
 * /reps?change=1, where the prompt stays put. The members printed are read
 * from the same data the page reads.
 */
const SAVED = '78501';
const SAVED_REPS = districtsForZip(SAVED).flatMap(repsForDistrict).map((l) => l.name);
const NEW_ZIP = '20002';
const readSavedZip = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('oravan.prefs') ?? '{}').zip ?? null);

test.describe('a saved ZIP opens /reps on your members (Q8 "a")', () => {
  for (const [prefix, m] of [
    ['', en],
    ['/es', es],
  ] as const) {
    const tr = createTranslator({ locale: prefix ? 'es' : 'en', messages: m, namespace: 'reps' });

    test(`${prefix || '/en'}: bare /reps applies the saved ZIP; Change ZIP asks again and saves the new one`, async ({
      page,
    }) => {
      expect(SAVED_REPS.length, `the fixture ZIP ${SAVED} must resolve to members in data/`).toBeGreaterThan(0);
      await page.goto(`${prefix}/privacy`);
      await seedZip(page, SAVED);

      await page.goto(`${prefix}/reps`);
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps\\?zip=${SAVED}$`));
      for (const name of SAVED_REPS) {
        await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
      }
      // The ZIP it came from is named, with the way to change it.
      const line = page.locator('[data-zip-line]');
      await expect(line).toContainText(tr('zipLine', { zip: SAVED }));
      await line.getByRole('link', { name: m.reps.changeZip, exact: true }).click();

      // Change ZIP: the prompt, pre-filled, and no bounce back to the saved ZIP.
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps\\?change=1$`));
      await expect(page.getByText(m.reps.noZip, { exact: true })).toBeVisible();
      const field = page.getByLabel(m.home.zipLabel);
      await expect(field).toHaveValue(SAVED);
      await field.fill(NEW_ZIP);
      await page.getByRole('button', { name: m.home.zipCta }).click();
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps\\?zip=${NEW_ZIP}$`));
      expect(await readSavedZip(page), 'the new ZIP is the saved one now').toBe(NEW_ZIP);

      // The next visit to bare /reps opens on the new ZIP.
      await page.goto(`${prefix}/reps`);
      await expect(page).toHaveURL(new RegExp(`${prefix}/reps\\?zip=${NEW_ZIP}$`));
    });
  }

  test('the lookup replaces bare /reps in history, so Back leaves the page', async ({ page }) => {
    await page.goto('/privacy');
    await seedZip(page, SAVED);
    await page.goto('/reps');
    await expect(page).toHaveURL(new RegExp(`/reps\\?zip=${SAVED}$`));
    await page.goBack();
    await expect(page).toHaveURL(/\/privacy$/);
  });

  test('no saved ZIP, or a saved value that is not a ZIP: bare /reps keeps its prompt', async ({
    page,
  }) => {
    await page.goto('/reps');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/reps$/);
    await expect(page.getByText(en.reps.noZip, { exact: true })).toBeVisible();

    await seedZip(page, 'abcde');
    await page.goto('/reps');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/\/reps$/);
    await expect(page.getByText(en.reps.noZip, { exact: true })).toBeVisible();
    await expect(page.locator('[data-saved-zip-lookup]')).toHaveCount(0);
  });
});

test('normal district shows one rep and two senators with local offices', async ({ page }) => {
  await page.goto('/reps?zip=78501');
  await expect(page.getByText('Monica De La Cruz')).toBeVisible();
  await expect(page.getByText('John Cornyn')).toBeVisible();
  await expect(page.getByText('Ted Cruz')).toBeVisible();
  await expect(
    page.getByText(new RegExp(`^${escapeRegExp(t('localOffices'))}`)).first()
  ).toBeVisible();
});

test('DC explains the delegate situation instead of promising senators', async ({ page }) => {
  await page.goto('/reps?zip=20002');
  await expect(page.getByText(t('delegateNote', { state: 'DC' }))).toBeVisible();
  await expect(page.getByText('Eleanor Holmes Norton')).toBeVisible();
  // The member's role label (components/RepCard.tsx) is the delegate key,
  // not "Representative": one card, labeled delegate, printing that key.
  const role = page.locator('[data-rep-role="delegate"]');
  await expect(role).toHaveCount(1);
  await expect(role).toContainText(t('delegate'));
});

test('unknown ZIP gets a recoverable error', async ({ page }) => {
  await page.goto('/reps?zip=00000');
  await expect(page.getByRole('alert').filter({ hasText: t('zipNotFound') })).toBeVisible();
});

/*
 * S24 groundwork (the project records §9.1(f)):
 * FL-20 is a real, currently-vacant House seat already baked into
 * data/legislators.json (Cherfilus-McCormick resigned Apr 21, 2026). ZIP
 * 33313 maps to FL-20 alone, so this is the sharpest regression fixture
 * available: the reps page must show an explicit vacant notice, never a stale
 * departed-member card, and never an election claim the record lacks. Since
 * 2026-09-28 the card prints the seat's special-election dates exactly as
 * data/special-elections.json records them from the FEC (none for FL-20 on
 * that day - the FEC and the House Clerk both list it "TBD"), with the day
 * they were checked.
 */
const FEC_DATES_PAGE = 'https://www.fec.gov/help-candidates-and-committees/dates-and-deadlines/';
const FL20 = (specialElections as Record<string, { checked: string; dates: { date: string; type: string }[] }>)['fl-20'];
const longDate = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`)
  );

test.describe('vacant seat (FL-20)', () => {
  for (const { prefix, locale, messages } of [
    { prefix: '', locale: 'en', messages: en },
    { prefix: '/es', locale: 'es', messages: es },
  ] as const) {
    test(`${locale}: explicit vacant notice, senators still shown, only the FEC's recorded election dates`, async ({
      page,
    }) => {
      await page.goto(`${prefix}/reps?zip=33313`);
      await expect(page.getByText(messages.reps.vacantSeat, { exact: true })).toBeVisible();
      await expect(page.getByText(messages.reps.vacantSeatBody)).toBeVisible();
      await expect(page.getByRole('link', { name: messages.reps.vacantSeatLink })).toHaveAttribute(
        'href',
        'https://www.house.gov/representatives/find-your-representative'
      );
      // Senators for the state are unaffected by a House vacancy.
      await expect(page.getByText('Rick Scott')).toBeVisible();
      await expect(page.getByText('Ashley Moody')).toBeVisible();
      // Never show the departed member.
      await expect(page.getByText('Cherfilus-McCormick')).toHaveCount(0);
      await expect(page.getByText(/election pending/i)).toHaveCount(0);

      // Election dates: exactly the recorded ones, or the recorded absence -
      // never a date the FEC row does not hold.
      const block = page.locator('[data-seat-elections]');
      if (!FL20) {
        await expect(block).toHaveCount(0);
        return;
      }
      await expect(block).toBeVisible();
      const tr = createTranslator({ locale, messages, namespace: 'reps' });
      const checked = longDate(locale, FL20.checked);
      await expect(block.locator('[data-seat-election-date]')).toHaveCount(FL20.dates.length);
      if (FL20.dates.length === 0) {
        await expect(block.locator('[data-seat-election-none]')).toHaveText(tr('seatElectionNone', { date: checked }));
      } else {
        for (const d of FL20.dates) {
          await expect(block.locator(`[data-seat-election-date="${d.date}"]`)).toHaveText(
            tr('seatElectionDate', { type: d.type, date: longDate(locale, d.date) })
          );
        }
        await expect(block.getByText(tr('seatElectionChecked', { date: checked }))).toBeVisible();
      }
      await expect(block.getByRole('link', { name: messages.reps.seatElectionLink })).toHaveAttribute(
        'href',
        FEC_DATES_PAGE
      );
      if (locale === 'es') {
        // No English leakage on the vacant-seat surface.
        await expect(page.getByText(en.reps.vacantSeat, { exact: true })).toHaveCount(0);
        await expect(page.getByText(en.reps.seatElectionLink, { exact: true })).toHaveCount(0);
      }
    });
  }

  test('/api/reps names the vacant seat explicitly (fact only, no since-date exposed)', async ({
    request,
  }) => {
    const res = await request.post('/api/reps', { data: { zip: '33313' } });
    const body = await res.json();
    expect(body.vacancies).toEqual([{ state: 'FL', district: 20 }]);
    const names = (body.reps as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['Rick Scott', 'Ashley Moody']));
  });

  test('/api/reps returns an empty vacancies array for a fully occupied district', async ({
    request,
  }) => {
    const res = await request.post('/api/reps', { data: { zip: '78501' } });
    const body = await res.json();
    expect(body.vacancies).toEqual([]);
  });
});

/*
 * Per-caller rate limit (fix/api-reps-rate-limit). /api/reps was the one
 * dynamic route with no limiter at all, and it is the only one the site
 * fires on PAGE RENDER rather than an explicit user action - so its ceiling
 * is the loosest here (300/10min, measured against a full instrumented suite
 * run; see app/api/reps/route.ts for the number's derivation).
 *
 * Every request below carries a distinct synthetic x-forwarded-for so this
 * block's own limiter traffic never interferes with itself across
 * Playwright's parallel workers/projects - and, more importantly, never
 * touches the 'unknown' counter every BROWSER test in this suite shares
 * (page fixtures send no x-forwarded-for). Mirrors nextIp in
 * tests/embed-brand-route.spec.ts and tests/embed-script-route.spec.ts, in a
 * third private range so the three files can never collide.
 */
const REPS_MAX = 300;

function nextIp(): string {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return `172.19.${octet()}.${octet()}`;
}

test.describe('per-caller rate limit', () => {
  test(`the ${REPS_MAX + 1}th request from one caller is 429, uniform body; a fresh caller is unaffected`, async ({
    request,
  }) => {
    const ip = nextIp();
    // Batched rather than 300 sequential round-trips: the handler is a pure
    // in-memory lookup and the window is a plain counter, so concurrency
    // changes nothing about the count - only how long this test takes.
    for (let sent = 0; sent < REPS_MAX; sent += 30) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(30, REPS_MAX - sent) }, () =>
          request.post('/api/reps', { data: { zip: '78501' }, headers: { 'x-forwarded-for': ip } })
        )
      );
      for (const res of batch) {
        expect(res.status(), `all ${REPS_MAX} requests inside the window must be served`).toBe(200);
      }
    }

    const overLimit = await request.post('/api/reps', {
      data: { zip: '78501' },
      headers: { 'x-forwarded-for': ip },
    });
    expect(overLimit.status()).toBe(429);
    expect(await overLimit.json()).toEqual({ error: 'rate_limited' });

    // A different caller is untouched by that caller's saturation - the
    // counter is per-caller-hash, not global.
    const fresh = await request.post('/api/reps', {
      data: { zip: '78501' },
      headers: { 'x-forwarded-for': nextIp() },
    });
    expect(fresh.status()).toBe(200);
    expect((await fresh.json()).reps.length).toBeGreaterThan(0);

    /*
     * PRIVACY PROBE (CLAUDE.md: no logs linking a network address to a
     * political position). The 429 is the moment the route knows both a
     * caller AND their ZIP, so it is the moment worth pinning: neither the
     * body nor ANY response header may carry the ZIP or anything
     * caller-derived. Also asserts the shape stays the bare uniform 429 -
     * no Retry-After, no retryAfterSec (that disclosure is /api/script's
     * deliberate citizen-path exception, not the house shape).
     */
    const raw = await overLimit.text();
    expect(raw).toBe('{"error":"rate_limited"}');
    expect(raw).not.toContain('78501');
    expect(raw).not.toContain(ip);
    const headers = overLimit.headers();
    expect(headers['retry-after']).toBeUndefined();
    for (const [name, value] of Object.entries(headers)) {
      expect(value, `header "${name}" must not echo the ZIP`).not.toContain('78501');
      expect(value, `header "${name}" must not echo the caller`).not.toContain(ip);
      expect(value, `header "${name}" must not echo a caller hash`).not.toMatch(/[0-9a-f]{64}/);
    }
  });

  test('a valid ZIP under the limit is answered normally, with the ZIP never echoed anywhere but the payload', async ({
    request,
  }) => {
    const res = await request.post('/api/reps', {
      data: { zip: '78501' },
      headers: { 'x-forwarded-for': nextIp() },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect((body.reps as Array<{ name: string }>).map((r) => r.name)).toEqual(
      expect.arrayContaining(['Monica De La Cruz', 'John Cornyn', 'Ted Cruz'])
    );
    for (const [name, value] of Object.entries(res.headers())) {
      expect(value, `header "${name}" must not echo the ZIP`).not.toContain('78501');
    }
  });

  test('a malformed ZIP is still judged on its merits, not rate-limited', async ({ request }) => {
    const res = await request.post('/api/reps', {
      data: { zip: 'abcde' },
      headers: { 'x-forwarded-for': nextIp() },
    });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_zip' });
  });

  test('X-Oravan-Key stays inert here: present or absent, the same response', async ({
    request,
  }) => {
    // The dormant tenancy hook (S18/S19) is recognized by this route as it is
    // by /api/district - and must not change a byte.
    const ip = nextIp();
    const without = await request.post('/api/reps', {
      data: { zip: '78501' },
      headers: { 'x-forwarded-for': ip },
    });
    const with_ = await request.post('/api/reps', {
      data: { zip: '78501' },
      headers: { 'x-forwarded-for': ip, 'x-oravan-key': 'rk_not_a_real_token' },
    });
    expect(with_.status()).toBe(without.status());
    expect(await with_.text()).toBe(await without.text());
  });
});

/*
 * The ZIP travels in the POST body, never in the request's address
 * (2026-10-06). The host's request logs keep the path with its query string,
 * so GET is refused outright rather than still answering a ZIP in the
 * address, and the refusal reads nothing from the request.
 */
test.describe('the ZIP stays out of the address', () => {
  test('GET is 405 with Allow: POST, and never echoes or answers a ZIP in the query', async ({ request }) => {
    const res = await request.get('/api/reps?zip=78501', { headers: { 'x-forwarded-for': nextIp() } });
    expect(res.status()).toBe(405);
    expect(res.headers()['allow']).toBe('POST');
    const raw = await res.text();
    expect(raw).toBe('{"error":"method_not_allowed"}');
    for (const [name, value] of Object.entries(res.headers())) {
      expect(value, `header "${name}" must not echo the ZIP`).not.toContain('78501');
    }
  });

  test('a POST without a JSON body is a plain 400, not a lookup', async ({ request }) => {
    const res = await request.post('/api/reps', {
      headers: { 'x-forwarded-for': nextIp(), 'content-type': 'text/plain' },
      data: 'zip=78501',
    });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request' });
  });
});

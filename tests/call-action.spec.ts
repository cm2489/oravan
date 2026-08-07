import { expect, test, type Page } from '@playwright/test';
import coverageData from '../data/coverage.json';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { mockScriptApi, seedZip } from './helpers';

/*
 * The "surface the call" behavior: a floating Make-the-call button keeps the
 * primary action reachable on a long bill page, but stands down whenever another
 * call CTA (the inline prompt or the action panel) is on screen — never two at
 * once. Data-driven: any real bill page carries the surfaces; use a covered bill
 * (guaranteed valid + long enough that the inline prompt sits below the fold).
 */
const slug = Object.keys(coverageData).find((k) => !k.startsWith('_'));

/**
 * THE ONE-SURFACE INVARIANT, sampled atomically.
 *
 * Both facts are read inside a SINGLE page.evaluate, inside expect.poll, so
 * the CTA's visibility and the button's state can never come from different
 * moments. The morning's version branched on a getBoundingClientRect taken
 * right after a scroll — on a cold WebKit page the scroll had not applied
 * yet, so it picked the wrong branch and then asserted the exact OPPOSITE of
 * correct behaviour. Playwright reported it flaky rather than wrong, which is
 * worse: a test that can assert either answer is not pinning anything
 * (pre-launch audit, 2026-07-25).
 *
 * The invariant itself: exactly one call surface is offered. When a CTA is on
 * screen the floating button stands down; when none is, it stands up. That is
 * `ctaOnScreen === fabInert`, and it holds at every scroll depth, on every
 * layout, for whatever bill the corpus serves up.
 */
async function oneSurfaceHolds(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const cta = document.querySelector('[data-call-cta]');
          const fab = document.querySelector('[data-floating-call]');
          if (!cta || !fab) return null;
          const r = cta.getBoundingClientRect();
          const onScreen = r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
          const inert =
            fab.getAttribute('aria-hidden') === 'true' &&
            getComputedStyle(fab).opacity === '0';
          return onScreen === inert;
        }),
      { message: 'exactly one call surface must be offered at this scroll depth' },
    )
    .toBe(true);
}

test('the floating call button surfaces the action and yields to on-screen CTAs', async ({ page }) => {
  test.skip(!slug, 'no bills in current data');

  // THE FLASH GUARD. The button's resting, server-rendered state must already
  // be the inert one. It used to be the shown one, so on every page where a
  // CTA is on screen at the top the button painted at full size and then faded
  // out over 300ms. A computed-style assertion cannot catch that — Playwright
  // retries until the value settles — so the resting markup is what gets
  // pinned, before any of the live behavior below.
  const resting = /<a[^>]*data-floating-call[^>]*>/.exec(
    await (await page.request.get(`/bills/${slug}`)).text()
  )?.[0];
  expect(resting).toBeTruthy();
  expect(resting).toContain('opacity-0');
  expect(resting).toContain('aria-hidden="true"');

  await page.goto(`/bills/${slug}`);

  const fab = page.locator('[data-floating-call]');
  const cta = page.locator('[data-call-cta]').first();
  await expect(fab).toHaveAttribute('href', '#act');

  // The layout the page is actually in, asked of the browser rather than
  // inferred from a project name — this is the same query Tailwind's
  // `min-[62rem]:` utilities compile to, evaluated against the real root font
  // size, so the branch can never disagree with the CSS it is describing.
  const onDesk = await page.evaluate(() => window.matchMedia('(min-width: 62rem)').matches);

  if (onDesk) {
    // THE DESK. The two-column bill page parks a sticky call rail beside the
    // reading column. Whether that rail's CTA is on screen AT THE TOP is
    // corpus-dependent, not layout-dependent: a floor_vote bill renders the
    // full-bleed deadline band above the grid, which at shorter desktop
    // viewports (webkit-desktop) pushes the rail below the fold. The night
    // hr-3937-119 (floor_vote) became coverage.json's first key, the old
    // hardcoded `toBeInViewport` went red on main itself — first caught on
    // 2026-07-25, by PR CI, because nightly-sync pushes use GITHUB_TOKEN and
    // therefore never trigger main's own CI on a fresh corpus.
    //
    // The PROPERTY this test exists to pin is the component's contract:
    // exactly one call surface at a time — the button stands down when a CTA
    // is on screen and stands up when none is. Assert THAT, from measured
    // visibility, for whichever bill the corpus serves up.
    await oneSurfaceHolds(page);

    // Past the foot of the grid the rail is USUALLY gone — but on a short
    // bill (thin decode, thin coverage) the sticky rail can still be
    // partially on screen at max scroll, and Linux webkit's text metrics
    // shift the boundary vs a Mac (the second half of the same corpus-shape
    // lesson as above: this went red in CI on hr-3937-119 while passing
    // locally on identical code). The invariant this component exists for is
    // that SOME call surface is on screen at every depth and never two —
    // assert the complementary pair from measured visibility, whichever side
    // of the boundary this bill and this engine land on.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await oneSurfaceHolds(page);
    return;
  }

  // SINGLE COLUMN. No rail; on a long page no other CTA is on screen at the
  // top — but measure rather than assume, for the same corpus-shape reason
  // as the desk branch: a short bill can put the panel inside the first
  // viewport, and then the button standing DOWN is the correct behavior.
  await oneSurfaceHolds(page);

  // Bring the action panel into view — the floating button fades out (inert).
  await cta.scrollIntoViewIfNeeded();
  await expect(fab).toHaveCSS('opacity', '0');
  await expect(fab).toHaveAttribute('aria-hidden', 'true');

  // Scroll back to a reading gap — it returns.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(fab).toHaveCSS('opacity', '1');
});

/*
 * S7 — the call-moment slice. The moment of actually dialing gets: a pre-dial
 * reassurance beat that never gates the tel: links, an honest client-clock
 * office-hours line (Eastern only — see lib/office-hours.ts), and a polished
 * clipboard copy with a screen-reader announcement. Zero Anthropic calls:
 * /api/script is mocked throughout.
 */
const BILL = '/bills/sjres-99-119'; // same stable slug flow.spec.ts / es-parity.spec.ts drive
const STANCES = ['support', 'oppose', 'undecided'] as const;

// Fixed clocks, pinned against their Eastern-time weekday/hour (see
// tests/office-hours.unit.spec.ts for the same constants and derivation).
const WEEKDAY_MORNING = new Date('2026-07-08T14:00:00Z').getTime(); // Wed 10:00 ET -> open
const WEEKEND_MIDDAY = new Date('2026-07-12T15:00:00Z').getTime(); // Sun 11:00 ET -> closed

async function openCallMode(page: Page, locale: 'en' | 'es', stance: (typeof STANCES)[number]) {
  const messages = locale === 'en' ? en : es;
  await page.getByRole('radio', { name: messages.bill.stance[stance] }).click();
  await expect(page.getByRole('textbox', { name: messages.bill.scriptTitle })).toBeVisible();
  await page.getByRole('button', { name: messages.bill.startCall }).click();
  return page.getByRole('dialog', { name: messages.bill.callTitle });
}

test.describe('S7 pre-dial beat: renders for a fresh caller across all three stance lanes', () => {
  for (const locale of ['en', 'es'] as const) {
    test(`${locale}: every stance opens call mode with the first-call beat, office hours, and tel: links`, async ({
      page,
    }) => {
      const messages = locale === 'en' ? en : es;
      await mockScriptApi(page);
      await page.goto(locale === 'es' ? '/es' + BILL : BILL);
      await seedZip(page, '78501');
      await page.reload();
      // Set the clock after the reload so it's guaranteed live for the
      // interactions below, regardless of whether it survives a navigation.
      await page.clock.setFixedTime(WEEKDAY_MORNING);

      for (const stance of STANCES) {
        const dialog = await openCallMode(page, locale, stance);
        await expect(dialog).toBeVisible();
        // Fresh profile (no calls logged yet): the first-call flavor of the
        // pre-dial beat shows, never the repeat-caller one, for every stance.
        // exact: the dialog's why-call link (2026-07 critique round 2) starts
        // with this same phrase in Spanish, so substring matching is ambiguous.
        await expect(dialog.getByText(messages.bill.firstCallTitle, { exact: true })).toBeVisible();
        // The honest, time-aware office-hours line sits beside it.
        await expect(dialog.getByText(messages.bill.officeHoursTitle)).toBeVisible();
        await expect(dialog.getByText(messages.bill.officeHoursOpenBody)).toBeVisible();
        // The pre-dial beat never gates the dial affordance underneath it.
        await expect(dialog.locator('a[href^="tel:"]').first()).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
      }
    });
  }
});

test('S7 pre-dial beat: a repeat caller sees the general beat, not the first-call one', async ({ page }) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await seedZip(page, '78501');
  await page.reload();
  await page.clock.setFixedTime(WEEKDAY_MORNING);

  // Log one outcome so callCount becomes 1.
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await page.getByRole('button', { name: en.bill.startCall }).click();
  let dialog = page.getByRole('dialog', { name: en.bill.callTitle });
  await expect(dialog.getByText(en.bill.firstCallTitle, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: en.bill.outcome.voicemail }).first().click();

  // A different stance, opened after that first logged call, gets the
  // general "before you dial" beat instead of the first-call framing.
  await page.getByRole('radio', { name: en.bill.stance.oppose }).click();
  await page.getByRole('button', { name: en.bill.startCall }).click();
  dialog = page.getByRole('dialog', { name: en.bill.callTitle });
  await expect(dialog.getByText(en.bill.preDialTitle)).toBeVisible();
  await expect(dialog.getByText(en.bill.preDialBody)).toBeVisible();
  await expect(dialog.getByText(en.bill.firstCallTitle, { exact: true })).toHaveCount(0);
});

test.describe('S7 office-hours note: honest, time-aware, Eastern-only', () => {
  test('inside typical business hours: the "likely to answer live" framing shows', async ({ page }) => {
    await mockScriptApi(page);
    await page.goto(BILL);
    await seedZip(page, '78501');
    await page.reload();
    await page.clock.setFixedTime(WEEKDAY_MORNING);
    await page.getByRole('radio', { name: en.bill.stance.support }).click();
    await expect(page.getByText(en.bill.officeHoursOpenBody)).toBeVisible();
    await expect(page.getByText(en.bill.officeHoursClosedBody)).toHaveCount(0);
  });

  test('outside business hours (weekend): the voicemail-as-the-plus framing shows, never an apology', async ({
    page,
  }) => {
    await mockScriptApi(page);
    await page.goto(BILL);
    await seedZip(page, '78501');
    await page.reload();
    await page.clock.setFixedTime(WEEKEND_MIDDAY);
    await page.getByRole('radio', { name: en.bill.stance.support }).click();
    await expect(page.getByText(en.bill.officeHoursClosedBody)).toBeVisible();
    await expect(page.getByText(en.bill.officeHoursOpenBody)).toHaveCount(0);
    // Never "sorry" / "unfortunately" language — voicemail is a plus, not a caveat.
    await expect(page.getByText(/sorry|unfortunately/i)).toHaveCount(0);
  });

  test('Spanish locale renders the same honest note, localized', async ({ page }) => {
    await mockScriptApi(page);
    await page.goto('/es' + BILL);
    await seedZip(page, '78501');
    await page.reload();
    await page.clock.setFixedTime(WEEKEND_MIDDAY);
    await page.getByRole('radio', { name: es.bill.stance.support }).click();
    await expect(page.getByText(es.bill.officeHoursTitle)).toBeVisible();
    await expect(page.getByText(es.bill.officeHoursClosedBody)).toBeVisible();
  });
});

test.describe('S7 clipboard copy: one tap, visible confirmation, aria-live announcement', () => {
  async function stubClipboard(page: Page) {
    await page.addInitScript(() => {
      const w = window as unknown as { __copied: string | null };
      w.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (t: string) => {
            w.__copied = t;
            return Promise.resolve();
          },
        },
      });
    });
  }

  test('copying the script from the panel shows confirmation and announces it', async ({ page }) => {
    await mockScriptApi(page);
    await stubClipboard(page);
    await page.goto(BILL);
    await seedZip(page, '78501');
    await page.reload();
    await page.getByRole('radio', { name: en.bill.stance.support }).click();

    await page.getByRole('button', { name: en.bill.copyScript, exact: true }).click();
    await expect(page.getByRole('button', { name: en.bill.scriptCopied })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: en.bill.scriptCopied })).toHaveCount(1);

    const copied = await page.evaluate(() => (window as unknown as { __copied: string | null }).__copied);
    expect(copied).toContain('MOCKED SCRIPT BODY');
  });

  test('the copy button inside call mode uses the same confirmation idiom', async ({ page }) => {
    await mockScriptApi(page);
    await stubClipboard(page);
    await page.goto(BILL);
    await seedZip(page, '78501');
    await page.reload();
    await page.getByRole('radio', { name: en.bill.stance.support }).click();
    await page.getByRole('button', { name: en.bill.startCall }).click();

    const dialog = page.getByRole('dialog', { name: en.bill.callTitle });
    await dialog.getByRole('button', { name: en.bill.copyScript, exact: true }).click();
    await expect(dialog.getByRole('button', { name: en.bill.scriptCopied })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: en.bill.scriptCopied })).toHaveCount(1);

    const copied = await page.evaluate(() => (window as unknown as { __copied: string | null }).__copied);
    expect(copied).toContain('MOCKED SCRIPT BODY');
  });

  test('spanish confirmation and announcement are localized', async ({ page }) => {
    await mockScriptApi(page);
    await stubClipboard(page);
    await page.goto('/es' + BILL);
    await seedZip(page, '78501');
    await page.reload();
    await page.getByRole('radio', { name: es.bill.stance.support }).click();
    await page.getByRole('button', { name: es.bill.copyScript, exact: true }).click();
    await expect(page.getByRole('button', { name: es.bill.scriptCopied })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: es.bill.scriptCopied })).toHaveCount(1);
  });
});

test('S7: call mode survives a visibilitychange/blur-return with its content intact', async ({ page }) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await seedZip(page, '78501');
  await page.reload();
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await page.getByRole('button', { name: en.bill.startCall }).click();

  const dialog = page.getByRole('dialog', { name: en.bill.callTitle });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/MOCKED SCRIPT BODY/)).toBeVisible();

  // Simulate the app-switch to the Phone app and back: the tab is hidden,
  // then visible again, with no navigation and no explicit re-render trigger.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });

  // Nothing reset: same dialog, same script, dial links still present.
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/MOCKED SCRIPT BODY/)).toBeVisible();
  await expect(dialog.locator('a[href^="tel:"]').first()).toBeVisible();
});

/*
 * Rate-limit degradation (2026-08, campaign #2 critical): a 429 from
 * /api/script must degrade ONLY the script slot. The representative phone
 * numbers and their tel: links never leave the DOM — a static fallback
 * template (honestly labeled as not-AI-drafted) fills the slot so every
 * script-gated surface stays mounted, and the retry guidance reflects
 * exactly what the API disclosed (a countdown when retryAfterSec came back,
 * an honest static hint when it didn't).
 */
test.describe('rate-limit degradation: phones never leave, script slot degrades', () => {
  /** The rateRetryIn line with its {time} slot as a m:ss pattern. */
  function retryInPattern(msg: string) {
    const esc = msg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(esc.replace('\\{time\\}', '\\d+:\\d{2}'));
  }

  function mock429(page: Page, body: Record<string, unknown>) {
    return page.route('**/api/script', (route) =>
      route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify(body) })
    );
  }

  for (const locale of ['en', 'es'] as const) {
    test(`${locale}: 429 with retryAfterSec — fallback fills the slot, tel: links stay, countdown then retry`, async ({
      page,
    }) => {
      const messages = locale === 'en' ? en : es;
      await page.clock.install();
      await mock429(page, { error: 'rate_limited', retryAfterSec: 120 });
      await page.goto(locale === 'es' ? '/es' + BILL : BILL);
      await seedZip(page, '78501');
      await page.reload();

      await page.getByRole('radio', { name: messages.bill.stance.support }).click();

      // The honest fallback template fills the script slot, labeled as
      // not-AI — the AI disclaimer never rides non-AI text.
      const fallback = page.getByRole('textbox', { name: messages.bill.fallbackTitle });
      await expect(fallback).toBeVisible();
      await expect(fallback).toBeEditable();
      await expect(page.getByText(messages.bill.scriptDisclaimer)).toHaveCount(0);
      await expect(page.getByText(messages.bill.fallbackDisclaimer)).toBeVisible();

      // The alert itself stays static; the countdown ticks OUTSIDE any live
      // region (a 1-s ticker inside role=alert would re-announce every
      // second).
      await expect(page.getByText(messages.bill.rateLimited)).toBeVisible();
      const countdown = page.getByText(retryInPattern(messages.bill.rateRetryIn));
      await expect(countdown).toBeVisible();
      // The works-right-now pointer must survive ALONGSIDE the countdown
      // (2026-08-04 walkthrough P1: it used to exist only in the
      // no-countdown hint, so a disclosed reset read as "dead for 8:01").
      await expect(page.getByText(messages.bill.rateTemplateNow)).toBeVisible();
      await expect(
        page.getByRole('alert').filter({ hasText: retryInPattern(messages.bill.rateRetryIn) })
      ).toHaveCount(0);

      // The call apparatus never left: the foot's start-call button is up,
      // and call mode still holds the dial links.
      await page.getByRole('button', { name: messages.bill.startCall }).click();
      const dialog = page.getByRole('dialog', { name: messages.bill.callTitle });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('a[href^="tel:"]').first()).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();

      // When the disclosed window elapses, the countdown yields to a real
      // retry affordance.
      await page.clock.fastForward(120_000);
      await expect(page.getByRole('button', { name: messages.bill.retry })).toBeVisible();
    });
  }

  test('429 with a bare body (no retryAfterSec): honest static hint, no invented countdown', async ({
    page,
  }) => {
    await mock429(page, { error: 'rate_limited' });
    await page.goto(BILL);
    await seedZip(page, '78501');
    await page.reload();

    await page.getByRole('radio', { name: en.bill.stance.support }).click();
    await expect(page.getByRole('textbox', { name: en.bill.fallbackTitle })).toBeVisible();
    await expect(page.getByText(en.bill.rateRetryHint)).toBeVisible();
    await expect(page.getByText(retryInPattern(en.bill.rateRetryIn))).toHaveCount(0);
  });

  test('phones-never-leave regression: a 429 on the SECOND stance keeps the tel: links of the first', async ({
    page,
  }) => {
    let calls = 0;
    await page.route('**/api/script', (route) => {
      calls += 1;
      if (calls === 1) {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ script: 'FIRST AI DRAFT. MOCKED SCRIPT BODY.', cached: false }),
        });
      }
      return route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'rate_limited' }),
      });
    });
    await page.goto(BILL);
    await seedZip(page, '78501');
    await page.reload();

    // First stance: a real AI draft, reps + tel: links render.
    await page.getByRole('radio', { name: en.bill.stance.support }).click();
    await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toHaveValue(
      /FIRST AI DRAFT/
    );
    await expect(page.locator('a[href^="tel:"]').first()).toBeVisible();

    // Second stance trips the limiter: the script slot degrades to the
    // fallback — and the phone numbers are still in the DOM.
    await page.getByRole('radio', { name: en.bill.stance.oppose }).click();
    await expect(page.getByRole('textbox', { name: en.bill.fallbackTitle })).toBeVisible();
    await expect(page.locator('a[href^="tel:"]').first()).toBeVisible();
  });
});

/*
 * SENATE-DEFAULT ROUTING KEEPS THE HOUSE MEMBER (owner rulings 2026-08-04
 * "demote, never bury" and 2026-08-06 "the focus should be on the senator as
 * a default").
 *
 * ⚠️ READ THIS BEFORE TRUSTING THE NAME. This drives a BILL — S.J.Res. 99,
 * whose own last action carries a Congressional Record S-page, so
 * liveCallTarget returns `{chamber:'senate', afterVote:false, soleChamber:false}`.
 * It is NOT nomination-backed, and the reason CHANGED under this comment
 * (amended 2026-08-06): it used to read that nothing in the app rendered a
 * nomination — no caller for `liveCallTargetForNomination`, no /nominations
 * route, ActionPanel mounted from exactly one page. All three stopped being
 * true when app/[locale]/nominations/[slug]/page.tsx landed, which calls that
 * predicate, is that route, and mounts that panel. A nomination-backed E2E
 * is therefore no longer impossible, and one exists: tests/nominations.spec.ts
 * drives the real page, the House member's own script slot included. This one
 * stays bill-backed on purpose, for the reason in the next paragraph.
 *
 * What it therefore pins is the part that IS shared, byte for byte:
 * `soleChamber` never reaches ActionPanel's `rank()`, so a nomination sorts
 * through the identical `liveChamber === 'senate'` path this bill takes. If
 * the House member ever loses his row, his dial, or his position behind the
 * senators here, he loses it on a nomination too — and on a nomination he is
 * the one office with no vote at all, which is exactly when burying him would
 * be easiest to justify and worst to do.
 *
 * The nomination-only copy is pinned twice: at unit level in
 * tests/journey.unit.spec.ts (suite 7: liveCallKey picks
 * `liveSenateNomination`, never one of the four relational keys, and picks
 * nothing at all for a reader with no senator), and in the DOM in
 * tests/nominations.spec.ts, which now that the page exists asserts the rail
 * never calls a nomination a bill, in both languages.
 */
test('Senate routing demotes the House member without burying him — rail and call mode', async ({
  page,
}) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await seedZip(page, '78501'); // TX-15: two senators + one House member
  await page.reload();
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();

  // The routing sentence names the Senate as the live call.
  await expect(page.getByText(en.bill.liveSenateFloor)).toBeVisible();

  // THE RAIL. Three rows, in that order, and the House member is the third —
  // present, not filtered.
  const railNames = page.locator('section[aria-labelledby="act"] ul > li > p.font-bold');
  await expect(railNames).toHaveCount(3);
  await expect(railNames.nth(0)).toHaveText('John Cornyn');
  await expect(railNames.nth(1)).toHaveText('Ted Cruz');
  await expect(railNames.nth(2)).toHaveText('Monica De La Cruz');

  // Demoted, never buried: the House row still carries a real, dialable
  // number, not a name with the phone taken away.
  const houseRow = page
    .locator('section[aria-labelledby="act"] ul > li')
    .filter({ hasText: 'Monica De La Cruz' });
  await expect(houseRow.locator('a[href^="tel:"]').first()).toHaveAttribute(
    'href',
    /^tel:\+1\d{10}$/
  );
  // …and the outcome buttons, so a call to that office is still loggable.
  await expect(houseRow.getByRole('button', { name: en.bill.outcome.voicemail })).toBeVisible();

  // THE CALL MODE — the dial moment itself, where an ordering regression
  // would do the most damage. Same order, same three dials.
  await page.getByRole('button', { name: en.bill.startCall }).click();
  const dialog = page.getByRole('dialog', { name: en.bill.callTitle });
  await expect(dialog.getByText(en.bill.liveSenateFloor)).toBeVisible();
  const dials = dialog.locator('a[href^="tel:"]');
  await expect(dials).toHaveCount(3);
  await expect(dials.nth(0)).toContainText('John Cornyn');
  await expect(dials.nth(1)).toContainText('Ted Cruz');
  await expect(dials.nth(2)).toContainText('Monica De La Cruz');
});

/*
 * The nomination annex is DARK until a surface serves one: no page passes a
 * soleChamber target today, so none of the three nomination strings may
 * appear anywhere on a bill page. This is the tripwire on that — if a future
 * change starts routing bills through the nomination branch, a reader would
 * be told "the House has no vote on this" about a bill the House votes on,
 * which is the single worst sentence this step could ship.
 */
test('no bill page ever shows the nomination copy', async ({ page }) => {
  await mockScriptApi(page);
  await page.goto(BILL);
  await seedZip(page, '78501');
  await page.reload();
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();

  for (const copy of [
    en.bill.liveSenateNomination,
    en.bill.nominationHow,
    en.bill.nominationHousePress,
  ]) {
    await expect(page.getByText(copy)).toHaveCount(0);
  }
});

/*
 * A READER WITH NO SENATOR IS NEVER TOLD THEIR SENATORS ARE THE CALL.
 *
 * N3 added `hasSenator` to liveCallKey and gated the NOMINATION key on it. The
 * four pre-existing BILL keys were left ungated, and they had the same defect
 * and had shipped with it: a reader in DC on this bill page was told "your
 * senators are the live call" when they have none — 57 DC ZIPs alone, plus PR,
 * VI, GU, AS and MP. Fixed in the same file and the same commit as the
 * nomination work, because a second commit would have been a guaranteed
 * conflict in one component.
 *
 * WHY THE TWO HOUSE KEYS ARE GATED ON THE SAME BOOLEAN, which reads odd until
 * you check the data: the six jurisdictions with no senator are exactly the six
 * that send a non-voting delegate or resident commissioner (verified against
 * data/legislators.json on 2026-08-06 — no state has fewer than two senators,
 * so `hasSenator === false` is a delegate jurisdiction and nothing else). "Your
 * House member is the live call" names an office with no vote on passage there,
 * so all four relational sentences are false for the same reader for the same
 * underlying reason. The exhaustive proof is at unit level
 * (tests/journey.unit.spec.ts, liveCallKey); this drives the one that actually
 * reaches a reader today.
 *
 * NOTHING IS TAKEN AWAY. The delegate keeps the row, the dial and the outcome
 * buttons, and `callWhoOne` — "Your delegate is your voice in the House" — is
 * the honest sentence that stays. The bill's stage is still on the page in the
 * journey stepper, which is server-rendered and knows nothing about the ZIP.
 */
test('a reader with no senator sees no routing sentence claiming senators are theirs', async ({
  page,
}) => {
  await mockScriptApi(page);
  await page.goto(BILL); // liveCallTarget: {chamber:'senate', afterVote:false}
  await seedZip(page, '20001'); // DC-0: one delegate, no senator at all
  await page.reload();
  await page.getByRole('radio', { name: en.bill.stance.support }).click();
  await expect(page.getByRole('textbox', { name: en.bill.scriptTitle })).toBeVisible();

  // The office they do have is right there, dialable.
  const railNames = page.locator('section[aria-labelledby="act"] ul > li > p.font-bold');
  await expect(railNames).toHaveCount(1);
  await expect(railNames.nth(0)).toHaveText('Eleanor Holmes Norton');
  await expect(page.locator('section[aria-labelledby="act"] a[href^="tel:"]').first()).toBeVisible();
  // …and the honest who-to-call sentence for a delegate jurisdiction.
  await expect(page.getByText(en.bill.callWhoOne)).toBeVisible();

  // None of the five routing sentences may appear — the four relational bill
  // ones and the nomination one.
  for (const key of [
    'liveSenateFloor',
    'liveHouseFloor',
    'liveSenateAfterHouse',
    'liveHouseAfterSenate',
    'liveSenateNomination',
  ] as const) {
    await expect(page.getByText(en.bill[key])).toHaveCount(0);
  }

  // Including at the dial moment, where the same line is repeated.
  await page.getByRole('button', { name: en.bill.startCall }).click();
  const dialog = page.getByRole('dialog', { name: en.bill.callTitle });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(en.bill.liveSenateFloor)).toHaveCount(0);
});

/*
 * 2026-07 critique, top consensus P0: with no saved ZIP the call mode used to
 * be a dead end — the script and reassurance rendered, but zero phone
 * numbers, no ZIP form, and no explanation. The fix lives IN the mode: a ZIP
 * mini-form inside the dialog, plus the Capitol switchboard as the universal
 * fallback that needs no ZIP at all.
 */
test('call mode without a saved ZIP is never a dead end: in-dialog ZIP form + switchboard', async ({
  page,
}) => {
  await mockScriptApi(page);
  await page.goto(BILL); // deliberately NO seedZip
  const dialog = await openCallMode(page, 'en', 'support');
  await expect(dialog).toBeVisible();

  // The universal fallback: the Capitol switchboard, dialable with no ZIP.
  await expect(dialog.getByText(en.bill.switchboardNote)).toBeVisible();
  await expect(dialog.locator('a[href="tel:+12022243121"]')).toBeVisible();

  // And the way to fix it without leaving the mode: the ZIP form, in-dialog.
  await expect(dialog.getByText(en.bill.needZip)).toBeVisible();
  await expect(dialog.getByLabel(en.home.zipLabel)).toBeVisible();
});

import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { getLiveMoments, getMoments, type MomentWithState } from '../lib/moments';

/*
 * e2e coverage for the Moments UI (app/[locale]/moments/*, the homepage
 * strip). Corpus-robust throughout, the same discipline as tests/corpus.ts:
 * expectations are derived from data/moments.json + lib/moments.ts's own
 * lifecycle computation, never a hardcoded id or count, so a future moment
 * (or one that settles) doesn't rot this suite. review_by on every entry
 * committed so far sits weeks out from "now," so — unlike the urgency-band
 * knife-edges tests/corpus.ts guards against — there's no realistic
 * clock-skew flip between build time and assertion time here; each state
 * check calls getMoments()/getLiveMoments() fresh, same as the pages do.
 */

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LOCALES = [
  { locale: 'en' as const, prefix: '', messages: en, pick: (l: { en: string; es: string }) => l.en },
  { locale: 'es' as const, prefix: '/es', messages: es, pick: (l: { en: string; es: string }) => l.es },
];

test.describe('/moments index', () => {
  for (const { locale, prefix, messages, pick } of LOCALES) {
    test(`${locale}: renders live Moments, the settled section (if any), and the scarcity note`, async ({
      page,
    }) => {
      const all = getMoments();
      const live = all.filter((m) => m.state === 'live' || m.state === 'stale');
      const settled = all.filter((m) => m.state === 'settled');
      const liveCount = all.filter((m) => m.state === 'live').length;

      await page.goto(`${prefix}/moments`);
      await expect(page.getByRole('heading', { level: 1, name: messages.moments.indexTitle })).toBeVisible();

      if (live.length > 0) {
        for (const m of live) {
          await expect(
            page.getByRole('link', { name: new RegExp(escapeRegex(pick(m.name))) })
          ).toBeVisible();
        }
      } else {
        await expect(page.getByText(messages.moments.emptyTitle)).toBeVisible();
      }

      const settledHeading = page.getByRole('heading', { level: 2, name: messages.moments.settledHeading });
      if (settled.length > 0) {
        await expect(settledHeading).toBeVisible();
        for (const m of settled) {
          await expect(
            page.getByRole('link', { name: new RegExp(escapeRegex(pick(m.name))) })
          ).toBeVisible();
        }
      } else {
        await expect(settledHeading).toHaveCount(0);
      }

      // The max-6 scarcity note states today's actual live count.
      await expect(page.getByText(String(liveCount), { exact: false }).first()).toBeVisible();
    });
  }

  test('a live Moment card links through to its own page', async ({ page }) => {
    const live = getMoments().filter((m) => m.state === 'live' || m.state === 'stale');
    test.skip(live.length === 0, 'no live moment in the corpus right now');
    const m = live[0];
    await page.goto('/moments');
    await page.getByRole('link', { name: new RegExp(escapeRegex(m.name.en)) }).click();
    await expect(page).toHaveURL(new RegExp(`/moments/${m.id}$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText(m.name.en);
  });
});

test.describe('/moments/[id] detail page', () => {
  const moments: MomentWithState[] = getMoments();

  for (const m of moments) {
    test(`${m.id}: AI chip, evidence, and every vehicle link resolves to its real bill page`, async ({
      page,
    }) => {
      await page.goto(`/moments/${m.id}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(m.name.en);

      // AI labeling — the existing bill.aiChip idiom, reused verbatim.
      await expect(page.getByText(en.bill.aiChip, { exact: true })).toBeVisible();
      await expect(page.getByText(en.bill.aiDisclaimer)).toBeVisible();

      // Evidence: the qualifying-signal type and every clickable ref.
      await expect(page.getByRole('heading', { name: en.moments.whyHeading })).toBeVisible();
      const signalTypeText =
        en.moments.signalType[m.qualifying_signal.type as keyof typeof en.moments.signalType];
      await expect(page.getByText(signalTypeText, { exact: true })).toBeVisible();
      for (let i = 0; i < m.qualifying_signal.refs.length; i++) {
        const link = page.getByRole('link', { name: en.moments.evidenceLink.replace('{index}', String(i + 1)) });
        await expect(link).toHaveAttribute('href', m.qualifying_signal.refs[i]);
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', /noopener/);
      }

      // No lean labels anywhere on a Moment page (spec §3.3) — coverage/lean
      // chrome (messages.coverage.lean.*, "AllSides") stays on the bill page only.
      expect(await page.getByText(/Leans left|Leans right|AllSides/i).count()).toBe(0);

      // Every vehicle both names its bill and resolves — click through and
      // confirm the real bill page renders (not a 404, not a stub).
      for (const v of m.vehicles) {
        const billLink = page.locator(`a[href="/bills/${v.slug}"]`).first();
        await expect(billLink).toBeVisible();
        await billLink.click();
        await expect(page).toHaveURL(new RegExp(`/bills/${v.slug}$`));
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await page.goBack();
      }
    });
  }

  test('settled vs. live framing differs on the page (corpus-robust: skips if no settled moment exists)', async ({
    page,
  }) => {
    const settled = getMoments().find((m) => m.state === 'settled');
    test.skip(!settled, 'no settled moment in the corpus right now');
    await page.goto(`/moments/${settled!.id}`);
    await expect(page.getByText(en.moments.settledBadge, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(en.moments.decidingSettled)).toBeVisible();
  });
});

test.describe('ES locale renders ES content end to end', () => {
  test('/es/moments and /es/moments/[id] render Spanish chrome and Spanish moment text', async ({ page }) => {
    await page.goto('/es/moments');
    await expect(page.getByRole('heading', { level: 1, name: es.moments.indexTitle })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: en.moments.indexTitle })).toHaveCount(0);

    const m = getMoments()[0];
    test.skip(!m, 'no moments in the corpus');
    await page.goto(`/es/moments/${m.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(m.name.es);
    await expect(page.getByText(es.bill.aiChip, { exact: true })).toBeVisible();
    // No English chrome leaks onto the ES page.
    await expect(page.getByText(en.bill.aiChip, { exact: true })).toHaveCount(0);
    await expect(page.getByText(en.moments.whyHeading, { exact: true })).toHaveCount(0);
  });
});

test.describe('homepage Moments strip', () => {
  for (const { locale, prefix, messages } of LOCALES) {
    test(`${locale}: strip appears iff a live Moment exists, sits after "Worth a call," never before`, async ({
      page,
    }) => {
      const liveMoments = getLiveMoments();
      await page.goto(`${prefix}/`);

      const topActions = page.locator('section[aria-labelledby="top-actions"]');
      const strip = page.locator('section[aria-labelledby="moments-strip-title"]');

      if (liveMoments.length > 0) {
        await expect(strip).toBeVisible();
        await expect(strip.getByRole('heading', { name: messages.home.momentsTitle })).toBeVisible();
        // DOM order: the strip must not precede the "Worth a call" band.
        const order = await page.evaluate(() => {
          const a = document.querySelector('section[aria-labelledby="top-actions"]');
          const b = document.querySelector('section[aria-labelledby="moments-strip-title"]');
          if (!a || !b) return null;
          return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 'after' : 'before';
        });
        expect(order).toBe('after');
        await expect(topActions).toBeVisible();

        const first = liveMoments[0];
        const name = locale === 'es' ? first.name.es : first.name.en;
        await strip.getByRole('link', { name: new RegExp(escapeRegex(name)) }).click();
        await expect(page).toHaveURL(new RegExp(`${prefix || ''}/moments/${first.id}$`));
      } else {
        await expect(strip).toHaveCount(0);
      }
    });
  }
});

test.describe('accessibility basics', () => {
  test('vehicle CTA meets the 44px touch target and is keyboard-focusable', async ({ page }) => {
    const m = getMoments()[0];
    test.skip(!m, 'no moments in the corpus');
    await page.goto(`/moments/${m.id}`);
    const cta = page.getByRole('link', { name: en.moments.readCall }).first();
    await expect(cta).toBeVisible();
    const box = await cta.boundingBox();
    expect(box?.height, 'vehicle CTA must meet the 44px touch target').toBeGreaterThanOrEqual(44);
    await cta.focus();
    await expect(cta).toBeFocused();
  });

  test('a moment index card is keyboard-focusable', async ({ page }) => {
    const m = getMoments()[0];
    test.skip(!m, 'no moments in the corpus');
    await page.goto('/moments');
    const card = page.getByRole('link', { name: new RegExp(escapeRegex(m.name.en)) });
    await card.focus();
    await expect(card).toBeFocused();
  });
});

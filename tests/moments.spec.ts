import { expect, test } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { getLiveMoments, getMoments, type MomentWithState } from '../lib/moments';
import { momentDek } from '../lib/moments-ui';
import { getBill, getTeasers } from '../lib/core';
import { waitForFeedHydrated } from './helpers';

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
      // .first(): the v2 live layer puts the SAME standing disclaimer under
      // the "Where it stands" state summary too, so on a moment carrying a
      // revision this string legitimately appears twice. One site-wide AI
      // caveat, repeated under each AI passage, is the intended posture —
      // tests/moment-updates-page.spec.ts asserts the second occurrence.
      await expect(page.getByText(en.bill.aiDisclaimer).first()).toBeVisible();

      // The vehicles grid leads with AI-decoded headlines and its CTA is the
      // phone call — the one place unlabeled AI text sat directly on the
      // control that drives a call (pre-launch audit, constitution-05). It
      // now carries the same label /bills prints over the same sentences,
      // and it is DATA-GATED: a grid whose decodes are all still pending
      // renders official titles, which are not AI text, and claims nothing.
      const decoded = m.vehicles.some((v) => Boolean(getBill(v.slug)?.ai_headline));
      await expect(
        page.locator('section[aria-labelledby="vehicles-h"]').getByText(en.bills.aiNote, { exact: true })
      ).toHaveCount(decoded ? 1 : 0);

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
      //
      // And the round trip: the bill page must say which bigger question it
      // is a vehicle of (spec §7.2). Only live and stale moments backlink
      // (lib/moments.ts), so a settled or retired moment naturally takes the
      // goBack() path instead — the same corpus-robust idiom the rest of
      // this file uses, no hardcoded expectation about today's data.
      const backlinks = m.state === 'live' || m.state === 'stale';
      for (const v of m.vehicles) {
        const billLink = page.locator(`a[href="/bills/${v.slug}"]`).first();
        await expect(billLink).toBeVisible();
        await billLink.click();
        await expect(page).toHaveURL(new RegExp(`/bills/${v.slug}$`));
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

        if (backlinks) {
          const backlink = page.getByRole('link', {
            name: new RegExp(escapeRegex(en.moments.partOf.replace('{name}', m.name.en))),
          });
          await expect(backlink).toBeVisible();
          const box = await backlink.boundingBox();
          expect(box?.height, 'the backlink must meet the 44px touch target').toBeGreaterThanOrEqual(44);
          // The backlink IS the return trip: clicking it must land on this
          // moment's page, which is where the next vehicle is read from.
          await backlink.click();
          await expect(page).toHaveURL(new RegExp(`/moments/${m.id}$`));
        } else {
          await page.goBack();
        }
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

test.describe('homepage Big Questions band', () => {
  for (const { locale, prefix, messages } of LOCALES) {
    test(`${locale}: band appears iff a live entry exists, sits BEFORE the week, never after`, async ({
      page,
    }) => {
      const liveMoments = getLiveMoments();
      await page.goto(`${prefix}/`);

      const topActions = page.locator('section[aria-labelledby="top-actions"]');
      const strip = page.locator('section[aria-labelledby="moments-strip-title"]');

      if (liveMoments.length > 0) {
        await expect(strip).toBeVisible();
        await expect(strip.getByRole('heading', { name: messages.home.momentsTitle })).toBeVisible();
        // DOM order: the band leads the truth half. The 2026-07-24 ruling put
        // discovery UNDER the week; the truth-first flip (owner decisions of
        // record, 2026-07-31, spec §7.1) reversed it, and this expected value
        // flipped 'after' -> 'before' in that same commit.
        const order = await page.evaluate(() => {
          const a = document.querySelector('section[aria-labelledby="top-actions"]');
          const b = document.querySelector('section[aria-labelledby="moments-strip-title"]');
          if (!a || !b) return null;
          return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 'after' : 'before';
        });
        expect(order).toBe('before');
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

/*
 * test-honesty-010 — the always-visible route into the feature had no test at
 * all. Nothing asserted the header carried this entry, in either nav or either
 * language, so the 2026-07-31 label change (Moments -> Big Questions / Grandes
 * preguntas; the /moments ROUTE and every internal name deliberately unchanged,
 * spec §0.2) could have silently broken it. Exactly one "Primary" landmark is
 * in the tree at a time (components/Header.tsx): the thumb bar on phones, which
 * carries `navShort`, and the row nav above 48rem, which carries `nav`.
 */
test.describe('header nav carries the Big Questions label', () => {
  for (const { locale, prefix, messages } of LOCALES) {
    test(`${locale}: the primary nav reaches /moments under its renamed label`, async ({
      page,
      isMobile,
    }) => {
      await page.goto(`${prefix}/`);
      const label = isMobile ? messages.common.navShort.moments : messages.common.nav.moments;
      const link = page.getByRole('link', { name: label, exact: true });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', `${prefix}/moments`);
      // The retired label is gone from every nav on the page, both locales.
      await expect(page.getByRole('link', { name: /^(Moments|Momentos)$/ })).toHaveCount(0);
      await link.click();
      await expect(page).toHaveURL(new RegExp(`${prefix}/moments$`));
    });
  }
});

test.describe('accessibility basics', () => {
  test('vehicle CTA meets the 44px touch target and is keyboard-focusable @reflow', async ({ page }) => {
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

/*
 * SEARCH PINNING (spec §7.3) — the promise data/moments.json has carried
 * since its first entry while nothing read the field. Corpus-derived like the
 * rest of this file: which alias to type, and whether that alias can produce
 * a zero-bill page today, are both facts about the live data, so they are
 * computed here and the test skips honestly when today's corpus can't
 * exercise the case.
 */
test.describe('bills search pins a live Moment', () => {
  /*
   * BillsBrowser's own bill-match rule, replicated so "this query returns no
   * bills" is derived rather than assumed. Saved interests are empty in a
   * fresh browser context, so the topic filter is not part of it.
   */
  const billsMatch = (q: string): boolean => {
    const categories = en.categories as Record<string, string>;
    return getTeasers('en').some(
      (b) =>
        b.title.toLowerCase().includes(q) ||
        (b.headline ?? '').toLowerCase().includes(q) ||
        b.identifier.toLowerCase().includes(q) ||
        b.tags.some((tag) => (categories[tag] ?? '').toLowerCase().includes(q))
    );
  };

  test("typing a live Moment's first alias pins it, and the row links through", async ({ page }) => {
    const live = getLiveMoments();
    test.skip(live.length === 0, 'no live moment in the corpus right now');
    const m = live[0];
    const alias = m.aliases.en[0];

    await page.goto('/bills');
    await waitForFeedHydrated(page);
    await page.getByRole('searchbox').fill(alias);

    const pin = page.locator(`a[href="/moments/${m.id}"]`);
    await expect(pin).toBeVisible();
    await expect(pin).toContainText(m.name.en);
    await expect(pin).toContainText(en.moments.searchPinLabel);
    await expect(pin).toContainText(en.moments.searchPinCta);

    /* ALIASES ARE NEVER RENDERED (the field's own contract). Asserted with an
       alias the name and dek don't already contain, so this is a claim about
       the row rather than an accident of English. */
    const rendered = `${m.name.en} ${momentDek(m.summary.en)}`.toLowerCase();
    const unrendered = m.aliases.en.find((a) => !rendered.includes(a.toLowerCase()));
    if (unrendered) await expect(pin).not.toContainText(unrendered, { ignoreCase: true });

    await pin.click();
    await expect(page).toHaveURL(new RegExp(`/moments/${m.id}$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText(m.name.en);
  });

  test('a query no bill matches still surfaces the Moment (the "ukraine" dead end)', async ({
    page,
  }) => {
    const candidates = getLiveMoments().flatMap((m) =>
      m.aliases.en
        .map((a) => a.trim())
        .filter((a) => a.length >= 2 && !billsMatch(a.toLowerCase()))
        .map((alias) => ({ m, alias }))
    );
    test.skip(
      candidates.length === 0,
      "every live alias also matches a bill in today's corpus - the dead end can't be reproduced"
    );
    const { m, alias } = candidates[0];

    await page.goto('/bills');
    await waitForFeedHydrated(page);
    await page.getByRole('searchbox').fill(alias);

    // Zero bills, and the count line says so - the pin is not a bill result.
    await expect(page.getByText(en.bills.noResults)).toBeVisible();
    await expect(page.locator(`a[href="/moments/${m.id}"]`)).toBeVisible();
  });
});

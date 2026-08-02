import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { getMoments, type MomentWithState } from '../lib/moments';
import {
  RENDER_DAY_CAP,
  getCurrentSummary,
  getRevisions,
  getUpdates,
  isAiSummary,
} from '../lib/moment-updates';
import { createTranslator } from 'next-intl';
import { collapseQuietDays, revisionReasons, timelineDays, type TimelineRow } from '../lib/moments-ui';

/*
 * e2e coverage for the Moments LIVE LAYER (v2 spec §7): the "Where it
 * stands" state summary and the "What's moved" timeline on /questions/[id],
 * plus the privacy line on /questions.
 *
 * CORPUS-ROBUST throughout, the same discipline as tests/moments.spec.ts:
 * every expectation is derived from data/moment-updates.json through the
 * reader (lib/moment-updates.ts) and the frame helper (lib/moments-ui.ts),
 * never from a hardcoded id, date, or count. The collector writes this file
 * on a cadence — a suite pinned to today's seed would be red by Thursday.
 * Where the live corpus cannot exercise a branch (no moment carries
 * `context_refs` yet; no seeded day overflows the render cap), the test
 * asserts the ABSENCE honestly rather than pretending to cover it.
 *
 * CLOCK: the pages are statically generated, so "today" is the BUILD's ET
 * day and these assertions use the runner's. Days that carry updates render
 * regardless of the frame, so every content assertion below is clock-proof;
 * only the quiet-day variants could skew, and only if a run straddles ET
 * midnight. tests/moments.spec.ts already accepts that same exposure.
 */

const WINDOW_DAYS = 14;

/** The same UTC-pinned day format the page uses — a date-only string
 *  rendered in any other zone prints a day early west of Greenwich. */
const fmtDay = (day: string, locale: 'en' | 'es') =>
  new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(day));

/** A "run sentence" regex derived from the message itself, so the leak
 *  checks below never hand-type copy — {count} matches any digits. */
const quietRunPattern = (msg: string) =>
  new RegExp(
    '^' + msg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{count\\}', '\\d+') + '$'
  );

/** The quiet runs the component folds — derived through the SAME helper it
 *  renders with, so the expectation and the render cannot drift. */
const quietRuns = (days: Parameters<typeof collapseQuietDays>[0]) =>
  collapseQuietDays(days).filter(
    (r): r is Extract<TimelineRow, { kind: 'quietRun' }> => r.kind === 'quietRun'
  );

/** The phrases the page prints after the reason label — same map, same ICU
 *  formatter, same message files the page itself renders through. */
const reasonPhrases = (tokens: string[], locale: 'en' | 'es'): string[] => {
  const t = createTranslator({
    locale,
    messages: (locale === 'en' ? en : es) as Record<string, unknown>,
  }) as unknown as (key: string, values?: Record<string, number>) => string;
  return revisionReasons(tokens).map((r) => t(`moments.updates.reason.${r.key}`, r.values));
};

const moments: MomentWithState[] = getMoments().filter((m) => m.state !== 'retired');
const withUpdates = moments.filter((m) => getUpdates(m.id).length > 0);

const timelineSection = (page: Page) => page.locator('section[aria-labelledby="whats-moved"]');

test.describe('"Where it stands" — the state summary', () => {
  for (const m of moments) {
    test(`${m.id}: summary renders with its date, the AI chip, and the disclaimer — or not at all`, async ({
      page,
    }) => {
      const revision = getCurrentSummary(m.id);
      await page.goto(`/questions/${m.id}`);

      const heading = page.getByRole('heading', { level: 2, name: /^Where it stands/ });
      if (!revision) {
        // No revision => NOTHING renders. An empty placeholder would be a
        // claim about our pipeline, and this surface only makes claims about
        // the record.
        await expect(heading).toHaveCount(0);
        return;
      }

      await expect(heading).toHaveText(
        en.moments.updates.whereHeading.replace('{date}', fmtDay(revision.as_of_day, 'en'))
      );
      await expect(page.getByText(revision.text.en, { exact: true })).toBeVisible();

      // AI labeled at first contact, above the passage it labels — and ONLY
      // when a model wrote that passage (pre-launch audit 2026-07-25,
      // constitution-08). The seed revisions carry model "hand-authored", and
      // a chip standing over human text erodes the label the same way a
      // missing chip does. Provenance is read through the same helper the
      // page renders with, so the two can't drift.
      const chip = page.getByText(en.moments.updates.summaryAiChip, { exact: true });
      if (isAiSummary(revision)) {
        await expect(chip.first()).toBeVisible();
        // The standing site-wide AI disclaimer sits under it (it also sits
        // under the hand-authored summary above, hence .last()).
        await expect(page.getByText(en.bill.aiDisclaimer).last()).toBeVisible();
      } else {
        // Nothing labels the passage as AI: no chip stands over it (any chip
        // in the DOM at all would be the one inside the closed revision
        // disclosure, which is hidden, and which labels the history — not
        // this summary).
        await expect(chip.first()).toBeHidden();
      }
    });

    test(`${m.id}: the revision history discloses only when there is history`, async ({ page }) => {
      const revisions = getRevisions(m.id);
      await page.goto(`/questions/${m.id}`);

      const toggle = page.getByText(/How this summary has changed/);
      if (revisions.length < 2) {
        await expect(toggle).toHaveCount(0);
        return;
      }
      await expect(toggle).toBeVisible();
      await expect(
        page.getByText(
          en.moments.updates.revisionsToggle.replace('{count}', String(revisions.length - 1)),
          { exact: true }
        )
      ).toBeVisible();
      // Prior revisions are listed with their dates; the current one is not
      // repeated inside its own history.
      //
      // COUNTED, not merely visible: the collector re-summarizes on a cadence,
      // so two revisions of the SAME ET day are ordinary — and iran-war-powers
      // shipped exactly that on 2026-07-25, which turned this assertion into a
      // Playwright strict-mode violation on main (two <p>As of July 25, 2026</p>
      // for one exact-text locator). One row per prior revision is the property
      // that was always meant here.
      await toggle.click();
      const perDate = new Map<string, number>();
      for (const prior of revisions.slice(0, -1)) {
        const label = en.moments.updates.revisionAsOf.replace(
          '{date}',
          fmtDay(prior.as_of_day, 'en')
        );
        perDate.set(label, (perDate.get(label) ?? 0) + 1);
      }
      for (const [label, count] of perDate) {
        await expect(page.getByText(label, { exact: true })).toHaveCount(count);
      }
    });

    /*
     * constitution-07: this disclosure printed `changed_because` verbatim, so
     * the page read "Rewritten because seed" — and /es read the same English
     * token. The reason is now a phrase from messages/*.json in the reader's
     * language, and a token that no longer maps takes the line with it rather
     * than printing itself. Asserted in the DOM, in BOTH locales, because
     * that is where the defect lived.
     */
    for (const locale of ['en', 'es'] as const) {
      test(`${m.id}: revision reasons read as language, not tokens (${locale})`, async ({
        page,
      }) => {
        const revisions = getRevisions(m.id);
        test.skip(revisions.length < 2, 'no prior revision to disclose');

        await page.goto(locale === 'en' ? `/questions/${m.id}` : `/es/questions/${m.id}`);
        const messages = locale === 'en' ? en : es;
        const history = page.locator('details', {
          has: page.locator('summary', {
            hasText: messages.moments.updates.revisionsToggle.replace(/\s*\(\{count\}\)$/, ''),
          }),
        });
        await history.locator('summary').click();
        const disclosed = await history.innerText();

        for (const prior of revisions.slice(0, -1)) {
          for (const phrase of reasonPhrases(prior.changed_because, locale)) {
            expect(disclosed, `${locale}: the localized reason is missing`).toContain(phrase);
          }
          for (const token of prior.changed_because) {
            expect(disclosed, `${locale}: raw token "${token}" reached the reader`).not.toContain(
              token
            );
          }
        }
        // Belt: no reason line survives with nothing after the label.
        expect(disclosed).not.toContain(`${messages.moments.updates.revisionReasonLabel}\n`);
      });
    }
  }
});

test.describe('"What\'s moved" — the timeline', () => {
  for (const m of withUpdates) {
    test(`${m.id}: every recorded day renders, capped at ${RENDER_DAY_CAP} items, newest first`, async ({
      page,
    }) => {
      const days = timelineDays(m.id, WINDOW_DAYS);
      await page.goto(`/questions/${m.id}`);

      await expect(
        page.getByRole('heading', { level: 2, name: en.moments.updates.timelineHeading })
      ).toBeVisible();

      const active = days.filter((d) => !d.quiet);
      expect(active.length, 'the seeded corpus must have at least one recorded day').toBeGreaterThan(0);

      for (const day of active) {
        const block = page.locator(`#moment-day-${day.day}`);
        await expect(block).toHaveCount(1);
        // A real heading over a real ordered list.
        await expect(block.getByRole('heading', { level: 3 })).toHaveText(fmtDay(day.day, 'en'));

        const items = block.locator('ol > li');
        await expect(items).toHaveCount(day.rendered.length);
        expect(day.rendered.length).toBeLessThanOrEqual(RENDER_DAY_CAP);

        for (const update of day.rendered) {
          await expect(block.getByText(update.text.en, { exact: true })).toBeVisible();
          // The class mark, localized — never a raw enum on screen.
          const label = en.moments.updates.class[update.class as keyof typeof en.moments.updates.class];
          await expect(block.getByText(label, { exact: true }).first()).toBeVisible();
          // Each item cites the vehicle it decodes, linking the real bill page.
          await expect(block.locator(`a[href="/bills/${update.vehicle}"]`).first()).toBeVisible();
        }
      }

      // DOM order: newest day first.
      if (active.length > 1) {
        const order = await page.evaluate(
          ([a, b]) => {
            const first = document.getElementById(`moment-day-${a}`);
            const second = document.getElementById(`moment-day-${b}`);
            if (!first || !second) return null;
            return first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING
              ? 'after'
              : 'before';
          },
          [active[0].day, active[1].day]
        );
        expect(order).toBe('after');
      }
    });

    test(`${m.id}: quiet days render as quiet days, and today's silence reads differently`, async ({
      page,
    }) => {
      const days = timelineDays(m.id, WINDOW_DAYS);
      const quiet = days.filter((d) => d.quiet);
      await page.goto(`/questions/${m.id}`);

      const past = page.getByText(en.moments.updates.quietDay, { exact: true });
      const today = page.getByText(en.moments.updates.quietToday, { exact: true });

      if (quiet.length === 0) {
        await expect(past).toHaveCount(0);
        await expect(today).toHaveCount(0);
        await expect(page.getByText(quietRunPattern(en.moments.updates.quietRun))).toHaveCount(0);
        return;
      }
      // A quiet day is computed, never a stored fake update — and a stretch
      // of two or more consecutive quiet, non-today days folds into ONE
      // spanned row, while a singleton renders exactly as before. Derived
      // through the same helper the component renders with, so the two
      // cannot drift. (The suite's ET-midnight exposure — see the header
      // comment — extends to run boundaries here: the same accepted risk.)
      const rows = collapseQuietDays(days);
      const singles = rows.filter((r) => r.kind === 'day' && r.day.quiet && !r.day.isToday);
      const runs = quietRuns(days);
      await expect(past).toHaveCount(singles.length);

      // Two equal-length runs print IDENTICAL sentences, so count per
      // distinct sentence (the Map/toHaveCount idiom the revision-history
      // test established) rather than asserting visibility one by one —
      // a bare toBeVisible() on a multi-match is a strict-mode violation.
      const perSentence = new Map<string, number>();
      for (const run of runs) {
        const sentence = en.moments.updates.quietRun.replace('{count}', String(run.count));
        perSentence.set(sentence, (perSentence.get(sentence) ?? 0) + 1);
      }
      for (const [sentence, n] of perSentence) {
        await expect(page.getByText(sentence, { exact: true })).toHaveCount(n);
      }
      // Each run prints its span, oldest day first. The expected string comes
      // from Intl's own formatRange (the fmtDay discipline): the en dash —
      // and, in some ICU builds, thin spaces — will never match a hand-typed
      // range. Ranges are unique per run, so exact text is safe here.
      for (const run of runs) {
        await expect(
          page.getByText(
            new Intl.DateTimeFormat('en', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              timeZone: 'UTC',
            }).formatRange(new Date(run.from), new Date(run.to)),
            { exact: true }
          )
        ).toBeVisible();
      }
      if (quiet.some((d) => d.isToday)) await expect(today).toHaveCount(1);
    });

    test(`${m.id}: source links are https, open safely, and never carry a lean`, async ({ page }) => {
      await page.goto(`/questions/${m.id}`);
      const section = timelineSection(page);

      const external = section.locator('a[target="_blank"]');
      const count = await external.count();
      expect(count, 'every update carries clickable evidence').toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        const link = external.nth(i);
        await expect(link).toHaveAttribute('href', /^https:\/\//);
        await expect(link).toHaveAttribute('rel', /noopener/);
        await expect(link).toHaveAttribute('rel', /noreferrer/);
      }

      // Lean is stored (the press guardrail needs it at write time) and is
      // DELIBERATELY never rendered — no lean labels, no AllSides chrome.
      expect(await section.getByText(/Leans left|Leans right|Leans center|AllSides/i).count()).toBe(0);
    });

    test(`${m.id}: the overflow line states what the cap held back`, async ({ page }) => {
      const days = timelineDays(m.id, WINDOW_DAYS);
      await page.goto(`/questions/${m.id}`);
      const overflowing = days.filter((d) => d.overflow > 0);
      const line = timelineSection(page).getByText(/further recorded action/);

      if (overflowing.length === 0) {
        // Honest absence: no seeded day has passed the render cap yet.
        await expect(line).toHaveCount(0);
        return;
      }
      for (const day of overflowing) {
        const block = page.locator(`#moment-day-${day.day}`);
        await expect(block.getByText(new RegExp(`${day.overflow} further recorded action`))).toBeVisible();
      }
    });
  }
});

test.describe('the ES live layer', () => {
  for (const m of withUpdates) {
    test(`${m.id}: /es renders Spanish update text with no English chrome`, async ({ page }) => {
      const days = timelineDays(m.id, WINDOW_DAYS);
      await page.goto(`/es/questions/${m.id}`);

      await expect(
        page.getByRole('heading', { level: 2, name: es.moments.updates.timelineHeading })
      ).toBeVisible();

      for (const day of days.filter((d) => !d.quiet)) {
        const block = page.locator(`#moment-day-${day.day}`);
        await expect(block.getByRole('heading', { level: 3 })).toHaveText(fmtDay(day.day, 'es'));
        for (const update of day.rendered) {
          await expect(block.getByText(update.text.es, { exact: true })).toBeVisible();
          // The English one-liner must not leak onto the Spanish page.
          await expect(page.getByText(update.text.en, { exact: true })).toHaveCount(0);
        }
      }

      // Zero English chrome from this feature's own namespace.
      await expect(page.getByText(en.moments.updates.timelineHeading, { exact: true })).toHaveCount(0);
      await expect(page.getByText(en.moments.updates.quietDay, { exact: true })).toHaveCount(0);
      // The English run sentence never leaks onto /es — and when the frame
      // holds a run, its Spanish sentence is what actually renders.
      await expect(page.getByText(quietRunPattern(en.moments.updates.quietRun))).toHaveCount(0);
      const runs = quietRuns(days);
      if (runs.length > 0) {
        await expect(
          page
            .getByText(
              es.moments.updates.quietRun.replace('{count}', String(runs[0].count)),
              { exact: true }
            )
            .first()
        ).toBeVisible();
      }
      await expect(page.getByText(en.moments.updates.sourcesLabel, { exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: /^Where it stands/ })).toHaveCount(0);
      const current = getCurrentSummary(m.id);
      if (current && isAiSummary(current)) {
        await expect(page.getByText(es.moments.updates.summaryAiChip, { exact: true }).first()).toBeVisible();
      }
      // The English chip never leaks onto the Spanish page, labeled or not.
      await expect(page.getByText(en.moments.updates.summaryAiChip, { exact: true })).toHaveCount(0);
    });
  }
});

test.describe('institutional context refs', () => {
  const carrying = moments.filter((m) => (m.context_refs?.length ?? 0) > 0);

  for (const m of carrying) {
    test(`${m.id}: the context_refs row names each source and links out`, async ({ page }) => {
      await page.goto(`/questions/${m.id}`);
      await expect(page.getByText(en.moments.updates.refsLabel, { exact: true })).toBeVisible();
      for (const ref of m.context_refs ?? []) {
        const link = page.locator(`a[href="${ref.url}"]`);
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', /noopener/);
        await expect(
          page.getByText(en.moments.updates.refKind[ref.kind], { exact: true }).first()
        ).toBeVisible();
      }
    });
  }

  /* Honest absence: `context_refs` is hand-curated (auto-discovery of CRS
     reports was refuted, v2 spec §5) and NO moment in the live corpus carries
     any yet, so the loop above is dormant and this one is what actually runs.
     Nothing here invents a reference to make a test green. */
  for (const m of moments.filter((mm) => (mm.context_refs?.length ?? 0) === 0)) {
    test(`${m.id}: no context_refs row when the moment carries none`, async ({ page }) => {
      await page.goto(`/questions/${m.id}`);
      await expect(page.getByText(en.moments.updates.refsLabel, { exact: true })).toHaveCount(0);
    });
  }
});

test.describe('the privacy line on /questions', () => {
  for (const { locale, prefix, messages } of [
    { locale: 'en', prefix: '', messages: en },
    { locale: 'es', prefix: '/es', messages: es },
  ] as const) {
    test(`${locale}: the index states that nobody is watching you read it`, async ({ page }) => {
      await page.goto(`${prefix}/questions`);
      await expect(page.getByText(messages.moments.updates.privacyNote, { exact: true })).toBeVisible();
    });
  }
});

test.describe('live-layer accessibility', () => {
  const m = withUpdates[0];

  test('the timeline is a real list under real headings, focusable at 44px', async ({ page }) => {
    test.skip(!m, 'no moment carries updates in the corpus right now');
    const day = timelineDays(m.id, WINDOW_DAYS).find((d) => !d.quiet);
    test.skip(!day, 'no recorded day in the frame');

    await page.goto(`/questions/${m.id}`);
    const block = page.locator(`#moment-day-${day!.day}`);
    // Semantic structure: h3 then ol > li, not a stack of divs.
    await expect(block.locator('h3')).toHaveCount(1);
    await expect(block.locator('ol')).toHaveCount(1);
    await expect(block.locator('ol > li').first()).toBeVisible();

    // Every link in an update row clears the 44px touch floor. (Inline
    // sentence links are exempt under WCAG 2.5.8; none of these are inline.)
    const links = block.locator('ol > li a');
    const count = await links.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await links.nth(i).boundingBox();
      expect(box?.height, 'timeline links must meet the 44px touch target').toBeGreaterThanOrEqual(44);
    }

    // Focus reaches them and is not removed.
    const first = links.first();
    await first.focus();
    await expect(first).toBeFocused();
  });
});

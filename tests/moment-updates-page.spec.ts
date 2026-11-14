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
import { etDay, shiftDay } from '../lib/moment-updates-gate.mjs';
import { frameDays, visitorEtDay } from './moment-frame';

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
 * CLOCK: the pages are statically generated, so the timeline's frame — which
 * day is "today", which fourteen days are quiet — is the BUILD's Eastern day,
 * and a CI run that straddles midnight Eastern builds on one day and asserts
 * on the next (run 43558569518, 2026-11-14: six failures, all in the quiet-day
 * tests below). So no expectation here reads this process's clock. The frame
 * comes from the page itself (`data-frame-day`, tests/moment-frame.ts), and
 * the one clock-dependent line — the newest quiet row's "yet today", decided
 * in the visitor's browser by components/MomentQuietDay.tsx — is asserted
 * against the BROWSER's clock, then exercised with that clock moved across
 * midnight (the last describe block). Days that carry updates render
 * regardless of the frame, so the other timeline tests are clock-proof.
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
      await page.goto(`/questions/${m.id}`);
      const days = await frameDays(page, m.id, WINDOW_DAYS);
      const quiet = days.filter((d) => d.quiet);

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
      // cannot drift.
      const rows = collapseQuietDays(days);
      const singles = rows.filter((r) => r.kind === 'day' && r.day.quiet && !r.day.isToday);
      const runs = quietRuns(days);
      // The newest row is the day the page was BUILT for. It says "yet today"
      // only while the visitor's own Eastern day is that day; any later and it
      // reads as the plain past-tense line a past quiet day gets
      // (components/MomentQuietDay.tsx). Both facts come from the browser and
      // the page, never from this process's clock.
      const newestIsQuiet = days[0].quiet;
      const stillToday = days[0].day === (await visitorEtDay(page));
      await expect(past).toHaveCount(singles.length + (newestIsQuiet && !stillToday ? 1 : 0));

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
      await expect(today).toHaveCount(newestIsQuiet && stillToday ? 1 : 0);
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
      await page.goto(`/es/questions/${m.id}`);
      const days = await frameDays(page, m.id, WINDOW_DAYS);

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

/*
 * THE NEWEST QUIET ROW FOLLOWS THE VISITOR'S CLOCK, NOT THE BUILD'S.
 *
 * The page is prerendered, so its newest row is the day it was BUILT for.
 * From midnight Eastern until the next deploy that day is yesterday, and the
 * row used to keep saying "Nothing recorded yet today." under yesterday's
 * date. Here the BROWSER's clock is pinned (page.clock) to each side of that
 * midnight and the page is asked what a visitor then reads: "yet today" on
 * the row's own day, the plain past-tense line on any other, never both and
 * never neither. The corpus decides whether a newest quiet row exists at all
 * (a question with a recorded action on its build day has none to move), so
 * that case skips with its reason, like the sections above.
 */
test.describe("the newest quiet row follows the visitor's clock, not the build's", () => {
  const HOUR = 3_600_000;
  const LOCALES = [
    { prefix: '', messages: en },
    { prefix: '/es', messages: es },
  ] as const;

  /** The first instant of Eastern day `day`, found rather than assumed, so
   *  the test holds on both sides of the November clock change. */
  const startOfEtDay = (day: string): number => {
    const ms = [4, 5]
      .map((h) => Date.parse(`${day}T0${h}:00:00Z`))
      .find((t) => etDay(t) === day && etDay(t - 1) !== day);
    if (ms === undefined) throw new Error(`no Eastern midnight found for ${day}`);
    return ms;
  };

  for (const m of withUpdates) {
    test(`${m.id}: "yet today" on the row's own day, the plain line on any other`, async ({ page }) => {
      for (const { prefix, messages } of LOCALES) {
        const path = `${prefix}/questions/${m.id}`;
        await page.goto(path);
        const days = await frameDays(page, m.id, WINDOW_DAYS);
        test.skip(!days[0].quiet, 'a recorded action sits on the build day: there is no quiet newest row to move');
        const built = days[0].day;
        const singles = collapseQuietDays(days).filter(
          (r) => r.kind === 'day' && r.day.quiet && !r.day.isToday
        ).length;

        const today = page.getByText(messages.moments.updates.quietToday, { exact: true });
        const plain = page.getByText(messages.moments.updates.quietDay, { exact: true });
        const at = {
          'the build day itself': { ms: startOfEtDay(built) + 12 * HOUR, live: true },
          'the next day (the build is stale)': { ms: startOfEtDay(shiftDay(built, 1)) + 12 * HOUR, live: false },
          'the day before (a clock set behind)': { ms: startOfEtDay(shiftDay(built, -1)) + 12 * HOUR, live: false },
        };
        for (const [when, { ms, live }] of Object.entries(at)) {
          await page.clock.setFixedTime(ms);
          await page.reload();
          const label = `${prefix || '/en'} on ${when}`;
          await expect(today, label).toHaveCount(live ? 1 : 0);
          await expect(plain, label).toHaveCount(singles + (live ? 0 : 1));
          // The row's own date is printed either way — the claim never
          // depends on the reader knowing the date.
          await expect(page.getByText(fmtDay(built, prefix ? 'es' : 'en'), { exact: true }).first(), label).toBeVisible();
        }
      }
    });

    test(`${m.id}: a tab left open across midnight Eastern stops saying "yet today"`, async ({ page }) => {
      await page.goto(`/questions/${m.id}`);
      const days = await frameDays(page, m.id, WINDOW_DAYS);
      test.skip(!days[0].quiet, 'a recorded action sits on the build day: there is no quiet newest row to move');
      const built = days[0].day;
      const singles = collapseQuietDays(days).filter(
        (r) => r.kind === 'day' && r.day.quiet && !r.day.isToday
      ).length;
      const midnight = startOfEtDay(shiftDay(built, 1));

      const today = page.getByText(en.moments.updates.quietToday, { exact: true });
      const plain = page.getByText(en.moments.updates.quietDay, { exact: true });
      await page.clock.install({ time: midnight - 20_000 });
      await page.goto(`/questions/${m.id}`);
      await expect(today).toHaveCount(1);
      await expect(plain).toHaveCount(singles);

      // Forty seconds on, the visitor's clock reads the next Eastern day.
      await page.clock.runFor(40_000);
      await expect(today).toHaveCount(0);
      await expect(plain).toHaveCount(singles + 1);
    });
  }
});

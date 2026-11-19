import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/*
 * THE STEPPER SAYS A PRESENTED BILL WAS SENT TO THE PRESIDENT (re-check of
 * #523, round 6). components/BillJourney.tsx prints the Big Questions status
 * line's own sentence ("Both chambers passed it, and it has been sent to the
 * president.", lowercased after "Right now:") when lib/journey.ts sets
 * `presented`. Switching that branch off left every other test green; this
 * renders the component itself, in both languages, so it cannot be switched
 * off unnoticed.
 *
 * The render runs in a child process (tests/render-bill-journey.mts, under
 * tsx): the unit project compiles .tsx for Playwright's component runner,
 * which react-dom/server cannot render.
 */

const ROOT = process.cwd();
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function rendered(lang: 'en' | 'es', lastAction: string): string {
  const html = execFileSync(process.execPath, [TSX, join(ROOT, 'tests', 'render-bill-journey.mts'), lang, lastAction], {
    cwd: ROOT,
    encoding: 'utf8',
    // A hung child must not block the job.
    timeout: 60_000,
  });
  return html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
}

test('a bill presented to the President: the stepper says it was sent to the president, in both languages', () => {
  expect(rendered('en', 'Presented to President.')).toContain('Right now: both chambers passed it, and it has been sent to the president.');
  expect(rendered('es', 'Presented to President.')).toContain('ambas cámaras lo aprobaron y se envió al presidente.');
});

test('a bill both chambers passed but not yet presented: no "sent to the president"', () => {
  const en = rendered('en', 'Passed Senate without amendment by Unanimous Consent.');
  expect(en).toContain('Right now:');
  expect(en).not.toContain('sent to the president');
  expect(rendered('es', 'Passed Senate without amendment by Unanimous Consent.')).not.toContain('se envió al presidente');
});

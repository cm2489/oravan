/*
 * Renders components/BillJourney.tsx to static HTML for
 * tests/bill-journey-presented.unit.spec.ts, which runs it with tsx in a
 * child process: the unit project compiles .tsx for Playwright's component
 * runner, which react-dom/server cannot render. next-intl is loaded through
 * the same module system the component is, so the provider and the
 * component's hooks share one context.
 *
 * Usage: tsx tests/render-bill-journey.mts <en|es> <last action text>
 * Prints the HTML.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveJourney } from '../lib/journey';

const require = createRequire(import.meta.url);
const { createElement } = require('react') as typeof import('react');
const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');
const { NextIntlClientProvider } = require('next-intl') as typeof import('next-intl');
const { BillJourney } = require('../components/BillJourney') as typeof import('../components/BillJourney');

const [lang, text] = process.argv.slice(2) as ['en' | 'es', string];
const messages = JSON.parse(readFileSync(join(process.cwd(), `messages/${lang}.json`), 'utf8'));
// A Congress number no list will ever hold, so the January switch that ends
// the 119th cannot change this reading (as tests/status-word-stages does).
const record = {
  bill_type: 'hr',
  status: 'passed_chamber' as const,
  last_action_text: text,
  status_basis_text: null,
  last_action_date: '2026-11-12',
  congress_number: 9_119,
  title: 'A bill.',
};
const journey = deriveJourney(record);
process.stdout.write(
  renderToStaticMarkup(
    createElement(NextIntlClientProvider, { locale: lang, messages, timeZone: 'UTC', children: createElement(BillJourney, { journey }) })
  )
);

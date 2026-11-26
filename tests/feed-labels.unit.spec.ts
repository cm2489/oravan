import { expect, test } from '@playwright/test';
// Relative import (not '@/'): plain lib modules resolve under the test runner.
import { channelFieldParts } from '../lib/core/feed-labels';

/*
 * THE SPANISH FEED'S CHANNEL LABELS ARE SPANISH (2026-11-25).
 *
 * An outside review of the Spanish edition read "Source:", "License:" and
 * "AI content:" in /es/feed/whats-moving.xml. lib/core/feed.ts builds the
 * channel description's field sentences through channelFieldParts, which
 * labels them in the feed's own language.
 */

const FIELDS = { source: 'S', license: 'L', ai_label: 'A' };

test('the Spanish feed labels its fields in Spanish', () => {
  expect(channelFieldParts('es', FIELDS)).toEqual(['Fuente: S', 'Licencia: L', 'Contenido de IA: A']);
});

test('the English feed keeps its English labels', () => {
  expect(channelFieldParts('en', FIELDS)).toEqual(['Source: S', 'License: L', 'AI content: A']);
});

test('no AI label means no AI sentence, in either language', () => {
  for (const locale of ['en', 'es'] as const) {
    expect(channelFieldParts(locale, { ...FIELDS, ai_label: null })).toHaveLength(2);
  }
});

import { expect, test } from '@playwright/test';
// Relative import (not '@/'): lib/coverage.ts is plain (no 'server-only') and
// imports its JSON relatively, so the matcher resolves under the test runner.
import { leanFor, normalizeSource } from '../lib/coverage';

test.describe('coverage matcher', () => {
  test('normalizeSource reduces any source form to a bare domain', () => {
    expect(normalizeSource('https://www.CNN.com/politics/x')).toBe('cnn.com');
    expect(normalizeSource('www.foxnews.com')).toBe('foxnews.com');
    expect(normalizeSource('NPR.org')).toBe('npr.org');
    expect(normalizeSource('  thehill.com  ')).toBe('thehill.com');
  });

  test('leanFor returns the AllSides lean for rated outlets', () => {
    expect(leanFor('cnn.com')).toBe('left');
    expect(leanFor('https://www.foxnews.com/politics/x')).toBe('right');
    expect(leanFor('thehill.com')).toBe('center');
  });

  test('leanFor returns null for unrated outlets (no chip)', () => {
    expect(leanFor('chir.georgetown.edu')).toBeNull();
    expect(leanFor('example.com')).toBeNull();
    expect(leanFor('')).toBeNull();
  });
});

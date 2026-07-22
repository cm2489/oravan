import { expect, test } from '@playwright/test';
import { createLruCache } from '../lib/brand-cache';

test('get/set round-trip and miss', () => {
  const cache = createLruCache<string>({ max: 3, ttlMs: 1000, now: () => 0 });
  expect(cache.get('a')).toBeUndefined();
  cache.set('a', 'A');
  expect(cache.get('a')).toBe('A');
});

test('TTL: entries expire on read past their deadline', () => {
  let clock = 0;
  const cache = createLruCache<string>({ max: 3, ttlMs: 100, now: () => clock });
  cache.set('a', 'A');
  clock = 99;
  expect(cache.get('a')).toBe('A');
  clock = 100;
  expect(cache.get('a')).toBeUndefined();
});

test('LRU: eviction removes the least-recently-USED, not least-recently-set', () => {
  const cache = createLruCache<string>({ max: 2, ttlMs: 1000, now: () => 0 });
  cache.set('a', 'A');
  cache.set('b', 'B');
  cache.get('a'); // refresh a's recency
  cache.set('c', 'C'); // evicts b, not a
  expect(cache.get('a')).toBe('A');
  expect(cache.get('b')).toBeUndefined();
  expect(cache.get('c')).toBe('C');
});

test('setting an existing key updates in place without evicting others', () => {
  const cache = createLruCache<string>({ max: 2, ttlMs: 1000, now: () => 0 });
  cache.set('a', 'A');
  cache.set('b', 'B');
  cache.set('a', 'A2');
  expect(cache.get('a')).toBe('A2');
  expect(cache.get('b')).toBe('B');
});

import { expect, test } from '@playwright/test';
// Relative imports (not '@/'): plain lib modules resolve under the test
// runner — same pattern as the other unit specs (tests/ratelimit.unit.spec.ts).
import {
  __memoryDomainCountForTests,
  __resetEmbedReferrerFallbackLogForTests,
  dayKey,
  domainNominationKey,
  noteEmbedReferralDomain,
  registrableDomain,
} from '../lib/embed-referrer';
import { COUNTERS_URL, MockUpstash, installUpstashFetch, setUpstashEnv } from './upstash-mock';

/*
 * F3 (S15): Referer truncation at ingestion. The ledger's own named test
 * lives in the second test.describe block below — a full-URL Referer
 * fixture with a path, a query string, AND a fake click-token, proving only
 * the registrable domain + a count survive anywhere on the (mocked) wire.
 * The first block pins registrableDomain's edge cases in isolation, since
 * that pure function is the entire truncation guarantee.
 */

test.describe('registrableDomain: pure truncation logic', () => {
  test('absent Referer (no header sent at all) — the common cross-origin case', () => {
    expect(registrableDomain(null)).toBeNull();
    expect(registrableDomain(undefined)).toBeNull();
    expect(registrableDomain('')).toBeNull();
    expect(registrableDomain('   ')).toBeNull();
  });

  test('a bare origin — the common strict-origin-when-cross-origin case', () => {
    expect(registrableDomain('https://example.org')).toBe('example.org');
    // A subdomain reduces to its registrable domain, not the full hostname.
    expect(registrableDomain('https://news.example.org')).toBe('example.org');
    expect(registrableDomain('https://www.local-news.example.com/')).toBe('example.com');
  });

  test('F3 named fixture: a full path+query+fake-click-token URL truncates to the domain alone', () => {
    const hostile =
      'https://www.local-news.example.com/section/politics/story-42?utm_source=newsletter&click_token=abc123-fake-tracking-id&ref=homepage#section-2';
    expect(registrableDomain(hostile)).toBe('example.com');
  });

  test('unsafe-url-shaped Referer (full URL even though it is cross-origin) still truncates', () => {
    expect(registrableDomain('https://library.example.org/catalog?item=9876&session=leak-canary')).toBe(
      'example.org'
    );
  });

  test('malformed Referers are handled gracefully, never thrown', () => {
    expect(registrableDomain('not a url at all')).toBeNull();
    expect(registrableDomain('example.com')).toBeNull(); // no scheme — not parseable as absolute
    expect(registrableDomain('://broken')).toBeNull();
    expect(registrableDomain('ftp://example.com/file')).toBeNull(); // non-http(s) scheme
    expect(registrableDomain('javascript:alert(1)')).toBeNull();
  });

  test('a bare IPv4 Referer is not treated as a nominable domain', () => {
    expect(registrableDomain('http://203.0.113.9/path')).toBeNull();
  });

  test('localhost / single-label hosts have nothing registrable to nominate', () => {
    expect(registrableDomain('http://localhost:3000/')).toBeNull();
    expect(registrableDomain('http://intranet/')).toBeNull();
  });

  test('two-level ccTLD suffixes resolve to the real registrant, not the suffix', () => {
    expect(registrableDomain('https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
    expect(registrableDomain('https://bbc.co.uk/')).toBe('bbc.co.uk');
  });

  test('a subdomain on a "one registrant per subdomain" hosting platform keeps the registrant', () => {
    expect(registrableDomain('https://my-newsroom.github.io/embed-demo')).toBe('my-newsroom.github.io');
    expect(registrableDomain('https://civic-org.vercel.app/')).toBe('civic-org.vercel.app');
  });

  test('a normal .org/.com/.news domain is unaffected by the exception list', () => {
    expect(registrableDomain('https://www.some-local-news.news/story')).toBe('some-local-news.news');
  });
});

test.describe('noteEmbedReferralDomain: F3 ingestion (Upstash-backed)', () => {
  let restoreFetch: (() => void) | null = null;
  let restoreEnv: (() => void) | null = null;

  test.afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    restoreEnv?.();
    restoreEnv = null;
  });

  test('the named F3 fixture: a full-URL Referer (path + query + fake click-token) leaves only the registrable domain + a count anywhere on the wire', async () => {
    restoreEnv = setUpstashEnv();
    const counters = new MockUpstash();
    restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

    const clickToken = 'fake-click-token-xyz-987-should-never-persist';
    const hostileReferer = `https://www.local-news.example.com/section/politics/story-42?utm_source=newsletter&click_token=${clickToken}&ref=homepage#deep-section`;

    await noteEmbedReferralDomain(hostileReferer);
    await noteEmbedReferralDomain(hostileReferer); // second load from the same host, same day

    const wire = JSON.stringify(counters.commands);

    // The registrable domain survived...
    expect(wire).toContain('example.com');
    // ...but NOTHING else about the original URL did: not the path, not the
    // query string, not the fake click-token, not the fragment, not the
    // "www" subdomain, not the scheme.
    for (const leaked of [
      'section',
      'politics',
      'story-42',
      'utm_source',
      'newsletter',
      clickToken,
      'ref=homepage',
      'deep-section',
      'www.local-news',
      'https://',
    ]) {
      expect(wire, `wire surface must not carry "${leaked}"`).not.toContain(leaked);
    }

    // Exactly one key exists, shaped <env>:embed-domain:<day>:<domain>, and
    // its count reflects both loads.
    const keys = counters.keys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(domainNominationKey('example.com', dayKey()));
    expect(keys[0]).toMatch(/^dev:embed-domain:\d{4}-\d{2}-\d{2}:example\.com$/);
    expect(counters.store.get(keys[0])?.value).toBe('2');
  });

  test('a second, different nominated domain gets its own independent daily counter', async () => {
    restoreEnv = setUpstashEnv();
    const counters = new MockUpstash();
    restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

    await noteEmbedReferralDomain('https://library.example.org/catalog?item=1');
    await noteEmbedReferralDomain('https://news.example.net/story?id=2');
    await noteEmbedReferralDomain('https://library.example.org/catalog?item=3');

    const keys = counters.keys().sort();
    expect(keys).toEqual(
      [domainNominationKey('example.net', dayKey()), domainNominationKey('example.org', dayKey())].sort()
    );
    expect(counters.store.get(domainNominationKey('example.org', dayKey()))?.value).toBe('2');
    expect(counters.store.get(domainNominationKey('example.net', dayKey()))?.value).toBe('1');
  });

  test('TTL is attached at creation (SET NX EX before INCR), bounded and non-permanent', async () => {
    restoreEnv = setUpstashEnv();
    const counters = new MockUpstash();
    restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

    await noteEmbedReferralDomain('https://example.org/');
    const key = domainNominationKey('example.org', dayKey());
    const ttl = counters.exec(['TTL', key]);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60 * 24 * 60 * 60);

    const setCommands = counters.commands.filter((c) => c[0] === 'SET' && c[1] === key);
    expect(setCommands).toHaveLength(1);
    expect(setCommands[0].slice(3)).toEqual(['NX', 'EX', String(60 * 24 * 60 * 60)]);
  });

  test('absent/malformed Referer: nothing is written, nothing throws', async () => {
    restoreEnv = setUpstashEnv();
    const counters = new MockUpstash();
    restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

    await expect(noteEmbedReferralDomain(null)).resolves.toBeUndefined();
    await expect(noteEmbedReferralDomain(undefined)).resolves.toBeUndefined();
    await expect(noteEmbedReferralDomain('not a url')).resolves.toBeUndefined();
    await expect(noteEmbedReferralDomain('http://localhost:3000/')).resolves.toBeUndefined();

    expect(counters.commands).toHaveLength(0);
  });

  test('graceful degradation: no env → in-memory fallback, zero network calls, single startup line', async () => {
    // No setUpstashEnv() here — the local-dev/CI/preview-without-env path.
    const counters = new MockUpstash();
    restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });
    __resetEmbedReferrerFallbackLogForTests();

    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => logged.push(args.join(' '));
    try {
      await noteEmbedReferralDomain('https://example.org/story?a=1');
      await noteEmbedReferralDomain('https://example.org/other?b=2');
    } finally {
      console.log = realLog;
    }

    expect(counters.commands, 'must not touch the REST surface without env').toHaveLength(0);
    expect(__memoryDomainCountForTests('example.org')).toBe(2);
    const fallbackLines = logged.filter((l) => l.includes('in-memory'));
    expect(fallbackLines).toHaveLength(1);
  });

  test('graceful degradation: an Upstash request error fails open, is counted, and logs status-only', async () => {
    restoreEnv = setUpstashEnv();
    const counters = new MockUpstash();
    counters.failWithStatus = 503;
    restoreFetch = installUpstashFetch({ [COUNTERS_URL]: counters });

    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => logged.push(args.join(' '));
    try {
      await expect(noteEmbedReferralDomain('https://example.org/secret-path?token=leak')).resolves.toBeUndefined();
    } finally {
      console.error = realError;
    }

    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).toContain('status 503');
      expect(line).not.toContain('secret-path');
      expect(line).not.toContain('token=leak');
    }
  });
});

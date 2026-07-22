import { expect, test } from '@playwright/test';
import { isForbiddenIp, makeGuardedLookup, normalizeBrandUrl } from '../lib/brand-fetch';

test.describe('normalizeBrandUrl', () => {
  test('bare domains and http are upgraded to an https origin', () => {
    expect(normalizeBrandUrl('example.com')).toEqual({ ok: true, origin: 'https://example.com' });
    expect(normalizeBrandUrl('http://example.com')).toEqual({ ok: true, origin: 'https://example.com' });
    expect(normalizeBrandUrl('https://news.example.org')).toEqual({
      ok: true,
      origin: 'https://news.example.org',
    });
  });

  test('the path/query/fragment never survive — origin truncation at parse time', () => {
    expect(normalizeBrandUrl('https://example.com/private/page?q=secret#frag')).toEqual({
      ok: true,
      origin: 'https://example.com',
    });
  });

  test('IDN hostnames come back as punycode (URL API normalization)', () => {
    const result = normalizeBrandUrl('https://münchen-zeitung.de');
    expect(result).toEqual({ ok: true, origin: 'https://xn--mnchen-zeitung-gsb.de' });
  });

  test('non-web schemes are refused', () => {
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://example.com',
      'data:text/html,x',
      'chrome://settings',
    ]) {
      expect(normalizeBrandUrl(bad)).toEqual({ ok: false });
    }
  });

  test('IP-literal hosts are refused pre-DNS, v4 and v6, public or not', () => {
    for (const bad of [
      'https://10.1.2.3',
      'https://127.0.0.1',
      'https://169.254.169.254',
      'https://8.8.8.8', // even public IPs: origins are names, not addresses
      'https://[::1]',
      'https://[2606:4700::6810:84e5]',
    ]) {
      expect(normalizeBrandUrl(bad)).toEqual({ ok: false });
    }
  });

  test('localhost, single-label, and private-use suffix hosts are refused', () => {
    for (const bad of [
      'https://localhost',
      'http://localhost:3000',
      'https://intranet',
      'https://nas.local',
      'https://build.internal',
      'https://router.lan',
      'https://ns.arpa',
    ]) {
      expect(normalizeBrandUrl(bad)).toEqual({ ok: false });
    }
  });

  test('userinfo and non-443 ports are refused', () => {
    expect(normalizeBrandUrl('https://user:pass@example.com')).toEqual({ ok: false });
    expect(normalizeBrandUrl('https://user@example.com')).toEqual({ ok: false });
    expect(normalizeBrandUrl('https://example.com:8443')).toEqual({ ok: false });
    expect(normalizeBrandUrl('http://example.com:8080')).toEqual({ ok: false });
    expect(normalizeBrandUrl('https://example.com:443')).toEqual({
      ok: true,
      origin: 'https://example.com',
    });
  });

  test('non-strings, empties, and oversized input are refused', () => {
    expect(normalizeBrandUrl(42)).toEqual({ ok: false });
    expect(normalizeBrandUrl(null)).toEqual({ ok: false });
    expect(normalizeBrandUrl('')).toEqual({ ok: false });
    expect(normalizeBrandUrl('   ')).toEqual({ ok: false });
    expect(normalizeBrandUrl('https://example.com/' + 'a'.repeat(2100))).toEqual({ ok: false });
  });
});

test.describe('isForbiddenIp', () => {
  test('the v4 private/reserved/metadata table', () => {
    for (const ip of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '100.127.255.255',
      '127.0.0.1',
      '127.255.255.254',
      '169.254.169.254', // cloud metadata
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.1',
      '192.0.2.44',
      '192.168.1.1',
      '198.18.0.1',
      '198.19.255.255',
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.251',
      '240.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isForbiddenIp(ip), `${ip} should be forbidden`).toBe(true);
    }
  });

  test('ordinary public v4 addresses pass', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '151.101.1.140', '76.76.21.21', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1']) {
      expect(isForbiddenIp(ip), `${ip} should be allowed`).toBe(false);
    }
  });

  test('the v6 table, including mapped-v4 and NAT64 unwrapping', () => {
    for (const ip of [
      '::',
      '::1',
      'fc00::1',
      'fd12:3456:789a::1',
      'fe80::1',
      'ff02::fb',
      '2001:db8::1',
      '::ffff:169.254.169.254', // mapped v4 → metadata
      '::ffff:10.0.0.1',
      '::ffff:a9fe:a9fe', // 169.254.169.254 in hex groups
      '64:ff9b::10.0.0.1', // NAT64 → private
      '64:ff9b::a00:1',
    ]) {
      expect(isForbiddenIp(ip), `${ip} should be forbidden`).toBe(true);
    }
  });

  test('public v6 and mapped-public-v4 pass', () => {
    for (const ip of ['2606:4700::6810:84e5', '2a00:1450:4001:82a::200e', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
      expect(isForbiddenIp(ip), `${ip} should be allowed`).toBe(false);
    }
  });

  test('unparseable input is forbidden (fail closed)', () => {
    for (const ip of ['', 'not-an-ip', '1.2.3', '1.2.3.4.5', '999.1.1.1', ':::', 'gggg::1']) {
      expect(isForbiddenIp(ip), `${ip} should fail closed`).toBe(true);
    }
  });
});

test.describe('makeGuardedLookup (injected DNS)', () => {
  type Cb = (err: Error | null, result?: unknown) => void;
  const fakeDns =
    (answers: Array<{ address: string; family: number }>) =>
    ((_host: string, _opts: unknown, cb: Cb) => cb(null, answers)) as never;

  function run(lookup: ReturnType<typeof makeGuardedLookup>, all = false) {
    return new Promise<{ err: Error | null; args: unknown[] }>((resolve) => {
      lookup('example.com', { all }, (err, ...args) => resolve({ err, args }));
    });
  }

  test('public-only answers pass through', async () => {
    const lookup = makeGuardedLookup(fakeDns([{ address: '93.184.216.34', family: 4 }]));
    const { err, args } = await run(lookup);
    expect(err).toBeNull();
    expect(args[0]).toBe('93.184.216.34');
  });

  test('a private answer refuses the whole lookup', async () => {
    const lookup = makeGuardedLookup(fakeDns([{ address: '10.0.0.5', family: 4 }]));
    const { err } = await run(lookup);
    expect(err).not.toBeNull();
    expect((err as NodeJS.ErrnoException).code).toBe('EFORBIDDEN');
  });

  test('mixed public + private refuses — the rebinding/round-robin shape', async () => {
    const lookup = makeGuardedLookup(
      fakeDns([
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ])
    );
    const { err } = await run(lookup);
    expect(err).not.toBeNull();
  });

  test('a private AAAA in the answer set also refuses', async () => {
    const lookup = makeGuardedLookup(
      fakeDns([
        { address: '93.184.216.34', family: 4 },
        { address: 'fd00::1', family: 6 },
      ])
    );
    const { err } = await run(lookup);
    expect(err).not.toBeNull();
  });

  test('empty answers refuse', async () => {
    const lookup = makeGuardedLookup(fakeDns([]));
    const { err } = await run(lookup);
    expect(err).not.toBeNull();
  });

  test('all:true passes the full validated list through', async () => {
    const answers = [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ];
    const lookup = makeGuardedLookup(fakeDns(answers));
    const { err, args } = await run(lookup, true);
    expect(err).toBeNull();
    expect(args[0]).toEqual(answers);
  });
});

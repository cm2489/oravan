import { lookup as nodeDnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';

/*
 * SSRF-guarded outbound fetch for /api/brand (brand-preview build). The one
 * place in the codebase that fetches a caller-chosen URL, so the guard
 * doctrine lives here:
 *
 *   - STATELESS + LOG-NOTHING, the app/api/district/route.ts rule: no catch
 *     in this module logs anything, not even the error object — a network
 *     error can embed the hostname, and the /embeds privacy copy promises
 *     the submitted address never lands anywhere.
 *   - The URL is truncated to its ORIGIN inside normalizeBrandUrl — the
 *     path/query/fragment never exist past that first function, and the
 *     homepage fetch is always `https://<origin>/`.
 *   - node:https with a guarded `lookup` rather than pre-resolve-then-fetch:
 *     the socket connects to the exact addresses the filter approved, so a
 *     DNS-rebinding attacker (public A record for the checker, private one
 *     for the connector) has no TOCTOU window. Stdlib-only on purpose — no
 *     undici dependency for one route.
 *   - Redirects are followed manually (≤ maxRedirects) and every hop passes
 *     the same host-shape check + guarded lookup again.
 *   - `Accept-Encoding: identity` so there is no decompression path and the
 *     byte cap counts real body bytes; the socket is destroyed at the cap
 *     and truncated HTML is a SUCCESS (extraction works on what arrived).
 *
 * Robots note: this is a single user-initiated fetch of the org's own
 * homepage (link-unfurler class, not crawling), with an honest, blockable
 * UA — robots.txt is deliberately not consulted.
 *
 * Not 'server-only' so the unit suite can drive the pure guard functions
 * directly; the route is the only runtime importer.
 */

export const BRAND_FETCH_UA = 'OravanBrandPreview/1.0 (+https://oravan.org/embeds)';

const MAX_URL_CHARS = 2048;
const FORBIDDEN_HOST_SUFFIXES = ['.local', '.internal', '.arpa', '.localhost', '.home', '.lan'];

/**
 * Parse untrusted input into a fetchable https origin, or refuse. Accepts
 * bare domains ("example.com") and http:// (silently upgraded — we never
 * fetch cleartext); refuses IP-literal hosts, localhost, single-label
 * hosts, private-use TLDs, userinfo, and any explicit port other than 443.
 * The URL API normalizes IDN hostnames to punycode before any check.
 */
export function normalizeBrandUrl(raw: unknown): { ok: true; origin: string } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_CHARS) return { ok: false };

  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false };
  if (url.username || url.password) return { ok: false };
  // An explicit port survives the scheme upgrade — only default https lands.
  if (url.port && url.port !== '443') return { ok: false };
  if (!hostnameAllowed(url.hostname)) return { ok: false };

  return { ok: true, origin: `https://${url.hostname}` };
}

/** Host-shape gate shared by the initial parse and every redirect hop. */
function hostnameAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host || host === 'localhost') return false;
  if (host.startsWith('[') || isIpv4Shaped(host)) return false; // IP literals never allowed
  if (!host.includes('.')) return false; // single-label = intranet name
  if (FORBIDDEN_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  return true;
}

function isIpv4Shaped(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function parseIpv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

const V4_FORBIDDEN: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local incl. cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function isForbiddenIpv4(ip: string): boolean {
  const value = parseIpv4(ip);
  if (value === null) return true; // unparseable = fail closed
  return V4_FORBIDDEN.some(([base, bits]) => {
    const baseValue = parseIpv4(base)!;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (baseValue & mask);
  });
}

/** Expand an IPv6 string into its 8 16-bit groups, or null if unparseable. */
function expandIpv6(ip: string): number[] | null {
  let host = ip.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zone = host.indexOf('%');
  if (zone !== -1) host = host.slice(0, zone);

  // Trailing dotted-quad (::ffff:1.2.3.4 and NAT64 shapes) → two groups.
  const v4Match = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (v4Match) {
    const v4 = parseIpv4(v4Match[2]);
    if (v4 === null) return null;
    host = `${v4Match[1]}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = host.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 0 : head.length !== 8) return null;

  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const parsed = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : -1));
  return parsed.some((g) => g < 0) ? null : parsed;
}

function isForbiddenIpv6(ip: string): boolean {
  const groups = expandIpv6(ip);
  if (!groups) return true; // unparseable = fail closed

  const embeddedV4 = ((groups[6] << 16) | groups[7]) >>> 0;
  const v4String = [24, 16, 8, 0].map((shift) => (embeddedV4 >>> shift) & 0xff).join('.');

  // ::ffff:0:0/96 (v4-mapped) and 64:ff9b::/96 (NAT64): the verdict is the
  // embedded v4 address's.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return isForbiddenIpv4(v4String);
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return isForbiddenIpv4(v4String);
  }

  if (groups.every((g) => g === 0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true; // doc range
  return false;
}

/** Any private/reserved/metadata address, v4 or v6. Unparseable = forbidden. */
export function isForbiddenIp(ip: string): boolean {
  return ip.includes(':') ? isForbiddenIpv6(ip) : isForbiddenIpv4(ip);
}

type DnsLookupFn = typeof nodeDnsLookup;

interface ResolvedIp {
  address: string;
  family: number;
}

/**
 * A node `lookup` replacement that refuses when ANY resolved address is
 * forbidden (a mixed public+private answer is an attack shape, not a
 * mistake to route around). Injectable dns for unit tests. Passing this to
 * https.request pins validation to the exact addresses the socket connects
 * to — the property that makes rebinding pointless.
 */
export function makeGuardedLookup(dnsLookup: DnsLookupFn = nodeDnsLookup) {
  return function guardedLookup(
    hostname: string,
    options: { all?: boolean },
    callback: (err: NodeJS.ErrnoException | null, ...args: unknown[]) => void
  ): void {
    dnsLookup(hostname, { all: true, family: 0 }, (err, resolved) => {
      if (err) return callback(err);
      const ips = resolved as unknown as ResolvedIp[];
      if (!Array.isArray(ips) || ips.length === 0 || ips.some((ip) => isForbiddenIp(ip.address))) {
        return callback(Object.assign(new Error('forbidden_address'), { code: 'EFORBIDDEN' }));
      }
      if (options && options.all) return callback(null, ips);
      callback(null, ips[0].address, ips[0].family);
    });
  };
}

export interface FetchGuardedOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  /** Response content-type must start with one of these. */
  contentTypes: string[];
  /** Test seam for the DNS layer only — the transport is always node:https. */
  dnsLookup?: DnsLookupFn;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * GET a guarded https URL (page or stylesheet), following ≤ maxRedirects
 * with a full re-guard per hop. Resolves { ok: false } on any refusal,
 * error, or timeout — never throws, never logs, never echoes the URL.
 */
export function fetchGuarded(
  urlString: string,
  opts: FetchGuardedOptions
): Promise<{ ok: true; text: string; finalUrl: URL } | { ok: false }> {
  const lookup = makeGuardedLookup(opts.dnsLookup);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), opts.timeoutMs);

  const attempt = (
    target: URL,
    redirectsLeft: number,
    resolve: (r: { ok: true; text: string; finalUrl: URL } | { ok: false }) => void
  ): void => {
    if (target.protocol !== 'https:' || (target.port && target.port !== '443')) {
      return resolve({ ok: false });
    }
    if (target.username || target.password || !hostnameAllowed(target.hostname)) {
      return resolve({ ok: false });
    }

    const req = httpsRequest(
      target,
      {
        method: 'GET',
        // Guarded resolution is the SSRF property — see module header.
        lookup: lookup as never,
        signal: controller.signal,
        headers: {
          'user-agent': BRAND_FETCH_UA,
          accept: opts.contentTypes.join(', ') + ', */*;q=0.5',
          'accept-encoding': 'identity',
          'accept-language': 'en, *;q=0.5',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;

        if (REDIRECT_STATUSES.has(status)) {
          res.resume(); // drain, we only need the header
          const location = res.headers.location;
          if (!location || redirectsLeft <= 0) return resolve({ ok: false });
          let next: URL;
          try {
            next = new URL(location, target);
          } catch {
            return resolve({ ok: false });
          }
          return attempt(next, redirectsLeft - 1, resolve);
        }

        if (status !== 200) {
          res.resume();
          return resolve({ ok: false });
        }
        const contentType = (res.headers['content-type'] ?? '').toLowerCase();
        if (!opts.contentTypes.some((allowed) => contentType.startsWith(allowed))) {
          res.resume();
          return resolve({ ok: false });
        }

        const chunks: Buffer[] = [];
        let received = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          const text = new TextDecoder('utf-8', { fatal: false }).decode(
            Buffer.concat(chunks, Math.min(received, opts.maxBytes))
          );
          resolve({ ok: true, text, finalUrl: target });
        };

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          chunks.push(chunk);
          if (received >= opts.maxBytes) {
            // Truncation is success: extract from what arrived.
            res.destroy();
            finish();
          }
        });
        res.on('end', finish);
        // Mid-body error: partial content is a truncated success; an error
        // before any byte is a plain failure.
        res.on('error', () => (received > 0 ? finish() : resolve({ ok: false })));
      }
    );

    req.on('error', () => resolve({ ok: false }));
    req.end();
  };

  return new Promise((resolve) => {
    let done = false;
    attempt(new URL(urlString), opts.maxRedirects, (result) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      resolve(result);
    });
  }).then(
    (result) => result as { ok: true; text: string; finalUrl: URL } | { ok: false },
    () => ({ ok: false }) as const
  );
}

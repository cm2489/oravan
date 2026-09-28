/*
 * In-process mock of the Upstash Redis REST surface, shared by the S11 unit
 * specs. Implements exactly the command subset lib/upstash.ts's callers use
 * (GET / SET [NX] [EX|EXAT] / INCR / EXPIRE / TTL / DEL / MGET, the last added
 * S20 for lib/impressions.ts's readImpressionsWindow; SCAN added S21 for
 * lib/tenancy.ts's listTenantIds/listTenants; PFADD / PFCOUNT / EXPIREAT
 * added 2026-09-25 for lib/ratelimit.ts's daily distinct-address sketch) over a Map, and
 * installs itself by swapping globalThis.fetch — the repo's established
 * mocking pattern (tests/embed-portrait.unit.spec.ts). No live tokens exist
 * anywhere in the test environment, by design.
 *
 * Every command is recorded (`commands`) so privacy specs can assert over
 * everything that WOULD have crossed the wire, not just what got stored.
 */

/** Redis glob (only `*` is used by any caller in this repo) -> RegExp. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

type Entry = { value: string; expiresAt: number | null };

export class MockUpstash {
  store = new Map<string, Entry>();
  /**
   * HyperLogLog stand-in (PFADD/PFCOUNT, added 2026-09-25 for the daily
   * distinct-address sketch in lib/ratelimit.ts). A real sketch keeps only
   * register maxima; this mock keeps the exact element set, in a side table
   * the store entry points at, so specs can assert WHAT was added. Its store
   * entry's value is the fixed marker HLL_MARKER — never an element — and
   * its TTL lives on that entry, so expiry behaves like every other key.
   */
  hll = new Map<string, Set<string>>();
  commands: string[][] = [];
  /** When set, every request answers with this HTTP status (error path). */
  failWithStatus: number | null = null;
  /** When true, every request throws (network-failure path). */
  failWithNetworkError = false;
  /**
   * When set, ONLY the call at this 1-indexed attempt number fails (a
   * generic 500) — every other call, before or after, behaves normally.
   * Simulates a single transient blip in the middle of a multi-call
   * request (e.g. an idempotency claim that succeeds followed by a
   * processing write that doesn't), which failWithStatus/
   * failWithNetworkError can't express since both fail every call from the
   * start. Unset (null, default): no effect on any existing test.
   */
  failOnCallNumber: number | null = null;
  /** Total calls attempted against this mock (successful or failed). */
  callsAttempted = 0;

  private live(key: string): Entry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      this.hll.delete(key);
      return undefined;
    }
    return entry;
  }

  exec(command: string[]): unknown {
    this.commands.push(command);
    const [op, ...args] = command;
    switch (op) {
      case 'GET':
        return this.live(args[0])?.value ?? null;
      case 'MGET':
        return args.map((key) => this.live(key)?.value ?? null);
      case 'SET': {
        const [key, value, ...flags] = args;
        const nx = flags.includes('NX');
        const exIdx = flags.indexOf('EX');
        const ttlSec = exIdx >= 0 ? Number(flags[exIdx + 1]) : null;
        // EXAT (absolute unix seconds), added 2026-09-27 for the distinct-
        // address sketch's day salt. A deadline already past leaves a key
        // that is dead on its next read, the way an expired key behaves.
        const exatIdx = flags.indexOf('EXAT');
        const exatMs = exatIdx >= 0 ? Number(flags[exatIdx + 1]) * 1000 : null;
        if (nx && this.live(key)) return null;
        this.store.set(key, {
          value,
          expiresAt: exatMs !== null ? exatMs : ttlSec !== null ? Date.now() + ttlSec * 1000 : null,
        });
        return 'OK';
      }
      case 'INCR': {
        const key = args[0];
        const entry = this.live(key);
        const next = entry ? Number(entry.value) + 1 : 1;
        // Redis semantics: INCR on a missing key creates it WITHOUT a TTL.
        this.store.set(key, {
          value: String(next),
          expiresAt: entry ? entry.expiresAt : null,
        });
        return next;
      }
      case 'EXPIRE': {
        const entry = this.live(args[0]);
        if (!entry) return 0;
        entry.expiresAt = Date.now() + Number(args[1]) * 1000;
        return 1;
      }
      case 'EXPIREAT': {
        // Absolute unix seconds. Redis semantics: a deadline already in the
        // past deletes the key.
        const entry = this.live(args[0]);
        if (!entry) return 0;
        entry.expiresAt = Number(args[1]) * 1000;
        this.live(args[0]); // drops the key now if the deadline has passed
        return 1;
      }
      case 'PFADD': {
        // Redis semantics: creates the key WITHOUT a TTL; answers 1 when the
        // sketch changed (always on creation), else 0. The mock's exact set
        // makes "changed" mean "a new element", which is the upper bound of
        // what a real sketch reports.
        const [key, ...elements] = args;
        const existing = this.live(key);
        if (existing && existing.value !== MockUpstash.HLL_MARKER) {
          throw new Error('MockUpstash: WRONGTYPE Key is not a valid HyperLogLog string value');
        }
        let changed = 0;
        if (!existing) {
          this.store.set(key, { value: MockUpstash.HLL_MARKER, expiresAt: null });
          this.hll.set(key, new Set());
          changed = 1;
        }
        const set = this.hll.get(key)!;
        for (const element of elements) {
          if (!set.has(element)) {
            set.add(element);
            changed = 1;
          }
        }
        return changed;
      }
      case 'PFCOUNT': {
        const union = new Set<string>();
        for (const key of args) {
          if (!this.live(key)) continue;
          for (const element of this.hll.get(key) ?? []) union.add(element);
        }
        return union.size;
      }
      case 'TTL': {
        const entry = this.live(args[0]);
        if (!entry) return -2;
        if (entry.expiresAt === null) return -1;
        return Math.ceil((entry.expiresAt - Date.now()) / 1000);
      }
      case 'DEL':
        return this.live(args[0]) ? (this.store.delete(args[0]), this.hll.delete(args[0]), 1) : 0;
      case 'SCAN': {
        // Single-page mock: real Upstash paginates via a numeric cursor and
        // a COUNT hint; this mock ignores COUNT and always exhausts in one
        // call (cursor '0' in, '0' out), which is sufficient to exercise
        // lib/tenancy.ts's scanTenantIds bounded-loop contract (it only
        // requires "eventually returns cursor '0'", never "returns exactly
        // one page's worth"). [cursor, MATCH, pattern, ...ignored] — COUNT
        // and its value, if present, are accepted and ignored.
        const matchIdx = args.indexOf('MATCH');
        const pattern = matchIdx >= 0 ? args[matchIdx + 1] : '*';
        const re = globToRegExp(pattern);
        const liveKeys = [...this.store.keys()].filter((k) => this.live(k) !== undefined);
        return ['0', liveKeys.filter((k) => re.test(k))];
      }
      default:
        throw new Error(`MockUpstash: unimplemented command ${op}`);
    }
  }

  keys(): string[] {
    return [...this.store.keys()];
  }

  /** The store value every HyperLogLog key carries in this mock. */
  static readonly HLL_MARKER = '<hll>';
}

export const COUNTERS_URL = 'https://counters.mock.test';
export const CACHE_URL = 'https://cache.mock.test';
export const TENANCY_URL = 'https://tenancy.mock.test';

/**
 * Swap globalThis.fetch for one that serves the given mocks by URL prefix
 * and hands anything else to `passthrough` (default: reject loudly, so a
 * test can never silently hit the network). Returns a restore function.
 */
export function installUpstashFetch(
  mocks: Record<string, MockUpstash>,
  passthrough?: (url: string, init?: RequestInit) => Promise<Response>
): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [base, mock] of Object.entries(mocks)) {
      if (!url.startsWith(base)) continue;
      mock.callsAttempted += 1;
      if (mock.failWithNetworkError) throw new TypeError('mock network failure');
      if (mock.failWithStatus !== null) {
        return new Response('mock upstream error', { status: mock.failWithStatus });
      }
      if (mock.callsAttempted === mock.failOnCallNumber) {
        return new Response('mock upstream error (induced single-call failure)', { status: 500 });
      }
      const command = JSON.parse(String(init?.body)) as string[];
      return new Response(JSON.stringify({ result: mock.exec(command) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (passthrough) return passthrough(url, init);
    throw new Error(`unexpected fetch in unit test: ${url.split('?')[0]}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

/** Set all three databases' env vars at the mock URLs; returns a cleanup fn. */
export function setUpstashEnv(): () => void {
  process.env.UPSTASH_COUNTERS_REST_URL = COUNTERS_URL;
  process.env.UPSTASH_COUNTERS_REST_TOKEN = 'test-counters-token';
  process.env.UPSTASH_CACHE_REST_URL = CACHE_URL;
  process.env.UPSTASH_CACHE_REST_TOKEN = 'test-cache-token';
  process.env.UPSTASH_TENANCY_REST_URL = TENANCY_URL;
  process.env.UPSTASH_TENANCY_REST_TOKEN = 'test-tenancy-token';
  return () => {
    delete process.env.UPSTASH_COUNTERS_REST_URL;
    delete process.env.UPSTASH_COUNTERS_REST_TOKEN;
    delete process.env.UPSTASH_CACHE_REST_URL;
    delete process.env.UPSTASH_CACHE_REST_TOKEN;
    delete process.env.UPSTASH_TENANCY_REST_URL;
    delete process.env.UPSTASH_TENANCY_REST_TOKEN;
  };
}

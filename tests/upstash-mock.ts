/*
 * In-process mock of the Upstash Redis REST surface, shared by the S11 unit
 * specs. Implements exactly the command subset lib/upstash.ts's callers use
 * (GET / SET [NX] [EX] / INCR / EXPIRE / TTL / DEL) over a Map, and installs
 * itself by swapping globalThis.fetch — the repo's established mocking
 * pattern (tests/feedback.unit.spec.ts). No live tokens exist anywhere in
 * the test environment, by design.
 *
 * Every command is recorded (`commands`) so privacy specs can assert over
 * everything that WOULD have crossed the wire, not just what got stored.
 */

type Entry = { value: string; expiresAt: number | null };

export class MockUpstash {
  store = new Map<string, Entry>();
  commands: string[][] = [];
  /** When set, every request answers with this HTTP status (error path). */
  failWithStatus: number | null = null;
  /** When true, every request throws (network-failure path). */
  failWithNetworkError = false;

  private live(key: string): Entry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
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
      case 'SET': {
        const [key, value, ...flags] = args;
        const nx = flags.includes('NX');
        const exIdx = flags.indexOf('EX');
        const ttlSec = exIdx >= 0 ? Number(flags[exIdx + 1]) : null;
        if (nx && this.live(key)) return null;
        this.store.set(key, {
          value,
          expiresAt: ttlSec !== null ? Date.now() + ttlSec * 1000 : null,
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
      case 'TTL': {
        const entry = this.live(args[0]);
        if (!entry) return -2;
        if (entry.expiresAt === null) return -1;
        return Math.ceil((entry.expiresAt - Date.now()) / 1000);
      }
      case 'DEL':
        return this.live(args[0]) ? (this.store.delete(args[0]), 1) : 0;
      default:
        throw new Error(`MockUpstash: unimplemented command ${op}`);
    }
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
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
      if (mock.failWithNetworkError) throw new TypeError('mock network failure');
      if (mock.failWithStatus !== null) {
        return new Response('mock upstream error', { status: mock.failWithStatus });
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

/**
 * Per-instance in-memory LRU for /api/brand results (brand-preview build).
 *
 * Deliberately NOT Upstash, and deliberately not the scriptcache pattern:
 * the privacy copy on /embeds says the submitted address is never stored,
 * and this keeps that literally true — nothing about a preview ever touches
 * a database. The cache exists so a double-click or a tweak-and-retry on
 * the same org doesn't spend a second fetch + Anthropic call; Vercel's
 * Fluid instance reuse makes hits real. A miss after instance recycling
 * just costs one more generation.
 *
 * Values are only ever the final validated response JSON — never fetched
 * HTML, never the raw URL (keys are origins, which the caller already
 * truncated to at parse time).
 */
export function createLruCache<T>(opts: { max: number; ttlMs: number; now?: () => number }): {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
} {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { value: T; expiresAt: number }>();

  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (hit.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      // Map iteration order is insertion order — re-inserting marks recency,
      // so eviction below is least-recently-USED, not least-recently-set.
      entries.delete(key);
      entries.set(key, hit);
      return hit.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + opts.ttlMs });
      if (entries.size > opts.max) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
  };
}

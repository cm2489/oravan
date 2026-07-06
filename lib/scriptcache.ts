import { createHash } from 'node:crypto';
import { cacheClient, keyPrefix, noteUpstashError } from './upstash';

/*
 * Content-keyed script cache, durable across instances (S11). This module is
 * the ONLY place cache-database keys are built — it is the registry
 * scripts/check-key-namespaces.mjs gates on.
 *
 * Key registry — the only shape ever written to the cache database:
 *
 *   <env>:script:<slug>:<stance>:<lang>:<version>
 *
 * version = first 12 hex chars of sha256(bill.ai_summary). The pre-S11 key
 * (slug:stance:lang) had no content component, so a corrected decode would
 * keep serving the stale script — the exact gap strategy §9.1(d) names. A
 * changed summary now changes the version, which is a clean miss.
 *
 * TTL: 24 hours. The nightly sync is the only thing that changes a bill's
 * summary or status, so a cached script never outlives the corpus day it
 * was generated from (the plan's "TTL ≤ 24h" rule — the version hash catches
 * summary corrections, the TTL catches everything else, e.g. status moves
 * that reword the citation line's context). Both guards are deliberate.
 *
 * Nothing caller-derived — IPs, caller hashes, addresses, the salt — may
 * ever appear in a cache key or value. Scripts are shared across all
 * visitors by design; that is what makes this database privacy-clean.
 *
 * GRACEFUL DEGRADATION: unconfigured → the same per-instance in-memory Map
 * the route shipped with; a failed Upstash request → treated as a miss (get)
 * or skipped (set), counted + logged status-only, never a hard failure.
 */

const SCRIPT_TTL_SECONDS = 24 * 60 * 60;
const MEMORY_CACHE_MAX_ENTRIES = 500;

export interface ScriptKeyParts {
  slug: string;
  stance: string;
  lang: 'en' | 'es';
  version: string;
}

/** Short content-version hash: a corrected decode invalidates stale scripts. */
export function contentVersion(summary: string): string {
  return createHash('sha256').update(summary).digest('hex').slice(0, 12);
}

// --- cache-database key builder (the whole registry) -------------------------

export function scriptKey(parts: ScriptKeyParts): string {
  return `${keyPrefix()}:script:${parts.slug}:${parts.stance}:${parts.lang}:${parts.version}`;
}

// --- the cache ----------------------------------------------------------------

export interface ScriptCache {
  get(parts: ScriptKeyParts): Promise<string | null>;
  /** Never throws — a cache write failure must not fail the response. */
  set(parts: ScriptKeyParts, script: string): Promise<void>;
}

let fallbackLogged = false;

/** Test seam only — mirrors lib/ratelimit.ts's single-startup-line seam. */
export function __resetCacheFallbackLogForTests(): void {
  fallbackLogged = false;
}

function logFallbackOnce(): void {
  if (fallbackLogged) return;
  fallbackLogged = true;
  console.log(
    'script-cache: cache database not configured (env absent) — using per-instance in-memory cache (expected in local dev, CI, and previews without env)'
  );
}

export function createScriptCache(): ScriptCache {
  // In-memory fallback (and per-request fail-open target): same semantics
  // the route shipped with, now with the versioned key and a bounded size.
  const memory = new Map<string, string>();

  function memoryGet(key: string): string | null {
    return memory.get(key) ?? null;
  }
  function memorySet(key: string, script: string): void {
    if (memory.size >= MEMORY_CACHE_MAX_ENTRIES) memory.clear(); // crude memory cap
    memory.set(key, script);
  }

  return {
    async get(parts: ScriptKeyParts): Promise<string | null> {
      const key = scriptKey(parts);
      // Resolved per call, not captured at construction — same reasoning as
      // lib/ratelimit.ts: route modules build this at import time.
      const client = cacheClient();
      if (!client) {
        logFallbackOnce();
        return memoryGet(key);
      }
      try {
        const value = await client.cmd(['GET', key]);
        return typeof value === 'string' ? value : null;
      } catch (err) {
        noteUpstashError('cache', err);
        return memoryGet(key); // fail open: a miss, or this instance's copy
      }
    },

    async set(parts: ScriptKeyParts, script: string): Promise<void> {
      const key = scriptKey(parts);
      memorySet(key, script); // always keep the warm-instance copy
      const client = cacheClient();
      if (!client) {
        logFallbackOnce();
        return;
      }
      try {
        await client.cmd(['SET', key, script, 'EX', String(SCRIPT_TTL_SECONDS)]);
      } catch (err) {
        noteUpstashError('cache', err); // never fails the response
      }
    },
  };
}

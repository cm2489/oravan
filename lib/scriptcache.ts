import { createHash } from 'node:crypto';
// TYPE-ONLY, and it must stay type-only: lib/core/nominations.ts imports
// data/nominations.json (~520 KB) at module scope. `import type` is erased at
// compile time, so this module still pulls zero bytes of that corpus — the
// same constraint lib/nomination-script.ts's header names.
import type { Nomination } from './core/nominations';
import { NOMINATION_PROMPT_VERSION } from './nomination-script';
import { PROMPT_VERSION } from './scriptprompt';
// TYPE-ONLY import — erased at compile time, so this module still pulls zero
// bytes of the corpus (the constraint lib/nomination-script.ts's header names).
import type { Bill } from './types';
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
 * ONE key shape, both vehicle kinds. A Senate nomination's script is cached
 * under the identical five segments (slug = `pn-…`); everything specific to a
 * nomination — including WHICH AUDIENCE the script was written for — lives
 * inside `version`, via nominationContentVersion() below. See its doc comment
 * for why that is deliberate rather than a shortcut.
 *
 * version = first 12 hex chars of sha256 over EVERY substantive input to the
 * generated prompt: PROMPT_VERSION + the summary + the status + the
 * last-action date (see contentVersion below for why each one is in there).
 * The pre-S11 key (slug:stance:lang) had no content component, so a corrected
 * decode would keep serving the stale script — the exact gap strategy §9.1(d)
 * names. A changed summary now changes the version, which is a clean miss; the
 * folded-in PROMPT_VERSION (lib/scriptprompt.ts) does the same for a prompt
 * change, which the summary alone would miss.
 *
 * TTL: 24 hours — a backstop, NOT the status guard. It was described as the
 * latter until 2026-08-08: the header used to say the version hash caught
 * summary corrections and "the TTL catches everything else, e.g. status
 * moves". It did not. A bill that moved from floor_vote to passed_chamber
 * kept its version hash (status was not key material, and ai_summary is only
 * rewritten on a fresh decode, never for an already-decoded bill), so every
 * visitor for the rest of the 24h window was handed a pre-vote script urging
 * a vote that had already happened — while the redeployed site said "Passed
 * the House" beside it. Status and last_action_date are key material now, so
 * the status move is a clean miss the moment the corpus lands.
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

/**
 * Length-prefixed join, so the hash input is unambiguous: concatenating
 * ('a','bc') and ('ab','c') must not produce the same key material. A bare
 * separator character can't promise that — any separator can itself appear
 * inside a decoded summary — but `2:ab|1:c` and `1:a|2:bc` can never collide,
 * whatever the parts contain.
 *
 * `null` gets its own marker rather than folding to '': a bill with no recorded
 * last action and a bill whose date came back empty are different facts, and a
 * `?? ''` fold would quietly key them the same. `~` can never be produced by
 * the length-prefixed branch, which always starts with a digit.
 */
function keyMaterial(parts: Array<string | null>): string {
  return parts.map((part) => (part === null ? '~' : `${part.length}:${part}`)).join('|');
}

/**
 * Short content-version hash: a corrected decode, a status move, OR a changed
 * generation prompt invalidates stale scripts.
 *
 * It takes the BILL rather than a pre-extracted string on purpose. Every input
 * the prompt actually reads has to be in here, and the one way to guarantee the
 * live route and the nightly warmer agree on that set is to give them one
 * function that pulls the fields itself — with the `?? title` fallback inside
 * it, not duplicated at each call site. A caller that passes different key
 * material than the route does would not fail; it would silently write entries
 * the route can never read.
 *
 * What's folded in, and why each one has to be:
 *   PROMPT_VERSION   — a prompt edit (lib/scriptprompt.ts) is a clean miss for
 *                      every (bill, stance, locale); the summary can't catch it
 *                      because editing the prompt never touches the summary.
 *   summary          — the §9.1(d) gap: a corrected decode must not keep
 *                      serving the script written from the wrong summary.
 *   status           — buildScriptPrompt writes `Current status: ${status}`
 *                      into the prompt. A bill that passes its chamber keeps
 *                      its summary (only a fresh decode rewrites that), so
 *                      without this the cache serves a pre-vote script for the
 *                      rest of the TTL, urging a vote that already happened.
 *   last_action_date — moves with status and dates the record the script is
 *                      grounded in; keyed for the same reason, so a re-dated
 *                      action can't be papered over by an unchanged status.
 */
export function contentVersion(
  bill: Pick<Bill, 'title' | 'ai_summary' | 'status' | 'last_action_date'>
): string {
  return createHash('sha256')
    .update(
      keyMaterial([PROMPT_VERSION, bill.ai_summary ?? bill.title, bill.status, bill.last_action_date])
    )
    .digest('hex')
    .slice(0, 12);
}

/**
 * The same hash for a SENATE NOMINATION — and the reason the audience goes
 * INSIDE it rather than beside it in the key.
 *
 * A nomination script has one axis a bill script does not: who it is being
 * read to (lib/nomination-script.ts NOMINATION_AUDIENCES — the senator who
 * votes, or the representative who does not). Two different scripts therefore
 * exist for the same (slug, stance, lang), and the cache must not serve one
 * for the other.
 *
 * The obvious fix — a sixth key segment — is the wrong one. The key shape
 * above IS the registry scripts/check-key-namespaces.mjs gates on, and it has
 * a pinned fixture asserting exactly five segments; growing it for a case the
 * bill path will never use would make every future reader of that gate ask
 * which shape is current. Folding the audience into the version hash keeps
 * ONE key shape for both kinds, and makes a collision structurally impossible
 * rather than merely unlikely.
 *
 * NOMINATION_PROMPT_VERSION is folded in for the same reason PROMPT_VERSION is
 * above, and it is a SEPARATE lineage: editing the bill prompt must not
 * invalidate every nomination script, or vice versa.
 *
 * IT SHARES keyMaterial() WITH contentVersion ABOVE, and that reverses a note
 * this comment briefly carried. The earlier version said the nomination hash
 * "deliberately keeps its plain `\n` join", on the grounds that two of its
 * three parts were a single digit and a fixed NOMINATION_AUDIENCES member, so
 * an ambiguous split was structurally impossible. That was true of the three
 * parts it hashed then. It is not true of the six it hashes now: the
 * description sentence, the receiving body and the Senate's own action text
 * are all free text and all adjacent, so ('ab','c') vs ('a','bc') is a real
 * collision shape rather than a theoretical one. The length prefix is the
 * cheap fix, and it is applied in the same change that made it necessary.
 *
 * ── WHAT IS IN THE HASH, AND WHY IT IS THE WHOLE RECORD (2026-08-09) ───────
 * It took `record: string` — Congress.gov's description sentence — and its
 * comment called that "the only substantive input to the prompt". That was
 * not true of the prompt it is supposed to track.
 * lib/nomination-script.ts's buildNominationScriptPrompt also interpolates
 * the receiving body, the status, and the Senate's own last recorded action:
 *
 *     Receiving body: ${nomination.organization}
 *     Where it stands: ${nomination.status}
 *     The Senate's own last recorded action: ${nomination.last_action_text}
 *
 * A nomination's DESCRIPTION never changes — it is one frozen sentence about
 * a person and a post — while its status moves the whole way from `received`
 * to `confirmed`. So the one field being hashed was the one field that never
 * moves, and every field that does move was invisible to the key: a
 * nomination that reached the Executive Calendar, or was confirmed outright,
 * kept serving the script written when it was still sitting in committee, for
 * the rest of the 24-hour TTL, while the redeployed page beside it said
 * otherwise. The TTL was the only thing that ever cleared it.
 *
 * It now takes the NOMINATION rather than a pre-extracted string, for the
 * reason contentVersion above does: the one way to guarantee every caller
 * agrees on the key material is to give them one function that pulls the
 * fields itself. A caller passing different material would not fail — it
 * would silently write entries the route can never read.
 *
 * `citation` is deliberately NOT hashed even though the prompt interpolates
 * it twice: it is derivable one-to-one from the slug, and the slug is already
 * its own segment of the cache key (scriptKey below). Hashing it would add no
 * discrimination the key does not already have.
 *
 * @param nomination the stored record — the fields below are read from it.
 * @param audience   one of NOMINATION_AUDIENCES.
 */
export function nominationContentVersion(
  nomination: Pick<
    Nomination,
    'nominee_description' | 'organization' | 'status' | 'last_action_text'
  >,
  audience: string
): string {
  return createHash('sha256')
    .update(
      keyMaterial([
        NOMINATION_PROMPT_VERSION,
        audience,
        nomination.nominee_description,
        nomination.organization,
        nomination.status,
        nomination.last_action_text,
      ])
    )
    .digest('hex')
    .slice(0, 12);
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

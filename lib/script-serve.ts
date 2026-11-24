import type { StanceSetCache, StanceSetParts } from './scriptcache';
import { STANCES } from './scriptprompt';
import type { Stance } from './types';

/*
 * THE STANCE-BLIND SCRIPT PATH (owner's pick, 2026-11-24, "Option 1").
 *
 * The gap it closes. /api/script sends Upstash, milliseconds apart, a
 * rate-limit count keyed on the caller's salted hash (counters database, whose
 * day salt also lives there) and a cache read for the bill. Until this change
 * that read named the caller's STANCE (`script:<slug>:<stance>:…`), and one
 * company runs both databases, so the provider could have paired a caller with
 * a political position by timing. The privacy page says a stance is "not
 * linked to any identity"; this module is what keeps that true of the
 * provider too.
 *
 * THE RULE: nothing this module sends to Upstash (either database) or to
 * Anthropic may depend on which stance the caller picked. It may depend only
 * on (a) what the cache already held for the bill and (b) which drafts came
 * back. The caller's pick is used once, in server memory, to choose which
 * script goes back in the response — which only Vercel and the caller see,
 * and Vercel already sees the stance in the request body (privacy page,
 * servicesVercel).
 *
 * What that means, step by step:
 *
 *   1. READ. One MGET of every stance's key, in STANCES order
 *      (cache.getStances). Same bytes for every caller of this bill.
 *
 *   2. NOTHING MISSING. Serve the caller's script. Count one script served.
 *
 *   3. SOMETHING MISSING — whichever stance it is, the caller's or another —
 *      draft EVERY missing stance, at once:
 *        a. the daily spend breaker takes ONE unit PER missing stance (a cold
 *           bill is up to three generations now, and each one is a real
 *           Anthropic spend the cap must see). ALL OR NOTHING: if any unit is
 *           refused, nothing is drafted. Drafting "what fits" would either
 *           have to favour the caller's stance (which the write would then
 *           reveal) or could spend money and still answer this caller 429.
 *           At the edge of the day this wastes up to two units of a cap that
 *           is about to close anyway; that is the cheaper error.
 *        b. one Anthropic request per missing stance, all started together,
 *           in STANCES order (Promise.allSettled). Each prompt carries one
 *           stance; the SET of prompts is the bill's missing stances, so
 *           Anthropic cannot tell which one this caller wanted.
 *        c. one write (cache.setStances) of whatever came back, in STANCES
 *           order. PARTIAL FAILURE (say 2 of 3 drafts fail): the one that
 *           succeeded is stored and the others are not. That reveals which
 *           draft succeeded — a fact about Anthropic, not about the caller —
 *           and the next request drafts the rest. Not storing it (all or
 *           nothing) would buy no privacy and throw away a paid draft.
 *        d. the caller gets their script if it is now available — already
 *           cached, or just drafted — else 502 (drafts failed) or 429 (the
 *           breaker said no).
 *      The fill STARTS as soon as the read says something is missing, before
 *      the code even looks at whether the caller's own script was among what
 *      came back. Only then is the caller's script picked: if it was cached,
 *      the response goes out at once while the fill carries on (`defer`,
 *      next/server's after() in the route, only keeps it alive); if not, the
 *      response waits for the fill. Either way the breaker units, the model
 *      requests, the write and the counts below leave in the same order, at
 *      times that do not depend on the stance, because none of them waits
 *      on the response
 *      (tests/script-stance-blind.unit.spec.ts pins the order, with a
 *      response that is never sent). What the caller's pick changes is only
 *      when THEIR answer leaves, which Upstash and Anthropic do not see.
 *
 *   4. COUNTS (counters database, lib/usage.ts), also stance-blind, chained
 *      onto the fill itself, never onto the response:
 *        - `generated`: one per draft that came back (an actual spend), as
 *          before — by the request that started the fill only, so a request
 *          that joined it (step 5) does not count the same spend twice.
 *        - `refusedDaily`: once whenever the breaker refused a fill, even when
 *          this caller's own script was cached and they got it. Counting it
 *          only for callers who were refused would tell the counters database
 *          whether this caller's stance was the cached one.
 *        - `served` (the people count, owner card `people`, 2026-11-23): once
 *          when the request ends with EVERY stance of the bill available —
 *          nothing was missing, or every missing draft came back. When a fill
 *          was refused, any draft failed, or no fill ran (step 5), it is not
 *          counted, even for a caller who did get a script: whether a caller
 *          got one then depends on their stance, and a count that ticked only
 *          for them would say which. So the served count is a FLOOR: it can
 *          come out low on a day with failed or held-back drafts; it never
 *          counts a script that was not served.
 *
 *   5. WHAT BOUNDS THE SPEND (first check of #554, 2026-11-24). Because a
 *      caller whose script is cached still starts the fill of the rest, cache
 *      hits on a half-warm bill can spend. Three per-instance limits keep that
 *      from draining the day's cap, all keyed by the bill set (slug, language,
 *      version), never by stance, and none of them sends anything anywhere
 *      (createFillCoordinator below):
 *        - ONE FILL PER BILL AT A TIME. A request that finds a fill of the
 *          same bill already running joins it and waits for the same result,
 *          so a burst on a cold bill drafts each stance once, not once per
 *          request.
 *        - A COOLDOWN after a fill in which any draft failed: for
 *          FILL_COOLDOWN_MS no new fill of that bill starts on this instance.
 *          A stance the model keeps refusing then costs one attempt per
 *          cooldown, not one per request. A caller whose script is missing
 *          meanwhile gets the 502 (the panel's template still works).
 *        - AT MOST MAX_FILLS_IN_FLIGHT bills filling at once on one instance.
 *          Past that, no fill starts, and a caller whose script is missing
 *          gets the 502.
 *      And the daily breaker (step 3a) still caps the day across instances.
 *
 * WHAT REMAINS VISIBLE (stated, not hidden):
 *   - The BILL. Upstash can pair the cache read (the bill) with the caller's
 *     rate-limit count (their salted hash, whose salt it also holds) by
 *     timing, as lib/upstash.ts says. That is the interest-level residual the
 *     privacy page discloses under Upstash; the stance is not part of it.
 *   - A RETRY. A caller whose script is missing after a failed or held-back
 *     fill gets a 502, and the panel offers Retry; the same salted hash asking
 *     about the same bill again seconds later hints that their stance was one
 *     of the missing ones. Rare (it needs a failed draft), and the reason the
 *     privacy page says nothing our server SENDS names the stance, rather than
 *     that the provider can never learn anything about it.
 */

export type ServeOutcome =
  | { kind: 'script'; script: string; cached: boolean }
  | { kind: 'daily-limited' }
  | { kind: 'generation-failed' };

export interface ServeDeps {
  cache: StanceSetCache;
  /**
   * Takes ONE unit of the global daily spend breaker; TRUE means refused
   * (at the ceiling, or the counters database could not be reached: the
   * breaker fails closed). Called once per stance about to be drafted.
   */
  takeGenerationUnit: () => Promise<boolean>;
  /** Drafts one stance's script. Rejects, or resolves '', on failure. */
  generate: (stance: Stance) => Promise<string>;
  /**
   * Keeps an already-running task alive past the response (next/server
   * after() in the route). Nothing passed here waits for the response to
   * START: the fill and its counts are running before it is called.
   */
  defer: (task: () => Promise<void>) => void;
  /** The content-free, caller-free day counts (lib/usage.ts). Never throw. */
  note: {
    served: () => Promise<void>;
    generated: () => Promise<void>;
    refusedDaily: () => Promise<void>;
  };
  /** One fill per bill at a time, the cooldown and the in-flight cap (step 5). */
  fills: FillCoordinator;
  /** Where a failed draft is reported (console.error in the route). */
  logFailure?: (err: unknown) => void;
}

export interface Fill {
  /** The breaker refused, so nothing was drafted. */
  refused: boolean;
  /** The drafts that came back, by stance. */
  drafted: Partial<Record<Stance, string>>;
  /** Every missing stance came back. */
  complete: boolean;
}

/* ------------------------------------------------------------------ *
 * Step 5: one fill per bill, a cooldown after a failed draft, a cap on
 * fills in flight. Per instance, in memory, keyed by the bill set.
 * ------------------------------------------------------------------ */

/** How long a bill waits for a new fill after one in which a draft failed. */
export const FILL_COOLDOWN_MS = 10 * 60 * 1000;
/** Bills one instance drafts at once (each up to three model requests). */
export const MAX_FILLS_IN_FLIGHT = 16;
/** Above this many remembered cooldowns, expired ones are swept. */
const COOLDOWN_SWEEP_AT = 500;

export type FillStart =
  /** This request started the fill, and counts its spend. */
  | { kind: 'started'; fill: Promise<Fill> }
  /** A fill of the same bill was already running; this request shares it. */
  | { kind: 'joined'; fill: Promise<Fill> }
  /** A recent fill of this bill had a failed draft; none starts yet. */
  | { kind: 'cooling' }
  /** MAX_FILLS_IN_FLIGHT bills are already filling on this instance. */
  | { kind: 'busy' };

export interface FillCoordinator {
  /**
   * Start `run` for this bill set, or join the one already running, or
   * decline (cooling, busy). `run` must never reject; if it does, the fill
   * is treated as every draft failing.
   */
  start(set: StanceSetParts, run: () => Promise<Fill>): FillStart;
  /** Forget every cooldown (a fill already running keeps running). For specs. */
  reset(): void;
}

const FAILED_FILL: Fill = { refused: false, drafted: {}, complete: false };

/** The bill set as a map key. In this process's memory only; never sent anywhere. */
function setKey(set: StanceSetParts): string {
  return JSON.stringify([set.slug, set.lang, set.version]);
}

export function createFillCoordinator(
  opts: { cooldownMs?: number; maxInFlight?: number; now?: () => number; onError?: (err: unknown) => void } = {}
): FillCoordinator {
  const cooldownMs = opts.cooldownMs ?? FILL_COOLDOWN_MS;
  const maxInFlight = opts.maxInFlight ?? MAX_FILLS_IN_FLIGHT;
  const now = opts.now ?? Date.now;
  const inFlight = new Map<string, Promise<Fill>>();
  const coolUntil = new Map<string, number>();

  function coolDown(key: string): void {
    coolUntil.delete(key); // re-insert, so iteration order stays oldest-first
    coolUntil.set(key, now() + cooldownMs);
    if (coolUntil.size <= COOLDOWN_SWEEP_AT) return;
    const t = now();
    for (const [k, until] of coolUntil) if (until <= t) coolUntil.delete(k);
    // Still too many live cooldowns: drop the oldest. Forgetting one only
    // lets that bill try again early; the daily breaker still applies.
    for (const k of coolUntil.keys()) {
      if (coolUntil.size <= COOLDOWN_SWEEP_AT) break;
      coolUntil.delete(k);
    }
  }

  return {
    start(set, run) {
      const key = setKey(set);
      const running = inFlight.get(key);
      if (running) return { kind: 'joined', fill: running };
      const until = coolUntil.get(key);
      if (until !== undefined) {
        if (now() < until) return { kind: 'cooling' };
        coolUntil.delete(key);
      }
      if (inFlight.size >= maxInFlight) return { kind: 'busy' };
      const fill = (async (): Promise<Fill> => {
        let result: Fill;
        try {
          result = await run();
        } catch (err) {
          opts.onError?.(err);
          result = FAILED_FILL;
        }
        // A refusal is not a failure: the breaker already bounds it, and it
        // spent nothing. Any failed draft starts the cooldown.
        if (!result.refused && !result.complete) coolDown(key);
        inFlight.delete(key);
        return result;
      })();
      inFlight.set(key, fill);
      return { kind: 'started', fill };
    },
    reset() {
      coolUntil.clear();
    },
  };
}

/**
 * The coordinator /api/script uses: one per instance, for the life of the
 * process. Here rather than in the route because a route module may export
 * only its handlers, and the specs that drive the real route must be able to
 * reset it between tests (a cooldown from one test would otherwise silence
 * the model in the next).
 */
export const routeFills: FillCoordinator = createFillCoordinator({
  onError: (err) => console.error('script fill failed', err),
});

/* ------------------------------------------------------------------ *
 * Steps 3 and 4.
 * ------------------------------------------------------------------ */

/** Draft every missing stance at once and store what came back, in one write. */
async function fillMissing(set: StanceSetParts, missing: Stance[], deps: ServeDeps): Promise<Fill> {
  const refusals = await Promise.all(missing.map(() => deps.takeGenerationUnit()));
  if (refusals.some(Boolean)) return { refused: true, drafted: {}, complete: false };

  // `async` so a generate() that throws before returning a promise still
  // lands in allSettled as that one draft failing (first check of #554, N6).
  const results = await Promise.allSettled(missing.map(async (stance) => deps.generate(stance)));
  const drafted: Partial<Record<Stance, string>> = {};
  results.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value) {
      drafted[missing[i]] = result.value;
    } else {
      deps.logFailure?.(result.status === 'rejected' ? result.reason : new Error('empty'));
    }
  });
  const count = Object.keys(drafted).length;
  if (count > 0) await deps.cache.setStances(set, drafted); // never throws
  return { refused: false, drafted, complete: count === missing.length };
}

/**
 * The day counts for one request, in a fixed order, from the fill alone.
 * `startedFill`: this request started the fill, so its drafts are its spend.
 */
async function recordCounts(fill: Fill | null, deps: ServeDeps, startedFill = false): Promise<void> {
  if (fill?.refused) await deps.note.refusedDaily();
  const generated = fill && startedFill ? Object.keys(fill.drafted).length : 0;
  for (let i = 0; i < generated; i += 1) await deps.note.generated();
  if (fill === null || fill.complete) await deps.note.served();
}

/**
 * Answer one script request without letting Upstash or Anthropic learn the
 * stance. `stance` is read only to pick the response.
 */
export async function serveStanceBlind(
  set: StanceSetParts,
  stance: Stance,
  deps: ServeDeps
): Promise<ServeOutcome> {
  const stored = await deps.cache.getStances(set);
  const missing = STANCES.filter((s) => !stored[s]);
  const own = stored[stance];

  if (missing.length === 0) {
    deps.defer(() => recordCounts(null, deps));
    return { kind: 'script', script: own as string, cached: true };
  }

  // Start (or join) the fill BEFORE branching on the caller's own script, and
  // chain the counts onto the fill, so nothing sent anywhere waits on the
  // response (step 3, first check of #554, B1).
  const start = deps.fills.start(set, () => fillMissing(set, missing, deps));
  const pending = start.kind === 'started' || start.kind === 'joined' ? start.fill : null;
  const counted = pending
    ?.then((f) => recordCounts(f, deps, start.kind === 'started'))
    .catch((err) => deps.logFailure?.(err));

  if (own) {
    // The answer leaves now; `defer` keeps the running fill and counts alive.
    if (counted) deps.defer(() => counted);
    return { kind: 'script', script: own, cached: true };
  }
  if (!pending || !counted) return { kind: 'generation-failed' }; // cooling or busy (step 5)
  const fill = await pending;
  // The counts are already running. Keep them alive past the answer when
  // there is something to count; when every draft failed there is nothing
  // (recordCounts writes nothing), so nothing is deferred — the same as the
  // 502 path before 2026-11-24. Either way nothing sent anywhere changes.
  if (fill.refused || Object.keys(fill.drafted).length > 0) deps.defer(() => counted);
  if (fill.refused) return { kind: 'daily-limited' };
  const script = fill.drafted[stance];
  if (!script) return { kind: 'generation-failed' };
  return { kind: 'script', script, cached: false };
}

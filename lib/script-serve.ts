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
 *      came back. So the breaker units, the model requests, the write and
 *      the counts below leave in the same order, at times that do not depend
 *      on the stance, because none of them waits on the response
 *      (tests/script-stance-blind.unit.spec.ts pins the order, with a
 *      response that is never sent).
 *      THE ANSWER WAITS FOR THE FILL, for every caller whose request started
 *      or joined one — the caller whose script was already cached included
 *      (fourth check of #554, B1; owner's answer r554 a, 2026-11-24). Upstash
 *      and Anthropic never see when an answer leaves, but they do see when
 *      the same caller asks next: if a cached caller were answered at once
 *      while a missing one waited seconds for the model, a quick next request
 *      (a second stance to compare, the House button on a nomination) would
 *      say the first answer had been a cached one, and so which stances it
 *      could have been. So every answer leaves at the same point whatever the
 *      stance: once the fill has ended (its drafts and its write) when a fill
 *      was started or joined — at once when the joined fill had already
 *      ended — and at once when none runs (cooling, busy; step 5). The
 *      caller's pick changes only WHICH answer leaves then: their script, or
 *      the 502 or 429 when theirs is one that could not be drafted (WHAT
 *      REMAINS VISIBLE). The cost: on a half-warm bill a caller whose script
 *      was cached waits for the drafts of the others. That is rare, since a
 *      bill's stances are normally drafted and written together.
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
 *          when the request ends with EVERY stance of the bill available, as
 *          THIS request's own read saw the bill: nothing was missing, or every
 *          stance it found missing came back in the fill it started or joined.
 *          (Judged against the request's own read, not the starter's, so a
 *          joiner that found a stance the starter did not — a key that
 *          expired mid-fill — is not counted when that stance stays missing;
 *          second check of #554, D3.) When a fill was refused, any of those
 *          drafts failed, or no fill ran (step 5), it is not counted, even for
 *          a caller who did get a script: whether a caller got one then
 *          depends on their stance, and a count that ticked only for them
 *          would say which. So the served count is a FLOOR: it can come out
 *          low on a day with failed or held-back drafts; it never counts a
 *          script that was not served.
 *
 *   5. WHAT BOUNDS THE SPEND (first check of #554, 2026-11-24). Because a
 *      caller whose script is cached still starts the fill of the rest, cache
 *      hits on a half-warm bill can spend. Three per-instance limits keep that
 *      from draining the day's cap, all keyed by the bill set (slug, language,
 *      version), never by stance, and none of them sends anything anywhere
 *      (createFillCoordinator below):
 *        - ONE FILL PER BILL AT A TIME. A request that finds a fill of the
 *          same bill already running joins it and waits for the same result.
 *          A finished fill stays joinable for RECENT_FILL_MS (5 seconds), so
 *          a request whose read was answered just before the fill's write
 *          landed, but which reaches the coordinator just after the fill
 *          ended, joins it instead of starting a second full fill (second
 *          check of #554, D4). So on one instance a burst on a cold bill
 *          drafts each stance once, not once per request. (A refused fill is
 *          not kept: it spent nothing, and the next request asks the breaker
 *          again.)
 *        - A COOLDOWN after a fill in which any draft failed (or the write
 *          of what came back did not reach the cache), backing off per
 *          bill: FILL_COOLDOWNS_MS, 1, 2, 4, then 10 minutes for each failed
 *          fill of that bill in a row, back to the start after a fill in
 *          which every draft came back and was stored (second check of #554,
 *          D5). Meanwhile
 *          no new fill of that bill starts on this instance, so a stance the
 *          model keeps refusing costs one attempt per cooldown, not one per
 *          request, while one transient failure darkens a bill for only a
 *          minute. A caller whose script that fill did not draft meanwhile
 *          gets the 502 (the panel's template still works). When the drafts
 *          came back but their WRITE failed, the fill stays joinable on this
 *          instance until its cooldown ends, not only RECENT_FILL_MS, so the
 *          callers of the stances it drafted are still served from it, with
 *          nothing more spent and nothing more sent than a joiner's read and
 *          counts (fourth check of #554, N1).
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
 *   - A RETRY. Whenever the scripts a request needs could not be drafted,
 *     the caller whose stance is missing gets an error and the caller whose
 *     stance is cached gets their script — at the same moment (step 3), but
 *     a different answer. Asking about the same bill again seconds later
 *     from the same salted hash then hints that their stance was one of the
 *     missing ones. It does not need a draft to fail in this request. The
 *     triggers:
 *       - a draft failed, and the cooldown that follows (step 5): a minute
 *         at first, up to ten minutes for a bill whose drafts keep failing,
 *         in which every caller on that instance whose stance that fill did
 *         not draft gets the 502 (a write that failed on its own no longer
 *         does this: the fill's drafts stay joinable for the cooldown);
 *       - the in-flight cap (step 5): MAX_FILLS_IN_FLIGHT bills already
 *         filling on this instance, so no fill starts, and the 502;
 *       - a stance key that expired during a fill this request joined
 *         (running, or finished less than RECENT_FILL_MS ago), so that fill
 *         never drafted it, and the 502;
 *       - the daily breaker refusing the fill (step 3a): a 429. The panel
 *         shows no Retry button for it, but pressing the same stance again
 *         sends a new request.
 *     So the answer is a 502 or a 429, and which one depends on the
 *     trigger, not on the stance; and when it leaves depends on neither.
 *     This is the only thing a caller's next request can hint at. Which is
 *     why the privacy page says that
 *     nothing our server SENDS names the stance and that a quick retry
 *     after a script could not be drafted can hint at it, rather than that
 *     the provider can never learn anything about it.
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
  /**
   * Every missing stance came back AND the write of them reached the cache
   * database. FALSE starts the bill's cooldown (step 5).
   */
  complete: boolean;
  /**
   * The write of `drafted` reached the cache database (TRUE when there was
   * nothing to write). FALSE keeps the fill joinable for its cooldown
   * (step 5, N1), since no other request can read those drafts.
   */
  stored: boolean;
}

/* ------------------------------------------------------------------ *
 * Step 5: one fill per bill, a cooldown after a failed draft or write, a cap on
 * fills in flight. Per instance, in memory, keyed by the bill set.
 * ------------------------------------------------------------------ */

/**
 * How long a bill waits for a new fill after one in which a draft (or the
 * cache write) failed:
 * the first entry after one failed fill, the next after a second in a row,
 * and so on, staying at the last. A fill in which every draft came back
 * and was stored starts the bill over at the first.
 */
export const FILL_COOLDOWNS_MS: readonly number[] = [1, 2, 4, 10].map((min) => min * 60 * 1000);
/** How long a finished fill stays joinable (step 5, D4). */
export const RECENT_FILL_MS = 5 * 1000;
/** Bills one instance drafts at once (each up to three model requests). */
export const MAX_FILLS_IN_FLIGHT = 16;
/** Above this many remembered cooldowns (or recent fills), the oldest are swept. */
const COOLDOWN_SWEEP_AT = 500;

export type FillStart =
  /** This request started the fill, and counts its spend. */
  | { kind: 'started'; fill: Promise<Fill> }
  /**
   * A fill of the same bill was already running, or finished less than
   * RECENT_FILL_MS ago; this request shares its result.
   */
  | { kind: 'joined'; fill: Promise<Fill> }
  /** A recent fill of this bill had a failed draft or write; none starts yet. */
  | { kind: 'cooling' }
  /** MAX_FILLS_IN_FLIGHT bills are already filling on this instance. */
  | { kind: 'busy' };

export interface FillCoordinator {
  /**
   * Start `run` for this bill set, or join the one already running (or
   * just finished), or decline (cooling, busy). `run` must never reject; if
   * it does, the fill
   * is treated as every draft failing.
   */
  start(set: StanceSetParts, run: () => Promise<Fill>): FillStart;
  /** Forget every cooldown and finished fill (a running fill keeps running). For specs. */
  reset(): void;
}

const FAILED_FILL: Fill = { refused: false, drafted: {}, complete: false, stored: true };

/** The bill set as a map key. In this process's memory only; never sent anywhere. */
function setKey(set: StanceSetParts): string {
  return JSON.stringify([set.slug, set.lang, set.version]);
}

export function createFillCoordinator(
  opts: {
    cooldownsMs?: readonly number[];
    recentMs?: number;
    maxInFlight?: number;
    now?: () => number;
    onError?: (err: unknown) => void;
  } = {}
): FillCoordinator {
  const cooldownsMs = opts.cooldownsMs ?? FILL_COOLDOWNS_MS;
  const recentMs = opts.recentMs ?? RECENT_FILL_MS;
  const maxInFlight = opts.maxInFlight ?? MAX_FILLS_IN_FLIGHT;
  const now = opts.now ?? Date.now;
  const inFlight = new Map<string, Promise<Fill>>();
  /** Fills that finished less than recentMs ago, oldest first. */
  const recent = new Map<string, { fill: Promise<Fill>; until: number }>();
  /** Per bill: when its cooldown ends, and how many failed fills in a row set it. */
  const cooling = new Map<string, { until: number; strikes: number }>();

  /** Drop entries past their time, then the oldest while over the bound. */
  function sweep<V extends { until: number }>(map: Map<string, V>, t: number, force: boolean): void {
    if (!force && map.size <= COOLDOWN_SWEEP_AT) return;
    for (const [k, v] of map) if (v.until <= t) map.delete(k);
    // Still too many live entries: drop the oldest. Forgetting a cooldown
    // (and its count of failures in a row) only lets that bill try again
    // early; forgetting a finished fill only lets a late request start a new
    // one, or, for a fill whose write failed and whose bill is still
    // cooling, gives its callers the 502 a cooling bill gives. The daily
    // breaker still applies to all of them.
    for (const k of map.keys()) {
      if (map.size <= COOLDOWN_SWEEP_AT) break;
      map.delete(k);
    }
  }

  /** Start (or lengthen) the bill's cooldown; returns when it ends. */
  function coolDown(key: string): number {
    const strikes = (cooling.get(key)?.strikes ?? 0) + 1;
    const wait = cooldownsMs[Math.min(strikes, cooldownsMs.length) - 1];
    const until = now() + wait;
    cooling.delete(key); // re-insert, so iteration order stays oldest-first
    cooling.set(key, { until, strikes });
    sweep(cooling, now(), false);
    return until;
  }

  return {
    start(set, run) {
      const key = setKey(set);
      const running = inFlight.get(key);
      if (running) return { kind: 'joined', fill: running };
      const t = now();
      sweep(recent, t, true);
      const done = recent.get(key);
      if (done) return { kind: 'joined', fill: done.fill };
      const cool = cooling.get(key);
      // An expired cooldown stays remembered (its count of failures in a
      // row sets the next one) until a fill of that bill succeeds.
      if (cool && t < cool.until) return { kind: 'cooling' };
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
        // spent nothing, so it neither cools the bill nor resets its
        // backoff, and it is not kept for late joiners.
        if (!result.refused) {
          let joinableUntil = now() + recentMs;
          if (result.complete) cooling.delete(key);
          else {
            const cooledUntil = coolDown(key);
            // Drafts whose write failed are in no cache another request can
            // read, so keep them joinable for as long as the bill cools,
            // instead of a 502 for every caller meanwhile (fourth check of
            // #554, N1). Still a failed fill: the cooldown above stands.
            if (!result.stored) joinableUntil = Math.max(joinableUntil, cooledUntil);
          }
          recent.delete(key);
          recent.set(key, { fill: Promise.resolve(result), until: joinableUntil });
          sweep(recent, now(), false);
        }
        inFlight.delete(key);
        return result;
      })();
      inFlight.set(key, fill);
      return { kind: 'started', fill };
    },
    reset() {
      cooling.clear();
      recent.clear();
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
  if (refusals.some(Boolean)) return { refused: true, drafted: {}, complete: false, stored: true };

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
  // Never throws. FALSE means the write did not reach the cache database
  // (in this process's memory only), so other requests will read those
  // stances as missing again: a failed store counts as a failed fill, and
  // the bill cools down (step 5) instead of re-drafting every stance on
  // the next request (third check of #554, N5). `drafted` is kept, so this
  // request and its joiners are still served — joiners until the cooldown
  // ends (step 5, fourth check of #554, N1).
  const stored = count > 0 ? await deps.cache.setStances(set, drafted) : true;
  return { refused: false, drafted, complete: count === missing.length && stored, stored };
}

/**
 * The day counts for one request, in a fixed order, from this request's own
 * read and the fill alone — never from the caller's stance.
 * `startedFill`: this request started the fill, so its drafts are its spend.
 * `missing`: the stances this request's read found missing.
 */
async function recordCounts(
  fill: Fill | null,
  missing: readonly Stance[],
  deps: ServeDeps,
  startedFill = false
): Promise<void> {
  if (fill?.refused) await deps.note.refusedDaily();
  const generated = fill && startedFill ? Object.keys(fill.drafted).length : 0;
  for (let i = 0; i < generated; i += 1) await deps.note.generated();
  // Every stance this request found missing came back (second check of
  // #554, D3: not `fill.complete`, which is judged against the STARTER's
  // read and would count a joiner whose extra missing stance stayed missing).
  const allAvailable = fill === null ? missing.length === 0 : !fill.refused && missing.every((s) => fill.drafted[s]);
  if (allAvailable) await deps.note.served();
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
    deps.defer(() => recordCounts(null, missing, deps));
    return { kind: 'script', script: own as string, cached: true };
  }

  // Start (or join) the fill BEFORE branching on the caller's own script, and
  // chain the counts onto the fill, so nothing sent anywhere waits on the
  // response (step 3, first check of #554, B1).
  const start = deps.fills.start(set, () => fillMissing(set, missing, deps));
  const pending = start.kind === 'started' || start.kind === 'joined' ? start.fill : null;
  const counted = pending
    ?.then((f) => recordCounts(f, missing, deps, start.kind === 'started'))
    .catch((err) => deps.logFailure?.(err));

  // Cooling or busy (step 5): no fill, so every answer leaves at once.
  if (!pending || !counted) {
    return own ? { kind: 'script', script: own, cached: true } : { kind: 'generation-failed' };
  }
  // A fill was started or joined: EVERY answer waits for it, the cached one
  // included, so when the answer leaves says nothing about whose script was
  // cached (step 3, fourth check of #554, B1).
  const fill = await pending;
  // The counts are already running. Keep them alive past the answer when
  // there is something to count; when every draft failed there is nothing
  // (recordCounts writes nothing), so nothing is deferred — the same as the
  // 502 path before 2026-11-24. Either way nothing sent anywhere changes.
  if (fill.refused || Object.keys(fill.drafted).length > 0) deps.defer(() => counted);
  if (own) return { kind: 'script', script: own, cached: true };
  if (fill.refused) return { kind: 'daily-limited' };
  const script = fill.drafted[stance];
  if (!script) return { kind: 'generation-failed' };
  return { kind: 'script', script, cached: false };
}

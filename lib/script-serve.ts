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
 *      If the caller's own script WAS cached, the response goes out at once
 *      and steps a–c run after it (`defer`, which is next/server's after() in
 *      the route), so a reader never waits on someone else's stance. The
 *      Upstash and Anthropic traffic is the same either way.
 *
 *   4. COUNTS (counters database, lib/usage.ts), also stance-blind:
 *        - `generated`: one per draft that came back (an actual spend), as
 *          before.
 *        - `refusedDaily`: once whenever the breaker refused a fill, even when
 *          this caller's own script was cached and they got it. Counting it
 *          only for callers who were refused would tell the counters database
 *          whether this caller's stance was the cached one.
 *        - `served` (the people count, owner card `people`, 2026-11-23): once
 *          when the request ends with EVERY stance of the bill available —
 *          nothing was missing, or every missing draft came back. When a fill
 *          was refused or any draft failed, it is not counted, even for a
 *          caller who did get a script: whether a caller got one then depends
 *          on their stance, and a count that ticked only for them would say
 *          which. So the served count can undercount on a day with failed
 *          drafts; it never counts a script that was not served.
 *      They run in one deferred task, in that fixed order, after the answer.
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
  /** Runs a task after the response is sent (next/server after() in the route). */
  defer: (task: () => Promise<void>) => void;
  /** The content-free, caller-free day counts (lib/usage.ts). Never throw. */
  note: {
    served: () => Promise<void>;
    generated: () => Promise<void>;
    refusedDaily: () => Promise<void>;
  };
  /** Where a failed draft is reported (console.error in the route). */
  logFailure?: (err: unknown) => void;
}

interface Fill {
  /** The breaker refused, so nothing was drafted. */
  refused: boolean;
  /** The drafts that came back, by stance. */
  drafted: Partial<Record<Stance, string>>;
  /** Every missing stance came back. */
  complete: boolean;
}

/** Draft every missing stance at once and store what came back, in one write. */
async function fillMissing(set: StanceSetParts, missing: Stance[], deps: ServeDeps): Promise<Fill> {
  const refusals = await Promise.all(missing.map(() => deps.takeGenerationUnit()));
  if (refusals.some(Boolean)) return { refused: true, drafted: {}, complete: false };

  const results = await Promise.allSettled(missing.map((stance) => deps.generate(stance)));
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

/** The day counts for one request, in a fixed order, from the fill alone. */
async function recordCounts(fill: Fill | null, deps: ServeDeps): Promise<void> {
  if (fill?.refused) await deps.note.refusedDaily();
  const generated = fill ? Object.keys(fill.drafted).length : 0;
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

  if (own) {
    // The caller's script is ready: answer now, draft the rest afterwards.
    deps.defer(async () => {
      try {
        await recordCounts(await fillMissing(set, missing, deps), deps);
      } catch (err) {
        deps.logFailure?.(err);
      }
    });
    return { kind: 'script', script: own, cached: true };
  }

  const fill = await fillMissing(set, missing, deps);
  // Every draft failed: nothing to count (recordCounts would write nothing),
  // so nothing is deferred — the same as the 502 path before 2026-11-24.
  if (fill.refused || Object.keys(fill.drafted).length > 0) deps.defer(() => recordCounts(fill, deps));
  if (fill.refused) return { kind: 'daily-limited' };
  const script = fill.drafted[stance];
  if (!script) return { kind: 'generation-failed' };
  return { kind: 'script', script, cached: false };
}

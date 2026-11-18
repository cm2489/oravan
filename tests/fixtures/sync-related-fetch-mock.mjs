/**
 * Preloaded with `node --import` by tests/related-bills-writer.unit.spec.ts:
 * replaces globalThis.fetch before scripts/sync-related.mjs loads, so the real
 * script runs with ZERO network. Answers come from the JSON file named by
 * RELATED_MOCK_SCENARIO: `{ "<type>/<number>": <answer> }`, where an answer is
 *   - an object: a 200 answer with that JSON body;
 *   - a number: that HTTP status, empty body;
 *   - "fail": a 500;
 *   - "hang": never answers, until the request's abort signal fires;
 *   - an array: one answer per attempt, in order (the last one repeats);
 *   - `{ "delay": ms, "then": <answer> }`: that answer after `ms` (a slow but
 *     working Congress.gov), unless the request's abort signal fires first.
 * A path not in the scenario answers 500. Every request path is appended to
 * RELATED_MOCK_LOG, without its query string (so the key never lands there).
 */
import { appendFileSync, readFileSync } from 'node:fs';

const scenario = JSON.parse(readFileSync(process.env.RELATED_MOCK_SCENARIO, 'utf8'));
const attempts = new Map();

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (process.env.RELATED_MOCK_LOG) appendFileSync(process.env.RELATED_MOCK_LOG, `${url.pathname}\n`);
  // The query's shape, never the key itself: whether the key sent is the one
  // the process was given.
  if (process.env.RELATED_MOCK_QUERY_LOG) {
    const q = url.searchParams;
    appendFileSync(
      process.env.RELATED_MOCK_QUERY_LOG,
      `limit=${q.get('limit')} format=${q.get('format')} key=${q.get('api_key') === process.env.CONGRESS_API_KEY ? 'given' : 'wrong'}\n`
    );
  }
  const m = url.pathname.match(/\/bill\/\d+\/([a-z]+)\/(\d+)\/relatedbills$/);
  const key = m ? `${m[1]}/${m[2]}` : '';
  let answer = scenario[key];
  if (Array.isArray(answer)) {
    const n = attempts.get(key) ?? 0;
    attempts.set(key, n + 1);
    answer = answer[Math.min(n, answer.length - 1)];
  }
  if (answer && typeof answer === 'object' && !Array.isArray(answer) && 'delay' in answer) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, answer.delay);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(init.signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
    answer = answer.then;
  }
  if (answer === 'hang') {
    return new Promise((_, reject) => {
      // A real hung request keeps its socket, and so the process, alive; this
      // timer does the same (AbortSignal.timeout's own timer does not).
      const alive = setInterval(() => {}, 1_000);
      const signal = init.signal;
      if (!signal) return; // never settles: the caller must bring a timeout
      signal.addEventListener('abort', () => {
        clearInterval(alive);
        reject(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  }
  if (answer === undefined || answer === 'fail') return new Response('{"error":"mock"}', { status: 500 });
  if (typeof answer === 'number') return new Response('', { status: answer });
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
};

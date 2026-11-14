/**
 * Preloaded with `node --import` by tests/twin-coverage.unit.spec.ts: replaces
 * globalThis.fetch before scripts/sync-related.mjs loads, so the real script
 * runs with ZERO network. Answers come from the JSON file named by
 * RELATED_MOCK_SCENARIO: `{ "<type>/<number>": <relatedbills payload> | "fail" }`.
 * A path not in the scenario answers 500. Every request path is appended to
 * RELATED_MOCK_LOG, without its query string (so the key never lands there).
 */
import { appendFileSync, readFileSync } from 'node:fs';

const scenario = JSON.parse(readFileSync(process.env.RELATED_MOCK_SCENARIO, 'utf8'));

globalThis.fetch = async (input) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (process.env.RELATED_MOCK_LOG) appendFileSync(process.env.RELATED_MOCK_LOG, `${url.pathname}\n`);
  const m = url.pathname.match(/\/bill\/\d+\/([a-z]+)\/(\d+)\/relatedbills$/);
  const answer = m ? scenario[`${m[1]}/${m[2]}`] : undefined;
  if (answer === undefined || answer === 'fail') return new Response('{"error":"mock"}', { status: 500 });
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
};

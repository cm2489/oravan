/**
 * A `--import` preload for tests/sync-coverage-runner.unit.spec.ts: replaces
 * globalThis.fetch BEFORE scripts/sync-coverage.mjs evaluates, so the run
 * makes ZERO network calls. Both clients the script uses go through it — the
 * TheNewsAPI adapter calls fetch directly, and the Anthropic SDK takes the
 * global fetch when its client is constructed.
 *
 *   MOCK_SCENARIO  path to a JSON scenario (below)
 *   MOCK_LOG       path to append one JSON line per request to
 *
 * Scenario:
 *   {
 *     "news": [{ "match": "substring of the search query", "sort": "published_at" | "relevance_score" | null | "*",
 *                "articles": [{ title, url, source, description, published_at }] }],
 *     "rejectDateSort": false,          // 400 every sort=published_at request
 *     "brokenQueries": ["substring"],   // 400 every request for these, sorted or not
 *     "keepMarker": "KEEP"              // the fake gate keeps titles containing this
 *   }
 *
 * The log never records the api_token VALUE — only whether one was sent — so
 * the test can also assert the script never prints it.
 */
import { appendFileSync, readFileSync } from 'node:fs';

const scenario = JSON.parse(readFileSync(process.env.MOCK_SCENARIO, 'utf8'));
const log = (entry) => appendFileSync(process.env.MOCK_LOG, `${JSON.stringify(entry)}\n`);

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));

  if (url.hostname === 'api.thenewsapi.com') {
    const search = url.searchParams.get('search') ?? '';
    const sort = url.searchParams.get('sort');
    log({
      kind: 'news',
      search,
      sort,
      published_after: url.searchParams.get('published_after'),
      limit: url.searchParams.get('limit'),
      token_sent: Boolean(url.searchParams.get('api_token')),
    });
    const rate = { 'x-ratelimit-remaining': '50' };
    if ((scenario.brokenQueries ?? []).some((m) => search.includes(m))) {
      return json(400, { error: { code: 'malformed_parameters', message: 'The search parameter is malformed.' } }, rate);
    }
    if (scenario.rejectDateSort && sort === 'published_at') {
      return json(400, { error: { code: 'malformed_parameters', message: 'The sort parameter is invalid.' } }, rate);
    }
    const rule = (scenario.news ?? []).find(
      (r) => search.includes(r.match) && (r.sort === '*' || r.sort === sort),
    );
    return json(200, { meta: { found: rule?.articles?.length ?? 0 }, data: rule?.articles ?? [] }, rate);
  }

  if (url.hostname === 'api.anthropic.com') {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
    const prompt = body.messages?.[0]?.content ?? '';
    const kept = [];
    for (const line of String(prompt).split('\n')) {
      const m = line.match(/^(\d+)\. \[[^\]]+\] (.*)$/);
      if (m && m[2].includes(scenario.keepMarker ?? 'KEEP')) kept.push(Number(m[1]));
    }
    log({ kind: 'gate', prompt, max_tokens: body.max_tokens, kept });
    return json(200, {
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text: kept.length ? kept.join(', ') : 'none' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  }

  throw new Error(`sync-coverage-fetch-mock: unexpected network call to ${url.hostname}`);
};

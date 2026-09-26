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
 *     "quotaExhausted": false,          // 402 (TheNewsAPI's quota answer) to every request
 *     "keepMarker": "KEEP",             // the fake gate keeps titles containing this
 *     "gateNoAnswer": ["substring"],    // the fake gate replies with nothing usable
 *                                       //   when its prompt contains one of these
 *     "gateReplies": [{ "match": "substring of the prompt",
 *                       "text": "{kept} — and a sentence",   // {kept} = the indexes it would keep, or "none"
 *                       "stop_reason": "end_turn" | "max_tokens" }]
 *   }                                   // a scripted reply, for the off-script / truncated cases
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
    if (scenario.quotaExhausted) {
      return json(402, { error: { code: 'usage_limit_reached', message: 'Daily usage limit reached.' } }, rate);
    }
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
    const keptText = kept.length ? kept.join(', ') : 'none';
    const noAnswer = (scenario.gateNoAnswer ?? []).some((m) => String(prompt).includes(m));
    const scripted = (scenario.gateReplies ?? []).find((r) => String(prompt).includes(r.match));
    const text = scripted ? String(scripted.text).replace('{kept}', keptText) : noAnswer ? '' : keptText;
    const stopReason = scripted?.stop_reason ?? 'end_turn';
    log({ kind: 'gate', prompt, max_tokens: body.max_tokens, kept: noAnswer ? null : kept, text, stop_reason: stopReason });
    return json(200, {
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  }

  throw new Error(`sync-coverage-fetch-mock: unexpected network call to ${url.hostname}`);
};

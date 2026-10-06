import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// SOCIAL SEND — scripts/social-send.mjs.
//
// The sender posts the drafter's queue to Oravan's own Bluesky account and
// Telegram channel, and posts nothing until the owner turns it on. Pinned here:
//   1. the kill switch: only all three layers on sends; --dry-run always wins;
//   2. a dry run makes no network call;
//   3. the daily cap, one post per bill a day, the record-date window, and
//      the rebuild-at-send-time check;
//   4. the AI label is in every outbound text that carries AI-written words;
//   5. the source has no code path for answering, tagging, endorsing or
//      re-sharing anyone's post, and names only the platform methods it needs;
//   6. secrets never reach a printed line.
// Every platform call goes to a fake fetch passed in; no real request is made.
import { buildQueue, recordContext } from '../scripts/social-drafts.mjs';
import {
  DAILY_CAP,
  MAX_FACT_AGE_DAYS,
  SECRET_NAMES,
  SEND_KINDS,
  blueskyPostRecord,
  coveredThrough,
  ensureBotLabel,
  escapeHtml,
  linkFacets,
  missingSecrets,
  outboundGuard,
  pickItems,
  readSwitchFile,
  run,
  switchFileState,
  switchState,
  telegramMessage,
} from '../scripts/social-send.mjs';

const SOURCE = readFileSync(join(process.cwd(), 'scripts/social-send.mjs'), 'utf8');

/* ---- fixtures ------------------------------------------------------------ */

const NOW = Date.parse('2026-09-29T16:00:00Z'); // Eastern date 2026-09-29
const TODAY = '2026-09-29';
const SECRETS = {
  BLUESKY_HANDLE: 'example.test',
  BLUESKY_APP_PASSWORD: 'app-pass-SECRET-1234',
  TELEGRAM_BOT_TOKEN: '123456:TOKEN-SECRET-abcdef',
  TELEGRAM_CHANNEL: '@example_channel',
};
const ON_FILE = { enabled: true, since: '2026-10-05', by: 'owner' };

type Seg = { from: string; text: string; key?: string };

function variant(segments: Seg[]) {
  const text = segments.map((s) => s.text).join('');
  return { text, chars: [...text].length, segments };
}

function item(kind: string, slug: string, factDate: string, opts: { ai?: boolean; id?: string; text?: string } = {}) {
  const url = `https://oravan.org/bills/${slug}`;
  const segs: Seg[] = opts.ai
    ? [
        { from: 'ai', text: opts.text ?? `Headline for ${slug}` },
        { from: 'sep', text: ' (' },
        { from: 'label', text: 'AI-decoded', key: 'og.aiDecoded' },
        { from: 'sep', text: ')\n' },
        { from: 'link', text: url },
      ]
    : [
        { from: 'quote', text: opts.text ?? '“On Passage” — “Passed”' },
        { from: 'sep', text: '\n' },
        { from: 'link', text: url },
      ];
  const v = variant(segs);
  return {
    id: opts.id ?? `${kind}:${slug}:${factDate}`,
    kind,
    ref: { slug },
    factDate,
    aiLabel: !!opts.ai,
    variants: { en: { short: v, long: v }, es: { short: v, long: v } },
  };
}

function queueOf(items: ReturnType<typeof item>[]) {
  return { schema: 'social-drafts/v1', briefDay: TODAY, liveGateNow: new Date(NOW).toISOString(), items };
}

const SIX = [
  item('roll-call', 'hr-1-119', '2026-09-29'),
  item('bill-card', 'hr-2-119', '2026-09-29', { ai: true }),
  item('bill-card', 'hr-3-119', '2026-09-28', { ai: true }),
  item('roll-call', 'hr-4-119', '2026-09-28'),
  item('floor-notice', 'hr-5-119', '2026-09-27'),
  item('bill-card', 'hr-6-119', '2026-09-26', { ai: true }),
];

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };

function fakeFetch(opts: { fail?: 'bluesky' | 'bluesky-hostile' | 'telegram'; profile?: unknown } = {}) {
  const calls: Call[] = [];
  const respond = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
  const fetchImpl = async (url: string, init?: Call['init']) => {
    calls.push({ url, init });
    if (url.startsWith('https://api.telegram.org/')) {
      if (opts.fail === 'telegram') return respond(401, { ok: false, error_code: 401, description: `Unauthorized ${SECRETS.TELEGRAM_BOT_TOKEN}` });
      return respond(200, { ok: true, result: { message_id: calls.length } });
    }
    if (url.includes('com.atproto.server.createSession')) {
      if (opts.fail === 'bluesky') return respond(401, { error: 'AuthenticationRequired', message: `bad ${SECRETS.BLUESKY_APP_PASSWORD}` });
      if (opts.fail === 'bluesky-hostile') return respond(401, { error: SECRETS.BLUESKY_APP_PASSWORD, message: SECRETS.BLUESKY_APP_PASSWORD });
      return respond(200, { accessJwt: 'jwt-SECRET', did: 'did:plc:example' });
    }
    if (url.includes('com.atproto.repo.getRecord')) return respond(200, opts.profile ?? { value: { displayName: 'Oravan', labels: { values: [{ val: 'bot' }] } }, cid: 'cid1' });
    if (url.includes('com.atproto.repo.putRecord')) return respond(200, { uri: 'at://profile', cid: 'cid2' });
    if (url.includes('com.atproto.repo.createRecord')) return respond(200, { uri: `at://post/${calls.length}` });
    return respond(404, { error: 'NotFound' });
  };
  return { calls, fetchImpl };
}

function workdir() {
  return mkdtempSync(join(tmpdir(), 'social-send-spec-'));
}

/** Writes a queue and a switch file to a temp folder outside the repo and
 *  runs the sender with the fake fetch. */
async function runWith(opts: {
  items?: ReturnType<typeof item>[];
  env?: Record<string, string | undefined>;
  file?: unknown;
  argv?: string[];
  fetch?: ReturnType<typeof fakeFetch>;
  ledger?: unknown[];
  /** Pass --first-run when no ledger is given (default true). */
  firstRun?: boolean;
  floorCovers?: (item: unknown) => string | null;
}) {
  const dir = workdir();
  const items = opts.items ?? SIX;
  const queuePath = join(dir, 'queue.json');
  writeFileSync(queuePath, JSON.stringify(queueOf(items)));
  const switchPath = join(dir, 'social-sending.json');
  if (opts.file !== undefined) writeFileSync(switchPath, JSON.stringify(opts.file));
  const ledgerPath = join(dir, 'ledger.json');
  if (opts.ledger) writeFileSync(ledgerPath, JSON.stringify({ sent: opts.ledger }));
  const fake = opts.fetch ?? fakeFetch();
  const lines: string[] = [];
  const result = await run({
    argv: ['--queue', queuePath, '--ledger', ledgerPath, ...(!opts.ledger && opts.firstRun !== false ? ['--first-run'] : []), ...(opts.argv ?? [])],
    env: opts.env ?? {},
    fetchImpl: fake.fetchImpl,
    now: NOW,
    log: (l: string) => lines.push(l),
    sleep: async () => {},
    switchFilePath: switchPath,
    rebuild: () => queueOf(items),
    floorCovers: opts.floorCovers ?? (() => TODAY),
  });
  return { result, calls: fake.calls, lines, ledgerPath };
}

/* ---- 1. the kill switch --------------------------------------------------- */

test.describe('the kill switch', () => {
  const combos: [boolean, boolean, boolean][] = [];
  for (const a of [false, true]) for (const b of [false, true]) for (const c of [false, true]) combos.push([a, b, c]);

  for (const [envOn, fileOn, secretsOn] of combos) {
    test(`SOCIAL_SEND ${envOn ? 'on' : 'off'}, switch file ${fileOn ? 'on' : 'off'}, secrets ${secretsOn ? 'set' : 'missing'}`, async () => {
      const env = { ...(envOn ? { SOCIAL_SEND: 'on' } : {}), ...(secretsOn ? SECRETS : {}) };
      const { result, calls } = await runWith({ env, file: fileOn ? ON_FILE : { enabled: false, since: null, by: null } });
      const all = envOn && fileOn && secretsOn;
      expect(result.mode).toBe(all ? 'sent' : 'dry-run');
      expect(result.exitCode).toBe(0);
      if (all) {
        expect(calls.length).toBeGreaterThan(0);
        expect(result.sent.length).toBe(2 * DAILY_CAP);
      } else {
        expect(calls).toHaveLength(0);
      }
    });
  }

  test('--dry-run wins over all three layers on, and makes no network call', async () => {
    const { result, calls, lines } = await runWith({ env: { SOCIAL_SEND: 'on', ...SECRETS }, file: ON_FILE, argv: ['--dry-run'] });
    expect(result.mode).toBe('dry-run');
    expect(calls).toHaveLength(0);
    expect(lines.join('\n')).toContain('Nothing was sent');
  });

  test('a missing switch file is off', async () => {
    const { result, calls } = await runWith({ env: { SOCIAL_SEND: 'on', ...SECRETS } });
    expect(result.mode).toBe('dry-run');
    expect(calls).toHaveLength(0);
  });

  test('each single missing secret is off', () => {
    for (const name of SECRET_NAMES) {
      const env: Record<string, string | undefined> = { SOCIAL_SEND: 'on', ...SECRETS, [name]: '' };
      const s = switchState({ env, switchFile: switchFileState(ON_FILE) });
      expect(s.send, name).toBe(false);
      expect(missingSecrets(env)).toEqual([name]);
    }
  });

  test('SOCIAL_SEND must be exactly "on"', () => {
    for (const v of ['ON', 'true', '1', 'yes', ' on', undefined]) {
      expect(switchState({ env: { SOCIAL_SEND: v, ...SECRETS }, switchFile: switchFileState(ON_FILE) }).send, String(v)).toBe(false);
    }
    expect(switchState({ env: { SOCIAL_SEND: 'on', ...SECRETS }, switchFile: switchFileState(ON_FILE) }).send).toBe(true);
  });

  test('the switch file is read strictly', () => {
    expect(switchFileState(ON_FILE).on).toBe(true);
    for (const bad of [
      { ...ON_FILE, enabled: 'true' },
      { ...ON_FILE, enabled: false },
      { ...ON_FILE, by: 'claude' },
      { ...ON_FILE, by: undefined },
      { ...ON_FILE, since: null },
      { ...ON_FILE, since: 'today' },
      null,
      [],
    ]) {
      expect(switchFileState(bad).on, JSON.stringify(bad)).toBe(false);
    }
  });

  test('the committed switch file is off', () => {
    const committed = JSON.parse(readFileSync(join(process.cwd(), 'data/social-sending.json'), 'utf8'));
    expect(committed.enabled).toBe(false);
    expect(readSwitchFile(join(process.cwd(), 'data/social-sending.json')).on).toBe(false);
  });
});

/* ---- 2. what gets picked ---------------------------------------------------- */

test.describe('picking the day', () => {
  test(`at most ${DAILY_CAP} a day per platform, newest record first`, () => {
    const { picks } = pickItems({ queue: queueOf(SIX), fresh: queueOf(SIX), today: TODAY });
    for (const p of ['bluesky', 'telegram'] as const) {
      expect(picks[p]).toHaveLength(DAILY_CAP);
      expect(picks[p].map((x: { id: string }) => x.id)).toEqual([SIX[0].id, SIX[1].id, SIX[3].id]);
    }
  });

  test('what was sent today counts against the cap; yesterday does not', () => {
    const ledger = [
      { platform: 'bluesky', id: 'x', slug: 'hr-90-119', lang: 'en', factDate: TODAY, day: TODAY },
      { platform: 'bluesky', id: 'y', slug: 'hr-91-119', lang: 'en', factDate: TODAY, day: TODAY },
      { platform: 'telegram', id: 'z', slug: 'hr-92-119', lang: 'en', factDate: '2026-09-28', day: '2026-09-28' },
    ];
    const { picks } = pickItems({ queue: queueOf(SIX), fresh: queueOf(SIX), ledger, today: TODAY });
    expect(picks.bluesky).toHaveLength(1);
    expect(picks.telegram).toHaveLength(DAILY_CAP);
  });

  test('a cap already reached sends nothing', async () => {
    const ledger = ['a', 'b', 'c'].flatMap((id, i) =>
      ['bluesky', 'telegram'].map((platform) => ({ platform, id, slug: `hr-8${i}-119`, lang: 'en', factDate: TODAY, day: TODAY })),
    );
    const { result, calls } = await runWith({ env: { SOCIAL_SEND: 'on', ...SECRETS }, file: ON_FILE, ledger });
    expect(result.sent).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test('an item already sent is not sent again; the ledger holds no reader data', async () => {
    const first = await runWith({ env: { SOCIAL_SEND: 'on', ...SECRETS }, file: ON_FILE });
    const ledger = JSON.parse(readFileSync(first.ledgerPath, 'utf8')).sent;
    expect(ledger).toHaveLength(2 * DAILY_CAP);
    for (const e of ledger) expect(Object.keys(e).sort()).toEqual(['at', 'day', 'factDate', 'id', 'lang', 'platform', 'ref', 'slug']);
    const { picks } = pickItems({ queue: queueOf(SIX), fresh: queueOf(SIX), ledger, today: '2026-09-30' });
    const sentIds = new Set(ledger.map((e: { id: string }) => e.id));
    for (const p of picks.bluesky) expect(sentIds.has(p.id)).toBe(false);
  });

  test('one post per bill a day', () => {
    const same = [item('roll-call', 'hr-1-119', TODAY, { id: 'a' }), item('roll-call', 'hr-1-119', TODAY, { id: 'b' }), item('bill-card', 'hr-1-119', TODAY, { ai: true, id: 'c' })];
    const { picks } = pickItems({ queue: queueOf(same), fresh: queueOf(same), today: TODAY });
    expect(picks.bluesky).toHaveLength(1);
  });

  test('only the send kinds go out; never a reply card, a question update or a day line', () => {
    const others = ['reply-card', 'big-question-update', 'today'].map((k, i) => item(k, `hr-7${i}-119`, TODAY, { ai: k !== 'today' }));
    const { picks } = pickItems({ queue: queueOf(others), fresh: queueOf(others), today: TODAY });
    expect(picks.bluesky).toHaveLength(0);
    expect(picks.telegram).toHaveLength(0);
    expect([...SEND_KINDS]).toEqual(['floor-notice', 'roll-call', 'bill-card']);
  });

  test(`an item older than the window (${MAX_FACT_AGE_DAYS} days) or dated after today is refused`, () => {
    const old = item('roll-call', 'hr-1-119', '2026-09-15');
    const edge = item('roll-call', 'hr-2-119', '2026-09-16');
    const future = item('roll-call', 'hr-3-119', '2026-09-30');
    const { picks, refused } = pickItems({ queue: queueOf([old, edge, future]), fresh: queueOf([old, edge, future]), today: TODAY });
    expect(picks.bluesky.map((p: { id: string }) => p.id)).toEqual([edge.id]);
    expect(refused.map((r: { id: string }) => r.id).sort()).toEqual([future.id, old.id].sort());
  });

  test('an item the drafter no longer produces, or now words differently, is refused', () => {
    const a = item('roll-call', 'hr-1-119', TODAY);
    const b = item('roll-call', 'hr-2-119', TODAY);
    const bNow = item('roll-call', 'hr-2-119', TODAY, { text: '“On Passage” — “Failed”' });
    const { picks, refused } = pickItems({ queue: queueOf([a, b]), fresh: queueOf([bNow]), today: TODAY });
    expect(picks.bluesky).toHaveLength(0);
    expect(refused.find((r: { id: string }) => r.id === a.id)?.reason).toMatch(/no longer produces/);
    expect(refused.find((r: { id: string; platform?: string }) => r.id === b.id && r.platform === 'bluesky')?.reason).toMatch(/differently/);
  });

  test('a queue of another schema stops the run', () => {
    expect(() => pickItems({ queue: { schema: 'x', items: [] }, fresh: queueOf([]), today: TODAY })).toThrow(/schema/);
  });
});

/* ---- 3. the AI label (rule 4) and the address ----------------------------------- */

test.describe('every outbound text', () => {
  test('AI-written text without its label is refused', () => {
    const bad = item('bill-card', 'hr-1-119', TODAY, { ai: true });
    const segs = bad.variants.en.short.segments.filter((s: Seg) => s.from !== 'label');
    const v = variant(segs);
    bad.variants.en = { short: v, long: v };
    expect(outboundGuard(bad, 'en', 'bluesky')).toMatch(/label/);
  });

  test('an @handle, a second Oravan address or a stray address is refused', () => {
    const tagged = item('roll-call', 'hr-1-119', TODAY, { text: '“On Passage” @someone' });
    expect(outboundGuard(tagged, 'en', 'bluesky')).toMatch(/@handle/);
    const twice = item('roll-call', 'hr-1-119', TODAY, { text: 'https://oravan.org/bills/hr-9-119' });
    expect(outboundGuard(twice, 'en', 'bluesky')).toMatch(/exactly one/);
  });

  test('on the committed record: every text that carries AI-written words carries the label, and every text its page address', () => {
    const q = buildQueue({ now: NOW });
    const { picks } = pickItems({ queue: q, fresh: q, today: TODAY, cap: Number.POSITIVE_INFINITY });
    const all = [...picks.bluesky, ...picks.telegram];
    expect(all.length).toBeGreaterThan(10);
    const byId = new Map(q.items.map((i: { id: string }) => [i.id, i]));
    for (const p of all) {
      const it = byId.get(p.id) as unknown as { aiLabel: boolean; kind: string };
      if (it.kind === 'bill-card') expect(it.aiLabel).toBe(true);
      if (it.aiLabel) expect(p.text, p.id).toContain('(AI-decoded)');
      expect(p.text.match(/https:\/\/oravan\.org\/bills\/[a-z0-9-]+/g), p.id).toHaveLength(1);
      expect(p.lang).toBe('en');
    }
  });
});

/* ---- 4. the platform requests ------------------------------------------------------ */

test.describe('what goes over the wire', () => {
  test('Bluesky: sign in, make sure of the bot self-label, then only posts', async () => {
    const { calls } = await runWith({ env: { SOCIAL_SEND: 'on', ...SECRETS }, file: ON_FILE });
    const bsky = calls.filter((c) => c.url.startsWith('https://bsky.social/xrpc/'));
    const methods = bsky.map((c) => c.url.replace('https://bsky.social/xrpc/', '').split('?')[0]);
    expect(methods).toEqual(['com.atproto.server.createSession', 'com.atproto.repo.getRecord', ...Array(DAILY_CAP).fill('com.atproto.repo.createRecord')]);
    for (const c of bsky.filter((x) => x.url.endsWith('createRecord'))) {
      const body = JSON.parse(c.init!.body!);
      expect(body.collection).toBe('app.bsky.feed.post');
      expect(Object.keys(body.record).sort()).toEqual(['$type', 'createdAt', 'facets', 'langs', 'text']);
      for (const f of body.record.facets) expect(f.features.map((x: { $type: string }) => x.$type)).toEqual(['app.bsky.richtext.facet#link']);
      expect(body.record.embed).toBeUndefined();
    }
  });

  test('the bot self-label is added when missing, keeping the rest of the profile', async () => {
    const fake = fakeFetch({ profile: { value: { displayName: 'Oravan', description: 'd' }, cid: 'cid1' } });
    const r = await ensureBotLabel(fake.fetchImpl, { token: 't', did: 'did:plc:example' });
    expect(r).toBe('added');
    const put = fake.calls.find((c) => c.url.endsWith('putRecord'))!;
    const body = JSON.parse(put.init!.body!);
    expect(body.swapRecord).toBe('cid1');
    expect(body.record.displayName).toBe('Oravan');
    expect(body.record.description).toBe('d');
    expect(body.record.labels).toEqual({ $type: 'com.atproto.label.defs#selfLabels', values: [{ val: 'bot' }] });
  });

  test('link facets count UTF-8 bytes', () => {
    const text = '“Quoted” · Sep 28\nS. 1 https://oravan.org/bills/s-1-119';
    const [f] = linkFacets(text);
    const bytes = new TextEncoder().encode(text);
    expect(new TextDecoder().decode(bytes.slice(f.index.byteStart, f.index.byteEnd))).toBe('https://oravan.org/bills/s-1-119');
    const rec = blueskyPostRecord({ text, lang: 'en' }, '2026-09-29T16:00:00.000Z');
    expect(rec.langs).toEqual(['en']);
  });

  test('Telegram: sendMessage to the channel, HTML-escaped, preview on the bill page', async () => {
    const { calls } = await runWith({ env: { SOCIAL_SEND: 'on', ...SECRETS }, file: ON_FILE });
    const tg = calls.filter((c) => c.url.startsWith('https://api.telegram.org/'));
    expect(tg).toHaveLength(DAILY_CAP);
    for (const c of tg) {
      expect(c.url).toMatch(/\/sendMessage$/);
      const body = JSON.parse(c.init!.body!);
      expect(Object.keys(body).sort()).toEqual(['chat_id', 'link_preview_options', 'parse_mode', 'text']);
      expect(body.chat_id).toBe(SECRETS.TELEGRAM_CHANNEL);
      expect(body.parse_mode).toBe('HTML');
      expect(body.link_preview_options.url).toMatch(/^https:\/\/oravan\.org\/bills\//);
    }
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
    expect(telegramMessage({ text: 'x <b>' }, '@c').text).toBe('x &lt;b&gt;');
  });
});

/* ---- 5. secrets never printed (rule 10) -------------------------------------------- */

test('a failing platform prints a status and a code, never a secret, and the run fails', async () => {
  for (const fail of ['bluesky', 'bluesky-hostile', 'telegram'] as const) {
    const { result, lines } = await runWith({ env: { SOCIAL_SEND: 'on', ...SECRETS }, file: ON_FILE, fetch: fakeFetch({ fail }) });
    expect(result.exitCode).toBe(1);
    const out = lines.join('\n') + JSON.stringify(result.errors);
    for (const v of Object.values(SECRETS).filter((x) => x !== SECRETS.TELEGRAM_CHANNEL)) expect(out).not.toContain(v);
    expect(out).not.toContain('jwt-SECRET');
    expect(out).not.toContain('api.telegram.org/bot');
  }
});

/* ---- 6. the source ------------------------------------------------------------------ */

/** The source with its comments taken out, so the words that describe what
 *  the sender never does do not count; only code does. */
function codeOnly(src: string) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\s\/\/\s.*$/, ''))
    .join('\n');
}

test('no code path answers, tags, endorses or re-shares anyone', () => {
  const code = codeOnly(SOURCE);
  expect(code.length).toBeGreaterThan(5000);
  for (const word of ['reply', 'replies', 'mention', 'like', 'likes', 'repost', 'quote', 'follow', 'thread', 'forward', 'dm', 'chat.bsky']) {
    expect(code, word).not.toMatch(new RegExp(`(?<![\\p{L}])${word.replace('.', '\\.')}(?![\\p{L}])`, 'iu'));
  }
  expect(code).not.toMatch(/reply_|_reply|replyTo|mention|#tag|app\.bsky\.feed\.(?!post)/i);
});

test('the source names only the platform methods it needs', () => {
  const nsids = new Set([...SOURCE.matchAll(/\b(?:com\.atproto|app\.bsky|chat\.bsky)\.[a-zA-Z.#]+/g)].map((m) => m[0].replace(/\.$/, '')));
  expect([...nsids].sort()).toEqual(
    [
      'app.bsky.actor.profile',
      'app.bsky.feed.post',
      'app.bsky.richtext.facet#link',
      'com.atproto.label.defs#selfLabels',
      'com.atproto.repo.createRecord',
      'com.atproto.repo.getRecord',
      'com.atproto.repo.putRecord',
      'com.atproto.server.createSession',
    ].sort(),
  );
  const code = codeOnly(SOURCE);
  const tgMethods = [...code.matchAll(/\/bot\$\{[^}]+\}\/(\w+)/g)].map((m) => m[1]);
  expect(tgMethods).toEqual(['sendMessage']);
  // The only network access is the fetch passed in.
  expect(code).not.toMatch(/from ['"](node:)?(http|https|http2|net|tls|dgram|child_process)['"]/);
  expect(code).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
  const fetchUses = [...code.matchAll(/\bfetch\b/g)].length;
  expect(fetchUses).toBe(1); // globalThis.fetch, handed in at the run-directly guard only
  // Secrets are read only from the env object passed in, by name.
  expect(code.match(/process\.env/g)).toHaveLength(1);
});

/* ---- 7. the fixes from the independent check (2026-10-03) ------------------------- */

test.describe('the sent ledger', () => {
  test('a send run with no ledger and no --first-run refuses, sends nothing and says why', async () => {
    const { result, calls, lines } = await runWith({ env: { SOCIAL_SEND: 'on', ...SECRETS }, file: ON_FILE, firstRun: false });
    expect(result.mode).toBe('refused');
    expect(result.exitCode).toBe(1);
    expect(result.sent).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/no ledger of earlier posts/);
  });

  test('a dry run with no ledger is still a plain dry run', async () => {
    const { result, calls } = await runWith({ env: {}, file: ON_FILE, firstRun: false });
    expect(result.mode).toBe('dry-run');
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('--first-run sends; the next day with the ledger kept repeats nothing', async () => {
    const first = await runWith({ env: { SOCIAL_SEND: 'on', ...SECRETS }, file: ON_FILE });
    expect(first.result.sent).toHaveLength(2 * DAILY_CAP);
    const ledger = JSON.parse(readFileSync(first.ledgerPath, 'utf8')).sent;
    const { picks } = pickItems({ queue: queueOf(SIX), fresh: queueOf(SIX), ledger, today: '2026-09-30', floorCovers: () => '2026-09-30' });
    const sent = new Set(ledger.map((e: { id: string; platform: string }) => `${e.platform}|${e.id}`));
    for (const p of ['bluesky', 'telegram'] as const) for (const x of picks[p]) expect(sent.has(`${p}|${x.id}`)).toBe(false);
  });

  test('an existing, empty ledger counts as restored', async () => {
    const { result } = await runWith({ env: { SOCIAL_SEND: 'on', ...SECRETS }, file: ON_FILE, ledger: [] });
    expect(result.mode).toBe('sent');
    expect(result.sent).toHaveLength(2 * DAILY_CAP);
  });
});

test.describe('a floor notice after its covered day', () => {
  const notice = item('floor-notice', 'sjres-197-119', '2026-09-28', { id: 'floor-notice:sjres-197-119:senate:daily-digest' });

  test('is refused once the day it covers is before today (Eastern)', () => {
    const q = queueOf([notice]);
    const past = pickItems({ queue: q, fresh: q, today: '2026-09-30', floorCovers: () => '2026-09-29' });
    expect(past.picks.telegram).toHaveLength(0);
    expect(past.refused[0].reason).toMatch(/covers 2026-09-29, before today/);
    const same = pickItems({ queue: q, fresh: q, today: '2026-09-29', floorCovers: () => '2026-09-29' });
    expect(same.picks.telegram).toHaveLength(1);
  });

  test('a notice with no covered day is refused', () => {
    const q = queueOf([notice]);
    const r = pickItems({ queue: q, fresh: q, today: TODAY, floorCovers: () => null });
    expect(r.picks.telegram).toHaveLength(0);
    expect(r.refused[0].reason).toMatch(/no covered day/);
  });

  test('the covered day: the meeting for the daily program, the week for the weekly schedule', () => {
    expect(coveredThrough({ covers: '2026-09-29', source: 'daily-digest' })).toBe('2026-09-29');
    expect(coveredThrough({ covers: '2026-09-28', source: 'billsthisweek' })).toBe('2026-10-04');
    expect(coveredThrough({ covers: null, source: 'daily-digest' })).toBeNull();
    expect(coveredThrough(null)).toBeNull();
  });

  test('on the committed record: the Sep 29 Senate notice is not sent on Sep 30 at 10 am Eastern', async () => {
    // The Senate's Daily Digest notice for S.J.Res. 197 (published 2026-09-28,
    // covering the meeting of 2026-09-29) was in data/floor-signals.json when
    // this test was written; the nightly refresh has since retired it, so the
    // committed file no longer holds a floor notice for this moment. The
    // notice's covered day, as that file recorded it, is pinned here and added
    // to the queue the drafter builds from today's committed data, so the
    // sender's covered-day rule is still what keeps it back.
    const RECORDED = { covers: '2026-09-29', source: 'daily-digest' };
    const dir = workdir();
    const at = Date.parse('2026-09-30T14:00:00Z');
    const built = buildQueue({ now: at });
    const q = { ...built, items: [...built.items, notice] };
    const queuePath = join(dir, 'queue.json');
    writeFileSync(queuePath, JSON.stringify(q));
    const ctx = recordContext(at);
    const floorCovers = (i: { id: string; ref?: { slug?: string } }) =>
      i.id === notice.id ? coveredThrough(RECORDED) : coveredThrough(i?.ref?.slug ? ctx.liveAnnouncement(i.ref.slug) : null);
    const lines: string[] = [];
    const r = await run({
      argv: ['--queue', queuePath, '--dry-run'],
      env: {},
      now: at,
      log: (l: string) => lines.push(l),
      rebuild: () => q,
      floorCovers,
    });
    const sentIds = [...r.picks!.bluesky, ...r.picks!.telegram].map((p: { id: string }) => p.id);
    expect(sentIds.some((id: string) => id.startsWith('floor-notice:'))).toBe(false);
    expect(r.refused.find((x: { id: string }) => x.id === notice.id)?.reason).toMatch(
      /covers 2026-09-29, before today \(2026-09-30\)/,
    );
  });
});

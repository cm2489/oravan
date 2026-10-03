/*
 * SOCIAL SEND — posts the day's reviewed drafts to Oravan's own Bluesky
 * account and its own Telegram channel. IT POSTS NOTHING UNTIL THE OWNER
 * TURNS IT ON, and by default it only prints what it would send.
 *
 *   npx tsx scripts/social-send.mjs [--dry-run] [--queue <queue.json> | --queue-dir <dir>]
 *                                   [--ledger <file>] [--now <ISO instant>]
 *
 * WHAT IT READS: the queue scripts/social-drafts.mjs wrote (outside this
 * repository), the committed record through that same script, and
 * data/social-sending.json. Nothing about a reader: there is no reader input
 * of any kind. What leaves the machine is the post text (the drafter's own,
 * unchanged, with its AI label and the bill's page address) and the two
 * accounts' credentials, sent only to their own platform.
 *
 * THE KILL SWITCH, THREE LAYERS, ALL DEFAULT OFF. It sends only when all
 * three are on; with any one off it prints what it would have sent and exits 0:
 *   (a) the environment says SOCIAL_SEND=on (the workflow's dry_run input
 *       sets it; it defaults to a dry run);
 *   (b) data/social-sending.json reads exactly
 *       { "enabled": true, "since": "<YYYY-MM-DD>", "by": "owner" }.
 *       The committed file says enabled: false. Only the owner flips it;
 *   (c) all four platform secrets are set: BLUESKY_HANDLE,
 *       BLUESKY_APP_PASSWORD, TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL.
 * --dry-run forces a dry run whatever the three say.
 *
 * WHAT IT SENDS: only three kinds the drafter makes — a floor notice (while
 * the chamber's notice is live), a roll call, a labelled bill card — in
 * English (SEND_LANGS), at most DAILY_CAP a day per platform, newest record
 * first. Before sending, it rebuilds the queue from the committed record at
 * this moment and sends an item only if the rebuilt draft is the same text:
 * the drafter's live gate, record-lag gate and every other gate run again at
 * send time. An item whose record date is older than the drafter's own window
 * (lib/today.ts BRIEF_WINDOW_DAYS) is refused.
 *
 * WHAT IT NEVER DOES, by construction: answer, tag, endorse or re-share
 * anyone's post, follow anyone, search a platform, read a feed, or send a
 * direct message. The only platform calls in this file are, for Bluesky,
 * com.atproto.server.createSession, com.atproto.repo.getRecord and
 * putRecord (the profile's "bot" self-label, the automated-account label the
 * platform's bot guide recommends) and com.atproto.repo.createRecord for
 * app.bsky.feed.post; for Telegram, sendMessage to the one channel.
 * tests/social-send.unit.spec.ts reads this file's source and fails if any
 * other platform method, or any word for those interactions, appears in code.
 *
 * SECRETS (rule 10): read from the environment, sent only in the request to
 * their own platform, never printed. Error lines print an HTTP status and the
 * platform's short error code only, never a request address (Telegram's
 * carries the bot token) and never a body we sent.
 *
 * Every platform call goes through a `fetch` passed in as a parameter, so the
 * spec runs the whole path against a fake and never makes a real request.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_OUT_DIR, QUEUE_SCHEMA, assertOutsideRepo, buildQueue } from './social-drafts.mjs';
import { BRIEF_WINDOW_DAYS, briefToday, easternDate, shiftDate } from '../lib/today';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** The kinds this sender may post: the record kinds plus labelled bill cards. */
export const SEND_KINDS = Object.freeze(['floor-notice', 'roll-call', 'bill-card']);

/** Posts a day, per platform. The research page's cadence for session days
 *  is one to three a day; three is the ceiling. */
export const DAILY_CAP = 3;

/** English only for now: whether the Spanish label reads right in a post is
 *  still the owner's open question. */
export const SEND_LANGS = Object.freeze(['en']);

/** The oldest record date an item may carry, in days before today (Eastern):
 *  the drafter's own window, today and the 13 days before. */
export const MAX_FACT_AGE_DAYS = BRIEF_WINDOW_DAYS - 1;

export const SWITCH_FILE = 'data/social-sending.json';
export const SECRET_NAMES = Object.freeze(['BLUESKY_HANDLE', 'BLUESKY_APP_PASSWORD', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL']);
export const PLATFORMS = Object.freeze(['bluesky', 'telegram']);

/** Which form of a draft each platform takes. Bluesky's post limit is 300
 *  characters, so it takes the drafter's short form (280 at most). */
export const PLATFORM_FORM = Object.freeze({ bluesky: 'short', telegram: 'long' });

export const BLUESKY_SERVICE = 'https://bsky.social';
export const TELEGRAM_API = 'https://api.telegram.org';
const TELEGRAM_GAP_MS = 1100; // the platform asks for at most one message a second in one chat

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /https:\/\/[^\s]+/g;
const OWN_LINK_RE = /^https:\/\/oravan\.org(\/es)?\/(bills|questions|today)\/[a-z0-9-]+$/;
/** An @handle in the text would read as tagging someone. */
const HANDLE_RE = /(^|[\s(])@[\p{L}\p{N}._-]+/u;

/* ------------------------------------------------------------------ *
 * The kill switch
 * ------------------------------------------------------------------ */

/** Layer (b): the committed switch file, read strictly. Anything but the
 *  exact owner shape is off. */
export function readSwitchFile(path = resolve(process.cwd(), SWITCH_FILE)) {
  if (!existsSync(path)) return { on: false, reason: `${SWITCH_FILE} is missing` };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { on: false, reason: `${SWITCH_FILE} is not valid JSON` };
  }
  return switchFileState(parsed);
}

export function switchFileState(parsed) {
  if (!parsed || typeof parsed !== 'object') return { on: false, reason: `${SWITCH_FILE} is not an object` };
  if (parsed.enabled !== true) return { on: false, reason: `${SWITCH_FILE} says enabled: ${JSON.stringify(parsed.enabled)}` };
  if (typeof parsed.since !== 'string' || !DATE_RE.test(parsed.since)) return { on: false, reason: `${SWITCH_FILE} has no "since" date` };
  if (parsed.by !== 'owner') return { on: false, reason: `${SWITCH_FILE} is not signed "by": "owner"` };
  return { on: true, reason: `${SWITCH_FILE} enabled since ${parsed.since} by the owner` };
}

/** The names of the platform secrets that are missing (never their values). */
export function missingSecrets(env) {
  return SECRET_NAMES.filter((n) => typeof env[n] !== 'string' || env[n].trim() === '');
}

/**
 * The three layers together. `send` is true only when every layer is on and
 * no dry run was asked for. `reasons` names each layer that is off.
 */
/** @param {{ env: Record<string, string | undefined>, switchFile: { on: boolean, reason: string } | null, dryRunFlag?: boolean }} args */
export function switchState({ env, switchFile, dryRunFlag = false }) {
  const reasons = [];
  if (dryRunFlag) reasons.push('--dry-run was given');
  if (env.SOCIAL_SEND !== 'on') reasons.push('SOCIAL_SEND is not "on"');
  if (!switchFile?.on) reasons.push(switchFile?.reason ?? `${SWITCH_FILE} was not read`);
  const missing = missingSecrets(env);
  if (missing.length) reasons.push(`secrets not set: ${missing.join(', ')}`);
  return { send: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ *
 * Picking the day's items
 * ------------------------------------------------------------------ */

const KIND_ORDER = Object.fromEntries(SEND_KINDS.map((k, i) => [k, i]));

/** The text a platform would carry for one item in one language, or null. */
export function formText(item, lang, platform) {
  return item?.variants?.[lang]?.[PLATFORM_FORM[platform]]?.text ?? null;
}

/**
 * Checks one outbound text against what the drafter promised, and refuses
 * the item otherwise. Returns null when it may go, or the reason.
 */
export function outboundGuard(item, lang, platform) {
  const v = item?.variants?.[lang]?.[PLATFORM_FORM[platform]];
  if (!v?.text) return `no ${PLATFORM_FORM[platform]} form`;
  const segs = v.segments ?? [];
  const hasAi = segs.some((s) => s.from === 'ai');
  const labels = segs.filter((s) => s.from === 'label');
  // Rule 4: AI-written text goes out only with its label, and the label is in the text.
  if (hasAi && labels.length === 0) return 'AI-written text without its label';
  if (item.aiLabel !== hasAi) return 'the queue item and its text disagree on the AI label';
  for (const l of labels) if (!v.text.includes(l.text)) return 'the AI label is not in the text';
  // The bill's own page address, exactly once.
  const urls = v.text.match(URL_RE) ?? [];
  const own = urls.filter((u) => u.startsWith('https://oravan.org'));
  if (own.length !== 1 || !OWN_LINK_RE.test(own[0])) return 'not exactly one canonical Oravan page address';
  if (HANDLE_RE.test(v.text)) return 'an @handle in the text';
  return null;
}

/**
 * The items to send now, per platform: queue items of the send kinds, in the
 * send languages, that the fresh rebuild still produces with the same text,
 * whose record date is inside the window, not yet sent on that platform, one
 * per bill a day, and no more than the cap minus what that platform already
 * sent today.
 *
 * `fresh` is the queue rebuilt at send time (buildQueue); `ledger` is the
 * list of what was already sent; `today` is the Eastern date of `now`.
 */
/** @param {{ queue: any, fresh: any, ledger?: any[], today: string, cap?: number }} args */
export function pickItems({ queue, fresh, ledger = [], today, cap = DAILY_CAP }) {
  if (queue?.schema !== QUEUE_SCHEMA) throw new Error(`social-send: queue schema is ${queue?.schema}, expected ${QUEUE_SCHEMA}`);
  const oldest = shiftDate(today, -MAX_FACT_AGE_DAYS);
  const freshById = new Map((fresh?.items ?? []).map((i) => [i.id, i]));
  const refused = [];
  const candidates = [];
  for (const item of queue.items ?? []) {
    if (!SEND_KINDS.includes(item.kind)) continue;
    if (!item.factDate || !DATE_RE.test(item.factDate)) {
      refused.push({ id: item.id, reason: 'no record date' });
      continue;
    }
    if (item.factDate < oldest) {
      refused.push({ id: item.id, reason: `record date ${item.factDate} is older than the window (${oldest})` });
      continue;
    }
    if (item.factDate > today) {
      refused.push({ id: item.id, reason: `record date ${item.factDate} is after today (${today})` });
      continue;
    }
    const again = freshById.get(item.id);
    if (!again) {
      refused.push({ id: item.id, reason: 'the drafter no longer produces it from the record (a gate drops it now)' });
      continue;
    }
    candidates.push({ item, again });
  }
  candidates.sort(
    (a, b) =>
      (b.item.factDate ?? '').localeCompare(a.item.factDate ?? '') ||
      KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] ||
      a.item.id.localeCompare(b.item.id),
  );
  /** @type {{ bluesky: any[], telegram: any[] }} */
  const picks = { bluesky: [], telegram: [] };
  for (const platform of PLATFORMS) {
    const sentToday = ledger.filter((e) => e.platform === platform && e.day === today);
    let room = Math.max(0, cap - sentToday.length);
    // One post per bill per day and language: three amendment votes on one
    // bill would crowd out everything else the record holds.
    const billsToday = new Set(sentToday.map((e) => `${e.slug}|${e.lang}`));
    picks[platform] = [];
    for (const { item, again } of candidates) {
      for (const lang of SEND_LANGS) {
        if (room === 0) break;
        if (ledger.some((e) => e.platform === platform && e.id === item.id && e.lang === lang && e.factDate === item.factDate)) continue;
        const slug = item.ref?.slug ?? null;
        if (slug && billsToday.has(`${slug}|${lang}`)) continue;
        const text = formText(item, lang, platform);
        if (!text || text !== formText(again, lang, platform)) {
          refused.push({ id: item.id, platform, lang, reason: text ? 'the rebuilt draft reads differently now' : `no ${PLATFORM_FORM[platform]} form` });
          continue;
        }
        const guard = outboundGuard(item, lang, platform);
        if (guard) {
          refused.push({ id: item.id, platform, lang, reason: guard });
          continue;
        }
        picks[platform].push({ id: item.id, kind: item.kind, slug, lang, factDate: item.factDate, text });
        if (slug) billsToday.add(`${slug}|${lang}`);
        room -= 1;
      }
    }
  }
  return { picks, refused };
}

/* ------------------------------------------------------------------ *
 * Bluesky (AT Protocol over HTTP)
 * ------------------------------------------------------------------ */

const utf8 = new TextEncoder();

/** Link facets for every https address in the text, by UTF-8 byte offsets. */
export function linkFacets(text) {
  const facets = [];
  for (const m of text.matchAll(URL_RE)) {
    const byteStart = utf8.encode(text.slice(0, m.index)).length;
    const byteEnd = byteStart + utf8.encode(m[0]).length;
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }],
    });
  }
  return facets;
}

/** The post record: text, its language, its link facets. Nothing else. */
export function blueskyPostRecord(pick, createdAt) {
  return {
    $type: 'app.bsky.feed.post',
    text: pick.text,
    langs: [pick.lang],
    facets: linkFacets(pick.text),
    createdAt,
  };
}

/** An error line that names a status and the platform's short code only. */
class PlatformError extends Error {}

async function xrpc(fetchImpl, method, { token, body, query, service = BLUESKY_SERVICE }) {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const res = await fetchImpl(`${service}/xrpc/${method}${qs}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const code = typeof json?.error === 'string' ? json.error.slice(0, 40) : 'no error code';
    throw new PlatformError(`bluesky ${method}: HTTP ${res.status} (${code})`);
  }
  return json;
}

/** Signs in with the app password. Returns the access token and the account id. */
export async function blueskySession(fetchImpl, env) {
  const s = await xrpc(fetchImpl, 'com.atproto.server.createSession', {
    body: { identifier: env.BLUESKY_HANDLE, password: env.BLUESKY_APP_PASSWORD },
  });
  if (!s?.accessJwt || !s?.did) throw new PlatformError('bluesky createSession: no session in the answer');
  return { token: s.accessJwt, did: s.did };
}

/**
 * The profile carries the "bot" self-label before anything is posted. Reads
 * the profile record; when the label is missing, writes the same record back
 * with it added (guarded by the record's cid). Returns 'present' or 'added'.
 */
export async function ensureBotLabel(fetchImpl, session) {
  let existing = null;
  let cid = null;
  try {
    const got = await xrpc(fetchImpl, 'com.atproto.repo.getRecord', {
      query: { repo: session.did, collection: 'app.bsky.actor.profile', rkey: 'self' },
    });
    existing = got?.value ?? null;
    cid = got?.cid ?? null;
  } catch (e) {
    // A brand-new account has no profile record yet; anything else stops here.
    if (!(e instanceof PlatformError) || !/HTTP 400 \(RecordNotFound\)/.test(e.message)) throw e;
  }
  const values = existing?.labels?.values ?? [];
  if (values.some((v) => v?.val === 'bot')) return 'present';
  const record = {
    ...(existing ?? {}),
    $type: 'app.bsky.actor.profile',
    labels: { $type: 'com.atproto.label.defs#selfLabels', values: [...values, { val: 'bot' }] },
  };
  await xrpc(fetchImpl, 'com.atproto.repo.putRecord', {
    token: session.token,
    body: { repo: session.did, collection: 'app.bsky.actor.profile', rkey: 'self', record, ...(cid ? { swapRecord: cid } : {}) },
  });
  return 'added';
}

export async function blueskyPost(fetchImpl, session, pick, createdAt) {
  const out = await xrpc(fetchImpl, 'com.atproto.repo.createRecord', {
    token: session.token,
    body: { repo: session.did, collection: 'app.bsky.feed.post', record: blueskyPostRecord(pick, createdAt) },
  });
  return out?.uri ?? null;
}

/* ------------------------------------------------------------------ *
 * Telegram (Bot API, one channel)
 * ------------------------------------------------------------------ */

export const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The sendMessage body: the text, HTML-escaped, and the preview pointed at
 *  the bill's page (a floor notice also carries the chamber's source link). */
export function telegramMessage(pick, channel) {
  const own = (pick.text.match(URL_RE) ?? []).find((u) => u.startsWith('https://oravan.org'));
  return {
    chat_id: channel,
    text: escapeHtml(pick.text),
    parse_mode: 'HTML',
    ...(own ? { link_preview_options: { url: own } } : {}),
  };
}

export async function telegramSend(fetchImpl, env, pick) {
  // The address carries the bot token: it is built here and never printed.
  const res = await fetchImpl(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(telegramMessage(pick, env.TELEGRAM_CHANNEL)),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || json?.ok !== true) {
    const code = typeof json?.error_code === 'number' ? json.error_code : 'no error code';
    throw new PlatformError(`telegram sendMessage: HTTP ${res.status} (${code})`);
  }
  return json?.result?.message_id ?? null;
}

/* ------------------------------------------------------------------ *
 * Ledger: what was sent, outside the repository
 * ------------------------------------------------------------------ */

export function readLedger(path) {
  if (!path || !existsSync(path)) return [];
  try {
    const l = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(l?.sent) ? l.sent : [];
  } catch {
    throw new Error(`social-send: the ledger at ${path} is not valid JSON; fix or move it before sending`);
  }
}

function writeLedger(path, sent) {
  assertOutsideRepo(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schema: 'social-sent/v1', sent }, null, 2) + '\n');
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

export function dryRunText({ picks, refused, state, today }) {
  const lines = [
    `social-send: DRY RUN for ${today}. Nothing was sent.`,
    ...state.reasons.map((r) => `  off: ${r}`),
    '',
  ];
  for (const platform of PLATFORMS) {
    lines.push(`== ${platform} (${PLATFORM_FORM[platform]} form, ${picks[platform].length} of at most ${DAILY_CAP}) ==`);
    for (const p of picks[platform]) lines.push(`-- ${p.id} [${p.lang}] record date ${p.factDate}`, p.text, '');
    if (!picks[platform].length) lines.push('(nothing to send)', '');
  }
  if (refused.length) {
    lines.push('== refused ==');
    for (const r of refused) lines.push(`- ${r.id}${r.platform ? ` ${r.platform}` : ''}${r.lang ? ` [${r.lang}]` : ''}: ${r.reason}`);
  }
  return lines.join('\n');
}

/**
 * The whole run with every outside dependency passed in. Returns
 * { mode: 'dry-run' | 'sent', exitCode, sent, errors, picks, refused }.
 */
/**
 * @param {{
 *   argv?: string[],
 *   env?: Record<string, string | undefined>,
 *   fetchImpl?: (url: string, init?: any) => Promise<any>,
 *   now?: number,
 *   log?: (line: string) => void,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   switchFilePath?: string,
 *   rebuild?: (instant: number) => any,
 * }} options
 */
export async function run({
  argv = [],
  env = {},
  fetchImpl,
  now = Date.now(),
  log = console.log,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  switchFilePath,
  rebuild = (instant) => buildQueue({ now: instant }),
}) {
  const args = { dryRun: false, queue: null, queueDir: DEFAULT_OUT_DIR, ledger: null, now };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--queue') args.queue = argv[++i];
    else if (a === '--queue-dir') args.queueDir = argv[++i];
    else if (a === '--ledger') args.ledger = argv[++i];
    else if (a === '--now') {
      args.now = Date.parse(argv[++i]);
      if (!Number.isFinite(args.now)) throw new Error('social-send: --now needs an ISO instant');
    } else throw new Error(`social-send: unknown argument ${a}`);
  }

  const state = switchState({ env, switchFile: readSwitchFile(switchFilePath), dryRunFlag: args.dryRun });
  const fresh = rebuild(args.now);
  const queuePath = args.queue ?? join(args.queueDir, fresh.briefDay ?? briefToday(), 'queue.json');
  const ledgerPath = args.ledger ?? join(dirname(dirname(resolve(queuePath))), 'sent-ledger.json');
  const today = easternDate(args.now);

  if (!existsSync(queuePath)) {
    log(`social-send: no queue at ${queuePath}. Run scripts/social-drafts.mjs first.`);
    return { mode: state.send ? 'sent' : 'dry-run', exitCode: state.send ? 1 : 0, sent: [], errors: ['no queue'], picks: null, refused: [] };
  }
  const queue = JSON.parse(readFileSync(queuePath, 'utf8'));
  const ledger = readLedger(ledgerPath);
  const { picks, refused } = pickItems({ queue, fresh, ledger, today });

  if (!state.send) {
    log(dryRunText({ picks, refused, state, today }));
    return { mode: 'dry-run', exitCode: 0, sent: [], errors: [], picks, refused };
  }

  if (typeof fetchImpl !== 'function') throw new Error('social-send: no fetchImpl was given');
  const sent = [...ledger];
  const done = [];
  const errors = [];
  const record = (platform, p, ref) => {
    const entry = { platform, id: p.id, slug: p.slug, lang: p.lang, factDate: p.factDate, day: today, at: new Date(args.now).toISOString(), ref };
    sent.push(entry);
    done.push(entry);
    writeLedger(ledgerPath, sent);
  };

  if (picks.bluesky.length) {
    try {
      const session = await blueskySession(fetchImpl, env);
      const label = await ensureBotLabel(fetchImpl, session);
      log(`social-send: bluesky profile bot self-label ${label}`);
      for (const p of picks.bluesky) {
        const uri = await blueskyPost(fetchImpl, session, p, new Date(args.now).toISOString());
        record('bluesky', p, uri);
        log(`social-send: bluesky posted ${p.id} [${p.lang}]`);
      }
    } catch (e) {
      errors.push(e instanceof PlatformError ? e.message : 'bluesky: the request failed before an answer');
    }
  }
  for (const [i, p] of picks.telegram.entries()) {
    try {
      if (i > 0) await sleep(TELEGRAM_GAP_MS);
      const id = await telegramSend(fetchImpl, env, p);
      record('telegram', p, id);
      log(`social-send: telegram posted ${p.id} [${p.lang}]`);
    } catch (e) {
      errors.push(e instanceof PlatformError ? e.message : 'telegram: the request failed before an answer');
      break;
    }
  }
  for (const err of errors) log(`social-send: ${err}`);
  log(`social-send: ${done.length} sent, ${errors.length} error(s), ledger ${ledgerPath}`);
  return { mode: 'sent', exitCode: errors.length ? 1 : 0, sent: done, errors, picks, refused };
}

// Run-directly guard without `import.meta` (Playwright transpiles an imported
// .mjs to CJS; scripts/social-drafts.mjs carries the same guard).
if (/(^|\/)social-send\.mjs$/.test(process.argv[1] ?? '') && /(^|\/)scripts\//.test(process.argv[1] ?? '')) {
  run({ argv: process.argv.slice(2), env: process.env, fetchImpl: globalThis.fetch })
    .then((r) => process.exit(r.exitCode))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : 'social-send: failed');
      process.exit(1);
    });
}

import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getUpdates, groupUpdatesByDay } from '../lib/moment-updates';
import { getBill } from '../lib/core/bills';
import { floorSignalsFile } from '../lib/docket';
import { briefWindow, buildBrief } from '../lib/today';
// SOCIAL DRAFTS, DRY RUN — scripts/social-drafts.mjs.
//
// The script drafts post and reply text from the committed record into a
// review queue outside the repo, and sends nothing. What is pinned here:
//   1. every gate drops a seeded violation (and never repairs it);
//   2. the queue is never written inside a repository;
//   3. the same data and the same `now` give the same queue;
//   4. the script's source imports no network module and calls no fetch;
//   5. every draft has its Spanish forms, and every link is the canonical page.
import {
  AI_LABEL_KEYS,
  GATES,
  KINDS,
  PLATFORM_LIMITS,
  admit,
  assertOutsideRepo,
  buildQueue,
  collectCandidates,
  composeBillCard,
  composeFloorNotice,
  composeQuestionUpdate,
  composeReplyCard,
  composeRollCall,
  composeToday,
  gateDraft,
  lagReason,
  latestUpdate,
  msg,
  normalizeAction,
  queueMarkdown,
  recordContext,
  trailsRecord,
} from '../scripts/social-drafts.mjs';

type Seg = { k: string; text: string; key?: string; values?: Record<string, unknown>; raw?: string; iso?: string; dates?: string[] };
type Draft = {
  kind: string;
  ref: Record<string, unknown>;
  factDate: string | null;
  recordQuotes: string[];
  href: string;
  titles?: string[];
  segments: { en: Seg[]; es: Seg[] };
};

const SOURCE = readFileSync(join(process.cwd(), 'scripts/social-drafts.mjs'), 'utf8');

/* ---- seeded record ------------------------------------------------------ */

const ANNOUNCEMENT = {
  quote: 'H.R. 100 — To rename a post office (Rep. Doe / Committee on Oversight).',
  url: 'https://docs.house.gov/billsthisweek/20260928/20260928.xml',
  published: '2026-09-28',
  covers: '2026-09-28',
  coversLabel: null,
  source: 'billsthisweek',
  chamber: 'house',
};

const ROLL_CALL = {
  id: 'h-119-2-300',
  chamber: 'house',
  roll: 300,
  question: 'On Passage',
  result: 'Passed',
  totals: { yea: 300, nay: 100, present: 0, notVoting: 31 },
  bill: { slug: 'hr-100-119', citation: 'H.R. 100', title: 'Post Office Act' },
};

const HEADLINE = {
  en: { text: 'Renames a post office in Springfield', lang: 'en' },
  es: { text: 'Cambia el nombre de una oficina de correos en Springfield', lang: 'es' },
};

const BILL_CARD_INPUT = {
  slug: 'hr-100-119',
  citation: 'H.R. 100',
  headline: HEADLINE,
  status: 'open',
  lastActionDate: '2026-09-28',
  title: 'Post Office Act',
};

const UPDATE = {
  id: 'u_1',
  day: '2026-09-27',
  ai: true,
  text: { en: 'The House passed the bill.', es: 'La Cámara aprobó el proyecto.' },
};

/** A context that knows exactly the seeded record. */
const ctx = {
  liveAnnouncement: (slug: string) => (slug === 'hr-100-119' ? ANNOUNCEMENT : null),
  recordDates: (d: Draft) => {
    const byKind: Record<string, string[]> = {
      'floor-notice': ['2026-09-28'],
      'roll-call': ['2026-09-28'],
      'bill-card': ['2026-09-28'],
      'reply-card': ['2026-09-28'],
      'big-question-update': ['2026-09-27'],
      today: ['2026-09-28'],
    };
    return new Set(byKind[d.kind] ?? []);
  },
};

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const seeds = (): Record<string, Draft> => ({
  floor: composeFloorNotice({ slug: 'hr-100-119', citation: 'H.R. 100', a: ANNOUNCEMENT }),
  roll: composeRollCall({ rc: ROLL_CALL, date: '2026-09-28', citation: 'H.R. 100' }),
  card: composeBillCard(BILL_CARD_INPUT),
  question: composeQuestionUpdate({ id: 'post-offices', name: { en: 'Post offices', es: 'Oficinas de correos' }, update: UPDATE }),
  today: composeToday({ summary: { date: '2026-09-28', votes: 2, bills: 5, questions: 0 } }),
  reply: composeReplyCard({ slug: 'hr-100-119', citation: 'H.R. 100', headline: HEADLINE, title: 'Post Office Act' }),
});

/** Apply `fn` to both languages' segments of a copy of `draft`. */
function seeded(draft: Draft, fn: (segs: Seg[], lang: 'en' | 'es') => Seg[]): Draft {
  const d = clone(draft);
  d.segments.en = fn(d.segments.en, 'en');
  d.segments.es = fn(d.segments.es, 'es');
  return d;
}

function expectDropped(draft: Draft, gate: string) {
  const fail = gateDraft(draft, ctx);
  expect(fail, `expected a ${gate} drop`).not.toBeNull();
  expect(fail!.gate).toBe(gate);
  const { items, dropped } = admit([draft], ctx);
  expect(items).toHaveLength(0);
  expect(dropped).toHaveLength(1);
  expect(dropped[0].gate).toBe(gate);
  return fail!;
}

/* ---- the clean seeds pass ------------------------------------------------ */

test('every seeded draft passes every gate as composed', () => {
  for (const [name, d] of Object.entries(seeds())) {
    expect(gateDraft(d, ctx), name).toBeNull();
  }
});

/* ---- rule 3 --------------------------------------------------------------- */

test.describe('rule 3: lintForbidden on composed text', () => {
  test('a forbidden word Oravan composed is dropped, in English and in Spanish', () => {
    const en = seeded(seeds().today, (s, lang) =>
      lang === 'en' ? [...s, { k: 'sep', text: ' ' }, { k: 'citation', text: 'fight' }] : s
    );
    expect(expectDropped(en, 'rule3').lang).toBe('en');
    const es = seeded(seeds().today, (s, lang) =>
      lang === 'es' ? [...s, { k: 'sep', text: ' ' }, { k: 'citation', text: 'luchar' }] : s
    );
    expect(expectDropped(es, 'rule3').lang).toBe('es');
  });

  test('the same word inside a record quote is exempt, as the site exempts it', () => {
    const rc = { ...ROLL_CALL, question: 'On Motion to Suspend the Rules and Pass: Stop Fentanyl Act' };
    const d = composeRollCall({ rc, date: '2026-09-28', citation: 'H.R. 100' });
    expect(gateDraft(d, ctx)).toBeNull();
  });
});

/* ---- rule 4 --------------------------------------------------------------- */

test.describe('rule 4: the AI label', () => {
  test('AI-written text without its label is dropped', () => {
    for (const d of [seeds().card, seeds().reply, seeds().question]) {
      expectDropped(seeded(d, (s) => s.filter((x) => x.k !== 'label')), 'rule4');
    }
  });

  test('a label that is not the site\'s own string is dropped', () => {
    const d = seeded(seeds().card, (s) => s.map((x) => (x.k === 'label' ? { ...x, text: 'Made by a robot' } : x)));
    expectDropped(d, 'rule4');
  });

  test('a draft of record quotes and numbers carries no AI label', () => {
    const d = seeded(seeds().roll, (s, lang) => [
      ...s,
      { k: 'sep', text: ' (' },
      { k: 'label', key: AI_LABEL_KEYS.bill, text: msg(lang, AI_LABEL_KEYS.bill) },
      { k: 'sep', text: ')' },
    ]);
    expectDropped(d, 'rule4');
  });

  test('the labels are the site\'s existing messages', () => {
    for (const key of Object.values(AI_LABEL_KEYS)) {
      expect(msg('en', key)).toBeTruthy();
      expect(msg('es', key)).toBeTruthy();
    }
  });
});

/* ---- rule 6 --------------------------------------------------------------- */

test.describe('rule 6: the record, quoted, never narrated', () => {
  test('a floor notice is drafted only while the live gate says it is live', () => {
    const d = composeFloorNotice({ slug: 'hr-999-119', citation: 'H.R. 999', a: { ...ANNOUNCEMENT } });
    const fail = expectDropped(d, 'rule6');
    expect(fail.reason).toMatch(/not live/);
  });

  test('a paraphrased quote is dropped', () => {
    const d = seeded(seeds().floor, (s) =>
      s.map((x) => (x.k === 'quote' ? { ...x, raw: 'The House will rename a post office.', text: '“The House will rename a post office.”' } : x))
    );
    expectDropped(d, 'rule6');
  });

  test('a date the record does not hold is dropped', () => {
    const d = composeRollCall({ rc: ROLL_CALL, date: '2026-09-30', citation: 'H.R. 100' });
    d.factDate = '2026-09-28';
    expectDropped(d, 'rule6');
  });

  test('a time of day in Oravan\'s own words is dropped', () => {
    const d = seeded(seeds().roll, (s) => [...s, { k: 'sep', text: ' ' }, { k: 'citation', text: 'at 2:15 p.m.' }]);
    expectDropped(d, 'rule6');
  });

  test('a fact without its date printed is dropped', () => {
    const d = seeded(seeds().roll, (s) => s.filter((x) => x.k !== 'date'));
    expectDropped(d, 'rule6');
  });
});

/* ---- links (rule 1, the 2026-09-26 decision) ------------------------------ */

test.describe('links: the canonical page, nothing else', () => {
  const swapLink = (d: Draft, to: (url: string) => string) =>
    seeded(d, (s) => s.map((x) => (x.k === 'link' ? { ...x, text: to(x.text) } : x)));

  test('a query string, a fragment or a stance is dropped', () => {
    expectDropped(swapLink(seeds().card, (u) => `${u}?utm_source=social`), 'link');
    expectDropped(swapLink(seeds().card, (u) => `${u}?stance=support`), 'link');
    expectDropped(swapLink(seeds().card, (u) => `${u}#call`), 'link');
  });

  test('the call flow and a phone dialer are dropped', () => {
    expectDropped(swapLink(seeds().card, (u) => u.replace('/bills/hr-100-119', '/call/hr-100-119')), 'link');
    const tel = seeded(seeds().card, (s) => [...s, { k: 'sep', text: ' ' }, { k: 'link', text: 'tel:+12025551234' }]);
    expectDropped(tel, 'link');
  });

  test('the other language\'s page is dropped', () => {
    expectDropped(swapLink(seeds().card, (u) => u.replace('/es/', '/')), 'link');
  });

  test('a stray URL inside published text is dropped', () => {
    const d = seeded(seeds().card, (s) => s.map((x) => (x.k === 'ai' ? { ...x, text: `${x.text} https://example.org/x` } : x)));
    expectDropped(d, 'link');
  });

  test('a source link only on a floor notice, only on a government host, no query', () => {
    const onCard = seeded(seeds().card, (s) => [...s, { k: 'sep', text: '\n' }, { k: 'source-link', text: 'https://www.congress.gov/x' }]);
    expectDropped(onCard, 'link');
    const offHost = seeded(seeds().floor, (s) => s.map((x) => (x.k === 'source-link' ? { ...x, text: 'https://example.com/schedule' } : x)));
    expectDropped(offHost, 'link');
  });
});

/* ---- tone ------------------------------------------------------------------ */

test('tone: urgency or instruction in Oravan\'s words is dropped', () => {
  expectDropped(seeded(seeds().today, (s) => [...s, { k: 'sep', text: ' ' }, { k: 'citation', text: 'Call now' }]), 'tone');
  expectDropped(seeded(seeds().today, (s) => [...s, { k: 'sep', text: ' ' }, { k: 'citation', text: 'This matters' }]), 'tone');
});

/* ---- rule 9 ---------------------------------------------------------------- */

test.describe('rule 9: no other product or organization', () => {
  test('free text in Oravan\'s separators is dropped', () => {
    expectDropped(seeded(seeds().today, (s) => [...s, { k: 'sep', text: ' via a newsroom' }]), 'rule9');
  });

  test('a web address outside a record quote is dropped', () => {
    const dom = seeded(seeds().card, (s) => s.map((x) => (x.k === 'ai' ? { ...x, text: `${x.text}, per example.com` } : x)));
    expectDropped(dom, 'rule9');
  });

  test('a message that is not the site\'s verbatim text is dropped', () => {
    const d = seeded(seeds().today, (s) => s.map((x) => (x.k === 'msg' && x.key === 'today.titleDated' ? { ...x, text: x.text.replace('Congress', 'Our Congress') } : x)));
    expectDropped(d, 'rule9');
  });

  test('a name inside a record quote is the record\'s and passes', () => {
    const rc = { ...ROLL_CALL, question: 'On Passage of the Bill (example.com Data Act)' };
    expect(gateDraft(composeRollCall({ rc, date: '2026-09-28', citation: 'H.R. 100' }), ctx)).toBeNull();
  });
});

/* ---- "the president" ------------------------------------------------------- */

test('"the president" style: a headline that is not in style is dropped, not fixed', () => {
  const headline = {
    en: { text: 'Resolution would direct President to halt action', lang: 'en' },
    es: { text: 'La resolución pediría al Presidente detener la acción', lang: 'es' },
  };
  expectDropped(composeBillCard({ ...BILL_CARD_INPUT, headline }), 'president');
});

/* ---- the latest update, and the record-lag gate --------------------------- */

const FUNDING = 'government-funding-deadline';
const NOW = Date.parse('2026-09-29T20:00:00Z');

test('latest update: the pick is the top of the site\'s own timeline, the same on every run', () => {
  const first = latestUpdate(FUNDING);
  const again = latestUpdate(FUNDING);
  expect(first).not.toBeNull();
  expect(again!.update.id).toBe(first!.update.id);
  const newest = groupUpdatesByDay(FUNDING, 60, NOW).find((g) => !g.quiet)!;
  expect(first!.update.id).toBe(newest.updates[0].id);
  expect(first!.update.day).toBe(newest.day);
});

test('latest update: same-day updates the data cannot order are marked, not silently picked', () => {
  const l = latestUpdate(FUNDING)!;
  const day = getUpdates(FUNDING).filter((u) => u.day === l.update.day);
  expect(day.length).toBeGreaterThan(1);
  expect(l.tied.length).toBeGreaterThan(0);
  for (const t of l.tied) expect(t.id).not.toBe(l.update.id);
  const d = composeQuestionUpdate({ id: FUNDING, name: { en: 'x', es: 'x' }, update: l.update, tied: l.tied }) as Draft & {
    sameDayTie?: boolean;
    sameDayOthers?: { id: string; text: { en: string } }[];
  };
  expect(d.sameDayTie).toBe(true);
  expect(d.sameDayOthers!.map((o) => o.id)).toEqual(l.tied.map((t) => t.id));
  expect(d.sameDayOthers![0].text.en.length).toBeGreaterThan(0);
  expect((seeds().question as Draft & { sameDayTie?: boolean }).sameDayTie).toBeUndefined();
});

test('record-lag: a settled bill whose update reads differently is dropped and counted', () => {
  const billWord = 'law';
  const settledOn = ['Became Public Law No: 119-103.', null];
  expect(lagReason({ billWord, settledOn, updateText: 'Presented to President.' })).toMatch(/behind the record.*"law"/);
  expect(lagReason({ billWord, settledOn, updateText: 'Became Public Law No: 119-103.' })).toBeNull();
  expect(lagReason({ billWord: 'open', settledOn, updateText: 'Presented to President.' })).toBeNull();
  expect(lagReason({ billWord, settledOn, updateText: undefined })).toBeNull();
  const lagging = { ...ctx, recordLag: (d: Draft) => (d.kind === 'big-question-update' ? lagReason({ billWord: 'law', settledOn: ['x'], updateText: 'y' }) : null) };
  const fail = gateDraft(seeds().question, lagging);
  expect(fail?.gate).toBe('record-lag');
  const { items, dropped } = admit([seeds().question, seeds().card], lagging);
  expect(items.map((d) => d.kind)).toEqual(['bill-card']);
  expect(dropped.map((d) => d.gate)).toEqual(['record-lag']);
});

test('record-lag on the committed record: the funding question never queues a step behind the law', () => {
  const l = latestUpdate(FUNDING)!;
  const draft = composeQuestionUpdate({ id: FUNDING, name: { en: 'x', es: 'x' }, update: l.update });
  const lag = recordContext(NOW).recordLag(draft);
  const q = buildQueue({ now: NOW });
  const inQueue = q.items.filter((i: { ref: { id?: string } }) => i.ref.id === FUNDING);
  if (lag) {
    expect(q.dropped.some((d: { ref: { id?: string }; gate: string }) => d.ref.id === FUNDING && d.gate === 'record-lag')).toBe(true);
    expect(inQueue).toHaveLength(0);
  } else {
    expect(inQueue).toHaveLength(1);
  }
  // "Presented to President." is a step behind "Became Public Law".
  const presented = getUpdates(FUNDING).find((u) => (u as { record?: { action_text?: string } }).record?.action_text === 'Presented to President.')!;
  const stale = composeQuestionUpdate({ id: FUNDING, name: { en: 'x', es: 'x' }, update: presented });
  expect(recordContext(NOW).recordLag(stale)).toMatch(/"law"/);
  // The update that IS the settling action is not a lag (the war-powers resolution's failed vote).
  const failed = getUpdates('iran-war-powers').find((u) => (u as { record?: { action_text?: string } }).record?.action_text?.startsWith('Failed of passage'))!;
  expect(recordContext(NOW).recordLag(composeQuestionUpdate({ id: 'iran-war-powers', name: { en: 'x', es: 'x' }, update: failed }))).toBeNull();
});

/* ---- record-only, the tie and the trail, in the file a person reads ------- */

const PENNY = 'penny-production-and-cash-rounding';
const CRYPTO = 'crypto-oversight-split-between-sec-and-cftc';
const ATHLETES = 'paying-college-athletes';
const classOf = (id: string, uid: string) => (getUpdates(id).find((u) => u.id === uid) as { class: string }).class;

test('record-only: a press line is never quoted; the newest record line stands in, by the site\'s order', () => {
  const l = latestUpdate(ATHLETES)!;
  expect(classOf(ATHLETES, l.update.id)).not.toBe('press_cluster');
  expect(['vote', 'status_change', 'floor_action']).toContain(classOf(ATHLETES, l.update.id));
  // The press update itself is dropped, under the gate, by the class field.
  const press = getUpdates(ATHLETES).find((u) => (u as { class: string }).class === 'press_cluster')!;
  const draft = composeQuestionUpdate({ id: ATHLETES, name: { en: 'x', es: 'x' }, update: press });
  expect(recordContext(NOW).recordOnly(draft)).toMatch(/press_cluster/);
  const stub = { ...ctx, recordOnly: (d: Draft) => (d.kind === 'big-question-update' ? 'press' : null) };
  expectDroppedWith(seeds().question, 'record-only', stub);
  const q = buildQueue({ now: NOW });
  expect(q.dropped.filter((d: { gate: string }) => d.gate === 'record-only')).toHaveLength(0);
  const item = q.items.find((i: { ref: { id?: string } }) => i.ref.id === ATHLETES)!;
  expect(item.ref.update).toBe(l.update.id);
});

function expectDroppedWith(draft: Draft, gate: string, c: typeof ctx) {
  const fail = gateDraft(draft, c);
  expect(fail?.gate).toBe(gate);
}

test('queue.md shows a same-day tie and a later same-day record action, in the draft\'s language', () => {
  const q = buildQueue({ now: NOW });
  const md = queueMarkdown(q);
  const penny = q.items.find((i: { ref: { id?: string } }) => i.ref.id === PENNY)!;
  expect(penny.sameDayTie).toBe(true);
  expect(penny.trailsRecord).toBe(true);
  expect(penny.laterSameDay.text.en).toMatch(/passed the Senate without amendment/);
  const section = md.slice(md.indexOf(`### ${penny.id}`), md.indexOf('### ', md.indexOf(`### ${penny.id}`) + 5));
  expect(section).toContain('Same day, also on the record (en):');
  expect(section).toContain('Later the same day, on the record (en):');
  expect(section).toContain('Later the same day, on the record (es):');
  expect(section).toContain(penny.laterSameDay.text.es);
  // The draft still quotes what the site's page shows first.
  expect(penny.ref.update).toBe(latestUpdate(PENNY)!.update.id);
});

test('trailsRecord: the crypto shape (a vote quoted; the motion to reconsider is the last action), any class', () => {
  const crypto = q(CRYPTO);
  expect(crypto.trailsRecord).toBe(true);
  expect(crypto.laterSameDay.text.en).toMatch(/motion to reconsider/);
  expect(classOf(CRYPTO, crypto.ref.update)).toBe('vote');
  expect(crypto.ref.update).toBe(latestUpdate(CRYPTO)!.update.id);
  expect(queueMarkdown(buildQueue({ now: NOW }))).toContain('Later the same day, on the record (en):');
});

function q(id: string) {
  return buildQueue({ now: NOW }).items.find((i: { ref: { id?: string } }) => i.ref.id === id)!;
}

test('trailsRecord and lagReason: punctuation is not a difference (both wordings the check found)', () => {
  expect(normalizeAction('Passed  Senate. (text: CR S4000-1)')).toBe('Passed Senate.');
  expect(normalizeAction('Became Public Law No: 119-103.')).toBe(normalizeAction('Became Public Law No. 119-103.'));
  const bill = { last_action_text: 'Passed Senate with an amendment by Yea-Nay Vote. 77 - 22. (text: CR S5044-5063)', status_basis_text: null };
  const own = { id: 'a', day: 'd', vehicle: 'v', record: { action_text: 'Committee discharged.' }, text: { en: 'a', es: 'a' } };
  const later = { id: 'b', day: 'd', vehicle: 'v', record: { action_text: 'Passed Senate with an amendment by Yea-Nay Vote. 77 - 22.' }, text: { en: 'b', es: 'b' } };
  expect(trailsRecord(own, [later], bill)).toEqual({ id: 'b', text: { en: 'b', es: 'b' } });
  expect(trailsRecord(later, [own], bill)).toBeNull();
  const bill2 = { last_action_text: 'Became Public Law No: 119-103.', status_basis_text: null };
  const later2 = { ...later, record: { action_text: 'Became Public Law No. 119-103.' } };
  expect(trailsRecord(own, [later2], bill2)).not.toBeNull();
  // The record-lag gate no longer drops a correct draft over these.
  expect(lagReason({ billWord: 'law', settledOn: ['Became Public Law No: 119-103.'], updateText: 'Became Public Law No. 119-103.' })).toBeNull();
  expect(lagReason({ billWord: 'law', settledOn: ['Passed. (text: CR S4000)'], updateText: 'Passed.' })).toBeNull();
  expect(lagReason({ billWord: 'law', settledOn: ['Became Public Law No: 119-103.'], updateText: 'Signed by President.' })).not.toBeNull();
});

test('the queue and queue.md are reproducible: two runs, same clock, identical output', () => {
  const a = buildQueue({ now: NOW });
  const b = buildQueue({ now: NOW });
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  expect(queueMarkdown(a)).toBe(queueMarkdown(b));
});

/* ---- length ---------------------------------------------------------------- */

test('length: a long form over the limit is dropped; a short form is never a cut quote', () => {
  const long = { ...ANNOUNCEMENT, quote: 'A '.repeat(300).trim() };
  const c = { ...ctx, liveAnnouncement: () => long };
  const d = composeFloorNotice({ slug: 'hr-100-119', citation: 'H.R. 100', a: long });
  const fail = gateDraft(d, c);
  expect(fail?.gate).toBe('length');
  expect(PLATFORM_LIMITS.variants.short.maxChars).toBe(280);
  expect(PLATFORM_LIMITS.variants.long.maxChars).toBe(500);
});

test('every gate named in GATES has a seeded drop above', () => {
  expect(GATES).toEqual(['rule3', 'rule4', 'rule6', 'record-only', 'record-lag', 'link', 'tone', 'rule9', 'president', 'length']);
});

/* ---- the output path ------------------------------------------------------- */

test.describe('the queue is never written inside a repository', () => {
  test('this checkout and any folder in it are refused', () => {
    const repo = process.cwd();
    expect(() => assertOutsideRepo(repo)).toThrow(/refusing/);
    expect(() => assertOutsideRepo(join(repo, 'data'))).toThrow(/refusing/);
    expect(() => assertOutsideRepo('drafts-out')).toThrow(/refusing/);
  });

  test('a folder inside any other working tree is refused too', () => {
    const other = mkdtempSync(join(tmpdir(), 'social-drafts-fake-repo-'));
    mkdirSync(join(other, '.git'));
    expect(() => assertOutsideRepo(join(other, 'drafts', '2026-09-29'))).toThrow(/refusing/);
  });

  test('a folder outside any repository is accepted', () => {
    const out = join(tmpdir(), 'social-drafts-spec');
    expect(assertOutsideRepo(out)).toBe(out);
  });
});

/* ---- no network ------------------------------------------------------------ */

test('the script imports no network module and calls no fetch', () => {
  const imports = [...SOURCE.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
  expect(imports.length).toBeGreaterThan(5);
  for (const spec of imports) {
    expect(spec, `import of ${spec}`).not.toMatch(/^(node:)?(http|https|http2|net|tls|dgram|dns|child_process|worker_threads)$/);
    expect(spec).not.toMatch(/undici|axios|node-fetch|got|ws$/);
  }
  expect(SOURCE).not.toMatch(/\bfetch\s*\(/);
  expect(SOURCE).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
  expect(SOURCE).not.toMatch(/https?\.request|https?\.get\(/);
  // No credential is read: the script touches no environment variable.
  expect(SOURCE).not.toMatch(/process\.env/);
});

/* ---- the committed record ---------------------------------------------------- */

test.describe('on the committed data', () => {
  const NOW = Date.parse('2026-09-29T16:00:00Z');

  test('the same data and the same now give the same queue', () => {
    const a = JSON.stringify(buildQueue({ now: NOW }));
    const b = JSON.stringify(buildQueue({ now: NOW }));
    expect(a).toBe(b);
  });

  test('every queued draft has both languages, both limits and the canonical link', () => {
    const q = buildQueue({ now: NOW });
    expect(q.dryRun).toBe(true);
    expect(q.items.length).toBeGreaterThan(0);
    for (const item of q.items) {
      expect(KINDS).toContain(item.kind);
      for (const lang of ['en', 'es'] as const) {
        const long = item.variants[lang].long;
        expect(long.text, `${item.id} ${lang}`).toBeTruthy();
        expect(long.chars).toBeLessThanOrEqual(500);
        const short = item.variants[lang].short;
        if (short.text) expect(short.chars).toBeLessThanOrEqual(280);
        const urls = long.text.match(/https?:\/\/\S+/g) ?? [];
        const own = urls.filter((u: string) => u.startsWith('https://oravan.org'));
        expect(own).toHaveLength(1);
        expect(own[0]).toMatch(lang === 'es' ? /^https:\/\/oravan\.org\/es\/(bills|questions|today)\/[a-z0-9-]+$/ : /^https:\/\/oravan\.org\/(bills|questions|today)\/[a-z0-9-]+$/);
        for (const u of urls.filter((x: string) => !x.startsWith('https://oravan.org'))) {
          expect(item.kind).toBe('floor-notice');
          expect(new URL(u).search).toBe('');
        }
        // Record quotes stay English inside Spanish drafts, and say so.
        if (lang === 'es') {
          for (const seg of long.segments.filter((s: { from: string }) => s.from === 'quote')) expect(seg.lang).toBe('en');
        }
      }
      const expectAi = ['bill-card', 'reply-card', 'big-question-update'].includes(item.kind);
      expect(item.aiLabel, item.id).toBe(expectAi);
    }
  });

  test('a bill that moved (and had no roll call) becomes a bill card and a reply card', () => {
    // Pins the lookup of each moved bill by its slug: the brief's moved items
    // carry a reference and a card, not the stored bill (lib/today.ts).
    const rollCallSlugs = new Set<string>();
    const movedSlugs = new Set<string>();
    for (const date of briefWindow()) {
      const day = buildBrief(date).days[0];
      for (const rc of day.rollCalls) rollCallSlugs.add(rc.bill.slug);
      for (const mv of day.moved) movedSlugs.add(mv.slug);
    }
    const signalSlugs = new Set(Object.keys(floorSignalsFile().signals ?? {}));
    const onlyMoved = [...movedSlugs].filter((slug) => {
      const bill = getBill(slug);
      return !rollCallSlugs.has(slug) && !signalSlugs.has(slug) && Boolean(bill?.ai_headline?.trim()) && Boolean(bill?.last_action_date);
    });
    expect(onlyMoved.length).toBeGreaterThan(0);
    const { candidates } = collectCandidates({ now: NOW });
    const slugsOf = (kind: string) => new Set(candidates.filter((c) => c.kind === kind).map((c) => (c.ref as { slug?: string }).slug));
    const cards = slugsOf('bill-card');
    const replies = slugsOf('reply-card');
    for (const slug of onlyMoved) {
      expect(cards.has(slug), `bill-card ${slug}`).toBe(true);
      expect(replies.has(slug), `reply-card ${slug}`).toBe(true);
    }
  });

  test('the counts add up', () => {
    const stats = buildQueue({ now: NOW }).stats as unknown as {
      candidates: Record<string, number>;
      admitted: Record<string, number>;
      dropped: Record<string, Record<string, number>>;
    };
    for (const k of KINDS) {
      const drops = Object.values(stats.dropped[k]).reduce((a, b) => a + b, 0);
      expect(stats.admitted[k] + drops).toBe(stats.candidates[k]);
    }
  });
});

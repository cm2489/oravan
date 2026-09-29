import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  composeBillCard,
  composeFloorNotice,
  composeQuestionUpdate,
  composeReplyCard,
  composeRollCall,
  composeToday,
  gateDraft,
  msg,
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
  expect(GATES).toEqual(['rule3', 'rule4', 'rule6', 'link', 'tone', 'rule9', 'president', 'length']);
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

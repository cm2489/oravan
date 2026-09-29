import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// "THE PRESIDENT" — lib/president-style.mjs, the rule in docs/copy-style.md.
//
// Owner, 2026-09-29: "It's 'the president' just FYI for all future copy
// (correct any other copy but first find the rules of how and when
// 'president' is capitalized". Every English and Spanish sentence below is
// copied from the committed corpus as it stood on origin/main 8160a29 (slug in
// the test name) unless it says otherwise, so the cases are the ones the sweep
// actually met, not invented ones.
//
// What is pinned:
//   1. Oravan's own words are restyled: lowercase, with "the".
//   2. The record is never restyled: quotation marks, a bill title copied
//      verbatim, a title before a name, a proper name.
//   3. What the normalizer cannot decide it reports and leaves alone.
//   4. It is idempotent, so a pipeline can run it on every write.
//   5. The prompts that write public text carry the rule, and the writers
//      call the normalizer (by string, zero model calls).
//   6. The site copy (messages/*.json) already follows it.
import {
  PRESIDENT_STYLE_RULE,
  normalizeEnglish,
  normalizePresidentStyle,
  normalizeSpanish,
  presidentStyle,
  presidentStyleSections,
  quotedSpans,
} from '../lib/president-style.mjs';
import { sweepCorpus, sweepMessagesRaw } from '../scripts/president-style.mjs';
import { assembleDecode, buildStructurePrompt, buildSummaryPrompt, decodeTitles } from '../scripts/bill-decode.mjs';
import { draftPrompt, validateDraft } from '../scripts/moment-draft.mjs';
import { buildScriptPrompt, finishScript, PROMPT_VERSION } from '../lib/scriptprompt';
import { buildNominationScriptPrompt, NOMINATION_PROMPT_VERSION } from '../lib/nomination-script';

const en = (s: string, titles: string[] = []) => normalizeEnglish(s, { titles }).text;
const es = (s: string) => normalizeSpanish(s).text;

test.describe('English: our own words become "the president"', () => {
  const cases: Array<[string, string, string]> = [
    // [where, before, after]
    [
      "hconres-89-119 headline (the owner's example)",
      'Resolution would direct president to halt military action against Iran',
      'Resolution would direct the president to halt military action against Iran',
    ],
    [
      'hconres-89-119 summary',
      'This resolution uses a law called the War Powers Resolution to tell the President to stop using U.S. military forces in combat against Iran',
      'This resolution uses a law called the War Powers Resolution to tell the president to stop using U.S. military forces in combat against Iran',
    ],
    ['sentence start keeps its capital on "The"', 'The President would have 90 days to respond.', 'The president would have 90 days to respond.'],
    ['a cost chip that opened on the bare noun', 'President may request exceptions', 'The president may request exceptions'],
    ['another cost chip', 'President has 30 days to deny exemption', 'The president has 30 days to deny exemption'],
    ['hr-7211-119 headline', 'Bill would let President award Ripley the Medal of Honor decades later', 'Bill would let the president award Ripley the Medal of Honor decades later'],
    ['headline', 'Bill would let Congress leaders, not President, pick Librarian and GPO chief', 'Bill would let Congress leaders, not the president, pick Librarian and GPO chief'],
    ['headline', 'HR 9106 waives Medal of Honor time limits so President can honor Air Force pilot Robert Lodge', 'HR 9106 waives Medal of Honor time limits so the president can honor Air Force pilot Robert Lodge'],
    ['headline, possessive', "Bill would repeal 1974 law limiting president's spending power", "Bill would repeal 1974 law limiting the president's spending power"],
    ['headline', 'House bill shifts travel ban power from president to State Department', 'House bill shifts travel ban power from the president to State Department'],
    ['headline', 'Resolution demands president halt combat operations against Iran', 'Resolution demands the president halt combat operations against Iran'],
    ['an office in a list takes no article', 'meaning elections for President, Vice President, U.S. Senate, and U.S. House', 'meaning elections for president, vice president, U.S. Senate, and U.S. House'],
    ['an ordinal before the office', 'Ulysses S. Grant, the Civil War general and 18th President of the United States', 'Ulysses S. Grant, the Civil War general and 18th president of the United States'],
    ['U.S. before the office', 'if the sitting U.S. President sues the IRS and wins.', 'if the sitting U.S. president sues the IRS and wins.'],
    ['coordination shares the article', 'Once a President or Vice President leaves office, they', 'Once a president or vice president leaves office, they'],
    ['vice president, possessive', "the White House, the Vice President's residence, and other", "the White House, the vice president's residence, and other"],
    ['predicate: no article', 'someone can be elected President. Right now, the 22nd Amendment says a person can be elected President only twice', 'someone can be elected president. Right now, the 22nd Amendment says a person can be elected president only twice'],
    ['becomes: no article', 'If someone becomes President without being elected (for example, a Vice President who takes over)', 'If someone becomes president without being elected (for example, a vice president who takes over)'],
    ['plural', 'certain former Presidents to run again; future Presidents would have less power', 'certain former presidents to run again; future presidents would have less power'],
    ['adjective', 'Removing the Presidential permit requirement shifts that decision', 'Removing the presidential permit requirement shifts that decision'],
    ['dashes', 'Congress—not just the President—has a constitutional role', 'Congress—not just the president—has a constitutional role'],
    ['bill.journey.nowPassedBoth (site copy)', 'both chambers have passed it. It goes to the President next.', 'both chambers have passed it. It goes to the president next.'],
    ['a lowercase title before a name is capitalized', 'an executive order from former president Donald Trump', 'an executive order from former President Donald Trump'],
    ['subject of a clause', 'If the President determines those named are responsible', 'If the president determines those named are responsible'],
  ];
  for (const [where, before, after] of cases) {
    test(`${where}: ${before}`, () => {
      expect(en(before)).toBe(after);
    });
  }
});

test.describe('English: the record and proper names are never restyled', () => {
  const kept: Array<[string, string]> = [
    ['title before a name (sjres-200-119)', 'cancel a March 2026 executive order signed by President Trump (Executive Order 14399)'],
    ['title before a full name (hr-9503-119)', 'killed in 1950 while protecting President Harry Truman during an assassination attempt'],
    ['former president, before a name', 'as former President Truman did'],
    ['a road named for a president (hr-4380-119)', 'the President George Bush Turnpike'],
    ['proper name (hr-7915-119)', 'She received the Presidential Medal of Freedom in 1980.'],
    ['proper name, possessive (s-1353-119)', "near the White House in President's Park."],
    ['agency name (hr-8702-119)', 'place it directly inside the Executive Office of the President, which'],
    ['proper name (s-675-119)', 'the Theodore Roosevelt Presidential Library Foundation'],
    ['holiday', 'Presidents Day falls on a Monday.'],
    ['a proclamation by number (hr-6978-119)', 'linked to Presidential Proclamation 10998, which restricts entry'],
    ['sentence start keeps an adjective capital', 'Presidential emergency control temporarily ends.'],
    ['the record quoted in curly quotes (moment-updates)', '“Signed by President.”'],
    ['the record quoted in straight quotes', 'The last action reads "Presented to President." on the record.'],
    ['vice president before a name', 'Vice President Vance cast the deciding vote.'],
  ];
  for (const [where, text] of kept) {
    test(where, () => {
      const r = normalizeEnglish(text);
      expect(r.text).toBe(text);
      expect(r.changes).toEqual([]);
    });
  }

  test('a bill title copied verbatim keeps its capitals (hconres-89-119 title)', () => {
    const title =
      'Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove United States Armed Forces from hostilities with Iran.';
    const text = 'The House agreed to H. Con. Res. 89, Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove forces.';
    const r = normalizeEnglish(text, { titles: [title] });
    expect(r.text).toBe(text);
    expect(r.skipped.map((s) => s.reason)).toEqual(['inside words copied verbatim from the official title']);
  });

  test("…but prose that only shares a title's words is ours (hr-7211-119)", () => {
    const title = 'To authorize the President to award the Medal of Honor to John W. Ripley for acts of valor during the Vietnam War, and for other purposes.';
    const text = "This bill allows the President to award the Medal of Honor, the nation's highest military honor, to John W. Ripley";
    expect(en(text, [title])).toBe("This bill allows the president to award the Medal of Honor, the nation's highest military honor, to John W. Ripley");
  });

  test('the official title field itself is never swept', () => {
    const bills = [
      {
        bill_type: 'hconres',
        bill_number: 89,
        congress_number: 119,
        title: 'Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove United States Armed Forces from hostilities with Iran.',
        short_title: null,
        last_action_text: 'Presented to President.',
        ai_headline: 'Resolution would direct president to halt military action against Iran',
        ai_summary: 'It tells the President to stop.',
        ai_sections: { tldr: 'The President must stop.', what: 'x', who: 'y', why: 'z', cost: null, costChips: ['President may request exceptions'] },
      },
    ];
    const report = sweepCorpus({ bills, billsEs: {}, headlines: {}, moments: {}, momentUpdates: {} });
    expect(bills[0].title).toContain('Directing the President');
    expect(bills[0].last_action_text).toBe('Presented to President.');
    expect(bills[0].ai_headline).toBe('Resolution would direct the president to halt military action against Iran');
    expect(bills[0].ai_summary).toBe('It tells the president to stop.');
    expect(bills[0].ai_sections.costChips).toEqual(['The president may request exceptions']);
    expect(report.changes.map((c) => c.path)).toEqual([
      'hconres-89-119.ai_headline',
      'hconres-89-119.ai_summary',
      'hconres-89-119.ai_sections.tldr',
      'hconres-89-119.ai_sections.costChips[0]',
    ]);
  });
});

test.describe('English: what it cannot decide, it reports and leaves alone', () => {
  test('a capitalized word before the office may make it a name (hr-5309-119)', () => {
    const text = 'the first woman to serve as Manhattan Borough President, and the first Black woman appointed';
    const r = normalizeEnglish(text);
    expect(r.text).toBe(text);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].match).toBe('Borough President');
  });

  test('a label that opens on the bare noun is the editor\'s call ("President\'s desk")', () => {
    const r = normalizeEnglish("President's desk");
    expect(r.text).toBe("President's desk");
    expect(r.skipped[0].reason).toMatch(/label/);
  });

  test('an unclosed quotation mark protects everything after it', () => {
    const text = 'He wrote "the President will act, and the President must sign';
    const r = normalizeEnglish(text);
    expect(r.text).toBe(text);
    expect(r.skipped.every((s) => s.reason === 'after an unclosed quotation mark')).toBe(true);
    expect(quotedSpans(text).unbalancedAt).toBe(9);
  });

  test('a bare noun after a word the rule does not know is lowercased but not given an article', () => {
    const r = normalizeEnglish('Congress wants President approval');
    expect(r.text).toBe('Congress wants president approval');
    expect(r.skipped[0].reason).toMatch(/no article/);
  });
});

test.describe('Spanish: "presidente" is lowercase, even before a name (RAE)', () => {
  const cases: Array<[string, string, string]> = [
    ['hconres-89-119 sections.what', 'Esta resolución le exigiría al Presidente que deje de usar las fuerzas', 'Esta resolución le exigiría al presidente que deje de usar las fuerzas'],
    ['El at the start of a sentence', 'El Presidente puede congelar cualquiera de estos bienes.', 'El presidente puede congelar cualquiera de estos bienes.'],
    ['before a name', 'una orden que el Presidente Trump firmó en marzo', 'una orden que el presidente Trump firmó en marzo'],
    ['an office in a list', 'elecciones para Presidente, Vicepresidente, Senado y Cámara de Representantes', 'elecciones para presidente, vicepresidente, Senado y Cámara de Representantes'],
    ['vicepresidente', 'el Presidente y el Vicepresidente no podrían cobrar', 'el presidente y el vicepresidente no podrían cobrar'],
    ['site copy (bill.journey.stepPresident)', 'Escritorio del Presidente', 'Escritorio del presidente'],
  ];
  for (const [where, before, after] of cases) {
    test(where, () => {
      expect(es(before)).toBe(after);
    });
  }

  const kept: Array<[string, string]> = [
    ['an agency name (hr-8702-119)', 'la Oficina Ejecutiva del Presidente, los tribunales federales'],
    ['a medal (hr-7915-119)', 'recibió la Medalla Presidencial de la Libertad en 1980.'],
    ['a fund, with its English name (hr-7418-119)', 'el Fondo para Campañas Electorales Presidenciales (Presidential Election Campaign Fund)'],
    ['a library (s-675-119)', 'la Biblioteca Presidencial Theodore Roosevelt'],
    ['the record quoted (moment-updates)', 'Registro oficial, en inglés: “Signed by President.”'],
    ['a quoted term (hr-3542-119)', 'Crea un puesto formal de "Presidente" para este comité'],
    ['start of a sentence', 'Presidente de la Cámara'],
  ];
  for (const [where, text] of kept) {
    test(`kept: ${where}`, () => {
      expect(es(text)).toBe(text);
    });
  }

  test('"Presidencia" is left to the editor (the office or the institution)', () => {
    const r = normalizeSpanish('según la Presidencia de la República');
    expect(r.text).toBe('según la Presidencia de la República');
    expect(r.skipped).toHaveLength(1);
  });
});

test.describe('shape of the API', () => {
  test('idempotent: a second pass over its own output changes nothing', () => {
    const samples = [
      'Resolution would direct president to halt military action against Iran',
      'President may request exceptions',
      "Bill would repeal 1974 law limiting president's spending power",
      'elections for President, Vice President, U.S. Senate',
      'The President would have 90 days.',
    ];
    for (const s of samples) {
      const once = en(s);
      expect(en(once)).toBe(once);
    }
    const once = es('El Presidente y el Vicepresidente');
    expect(es(once)).toBe(once);
  });

  test('presidentStyle passes non-strings through, and dispatches on language', () => {
    expect(presidentStyle(null, 'en')).toBeNull();
    expect(presidentStyle(undefined, 'es')).toBeUndefined();
    expect(presidentStyle('the President', 'en')).toBe('the president');
    expect(normalizePresidentStyle('al Presidente', 'es').text).toBe('al presidente');
  });

  test('presidentStyleSections restyles strings and chip arrays, leaves the rest', () => {
    const out = presidentStyleSections(
      { tldr: 'The President must act.', cost: null, costChips: ['President may request exceptions', 'No new money'] },
      'en',
    );
    expect(out).toEqual({ tldr: 'The president must act.', cost: null, costChips: ['The president may request exceptions', 'No new money'] });
  });

  test('sweepMessagesRaw keeps the file byte-identical outside the changed strings', () => {
    const raw = '{\n  "a": {\n    "b": "the President signed it."\n  },\n  "c": "Untouched"\n}\n';
    const r = sweepMessagesRaw(raw, 'en');
    expect(r.raw).toBe('{\n  "a": {\n    "b": "the president signed it."\n  },\n  "c": "Untouched"\n}\n');
    expect(r.changes).toEqual([{ path: 'a.b', before: 'the President signed it.', after: 'the president signed it.' }]);
  });
});

test.describe('the pipelines that write public text carry the rule (strings only, zero model calls)', () => {
  const bill = {
    bill_type: 'hconres',
    bill_number: 89,
    title: 'Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove United States Armed Forces from hostilities with Iran.',
    short_title: null,
    ai_summary: 'It tells the President to stop.',
    status: 'floor_vote',
  };

  test('decode call 2 carries the rule; call 1 does NOT, so no stored fingerprint moves', () => {
    expect(buildStructurePrompt(bill, 'A summary.')).toContain(PRESIDENT_STYLE_RULE);
    // decode_text_sha fingerprints call 1's prompt (scripts/bill-decode.mjs
    // textFingerprint). Adding the rule there would move every fingerprint in
    // the corpus at once and pay for re-decodes the veto exists to refuse.
    expect(buildSummaryPrompt(bill, 'TEXT')).not.toContain('Style for the office');
  });

  test('assembleDecode restyles every field of both languages, chips before their length check', () => {
    const reply = [
      '[HEADLINE_EN]',
      'Resolution would direct president to halt military action against Iran',
      '[HEADLINE_ES]',
      'Resolución pediría al Presidente detener acciones militares contra Irán',
      '[TLDR]',
      'The President must remove forces.',
      '[WHAT]',
      'It directs the President to remove forces.',
      '[WHO]',
      'The President and service members.',
      '[WHY]',
      'It limits the President.',
      '[COST]',
      'NONE',
      '[COST_CHIPS]',
      'NONE',
      '[ES_TLDR]',
      'El Presidente debe retirar las fuerzas.',
      '[ES_WHAT]',
      'Ordena al Presidente retirar las fuerzas.',
      '[ES_WHO]',
      'El Presidente.',
      '[ES_WHY]',
      'Limita al Presidente.',
      '[ES_COST]',
      'NONE',
      '[ES_COST_CHIPS]',
      'NONE',
      '[ES_SUMMARY]',
      'Le ordena al Presidente detenerse.',
    ].join('\n');
    const dec = assembleDecode('It tells the President to stop.', reply, decodeTitles(bill));
    expect(dec.ai_summary).toBe('It tells the president to stop.');
    expect(dec.ai_headline).toBe('Resolution would direct the president to halt military action against Iran');
    expect(dec.ai_sections.tldr).toBe('The president must remove forces.');
    expect(dec.ai_sections.what).toBe('It directs the president to remove forces.');
    expect(dec.es_headline).toBe('Resolución pediría al presidente detener acciones militares contra Irán');
    expect(dec.es_summary).toBe('Le ordena al presidente detenerse.');
    expect(dec.es_sections.what).toBe('Ordena al presidente retirar las fuerzas.');
  });

  test('the Big Question draft prompt carries the rule, and a clean draft is restyled before it is offered', () => {
    const g = { slug: 'hconres-89-119', citation: 'H.Con.Res. 89', title: bill.title, status: 'floor_vote', lastActionText: 'x', lastActionDate: '2026-09-24', introducedDate: '2026-04-23', press: null };
    expect(draftPrompt(g as never)).toContain(PRESIDENT_STYLE_RULE);
    const { clean } = validateDraft({
      name: { en: 'Iran war powers', es: 'Poderes de guerra sobre Irán' },
      summary: {
        en: 'The House agreed to a resolution that directs the President to remove U.S. armed forces from hostilities with Iran. A yes vote in the Senate would join that direction; a no vote leaves operations under the President\'s direction. The record shows no vote date in the Senate for it.',
        es: 'La Cámara aprobó una resolución que ordena al Presidente retirar a las fuerzas armadas de EE. UU. de las hostilidades con Irán. Un voto a favor en el Senado se sumaría a esa orden; un voto en contra deja las operaciones bajo la dirección del Presidente. El expediente no muestra fecha de votación en el Senado.',
      },
      role: {
        en: 'It directs the President to remove U.S. armed forces from hostilities with Iran. It is on the Senate calendar.',
        es: 'Ordena al Presidente retirar a las fuerzas armadas de EE. UU. de las hostilidades con Irán. Está en el calendario del Senado.',
      },
    });
    expect(clean.role?.en).toBe('It directs the president to remove U.S. armed forces from hostilities with Iran. It is on the Senate calendar.');
    expect(clean.role?.es).toMatch(/^Ordena al presidente/);
  });

  test('call scripts: both prompts carry the rule, both versions moved, and finishScript restyles', () => {
    expect(buildScriptPrompt({ bill: bill as never, stance: 'support', lang: 'en' })).toContain(PRESIDENT_STYLE_RULE);
    const nom = buildNominationScriptPrompt({
      nomination: { citation: 'PN 12-1', nominee_description: 'Jane Doe, of Ohio, to be an Assistant Secretary of State.', organization: 'Department of State', status: 'committee', last_action_text: null } as never,
      stance: 'support',
      audience: 'senator',
      lang: 'en',
    });
    expect(nom).toContain(PRESIDENT_STYLE_RULE);
    expect(nom).toContain('no naming of the president');
    // The examples are historical on purpose: these prompts forbid naming a
    // sitting officeholder, and an example is what a model copies.
    expect(PRESIDENT_STYLE_RULE).not.toMatch(/Trump|Biden|Vance|Harris/);
    // A prompt change must move the cache version, or it never reaches users.
    expect(PROMPT_VERSION).toBe('3');
    expect(NOMINATION_PROMPT_VERSION).toBe('2');
    expect(finishScript('  Hello. I ask the President to act.\n', 'en')).toBe('Hello. I ask the president to act.');
    expect(finishScript('Hola. Le pido al Presidente que actúe.', 'es')).toBe('Hola. Le pido al presidente que actúe.');
  });

  test('every writer imports the normalizer (a new writer that skips it shows up here)', () => {
    const root = process.cwd();
    const writers: Array<[string, RegExp]> = [
      ['scripts/bill-decode.mjs', /presidentStyle\(/],
      ['lib/decode-batch.mjs', /decodeTitles\(/],
      ['scripts/moment-updates.mjs', /presidentStyle\(/],
      ['scripts/moment-draft.mjs', /presidentStyle\(/],
      ['lib/scriptprompt.ts', /presidentStyle\(/],
      ['app/api/script/route.ts', /finishScript\(/],
      ['lib/pregen-runner.ts', /finishScript\(/],
      ['scripts/regenerate-headlines.mjs', /presidentStyle\(/],
      ['scripts/translate-summaries.mjs', /presidentStyle\(/],
      ['scripts/restructure-decoded.mjs', /presidentStyleSections\(/],
      ['scripts/generate-cost-chips.mjs', /presidentStyle\(/],
    ];
    for (const [file, re] of writers) {
      expect(readFileSync(join(root, file), 'utf8'), file).toMatch(re);
    }
  });
});

test.describe('the site copy follows the rule', () => {
  for (const lang of ['en', 'es'] as const) {
    test(`messages/${lang}.json has nothing left to restyle`, () => {
      const raw = readFileSync(join(process.cwd(), `messages/${lang}.json`), 'utf8');
      const { changes } = sweepMessagesRaw(raw, lang);
      expect(
        changes,
        `run: node scripts/president-style.mjs --messages --write  (docs/copy-style.md, owner 2026-09-29: "the president")`,
      ).toEqual([]);
    });
  }
});

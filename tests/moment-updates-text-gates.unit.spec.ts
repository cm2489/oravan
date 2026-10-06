import { expect, test } from '@playwright/test';
/*
 * Two checks an AI-written "Where it stands" summary passes before it is
 * stored (lib/moment-updates-gate.mjs, called from scripts/moment-updates.mjs,
 * re-checked on what is stored by scripts/check-moment-updates.mjs), added
 * 2026-10-06:
 *
 *   1. The absence lint now catches two shapes with no "no" in them, which a
 *      diagnostic sample of 2026-10-01 (workflow run 36884798035, "baseline
 *      #4") got past it: "neither had a new vote or action in this window"
 *      and "These were the only actions listed for the bill in the last 14
 *      days", and their Spanish twins from the same sample.
 *   2. The vote-count lint: every vote count a summary states must be one the
 *      record holds for one of the question's measures, in the data the
 *      summary was written from. An invented "by a vote of 98 to 0" (the
 *      independent check of PR #412, case D) passed every gate and was stored.
 *
 * ZERO network and ZERO model calls: the Anthropic clients are stubs. The
 * committed data/ files are read, nothing is written.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  absenceClaims,
  checkMomentUpdates,
  etDay,
  groundingMayBePruned,
  HARD_DAY_CEILING,
  lintRevisionText,
  MAX_UPDATES_PER_MOMENT,
  pruneEntry,
  RETENTION_DAYS,
  shiftDay,
  statedVoteCounts,
  STORED_SUMMARY_WINDOW_DAYS,
  unheldVoteCounts,
  voteCountRecord,
} from '../lib/moment-updates-gate.mjs';
import { generateStateSummary, SUMMARY_WINDOW_DAYS } from '../scripts/moment-updates.mjs';

// The committed data files are read as plain JSON; their shapes are what the gate checks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const readData = (p: string): Json => JSON.parse(readFileSync(join(process.cwd(), p), 'utf8'));

const STORE: Json = readData('data/moment-updates.json');
const VOTES: Json = readData('data/votes.json');
const MOMENTS: Json = readData('data/moments.json');
const BILLS = readData('data/bills.json') as unknown as Json[];
const ROLL_BY_ID = new Map<string, Json>(VOTES.rollCalls.map((r: Json) => [String(r.id), r]));
const roll = (id: string): Json => {
  const r = ROLL_BY_ID.get(id);
  if (!r) throw new Error(`data/votes.json no longer holds ${id}`);
  return r;
};

/** The record a stored revision was written from, rebuilt the way the gate rebuilds it. */
function recordOf(entry: Json, revision: Json) {
  const byId = new Map<string, Json>((entry.updates ?? []).map((u: Json) => [String(u.id), u]));
  return voteCountRecord({
    rollCalls: (revision.grounded_in.roll_calls as string[]).map(roll),
    actionTexts: (revision.grounded_in.update_ids ?? [])
      .map((id: string) => byId.get(String(id)))
      .filter((u: Json | undefined) => u && u.class !== 'press_cluster')
      .map((u: Json) => u.record?.action_text),
  });
}

/** Every stored revision the collector wrote with its grounding (the gate's marker). */
const GROUNDED_REVISIONS = Object.entries(STORE)
  .filter(([k]) => k !== '_meta')
  .flatMap(([momentId, entry]: [string, Json]) =>
    (entry.summary_revisions ?? [])
      .filter((r: Json) => Array.isArray(r.grounded_in?.roll_calls))
      .map((r: Json) => ({ momentId, entry, r })),
  );

/** An Anthropic-shaped stub that returns one fixed reply. */
const replying = (reply: { en: string; es: string }) => ({
  messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(reply) }] }) },
});

/* ------------------------------------------------------------------ *
 * 1 · the absence lint
 * ------------------------------------------------------------------ */

test.describe('the absence lint · the two shapes with no "no" in them', () => {
  // workflow run 36884798035 (2026-10-01), sample "baseline #4", verbatim.
  const BASELINE_4 = {
    en: [
      'These were the only actions listed for the bill in the last 14 days.',
      'S. 1525 and H.R. 3074 each have a passage in one chamber on their record, and neither had a new vote or action in this window.',
    ],
    es: [
      'Estas fueron las únicas acciones registradas para el proyecto en los últimos 14 días.',
      'Los proyectos S. 1525 y H.R. 3074 tienen cada uno una aprobación en una cámara en su historial, y ninguno tuvo un voto o una acción nuevos en este período.',
    ],
  };

  test('the two real sentences are caught, in English and in Spanish', () => {
    for (const lang of ['en', 'es'] as const) {
      for (const s of BASELINE_4[lang]) {
        expect(absenceClaims(s, lang), s).not.toEqual([]);
        expect(lintRevisionText(s, lang, { groundedEvents: true, rollCallsOnRecord: 0 }).some((f: string) => f.startsWith('absence claim')), s).toBe(true);
      }
    }
    expect(absenceClaims(BASELINE_4.en[0], 'en')).toEqual(['the only actions']);
    expect(absenceClaims(BASELINE_4.en[1], 'en')).toEqual(['neither had a new vote']);
  });

  test('…and their cousins the same run wrote ("the only movement recorded", "the only ones in the last 14 days")', () => {
    const en = [
      "The Senate's action on September 28, 2026 is the only movement recorded in the last 14 days.",
      'These two actions on September 28 are the only ones in the last 14 days for this bill.',
      'None of the other measures saw any action in this period.',
      'Neither measure has moved since July.',
    ];
    const es = [
      'La acción del Senado el 28 de septiembre de 2026 es el único movimiento que consta en ese período.',
      'Esas dos medidas del 28 de septiembre son las únicas de los últimos 14 días para este proyecto.',
      'Ninguna de las otras medidas registró actividad en este período.',
    ];
    for (const s of en) expect(absenceClaims(s, 'en'), s).not.toEqual([]);
    for (const s of es) expect(absenceClaims(s, 'es'), s).not.toEqual([]);
  });

  test('a sentence that states what happened is not touched — one clause, never across a comma', () => {
    const en = [
      'On September 28, 2026, the Senate passed H.R. 10167 without amendment by unanimous consent.',
      'Neither amendment was agreed to.',
      'The only amendment agreed to was S.Amdt. 6828, by a recorded vote of 96 to 1 (Roll no. 245).',
      'Neither of the two amendments passed, and the vote on S.Amdt. 6760 was 42 to 54.',
    ];
    const es = [
      'El 28 de septiembre de 2026, el Senado aprobó el proyecto H.R. 10167 sin enmiendas por consentimiento unánime.',
      'La única enmienda aprobada fue la S.Amdt. 6828, por votación nominal de 96 a 1 (votación núm. 245).',
      'Ninguna de las dos enmiendas fue aprobada, y la votación sobre la S.Amdt. 6760 fue de 42 a 54.',
    ];
    for (const s of en) expect(absenceClaims(s, 'en'), s).toEqual([]);
    for (const s of es) expect(absenceClaims(s, 'es'), s).toEqual([]);
  });

  test('the rewordings an independent check tried (2026-10-06) are caught in both languages', () => {
    const en = [
      'Neither S. 1525 nor H.R. 3074 had a new vote in this window.',
      'Neither H. Con. Res. 89 nor S.J. Res. 185 was voted on this week.',
      'Those were the only two votes.',
    ];
    const es = [
      'Ni el S. 1525 ni el H.R. 3074 tuvo una votación nueva en este período.',
      'Esas fueron las dos únicas votaciones.',
      'Ninguno de los dos se votó.',
      'Ni el S. 1525 ni el H.R. 3074 fue votado.',
    ];
    for (const s of en) expect(absenceClaims(s, 'en'), s).not.toEqual([]);
    for (const s of es) expect(absenceClaims(s, 'es'), s).not.toEqual([]);
  });

  test('a plain "voted" after "neither … nor" / "none" is caught in both languages (a second independent check, 2026-10-06)', () => {
    const en = ['Neither the House nor the Senate voted.', 'None of them voted.'];
    const es = ['Ni la Cámara ni el Senado votaron.', 'Ninguno de ellos votó.'];
    for (const s of en) expect(absenceClaims(s, 'en'), s).not.toEqual([]);
    for (const s of es) expect(absenceClaims(s, 'es'), s).not.toEqual([]);
    // …but "voted" with a side is a party count, in both languages.
    const enSide = ['Neither the House nor the Senate voted for it.', 'Neither Democrats nor Republicans voted against it.'];
    const esSide = ['Ni la Cámara ni el Senado votaron a favor.', 'Ni los demócratas ni los republicanos votaron en contra.', 'Ninguno de ellos votó con su partido.'];
    for (const s of enSide) expect(absenceClaims(s, 'en'), s).toEqual([]);
    for (const s of esSide) expect(absenceClaims(s, 'es'), s).toEqual([]);
  });

  test('"the only one to vote against it" states a roll call, not an absence, in both languages; "the only ones in the last 14 days" is still caught', () => {
    const en = ['Senator X was the only one to vote against it.', 'She was the only one who voted no.', 'It was the only one that voted.'];
    const es = ['El senador X fue el único que votó en contra.', 'Ella fue la única en votar en contra.', 'Fueron los únicos que votaron a favor.'];
    for (const s of en) expect(absenceClaims(s, 'en'), s).toEqual([]);
    for (const s of es) expect(absenceClaims(s, 'es'), s).toEqual([]);
    expect(absenceClaims('These two actions are the only ones in the last 14 days.', 'en')).toEqual(['the only ones']);
    expect(absenceClaims('Son las únicas de los últimos 14 días.', 'es')).toEqual(['las únicas']);
    expect(absenceClaims('Es el único que consta.', 'es')).toEqual(['el único']);
  });

  test('a party count with "none" / "ninguno" in it is not an absence claim, in either language', () => {
    const en = [
      'Every Democrat and none of the Republicans voted yes.',
      'None of the Republicans voted for it, and none of the Democrats voted against it.',
    ];
    const es = [
      'Todos los demócratas y ninguno de los republicanos votaron a favor.',
      'Ninguno de los republicanos votó a favor, y ninguno de los demócratas votó en contra.',
    ];
    for (const s of en) expect(absenceClaims(s, 'en'), s).toEqual([]);
    for (const s of es) expect(absenceClaims(s, 'es'), s).toEqual([]);
  });

  test('no stored revision the gate re-lints trips the wider lint (grounded, over a record that is not empty)', () => {
    // The gate's own condition: the revision carries grounded_in.roll_calls,
    // and its grounding holds a roll call or a record-bearing update.
    const linted = GROUNDED_REVISIONS.filter(({ entry, r }) => {
      const classOf = new Map((entry.updates ?? []).map((u: Json) => [String(u.id), u.class]));
      const events = (r.grounded_in.update_ids ?? []).filter((id: string) => {
        const c = classOf.get(String(id));
        return c !== undefined && c !== 'press_cluster';
      });
      return events.length > 0 || r.grounded_in.roll_calls.length > 0;
    });
    expect(linted.length).toBeGreaterThan(5);
    for (const { momentId, r } of linted) {
      const onRecord = Array.isArray(r.grounded_in.roll_calls_on_record) ? r.grounded_in.roll_calls_on_record.length : undefined;
      for (const lang of ['en', 'es'] as const) {
        expect(absenceClaims(r.text[lang], lang, { rollCallsOnRecord: onRecord }), `${momentId} ${r.id} ${lang}`).toEqual([]);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2 · the vote-count lint
 * ------------------------------------------------------------------ */

test.describe('the vote-count lint · what counts as a vote count', () => {
  test('every form the summaries use reads as a pair: "77 to 22", "77-22", "77–22", "77 - 22", the worded ones, and the Spanish', () => {
    const en = 'It passed 77 to 22, then 77-22, then 77–22, then 77 - 22; 49 yeas to 50 nays; Yeas 49, Nays 50; got 50 votes to 46.';
    expect(statedVoteCounts(en, 'en').map((c: Json) => c.text)).toEqual([
      '77 to 22', '77-22', '77–22', '77 - 22', '49 yeas to 50 nays', 'Yeas 49, Nays 50', '50 votes to 46',
    ]);
    const es = 'Se aprobó 77 a 22; 77-22; 77–22; 77 votos a favor y 22 en contra; 4 a favor, 49 en contra; obtuvo 50 votos contra 46.';
    expect(statedVoteCounts(es, 'es').map((c: Json) => c.text)).toEqual([
      '77 a 22', '77-22', '77–22', '77 votos a favor y 22 en contra', '4 a favor, 49 en contra', '50 votos contra 46',
    ]);
  });

  test('the English reads the worded shapes the Spanish reads, and the non-breaking hyphen', () => {
    const en = 'It passed with 98 votes in favor and 0 against; then 48 for, 51 against; 98 for and 0 against; 98 yea votes to 0 nay votes; and 98\u20110.';
    expect(statedVoteCounts(en, 'en').map((c: Json) => [c.text, c.a, c.b, c.ordered])).toEqual([
      ['98 votes in favor and 0 against', 98, 0, true],
      ['48 for, 51 against', 48, 51, true],
      ['98 for and 0 against', 98, 0, true],
      ['98 yea votes to 0 nay votes', 98, 0, true],
      ['98\u20110', 98, 0, false],
    ]);
    const es = 'Se aprobó con 98 votos a favor y 0 votos en contra, y luego 98\u20110.';
    expect(statedVoteCounts(es, 'es').map((c: Json) => c.text)).toEqual(['98 votos a favor y 0 votos en contra', '98\u20110']);
  });

  test('the press forms "por 98 votos a 0" and "98 votes for and 0 against" read in both languages (a second independent check, 2026-10-06)', () => {
    expect(statedVoteCounts('Se aprobó por 98 votos a 0, y luego por 77 votos a 22.', 'es').map((c: Json) => [c.text, c.a, c.b])).toEqual([
      ['98 votos a 0', 98, 0],
      ['77 votos a 22', 77, 22],
    ]);
    expect(statedVoteCounts('It passed with 98 votes for and 0 against, then 77 votes for, 22 against.', 'en').map((c: Json) => [c.text, c.a, c.b, c.ordered])).toEqual([
      ['98 votes for and 0 against', 98, 0, true],
      ['77 votes for, 22 against', 77, 22, true],
    ]);
    // A single number with "a favor" / "for" after it is still never a count.
    expect(statedVoteCounts('Obtuvo 30 votos a favor.', 'es')).toEqual([]);
    expect(statedVoteCounts('It drew the 60 votes for cloture.', 'en')).toEqual([]);
  });

  test('the party figures the writers may state read as party counts (lib/party-count-rule.mjs shapes)', () => {
    const en = statedVoteCounts('On that vote, 4 Republicans and 43 Democrats voted yes. Republicans: 4 yea, 49 nay.', 'en');
    expect(en.map((c: Json) => [c.kind, c.text, c.party])).toEqual([
      ['party_count', '4 Republicans', 'R'],
      ['party_count', '43 Democrats', 'D'],
      ['party_pair', '4 yea, 49 nay', 'R'],
    ]);
    const es = statedVoteCounts('En esa votación, 4 republicanos y 43 demócratas votaron a favor. Republicanos: 4 a favor, 49 en contra.', 'es');
    expect(es.map((c: Json) => [c.kind, c.text, c.party])).toEqual([
      ['party_count', '4 republicanos', 'R'],
      ['party_count', '43 demócratas', 'D'],
      ['party_pair', '4 a favor, 49 en contra', 'R'],
    ]);
  });

  test('numbers that are not vote counts never read as one — thresholds, two-thirds, dates, bill, section and roll numbers, money, years', () => {
    const en = [
      'Cloture needed 60 votes, and suspension needs a two-thirds vote.',
      'The Senate met on September 15-17, 2026, and again on Sept. 22–24.',
      'S. 1525 and H.R. 3074 passed one chamber; H.R. 10167 passed both.',
      'Sections 101 to 105 and section 5(c) of the War Powers Resolution; Title 10.',
      'It provides $2 to $3 million, or 5 to 10 percent, over 2 to 3 years.',
      'The 2025-2026 session; the 2025–26 cycle.',
      'The text is at CR H4731-4733 and CR S4586-4588.',
      'See Roll nos. 245-248 and Record Vote Numbers 245 to 248.',
      'It became Public Law 119-103 (Public Law No: 119-60).',
      'The order of 8/8/26, (2/3 required), at 1:45 to 2:30 p.m.',
      'S.Amdt. 6776 to S. 4668, Calendar No. 501, Roll no. 244.',
      'Ages 18 to 24.',
      'Rule 22 to 24 of the Standing Rules; Rules 5-7.',
      'See roll call votes 244-246 and votes 244 to 246.',
      'It drew 12 to 15 cosponsors and 10 to 20 amendments.',
      'It covers grades 9 to 12, Divisions 1 to 3 and Tier 1-2, at level 2-3.',
      'It funds 3 to 5 schools within 2 to 3 business days.',
    ];
    for (const s of en) expect(statedVoteCounts(s, 'en'), s).toEqual([]);
    const es = [
      'El cierre del debate necesitaba 60 votos, y la suspensión necesita dos tercios.',
      'El Senado se reunió del 15 al 17 de septiembre y el 15-17 de septiembre de 2026.',
      'Las secciones 101 a 105 y la sección 5(c); artículos 3 a 5.',
      'Otorga de 2 a 3 millones de dólares, o de 5 a 10 por ciento, en 30 a 60 días.',
      'La sesión 2025-2026.',
      'El texto está en CR H4731-4733.',
      'Se convirtió en la Ley Pública 119-103 (Ley Pública núm. 119-60).',
      'Votaciones núm. 245 a 248; la orden del 8/8/26.',
      'Las reglas 22 a 24; las votaciones 244-246.',
      'Reunió de 12 a 15 copatrocinadores y de 10 a 20 enmiendas.',
      'Abarca los grados 9 a 12, las divisiones 1 a 3 y el nivel 1-2.',
      'Financia de 3 a 5 escuelas en 2 a 3 días hábiles.',
    ];
    for (const s of es) expect(statedVoteCounts(s, 'es'), s).toEqual([]);
  });

  test('the record keeps its tallies yeas first, from both roll calls and the chamber\'s own sentences', () => {
    const rec = voteCountRecord({
      rollCalls: [roll('s-119-2-244')],
      actionTexts: ['Motion to proceed to consideration of measure agreed to in Senate by Yea-Nay Vote. 77 - 22. Record Vote Number: 236.', 'Became Public Law No: 119-103.', 'Passed Senate with an amendment by Unanimous Consent. (text of amendment in the nature of a substitute: CR S4586-4588)'],
    });
    expect(rec.pairs).toEqual(['49-50', '77-22']);
    expect(rec.partyPairs.R).toEqual(['4-49']);
    expect(rec.partyCounts.D).toEqual([0, 1, 43]);
  });
});

test.describe('the vote-count lint · held and unheld', () => {
  const REC_244 = () => voteCountRecord({ rollCalls: [roll('s-119-2-244')] });

  test('case D: an invented "by a vote of 98 to 0" is refused, in both languages', () => {
    // The penny question's window on 2026-09-29: no roll call, two passages by unanimous consent.
    const rec = voteCountRecord({
      rollCalls: [],
      actionTexts: ['Passed Senate without amendment by Unanimous Consent.', 'Senate Committee on Banking, Housing, and Urban Affairs discharged by Unanimous Consent.'],
    });
    expect(unheldVoteCounts('On September 28, 2026, the Senate passed H.R. 10167 by a vote of 98 to 0.', 'en', rec)).toEqual(['98 to 0']);
    expect(unheldVoteCounts('El 28 de septiembre de 2026, el Senado aprobó el H.R. 10167 por una votación de 98 a 0.', 'es', rec)).toEqual(['98 a 0']);
    const f = lintRevisionText('The Senate passed it by a vote of 98 to 0.', 'en', { voteRecord: rec });
    expect(f.some((x: string) => x.startsWith('vote count "98 to 0"'))).toBe(true);
  });

  test('a true count passes in every form; a joined pair in either order; a worded pair only with the yeas first', () => {
    const rec = REC_244();
    for (const s of ['rejected, 49 to 50 (Roll no. 244)', 'rejected 49-50', 'rejected 49–50', 'rejected 50 to 49', 'by 49 yeas to 50 nays', 'Yeas 49, Nays 50']) {
      expect(unheldVoteCounts(s, 'en', rec), s).toEqual([]);
    }
    for (const s of ['por votación nominal de 49 a 50', 'rechazada 49-50', '49 votos a favor y 50 en contra']) {
      expect(unheldVoteCounts(s, 'es', rec), s).toEqual([]);
    }
    expect(unheldVoteCounts('by 50 yeas to 49 nays', 'en', rec)).toEqual(['50 yeas to 49 nays']);
    expect(unheldVoteCounts('50 votos a favor y 49 en contra', 'es', rec)).toEqual(['50 votos a favor y 49 en contra']);
  });

  test('the press forms, held and invented, in both languages: "por 49 votos a 50" / "49 votes for and 50 against"', () => {
    const rec = REC_244();
    expect(unheldVoteCounts('Fue rechazada por 49 votos a 50.', 'es', rec)).toEqual([]);
    expect(unheldVoteCounts('It was rejected with 49 votes for and 50 against.', 'en', rec)).toEqual([]);
    expect(unheldVoteCounts('Se aprobó por 98 votos a 0.', 'es', rec)).toEqual(['98 votos a 0']);
    expect(unheldVoteCounts('It passed with 98 votes for and 0 against.', 'en', rec)).toEqual(['98 votes for and 0 against']);
    // The English names the yeas, so it must match in that order, like every worded pair.
    expect(unheldVoteCounts('It passed with 50 votes for and 49 against.', 'en', rec)).toEqual(['50 votes for and 49 against']);
    const f = lintRevisionText('Se aprobó por 98 votos a 0.', 'es', { voteRecord: rec });
    expect(f.some((x: string) => x.startsWith('vote count "98 votos a 0"'))).toBe(true);
  });

  test('party figures must be that party\'s, on a printed roll call', () => {
    const rec = REC_244();
    expect(unheldVoteCounts('On that vote, 4 Republicans and 43 Democrats voted yes. Republicans: 4 yea, 49 nay.', 'en', rec)).toEqual([]);
    expect(unheldVoteCounts('En esa votación, 4 republicanos y 43 demócratas votaron a favor. Republicanos: 4 a favor, 49 en contra.', 'es', rec)).toEqual([]);
    expect(unheldVoteCounts('On that vote, 5 Republicans and 43 Democrats voted yes.', 'en', rec)).toEqual(['5 Republicans']);
    expect(unheldVoteCounts('Democrats: 4 yea, 49 nay.', 'en', rec)).toEqual(['4 yea, 49 nay']);
    expect(unheldVoteCounts('Republicans: 49 yea, 4 nay.', 'en', rec)).toEqual(['49 yea, 4 nay']);
  });

  test('a true count the prompt did NOT print is refused: the record is the data the summary was written from', () => {
    // 214 to 208 is House roll 282 on H.Con.Res. 89 (2026-07-23): true, but outside a window that prints roll 244 only.
    expect(unheldVoteCounts('The House agreed to it 214 to 208.', 'en', REC_244())).toEqual(['214 to 208']);
  });

  test('with no record, nothing is checked (a caller that does not know what the text was written from)', () => {
    expect(unheldVoteCounts('by a vote of 98 to 0', 'en', null)).toEqual([]);
    expect(lintRevisionText('The Senate passed it by a vote of 98 to 0.', 'en')).toEqual([]);
  });

  test('the committed corpus: every count every grounded stored revision states is one its own grounding holds', () => {
    let counted = 0;
    for (const { momentId, entry, r } of GROUNDED_REVISIONS) {
      const rec = recordOf(entry, r);
      for (const lang of ['en', 'es'] as const) {
        counted += statedVoteCounts(r.text[lang], lang).length;
        expect(unheldVoteCounts(r.text[lang], lang, rec), `${momentId} ${r.id} ${lang}`).toEqual([]);
      }
    }
    // Not vacuous: the stored text carries dozens of tallies and party counts.
    expect(counted).toBeGreaterThan(50);
  });

  test('the committed corpus: s_1c339dac (S. 4668 passage) reads every tally and party count it states, in both languages', () => {
    const entry = STORE['paying-college-athletes'];
    const r = entry.summary_revisions.find((x: Json) => x.id === 's_1c339dac');
    expect(r).toBeTruthy();
    expect(statedVoteCounts(r.text.en, 'en').map((c: Json) => c.text)).toEqual([
      '77 to 22', '50 Republicans', '26 Democrats', '96 to 1', '77 to 23', '74 to 25', '77 to 22',
    ]);
    expect(statedVoteCounts(r.text.es, 'es').map((c: Json) => c.text)).toEqual([
      '77 a 22', '50 republicanos', '26 demócratas', '96 a 1', '77 a 23', '74 a 25', '77 a 22',
    ]);
    expect(unheldVoteCounts(r.text.en, 'en', recordOf(entry, r))).toEqual([]);
    expect(unheldVoteCounts(r.text.es, 'es', recordOf(entry, r))).toEqual([]);
  });

  test('the committed corpus: the Big Question text\'s "77–22" forms (data/moments.json) read as the S. 4668 roll calls', () => {
    const mo = MOMENTS['paying-college-athletes'];
    const slugs = new Set(mo.vehicles.map((v: Json) => v.slug));
    const rec = voteCountRecord({ rollCalls: VOTES.rollCalls.filter((r: Json) => slugs.has(r.bill)) });
    for (const lang of ['en', 'es'] as const) {
      const text = String(mo.summary?.[lang] ?? '');
      const stated = statedVoteCounts(text, lang).map((c: Json) => c.text);
      expect(stated, lang).toContain('77–22');
      expect(unheldVoteCounts(text, lang, rec), lang).toEqual([]);
    }
  });

  test('the hand-authored "214-208" / "47-50" of 2026-07-25 read as pairs the vote file holds', () => {
    const entry = STORE['iran-war-powers'];
    const r = entry.summary_revisions.find((x: Json) => x.id === 's_d26a6b43');
    expect(statedVoteCounts(r.text.en, 'en').map((c: Json) => c.text)).toEqual(['214-208', '47-50']);
    const slugs = new Set(MOMENTS['iran-war-powers'].vehicles.map((v: Json) => v.slug));
    const rec = voteCountRecord({ rollCalls: VOTES.rollCalls.filter((x: Json) => slugs.has(x.bill)) });
    expect(unheldVoteCounts(r.text.en, 'en', rec)).toEqual([]);
    expect(unheldVoteCounts(r.text.es, 'es', rec)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 2b · the parity table (2026-10-06)
 *
 * Three independent checks on 2026-10-06 each found another vote-count form
 * read in one language and not in its twin. This table is what "both
 * languages are read the same way" means, and all it means: every twin form
 * in it is read as the same count in English and Spanish, held when the
 * record holds it and refused when it is invented; every range in it is read
 * in neither; every form in UNREAD is read in neither (the code note's WHAT
 * IT CANNOT SEE, lib/moment-updates-gate.mjs). A form outside this table is
 * not claimed either way. Every form any of the three checks named is here.
 * ------------------------------------------------------------------ */

test.describe('the vote-count lint · the parity table: twin forms read the same way in both languages', () => {
  // Senate roll 244: Yeas 49, Nays 50; Republicans 4 yea, 49 nay.
  const REC_244 = () => voteCountRecord({ rollCalls: [roll('s-119-2-244')] });
  type Form = (yeas: number, nays: number) => string;
  /** [where the form came from, English, Spanish], each written from the yeas and the nays. */
  const TWINS: [string, Form, Form][] = [
    ['case D', (y, n) => `by a vote of ${y} to ${n}`, (y, n) => `por una votación de ${y} a ${n}`],
    ['hyphen', (y, n) => `rejected ${y}-${n}`, (y, n) => `rechazada ${y}-${n}`],
    ['en dash', (y, n) => `rejected ${y}–${n}`, (y, n) => `rechazada ${y}–${n}`],
    ['spaced hyphen, the record\'s own', (y, n) => `rejected ${y} - ${n}`, (y, n) => `rechazada ${y} - ${n}`],
    ['non-breaking hyphen (check 1)', (y, n) => `rejected ${y}‑${n}`, (y, n) => `rechazada ${y}‑${n}`],
    ['hyphenated adjective (check 3)', (y, n) => `on a ${y}-to-${n} vote`, (y, n) => `en una votación de ${y} a ${n}`],
    ['hyphenated adverb (check 3)', (y, n) => `it failed ${y}-to-${n}`, (y, n) => `fracasó ${y} a ${n}`],
    ['bare contra (check 3)', (y, n) => `by ${y} to ${n}`, (y, n) => `por ${y} contra ${n}`],
    ['against / contra', (y, n) => `${y} against ${n}`, (y, n) => `${y} contra ${n}`],
    ['versus / frente a', (y, n) => `${y} versus ${n}`, (y, n) => `${y} frente a ${n}`],
    ['by N votes to M (check 2)', (y, n) => `by ${y} votes to ${n}`, (y, n) => `por ${y} votos a ${n}`],
    ['N votes against M', (y, n) => `${y} votes against ${n}`, (y, n) => `${y} votos contra ${n}`],
    ['N votes versus M', (y, n) => `got ${y} votes versus ${n}`, (y, n) => `obtuvo ${y} votos frente a ${n}`],
    ['yeas and nays', (y, n) => `${y} yeas and ${n} nays`, (y, n) => `${y} sí y ${n} no`],
    ['yea votes to nay votes (check 1)', (y, n) => `${y} yea votes to ${n} nay votes`, (y, n) => `${y} votos sí contra ${n} votos no`],
    ['votes in favor and against (check 1)', (y, n) => `${y} votes in favor and ${n} against`, (y, n) => `${y} votos a favor y ${n} votos en contra`],
    ['votes for and against (check 2)', (y, n) => `${y} votes for and ${n} against`, (y, n) => `${y} votos a favor y ${n} en contra`],
    ['N for, M against (check 1)', (y, n) => `${y} for, ${n} against`, (y, n) => `${y} a favor, ${n} en contra`],
    ['N for and M against (check 1)', (y, n) => `${y} for and ${n} against`, (y, n) => `${y} a favor y ${n} en contra`],
    ['votos en favor (check 3)', (y, n) => `${y} votes in favor and ${n} against`, (y, n) => `${y} votos en favor y ${n} en contra`],
    ['votos en pro (check 3)', (y, n) => `${y} in favor, ${n} opposed`, (y, n) => `${y} votos en pro, ${n} en contra`],
    ['label first, the record\'s order', (y, n) => `Yeas ${y}, Nays ${n}`, (y, n) => `A favor: ${y}, en contra: ${n}`],
    ['label first, in favor', (y, n) => `In favor: ${y}, against: ${n}`, (y, n) => `En favor: ${y}, en contra: ${n}`],
  ];

  test('every twin reads as the same single count in both languages, in the same order rule', () => {
    for (const [why, en, es] of TWINS) {
      const e = statedVoteCounts(en(49, 50), 'en');
      const s = statedVoteCounts(es(49, 50), 'es');
      expect(e.length, `${why} · en: ${en(49, 50)}`).toBe(1);
      expect(s.length, `${why} · es: ${es(49, 50)}`).toBe(1);
      expect([s[0].kind, s[0].a, s[0].b, s[0].ordered], `${why}: ${es(49, 50)}`).toEqual([e[0].kind, e[0].a, e[0].b, e[0].ordered]);
    }
  });

  test('every twin is held when the record holds it and refused when it is invented, in both languages', () => {
    const rec = REC_244();
    for (const [why, en, es] of TWINS) {
      expect(unheldVoteCounts(en(49, 50), 'en', rec), `${why} · held · en`).toEqual([]);
      expect(unheldVoteCounts(es(49, 50), 'es', rec), `${why} · held · es`).toEqual([]);
      expect(unheldVoteCounts(en(98, 0), 'en', rec).length, `${why} · invented · en: ${en(98, 0)}`).toBe(1);
      expect(unheldVoteCounts(es(98, 0), 'es', rec).length, `${why} · invented · es: ${es(98, 0)}`).toBe(1);
    }
  });

  test('the party figures, held and invented, in both languages', () => {
    const rec = REC_244();
    const held: [string, string][] = [
      ['Republicans: 4 yea, 49 nay.', 'Republicanos: 4 a favor, 49 en contra.'],
      ['4 Republicans voted yes.', '4 republicanos votaron a favor.'],
    ];
    const invented: [string, string][] = [
      ['Republicans: 49 yea, 4 nay.', 'Republicanos: 49 a favor, 4 en contra.'],
      ['5 Republicans voted yes.', '5 republicanos votaron a favor.'],
    ];
    for (const [en, es] of held) {
      const e = statedVoteCounts(en, 'en');
      const s = statedVoteCounts(es, 'es');
      expect(s.map((c: Json) => [c.kind, c.a, c.b, c.party]), es).toEqual(e.map((c: Json) => [c.kind, c.a, c.b, c.party]));
      expect(unheldVoteCounts(en, 'en', rec), en).toEqual([]);
      expect(unheldVoteCounts(es, 'es', rec), es).toEqual([]);
    }
    for (const [en, es] of invented) {
      expect(unheldVoteCounts(en, 'en', rec).length, en).toBe(1);
      expect(unheldVoteCounts(es, 'es', rec).length, es).toBe(1);
    }
  });

  // Ranges that are not vote counts: read in neither language.
  const RANGES: [string, string][] = [
    ['Rule 22 to 24', 'las reglas 22 a 24'],
    ['roll call votes 244-246', 'las votaciones 244-246'],
    ['roll calls 244 to 246', 'las votaciones nominales 244 a 246'],
    ['roll call 244 to 246', 'la votación nominal 244 a 246'],
    ['grades 9 to 12', 'los grados 9 a 12'],
    ['Divisions 1 to 3', 'las divisiones 1 a 3'],
    ['Tier 1-2', 'el nivel 1-2'],
    ['3 to 5 schools', '3 a 5 escuelas'],
    ['2 to 3 business days', '2 a 3 días hábiles'],
    ['paragraphs 3 to 5', 'los apartados 3 a 5'],
    ['paragraphs 3 to 5', 'las fracciones 3 a 5'],
    ['clauses 3 to 5', 'las cláusulas 3 a 5'],
    ['subsections 3 to 5', 'las subsecciones 3 a 5'],
    ['articles 3 to 5', 'los artículos 3 a 5'],
    ['ch. 3-5', 'cap. 3-5'],
    ['support grew from 47 votes to 60', 'el apoyo pasó de 47 votos a 60'],
    ['it rose from 47 to 60', 'subió de 47 a 60'],
    ['it fell from 60 to 47', 'bajó de 60 a 47'],
    ['between 3 and 5', 'entre 3 a 5'],
    ['5 to 10 points', '5 a 10 puntos'],
    ['1 to 2 p.m.', '1 a 2 p. m.'],
  ];

  test('every range in the table is read in neither language', () => {
    for (const [en, es] of RANGES) {
      expect(statedVoteCounts(en, 'en'), en).toEqual([]);
      expect(statedVoteCounts(es, 'es'), es).toEqual([]);
    }
  });

  // WHAT IT CANNOT SEE (the code note): read in neither language, so an invented count written this way passes in both.
  const UNREAD: [string, string][] = [
    ['It passed ninety-eight to zero.', 'Se aprobó noventa y ocho a cero.'],
    ['77 senators voted yes.', '77 senadores votaron a favor.'],
    ['It passed with 60 votes.', 'Se aprobó con 60 votos.'],
    ['98 senators voted for it and 0 against.', '98 senadores votaron a favor y 0 en contra.'],
    ['It passed with 98 votes for, and 0 against.', 'Se aprobó con 98 votos a favor, y 0 en contra.'],
    ['98 affirmative votes to 0 negative.', '98 votos afirmativos y 0 negativos.'],
    ['It passed 98-0-2.', 'Se aprobó 98-0-2.'],
  ];

  test('every form the code note says it cannot see is read in neither language', () => {
    for (const [en, es] of UNREAD) {
      expect(statedVoteCounts(en, 'en'), en).toEqual([]);
      expect(statedVoteCounts(es, 'es'), es).toEqual([]);
    }
  });

  test('the two it cannot tell from a tally are read in both languages, as the same count: a court split and a singular "vote" range', () => {
    const both: [string, string][] = [
      ['The court ruled 6-3.', 'El tribunal falló 6 a 3.'],
      ['See vote 244 to 246.', 'Véase la votación 244 a 246.'],
    ];
    for (const [en, es] of both) {
      const e = statedVoteCounts(en, 'en');
      const s = statedVoteCounts(es, 'es');
      expect(e.length, en).toBe(1);
      expect(s.map((c: Json) => [c.a, c.b]), es).toEqual(e.map((c: Json) => [c.a, c.b]));
    }
  });

  test('the absence lint\'s twins: caught in both languages, or left alone in both', () => {
    const caught: [string, string][] = [
      ['Neither measure has advanced.', 'Ninguna de las dos medidas ha avanzado.'],
      ['Neither measure advanced.', 'Ninguna de las dos medidas avanzó.'],
      ['Neither measure has moved since July.', 'Ninguna de las dos medidas se ha movido desde julio.'],
      ['Neither chamber moved it.', 'Ninguna de las cámaras lo movió.'],
      ['Neither chamber acted.', 'Ninguna cámara actuó.'],
      ['Neither the House nor the Senate voted.', 'Ni la Cámara ni el Senado votaron.'],
    ];
    const leftAlone: [string, string][] = [
      ['Neither the House nor the Senate voted in favor.', 'Ni la Cámara ni el Senado votaron en favor.'],
      ['Neither the House nor the Senate voted in favor.', 'Ni la Cámara ni el Senado votaron en pro.'],
      ['None of the funding for advanced nuclear reactors was cut.', 'Ninguno de los fondos para reactores nucleares avanzados se recortó.'],
      ['None of the Republicans voted yes.', 'Ninguno de los republicanos votó a favor.'],
    ];
    for (const [en, es] of caught) {
      expect(absenceClaims(en, 'en'), en).not.toEqual([]);
      expect(absenceClaims(es, 'es'), es).not.toEqual([]);
    }
    for (const [en, es] of leftAlone) {
      expect(absenceClaims(en, 'en'), en).toEqual([]);
      expect(absenceClaims(es, 'es'), es).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3 · the collector refuses, the gate re-checks
 * ------------------------------------------------------------------ */

test.describe('the collector refuses an unheld count; nothing is stored', () => {
  const today = etDay(new Date());
  const PENNY_UPDATE = {
    id: 'u_00000001',
    class: 'floor_action',
    vehicle: 'hr-10167-119',
    day: today,
    occurred_at: today,
    occurred_precision: 'day',
    recorded_at: `${today}T20:00:00.000Z`,
    text: { en: 'x', es: 'x' },
    source: { kind: 'congress_actions', refs: ['https://www.congress.gov/bill/119th-congress/house-bill/10167'] },
    record: { action_text: 'Passed Senate without amendment by Unanimous Consent.', action_code: null, action_type: 'Floor', source_system: 'Senate' },
    ai: true,
  };
  const STATUSES = { 'hr-10167-119': 'passed_chamber' };

  test('case D through generateStateSummary: "98 to 0" over a unanimous-consent window → null, the previous revision stands', async () => {
    const previous = { id: 's_00000001', text: { en: 'Prior.', es: 'Previo.' } };
    const entry = { updates: [PENNY_UPDATE], summary_revisions: [previous] };
    const revision = await generateStateSummary(
      replying({
        en: 'On September 28, 2026, the Senate passed H.R. 10167 without amendment by a vote of 98 to 0.',
        es: 'El 28 de septiembre de 2026, el Senado aprobó el H.R. 10167 sin enmiendas por una votación de 98 a 0.',
      }),
      'penny-production-and-cash-rounding', entry, STATUSES, [], {}, [], [],
    );
    expect(revision).toBeNull();
    expect(entry.summary_revisions).toEqual([previous]);
  });

  test('the same window, written the way the record says it: stored', async () => {
    const entry = { updates: [PENNY_UPDATE], summary_revisions: [] };
    const revision = await generateStateSummary(
      replying({
        en: 'On September 28, 2026, the Senate passed H.R. 10167 without amendment by unanimous consent.',
        es: 'El 28 de septiembre de 2026, el Senado aprobó el H.R. 10167 sin enmiendas por consentimiento unánime.',
      }),
      'penny-production-and-cash-rounding', entry, STATUSES, [], {}, [], [],
    );
    expect(revision).not.toBeNull();
  });

  test('a printed roll call: its tally passes, a sibling roll call\'s tally the prompt did not print does not', async () => {
    const R250 = roll('s-119-2-250');
    const ok = await generateStateSummary(
      replying({
        en: 'On September 28, 2026, the Senate passed S. 4668 by a recorded vote of 77 to 22 (Roll no. 250). On that vote, 50 Republicans and 26 Democrats voted yes.',
        es: 'El 28 de septiembre de 2026, el Senado aprobó el S. 4668 por votación nominal de 77 a 22 (votación núm. 250). En esa votación, 50 republicanos y 26 demócratas votaron a favor.',
      }),
      'paying-college-athletes', { updates: [], summary_revisions: [] }, { 's-4668-119': 'passed_chamber' }, [], {}, [R250], [R250.id],
    );
    expect(ok).not.toBeNull();
    const refused = await generateStateSummary(
      replying({
        en: 'On September 28, 2026, the Senate passed S. 4668 by a recorded vote of 77 to 23.',
        es: 'El 28 de septiembre de 2026, el Senado aprobó el S. 4668 por votación nominal de 77 a 23.',
      }),
      'paying-college-athletes', { updates: [], summary_revisions: [] }, { 's-4668-119': 'passed_chamber' }, [], {}, [R250], [R250.id],
    );
    expect(refused).toBeNull();
  });
});

test.describe('the gate re-checks what is stored (checkMomentUpdates, opts.rollCallsById)', () => {
  const billSlugs = new Set(BILLS.map((b: Json) => b.full_identifier));
  const now = Date.parse(STORE._meta?.generated_at ?? new Date().toISOString()) + 86_400_000;
  const run = (file: Json, byId?: Map<string, Json>) =>
    checkMomentUpdates(file, MOMENTS, billSlugs, { now, ...(byId ? { rollCallsById: byId } : {}) });
  const voteViolations = (res: { violations: string[] }) => res.violations.filter((v) => v.includes('vote count'));

  test('the committed file passes with the vote file supplied', () => {
    expect(voteViolations(run(STORE, ROLL_BY_ID))).toEqual([]);
  });

  test('a stored revision with an invented count fails, in each language', () => {
    const file = structuredClone(STORE);
    const revs = file['iran-war-powers'].summary_revisions;
    const r = revs[revs.length - 1];
    expect(r.text.en).toContain('49 to 50');
    r.text.en = r.text.en.replace('49 to 50', '98 to 0');
    r.text.es = r.text.es.replace('49 a 50', '98 a 0');
    const v = voteViolations(run(file, ROLL_BY_ID));
    expect(v).toHaveLength(2);
    expect(v[0]).toContain('.text.en: vote count "98 to 0"');
    expect(v[1]).toContain('.text.es: vote count "98 a 0"');
    // Without the vote file the check does not run (fixture suites keep their call shape).
    expect(voteViolations(run(file))).toEqual([]);
  });

  test('a roll call the vote file no longer holds leaves the record unknown: a warning, never a guess', () => {
    const file = structuredClone(STORE);
    const revs = file['iran-war-powers'].summary_revisions;
    revs[revs.length - 1].text.en = revs[revs.length - 1].text.en.replace('49 to 50', '98 to 0');
    const partial = new Map(ROLL_BY_ID);
    partial.delete('s-119-2-244');
    const res = run(file, partial);
    expect(voteViolations(res)).toEqual([]);
    expect(res.warnings.some((w: string) => w.includes('vote counts not checked') && w.includes('s-119-2-244'))).toBe(true);
  });
  test('a count the window did not print but the vote file holds on the measures passes on what is stored (the collector stays strict)', () => {
    // 214 to 208 is House roll 282 on H.Con.Res. 89 (2026-07-23): outside the window of the current revision.
    const file = structuredClone(STORE);
    const revs = file['iran-war-powers'].summary_revisions;
    const r = revs[revs.length - 1];
    expect(r.grounded_in.roll_calls).not.toContain('h-119-2-282');
    r.text.en = `${r.text.en} In July, the House agreed to it 214 to 208.`;
    r.text.es = `${r.text.es} En julio, la Cámara la aprobó 214 a 208.`;
    expect(voteViolations(run(file, ROLL_BY_ID))).toEqual([]);
  });

  test('grounded_in.roll_calls_on_record widens the stored record on its own, for a roll call whose bill is not one of the vehicles', () => {
    // 214 to 208 is House roll 282 (2026-07-23). Here its `bill` is taken not
    // to map to a vehicle, so only the revision's roll_calls_on_record can hold it.
    const file = structuredClone(STORE);
    const r = file['iran-war-powers'].summary_revisions.at(-1);
    expect(r.grounded_in.roll_calls).not.toContain('h-119-2-282');
    expect(r.grounded_in.roll_calls_on_record).toContain('h-119-2-282');
    r.text.en = `${r.text.en} In July, the House agreed to it 214 to 208.`;
    r.text.es = `${r.text.es} En julio, la Cámara la aprobó 214 a 208.`;
    const unmapped = new Map(ROLL_BY_ID);
    unmapped.set('h-119-2-282', { ...roll('h-119-2-282'), bill: 'hr-0-119' });
    expect(voteViolations(run(file, unmapped))).toEqual([]);
    // Without it on the record, the same count is refused, in each language.
    r.grounded_in.roll_calls_on_record = r.grounded_in.roll_calls_on_record.filter((id: string) => id !== 'h-119-2-282');
    const v = voteViolations(run(file, unmapped));
    expect(v).toHaveLength(2);
    expect(v[0]).toContain('.text.en: vote count "214 to 208"');
    expect(v[1]).toContain('.text.es: vote count "214 a 208"');
  });

  test('retention never makes the stored check stricter: a tally held only by a pruned record sentence becomes a warning, not a failure', () => {
    // The independent check's case: the night's votes sync lagged, so the
    // revision's window held no roll call, and the tally came from the
    // chamber's sentence alone ("Failed of passage in Senate by Yea-Nay
    // Vote. 49 - 50"). The vote file is taken to hold no roll call on the
    // measure either (a roll call whose bill does not map), so nothing but
    // that sentence holds the count.
    const file = structuredClone(STORE);
    const entry = file['iran-war-powers'];
    const r = entry.summary_revisions.find((x: Json) => x.id === 's_0cf29b30');
    expect(r).toBeTruthy();
    expect(r.text.en).toContain('49 to 50');
    r.grounded_in.roll_calls = [];
    r.grounded_in.roll_calls_on_record = [];
    // A count by party is only ever held by a roll call, so the sentence that states one goes with it.
    r.text.en = r.text.en.replace(' Republicans: 4 yea, 49 nay.', '');
    r.text.es = r.text.es.replace(' Republicanos: 4 a favor, 49 en contra.', '');
    expect(r.text.en).not.toContain('Republicans');
    const noMeasureRolls = new Map([...ROLL_BY_ID].filter(([, rc]) => !MOMENTS['iran-war-powers'].vehicles.some((v: Json) => v.slug === rc.bill)));
    const voteRows = (res: { violations: string[]; warnings: string[] }) => ({
      violations: res.violations.filter((v) => v.includes('s_0cf29b30') || (v.includes('vote count') && v.includes('iran-war-powers'))),
      warnings: res.warnings.filter((w) => w.includes('vote count') && w.includes('49 to 50')),
    });

    // Today: the sentence is still cited, the count is held.
    const today = voteRows(checkMomentUpdates(file, MOMENTS, billSlugs, { now, rollCallsById: noMeasureRolls }));
    expect(today.violations).toEqual([]);

    // 2026-12-20: retention has pruned the cited updates; the revision is kept, citing nothing.
    const later = Date.parse('2026-12-20T17:00:00Z');
    const prunedEntry = pruneEntry(entry, { now: later }) as Json;
    const kept = prunedEntry.summary_revisions.find((x: Json) => x.id === 's_0cf29b30');
    expect(kept.grounded_in.update_ids).toEqual([]);
    const prunedFile = { ...file, 'iran-war-powers': prunedEntry };
    const after = checkMomentUpdates(prunedFile, MOMENTS, billSlugs, { now: later, rollCallsById: noMeasureRolls });
    expect(after.violations.filter((v) => v.includes('vote count'))).toEqual([]);
    const w = voteRows(after).warnings;
    expect(w.length).toBe(1);
    expect(w[0]).toContain('not enforced: retention may have dropped');

    // With the vote file's roll call on the measure, the same pruned revision is held outright: no warning at all.
    const held = checkMomentUpdates(prunedFile, MOMENTS, billSlugs, { now: later, rollCallsById: ROLL_BY_ID });
    expect(held.violations.filter((v) => v.includes('vote count'))).toEqual([]);
    expect(voteRows(held).warnings).toEqual([]);
  });

  test('an invented count on a revision retention cannot have touched still fails', () => {
    const file = structuredClone(STORE);
    const entry = file['iran-war-powers'];
    const r = entry.summary_revisions.find((x: Json) => x.id === 's_0cf29b30');
    r.text.en = r.text.en.replace('49 to 50', '98 to 0');
    r.text.es = r.text.es.replace('49 a 50', '98 a 0');
    expect(groundingMayBePruned(r, entry.updates, etDay(now))).toBeNull();
    const v = voteViolations(run(file, ROLL_BY_ID));
    expect(v.filter((x) => x.includes('summary_revisions') && x.includes('98'))).toHaveLength(2);
  });
});

test.describe('groundingMayBePruned · when retention can have dropped what a revision was written from', () => {
  const today = '2026-12-20';
  const safeAge = RETENTION_DAYS - STORED_SUMMARY_WINDOW_DAYS;
  const upd = (day: string) => ({ id: `u_${day}`, day, class: 'floor_action' });

  test('the window constant is the collector\'s', () => {
    expect(STORED_SUMMARY_WINDOW_DAYS).toBe(SUMMARY_WINDOW_DAYS);
  });

  test('by age: safe while the window starts inside retention, from the first day it cannot', () => {
    expect(groundingMayBePruned({ as_of_day: shiftDay(today, -safeAge) }, [], today)).toBeNull();
    expect(groundingMayBePruned({ as_of_day: shiftDay(today, -(safeAge + 1)) }, [], today)).toContain('retention');
    // The boundary is exact: an update on the window's first day is kept by pruneEntry on that day.
    const asOf = shiftDay(today, -safeAge);
    const first = { ...upd(shiftDay(asOf, -STORED_SUMMARY_WINDOW_DAYS)), occurred_at: shiftDay(asOf, -STORED_SUMMARY_WINDOW_DAYS), recorded_at: `${asOf}T00:00:00Z` };
    const pruned = pruneEntry({ updates: [first], summary_revisions: [] }, { now: Date.parse(`${today}T17:00:00Z`) }) as Json;
    expect(pruned.updates.map((u: Json) => u.id)).toEqual([first.id]);
  });

  test('by count: a moment at its cap, or a day in the window at the per-day ceiling', () => {
    const asOf = shiftDay(today, -1);
    expect(groundingMayBePruned({ as_of_day: asOf }, Array.from({ length: MAX_UPDATES_PER_MOMENT }, () => upd(asOf)), today)).toContain('per-moment');
    expect(groundingMayBePruned({ as_of_day: asOf }, Array.from({ length: HARD_DAY_CEILING }, () => upd(shiftDay(asOf, -3))), today)).toContain('per-day');
    // A busy day OUTSIDE the window does not matter.
    expect(groundingMayBePruned({ as_of_day: asOf }, Array.from({ length: HARD_DAY_CEILING }, () => upd(shiftDay(asOf, -30))), today)).toBeNull();
    expect(groundingMayBePruned({ as_of_day: asOf }, Array.from({ length: HARD_DAY_CEILING - 1 }, () => upd(asOf)), today)).toBeNull();
  });

  test('no as_of_day: the window is unknown, so it may', () => {
    expect(groundingMayBePruned({}, [], today)).toContain('as_of_day');
  });
});

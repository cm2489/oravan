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
      'See roll call votes 244-246 and recorded votes 244 to 246.',
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

  // The text of s_1c339dac (paying-college-athletes, 2026-09-29) as it was stored,
  // copied here so the test depends on neither the revision nor the nightly data:
  // revisions are trimmed by count, and a pinned id goes with the oldest. What it
  // is held against is data/votes.json, which never rewrites a roll call it holds.
  const S_1C339DAC = {
    en: "The Senate passed S. 4668, the Protect College Sports Act of 2026, on September 28, 2026, by a recorded vote of 77 to 22 (Roll no. 250). On that vote, 50 Republicans and 26 Democrats voted yes. Earlier that day, senators rejected four amendments and agreed to one, by a recorded vote of 96 to 1 (Roll no. 245). Before that, the Senate agreed to amendment S.Amdt. 6776 on September 24, 2026, by a recorded vote of 77 to 23 (Roll no. 242), and invoked cloture on the bill the same day, 74 to 25 (Roll no. 243). The Senate voted 77 to 22 on September 17, 2026, to proceed to the bill (Roll no. 236). The bill is now listed as \"Passed one chamber.\"",
    es: "El Senado aprobó el proyecto S. 4668, la Ley para Proteger los Deportes Universitarios de 2026, el 28 de septiembre de 2026, por votación nominal de 77 a 22 (votación núm. 250). En esa votación, 50 republicanos y 26 demócratas votaron a favor. Ese mismo día, los senadores rechazaron cuatro enmiendas y aprobaron una, por votación nominal de 96 a 1 (votación núm. 245). Antes, el 24 de septiembre de 2026, el Senado aprobó la enmienda S.Amdt. 6776 por votación nominal de 77 a 23 (votación núm. 242) y ese mismo día invocó el cierre del debate sobre el proyecto, por 74 a 25 (votación núm. 243). El 17 de septiembre de 2026, el Senado votó 77 a 22 para proceder al proyecto (votación núm. 236). El proyecto figura ahora como \"Aprobado por una cámara\".",
    rolls: ["s-119-2-250", "s-119-2-249", "s-119-2-248", "s-119-2-247", "s-119-2-246", "s-119-2-245", "s-119-2-243", "s-119-2-242", "s-119-2-240", "s-119-2-236", "s-119-2-235"],
  };
  test('the S. 4668 passage summary (stored text, copied) reads every tally and party count it states, in both languages', () => {
    expect(statedVoteCounts(S_1C339DAC.en, 'en').map((c: Json) => c.text)).toEqual([
      '77 to 22', '50 Republicans', '26 Democrats', '96 to 1', '77 to 23', '74 to 25', '77 to 22',
    ]);
    expect(statedVoteCounts(S_1C339DAC.es, 'es').map((c: Json) => c.text)).toEqual([
      '77 a 22', '50 republicanos', '26 demócratas', '96 a 1', '77 a 23', '74 a 25', '77 a 22',
    ]);
    const rec = voteCountRecord({ rollCalls: S_1C339DAC.rolls.map(roll) });
    expect(unheldVoteCounts(S_1C339DAC.en, 'en', rec)).toEqual([]);
    expect(unheldVoteCounts(S_1C339DAC.es, 'es', rec)).toEqual([]);
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

  // s_d26a6b43 (iran-war-powers, 2026-07-25), the hand-authored text as stored, copied
  // here for the same reason as above.
  const S_D26A6B43 = {
    en: "On July 23, 2026 the House adopted H. Con. Res. 89, 214-208, and the Senate referred it to the Committee on Foreign Relations that day. On June 24, 2026 the Senate rejected a motion to proceed to S.J.Res. 185, 47-50.",
    es: "El 23 de julio de 2026 la Cámara aprobó la H. Con. Res. 89, 214-208, y el Senado la remitió al Comité de Relaciones Exteriores ese mismo día. El 24 de junio de 2026 el Senado rechazó una moción para considerar la S.J.Res. 185, 47-50.",
  };
  test('the hand-authored "214-208" / "47-50" of 2026-07-25 (stored text, copied) read as pairs the vote file holds', () => {
    expect(statedVoteCounts(S_D26A6B43.en, 'en').map((c: Json) => c.text)).toEqual(['214-208', '47-50']);
    const slugs = new Set(MOMENTS['iran-war-powers'].vehicles.map((v: Json) => v.slug));
    const rec = voteCountRecord({ rollCalls: VOTES.rollCalls.filter((x: Json) => slugs.has(x.bill)) });
    expect(unheldVoteCounts(S_D26A6B43.en, 'en', rec)).toEqual([]);
    expect(unheldVoteCounts(S_D26A6B43.es, 'es', rec)).toEqual([]);
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
    // A fourth independent check (2026-10-06) found the English "vs." / "versus" read and the Spanish not.
    ['vs. (check 4)', (y, n) => `it passed ${y} vs. ${n}`, (y, n) => `se aprobó ${y} vs. ${n}`],
    ['vs without a period (check 4)', (y, n) => `it passed ${y} vs ${n}`, (y, n) => `se aprobó ${y} vs ${n}`],
    ['versus, same word in both (check 4)', (y, n) => `it passed ${y} versus ${n}`, (y, n) => `se aprobó ${y} versus ${n}`],
    ['N votes vs. M (check 4)', (y, n) => `got ${y} votes vs. ${n}`, (y, n) => `obtuvo ${y} votos vs. ${n}`],
    ['N votes versus M, same word in both (check 4)', (y, n) => `got ${y} votes versus ${n}`, (y, n) => `obtuvo ${y} votos versus ${n}`],
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
    // 2026-11-11, the independent review of 791239b2.
    ['singular roll call, then a tally (review 5)', (y, n) => `it failed on roll call ${y} to ${n}`, (y, n) => `fracasó por votación nominal ${y} a ${n}`],
    ['singular roll call, hyphen (review 5)', (y, n) => `it failed on roll call ${y}-${n}`, (y, n) => `fracasó en votación nominal ${y}-${n}`],
    ['label first with the word votes (review 5)', (y, n) => `Votes in favor: ${y}, votes against: ${n}`, (y, n) => `Votos a favor: ${y}, votos en contra: ${n}`],
    ['ayes to noes (review 5)', (y, n) => `${y} ayes to ${n} noes`, (y, n) => `${y} sí a ${n} no`],
    ['ayes versus noes (review 5)', (y, n) => `${y} ayes versus ${n} noes`, (y, n) => `${y} sí versus ${n} no`],
    ['cast votes N to M (review 5)', (y, n) => `Senators cast votes ${y} to ${n}`, (y, n) => `Los senadores emitieron votos ${y} a ${n}`],
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
    ['roll calls 249 and 250', 'las votaciones nominales 249 y 250'],
    ['roll calls 249 to 250', 'las votaciones nominales 249 a 250'],
    ['Roll no. 250', 'votación núm. 250'],
    ['roll call 250', 'votación nominal 250'],
    ['roll call votes 244 to 246', 'las votaciones 244 a 246'],
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
    // The new "vs." / "versus" reading (check 4) keeps every range exclusion: near-misses that must stay un-flagged.
    ['rule 22 vs. 24', 'la regla 22 vs. 24'],
    ['article 12 versus 14', 'el artículo 12 versus 14'],
    ['60 votes versus the threshold', 'los 60 votos versus el umbral'],
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

  test('a three-number split is read in neither language with any dash: hyphen, en dash, em dash, minus sign, non-breaking hyphen', () => {
    for (const d of ['-', '–', '—', '−', '\u2011']) {
      expect(statedVoteCounts(`It passed 98${d}0${d}2.`, 'en'), `en ${JSON.stringify(d)}`).toEqual([]);
      expect(statedVoteCounts(`Se aprobó 98${d}0${d}2.`, 'es'), `es ${JSON.stringify(d)}`).toEqual([]);
    }
    // …and a single pair is read with each of them, also when the dash is the writer's punctuation around it.
    for (const d of ['-', '–', '—', '−', '\u2011']) {
      expect(statedVoteCounts(`It passed 98${d}0.`, 'en').map((c: Json) => [c.a, c.b]), `en pair ${JSON.stringify(d)}`).toEqual([[98, 0]]);
      expect(statedVoteCounts(`Se aprobó 98${d}0.`, 'es').map((c: Json) => [c.a, c.b]), `es pair ${JSON.stringify(d)}`).toEqual([[98, 0]]);
    }
    expect(statedVoteCounts('It passed—98–0—on Tuesday.', 'en').map((c: Json) => [c.a, c.b])).toEqual([[98, 0]]);
    expect(statedVoteCounts('Se aprobó—98–0—el martes.', 'es').map((c: Json) => [c.a, c.b])).toEqual([[98, 0]]);
  });

  test('a roll-call NUMBER is skipped and a TALLY after the singular phrase is read, in both languages', () => {
    // "roll call vote No. 250, 77-22" is the tally 77-22 and never 250-77.
    expect(statedVoteCounts('It passed on a roll call vote No. 250, 77-22.', 'en').map((c: Json) => [c.a, c.b])).toEqual([[77, 22]]);
    expect(statedVoteCounts('Se aprobó en la votación nominal núm. 250, 77-22.', 'es').map((c: Json) => [c.a, c.b])).toEqual([[77, 22]]);
    for (const [en, es] of [
      ['It passed on roll call 98-0.', 'Se aprobó por votación nominal 98 a 0.'],
      ['It passed on roll call 98 to 0.', 'Se aprobó en votación nominal 98-0.'],
    ]) {
      expect(statedVoteCounts(en, 'en').map((c: Json) => [c.a, c.b]), en).toEqual([[98, 0]]);
      expect(statedVoteCounts(es, 'es').map((c: Json) => [c.a, c.b]), es).toEqual([[98, 0]]);
      expect(unheldVoteCounts(en, 'en', REC_244()).length, en).toBe(1);
      expect(unheldVoteCounts(es, 'es', REC_244()).length, es).toBe(1);
    }
  });

  // KNOWN FALSE REFUSALS (the code note): an ordinary range worded like a tally. Read as a count in BOTH
  // languages, so a true sentence like these is refused unless the record holds that pair. No small
  // rule separates them from a tally without letting "it cleared 98-0" through, so none is attempted.
  const KNOWN_FALSE_REFUSALS: [string, string, [number, number]][] = [
    ['The bill needs 60 to 67 votes.', 'El proyecto necesita de 60 a 67 votos.', [60, 67]],
    ['It affects young people 18 to 24.', 'Afecta a jóvenes de 18 a 24.', [18, 24]],
    ['It was debated in 2 to 3 sessions.', 'Se debatió en 2 a 3 sesiones.', [2, 3]],
  ];
  test('the one asymmetry the code note names, and does not claim to match: English bare "votes N to M" is read as ballots, "votaciones" and "roll call votes" are skipped', () => {
    expect(statedVoteCounts('Senators cast votes 244 to 246.', 'en').map((c: Json) => [c.a, c.b])).toEqual([[244, 246]]);
    expect(statedVoteCounts('Los senadores emitieron votos 244 a 246.', 'es').map((c: Json) => [c.a, c.b])).toEqual([[244, 246]]);
    expect(statedVoteCounts('See roll call votes 244 to 246.', 'en')).toEqual([]);
    expect(statedVoteCounts('Véanse las votaciones 244 a 246.', 'es')).toEqual([]);
  });

  test('the known false refusals are read in both languages, as the code note says', () => {
    for (const [en, es, pair] of KNOWN_FALSE_REFUSALS) {
      expect(statedVoteCounts(en, 'en').map((c: Json) => [c.a, c.b]), en).toEqual([pair]);
      expect(statedVoteCounts(es, 'es').map((c: Json) => [c.a, c.b]), es).toEqual([pair]);
    }
  });

  test('the two it cannot tell from a tally are read in both languages, as the same count: a court split and a singular "vote" range', () => {
    const both: [string, string][] = [
      ['The court ruled 6-3.', 'El tribunal falló 6 a 3.'],
      ['See vote 244 to 246.', 'Véase la votación 244 a 246.'],
      ['See roll call 244 to 246.', 'Véase la votación nominal 244 a 246.'],
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
      // Check 4 (2026-10-06): "ningún", the short masculine form before a noun, is "ninguno" / "ninguna" too.
      ['Neither bill had a new vote.', 'Ningún proyecto tuvo una votación nueva.'],
      ['Neither bill has moved.', 'Ningún proyecto se ha movido.'],
      ['Neither bill advanced.', 'Ningún proyecto avanzó.'],
      ['Neither chamber voted.', 'Ningún pleno votó.'],
      // 2026-11-11: "Nothing else happened" was caught in English only.
      ['Nothing else happened.', 'No pasó nada más.'],
      ['Nothing else happened.', 'Nada más ocurrió.'],
      ['Nothing happened.', 'No ocurrió nada.'],
    ];
    const leftAlone: [string, string][] = [
      ['Neither the House nor the Senate voted in favor.', 'Ni la Cámara ni el Senado votaron en favor.'],
      ['Neither the House nor the Senate voted in favor.', 'Ni la Cámara ni el Senado votaron en pro.'],
      ['None of the funding for advanced nuclear reactors was cut.', 'Ninguno de los fondos para reactores nucleares avanzados se recortó.'],
      ['None of the Republicans voted yes.', 'Ninguno de los republicanos votó a favor.'],
      // Check 4's near-misses for "ningún": a party count, never an absence claim.
      ['No Republican voted yes.', 'Ningún republicano votó a favor.'],
      ['No Republican voted against it.', 'Ningún republicano votó en contra.'],
      ['No senator voted no.', 'Ningún senador votó no.'],
      // 2026-11-11: a subject that cast a vote is a party count in both languages ("Ningún" was refused).
      ['No Republican cast a vote for it.', 'Ningún republicano emitió un voto a favor.'],
      ['No Republican cast a vote against it.', 'Ningún republicano emitió un voto en contra.'],
      ['None of the Republicans cast a vote for it.', 'Ninguno de los republicanos emitió un voto a favor.'],
      ['Neither Republican cast a vote against it.', 'Ninguno de los republicanos emitió un voto en contra.'],
      ['No Republicans cast votes against it.', 'Ningún republicano emitió votos en contra.'],
      ['No Republican votes were cast for it.', 'No hubo votos republicanos a favor.'],
      // What a bill WOULD do is not a claim that nothing happened ("would change" was refused in English only).
      ['Neither bill would change the tax.', 'Ningún proyecto cambiaría el impuesto.'],
      ['None of its provisions would change current law.', 'Ninguna de sus disposiciones cambiaría la ley vigente.'],
      ['Neither bill will change.', 'Ningún proyecto cambiará.'],
      // "the change" is a named change, not "no change at all" (refused in Spanish only).
      ['Neither the House nor Senate version includes the change.', 'Ni la versión de la Cámara ni la del Senado incluye el cambio.'],
      ['Neither version includes the change.', 'Ninguna versión incluye el cambio.'],
    ];
    for (const [en, es] of caught) {
      expect(absenceClaims(en, 'en'), en).not.toEqual([]);
      expect(absenceClaims(es, 'es'), es).not.toEqual([]);
    }
    // The narrowing opens nothing: a bare vote or an unnamed change after "neither" / "ninguno" is still an absence claim.
    for (const [en, es] of [
      ['Neither bill had a change.', 'Ningún proyecto tuvo un cambio.'],
      ['None of them cast a vote.', 'Ninguno emitió un voto.'],
      ['Neither bill had a vote in the Senate.', 'Ningún proyecto tuvo un voto en el Senado.'],
    ]) {
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
  // A test that expects a count to be a VIOLATION must say what day it is: after
  // retention can have pruned the record the revision was written from
  // (groundingMayBePruned), the same count is only a warning. So those tests
  // take their clock from the revision itself, one day after its as_of_day,
  // never from the nightly data's generated_at, which moves every night.
  const nowAfter = (r: Json): number => Date.parse(`${r.as_of_day}T17:00:00Z`) + 86_400_000;
  const runAt = (file: Json, at: number, byId?: Map<string, Json>) =>
    checkMomentUpdates(file, MOMENTS, billSlugs, { now: at, ...(byId ? { rollCallsById: byId } : {}) });
  const voteViolations = (res: { violations: string[] }) => res.violations.filter((v) => v.includes('vote count'));
  // The stored revision that states the Senate's 49-50 tally in both languages. The
  // NEWEST revision of a question is not it for long (the nightly run appends
  // revisions, and a later one can drop the tally), so these tests pick the
  // revision by what it says, never by its position. `extra` narrows further.
  const tallyRevision = (file: Json, extra: (r: Json) => boolean = () => true): Json => {
    const hit = file['iran-war-powers'].summary_revisions.findLast((r: Json) => r.text.en.includes('49 to 50') && r.text.es.includes('49 a 50') && extra(r));
    expect(hit, 'a stored iran-war-powers revision that states the 49-50 tally in both languages').toBeTruthy();
    return hit;
  };

  test('the committed file passes with the vote file supplied', () => {
    expect(voteViolations(run(STORE, ROLL_BY_ID))).toEqual([]);
  });

  test('a stored revision with an invented count fails, in each language', () => {
    const file = structuredClone(STORE);
    const r = tallyRevision(file);
    expect(r.text.en).toContain('49 to 50');
    r.text.en = r.text.en.replace('49 to 50', '98 to 0');
    r.text.es = r.text.es.replace('49 a 50', '98 a 0');
    const v = voteViolations(runAt(file, nowAfter(r), ROLL_BY_ID));
    expect(v).toHaveLength(2);
    expect(v[0]).toContain('.text.en: vote count "98 to 0"');
    expect(v[1]).toContain('.text.es: vote count "98 a 0"');
    // Without the vote file the check does not run (fixture suites keep their call shape).
    expect(voteViolations(run(file))).toEqual([]);
  });

  test('a roll call the vote file no longer holds leaves the record unknown: a warning, never a guess', () => {
    const file = structuredClone(STORE);
    const r = tallyRevision(file);
    expect(r.grounded_in.roll_calls).toContain('s-119-2-244');
    r.text.en = r.text.en.replace('49 to 50', '98 to 0');
    const partial = new Map(ROLL_BY_ID);
    partial.delete('s-119-2-244');
    const res = run(file, partial);
    expect(voteViolations(res)).toEqual([]);
    expect(res.warnings.some((w: string) => w.includes('vote counts not checked') && w.includes('s-119-2-244'))).toBe(true);
  });
  test('a count the window did not print but the vote file holds on the measures passes on what is stored (the collector stays strict)', () => {
    // 214 to 208 is House roll 282 on H.Con.Res. 89 (2026-07-23): outside the window of the current revision.
    const file = structuredClone(STORE);
    const r = tallyRevision(file, (x) => !(x.grounded_in.roll_calls ?? []).includes('h-119-2-282'));
    expect(r.grounded_in.roll_calls).not.toContain('h-119-2-282');
    r.text.en = `${r.text.en} In July, the House agreed to it 214 to 208.`;
    r.text.es = `${r.text.es} En julio, la Cámara la aprobó 214 a 208.`;
    expect(voteViolations(run(file, ROLL_BY_ID))).toEqual([]);
  });

  test('grounded_in.roll_calls_on_record widens the stored record on its own, for a roll call whose bill is not one of the vehicles', () => {
    // 214 to 208 is House roll 282 (2026-07-23). Here its `bill` is taken not
    // to map to a vehicle, so only the revision's roll_calls_on_record can hold it.
    const file = structuredClone(STORE);
    const r = tallyRevision(file, (x) => !(x.grounded_in.roll_calls ?? []).includes('h-119-2-282') && (x.grounded_in.roll_calls_on_record ?? []).includes('h-119-2-282'));
    expect(r.grounded_in.roll_calls).not.toContain('h-119-2-282');
    expect(r.grounded_in.roll_calls_on_record).toContain('h-119-2-282');
    r.text.en = `${r.text.en} In July, the House agreed to it 214 to 208.`;
    r.text.es = `${r.text.es} En julio, la Cámara la aprobó 214 a 208.`;
    const unmapped = new Map(ROLL_BY_ID);
    unmapped.set('h-119-2-282', { ...roll('h-119-2-282'), bill: 'hr-0-119' });
    expect(voteViolations(run(file, unmapped))).toEqual([]);
    // Without it on the record, the same count is refused, in each language.
    r.grounded_in.roll_calls_on_record = r.grounded_in.roll_calls_on_record.filter((id: string) => id !== 'h-119-2-282');
    const v = voteViolations(runAt(file, nowAfter(r), unmapped));
    expect(v).toHaveLength(2);
    expect(v[0]).toContain('.text.en: vote count "214 to 208"');
    expect(v[1]).toContain('.text.es: vote count "214 a 208"');
  });

  // The two retention tests below build their own question, update and revision,
  // so they depend on no stored revision (revisions are trimmed by count and
  // would take a pinned id with them) and on no clock: every date is written
  // here. The vote is the Senate's 49-50 on 2026-09-24 (Roll no. 244).
  const SYN_MOMENT = 'synthetic-moment';
  const SYN_SLUG = 'sjres-1-119';
  const SYN_AS_OF = '2026-10-04';
  const synthetic = () => {
    const update = {
      id: 'u_syn00001',
      class: 'vote',
      vehicle: SYN_SLUG,
      day: '2026-09-24',
      occurred_at: '2026-09-24',
      occurred_precision: 'day',
      recorded_at: '2026-09-24T20:00:00.000Z',
      text: { en: 'x', es: 'x' },
      source: { kind: 'congress_actions', refs: ['https://www.congress.gov/bill/119th-congress/senate-joint-resolution/1'] },
      record: { action_text: 'Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.', action_code: null, action_type: 'Floor', source_system: 'Senate' },
      ai: true,
    };
    const revision = {
      id: 's_syn00001',
      as_of_day: SYN_AS_OF,
      text: {
        en: 'On September 24, 2026, the Senate rejected it by a recorded vote of 49 to 50 (Roll no. 244).',
        es: 'El 24 de septiembre de 2026, el Senado la rechazó por votación nominal de 49 a 50 (votación núm. 244).',
      },
      grounded_in: { vehicle_statuses: { [SYN_SLUG]: 'rejected' }, update_ids: [update.id], roll_calls: [] as string[], roll_calls_on_record: [] as string[] },
    };
    const entry = { updates: [update], summary_revisions: [revision] };
    const moments = { [SYN_MOMENT]: { status: 'live', vehicles: [{ slug: SYN_SLUG }] } };
    const file = { _meta: { schema: 1, generated_at: `${SYN_AS_OF}T12:00:00.000Z` }, [SYN_MOMENT]: entry };
    const check = (f: Json, at: number, byId: Map<string, Json>) => checkMomentUpdates(f, moments, billSlugs, { now: at, rollCallsById: byId });
    return { entry, revision, file, check };
  };
  const SYN_ROLL = new Map<string, Json>([['s-119-2-244', { id: 's-119-2-244', bill: SYN_SLUG, totals: { yea: 49, nay: 50 } }]]);
  const NO_ROLLS = new Map<string, Json>();
  const synRows = (res: { violations: string[]; warnings: string[] }) => ({
    violations: res.violations.filter((v) => v.includes('vote count')),
    warnings: res.warnings.filter((w) => w.includes('vote count')),
  });

  test('retention never makes the stored check stricter: a tally held only by a pruned record sentence becomes a warning, not a failure', () => {
    // The independent check's case: the night's votes sync lagged, so the
    // revision's window held no roll call, and the tally came from the
    // chamber's sentence alone ("Failed of passage in Senate by Yea-Nay
    // Vote. 49 - 50"). The vote file is taken to hold no roll call on the
    // measure either, so nothing but that sentence holds the count.
    const { entry, file, check } = synthetic();
    const early = Date.parse(`${SYN_AS_OF}T17:00:00Z`) + 86_400_000;

    // The day after it was written: the sentence is still cited, the count is held.
    const before = synRows(check(file, early, NO_ROLLS));
    expect(before.violations).toEqual([]);
    expect(before.warnings).toEqual([]);

    // 2026-12-20: retention has pruned the cited update; the revision is kept, citing nothing.
    const later = Date.parse('2026-12-20T17:00:00Z');
    const prunedEntry = pruneEntry(entry, { now: later }) as Json;
    expect(prunedEntry.updates).toEqual([]);
    expect(prunedEntry.summary_revisions[0].grounded_in.update_ids).toEqual([]);
    const prunedFile = { ...file, [SYN_MOMENT]: prunedEntry };
    const after = synRows(check(prunedFile, later, NO_ROLLS));
    expect(after.violations).toEqual([]);
    expect(after.warnings).toHaveLength(2);
    for (const w of after.warnings) expect(w).toContain('not enforced: retention may have dropped');

    // With the vote file's roll call on the measure, the same pruned revision is held outright: no warning at all.
    const held = synRows(check(prunedFile, later, SYN_ROLL));
    expect(held.violations).toEqual([]);
    expect(held.warnings).toEqual([]);
  });

  test('an invented count on a revision retention cannot have touched still fails — on a clock that is written here, not read from the data', () => {
    const { entry, revision, file, check } = synthetic();
    revision.text.en = revision.text.en.replace('49 to 50', '98 to 0');
    revision.text.es = revision.text.es.replace('49 a 50', '98 a 0');
    const at = Date.parse(`${SYN_AS_OF}T17:00:00Z`) + 86_400_000;
    expect(groundingMayBePruned(revision, entry.updates, etDay(at))).toBeNull();
    const v = synRows(check(file, at, NO_ROLLS)).violations;
    expect(v).toHaveLength(2);
    expect(v[0]).toContain('.text.en: vote count "98 to 0"');
    expect(v[1]).toContain('.text.es: vote count "98 a 0"');
    // …and on the first day retention can have pruned its sentence, the same text is only a warning.
    const lateDay = shiftDay(SYN_AS_OF, RETENTION_DAYS - STORED_SUMMARY_WINDOW_DAYS + 1);
    const late = Date.parse(`${lateDay}T17:00:00Z`);
    expect(groundingMayBePruned(revision, entry.updates, lateDay)).toContain('retention');
    const rows = synRows(check(file, late, NO_ROLLS));
    expect(rows.violations).toEqual([]);
    expect(rows.warnings).toHaveLength(2);
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

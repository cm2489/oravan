import { expect, test } from '@playwright/test';
/*
 * Two checks an AI-written "Where it stands" summary passes before it is
 * stored (lib/moment-updates-gate.mjs, called from scripts/moment-updates.mjs,
 * re-checked on what is stored by scripts/check-moment-updates.mjs):
 *
 *   1. The absence lint: no sentence saying nothing happened over a record
 *      that holds a vote or action. Its patterns come in English and Spanish
 *      pairs, one row each; the twin table below is the whole claim.
 *   2. The number lint (2026-11-11, replacing the vote-count lint of
 *      2026-10-06): every whole number from 0 to 435 a summary states must be
 *      one the record it was written from holds, and the Spanish must state
 *      exactly the English's numbers. No list of tally phrasings in either
 *      language, so the two languages cannot read a sentence differently.
 *
 * ZERO network and ZERO model calls: the Anthropic clients are stubs. No
 * committed data/ file is read: every record here is a fixture written in
 * this file (the roll calls and the stored revision are copied from
 * data/votes.json and data/moment-updates.json as they stood on 2026-11-11),
 * so no nightly data change can turn this file red. The committed files are
 * checked by scripts/check-moment-updates.mjs in CI.
 */
import {
  absenceClaims,
  checkMomentUpdates,
  etDay,
  groundingMayBePruned,
  HARD_DAY_CEILING,
  lintRevisionText,
  MAX_UPDATES_PER_MOMENT,
  numberGrounding,
  numberParity,
  numberParityFailure,
  pruneEntry,
  RECORD_ONLY_MODEL,
  RETENTION_DAYS,
  shiftDay,
  statedNumbers,
  STORED_SUMMARY_WINDOW_DAYS,
} from '../lib/moment-updates-gate.mjs';
import { generateStateSummary, RECORD_ONLY_MODEL as COLLECTOR_RECORD_ONLY_MODEL, recordOnlyText, SUMMARY_WINDOW_DAYS } from '../scripts/moment-updates.mjs';

// Fixtures are plain JSON shapes; their fields are what the gate checks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type Pair = { en: string; es: string };

/** An Anthropic-shaped stub that returns one fixed reply. */
const replying = (reply: Pair) => ({
  messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(reply) }] }) },
});

/* ------------------------------------------------------------------ *
 * Fixtures: two roll calls, copied from data/votes.json (member lists dropped).
 * ------------------------------------------------------------------ */

/** S. 4668 passed the Senate, 77-22, on 2026-09-28. */
const ROLL_250 = {
  id: 's-119-2-250', chamber: 'senate', congress: 119, session: 2, roll: 250, date: '2026-09-28',
  question: 'On Passage of the Bill S. 4668', result: 'Bill Passed', bill: 's-4668-119',
  totals: { yea: 77, nay: 22, present: 0, notVoting: 1 },
  totalsByParty: { D: { yea: 26, nay: 19, present: 0, notVoting: 0 }, I: { yea: 1, nay: 1, present: 0, notVoting: 0 }, R: { yea: 50, nay: 2, present: 0, notVoting: 1 } },
};
/** H.Con.Res. 89 failed in the Senate, 49-50, on 2026-09-24. */
const ROLL_244 = {
  id: 's-119-2-244', chamber: 'senate', congress: 119, session: 2, roll: 244, date: '2026-09-24',
  question: 'On the Concurrent Resolution H.Con.Res. 89', result: 'Concurrent Resolution Rejected', bill: 'hconres-89-119',
  totals: { yea: 49, nay: 50, present: 0, notVoting: 1 },
  totalsByParty: { D: { yea: 43, nay: 1, present: 0, notVoting: 1 }, I: { yea: 2, nay: 0, present: 0, notVoting: 0 }, R: { yea: 4, nay: 49, present: 0, notVoting: 0 } },
};
/** H.Con.Res. 93 passed the House, 220-204, on 2026-09-15. */
const ROLL_307 = {
  id: 'h-119-2-307', chamber: 'house', congress: 119, session: 2, roll: 307, date: '2026-09-15',
  question: 'On Agreeing to the Resolution', result: 'Passed', bill: 'hconres-93-119',
  totals: { yea: 220, nay: 204, present: 0, notVoting: 9 },
  totalsByParty: { D: { yea: 213, nay: 0, present: 0, notVoting: 1 }, I: { yea: 0, nay: 1, present: 0, notVoting: 0 }, R: { yea: 7, nay: 203, present: 0, notVoting: 8 } },
};

/** What the collector's prompt holds for a window with one printed roll call. */
const groundingOf = (roll: Json) => numberGrounding({ rollCalls: [roll], vehicles: [roll.bill], windowDays: SUMMARY_WINDOW_DAYS });
const G250 = groundingOf(ROLL_250);
const G244 = groundingOf(ROLL_244);

/** Part 1 for one string: the numbers it states that `numbers` does not hold. */
const numberFailures = (text: string, lang: 'en' | 'es', numbers: number[]) =>
  lintRevisionText(text, lang, { numbers }).filter((f: string) => f.startsWith('number '));
/** The verdict on one pair: refused in English, in Spanish, and for differing numbers. */
const verdict = (pair: Pair, numbers: number[]) => ({
  en: numberFailures(pair.en, 'en', numbers).length > 0,
  es: numberFailures(pair.es, 'es', numbers).length > 0,
  parity: numberParityFailure(pair.en, pair.es) !== null,
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
});

test.describe('the absence lint · the twin table: every row caught in both languages, or left alone in both', () => {
  // One row per pattern pair in ABSENCE (lib/moment-updates-gate.mjs, ROW 1
  // to ROW 10). The rows are the whole claim: a form not listed here is not
  // claimed either way.
  const CAUGHT: [row: number, en: string, es: string][] = [
    [1, 'No new votes were recorded.', 'No se registraron nuevas votaciones.'],
    [1, 'There was no floor action.', 'No hubo acción en el pleno.'],
    // 2026-11-11: "No further action was taken" was caught in English only.
    [1, 'No further action was taken.', 'No se tomó ninguna otra acción.'],
    [1, 'No further action was taken.', 'No se tomaron más medidas.'],
    [1, 'There has been no further action.', 'No ha habido más acción.'],
    [1, 'It saw no committee activity.', 'No tuvo actividad en comité.'],
    [1, 'There were no changes.', 'No hubo cambios.'],
    [1, 'There was no progress.', 'No hubo avances.'],
    [1, 'No hearings were held.', 'No se celebraron audiencias.'],
    [1, 'No amendments were offered.', 'No se presentaron enmiendas.'],
    [1, 'There is no date set for a vote.', 'No hay fecha fijada para una votación.'],
    [1, 'No vote has been scheduled.', 'No se ha programado ninguna votación.'],
    [2, 'Since then, with no changes to its status.', 'Desde entonces, sin cambios en su estado.'],
    [2, 'The week passed without any action.', 'La semana pasó sin ninguna acción.'],
    [2, 'The bill sits without activity.', 'El proyecto está sin actividad.'],
    [2, 'It remains without a vote.', 'Sigue sin votación.'],
    [3, 'No vote has been recorded.', 'No se ha registrado ninguna votación.'],
    [3, 'No action is listed.', 'No figura ninguna acción.'],
    [3, 'The record shows no votes.', 'El registro no muestra votos.'],
    [3, 'The vote does not appear in the record.', 'La votación no aparece en el registro.'],
    [3, 'No committee markups or notices appear in the record.', 'No aparecen en el registro sesiones de comité ni avisos.'],
    [4, 'Nothing has moved.', 'Nada se ha movido.'],
    [4, 'Nothing new was recorded.', 'No se registró nada nuevo.'],
    [4, 'Nothing else happened.', 'No pasó nada más.'],
    [4, 'Nothing else happened.', 'Nada más ocurrió.'],
    [4, 'Nothing happened.', 'No ocurrió nada.'],
    [4, 'Nothing changed.', 'Nada cambió.'],
    [4, 'Nothing appears in the record.', 'No aparece nada en el registro.'],
    [4, 'Nothing appears in the record.', 'Nada aparece en el registro.'],
    [5, 'Its status is unchanged.', 'Su estado sigue sin cambios.'],
    [5, 'Its status remains unchanged.', 'Su estado permanece sin cambios.'],
    // 2026-11-11: "has not changed / advanced" was caught in English only.
    [6, 'Its status has not changed.', 'Su estado no ha cambiado.'],
    [6, 'The bill has not advanced.', 'El proyecto no ha avanzado.'],
    [6, 'The bill has not moved.', 'El proyecto no se ha movido.'],
    [6, 'The bill had not moved.', 'El proyecto no se había movido.'],
    [6, "The bill hasn't moved.", 'El proyecto no se ha movido.'],
    [7, 'It stands where it stood.', 'Sigue donde estaba.'],
    [7, 'It remains where it was.', 'Permanece donde estaba.'],
    [7, 'It remains exactly where it stood.', 'Sigue exactamente donde estaba.'],
    [7, 'It is in the same status as before.', 'Está en el mismo estado que antes.'],
    [7, 'It stays the same.', 'Sigue igual.'],
    [8, 'The bill has been quiet.', 'El proyecto ha estado inactivo.'],
    [8, 'The Senate has been quiet on it.', 'El Senado ha estado en calma al respecto.'],
    [9, 'Neither had a new vote or action in this window.', 'Ninguno tuvo un voto o una acción nuevos en este período.'],
    [9, 'Neither measure has advanced.', 'Ninguna de las dos medidas ha avanzado.'],
    [9, 'Neither measure advanced.', 'Ninguna de las dos medidas avanzó.'],
    [9, 'Neither measure has moved since July.', 'Ninguna de las dos medidas se ha movido desde julio.'],
    [9, 'Neither chamber moved it.', 'Ninguna de las cámaras lo movió.'],
    [9, 'Neither chamber acted.', 'Ninguna cámara actuó.'],
    [9, 'Neither the House nor the Senate voted.', 'Ni la Cámara ni el Senado votaron.'],
    [9, 'Neither bill had a new vote.', 'Ningún proyecto tuvo una votación nueva.'],
    [9, 'Neither bill has moved.', 'Ningún proyecto se ha movido.'],
    [9, 'Neither bill advanced.', 'Ningún proyecto avanzó.'],
    [9, 'Neither chamber voted.', 'Ningún pleno votó.'],
    [9, 'Neither bill had a change.', 'Ningún proyecto tuvo un cambio.'],
    [9, 'None of them cast a vote.', 'Ninguno emitió un voto.'],
    [9, 'Neither bill had a vote in the Senate.', 'Ningún proyecto tuvo un voto en el Senado.'],
    [10, 'These were the only actions listed.', 'Estas fueron las únicas acciones registradas.'],
    [10, 'It is the only movement recorded.', 'Es el único movimiento que consta.'],
    [10, 'They are the only ones in the last 14 days.', 'Son las únicas de los últimos 14 días.'],
  ];
  const LEFT_ALONE: [en: string, es: string][] = [
    // How a measure passed, and outcomes.
    ['The Senate passed it without amendment by unanimous consent.', 'El Senado lo aprobó sin enmiendas por consentimiento unánime.'],
    ['The House passed it with no changes.', 'La Cámara lo aprobó sin cambios.'],
    ['The House passed it without changes.', 'La Cámara lo aprobó sin cambios.'],
    ['The House passed it unchanged.', 'La Cámara lo aprobó sin cambios.'],
    ['It passed by voice vote.', 'Se aprobó por votación a viva voz.'],
    ['It passed without objection.', 'Se aprobó sin objeciones.'],
    ['The motion was not agreed to.', 'La moción no fue aprobada.'],
    ['The Senate rejected it, 49 yeas to 50 nays (Roll no. 244).', 'El Senado la rechazó, 49 a favor y 50 en contra (votación núm. 244).'],
    ['The Senate took up the measure.', 'El Senado tomó la medida.'],
    ['No other measure was introduced.', 'No se presentó otra medida.'],
    // Not in any row, in either language.
    ['The bill did not advance.', 'El proyecto no avanzó.'],
    ['The bill did not move.', 'El proyecto no se movió.'],
    ['There is no quorum.', 'No hay quórum.'],
    ['The hearing was not held.', 'No se celebró la audiencia.'],
    // A party count is a statement about a roll call.
    ['Neither the House nor the Senate voted in favor.', 'Ni la Cámara ni el Senado votaron en favor.'],
    ['Neither the House nor the Senate voted in favor.', 'Ni la Cámara ni el Senado votaron en pro.'],
    ['None of the Republicans voted yes.', 'Ninguno de los republicanos votó a favor.'],
    ['No Republican voted yes.', 'Ningún republicano votó a favor.'],
    ['No Republican voted against it.', 'Ningún republicano votó en contra.'],
    ['No senator voted no.', 'Ningún senador votó no.'],
    ['No Republican cast a vote for it.', 'Ningún republicano emitió un voto a favor.'],
    ['No Republican cast a vote against it.', 'Ningún republicano emitió un voto en contra.'],
    ['None of the Republicans cast a vote for it.', 'Ninguno de los republicanos emitió un voto a favor.'],
    ['Neither Republican cast a vote against it.', 'Ninguno de los republicanos emitió un voto en contra.'],
    ['No Republicans cast votes against it.', 'Ningún republicano emitió votos en contra.'],
    ['No Republican votes were cast for it.', 'No hubo votos republicanos a favor.'],
    ['The House voted 220 to 204; no Democrat voted against it.', 'La Cámara votó 220 a 204; ningún demócrata votó en contra.'],
    // What a bill would do, and a named change.
    ['None of the funding for advanced nuclear reactors was cut.', 'Ninguno de los fondos para reactores nucleares avanzados se recortó.'],
    ['Neither bill would change the tax.', 'Ningún proyecto cambiaría el impuesto.'],
    ['None of its provisions would change current law.', 'Ninguna de sus disposiciones cambiaría la ley vigente.'],
    ['Neither bill will change.', 'Ningún proyecto cambiará.'],
    ['Neither the House nor Senate version includes the change.', 'Ni la versión de la Cámara ni la del Senado incluye el cambio.'],
    ['Neither version includes the change.', 'Ninguna versión incluye el cambio.'],
  ];

  test('every caught row is caught in English and in Spanish', () => {
    for (const [row, en, es] of CAUGHT) {
      expect(absenceClaims(en, 'en'), `row ${row}: ${en}`).not.toEqual([]);
      expect(absenceClaims(es, 'es'), `row ${row}: ${es}`).not.toEqual([]);
    }
    // Every row has at least one twin here.
    expect(new Set(CAUGHT.map(([row]) => row))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  });

  test('every left-alone pair is left alone in English and in Spanish', () => {
    for (const [en, es] of LEFT_ALONE) {
      expect(absenceClaims(en, 'en'), en).toEqual([]);
      expect(absenceClaims(es, 'es'), es).toEqual([]);
    }
  });

  test('a true roll-call absence is let through in both languages when the vote file holds none, and caught in both when it holds one', () => {
    const pairs: Pair[] = [
      { en: 'The House passed it with no recorded vote.', es: 'La Cámara lo aprobó sin votación nominal.' },
      { en: 'The House passed it without a recorded vote.', es: 'La Cámara lo aprobó sin votación nominal.' },
      { en: 'No roll call was taken on it.', es: 'No se realizó ninguna votación nominal sobre ella.' },
    ];
    for (const { en, es } of pairs) {
      expect(absenceClaims(en, 'en', { rollCallsOnRecord: 0 }), en).toEqual([]);
      expect(absenceClaims(es, 'es', { rollCallsOnRecord: 0 }), es).toEqual([]);
      expect(absenceClaims(en, 'en', { rollCallsOnRecord: 1 }), en).not.toEqual([]);
      expect(absenceClaims(es, 'es', { rollCallsOnRecord: 1 }), es).not.toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2 · the number lint
 * ------------------------------------------------------------------ */

test.describe('the number lint · what a number is', () => {
  test('one tokenizer for every language: digits, thousands separators, ordinals, decimals, times', () => {
    expect(statedNumbers('a 77-22 vote, 77–22, 77 - 22, 77-to-22')).toEqual([77, 22, 77, 22, 77, 22, 77, 22]);
    expect(statedNumbers('the 119th Congress / el 119.º Congreso')).toEqual([119, 119]);
    expect(statedNumbers('1.5 percent / 1,5 por ciento')).toEqual([1, 5, 1, 5]);
    expect(statedNumbers('1:45 p.m.')).toEqual([1, 45]);
    expect(statedNumbers('section 5(c)')).toEqual([5]);
    // A thousands separator joins: 1,500 / 1.500 / 1 500 (no-break space) are 1500, above the range.
    expect(statedNumbers('1,500 and 1.500 and 1 500 and 1 500')).toEqual([]);
    // A plain space never joins.
    expect(statedNumbers('1 500')).toEqual([1, 500].filter((n) => n <= 435));
    // Years and most bill numbers are above the range.
    expect(statedNumbers('H.R. 10167, S. 4668, September 28, 2026')).toEqual([28]);
    expect(statedNumbers('Roll no. 250, S.J.Res. 185, H. Con. Res. 89')).toEqual([250, 185, 89]);
  });

  test('the grounding is what the prompt printed from the record: the roll call, the updates, the measures, the window', () => {
    expect(G250).toEqual([0, 1, 2, 9, 14, 19, 22, 26, 28, 50, 77, 119, 250, 2026, 4668]);
    const withUpdate = numberGrounding({
      updates: [
        { day: '2026-09-24', vehicle: 'hconres-89-119', class: 'floor_action', record: { action_text: 'Senate Committee on Foreign Relations discharged, under the order of 8/8/26.' } },
        { day: '2026-09-20', vehicle: 'hconres-93-119', class: 'press_cluster', source: { outlet_names: ['The 19th'] } },
      ],
      vehicles: ['sjres-185-119'],
    });
    expect(withUpdate).toEqual([8, 9, 19, 20, 24, 26, 89, 93, 119, 185, 2026]);
    // Not the prompt's own example: a number copied from an instruction is not the record's.
    expect(G250).not.toContain(214);
    expect(G250).not.toContain(282);
  });
});

test.describe('the number lint · the parity property: English and Spanish cannot disagree', () => {
  // Templates: a tally in many phrasings and separators, with a date, a bill
  // number and a roll number around it. Each slot is filled with a number the
  // record holds or one it does not, and each pair is the same sentence in
  // both languages.
  const TALLY: [en: (a: number, b: number) => string, es: (a: number, b: number) => string][] = [
    [(a, b) => `by a vote of ${a} to ${b}`, (a, b) => `por una votación de ${a} a ${b}`],
    [(a, b) => `${a}-${b}`, (a, b) => `${a}-${b}`],
    [(a, b) => `${a}–${b}`, (a, b) => `${a}–${b}`],
    [(a, b) => `${a} - ${b}`, (a, b) => `${a} - ${b}`],
    [(a, b) => `${a}‑${b}`, (a, b) => `${a}‑${b}`],
    [(a, b) => `in a ${a}-to-${b} vote`, (a, b) => `en una votación de ${a} a ${b}`],
    [(a, b) => `by ${a} votes to ${b}`, (a, b) => `por ${a} votos a ${b}`],
    [(a, b) => `${a} yeas to ${b} nays`, (a, b) => `${a} a favor y ${b} en contra`],
    [(a, b) => `with ${a} senators voting in favor and ${b} against`, (a, b) => `con ${a} senadores a favor y ${b} en contra`],
    [(a, b) => `(Yeas ${a}, Nays ${b})`, (a, b) => `(a favor: ${a}, en contra: ${b})`],
    [(a, b) => `${a} votes for, ${b} against`, (a, b) => `${a} votos a favor, ${b} en contra`],
    [(a, b) => `${a} versus ${b}`, (a, b) => `${a} frente a ${b}`],
  ];
  const DATE: [en: (d: number) => string, es: (d: number) => string][] = [
    [(d) => `On September ${d}, 2026,`, (d) => `El ${d} de septiembre de 2026,`],
    [(d) => `On Sept. ${d},`, (d) => `El ${d} de sept.,`],
  ];
  const TALLIES = [
    { a: 77, b: 22, held: true },
    { a: 22, b: 77, held: true },
    { a: 98, b: 0, held: false },
    { a: 77, b: 23, held: false },
  ];
  const DAYS = [
    { d: 28, held: true },
    { d: 24, held: false },
  ];
  const ROLLS = [
    { r: 250, held: true },
    { r: 251, held: false },
  ];
  const pairs: { pair: Pair; held: boolean }[] = [];
  for (const [tEn, tEs] of TALLY) {
    for (const [dEn, dEs] of DATE) {
      for (const { a, b, held: tHeld } of TALLIES) {
        for (const { d, held: dHeld } of DAYS) {
          for (const { r, held: rHeld } of ROLLS) {
            pairs.push({
              pair: {
                en: `${dEn(d)} the Senate passed S. 4668 ${tEn(a, b)} (Roll no. ${r}).`,
                es: `${dEs(d)} el Senado aprobó el S. 4668 ${tEs(a, b)} (votación núm. ${r}).`,
              },
              held: tHeld && dHeld && rHeld,
            });
          }
        }
      }
    }
  }

  test(`${12 * 2 * 4 * 2 * 2} generated pairs: the verdict is the same in both languages, and right`, () => {
    expect(pairs.length).toBe(384);
    let refused = 0;
    for (const { pair, held } of pairs) {
      const v = verdict(pair, G250);
      expect(v.en, pair.en).toBe(v.es);
      expect(v.parity, `${pair.en} | ${pair.es}`).toBe(false);
      expect(v.en, pair.en).toBe(!held);
      if (v.en) refused++;
    }
    expect(refused).toBe(384 - 12 * 2 * 2);
  });

  test('every generated pair whose Spanish changes, drops or adds one number is refused as a pair', () => {
    for (const { pair } of pairs) {
      const nums = statedNumbers(pair.es);
      const last = nums.at(-1)!;
      const changed = { en: pair.en, es: pair.es.replace(new RegExp(`${last}(?!.*${last})`), String(last + 1)) };
      const dropped = { en: pair.en, es: pair.es.replace(/ \(votación núm\. \d+\)/, '') };
      const added = { en: pair.en, es: pair.es.replace('el Senado', 'el Senado, con 3 votos ausentes,') };
      for (const p of [changed, dropped, added]) expect(verdict(p, G250).parity, p.es).toBe(true);
    }
  });

  test('an invented number in English alone, in Spanish alone, or in both is refused; the true pair passes', () => {
    const truth: Pair = {
      en: 'On September 28, 2026, the Senate passed S. 4668 by a recorded vote of 77 to 22 (Roll no. 250).',
      es: 'El 28 de septiembre de 2026, el Senado aprobó el S. 4668 por votación nominal de 77 a 22 (votación núm. 250).',
    };
    expect(verdict(truth, G250)).toEqual({ en: false, es: false, parity: false });
    const enOnly = { ...truth, en: truth.en.replace('77 to 22', '98 to 0') };
    const esOnly = { ...truth, es: truth.es.replace('77 a 22', '98 a 0') };
    const both = { en: enOnly.en, es: esOnly.es };
    expect(verdict(enOnly, G250)).toEqual({ en: true, es: false, parity: true });
    expect(verdict(esOnly, G250)).toEqual({ en: false, es: true, parity: true });
    expect(verdict(both, G250)).toEqual({ en: true, es: true, parity: false });
    expect(numberParity(enOnly.en, enOnly.es)).toEqual({ onlyEn: [0, 98], onlyEs: [22, 77] });
  });
});

test.describe('the number lint · the strings the 2026-11-11 reviews named, each with the same verdict in both languages', () => {
  // [English, Spanish, the grounding, refused?]
  const NAMED: [string, string, number[], boolean][] = [
    // A pair followed by a month was skipped in English only.
    ['The Senate voted 77-22 Sept. 24.', 'El Senado votó 77-22 el 24 de sept.', G244, true],
    ['The Senate voted 49-50 Sept. 24.', 'El Senado votó 49-50 el 24 de sept.', G244, false],
    // A count with its subject between the number and the side passed in both.
    ['77 senators voted in favor and 22 against.', '77 senadores votaron a favor y 22 en contra.', G244, true],
    ['77 senators voted in favor and 22 against.', '77 senadores votaron a favor y 22 en contra.', G250, false],
    // A party's split, read differently in each language.
    ['Republicans split 4-49.', 'Los republicanos se dividieron 4-49.', G244, false],
    ['Republicans split 4-49.', 'Los republicanos se dividieron 4-49.', G250, true],
    // Ranges refused in one language only. Now: refused in both unless the record holds the numbers.
    ['It covers ages 18 to 24.', 'Abarca edades de 18 a 24.', G250, true],
    ['It amends Sec. 101-105.', 'Modifica las Secc. 101-105.', G250, true],
    ['It covers people from 18 to 24.', 'Abarca a personas de 18 a 24.', G250, true],
    ['It covers children 5 to 17.', 'Abarca a niños de 5 a 17.', G250, true],
    ['The Senate is split 53-47.', 'El Senado está dividido 53-47.', G250, true],
    ['The court ruled 6-3.', 'La corte falló 6-3.', G250, true],
    ['A panel of 9 to 11 members.', 'Un panel de 9 a 11 miembros.', G250, true],
    ['It needs 60 to 67 votes.', 'Necesita de 60 a 67 votos.', G250, true],
  ];

  test('each is read the same way in both languages: refused when the record does not hold its numbers, passed when it does', () => {
    for (const [en, es, numbers, refused] of NAMED) {
      expect(verdict({ en, es }, numbers), en).toEqual({ en: refused, es: refused, parity: false });
    }
  });

  test('each range passes in both languages once the record holds its numbers (the check reads numbers, never phrasings)', () => {
    for (const [en, es] of NAMED.slice(6)) {
      const all = [...new Set([...statedNumbers(en), ...G250])];
      expect(verdict({ en, es }, all), en).toEqual({ en: false, es: false, parity: false });
    }
  });

  test('a number written in words is not read, in either language (out of scope, stated in the code note)', () => {
    expect(verdict({ en: 'It passed ninety-eight to zero, two-thirds of the chamber.', es: 'Se aprobó noventa y ocho a cero, dos tercios de la cámara.' }, G250)).toEqual({ en: false, es: false, parity: false });
    // …but a number in digits on one side and in words on the other is a difference.
    expect(verdict({ en: 'Three measures moved.', es: '3 medidas avanzaron.' }, [3]).parity).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 3 · the collector refuses, nothing is stored
 * ------------------------------------------------------------------ */

test.describe('the collector refuses an unheld or mismatched number; nothing is stored', () => {
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
  const write = (reply: Pair, entry: Json = { updates: [PENNY_UPDATE], summary_revisions: [] }) =>
    generateStateSummary(replying(reply), 'penny-production-and-cash-rounding', entry, STATUSES, [], {}, [], []);

  test('case D: an invented "by a vote of 98 to 0" over a unanimous-consent window → null, the previous revision stands', async () => {
    const previous = { id: 's_00000001', text: { en: 'Prior.', es: 'Previo.' } };
    const entry = { updates: [PENNY_UPDATE], summary_revisions: [previous] };
    expect(
      await write({ en: 'The Senate passed H.R. 10167 without amendment by a vote of 98 to 0.', es: 'El Senado aprobó el H.R. 10167 sin enmiendas por una votación de 98 a 0.' }, entry),
    ).toBeNull();
    expect(entry.summary_revisions).toEqual([previous]);
  });

  test('the same window, written the way the record says it: stored', async () => {
    expect(
      await write({ en: 'The Senate passed H.R. 10167 without amendment by unanimous consent.', es: 'El Senado aprobó el H.R. 10167 sin enmiendas por consentimiento unánime.' }),
    ).not.toBeNull();
  });

  test('the prompt\'s own example tally, copied into a summary, is refused', async () => {
    expect(
      await write({ en: 'The Senate passed H.R. 10167 by a recorded vote of 214 to 208 (Roll no. 282).', es: 'El Senado aprobó el H.R. 10167 por votación nominal de 214 a 208 (votación núm. 282).' }),
    ).toBeNull();
  });

  test('a printed roll call: its numbers pass; a changed tally, in either language or both, does not; nor a Spanish that drops one', async () => {
    const run = (reply: Pair) =>
      generateStateSummary(replying(reply), 'paying-college-athletes', { updates: [], summary_revisions: [] }, { 's-4668-119': 'passed_chamber' }, [], {}, [ROLL_250], [ROLL_250.id]);
    const truth: Pair = {
      en: 'On September 28, 2026, the Senate passed S. 4668 by a recorded vote of 77 to 22 (Roll no. 250). On that vote, 50 Republicans and 26 Democrats voted yes.',
      es: 'El 28 de septiembre de 2026, el Senado aprobó el S. 4668 por votación nominal de 77 a 22 (votación núm. 250). En esa votación, 50 republicanos y 26 demócratas votaron a favor.',
    };
    expect(await run(truth)).not.toBeNull();
    expect(await run({ ...truth, en: truth.en.replace('77 to 22', '77 to 23') })).toBeNull();
    expect(await run({ ...truth, es: truth.es.replace('77 a 22', '77 a 23') })).toBeNull();
    expect(await run({ en: truth.en.replace('77 to 22', '77 to 23'), es: truth.es.replace('77 a 22', '77 a 23') })).toBeNull();
    expect(await run({ ...truth, es: truth.es.replace(' (votación núm. 250)', '') })).toBeNull();
    // A date the record does not hold is a number too.
    expect(await run({ en: truth.en.replace('September 28', 'September 29'), es: truth.es.replace('28 de septiembre', '29 de septiembre') })).toBeNull();
  });

  test('the record-only template passes part 2 for every day of the year (it is exempt from part 1, which the gate reads by its model)', () => {
    expect(COLLECTOR_RECORD_ONLY_MODEL).toBe(RECORD_ONLY_MODEL);
    for (let i = 0; i < 366; i++) {
      const day = shiftDay('2026-01-01', i);
      for (const count of [1, 2]) {
        const text = recordOnlyText(day, count);
        expect(numberParityFailure(text.en, text.es), day).toBeNull();
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 4 · the gate re-checks what is stored
 * ------------------------------------------------------------------ */

test.describe('the gate re-checks what is stored (checkMomentUpdates, opts.rollCallsById)', () => {
  // iran-war-powers revision s_0a74cf71 (2026-09-25) and the four updates and
  // two roll calls it was written from, copied from data/moment-updates.json
  // and data/votes.json on 2026-11-11.
  const MOMENT = 'iran-war-powers';
  const SLUGS = ['hconres-93-119', 'hconres-89-119', 'hconres-86-119', 'sjres-185-119', 'sjres-200-119', 'sjres-211-119', 'sjres-180-119', 'sjres-181-119', 'sjres-172-119', 'hconres-38-119'];
  const update = (id: string, day: string, klass: string, vehicle: string, actionText: string) => ({
    id, class: klass, vehicle, day, occurred_at: day, occurred_precision: 'day', recorded_at: '2026-09-25T13:41:33.041Z',
    text: { en: 'x', es: 'x' }, source: { kind: 'congress_actions', refs: ['https://www.congress.gov/'] },
    record: { action_text: actionText, action_code: null, action_type: 'Floor', source_system: 'Senate' }, ai: false,
  });
  const UPDATES = [
    update('u_40aa8bf1', '2026-09-24', 'vote', 'hconres-89-119', 'Failed of passage in Senate by Yea-Nay Vote. 49 - 50. Record Vote Number: 244.'),
    update('u_fe66be12', '2026-09-24', 'floor_action', 'hconres-89-119', 'Senate Committee on Foreign Relations discharged, under the order of 8/8/26.'),
    update('u_470e18ff', '2026-09-16', 'floor_action', 'hconres-93-119', 'Received in the Senate and referred to the Committee on Foreign Relations.'),
    update('u_06fa2260', '2026-09-15', 'vote', 'hconres-93-119', 'On agreeing to the resolution Agreed to by the Yeas and Nays: 220 - 204 (Roll no. 307). (text: CR H5609)'),
  ];
  const TEXT: Pair = {
    en: 'The most recent floor action is a Senate defeat: H. Con. Res. 89 failed on a Yea-Nay vote of 49 to 50 (Roll no. 244) on September 24, 2026, after the Senate Foreign Relations Committee was discharged from further consideration under the order of August 8, 2026. That measure remains listed as passed one chamber, reflecting its earlier House action. Separately, H. Con. Res. 93 passed the House by a recorded vote of 220 to 204 (Roll no. 307) on September 15, 2026, and was received in the Senate on September 16, 2026, where it was referred to the Committee on Foreign Relations. H. Con. Res. 86 also stands as passed one chamber. Several other measures, including S.J.Res. 185, S.J.Res. 180, S.J.Res. 181, S.J.Res. 172, and H. Con. Res. 38, show floor activity, while S.J.Res. 200 and S.J.Res. 211 remain in committee.',
    es: 'La acción más reciente en el pleno es una derrota en el Senado: la H. Con. Res. 89 no fue aprobada por votación nominal de 49 a 50 (votación núm. 244) el 24 de septiembre de 2026, después de que el Comité de Relaciones Exteriores del Senado fuera relevado de su consideración bajo la orden del 8 de agosto de 2026. Esa medida sigue figurando como aprobada por una cámara, en referencia a su acción previa en la Cámara. Por separado, la H. Con. Res. 93 fue aprobada en la Cámara por votación nominal de 220 a 204 (votación núm. 307) el 15 de septiembre de 2026, y fue recibida en el Senado el 16 de septiembre de 2026, donde se remitió al Comité de Relaciones Exteriores. La H. Con. Res. 86 también figura como aprobada por una cámara. Otras medidas, como la S.J.Res. 185, la S.J.Res. 180, la S.J.Res. 181, la S.J.Res. 172 y la H. Con. Res. 38, muestran actividad en el pleno, mientras que la S.J.Res. 200 y la S.J.Res. 211 permanecen en comité.',
  };
  const AS_OF = '2026-09-25';
  const fixture = (text: Pair = TEXT, extra: Json = {}) => {
    const revision = {
      id: 's_0a74cf71', generated_at: '2026-09-25T13:41:54.769Z', as_of_day: AS_OF, text: { ...text },
      grounded_in: {
        vehicle_statuses: Object.fromEntries(SLUGS.map((s) => [s, 'floor_vote'])),
        update_ids: UPDATES.map((u) => u.id),
        roll_calls: ['s-119-2-244', 'h-119-2-307'],
        refs: [],
      },
      changed_because: ['updates:+5'], model: 'claude-sonnet-5', ...extra,
    };
    const entry = { updates: structuredClone(UPDATES), summary_revisions: [revision] };
    return { revision, entry, file: { _meta: { schema: 1, generated_at: `${AS_OF}T14:00:00.000Z` }, [MOMENT]: entry } as Json };
  };
  const MOMENTS = { [MOMENT]: { status: 'live', vehicles: SLUGS.map((slug) => ({ slug })) } };
  const BILL_SLUGS = new Set(SLUGS);
  const ROLLS = new Map<string, Json>([[ROLL_244.id, ROLL_244], [ROLL_307.id, ROLL_307]]);
  const DAY_AFTER = Date.parse(`${AS_OF}T17:00:00Z`) + 86_400_000;
  /** `rolls: null` checks with no vote file at all. */
  const check = (file: Json, at: number = DAY_AFTER, rolls: Map<string, Json> | null = ROLLS) =>
    checkMomentUpdates(file, MOMENTS, BILL_SLUGS, { now: at, ...(rolls ? { rollCallsById: rolls } : {}) });
  const rows = (res: { violations: string[]; warnings: string[] }) => ({
    violations: res.violations.filter((v) => v.includes('number') || v.includes('state different numbers')),
    warnings: res.warnings.filter((w) => w.includes('number')),
  });

  test('the stored revision passes on its own grounding, through the gate\'s entry point', () => {
    expect(rows(check(fixture().file))).toEqual({ violations: [], warnings: [] });
  });

  test('an invented number fails in the language that states it, and the pair fails when the two differ', () => {
    const enOnly = fixture({ ...TEXT, en: TEXT.en.replace('49 to 50', '98 to 0') });
    expect(rows(check(enOnly.file)).violations).toEqual([
      expect.stringContaining('.text.es: the English and the Spanish state different numbers — only in the English: 0, 98; only in the Spanish: 49, 50'),
      expect.stringContaining('.text.en: number "98" that its grounding does not hold'),
    ]);
    const both = fixture({ en: TEXT.en.replace('49 to 50', '98 to 0'), es: TEXT.es.replace('49 a 50', '98 a 0') });
    const v = rows(check(both.file)).violations;
    expect(v.filter((x) => x.includes('number "98"'))).toHaveLength(2);
    expect(v.filter((x) => x.includes('state different numbers'))).toEqual([]);
    const esOnly = fixture({ ...TEXT, es: TEXT.es.replace('49 a 50', '98 a 0') });
    const w = rows(check(esOnly.file)).violations;
    expect(w.some((x) => x.includes('.text.es: number "98"'))).toBe(true);
    expect(w.some((x) => x.includes('state different numbers'))).toBe(true);
    expect(w.some((x) => x.includes('.text.en: number'))).toBe(false);
  });

  test('a Spanish that drops a number fails part 2, with or without the vote file', () => {
    const dropped = fixture({ ...TEXT, es: TEXT.es.replace(' (votación núm. 244)', '') });
    for (const rolls of [ROLLS, null]) {
      expect(rows(check(dropped.file, DAY_AFTER, rolls)).violations).toEqual([
        expect.stringContaining('only in the English: 244; only in the Spanish: none'),
      ]);
    }
  });

  test('without the vote file, part 1 does not run (fixture suites keep their call shape)', () => {
    const both = fixture({ en: TEXT.en.replace('49 to 50', '98 to 0'), es: TEXT.es.replace('49 a 50', '98 a 0') });
    expect(rows(check(both.file, DAY_AFTER, null)).violations).toEqual([]);
  });

  test('a roll call the vote file no longer holds leaves the record unknown: a warning, never a guess', () => {
    const both = fixture({ en: TEXT.en.replace('49 to 50', '98 to 0'), es: TEXT.es.replace('49 a 50', '98 a 0') });
    const res = rows(check(both.file, DAY_AFTER, new Map([[ROLL_307.id, ROLL_307]])));
    expect(res.violations).toEqual([]);
    expect(res.warnings).toEqual([expect.stringContaining('numbers not checked — data/votes.json no longer holds s-119-2-244')]);
  });

  test('a number the window did not print but a roll call on the measures holds passes on what is stored (the collector stays strict)', () => {
    // 214 to 208 is House roll 282 on H.Con.Res. 89 (2026-07-23), outside this revision's window.
    const ROLL_282 = { id: 'h-119-2-282', chamber: 'house', roll: 282, date: '2026-07-23', question: 'On Agreeing to the Resolution', result: 'Passed', bill: 'hconres-89-119', totals: { yea: 214, nay: 208, present: 0, notVoting: 11 } };
    const text = { en: `${TEXT.en} In July, the House agreed to it 214 to 208.`, es: `${TEXT.es} En julio, la Cámara la aprobó 214 a 208.` };
    expect(rows(check(fixture(text).file, DAY_AFTER, new Map([...ROLLS, [ROLL_282.id, ROLL_282]]))).violations).toEqual([]);
    // Its `bill` taken not to map to a vehicle: only roll_calls_on_record can hold it.
    const unmapped = new Map([...ROLLS, [ROLL_282.id, { ...ROLL_282, bill: 'hr-0-119' }]]);
    expect(rows(check(fixture(text).file, DAY_AFTER, unmapped)).violations).toHaveLength(4);
    const onRecord = fixture(text);
    (onRecord.revision.grounded_in as Json).roll_calls_on_record = ['s-119-2-244', 'h-119-2-307', 'h-119-2-282'];
    expect(rows(check(onRecord.file, DAY_AFTER, unmapped)).violations).toEqual([]);
  });

  test('retention never makes the stored check stricter: a number held only by a pruned update becomes a warning, not a failure', () => {
    // September 16 is held only by the referral's day.
    const { entry, file } = fixture();
    const later = Date.parse('2026-12-20T17:00:00Z');
    const prunedEntry = pruneEntry(entry, { now: later }) as Json;
    expect(prunedEntry.updates).toEqual([]);
    expect(prunedEntry.summary_revisions[0].grounded_in.update_ids).toEqual([]);
    const res = rows(check({ ...file, [MOMENT]: prunedEntry }, later));
    expect(res.violations).toEqual([]);
    // 16 was held by an update alone; every other number is still held by the
    // two roll calls, which are never pruned. ("August 8" was held by the
    // discharge sentence, and still is by roll 307: eight Republicans did not
    // vote. A small number held by accident, as the code note says.)
    expect(res.warnings.map((w) => /text\.(en|es): number "(\d+)"/.exec(w)?.slice(1).join(' '))).toEqual(['en 16', 'es 16']);
    for (const w of res.warnings) expect(w).toContain('not enforced: retention may have dropped');
  });

  test('an invented number on a revision retention cannot have touched still fails — on a clock written here, never read from data', () => {
    const { revision, entry, file } = fixture({ en: TEXT.en.replace('49 to 50', '98 to 0'), es: TEXT.es.replace('49 a 50', '98 a 0') });
    expect(groundingMayBePruned(revision, entry.updates, etDay(DAY_AFTER))).toBeNull();
    expect(rows(check(file)).violations).toHaveLength(2);
    // …and from the first day retention can have pruned an update it cites, the same text is only a warning.
    const lateDay = shiftDay(AS_OF, RETENTION_DAYS - STORED_SUMMARY_WINDOW_DAYS + 1);
    expect(groundingMayBePruned(revision, entry.updates, lateDay)).toContain('retention');
    const late = rows(check(file, Date.parse(`${lateDay}T17:00:00Z`)));
    expect(late.violations).toEqual([]);
    expect(late.warnings).toHaveLength(2);
  });

  test('a record-only revision is exempt from part 1 (a template, not AI text) and held to part 2', () => {
    const text = recordOnlyText('2026-09-27', 2);
    const ro = fixture(text, { model: RECORD_ONLY_MODEL });
    expect(rows(check(ro.file))).toEqual({ violations: [], warnings: [] });
    // The same sentence under a model's name is AI text, and September 27 is in no update or roll call here.
    expect(rows(check(fixture(text).file)).violations).toHaveLength(2);
    const broken = fixture({ en: text.en, es: text.es.replace('27 de septiembre', '28 de septiembre') }, { model: RECORD_ONLY_MODEL });
    expect(rows(check(broken.file)).violations).toEqual([expect.stringContaining('state different numbers')]);
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

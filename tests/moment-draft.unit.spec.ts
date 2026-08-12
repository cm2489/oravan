import { expect, test } from '@playwright/test';
// The DEGRADATION PATHS of the Big Question draft layer (scripts/moment-draft.mjs).
//
// The watcher's whole value is that silence means "nothing crossed the floor".
// That only holds if noise is never silence — so every way drafting can fail
// has to end with the blank scaffold that shipped before drafting existed, and
// with the issue still opening. This file pins each of those exits: no key, an
// API outage, an unparseable reply, a reply that is JSON but not an object, a
// field that fails the lint, a field whose Spanish is missing, and the per-run
// cap. Each one asserts BOTH halves — the fallback value AND that the rendered
// issue body is still a complete issue.
//
// ZERO network and ZERO filesystem: the Anthropic client is injected as a
// stub, and every candidate is a literal in buildReport()'s output shape.
// Same discipline as tests/moment-updates-runner.unit.spec.ts, and the same
// reason: these branches are the ones a silent regression would turn into
// invented prose or a missing notification, and neither is visible in a diff.
import {
  DRAFT_FIELDS,
  DRAFT_LABEL,
  INTERNAL_ENUM_TOKENS,
  blankDraft,
  draftAll,
  draftFor,
  draftPrompt,
  enumLeaks,
  groundFor,
  lintField,
  recordLines,
  validateDraft,
} from '../scripts/moment-draft.mjs';
import { DRAFT_STANDING_LINE, renderPush, scaffoldFor } from '../scripts/moment-watch.mjs';
import { STANDING_LINE, statusKeyFor } from '../scripts/moment-candidates.mjs';

/* ------------------------------------------------------------------ *
 * Fixtures — one candidate in buildReport()'s exact output shape, and
 * the bill row scripts/moment-watch.mjs looks up beside it.
 * ------------------------------------------------------------------ */

const CANDIDATE = {
  slug: 's-3172-119',
  citation: 'S. 3172',
  headline: 'Bill would repeal two long-standing US sanctions laws on Syria',
  status: 'floor_vote',
  /* RELATIVE, not a literal (N3, 2026-08-11). statusKeyFor reads this date
     now, and a hardcoded '2026-07-27' would have silently flipped every
     assertion in this file from `floor_vote` to `floor_vote_stale` fifteen
     days after it was written — the fixture would have started testing the
     clock instead of the record block, on a day nobody touched this file.
     These fixtures ask "what does the record block say about a MOVING bill",
     so the date says moving. The aged case is pinned deliberately, in
     tests/journey.unit.spec.ts, where the clock is the subject. */
  lastActionDate: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
  floorCalendar: true,
  floorChamber: 'senate',
  urgency: 0.9,
  tier: 'neutral',
  outlets: 5,
  leans: ['unrated'],
  partisanLeans: 0,
  articles: 5,
  url: 'https://www.congress.gov/bill/119th-congress/senate-bill/3172',
};

const BILL = {
  full_identifier: 's-3172-119',
  title: 'A bill to repeal certain Acts that impose sanctions upon Syria.',
  last_action_text: 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 501.',
};

/* The real messages/*.json vocabulary, verbatim — `floor_vote_stale` included
   since N3 (2026-08-11). A missing phrase here would not fail loudly: groundFor
   falls back to the underscored key with spaces ("floor vote stale"), which is
   an internal token wearing a disguise, and it would reach the prompt. */
const STATUS_PHRASES = {
  en: {
    floor_vote: 'On the floor calendar',
    floor_vote_stale: 'Placed on the calendar',
    floor_activity: 'Floor activity',
  },
  es: {
    floor_vote: 'En el calendario del pleno',
    floor_vote_stale: 'Incluido en el calendario',
    floor_activity: 'Actividad en el pleno',
  },
};

/* s-4668-119's real shape at the time it shipped a false sentence: status
 * `floor_vote`, last action a CLOTURE MOTION — an activity, not a placement.
 * The candidate report already knows the difference (`floorCalendar: false`);
 * the record block did not. */
const CLOTURE_CANDIDATE = {
  ...CANDIDATE,
  slug: 's-4668-119',
  citation: 'S. 4668',
  floorCalendar: false,
  floorChamber: null,
};
const CLOTURE_BILL = {
  full_identifier: 's-4668-119',
  title: 'A bill to do a thing.',
  last_action_text: 'Cloture motion on the motion to proceed to the measure presented in Senate.',
};

const REPORT = { moments: { live: 2, cap: 6, openSlots: 4 }, candidates: [CANDIDATE] };

const GROUND = groundFor(CANDIDATE, BILL, STATUS_PHRASES);

/** A clean, lint-passing draft in the reply shape the prompt asks for. */
const GOOD = {
  name: { en: 'The Syria sanctions question', es: 'La cuestión de las sanciones a Siria' },
  summary: {
    en: 'A bill before the Senate would repeal two laws that impose US sanctions on Syria. A yes vote repeals them; a no vote leaves both in force.',
    es: 'Un proyecto de ley ante el Senado derogaría dos leyes que imponen sanciones de Estados Unidos a Siria. Un voto a favor las deroga; un voto en contra las deja en vigor.',
  },
  role: {
    en: 'A yes vote repeals the two sanctions Acts this bill names. A no vote leaves both in force.',
    es: 'Un voto a favor deroga las dos leyes de sanciones que nombra este proyecto. Un voto en contra las deja en vigor.',
  },
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** An Anthropic-shaped stub. `replies` are returned in order; the last one
 *  repeats, so a one-element list answers every attempt identically. */
function clientReturning(...replies: string[]) {
  let i = 0;
  const calls: unknown[] = [];
  return {
    calls,
    messages: {
      create: async (params: unknown) => {
        calls.push(params);
        const reply = replies[Math.min(i, replies.length - 1)];
        i++;
        return { content: [{ type: 'text', text: reply }] };
      },
    },
  };
}

const throwingClient = {
  messages: {
    create: async () => {
      throw new Error('boom');
    },
  },
};

const json = (v: unknown) => JSON.stringify(v);

/** The two things every degrade path must be able to say at once: the scaffold
 *  is the blank form, and the issue body is still a complete issue. */
function expectBlankButDelivered(draft: ReturnType<typeof blankDraft>) {
  expect(draft.drafted).toBe(false);
  for (const field of DRAFT_FIELDS) {
    expect(draft[field as 'name']).toEqual({ en: '', es: '' });
  }
  // Byte-identical to the scaffold that shipped before drafting existed.
  expect(scaffoldFor(CANDIDATE, draft)).toEqual(scaffoldFor(CANDIDATE));

  const body = renderPush([CANDIDATE], REPORT, {
    grounds: new Map([[CANDIDATE.slug, GROUND]]),
    drafts: new Map([[CANDIDATE.slug, draft]]),
  });
  expect(body).toContain('1 new Big Question candidate');
  expect(body).toContain('s-3172-119');
  // The old, still-true standing line, and the old <details> label.
  expect(body).toContain(STANDING_LINE);
  expect(body).toContain('facts only — you write every sentence');
  expect(body).not.toContain(DRAFT_LABEL);
}

/* ------------------------------------------------------------------ *
 * 1 · DEGRADE, NEVER BLOCK — the four ways the model can fail us.
 * ------------------------------------------------------------------ */

test.describe('degradation: the issue opens no matter what', () => {
  test('no ANTHROPIC_API_KEY: blank scaffold, no call, the issue still opens', async () => {
    const draft = await draftFor(null, GROUND);
    expectBlankButDelivered(draft);
    expect(draft.notes.join(' ')).toContain('ANTHROPIC_API_KEY');
  });

  test('the API throws: blank scaffold, and the failure is named in the issue', async () => {
    const draft = await draftFor(throwingClient, GROUND);
    expectBlankButDelivered(draft);
    expect(draft.notes.join(' ')).toContain('boom');
  });

  test('an unparseable reply: blank scaffold, never a half-parsed one', async () => {
    const client = clientReturning('Sure! Here is the draft you asked for.');
    const draft = await draftFor(client, GROUND);
    expectBlankButDelivered(draft);
    // Retried once before giving up — the retry is real, not decoration.
    expect(client.calls.length).toBe(2);
  });

  test('valid JSON that is not an object (a bare array) is refused, and named as such', async () => {
    const draft = await draftFor(clientReturning('[1, 2, 3]'), GROUND);
    expectBlankButDelivered(draft);
    // Not merely blank: the note has to say the shape was wrong, or a future
    // reader debugging an empty scaffold cannot tell a refusal from an outage.
    expect(draft.notes.join(' ')).toContain('not a JSON object');
  });

  test('a fenced reply is still parsed — models add fences despite instructions', async () => {
    const draft = await draftFor(clientReturning('```json\n' + json(GOOD) + '\n```'), GROUND);
    expect(draft.drafted).toBe(true);
    expect(draft.name.en).toBe(GOOD.name.en);
  });
});

/* ------------------------------------------------------------------ *
 * 2 · LINTED BEFORE IT IS OFFERED. Handing the owner copy that cannot
 * merge is worse than handing him blanks: he would edit it, open the PR,
 * and find out from CI.
 * ------------------------------------------------------------------ */

test.describe('lint rejection falls back to blank, per field', () => {
  test('forbidden vocabulary blanks that field in BOTH languages, keeps the rest, and says so', async () => {
    const dirty = clone(GOOD);
    dirty.summary.en = 'The measure would block the two sanctions laws from being enforced.';
    const client = clientReturning(json(dirty));

    const draft = await draftFor(client, GROUND);

    expect(draft.summary).toEqual({ en: '', es: '' }); // ES was clean; parity wins
    expect(draft.name.en).toBe(GOOD.name.en);
    expect(draft.role.en).toBe(GOOD.role.en);
    expect(draft.drafted).toBe(true);
    expect(client.calls.length).toBe(2); // retried once before blanking
    const notes = draft.notes.join(' ');
    expect(notes).toContain('summary');
    expect(notes).toContain('block');

    // And the issue says it, rather than shipping a quietly-thinner scaffold.
    const body = renderPush([CANDIDATE], REPORT, {
      grounds: new Map([[CANDIDATE.slug, GROUND]]),
      drafts: new Map([[CANDIDATE.slug, draft]]),
    });
    expect(body).toContain('Drafting notes:');
    expect(body).toContain('summary left blank');
  });

  test('the retry rescues a dirty field, and clean fields from attempt 1 are kept', async () => {
    const dirty = clone(GOOD);
    dirty.summary.en = 'A yes vote would stop the sanctions.';
    const client = clientReturning(json(dirty), json(GOOD));

    const draft = await draftFor(client, GROUND);

    expect(draft.summary.en).toBe(GOOD.summary.en);
    expect(draft.name.en).toBe(GOOD.name.en);
    expect(client.calls.length).toBe(2);
    expect(draft.notes.join(' ')).toContain('retrying once');
  });

  test('an asserted vote date is refused — the corpus has none to derive it from', () => {
    expect(
      lintField('summary', {
        en: 'The Senate will vote on the measure next week.',
        es: 'El Senado votará la medida la próxima semana.',
      }).length,
    ).toBeGreaterThan(1);
    expect(lintField('summary', { en: 'A vote is scheduled.', es: 'Está programada.' }).length).toBeGreaterThan(0);
  });

  test('forecasting is refused by the inherited speculation lint', () => {
    const failures = lintField('summary', {
      en: 'The bill is expected to pass.',
      es: 'Se espera que el proyecto avance.',
    });
    expect(failures.join(' ')).toContain('speculation');
  });

  test('EN and ES are one unit: a missing Spanish half blanks the field entirely', async () => {
    const half = clone(GOOD);
    half.name.es = '';
    const draft = await draftFor(clientReturning(json(half)), GROUND);
    expect(draft.name).toEqual({ en: '', es: '' });
    expect(draft.summary.en).toBe(GOOD.summary.en);
  });

  test('a runaway field is dropped, never truncated — a truncated summary is a wrong summary', () => {
    const long = 'palabra '.repeat(400);
    expect(lintField('summary', { en: long, es: long }).join(' ')).toContain('ceiling');
  });

  test('validateDraft reports every field independently', () => {
    const { clean, problems } = validateDraft({ ...GOOD, role: { en: 'A yes vote saves the program.', es: GOOD.role.es } });
    expect(Object.keys(clean).sort()).toEqual(['name', 'summary']);
    expect(problems.role.join(' ')).toContain('save');
  });
});

/* ------------------------------------------------------------------ *
 * 3 · VISIBLY A DRAFT, and bounded.
 * ------------------------------------------------------------------ */

test.describe('the issue tells the truth about what it carries', () => {
  test('a drafted issue is labelled AI-drafted and swaps the standing line', async () => {
    const draft = await draftFor(clientReturning(json(GOOD)), GROUND);
    const body = renderPush([CANDIDATE], REPORT, {
      grounds: new Map([[CANDIDATE.slug, GROUND]]),
      drafts: new Map([[CANDIDATE.slug, draft]]),
    });
    expect(body).toContain(DRAFT_LABEL);
    expect(body).toContain(DRAFT_STANDING_LINE);
    expect(body).not.toContain(STANDING_LINE);
    expect(body).toContain('AI first draft — edit every sentence before merging');
    // The record the draft was grounded in is printed with it, so every claim
    // in the prose is checkable against the same issue.
    expect(body).toContain(BILL.title);
    expect(body).toContain(BILL.last_action_text);
  });

  test('the cap bounds one run, and the capped candidates say why they are blank', async () => {
    const second = { ...GROUND, slug: 's-4784-119' };
    const client = clientReturning(json(GOOD));
    const drafts = await draftAll(client, [GROUND, second], { cap: 1 });
    expect(client.calls.length).toBe(1);
    expect(drafts.get(GROUND.slug)?.drafted).toBe(true);
    expect(drafts.get(second.slug)?.drafted).toBe(false);
    expect(drafts.get(second.slug)?.notes.join(' ')).toContain('MOMENT_DRAFT_CAP');
  });

  test('the prompt carries the closed record and the no-vote-date rule verbatim', () => {
    const prompt = draftPrompt(GROUND);
    expect(prompt).toContain('THERE IS NO SCHEDULED VOTE DATE IN THIS RECORD');
    expect(prompt).toContain('this is the ENTIRE record you may use');
    expect(prompt).toContain(BILL.title);
    expect(prompt).toContain(BILL.last_action_text);
    // The raw enum must never reach the model as a FACT (scripts/
    // moment-updates.mjs leaked "floor_vote" into published prose in both
    // languages once); the prompt names it only as a negative example.
    expect(prompt).toContain('On the floor calendar');
    expect(prompt).toContain('En el calendario del pleno');
    expect(recordLines(GROUND).join('\n')).not.toContain('floor_vote');
  });
});

/* ------------------------------------------------------------------ *
 * 4 · THE RECORD BLOCK IS THE WHOLE GROUND, so it may not contain a
 * contradiction and it may not contain one of our own classifications.
 * Both of these shipped as published sentences.
 * ------------------------------------------------------------------ */

test.describe('the record block cannot contradict itself about the floor', () => {
  test('a cloture motion is NOT "On the floor calendar" — the status label goes through the gate', () => {
    const g = groundFor(CLOTURE_CANDIDATE, CLOTURE_BILL, STATUS_PHRASES);
    // The gate's own answer, and the record block's, are the same answer.
    // Three args since N3 (2026-08-11): the gate reads the date as well as the
    // sentence. `floor_activity` is the ONE key the clock cannot touch — there
    // is no placement here to age — so this assertion holds at any date, and
    // passing the candidate's own is what proves that rather than assumes it.
    expect(
      statusKeyFor(
        CLOTURE_CANDIDATE.status,
        CLOTURE_BILL.last_action_text,
        CLOTURE_CANDIDATE.lastActionDate
      )
    ).toBe('floor_activity');
    expect(g.statusKey).toBe('floor_activity');
    expect(g.statusEn).toBe('Floor activity');
    expect(g.statusEs).toBe('Actividad en el pleno');

    const block = recordLines(g).join('\n');
    // THE BUG, verbatim: the block used to say both of these at once, and the
    // draft resolved toward the label — "sitting on the Senate floor calendar"
    // reached data/moments.json.
    expect(block).not.toContain('On the floor calendar');
    expect(block).toContain('floor calendar: not on a floor calendar');
  });

  test('a real placement still reads as a placement', () => {
    const block = recordLines(GROUND).join('\n');
    expect(GROUND.statusKey).toBe('floor_vote');
    expect(block).toContain('where it stands: EN "On the floor calendar"');
    expect(block).toContain('on the senate floor calendar');
  });

  test('the label and the calendar line are two renderings of ONE decision', () => {
    for (const [c, bill] of [
      [CANDIDATE, BILL],
      [CLOTURE_CANDIDATE, CLOTURE_BILL],
      // No bill row at all: thin, but still not self-contradictory.
      [CLOTURE_CANDIDATE, undefined],
      [{ ...CANDIDATE, status: 'passed_chamber', floorCalendar: false }, BILL],
    ] as [Record<string, unknown>, Record<string, unknown> | undefined][]) {
      const g = groundFor(c, bill, STATUS_PHRASES);
      expect(g.floorCalendar, String(c.slug)).toBe(g.statusKey === 'floor_vote');
    }
  });
});

test.describe('no internal enum reaches the model as a fact', () => {
  test('the coverage TIER is gone from the record block', () => {
    // "press: neutral coverage across 3 outlet(s)" handed the model a verdict
    // of OUR AllSides lookup — `neutral` means "no outlet here is lean-rated in
    // our table" — and it shipped as a published characterization of the press.
    const block = recordLines(GROUND).join('\n');
    expect(GROUND.tier).toBe('neutral'); // the ground still knows it…
    expect(block).not.toContain('neutral'); // …the prompt never learns it
    expect(block).toContain('5 outlet(s) in Oravan');
    expect(block).toContain('lean rating');
    expect(block).toContain('fact about that table');
  });

  test('enumLeaks is clean on the record block this file actually builds', () => {
    expect(enumLeaks(GROUND)).toEqual([]);
    expect(enumLeaks(groundFor(CLOTURE_CANDIDATE, CLOTURE_BILL, STATUS_PHRASES))).toEqual([]);
    // …including the no-bill-row path, where every value is a placeholder.
    expect(enumLeaks(groundFor(CANDIDATE, undefined, STATUS_PHRASES))).toEqual([]);
  });

  test('enumLeaks CATCHES a re-added enum, in whatever field it comes back through', () => {
    const leaky = { ...GROUND, statusEn: 'floor_vote', statusEs: 'floor_vote' };
    expect(enumLeaks(leaky)).toContain('floor_vote');
    expect(enumLeaks({ ...GROUND, floorChamber: 'one_sided' })).toContain('one_sided');
  });

  test("somebody else's words are not a leak — Congress may title a bill anything", () => {
    // The verbatim spans (title, headline, last action, citation, URL) are
    // removed before the scan: a bill genuinely called the "Cross-Border Act"
    // is not this file interpolating a coverage tier.
    const g = {
      ...GROUND,
      title: 'The Cross-Border Press Neutrality Act',
      lastActionText: 'Placed on the Union Calendar; none of the amendments were live.',
    };
    expect(enumLeaks(g)).toEqual([]);
  });

  test('a leaking block refuses to spend, and says why', async () => {
    const client = clientReturning(json(GOOD));
    const draft = await draftFor(client, { ...GROUND, statusEn: 'floor_vote' });
    expect(client.calls.length).toBe(0); // not one token
    expect(draft.drafted).toBe(false);
    expect(draft.notes.join(' ')).toContain('floor_vote');
  });

  test('the token list names the vocabularies, and only unambiguous ones', () => {
    expect(INTERNAL_ENUM_TOKENS).toContain('floor_vote');
    expect(INTERNAL_ENUM_TOKENS).toContain('one_sided');
    expect(INTERNAL_ENUM_TOKENS).toContain('neutral');
    // Deliberately absent: each of these IS its own published English label
    // ("In committee", "In markup", "Signed into law"), so scanning for them
    // would fire on the correct rendering of the fact the line exists to state.
    for (const label of ['committee', 'markup', 'signed', 'introduced', 'conference', 'vetoed']) {
      expect(INTERNAL_ENUM_TOKENS, label).not.toContain(label);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5 · The footer tells the truth PER FIELD. `drafted` is true when ANY
 * field survived, which is the wrong question for "is there prose left
 * to write".
 * ------------------------------------------------------------------ */

test.describe('a partially-drafted scaffold says which prose is still missing', () => {
  const bodyFor = (draft: unknown) =>
    renderPush([CANDIDATE], REPORT, {
      grounds: new Map([[CANDIDATE.slug, GROUND]]),
      drafts: new Map([[CANDIDATE.slug, draft]]),
    });

  test('one blanked field is named, in the footer AND on the fold', async () => {
    const dirty = clone(GOOD);
    dirty.summary.en = 'The measure would block the two sanctions laws from being enforced.';
    const draft = await draftFor(clientReturning(json(dirty)), GROUND);
    expect(draft.drafted).toBe(true);
    expect(draft.summary).toEqual({ en: '', es: '' });

    const body = bodyFor(draft);
    // Before the fix this read as finished: `drafted` was true, so the footer
    // dropped the empty-prose clause entirely and two blank bilingual fields
    // sat inside the fold with only the drafting notes to say so.
    expect(body).toContain('still-empty **summary** (both languages)');
    expect(body).toContain('PARTIAL AI first draft');
    expect(body).toContain('summary came back blank');
  });

  test('a fully drafted scaffold claims nothing is left, and a blank one claims everything is', async () => {
    const full = await draftFor(clientReturning(json(GOOD)), GROUND);
    const fullBody = bodyFor(full);
    expect(fullBody).not.toContain('still-empty');
    expect(fullBody).not.toContain('the empty prose');
    expect(fullBody).toContain('AI first draft — edit every sentence before merging');

    const blankBody = bodyFor(blankDraft());
    expect(blankBody).toContain('the empty prose');
    expect(blankBody).not.toContain('still-empty');
  });

  test('a field whose SPANISH is missing counts as blank, not as drafted', async () => {
    // Parity is the unit: `drafted` would be true and `name.en` empty, so a
    // per-language check is the only one that can be believed here.
    const half = clone(GOOD);
    half.name.es = '';
    const draft = await draftFor(clientReturning(json(half)), GROUND);
    expect(bodyFor(draft)).toContain('still-empty **name** (both languages)');
  });
});

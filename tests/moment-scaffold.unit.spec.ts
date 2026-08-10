import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// THE PROPERTY THIS FILE EXISTS FOR:
//
//   The scaffold scripts/moment-watch.mjs prints in a candidate issue, pasted
//   VERBATIM into data/moments.json, passes `node scripts/check-moments.mjs`
//   with zero violations.
//
// Nothing else establishes the deliverable. A scaffold that drafts the hard
// part (bilingual prose) and then reds CI on the mechanical part is worse than
// blanks, because it looks finished — the owner would edit it, open a PR, and
// learn about `aliases: []` from a gate. So the test below takes REAL
// candidates out of the real corpus, generates their scaffolds with a stubbed
// draft client, splices each into a COPY of the real data/moments.json, and
// runs the REAL checkMoments against the REAL corpora — the same wiring
// scripts/check-moments.mjs uses, copied here the way
// tests/moments.unit.spec.ts already copies it.
//
// And its counterpart, which is the honest half: with drafting OFF, the same
// scaffold must fail on the six empty prose fields and NOTHING ELSE. A blank
// scaffold's failures should be exactly the sentences the owner still has to
// write.
//
// ZERO network. The Anthropic client is a stub; every other input is a file
// already in the repo.
import { checkMoments, lintForbidden, vehicleKind } from '../lib/moments-gate.mjs';
import { nominationSlug, type Nomination } from '../lib/core/nominations';
import { buildReport } from '../scripts/moment-candidates.mjs';
import { blankDraft, draftFor, groundFor } from '../scripts/moment-draft.mjs';
import {
  PLACEHOLDER_ID,
  PUBLISHED_SIGNAL_MAX_AGE_DAYS,
  REVIEW_WINDOW_DAYS,
  aliasesFor,
  blankStructure,
  categoryFor,
  floorActionInRecord,
  kebab,
  leanDiverseRefs,
  momentIdFor,
  reviewByFor,
  signalFor,
  structureFor,
} from '../scripts/moment-scaffold.mjs';
import { FLOORS, articlesFor, passesFloors, scaffoldFor } from '../scripts/moment-watch.mjs';

const read = (p: string) => JSON.parse(readFileSync(join(__dirname, '..', p), 'utf8'));

interface BillRow {
  full_identifier: string;
  status: string;
  issue_tags?: string[];
  last_action_text?: string | null;
}
interface MomentRow {
  name: { en: string; es: string };
  opened: string;
  review_by: string;
  qualifying_signal: { type: string; refs: string[] };
}

const bills = read('data/bills.json') as BillRow[];
const coverage = read('data/coverage.json') as Record<string, { url: string; source: string }[]>;
const momentsFile = read('data/moments.json') as Record<string, MomentRow>;
const nominations = read('data/nominations.json') as Nomination[];

/** Frozen for the whole file so `opened`/`review_by` cannot straddle midnight
 *  between two assertions. */
const NOW = Date.now();

const report = buildReport({ bills, coverage, moments: momentsFile, rejections: [], now: NOW });
const billBySlug = new Map(bills.map((b) => [b.full_identifier, b]));
const takenIds = new Set(Object.keys(momentsFile));

/* ------------------------------------------------------------------ *
 * The gate, wired exactly as scripts/check-moments.mjs wires it, over a
 * COPY of the real file with one candidate spliced in. Nothing here
 * writes: the splice is an object spread.
 * ------------------------------------------------------------------ */

const slugsByKind = {
  bill: new Set(bills.map((b) => b.full_identifier)),
  nomination: new Set(nominations.map(nominationSlug)),
};
const statusByKind: Record<string, Map<string, string>> = {
  bill: new Map(bills.map((b) => [b.full_identifier, b.status])),
  nomination: new Map(nominations.map((n) => [nominationSlug(n), n.status])),
};
const describedNominationSlugs = new Set(
  nominations.filter((n) => n.nominee_description?.trim()).map(nominationSlug),
);

function checkSpliced(entry: Record<string, unknown>): string[] {
  const spliced = { ...momentsFile, ...entry };
  const { violations } = checkMoments(
    spliced,
    slugsByKind,
    (v: { slug: string; kind?: string }) => statusByKind[vehicleKind(v)]?.get(v.slug),
    { describedNominationSlugs, now: NOW },
  );
  return violations;
}

/* ------------------------------------------------------------------ *
 * The stub. Prose is generic on purpose — this file asserts nothing
 * about what the model writes (tests/moment-draft.unit.spec.ts owns
 * that); it needs a clean, lint-passing, bilingual reply so the prose
 * slots are full and the only thing left under test is structure.
 * ------------------------------------------------------------------ */

const DRAFTED = {
  name: { en: 'The Syria sanctions question', es: 'La cuestión de las sanciones a Siria' },
  summary: {
    en: 'A measure before the Senate would change two laws now in force. A yes vote adopts the change; a no vote leaves both laws as they are.',
    es: 'Una medida ante el Senado cambiaría dos leyes vigentes. Un voto a favor adopta el cambio; un voto en contra deja ambas leyes como están.',
  },
  role: {
    en: 'A yes vote adopts the change this measure names. A no vote leaves current law in place.',
    es: 'Un voto a favor adopta el cambio que nombra esta medida. Un voto en contra deja la ley actual como está.',
  },
};

const draftClient = {
  messages: {
    create: async () => ({ content: [{ type: 'text', text: JSON.stringify(DRAFTED) }] }),
  },
};

type Candidate = (typeof report.candidates)[number];

const structureOf = (c: Candidate, nameEn: string) =>
  structureFor(c, billBySlug.get(c.slug), {
    now: NOW,
    articles: articlesFor(coverage, c.slug),
    takenIds,
    nameEn,
  });

const groundOf = (c: Candidate) => groundFor(c, billBySlug.get(c.slug), null);

/**
 * The candidates whose structure is fully derivable — every mechanical field
 * filled from the record. Drawn from the whole ranked report rather than only
 * the handful above the notification floor: the property under test is the
 * scaffold's SHAPE, and a corpus quiet enough to have nothing above the floor
 * would otherwise silently stop proving it.
 */
const derivable = report.candidates.filter((c) => structureOf(c, DRAFTED.name.en).gaps.length === 0);

/* ------------------------------------------------------------------ *
 * 1 · THE PROPERTY.
 * ------------------------------------------------------------------ */

test.describe('a scaffold, pasted verbatim, merges clean', () => {
  test('every mechanical field is derivable for a real candidate', () => {
    expect(
      derivable.length,
      'no candidate in the corpus has both a derivable category and a derivable qualifying signal. That is far more likely to mean categoryFor/signalFor broke than that the corpus went quiet — check those before assuming this is data.',
    ).toBeGreaterThan(0);
  });

  test('the drafted scaffold passes the real gate, against the real corpora', async () => {
    // Up to three, so one odd candidate cannot carry the proof alone.
    for (const c of derivable.slice(0, 3)) {
      const draft = await draftFor(draftClient, groundOf(c));
      expect(draft.drafted, `${c.slug}: the stub reply should have passed the draft lint`).toBe(true);

      const scaffold = scaffoldFor(c, draft, structureOf(c, draft.name.en));
      expect(checkSpliced(scaffold), `${c.slug} pasted verbatim`).toEqual([]);
    }
  });

  test('the scaffold is JSON-round-trippable — what the issue prints is what is checked', async () => {
    const c = derivable[0];
    const draft = await draftFor(draftClient, groundOf(c));
    const structure = structureOf(c, draft.name.en);
    // The issue body carries JSON.stringify(scaffold, null, 2) inside a fence;
    // the owner copies that TEXT. Parse it back and gate the parsed value, so
    // the proof is about the characters he pastes, not about an object in
    // memory that happens to serialise close enough.
    const pasted = JSON.parse(JSON.stringify(scaffoldFor(c, draft, structure), null, 2));
    expect(checkSpliced(pasted)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 2 · HONEST DEGRADATION. With no key, the failures are the sentences
 *     the owner has to write — and nothing mechanical.
 * ------------------------------------------------------------------ */

test.describe('with drafting off, only the prose is missing', () => {
  test('a blank scaffold fails on exactly the six prose fields', async () => {
    const c = derivable[0];
    const draft = await draftFor(null, groundOf(c)); // no client = no key
    expect(draft.drafted).toBe(false);

    const structure = structureOf(c, draft.name.en); // '' — nothing was drafted
    const scaffold = scaffoldFor(c, draft, structure);
    const id = Object.keys(scaffold)[0];

    const violations = checkSpliced(scaffold);
    // Every violation names one of the six prose slots, and says the same
    // thing about each: it is empty. Nothing structural is left.
    expect(violations.map((v) => v.split(':')[0]).sort()).toEqual(
      [
        `${id}.name.en`,
        `${id}.name.es`,
        `${id}.summary.en`,
        `${id}.summary.es`,
        `${id}.vehicles[0].role.en`,
        `${id}.vehicles[0].role.es`,
      ].sort(),
    );
    for (const v of violations) expect(v).toContain('missing or empty');
  });

  test('the blank-path id is still a valid moment id — the placeholder never reaches the gate', async () => {
    const c = derivable[0];
    const structure = structureOf(c, '');
    expect(structure.id).not.toBe(PLACEHOLDER_ID);
    expect(structure.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    // …and the notes say it is a placeholder, so nobody ships `question-…`.
    expect(structure.notes.join(' ')).toContain('placeholder');
  });

  test('a structure that was never derived fails LOUDLY rather than looking valid', () => {
    const c = report.candidates[0];
    const violations = checkSpliced(scaffoldFor(c, blankDraft(), blankStructure()));
    expect(violations.join(' ')).toContain('moment id must be a lowercase kebab slug');
  });
});

/* ------------------------------------------------------------------ *
 * 3 · NEVER INVENT A FACT TO SATISFY A SCHEMA. Each derivation, and
 *     each refusal, on its own.
 * ------------------------------------------------------------------ */

test.describe('category comes from the bill, or stays blank', () => {
  test('one issue tag maps straight through', () => {
    expect(categoryFor({ issue_tags: ['national_security'] })).toEqual({
      category: 'national_security',
      note: null,
    });
  });

  test('no tag leaves it blank and says so', () => {
    const { category, note } = categoryFor({ issue_tags: [] });
    expect(category).toBe('');
    expect(note).toContain('`category` is blank');
  });

  test('two tags leave it blank — the category is a choice, not a coin flip', () => {
    const { category, note } = categoryFor({ issue_tags: ['health', 'jobs_economy'] });
    expect(category).toBe('');
    expect(note).toContain('health');
    expect(note).toContain('jobs_economy');
  });

  test('a tag that is not one of the 12 never becomes a category', () => {
    expect(categoryFor({ issue_tags: ['not_a_category'] }).category).toBe('');
  });

  test('the derivation is total over the real corpus — no bill can produce an invalid category', () => {
    for (const b of bills) {
      const { category } = categoryFor(b);
      if (category) expect(b.issue_tags).toEqual([category]);
    }
  });
});

test.describe('the qualifying signal is the evidence the floor already tested', () => {
  const ON_CALENDAR = {
    slug: 's-3172-119',
    citation: 'S. 3172',
    status: 'floor_vote',
    lastActionDate: '2026-07-27',
    floorCalendar: true,
    floorChamber: 'senate',
    tier: 'neutral',
    outlets: 5,
    url: 'https://www.congress.gov/bill/119th-congress/senate-bill/3172',
  };
  const NOW_NEAR = Date.parse('2026-08-01T00:00:00Z');

  test('a floor-calendar placement is tier0_floor, evidenced by the record link', () => {
    const { signal, note } = signalFor(ON_CALENDAR, [], { now: NOW_NEAR });
    expect(signal).toEqual({ type: 'tier0_floor', refs: [ON_CALENDAR.url] });
    expect(note).toBeNull();
    // The same type and the same class of ref both live moments already carry.
    for (const m of Object.values(momentsFile)) {
      if (m.qualifying_signal.type === 'tier0_floor') {
        for (const ref of m.qualifying_signal.refs) expect(ref).toMatch(/^https:\/\/www\.congress\.gov\//);
      }
    }
  });

  /* ---------------------------------------------------------------- *
   * tier0_floor_action (2026-08-09). The gap this closes is not
   * hypothetical: `paying-college-athletes` and `annual-defense-policy`
   * were opened with `tier0_floor` over records whose last action was a
   * MOTION, because the scaffold could derive nothing for them and the
   * empty box got filled by hand. These fixtures are those two records,
   * verbatim from congress.gov.
   * ---------------------------------------------------------------- */
  const CLOTURE_TEXT = 'Cloture motion on the motion to proceed to the measure presented in Senate. (CR S4449)';
  const MTP_TEXT = 'Motion to proceed to consideration of measure made in Senate. (CR S4276)';
  const FLOOR_ACTION = {
    slug: 's-4668-119',
    citation: 'S. 4668',
    status: 'floor_vote',
    lastActionDate: '2026-08-05',
    floorCalendar: false,
    floorChamber: null,
    tier: 'neutral',
    outlets: 5,
    url: 'https://www.congress.gov/bill/119th-congress/senate-bill/4668',
  };
  const NOW_FLOOR = Date.parse('2026-08-09T00:00:00Z');

  test('floor action in the record is tier0_floor_action, evidenced by the record AND its actions page', () => {
    const { signal, note } = signalFor(FLOOR_ACTION, [], { now: NOW_FLOOR, lastActionText: CLOTURE_TEXT });
    expect(signal).toEqual({
      type: 'tier0_floor_action',
      refs: [FLOOR_ACTION.url, `${FLOOR_ACTION.url}/all-actions`],
    });
    expect(note).toBeNull();
  });

  test('a motion to proceed is the same signal — the type is about the floor, not about cloture', () => {
    const { signal } = signalFor(
      { ...FLOOR_ACTION, slug: 's-4784-119', url: 'https://www.congress.gov/bill/119th-congress/senate-bill/4784' },
      [],
      { now: NOW_FLOOR, lastActionText: MTP_TEXT },
    );
    expect(signal.type).toBe('tier0_floor_action');
  });

  test('a placement is never floor action — the narrower type wins, and tier0_floor is untouched', () => {
    const { signal } = signalFor(ON_CALENDAR, [], {
      now: NOW_NEAR,
      lastActionText: 'Placed on Senate Legislative Calendar under General Orders. Calendar No. 501.',
    });
    expect(signal).toEqual({ type: 'tier0_floor', refs: [ON_CALENDAR.url] });
  });

  test('with no last-action text on file nothing is derived — silence is not evidence', () => {
    const { signal, note } = signalFor(FLOOR_ACTION, [], { now: NOW_FLOOR });
    expect(signal).toEqual({ type: '', refs: [] });
    expect(note).toContain('`qualifying_signal` is empty');
    expect(note).toContain('no last-action text was on file');
  });

  test('a record that is neither placement nor floor action still yields the empty box, naming both', () => {
    const committeeText = 'Committee on Foreign Relations. Hearings held.';
    const { signal, note } = signalFor(
      { ...FLOOR_ACTION, status: 'floor_vote' },
      [],
      { now: NOW_FLOOR, lastActionText: committeeText },
    );
    expect(signal).toEqual({ type: '', refs: [] });
    expect(note).toContain('tier0_floor`');
    expect(note).toContain('tier0_floor_action');
    expect(note).toContain(committeeText);
  });

  /* The matcher is measured against the corpus, not guessed — the same
     totality discipline categoryFor gets above. Two directions matter: it
     must cover the whole population it exists for, and it must never fire
     on a bill whose record says something else. */
  test('the floor-action vocabulary is total over the corpus it is for, and fires nowhere else', () => {
    const isPlacement = (t?: string | null) =>
      /placed on (?:the )?(senate legislative|union|house|senate)\s+calendar/i.test(t ?? '');
    let activityOnly = 0;
    for (const b of bills) {
      const placement = isPlacement(b.last_action_text);
      const onFloor = b.status === 'floor_vote';
      const derived = floorActionInRecord(
        { status: b.status, floorCalendar: onFloor && placement },
        b.last_action_text ?? null,
      );
      if (onFloor && !placement) {
        activityOnly++;
        expect(derived, `${b.full_identifier}: ${b.last_action_text}`).toBe(true);
      } else {
        expect(derived, `${b.full_identifier}: ${b.last_action_text}`).toBe(false);
      }
    }
    // Guards the guard: if the population ever empties, the loop above would
    // pass vacuously and stop meaning anything.
    expect(activityOnly).toBeGreaterThan(0);
  });

  test('cross-spectrum coverage is press, with one https ref per lean-diverse outlet', () => {
    const articles = [
      { url: 'https://a.example/1', outlet: 'a.example', lean: 'left' },
      { url: 'https://a.example/2', outlet: 'a.example', lean: 'left' },
      { url: 'https://b.example/1', outlet: 'b.example', lean: 'right' },
      { url: 'https://c.example/1', outlet: 'c.example', lean: null },
    ];
    const { signal } = signalFor({ tier: 'cross', floorCalendar: false }, articles, { now: NOW_NEAR });
    expect(signal.type).toBe('press');
    expect(signal.refs).toEqual(['https://a.example/1', 'https://b.example/1']);
  });

  test('neutral coverage is never called press — "across the spectrum" would be false', () => {
    const articles = [
      { url: 'https://a.example/1', outlet: 'a.example', lean: null },
      { url: 'https://b.example/1', outlet: 'b.example', lean: null },
      { url: 'https://c.example/1', outlet: 'c.example', lean: null },
    ];
    const { signal, note } = signalFor(
      { tier: 'neutral', floorCalendar: false, status: 'floor_vote' },
      articles,
      { now: NOW_NEAR },
    );
    expect(signal).toEqual({ type: '', refs: [] });
    expect(note).toContain('`qualifying_signal` is empty');
  });

  test('one-sided coverage yields no refs at all', () => {
    expect(
      leanDiverseRefs([
        { url: 'https://a.example/1', outlet: 'a.example', lean: 'right' },
        { url: 'https://b.example/1', outlet: 'b.example', lean: 'right' },
      ]),
    ).toEqual([]);
  });

  test('a non-https article is not evidence', () => {
    expect(
      leanDiverseRefs([
        { url: 'http://a.example/1', outlet: 'a.example', lean: 'left' },
        { url: 'https://b.example/1', outlet: 'b.example', lean: 'right' },
      ]),
    ).toEqual([]);
  });

  test('tier0_scheduled is never emitted — there is no scheduled-vote date to derive it from', () => {
    // Wired the way structureFor wires it, so this runs the REAL floor-action
    // path over the real candidates rather than a text-free shortcut of it.
    const emitted = new Set(
      report.candidates.map(
        (c) =>
          signalFor(c, articlesFor(coverage, c.slug), {
            now: NOW,
            lastActionText: billBySlug.get(c.slug)?.last_action_text ?? null,
          }).signal.type,
      ),
    );
    expect([...emitted].sort()).not.toContain('tier0_scheduled');
    expect([...emitted].sort()).not.toContain('tier0_exec_calendar');
    expect([...emitted].sort()).not.toContain('tier0_most_viewed');
    // Closed set: only the three types this file can derive, plus the empty
    // box. A new member appearing here is a fabrication until it is argued.
    for (const type of emitted) {
      expect(['', 'tier0_floor', 'tier0_floor_action', 'press']).toContain(type);
    }
  });

  test('a signal older than the published 45-day criterion is emitted AND flagged', () => {
    const stale = { ...ON_CALENDAR, lastActionDate: '2026-06-01' };
    const { signal, note } = signalFor(stale, [], { now: Date.parse('2026-08-01T00:00:00Z') });
    expect(signal.type).toBe('tier0_floor'); // still true of the record
    expect(note).toContain('moments.whyCriteria');
  });

  test('the published window, the watcher floor, and the copy agree — in both languages', () => {
    // Owner ruling 2026-08-09: one number, everywhere a reader can compare.
    // If any of these four move independently, the stale-signal note starts
    // firing on real candidates again — that note is detection, this is the pin.
    expect(PUBLISHED_SIGNAL_MAX_AGE_DAYS).toBe(FLOORS.maxLastActionAgeDays);
    const en = read('messages/en.json').moments;
    const es = read('messages/es.json').moments;
    for (const s of [en.whyCriteria, en.howMadeRule2]) {
      expect(s).toContain(`last ${PUBLISHED_SIGNAL_MAX_AGE_DAYS} days`);
    }
    for (const s of [es.whyCriteria, es.howMadeRule2]) {
      expect(s).toContain(`últimos ${PUBLISHED_SIGNAL_MAX_AGE_DAYS} días`);
    }
  });
});

test.describe('aliases are copied, never composed', () => {
  test('the citation is the one derived term, in both languages', () => {
    const { aliases, note } = aliasesFor({ citation: 'S. 3172' });
    expect(aliases).toEqual({ en: ['S. 3172'], es: ['S. 3172'] });
    expect(note).toContain('placeholder');
  });

  test('every derived alias is vocabulary-clean, though the gate never checks aliases', () => {
    // The gate deliberately skips the lint here, which is exactly why nothing
    // written by a model may land in this field. What IS placed here is copied
    // from the record, and it is linted anyway.
    for (const c of report.candidates) {
      const { aliases } = aliasesFor(c);
      for (const lang of ['en', 'es'] as const) {
        for (const a of aliases[lang]) expect(lintForbidden(a, lang)).toEqual([]);
      }
    }
  });

  test('a citation-less candidate leaves the list empty and asks for words', () => {
    const { aliases, note } = aliasesFor({});
    expect(aliases).toEqual({ en: [], es: [] });
    expect(note).toContain('needs you');
  });
});

test.describe('the moment id is derived the way the live file was named', () => {
  test('the rule reproduces both hand-authored ids from their own names', () => {
    for (const [id, m] of Object.entries(momentsFile)) {
      expect(momentIdFor(m.name.en, 'unused', new Set()).id, `${id} from "${m.name.en}"`).toBe(id);
    }
  });

  test('a collision is renamed and called out — a duplicate key would delete a live question', () => {
    const existing = Object.keys(momentsFile)[0];
    const name = Object.values(momentsFile)[0].name.en;
    const { id, collided } = momentIdFor(name, 's-3172-119', new Set(Object.keys(momentsFile)));
    expect(collided).toBe(true);
    expect(id).toBe(`${existing}-s-3172-119`);
  });

  test('no name to derive from falls back to a valid slug, not to a scream', () => {
    const { id, derived } = momentIdFor('', 's-3172-119');
    expect(derived).toBe(false);
    expect(id).toBe('question-s-3172-119');
  });

  test('accents and punctuation survive as a kebab slug', () => {
    expect(kebab('La cuestión de los poderes de guerra')).toBe('la-cuestion-de-los-poderes-de-guerra');
  });
});

test.describe('the dates match the file, not an invented cadence', () => {
  test('review_by is opened + 30 days in both live moments', () => {
    for (const [id, m] of Object.entries(momentsFile)) {
      expect(reviewByFor(m.opened), `${id}`).toBe(m.review_by);
    }
    expect(REVIEW_WINDOW_DAYS).toBe(30);
  });

  test('opened is the run date and review_by follows it', () => {
    const s = structureOf(report.candidates[0], DRAFTED.name.en);
    expect(s.opened).toBe(new Date(NOW).toISOString().slice(0, 10));
    expect(s.review_by).toBe(reviewByFor(s.opened));
  });
});

/* ------------------------------------------------------------------ *
 * 4 · A GAP IS NEVER SILENT. Whatever the record cannot support comes
 *     out correctly shaped, empty, and NAMED in the issue.
 * ------------------------------------------------------------------ */

test.describe('what the record cannot support is shaped, empty, and explained', () => {
  test('every candidate in the corpus gets a structure with a reason for each gap', () => {
    for (const c of report.candidates) {
      const s = structureOf(c, DRAFTED.name.en);
      // Shape first: an empty value never means a wrong type.
      expect(Array.isArray(s.aliases.en) && Array.isArray(s.aliases.es)).toBe(true);
      expect(typeof s.signal.type).toBe('string');
      expect(Array.isArray(s.signal.refs)).toBe(true);
      expect(s.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      for (const ref of s.signal.refs) expect(ref).toMatch(/^https:\/\//);
      // Then the promise: no gap goes unexplained.
      for (const gap of s.gaps) {
        expect(s.notes.join(' '), `${c.slug}: \`${gap}\` is empty and nothing in the issue says why`).toContain(
          gap === 'qualifying_signal' ? '`qualifying_signal`' : `\`${gap}\``,
        );
      }
    }
  });

  test('the candidates above the notification floor are the ones this actually ships for', () => {
    const above = report.candidates.filter(
      (c) => passesFloors(c, { now: NOW, openSlots: report.moments.openSlots }).pass,
    );
    // Not an assertion about how many: a quiet night is a legitimate state and
    // the watcher's whole value is that silence means something. What IS
    // asserted is that whatever ships is shaped, which is the property above,
    // applied to the exact set the workflow renders.
    for (const c of above) {
      const s = structureOf(c, DRAFTED.name.en);
      const scaffold = scaffoldFor(c, blankDraft(), s);
      const violations = checkSpliced(scaffold);
      const structural = violations.filter(
        (v) => !/\.(name|summary)\.(en|es):|\.role\.(en|es):/.test(v),
      );
      // Every remaining structural failure is a gap the issue already names.
      for (const v of structural) {
        expect(s.gaps.some((g) => v.includes(g)), `${c.slug}: unnamed structural failure "${v}"`).toBe(true);
      }
    }
  });
});

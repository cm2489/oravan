/**
 * Moment scaffold — the STRUCTURAL half of a Big Question scaffold, the way
 * scripts/moment-draft.mjs is the PROSE half.
 *
 * WHY THIS EXISTS. The 2026-08-07 draft layer filled the three hard slots —
 * name, summary, role, both languages — and left every mechanical field the
 * way the blank form had them: `aliases: []`, a free-text `qualifying_signal`
 * sentence, `category: ""`, `opened`/`review_by` empty, `context_refs: []`,
 * and a moment id of `REPLACE-WITH-MOMENT-ID`. Pasted into data/moments.json
 * that scaffold failed `node scripts/check-moments.mjs` on eight violations
 * before the owner had read a sentence of it.
 *
 * That is worse than blanks, and specifically worse in the way this project
 * cares about: it LOOKS finished. The owner's job is "review and edit the
 * writing and the choice of what goes up" (ruling, 2026-08-07). Debugging a
 * schema gate is not that job, and every minute of it is a minute he did not
 * spend on the sentences only he can write.
 *
 * So this module derives the mechanical fields, and the property that makes
 * the whole scaffold worth shipping is testable in one line:
 *
 *   THE SCAFFOLD, PASTED VERBATIM, PASSES scripts/check-moments.mjs.
 *
 * tests/moment-scaffold.unit.spec.ts proves exactly that against the real
 * corpora, and proves its honest-degradation counterpart: with drafting off,
 * the ONLY violations left are the six empty prose fields — so a blank
 * scaffold's failures are precisely the sentences the owner still has to
 * write, and nothing mechanical.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THIS FILE OBEYS: **never invent a fact to satisfy a schema.**
 *
 * A structurally valid record carrying a guessed category or a fabricated ref
 * is far worse than one blank field, because the gate would wave it through
 * and nobody would ever look again. Every value below traces to data the
 * issue already prints:
 *
 *   category ....... the bill's OWN `issue_tags`, which are already one of the
 *                    12 CRS categories. Exactly one tag maps; zero or several
 *                    leave the field blank with the reason named, because the
 *                    category drives the whole taxonomy.
 *   qualifying_signal  the floor-calendar placement the watcher already tested
 *                    (`tier0_floor`, evidenced by the congress.gov record),
 *                    floor action stated in the record's own words
 *                    (`tier0_floor_action`, evidenced by the record and its
 *                    `/all-actions` page), or cross-spectrum press (`press`,
 *                    evidenced by the stored article URLs of two lean-diverse
 *                    outlets). Anything else is structured-but-empty with the
 *                    reason named. No member of SIGNAL_TYPES is ever invented,
 *                    and `tier0_scheduled` is never emitted at all — see
 *                    signalFor.
 *   aliases ........ the citation, copied verbatim. Never composed. See aliasesFor.
 *   opened ......... the run's own date.
 *   review_by ...... opened + 30 days, which is the interval both live moments
 *                    use (2026-07-23 -> 2026-08-22, twice). Read off the file,
 *                    not invented.
 *   id ............. kebab of the drafted name.en, minus a leading "the" and a
 *                    trailing "question" — the rule that reproduces BOTH live
 *                    ids from their own names. A suggestion, and labelled one.
 *   context_refs ... omitted entirely. It is optional, hand-curated, and
 *                    host-allowlisted (CRS/CBO/GAO); the empty array the old
 *                    scaffold shipped was itself a violation ("a claim of
 *                    grounding with no ground").
 *
 * IMPORT DISCIPLINE. One import, and it is the gate's own module — CATEGORIES,
 * SIGNAL_TYPES and lintForbidden are IMPORTED, NEVER COPIED (v2 spec §2.3),
 * so a category or signal type this file emits cannot drift from the list
 * scripts/check-moments.mjs validates against. lib/moments-gate.mjs is itself
 * import-free and free of import.meta, so the chain loads under Playwright's
 * transform. No module-scope I/O, no env, no clock: `now` is a parameter.
 */
import { CATEGORIES, SIGNAL_TYPES, lintForbidden } from '../lib/moments-gate.mjs';

const DAY_MS = 86_400_000;

/**
 * `review_by` = `opened` + this. Not a policy invented here: it is the
 * interval BOTH hand-authored moments in data/moments.json use (opened
 * 2026-07-23, review_by 2026-08-22 — 30 days, in both entries). Nothing else
 * in the repo states a review cadence, so the file is the convention.
 */
export const REVIEW_WINDOW_DAYS = 30;

/**
 * What `moments.whyCriteria` and `moments.howMadeRule2` promise readers about
 * a qualifying signal: "within the last 45 days" — set equal to the watcher's
 * own currency floor (FLOORS.maxLastActionAgeDays) by owner ruling 2026-08-09,
 * which closed the gap this note was built to name (the copy used to say 14).
 * The note below stays as a tripwire: it can still fire on an out-of-band
 * invocation (`--only` against an older record), and it fires again the day
 * the two numbers drift apart — a drift test pins them equal.
 */
export const PUBLISHED_SIGNAL_MAX_AGE_DAYS = 45;

/** The id a scaffold carries when nothing was derived — deliberately the
 *  screaming placeholder, and deliberately NOT a valid moment id, so a code
 *  path that forgot to derive a structure fails the gate loudly. */
export const PLACEHOLDER_ID = 'REPLACE-WITH-MOMENT-ID';

const isHttps = (u) => typeof u === 'string' && /^https:\/\//.test(u.trim());

/** UTC calendar day of a timestamp. */
export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Whole days between an ISO date and `now`; Infinity when unparseable, so an
 *  undated record reads as old rather than as fresh. */
function ageInDays(isoDate, now) {
  if (!isoDate) return Infinity;
  const t = Date.parse(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? Infinity : Math.floor((now - t) / DAY_MS);
}

/** `opened` + REVIEW_WINDOW_DAYS, as YYYY-MM-DD. '' when `opened` is not a date. */
export function reviewByFor(opened, days = REVIEW_WINDOW_DAYS) {
  const t = Date.parse(`${String(opened ?? '').slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? isoDay(t + days * DAY_MS) : '';
}

/* ------------------------------------------------------------------ *
 * category
 * ------------------------------------------------------------------ */

/**
 * The category, from the bill's own `issue_tags`.
 *
 * Free, and free of judgement: a bill's tags are already drawn from the same
 * 12 CRS categories a moment's `category` must be (2,561 of the 2,607 bills in
 * the corpus carry exactly one, 46 carry none, and none carries two), so the
 * mapping is a lookup rather than a classification.
 *
 * ZERO OR SEVERAL LEAVES IT BLANK. The category decides which index a question
 * appears under and which topic filter finds it — picking one of two plausible
 * tags would be an editorial act wearing a schema's clothes. The issue says
 * which tags were on the record and asks for the choice.
 *
 * @param {{ issue_tags?: string[] } | undefined} bill  its data/bills.json row
 * @returns {{ category: string, note: string | null }}
 */
export function categoryFor(bill) {
  const tags = Array.isArray(bill?.issue_tags) ? bill.issue_tags : [];
  const known = tags.filter((t) => CATEGORIES.includes(t));
  if (tags.length === 1 && known.length === 1) return { category: known[0], note: null };
  if (tags.length === 0) {
    return {
      category: '',
      note: '**`category` is blank and needs you.** The bill carries no issue tag, so there is nothing on the record to map from. Choose one of `' + CATEGORIES.join('` · `') + '`.',
    };
  }
  return {
    category: '',
    note:
      `**\`category\` is blank and needs you.** The bill's issue tags are ${tags.map((t) => `\`${t}\``).join(', ')}` +
      `${known.length === tags.length ? '' : ' (not all of them are categories)'}` +
      ', which is not a single category. The category drives the whole taxonomy — which index the question sits in and which topic filter finds it — so it is a choice, not a guess.',
  };
}

/* ------------------------------------------------------------------ *
 * qualifying_signal
 * ------------------------------------------------------------------ */

/**
 * The article URLs that evidence a `press` signal: https only, one per outlet,
 * and only outlets the AllSides table rates left or right — because the claim
 * the type makes ("Covered by outlets across the spectrum") and the rule the
 * gate states ("≥2 refs from lean-diverse outlets") are both about LEAN, not
 * about volume. Returns [] when fewer than two distinct leans survive, which
 * is the honest answer rather than a shorter list.
 *
 * @param {{ url?: string, outlet?: string, lean?: string | null }[]} articles
 */
export function leanDiverseRefs(articles, max = 4) {
  const byOutlet = new Map();
  for (const a of articles ?? []) {
    if (!isHttps(a?.url)) continue;
    if (a.lean !== 'left' && a.lean !== 'right') continue;
    const outlet = String(a.outlet ?? a.url).toLowerCase();
    if (!byOutlet.has(outlet)) byOutlet.set(outlet, { url: a.url.trim(), lean: a.lean });
  }
  const picked = [...byOutlet.values()];
  if (new Set(picked.map((p) => p.lean)).size < 2) return [];
  return picked.slice(0, max).map((p) => p.url);
}

/* ------------------------------------------------------------------ *
 * Import-free copy #1 for this file — the floor-ACTION vocabulary.
 *
 * SOURCE OF TRUTH: lib/journey.ts `statusKeyFor` + `floorActionChamber`,
 * which is what every SURFACE routes through to print "Floor activity"
 * instead of "On the floor calendar". This module may not import that file
 * (TypeScript, and this script runs on bare node — the same constraint
 * scripts/moment-candidates.mjs solves with its own documented copies), so
 * the patterns live here and tests/moment-scaffold.unit.spec.ts pins them
 * against the real corpus.
 *
 * WHY A POSITIVE MATCHER RATHER THAN `statusKeyFor`'s ABSENCE TEST. The page
 * label may be derived by absence — a `floor_vote` bill whose text is not a
 * placement is "Floor activity" — because a label describes a bill that is
 * already on screen. A qualifying signal is a CLAIM about why a Big Question
 * exists at all, and this file's one rule is never to invent a fact to
 * satisfy a schema. So the record has to SAY it, in its own words, and a
 * missing or unrecognized sentence yields nothing (fail closed).
 *
 * THE LIST IS MEASURED, NOT GUESSED. Of the 339 `floor_vote` bills in
 * data/bills.json on 2026-08-09, 26 carry no placement sentence — the exact
 * population this matcher is for — and these six patterns cover 26 of 26:
 *   11  Motion to proceed to consideration of measure made/rejected in Senate
 *    6  Cloture motion … presented / cloture … not invoked, by Yea-Nay Vote
 *    3  Motion to discharge Senate Committee on … rejected by Yea-Nay Vote
 *    3  Rules Committee Resolution H. Res. N Reported to House. Rule provides
 *       for consideration of …
 *    2  POSTPONED PROCEEDINGS — Pursuant to clause 1(c) of rule XIX …
 *    1  Motion by Senator … to reconsider …
 * Every one of them is a chamber acting on the measure on its own floor.
 * ------------------------------------------------------------------ */
const FLOOR_ACTION_PATTERNS = [
  /\bcloture\b/i,
  /\bmotion to proceed\b/i,
  /\bmotion to discharge\b/i,
  /\bpostponed proceedings\b/i,
  /\brule provides for consideration\b/i,
  /\bmotion by senator\b/i,
];

/**
 * Does the candidate's OWN last action say a chamber took floor action on the
 * measure — as opposed to placing it on a calendar, which is `tier0_floor`?
 *
 * Three conditions, all required, all fail-closed:
 *   1. the corpus derived `floor_vote` for it (which sync-bills derives FROM
 *      the action text — see lib/journey.ts's header), so this is never a
 *      committee-stage bill with a stray word in its sentence;
 *   2. it is NOT a placement (`floorCalendar`, the strict gate in
 *      scripts/moment-candidates.mjs) — a placement is the other type, and
 *      the two must never both fire;
 *   3. the last action TEXT matches one of the measured shapes above. With no
 *      text on file this is false, and the caller emits nothing.
 *
 * @param {Record<string, any>} c            one entry of buildReport().candidates
 * @param {string | null} [lastActionText]   the bill's own `last_action_text`
 */
export function floorActionInRecord(c, lastActionText = null) {
  if (c?.status !== 'floor_vote') return false;
  if (c?.floorCalendar) return false;
  const text = String(lastActionText ?? '');
  return text.trim().length > 0 && FLOOR_ACTION_PATTERNS.some((re) => re.test(text));
}

/**
 * The qualifying signal, from the evidence the watcher ALREADY tested to let
 * this candidate through the floor.
 *
 * THREE TYPES ARE DERIVABLE, in this order:
 *
 *  1. `tier0_floor` — the candidate's own last action says a chamber PLACED it
 *     on a calendar (scripts/moment-candidates.mjs `isOnFloorCalendar`, which
 *     is deliberately stricter than `status === "floor_vote"`: hundreds of
 *     bills carry that status and only a placement sentence earns the claim).
 *     The ref is the congress.gov record, which is where that sentence lives —
 *     exactly what both hand-authored moments cite for the same type.
 *
 *  2. `tier0_floor_action` — the last action is the chamber MOVING on the
 *     measure on the floor (a motion to proceed, a cloture filing, a rule
 *     resolution), which is a different fact from a placement and, until
 *     2026-08-09, had no type of its own. That gap is not theoretical: two
 *     live moments were hand-filled with `tier0_floor` over exactly these
 *     records, so /questions printed "On the floor schedule" while the vehicle
 *     card beneath it printed "Floor activity" off the same sentence. The refs
 *     are the record AND its `/all-actions` page, because the motions this
 *     type points at are further down the list than the summary shows.
 *
 *  3. `press` — cross-spectrum coverage, and ONLY tier `cross`. `neutral`
 *     coverage can be five outlets wide and still have no partisan lean in it
 *     at all, so emitting `press` for it would put "Covered by outlets across
 *     the spectrum" on a page over a record that does not say so.
 *
 * Government signals outrank press, and a placement outranks activity: the
 * first two are the chamber's own scheduling record, and 1 is the narrower
 * claim, so a bill that somehow satisfied both would take the narrower one.
 *
 * EVERYTHING ELSE IS STRUCTURED-BUT-EMPTY, with the reason named. In
 * particular `tier0_scheduled` ("Scheduled for a floor vote") is NEVER emitted
 * by this file: the corpus carries no forward-looking scheduled-vote date and
 * none is derivable from a calendar placement — the same fact the draft
 * prompt states twice and FUTURE_VOTE enforces mechanically. A signal type is
 * a claim; an undeserved one is a fabrication that happens to typecheck.
 *
 * @param {Record<string, any>} c  one entry of buildReport().candidates
 * @param {{ url?: string, outlet?: string, lean?: string | null }[]} articles
 * @param {{ now?: number, lastActionText?: string | null }} [opts]
 *        `lastActionText` is the bill's own `last_action_text`, which the
 *        candidate object does not carry (structureFor has the bill row and
 *        passes it). Omitting it cannot produce a signal — see
 *        floorActionInRecord — so a caller that forgets degrades to the empty
 *        box the owner already knows how to fill, never to a wrong type.
 * @returns {{ signal: { type: string, refs: string[] }, note: string | null }}
 */
export function signalFor(c, articles = [], { now = Date.now(), lastActionText = null } = {}) {
  const empty = { type: '', refs: [] };
  const types = '`' + SIGNAL_TYPES.join('` · `') + '`';

  if (c?.floorCalendar) {
    if (!isHttps(c?.url)) {
      return {
        signal: empty,
        note: `**\`qualifying_signal\` is empty and needs you.** The record shows a ${c.floorChamber ?? ''} floor-calendar placement, which is a \`tier0_floor\` signal, but the candidate carries no https congress.gov URL to cite as its ref. Add the record link.`.replace('  ', ' '),
      };
    }
    return { signal: { type: 'tier0_floor', refs: [c.url.trim()] }, note: staleSignalNote(c, now) };
  }

  if (floorActionInRecord(c, lastActionText)) {
    if (!isHttps(c?.url)) {
      return {
        signal: empty,
        note: `**\`qualifying_signal\` is empty and needs you.** The record shows floor action on the measure — “${lastActionText}” — which is a \`tier0_floor_action\` signal, but the candidate carries no https congress.gov URL to cite as its ref. Add the record link.`,
      };
    }
    const record = c.url.trim();
    return {
      signal: { type: 'tier0_floor_action', refs: [record, `${record}/all-actions`] },
      note: staleSignalNote(c, now),
    };
  }

  if (c?.tier === 'cross') {
    const refs = leanDiverseRefs(articles);
    if (refs.length >= 2) {
      return { signal: { type: 'press', refs }, note: staleSignalNote(c, now) };
    }
    return {
      signal: empty,
      note: `**\`qualifying_signal\` is empty and needs you.** Coverage is \`cross\`, so \`press\` is the right type, but the stored articles yield ${refs.length} usable ref(s): a press signal needs two https links from outlets on different sides of the AllSides table, and \`data/coverage.json\` does not hold two for this bill. Paste two yourself, or pick another type from ${types}.`,
    };
  }

  return {
    signal: empty,
    note:
      `**\`qualifying_signal\` is empty and needs you.** Nothing on this record earns a type on its own: its own last action neither says a chamber placed it on a calendar (so \`tier0_floor\` would be a claim the record does not make — it cleared the notification floor on its \`${c?.status}\` status alone) nor reads as floor action on the measure — ${lastActionText ? `it says “${lastActionText}”` : 'no last-action text was on file to read'} — so \`tier0_floor_action\` would be the same kind of claim; and its coverage is \`${c?.tier}\`, not \`cross\` (so \`press\`, which means "across the spectrum", would be false). ` +
      `Deliberately NOT auto-filled with \`tier0_scheduled\`: the corpus holds no scheduled-vote date and none is derivable from a status. Pick from ${types} and attach https refs.`,
  };
}

/** Named when the signal is older than what the site promises readers. The
 *  signal stays — a placement is true until it moves — and since the 2026-08-09
 *  ruling set the published criterion equal to the 45-day notification floor,
 *  this fires only on out-of-band invocations or renewed drift. */
function staleSignalNote(c, now) {
  const age = ageInDays(c?.lastActionDate, now);
  if (age <= PUBLISHED_SIGNAL_MAX_AGE_DAYS) return null;
  return `\`qualifying_signal\` is derived from an action ${age === Infinity ? 'with no date' : `${age} days old`} (${c?.lastActionDate ?? 'undated'}). It is still true of the record, but \`moments.whyCriteria\` tells readers a Big Question opens on a signal "within the last ${PUBLISHED_SIGNAL_MAX_AGE_DAYS} days" — check the record against that promise before merging.`;
}

/* ------------------------------------------------------------------ *
 * aliases
 * ------------------------------------------------------------------ */

/**
 * `aliases` — search-only terms, never rendered (lib/moments-ui.ts pins that
 * contract), and the ONE field the gate deliberately does not vocabulary-lint,
 * "because one-sided nicknames may live here, from both directions".
 *
 * WHICH IS EXACTLY WHY NOTHING IS DRAFTED HERE. Model-written aliases would be
 * the one string in a scaffold that no lint ever reads — unlinted text walking
 * past the only check that catches bad vocabulary. So this returns a COPY, not
 * a composition: the display citation, verbatim, in both languages (a Spanish
 * speaker searching for this bill types "S. 3172" too — the draft prompt keeps
 * citations in their English form for the same reason).
 *
 * IT IS A PLACEHOLDER, AND THE ISSUE SAYS SO. Real aliases are the words the
 * press and the public use for a fight ("shutdown", "strikes on iran"), which
 * is knowledge a person has and a record does not. The citation is what can be
 * derived without inventing anything.
 *
 * WHY NOT AN EMPTY LIST: lib/moments-gate.mjs requires a NON-EMPTY array of
 * strings per language (`isStringArray`), so `{ en: [], es: [] }` — the
 * correct shape with empty values — is itself two violations. Between weakening
 * a shipped CI gate to fit a scaffold and deriving one real search term, the
 * gate wins. The lint runs over the copied citation anyway, below, because
 * "this string cannot possibly be dirty" is exactly the reasoning that ends
 * with a dirty string.
 *
 * @returns {{ aliases: { en: string[], es: string[] }, note: string | null }}
 */
export function aliasesFor(c) {
  const citation = String(c?.citation ?? '').trim();
  if (!citation) {
    return {
      aliases: { en: [], es: [] },
      note: '**`aliases` is empty and needs you.** The candidate carries no citation to copy, and nothing else on the record is a search term. Add the words people actually use for this question, in both languages.',
    };
  }
  const dirty = [...new Set(['en', 'es'].flatMap((lang) => lintForbidden(citation, lang)))];
  if (dirty.length) {
    return {
      aliases: { en: [], es: [] },
      note: `**\`aliases\` is empty and needs you.** The citation "${citation}" trips the forbidden-vocabulary lint (${dirty.join(', ')}), so it was not copied in. Add search terms yourself, in both languages.`,
    };
  }
  return {
    aliases: { en: [citation], es: [citation] },
    note: `\`aliases\` carries only the citation, copied from the record so the entry is valid — the gate requires a non-empty list per language. It is a placeholder: aliases are what a person TYPES ("shutdown", "strikes on iran"), and those words are yours, not the record's. Nothing here is AI-written, on purpose — aliases are the one field the vocabulary lint never reads.`,
  };
}

/* ------------------------------------------------------------------ *
 * the moment id
 * ------------------------------------------------------------------ */

/** Lowercase kebab, ASCII-only — the shape lib/moments-gate.mjs's ID_RE wants. */
export function kebab(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A moment id CANDIDATE from the drafted English name.
 *
 * The rule — kebab, drop a leading "the", drop a trailing "question" —
 * is not invented: it was read off the file back when names carried the
 * "The <subject> question" wrapper, and it reproduced both live ids from
 * their own names exactly. The wrapper was retired 2026-08-09 (names are
 * bare noun phrases now; draft prompt v2), which makes both strips no-ops
 * on a compliant draft — they are KEPT deliberately, so an old-style draft
 * still derives the same id instead of a `the-…-question` near-duplicate.
 * tests/moment-scaffold.unit.spec.ts pins both shapes.
 *
 * COLLISIONS MATTER MORE THAN THEY LOOK. Two entries with the same key in one
 * JSON object do not error — the last one silently REPLACES the first, so a
 * colliding id pasted into data/moments.json would delete a live Big Question
 * and pass every gate. `taken` is the existing key set; a hit gets the vehicle
 * slug appended and a note.
 *
 * @param {string} nameEn      the drafted name, or '' when nothing was drafted
 * @param {string} vehicleSlug the candidate's slug, the blank-path fallback
 * @param {Set<string>} taken  ids already in data/moments.json
 * @returns {{ id: string, derived: boolean, collided: boolean }}
 */
export function momentIdFor(nameEn, vehicleSlug, taken = new Set()) {
  const fallback = kebab(vehicleSlug) || 'candidate';
  let id = kebab(nameEn).replace(/^the-/, '').replace(/-question$/, '');
  const derived = id.length > 0;
  if (!derived) id = `question-${fallback}`;
  const collided = taken.has(id);
  if (collided) id = `${id}-${fallback}`;
  return { id, derived, collided };
}

/* ------------------------------------------------------------------ *
 * the whole structure
 * ------------------------------------------------------------------ */

/**
 * The zero value — the screaming placeholder, for any caller that renders a
 * scaffold without deriving one. Kept deliberately INVALID (see PLACEHOLDER_ID)
 * so a missed wiring fails the gate instead of shipping a valid-looking entry.
 *
 * @param {string[]} [notes]
 * @returns {{ id: string, category: string, aliases: { en: string[], es: string[] },
 *             signal: { type: string, refs: string[] }, opened: string,
 *             review_by: string, notes: string[], gaps: string[] }}
 */
export function blankStructure(notes = []) {
  return {
    id: PLACEHOLDER_ID,
    category: '',
    aliases: { en: [], es: [] },
    signal: { type: '', refs: [] },
    opened: '',
    review_by: '',
    notes,
    gaps: ['id', 'category', 'aliases', 'qualifying_signal', 'opened', 'review_by'],
  };
}

/**
 * Everything in a scaffold that is not a sentence.
 *
 * `gaps` lists the fields that are still empty — the machine-readable half of
 * `notes`, and what the test suite filters on to find a candidate whose
 * structure is complete. A field is in `gaps` if and only if pasting the
 * scaffold would produce a violation for it.
 *
 * @param {Record<string, any>} c  one entry of buildReport().candidates
 * @param {Record<string, any>} [bill] its data/bills.json row (for issue_tags)
 * @param {{ now?: number, articles?: object[], takenIds?: Set<string>, nameEn?: string }} [opts]
 *        `nameEn` is the DRAFTED name, so this must be computed after drafting;
 *        with drafting off it is '' and the id falls back to a placeholder that
 *        is still a valid kebab slug — the blank scaffold must fail on prose
 *        and nothing else.
 */
export function structureFor(c, bill, { now = Date.now(), articles = [], takenIds = new Set(), nameEn = '' } = {}) {
  const notes = [];
  const gaps = [];

  const { category, note: categoryNote } = categoryFor(bill);
  if (categoryNote) {
    notes.push(categoryNote);
    gaps.push('category');
  }

  /* The bill row is here and the candidate object is not, so this is the one
     place that can hand signalFor the record sentence its floor-action
     derivation reads. Absent (no row, no text) it degrades to the empty box. */
  const { signal, note: signalNote } = signalFor(c, articles, {
    now,
    lastActionText: bill?.last_action_text ?? null,
  });
  if (!SIGNAL_TYPES.includes(signal.type) || signal.refs.length === 0) gaps.push('qualifying_signal');

  const { aliases, note: aliasNote } = aliasesFor(c);
  if (!aliases.en.length || !aliases.es.length) gaps.push('aliases');

  const opened = isoDay(now);
  const review_by = reviewByFor(opened);
  const { id, derived, collided } = momentIdFor(nameEn, c?.slug, takenIds);

  if (signalNote) notes.push(signalNote);
  if (aliasNote) notes.push(aliasNote);

  notes.push(
    derived
      ? `The id \`${id}\` is a SUGGESTION, kebabed from the drafted name — rename it to whatever you would type in a URL. It is the moment's permanent address (\`/questions/${id}\`), so it is worth a second of thought.`
      : `The id \`${id}\` is a placeholder — no name was drafted, so there was nothing to derive one from. Rename it before merging; it becomes the permanent address \`/questions/${id}\`.`
  );
  if (collided) {
    notes.push(
      `**That id already existed in \`data/moments.json\`, so the vehicle slug was appended.** Two entries with the same key do not error — the second silently replaces the first — so the collision is called out here rather than left to delete a live question quietly.`
    );
  }
  notes.push(
    `\`opened\` is today and \`review_by\` is 30 days out (${opened} → ${review_by}), the interval both live moments use. Shorten it if this one will move faster than that.`
  );
  notes.push(
    '`context_refs` is omitted rather than empty: it is optional, hand-curated, and host-allowlisted to CRS/CBO/GAO. Add one if you have a report worth linking — an empty array is a claim of grounding with no ground, which is why the old scaffold failed on it.'
  );

  return { id, category, aliases, signal, opened, review_by, notes, gaps };
}

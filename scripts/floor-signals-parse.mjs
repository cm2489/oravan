/**
 * Pure parsing + judgement for data/floor-signals.json — the T0 ANNOUNCED
 * rung of the docket ladder. Same split as newsdesk.mjs / newsdesk-match.mjs:
 * scripts/floor-signals.mjs does the network and the file write, everything
 * here is a plain string/data transform with ZERO network, ZERO fs and ZERO
 * secrets, so tests/floor-signals.unit.spec.ts can exercise the whole design
 * against committed fixtures.
 *
 * ---- WHAT T0 IS -----------------------------------------------------------
 * The chamber itself, in its own published words, naming a measure for floor
 * action that has not happened yet. Two sources, both free, both the
 * government's own record:
 *
 *   billsthisweek  docs.house.gov/billsthisweek/{Monday}/{Monday}.xml — the
 *                  House's weekly floor schedule. Carries the structure A-2
 *                  demands: <category type="Items that may be considered
 *                  under suspension of the rules"> vs "…pursuant to a rule".
 *   daily-digest   The Senate's "Program for {Weekday}:" block in the Daily
 *                  Digest of the Congressional Record, reached through the
 *                  Congress.gov daily-congressional-record API (list ->
 *                  issue detail -> the Daily Digest section's Formatted Text
 *                  URL). Measured hold rate over 2026-07-27..08-10: every
 *                  corpus-eligible measure the Senate program named saw floor
 *                  action within the next 2 Senate session days (12/12; 11 of
 *                  them on the very next session day).
 *
 * ---- WHAT THIS FILE MAY NEVER DO -----------------------------------------
 * 1. TRANSLATE A QUOTE. `quote` is English verbatim from the record, always
 *    (owner ruling V4). A Spanish surface frames the quote in Spanish and
 *    prints the English sentence unchanged; a translated quote is a
 *    paraphrase wearing quotation marks.
 * 2. SYNTHESIZE A DATE. Every date stored here is either printed by the
 *    source (`published`, `covers_label`) or derived from one with the year
 *    filled in from the issue's own date (`covers`) — and the verbatim label
 *    is stored beside the derived value so a reader can check it.
 * 3. LET A NOMINATION ENTER THE BILL LADDER. The Senate program is dominated
 *    by executive-calendar nominations. Owner ruling V3: they route to the
 *    nominations path or they are dropped with a logged reason. They live in
 *    a separate top-level map here so "a nomination in the bill ladder" is
 *    unrepresentable, not merely unlikely.
 *
 * ---- HOW A CONSUMER READS source_status (critic A-5) ---------------------
 * A 404 during a recess and a 404 because the URL scheme rotted look
 * identical, and AP's RSS died exactly that way. So every source's status is
 * cross-checked against an INDEPENDENT in-session signal before it may read
 * as quiet:
 *
 *   ok          the source answered and named measures — render them
 *   quiet       the source (or its cross-check) says the chamber is not
 *               meeting — the ONLY status that may render "no floor schedule
 *               was published this week"
 *   data_stale  the source is silent WHILE the other source shows the chamber
 *               in session — treat as a data outage, never as a quiet week
 *   error       the fetch or the parse failed outright
 *   unknown     silent, and nothing independent can say whether Congress is
 *               meeting — honest, and it is not "quiet"
 *
 * Only `ok` and `quiet` are statements about Congress. The other three are
 * statements about us, and lib/freshness-state.ts's data_stale posture is
 * where they belong.
 */
import { isTerminalNominationStatus } from '../lib/nomination-status.mjs';
import { TERMINAL_STATUSES } from '../lib/urgency.mjs';
import { findCitations } from './newsdesk-match.mjs';

export const FLOOR_SIGNALS_PATH = 'data/floor-signals.json';
export const FLOOR_SIGNALS_SCHEMA = 'floor-signals/v1';

/** A T0 quote is one announcement of the record, not a page of it — the
 *  ceiling is a tripwire on a parse that lost its bearings, not a style
 *  budget. Measured over the ten session-day digests of 2026-07-27..08-10:
 *  the longest program paragraph is 555 characters (2026-07-29, four
 *  announcements the digest ran together in one block) and the longest quote
 *  actually stored after splitting is 412 — the two war-powers conditionals
 *  of that same day, which stay together because the boundary between them
 *  sits after "11:30 a.m." and splitProgramSentences will not cut on an
 *  abbreviation. 900 leaves room for a wordier week without ever admitting a
 *  whole section. */
export const QUOTE_MAX_CHARS = 900;

/** How long a signal may be carried forward while its source is dark. The
 *  file is committed (owner ruling V5), so a source that breaks on a Friday
 *  would otherwise keep asserting Friday's schedule all week. Three days is
 *  past a weekend gap and short of a stale claim. */
export const CARRY_FORWARD_MAX_DAYS = 3;

/** Re-confirmation stamp ceiling, in hours. The file is only rewritten when
 *  its CONTENT changes — an hourly cron must never become an hourly deploy
 *  (newsdesk.yml's own rule) — but A-1's "as of {time}" copy needs a stamp
 *  that isn't days old while the schedule genuinely hasn't moved. So a run
 *  that finds no change still rewrites the stamp once the stored one is this
 *  old, AND only while at least one live signal exists: a recess week, where
 *  the file is empty and nothing is being claimed, produces no writes at all. */
export const STAMP_MAX_AGE_HOURS = 6;

// ---- HTML -> text --------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', sect: '§',
};

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * The Daily Digest's Formatted Text page is HTML, not a <pre> block: the
 * program sentences arrive as `<p>`-separated runs inside `<strong>`/`<center>`
 * markup, and the headings that identify which chamber a program belongs to
 * are `<center><strong>SENATE</strong></center>`. Turning the whole document
 * into line-per-paragraph text FIRST means every rule below is a rule about
 * sentences, not about tags — the markup can drift without silently changing
 * which sentence we quote.
 *
 * Verified against the live pages for issues 122-131 (2026-07-27..08-10).
 *
 * @param {string} html
 * @returns {string}
 */
export function digestToText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|center|h[1-6]|tr|li)>/gi, '\n')
      .replace(/<(p|div|center|h[1-6]|tr|li)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

const CHAMBER_HEADINGS = [
  { chamber: 'senate', re: /^SENATE$/ },
  { chamber: 'house', re: /^HOUSE OF REPRESENTATIVES$/ },
];

// A program block ends where the digest's next structural heading begins.
// "Next Meeting of the" opens the other chamber's block; the rest are the
// document's own tail sections. The last alternative is a printer's rule —
// govinfo's per-page granules close every section with a run of underscores,
// and swallowing one into a program block silently breaks the pro-forma test
// (every sentence must be pro forma, and a rule is not a sentence).
const PROGRAM_TERMINATOR =
  /^(Next Meeting of the|Extensions of Remarks|\[Page:|\[\[Page|COMMITTEE MEETINGS|Chamber Action|Committee Meetings|[_\-–—]{5,}\s*$)/i;

const WEEKDAY = '(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day';
const MONTH =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const MEETING_DATE_RE = new RegExp(`(${WEEKDAY}),\\s+(${MONTH})\\s+(\\d{1,2})`, 'i');

/**
 * Split the digest text into each chamber's "Next Meeting / Program for"
 * block. The heading is the selector, not a substring guess: the digest
 * prints `Next Meeting of the` / `SENATE` / `{time}, {Weekday}, {Month} {D}` /
 * `Senate Chamber` / `Program for {Weekday}: …`, in that order, every issue
 * tested. The probe's cheaper fallback — "the first Program-for block whose
 * opening words mention the Senate" — is kept for the day the headings move,
 * because a block we can still attribute is better than no T0 at all.
 *
 * Returns `{senate, house}`, each `{ label, meetingLabel, lines, proForma }`
 * or null.
 *
 * @param {string} text
 * @returns {{ senate: any, house: any }}
 */
export function parseProgramBlocks(text) {
  const lines = String(text ?? '').split('\n');
  const out = { senate: null, house: null };
  for (let i = 0; i < lines.length; i++) {
    if (!/^Next Meeting of the/i.test(lines[i])) continue;
    // congress.gov's whole-digest page centres the chamber name on its own
    // line ("Next Meeting of the" / "SENATE"); govinfo's per-page granule
    // prints it on one ("Next Meeting of the SENATE"). Both are the same
    // heading, so both are read.
    const inline = lines[i].replace(/^Next Meeting of the\s*/i, '').trim();
    const heading =
      CHAMBER_HEADINGS.find((h) => h.re.test(inline)) ??
      CHAMBER_HEADINGS.find((h) => h.re.test(lines[i + 1] ?? ''));
    if (!heading) continue;
    let meetingLabel = null;
    let start = -1;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      if (meetingLabel === null && MEETING_DATE_RE.test(lines[j])) meetingLabel = lines[j];
      if (/^Program for\b/i.test(lines[j])) { start = j; break; }
    }
    if (start === -1) continue;
    const body = [];
    for (let j = start; j < lines.length; j++) {
      if (j > start && PROGRAM_TERMINATOR.test(lines[j])) break;
      body.push(lines[j]);
    }
    // The first line carries the "Program for Wednesday:" label. The label is
    // the digest's own heading for the block, not part of what the chamber
    // announced, so it is stored separately and never quoted as a sentence.
    const labelMatch = /^(Program for [^:]*:)\s*(.*)$/i.exec(body[0] ?? '');
    const label = labelMatch ? labelMatch[1] : null;
    const first = labelMatch ? labelMatch[2] : body[0] ?? '';
    const sentences = [first, ...body.slice(1)].map((s) => s.trim()).filter(Boolean);
    out[heading.chamber] = {
      label,
      meetingLabel,
      lines: sentences,
      proForma: sentences.length > 0 && sentences.every((s) => /pro forma/i.test(s)),
    };
  }
  if (!out.senate) {
    // Fallback: no recognizable headings. Take Program-for blocks in document
    // order and attribute by the block's own opening words (the probe's
    // measured selector: every digest yields exactly two, Senate first).
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^Program for\b/i.test(lines[i])) continue;
      const body = [lines[i]];
      for (let j = i + 1; j < lines.length && !PROGRAM_TERMINATOR.test(lines[j]) && !/^Program for\b/i.test(lines[j]); j++) {
        body.push(lines[j]);
      }
      blocks.push(body);
    }
    for (const body of blocks) {
      const labelMatch = /^(Program for [^:]*:)\s*(.*)$/i.exec(body[0] ?? '');
      const label = labelMatch ? labelMatch[1] : null;
      const first = labelMatch ? labelMatch[2] : body[0] ?? '';
      const sentences = [first, ...body.slice(1)].map((s) => s.trim()).filter(Boolean);
      const head = sentences.join(' ').slice(0, 120);
      const chamber = /senate/i.test(head) ? 'senate' : /house/i.test(head) ? 'house' : null;
      if (!chamber || out[chamber]) continue;
      out[chamber] = {
        label,
        meetingLabel: null,
        lines: sentences,
        proForma: sentences.length > 0 && sentences.every((s) => /pro forma/i.test(s)),
      };
    }
  }
  return out;
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * "10:30 a.m., Wednesday, August 5" + the issue's own date -> 2026-08-05.
 *
 * The digest prints no year, so the year is FILLED IN from the issue date —
 * the one derivation in this module. It is a derivation, not a guess: the
 * next meeting is days away, so the only ambiguity is the December->January
 * rollover, which is resolved by taking whichever year puts the meeting
 * within [issue - 2 days, issue + 200 days]. The verbatim label travels with
 * the derived date everywhere (`covers_label`) so the reader can check it.
 *
 * @param {string | null | undefined} meetingLabel
 * @param {string} issueDate
 * @returns {string | null}
 */
export function resolveMeetingDate(meetingLabel, issueDate) {
  const m = MEETING_DATE_RE.exec(String(meetingLabel ?? ''));
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  const day = Number(m[3]);
  const issueMs = Date.parse(`${issueDate}T00:00:00Z`);
  if (month < 0 || !Number.isFinite(day) || !Number.isFinite(issueMs)) return null;
  const issueYear = new Date(issueMs).getUTCFullYear();
  for (const year of [issueYear, issueYear + 1, issueYear - 1]) {
    const cand = Date.UTC(year, month, day);
    const deltaDays = (cand - issueMs) / 86_400_000;
    if (deltaDays >= -2 && deltaDays <= 200) return new Date(cand).toISOString().slice(0, 10);
  }
  return null;
}

// ---- Senate program -> signals ------------------------------------------

/**
 * How sure the chamber's own sentence is that a vote happens. NOT a
 * probability and NOT a claim about the outcome — it is which VERB the Senate
 * used, kept as a field so the ladder can rank an announced vote above a
 * conditional one (critic A-2's requirement, in the Senate's dialect: the
 * House distinguishes rule-bills from suspensions structurally, the Senate
 * distinguishes them in the sentence).
 *
 * @param {string} sentence
 * @returns {'scheduled_vote' | 'consideration' | 'conditional'}
 */
export function programCertainty(sentence) {
  const s = String(sentence ?? '');
  if (/^\s*if\b/i.test(s) || /\bIf (?:Senator|the )/i.test(s)) return 'conditional';
  if (/will vote on/i.test(s)) return 'scheduled_vote';
  return 'consideration';
}

/** Is this measure already finally disposed of, as of the digest's own date?
 *  The measured miss class: a program sentence citing a resolution that was
 *  agreed to weeks ago because it is the standing order the day's business
 *  runs under ("provided under the provisions of S. Res. 817"). Naming it is a
 *  citation, not a schedule. *
 * @param {any} bill
 * @param {string} asOfDate
 * @returns {boolean}
 */
export function alreadyDisposed(bill, asOfDate) {
  if (!bill) return false;
  if (!TERMINAL_STATUSES.has(bill.status)) return false;
  const last = bill.last_action_date;
  return typeof last === 'string' && typeof asOfDate === 'string' && last <= asOfDate;
}

// Abbreviations the digest ends "words" with that are NOT ends of sentences.
// "S.J. Res. 199" and "11:30 a.m." both put a period before a capital letter,
// which is the only structural signal a splitter has.
const ABBREV_TAIL =
  /(?:\b[A-Z]|\bRes|\bNo|\bCon|\bRept|\bJr|\bSr|\bMr|\bMrs|\bMs|\bDr|\bSt|\bSen|\bRep|\bvs|\betc|\ba\.m|\bp\.m|\bU\.S)\.$/i;

/**
 * Split one program block line into the announcements it actually contains.
 *
 * The digest usually gives each announcement its own paragraph, and then
 * occasionally does not: 2026-07-29 ran four sentences together, so quoting
 * the paragraph would have printed 555 characters — two of them about other
 * measures — under a crown about S.J.Res. 199.
 *
 * FAIL-CLOSED, because a mis-split quote is worse than a long one: a boundary
 * is taken only after a period followed by whitespace and a capital, never
 * after a known abbreviation, and if ANY resulting fragment fails to look
 * like a whole announcement (does not end in a period, or is implausibly
 * short) the whole line is returned unsplit. A long verbatim quote is still
 * true; half a sentence is not.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function splitProgramSentences(line) {
  const text = String(line ?? '').trim();
  if (!text) return [];
  const parts = [];
  let buf = '';
  for (const piece of text.split(/(?<=\.)\s+(?=[A-Z])/)) {
    buf = buf ? `${buf} ${piece}` : piece;
    if (ABBREV_TAIL.test(buf)) continue; // the period belonged to an abbreviation
    parts.push(buf);
    buf = '';
  }
  if (buf) parts.push(buf);
  const clean = parts.map((p) => p.trim()).filter(Boolean);
  if (clean.length <= 1) return [text];
  if (clean.some((p) => !p.endsWith('.') || p.length < 40)) return [text];
  return clean;
}

const NOMINATION_RE = /\bnomination(?:s)?\b/i;

/**
 * Route one Senate-program sentence that is about a nomination (owner ruling
 * V3). Two handles, both from the record:
 *   - "Executive Calendar #123" / "Calendar No. 123" -> exec_calendar_number
 *   - "the nomination of Erica Schwartz, of Florida, to be Director of …"
 *     -> the nominee's name against `nominee_description`
 * En-bloc sentences ("the en bloc nominations, provided under the provisions
 * of S. Res. 817") name no nominee and route to nothing — they are dropped
 * with a reason, never guessed at.
 *
 * @param {string} sentence
 * @param {any[]} nominations
 * @returns {{ citation: string, matchedOn: string } | null}
 */
export function routeNomination(sentence, nominations) {
  const s = String(sentence ?? '');
  const calendar = /(?:Executive Calendar\s*#?|Calendar\s+No\.?\s*)(\d{1,4})/i.exec(s);
  if (calendar) {
    const n = (nominations ?? []).find(
      (x) => String(x.exec_calendar_number ?? '') === String(Number(calendar[1]))
    );
    if (n) return { citation: n.citation, matchedOn: 'exec_calendar_number' };
  }
  // "nomination of {Name}, of {State}, to be {Office}" — the digest's fixed
  // phrasing, and Congress.gov writes `nominee_description` in exactly the
  // same order, so the name matches the head of the description.
  const named = /nomination of ([A-Z][^,]{1,60}?),\s+of\s+[A-Z]/.exec(s);
  if (!named) return null;
  const name = named[1].trim().toLowerCase();
  let hits = (nominations ?? []).filter((x) =>
    String(x.nominee_description ?? '').toLowerCase().startsWith(`${name},`)
  );
  if (hits.length === 0) return null;
  if (hits.length > 1) {
    // The same person is nominated more than once — Walter Clayton holds four
    // records in the corpus (US Attorney twice, DNI once). The digest names
    // the OFFICE in the same sentence, so use it rather than guess: "to be
    // Director of National Intelligence" appears verbatim in the description.
    const office = /\bto be ([^,.]{3,80})/i.exec(s.slice(named.index));
    if (office) {
      const needle = office[1].trim().toLowerCase();
      const byOffice = hits.filter((x) =>
        String(x.nominee_description ?? '').toLowerCase().includes(needle)
      );
      if (byOffice.length > 0) hits = byOffice;
    }
  }
  if (hits.length > 1) {
    // Still tied: the same person, the same office, renominated in a later
    // session. The digest is announcing a vote, so a nomination the Senate has
    // already disposed of is not the one being scheduled.
    const live = hits.filter((x) => !isTerminalNominationStatus(x.status));
    if (live.length > 0) hits = live;
  }
  // A tie past both discriminators is ambiguity, and the digest gives nothing
  // else to break it with, so nothing is routed — the same discipline the
  // nickname bridge keeps, and owner ruling V3's "dropped with a logged
  // reason" rather than a guess.
  if (hits.length === 1) return { citation: hits[0].citation, matchedOn: 'nominee_name' };
  return null;
}

/**
 * Turn one chamber's program block into T0 items.
 *
 * `bySlug` is the corpus (a Map slug -> bill) and is used ONLY to drop
 * already-disposed measures; a measure not in the corpus is still recorded —
 * it is the record, and the bill may arrive on a later sync.
 *
 * @param {{ label: string | null, meetingLabel: string | null, lines: string[], proForma: boolean } | null} program
 * @param {{ issueDate?: string, url?: string, covers?: string | null, coversLabel?: string | null, bySlug?: Map<string, any>, nominations?: any[] }} [ctx]
 * @returns {{ items: any[], dropped: any[] }}
 */
export function parseSenateProgram(program, ctx) {
  const { issueDate, url, covers, coversLabel, bySlug = new Map(), nominations = [] } = ctx ?? {};
  const items = [];
  const dropped = [];
  const seen = new Set();
  const sentences = (program?.lines ?? []).flatMap((line) => splitProgramSentences(line));
  for (const sentence of sentences) {
    const quote = sentence.length > QUOTE_MAX_CHARS ? null : sentence;
    const citations = findCitations(sentence);
    if (citations.length > 0) {
      for (const c of citations) {
        if (seen.has(c.slug)) continue;
        if (alreadyDisposed(bySlug.get(c.slug), issueDate)) {
          dropped.push({ source: 'daily-digest', reason: 'already_disposed', slug: c.slug, text: sentence.slice(0, 160) });
          continue;
        }
        if (!quote) {
          dropped.push({ source: 'daily-digest', reason: 'no_quote', slug: c.slug, text: sentence.slice(0, 160) });
          continue;
        }
        seen.add(c.slug);
        items.push({
          kind: 'bill',
          slug: c.slug,
          tier0: {
            source: 'daily-digest',
            chamber: 'senate',
            quote,
            quote_lang: 'en',
            quote_kind: 'digest_program_sentence',
            url,
            published: issueDate,
            covers: covers ?? null,
            covers_label: coversLabel ?? null,
            track: 'unspecified',
            certainty: programCertainty(sentence),
          },
        });
      }
      continue;
    }
    if (NOMINATION_RE.test(sentence)) {
      const routed = quote ? routeNomination(sentence, nominations) : null;
      if (!routed) {
        dropped.push({
          source: 'daily-digest',
          reason: quote ? 'nomination_unroutable' : 'no_quote',
          text: sentence.slice(0, 160),
        });
        continue;
      }
      if (seen.has(routed.citation)) continue;
      seen.add(routed.citation);
      items.push({
        kind: 'nomination',
        citation: routed.citation,
        matchedOn: routed.matchedOn,
        tier0: {
          source: 'daily-digest',
          chamber: 'senate',
          quote,
          quote_lang: 'en',
          quote_kind: 'digest_program_sentence',
          url,
          published: issueDate,
          covers: covers ?? null,
          covers_label: coversLabel ?? null,
          track: 'unspecified',
          certainty: programCertainty(sentence),
        },
      });
    }
    // Everything else — morning business, adjournment resolutions, untracked
    // simple resolutions — is not a measure this build tracks. Silent by
    // design: a dropped line for every routine sentence would bury the two
    // reasons that matter above.
  }
  return { items, dropped };
}

// ---- billsthisweek -> signals -------------------------------------------

/**
 * The House's own section headings, mapped to the ladder's ordering marker
 * (critic A-2). A suspension-calendar bill and a bill made in order by a rule
 * are both "scheduled", and treating them as one tier is what lets a
 * post-office renaming outrank a continuing resolution on a same-date tie.
 * Unknown headings map to `unspecified` rather than guessing.
 *
 * @param {string | null | undefined} categoryType
 * @returns {'rule' | 'suspension' | 'unspecified'}
 */
export function trackFromCategory(categoryType) {
  const t = String(categoryType ?? '').toLowerCase();
  if (t.includes('suspension')) return 'suspension';
  if (t.includes('pursuant to a rule')) return 'rule';
  return 'unspecified';
}

const attr = (tag, name) => {
  const m = new RegExp(`${name}="([^"]*)"`, 'i').exec(tag);
  return m ? m[1] : null;
};

/**
 * Parse docs.house.gov's weekly floorschedule XML into T0 items, keeping the
 * document's own structure:
 *   <category type="Items that may be considered pursuant to a rule">
 *     <floor-item publish-date=… remove-date=…>
 *       <legis-num>H.R. 2715</legis-num><floor-text>…, as amended</floor-text>
 *
 * `remove-date` is honored: a non-empty one is the House saying it pulled the
 * item, which is exactly the mid-week churn A-1 refuses to keep crowning.
 * Only `<legis-num>` is scanned for bill numbers — `<floor-text>` cites other
 * measures in passing, the same rule extractBillsThisWeekSlugs already keeps.
 *
 * @param {string} xml
 * @param {{ url?: string, weekOf?: string }} [ctx]
 * @returns {{ items: any[], dropped: any[], weekDate: string | null }}
 */
export function parseBillsThisWeek(xml, ctx) {
  const { url, weekOf } = ctx ?? {};
  const src = String(xml ?? '');
  const items = [];
  const dropped = [];
  const seen = new Set();
  const weekDate = attr(src.slice(0, 400), 'week-date') ?? weekOf ?? null;
  for (const cat of src.matchAll(/<category\b([^>]*)>([\s\S]*?)<\/category>/gi)) {
    const track = trackFromCategory(attr(cat[1], 'type'));
    const announcement = decodeEntities(attr(cat[1], 'type') ?? '').trim() || null;
    for (const item of cat[2].matchAll(/<floor-item\b([^>]*)>([\s\S]*?)<\/floor-item>/gi)) {
      const removeDate = attr(item[1], 'remove-date');
      const publishDate = attr(item[1], 'publish-date');
      const body = item[2];
      const legis = /<legis-num\b[^>]*>([\s\S]*?)<\/legis-num>/i.exec(body);
      if (!legis) continue;
      const floorText = /<floor-text\b[^>]*>([\s\S]*?)<\/floor-text>/i.exec(body);
      const quote = decodeEntities(floorText?.[1] ?? '').replace(/\s+/g, ' ').trim();
      for (const c of findCitations(decodeEntities(legis[1]))) {
        if (removeDate) {
          dropped.push({ source: 'billsthisweek', reason: 'removed_from_schedule', slug: c.slug, text: removeDate });
          continue;
        }
        if (seen.has(c.slug)) continue;
        if (!quote || quote.length > QUOTE_MAX_CHARS) {
          dropped.push({ source: 'billsthisweek', reason: 'no_quote', slug: c.slug, text: quote.slice(0, 160) });
          continue;
        }
        seen.add(c.slug);
        items.push({
          kind: 'bill',
          slug: c.slug,
          tier0: {
            source: 'billsthisweek',
            chamber: 'house',
            quote,
            quote_lang: 'en',
            quote_kind: 'floor_text',
            announcement,
            url: url ?? null,
            published: publishDate ? publishDate.slice(0, 10) : weekDate,
            covers: weekDate,
            covers_label: null,
            track,
            certainty: 'consideration',
          },
        });
      }
    }
  }
  return { items, dropped, weekDate };
}

// ---- govinfo fallback ----------------------------------------------------

/**
 * Pick the Daily Digest granule that carries the "Program for" text out of a
 * govinfo package granule list.
 *
 * The shape difference that makes this necessary: congress.gov serves the
 * WHOLE digest as one document, govinfo splits it per printed page — and the
 * program is never on the digest's first page (PgD807 for 2026-08-04 answers
 * 200 with no "Program for" in it at all; the text lives on PgD809). The
 * granule's own title names the section, so the selector is the title, not a
 * page-number guess: "Daily Digest/Next Meeting of the SENATE + Next Meeting
 * of the HOUSE OF REPRESENTATIVES + Other End Matter". Verified live
 * 2026-08-12 against CREC-2026-08-04 (62 granules).
 *
 * @param {any} granules
 * @returns {string | null}
 */
export function selectDigestGranule(granules) {
  const list = Array.isArray(granules) ? granules : (granules?.granules ?? []);
  const hit = list.find(
    (g) => /DAILYDIGEST/i.test(String(g?.granuleClass ?? '')) && /Next Meeting of the SENATE/i.test(String(g?.title ?? ''))
  );
  return hit?.granuleId ?? null;
}

/** The no-key, no-UA HTML URL for one granule (verified live 2026-08-12). *
 * @param {string} packageId
 * @param {string} granuleId
 * @returns {string}
 */
export function govinfoGranuleHtmlUrl(packageId, granuleId) {
  return `https://www.govinfo.gov/content/pkg/${packageId}/html/${granuleId}.htm`;
}

// ---- source_status (critic A-5) -----------------------------------------

/**
 * `outcome` is what the fetch did: 'ok' (answered, named measures), 'empty'
 * (answered, named none), 'missing' (an allowed 404), 'error' (anything else).
 * `selfEvidentQuiet` is the source telling us itself that the chamber is not
 * meeting ("Senate will meet in a pro forma session"). `crossCheck` is the
 * OTHER source's verdict on whether Congress is meeting at all.
 *
 * The asymmetry is deliberate: only POSITIVE evidence ("the other source
 * named measures") counts as in_session. Two dark sources produce `unknown`,
 * never `quiet` — that is the whole point of the cross-check.
 *
 * @param {{ outcome: 'ok' | 'empty' | 'missing' | 'error', selfEvidentQuiet?: boolean, crossCheck?: 'in_session' | 'out_of_session' | 'unknown' }} input
 * @returns {'ok' | 'quiet' | 'data_stale' | 'error' | 'unknown'}
 */
export function deriveSourceStatus({ outcome, selfEvidentQuiet = false, crossCheck = 'unknown' }) {
  if (outcome === 'ok') return 'ok';
  if (outcome === 'error') return 'error';
  if (selfEvidentQuiet) return 'quiet';
  if (crossCheck === 'in_session') return 'data_stale';
  if (crossCheck === 'out_of_session') return 'quiet';
  return 'unknown';
}

/** The digest's own read on whether a chamber is meeting, used as the
 *  cross-check for the other source. `pro forma` is Congress saying "we are
 *  gaveling in and out"; a program with real business is in_session. *
 * @param {any} program
 * @returns {'in_session' | 'out_of_session' | 'unknown'}
 */
export function sessionFromProgram(program) {
  if (!program || !Array.isArray(program.lines) || program.lines.length === 0) return 'unknown';
  if (program.proForma) return 'out_of_session';
  return 'in_session';
}

// ---- merge / write policy ------------------------------------------------

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Fold this run's fetched items into the previous committed file.
 *
 * THE A-1 RULE, and the only rule that matters here: when a source answers,
 * its signals are REPLACED wholesale from that answer. A bill pulled from the
 * schedule stops being a signal the same hour, rather than living on because
 * it was true on Monday. When a source does NOT answer, its previous signals
 * are carried forward and marked `stale: true` — a fetch failure must not
 * masquerade as Congress cancelling its own week — bounded by
 * CARRY_FORWARD_MAX_DAYS and by the announcement's own horizon (`covers`).
 *
 * @param {{ previous?: any, fetched?: any[], sourceStates?: Record<string, any>, now: number }} input
 * @returns {{ signals: Record<string, any>, nominations: Record<string, any> }}
 */
export function mergeSignals({ previous, fetched, sourceStates, now }) {
  const nowISO = new Date(now).toISOString();
  const today = ymd(now);
  const prevSignals = previous?.signals ?? {};
  const prevNoms = previous?.nominations ?? {};
  const answered = new Set(
    Object.entries(sourceStates ?? {})
      .filter(([, s]) => s.status === 'ok' || s.status === 'quiet')
      .map(([name]) => name)
  );

  const carry = (prevMap, freshKeys) => {
    const out = {};
    for (const [key, entry] of Object.entries(prevMap)) {
      const source = entry?.tier0?.source;
      if (freshKeys.has(key)) continue; // this run re-observed it; the fresh copy wins
      if (answered.has(source)) continue; // A-1: the source answered and did not name it
      const ageDays = (now - Date.parse(entry?.fetched_at ?? '')) / 86_400_000;
      if (!Number.isFinite(ageDays) || ageDays > CARRY_FORWARD_MAX_DAYS) continue;
      const covers = entry?.tier0?.covers;
      // A weekly schedule covers its week; a daily program covers its day.
      const horizonDays = entry?.tier0?.source === 'billsthisweek' ? 7 : 1;
      if (covers && Date.parse(`${covers}T00:00:00Z`) + horizonDays * 86_400_000 < Date.parse(`${today}T00:00:00Z`)) continue;
      out[key] = { ...entry, stale: true };
    }
    return out;
  };

  const freshSignals = {};
  const freshNoms = {};
  for (const item of fetched ?? []) {
    const key = item.kind === 'nomination' ? item.citation : item.slug;
    const target = item.kind === 'nomination' ? freshNoms : freshSignals;
    if (!key || target[key]) continue;
    const prev = (item.kind === 'nomination' ? prevNoms : prevSignals)[key];
    target[key] = {
      tier0: item.tier0,
      fetched_at: nowISO,
      first_seen: prev?.first_seen ?? nowISO,
      stale: false,
    };
  }

  return {
    signals: sortKeys({ ...carry(prevSignals, new Set(Object.keys(freshSignals))), ...freshSignals }),
    nominations: sortKeys({ ...carry(prevNoms, new Set(Object.keys(freshNoms))), ...freshNoms }),
  };
}

/** @param {Record<string, any>} obj @returns {Record<string, any>} */
function sortKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

/** Everything about the document EXCEPT its timestamps. Two runs that found
 *  the same schedule produce the same string here, which is what lets the
 *  writer stay silent instead of committing an identical file every hour. */
/** @param {any} doc @returns {string} */
export function materialFingerprint(doc) {
  const strip = (map) =>
    Object.fromEntries(
      Object.entries(map ?? {}).map(([k, v]) => [k, { tier0: v.tier0, stale: v.stale === true }])
    );
  return JSON.stringify({
    signals: strip(doc?.signals),
    nominations: strip(doc?.nominations),
    sources: Object.fromEntries(
      Object.entries(doc?._meta?.sources ?? {}).map(([k, v]) => [
        k,
        { status: v.status, detail: v.detail ?? null, url: v.url ?? null, published: v.published ?? null, covers: v.covers ?? null },
      ])
    ),
    in_session: doc?._meta?.in_session ?? null,
    dropped: doc?._meta?.dropped ?? [],
  });
}

/**
 * Should this run write the file at all?
 *
 * Yes when the content moved. Yes when the stored stamp has aged past
 * STAMP_MAX_AGE_HOURS *and* the file is actually claiming something (at least
 * one live signal) — that keeps A-1's "as of" honest without turning an
 * hourly cron into an hourly deploy. Otherwise no: an unchanged quiet week
 * writes nothing, exactly like an hourly newsdesk run that fired nothing.
 *
 * @param {{ previous: any, next: any, now: number }} input
 * @returns {boolean}
 */
export function shouldWrite({ previous, next, now }) {
  if (!previous) return true;
  if (materialFingerprint(previous) !== materialFingerprint(next)) return true;
  const live = Object.values(next?.signals ?? {}).some((s) => s.stale !== true);
  if (!live) return false;
  const stampAgeHours = (now - Date.parse(previous?._meta?.fetched_at ?? '')) / 3_600_000;
  return !Number.isFinite(stampAgeHours) || stampAgeHours >= STAMP_MAX_AGE_HOURS;
}

// ---- the re-decode trigger (design A6 + critic A-8) ----------------------

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Has the vehicle been swapped under the decode?
 *
 * The measured case is hr-6500-119: the corpus title (and the shipped decode)
 * says "AGOA Extension Act", while the document Congress is actually voting on
 * is the continuing resolution. Titles wobble constantly for innocent reasons
 * (", as amended", punctuation, a short title added), so equality alone would
 * burn decodes on noise: a swap is declared only when the two titles share
 * less than SWAP_SIMILARITY_FLOOR of their content words.
 */
export const SWAP_SIMILARITY_FLOOR = 0.5;

/**
 * @param {string | null | undefined} corpusTitle
 * @param {string | null | undefined} fetchedTitle
 * @returns {{ swapped: boolean, similarity: number }}
 */
export function titleDrift(corpusTitle, fetchedTitle) {
  const a = norm(corpusTitle);
  const b = norm(fetchedTitle);
  if (!a || !b) return { swapped: false, similarity: 1 };
  if (a === b) return { swapped: false, similarity: 1 };
  const at = new Set(a.split(' '));
  const bt = new Set(b.split(' '));
  let shared = 0;
  for (const t of at) if (bt.has(t)) shared++;
  const similarity = shared / Math.max(at.size, bt.size);
  return { swapped: similarity < SWAP_SIMILARITY_FLOOR, similarity: Math.round(similarity * 1000) / 1000 };
}

/**
 * Should this bill's decode be re-run? Pure, and deliberately conservative in
 * both directions.
 *
 * `stale-decode` — the decode predates the bill's own latest action, so the
 *   page is explaining a document the record has since moved past. Compared
 *   at DAY granularity: `decoded_at` is a timestamp and `last_action_date` is
 *   a date, and a same-day pair is not evidence of staleness in either
 *   direction. Under-triggering is the safe side of a spend gate.
 * `vehicle-swap` — the title we hold is not the title Congress is serving.
 * `null-decoded-at` (critic A-8) — the whole pre-2026-08-12 corpus has no
 *   `decoded_at`, and "unknown" must never read as "old": on day one every
 *   bill entering T0/T1 would otherwise queue a re-decode and eat the tier-0
 *   daily cap re-explaining decodes that were fine. A null decode stamp with
 *   a matching title is skipped, and gets its stamp the next time the bill is
 *   decoded for a reason of its own.
 *
 * @param {{ decodedAt?: string | null, lastActionDate?: string | null, corpusTitle?: string | null, fetchedTitle?: string | null }} input
 * @returns {{ redecode: boolean, reason: string, similarity?: number }}
 */
export function redecodeVerdict({ decodedAt, lastActionDate, corpusTitle, fetchedTitle }) {
  if (fetchedTitle && corpusTitle) {
    const drift = titleDrift(corpusTitle, fetchedTitle);
    if (drift.swapped) return { redecode: true, reason: 'vehicle-swap', similarity: drift.similarity };
  }
  if (!decodedAt) return { redecode: false, reason: 'null-decoded-at' };
  if (!lastActionDate) return { redecode: false, reason: 'no-last-action' };
  const decodedDay = String(decodedAt).slice(0, 10);
  if (decodedDay < String(lastActionDate)) return { redecode: true, reason: 'stale-decode' };
  return { redecode: false, reason: 'fresh-decode' };
}

/**
 * THE SPEND GATE FOR T1 — re-exported from lib/docket.mjs, which owns it.
 *
 * It shipped here first, one branch ahead of the ladder that consumes it, with
 * a private copy of FLOOR_SETTLED beside it. Both are gone: the ladder's T1
 * rung and this re-decode queue must mean the SAME thing by "close enough to
 * the floor", or the site would rank a bill it never bothered to re-read (and
 * the four-copies-of-one-regex problem is exactly what lib/floor-text.mjs was
 * created to end). Kept as a named re-export so this module's own callers and
 * tests/floor-signals.unit.spec.ts are unchanged.
 *
 * It stays deliberately WIDER than lib/journey.ts's `floorPendingChamber`, and
 * is not a substitute for it: journey's allow-list decides what the site may
 * SAY and is fail-closed, because a novel Senate sentence must cost a quiet
 * week rather than a false claim of urgency. This decides only whether a bill
 * is close enough to the floor to be worth re-reading and ranking. A false
 * positive costs at most one capped decode; a false negative costs a reader a
 * stale explanation of a live bill. tests/floor-signals.unit.spec.ts pins the
 * superset relationship against lib/journey.ts over the live corpus, so the two
 * can drift apart only in the safe direction.
 */
export { entersFloorWatch } from '../lib/docket.mjs';
import { entersFloorWatch } from '../lib/docket.mjs';

/**
 * The ordered, capped queue of bills worth re-reading this run.
 *
 * T0 first (the chamber has named them for the floor), then T1 (the record
 * says a vote is ripening), each newest-action-first. Only corpus bills are
 * considered: a T0 signal for a bill we don't hold yet is the newsdesk's
 * existing tier-0 fire path's job, not a re-decode's.
 *
 * @param {{ signals?: Record<string, any> | null, bills?: any[], now: number, windowDays?: number, cap?: number }} input
 * @returns {{ slug: string, tier: 't0' | 't1', lastActionDate: string }[]}
 */
export function redecodeCandidates({ signals, bills, now, windowDays = 14, cap = 25 }) {
  const live = new Set(
    Object.entries(signals ?? {})
      .filter(([, s]) => s?.stale !== true)
      .map(([slug]) => slug)
  );
  const out = [];
  for (const b of bills ?? []) {
    const slug = `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();
    if (live.has(slug)) {
      out.push({ slug, tier: 't0', lastActionDate: b.last_action_date ?? '' });
      continue;
    }
    if (!entersFloorWatch(b.last_action_text)) continue;
    const ms = Date.parse(`${b.last_action_date}T00:00:00Z`);
    if (!Number.isFinite(ms)) continue;
    if ((now - ms) / 86_400_000 > windowDays) continue;
    out.push({ slug, tier: 't1', lastActionDate: b.last_action_date ?? '' });
  }
  out.sort((a, x) => {
    if (a.tier !== x.tier) return a.tier === 't0' ? -1 : 1;
    if (a.lastActionDate !== x.lastActionDate) return a.lastActionDate < x.lastActionDate ? 1 : -1;
    return a.slug < x.slug ? -1 : 1;
  });
  return out.slice(0, cap);
}

// ---- verification (scripts/verify-sync.mjs + scripts/check-floor-signals.mjs)

/** Ceiling on the committed file. A week of House floor schedule plus a day
 *  of Senate program is a few KB; anything near this is a runaway writer. */
export const FLOOR_SIGNALS_MAX_BYTES = 256 * 1024;

const KNOWN_STATUSES = new Set(['ok', 'quiet', 'data_stale', 'error', 'unknown']);
const KNOWN_SOURCES = new Set(['daily-digest', 'billsthisweek']);

/**
 * The judgement half of the floor-signals gate — same split as
 * lib/verify-moment-updates.mjs, so both the nightly dead-man's-switch and
 * the CI check run the identical rules and the unit spec can reach them.
 *
 * Everything here polices ONE promise: every T0 claim on the page is a dated,
 * attributed, checkable quote of the government's own record. A signal
 * without a quote, without a URL, or dated in the future is not that.
 *
 * @param {{ data: any, fileBytes?: number, now?: number, knownSlugs?: Set<string> | null }} input
 * @returns {{ failures: string[], warnings: string[], notes: string[] }}
 */
export function verifyFloorSignals({ data, fileBytes, now = Date.now(), knownSlugs = null }) {
  const failures = [];
  const warnings = [];
  const notes = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    failures.push(`${FLOOR_SIGNALS_PATH} is not a JSON object`);
    return { failures, warnings, notes };
  }
  const meta = data._meta ?? {};
  if (meta.schema !== FLOOR_SIGNALS_SCHEMA) {
    failures.push(
      `${FLOOR_SIGNALS_PATH} carries an unknown _meta.schema (${JSON.stringify(meta.schema)}); this build writes ${FLOOR_SIGNALS_SCHEMA}`
    );
  }
  if (!meta.fetched_at || !Number.isFinite(Date.parse(meta.fetched_at))) {
    failures.push(`${FLOOR_SIGNALS_PATH} _meta.fetched_at is missing or unparseable`);
  }
  for (const [name, src] of Object.entries(meta.sources ?? {})) {
    if (!KNOWN_STATUSES.has(src?.status)) {
      failures.push(`${FLOOR_SIGNALS_PATH} source ${name} carries an unknown status ${JSON.stringify(src?.status)}`);
    }
  }
  if (Number.isFinite(fileBytes) && fileBytes > FLOOR_SIGNALS_MAX_BYTES) {
    failures.push(
      `${FLOOR_SIGNALS_PATH} is ${fileBytes} bytes, past the ${FLOOR_SIGNALS_MAX_BYTES}-byte ceiling`
    );
  }
  const tomorrow = new Date(now + 86_400_000).toISOString().slice(0, 10);
  const checkEntry = (key, entry, kind) => {
    const t0 = entry?.tier0;
    if (!t0) return failures.push(`${FLOOR_SIGNALS_PATH} ${kind} ${key} has no tier0 block`);
    if (!KNOWN_SOURCES.has(t0.source)) {
      failures.push(`${FLOOR_SIGNALS_PATH} ${kind} ${key} names an unknown source ${JSON.stringify(t0.source)}`);
    }
    if (typeof t0.quote !== 'string' || t0.quote.trim().length === 0) {
      failures.push(`${FLOOR_SIGNALS_PATH} ${kind} ${key} has no quote — a T0 claim with nothing to check it against`);
    } else if (t0.quote.length > QUOTE_MAX_CHARS) {
      failures.push(`${FLOOR_SIGNALS_PATH} ${kind} ${key} quote is ${t0.quote.length} chars, past the ${QUOTE_MAX_CHARS} ceiling`);
    }
    if (t0.quote_lang !== 'en') {
      failures.push(
        `${FLOOR_SIGNALS_PATH} ${kind} ${key} quote_lang is ${JSON.stringify(t0.quote_lang)} — evidence quotes stay English verbatim (owner ruling V4); a Spanish surface frames them, it never translates them`
      );
    }
    if (typeof t0.url !== 'string' || !/^https:\/\//.test(t0.url)) {
      failures.push(`${FLOOR_SIGNALS_PATH} ${kind} ${key} has no https source URL`);
    }
    if (typeof t0.published !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t0.published)) {
      failures.push(`${FLOOR_SIGNALS_PATH} ${kind} ${key} has no YYYY-MM-DD published date`);
    } else if (t0.published > tomorrow) {
      failures.push(`${FLOOR_SIGNALS_PATH} ${kind} ${key} is published ${t0.published}, in the future`);
    }
    if (!entry.fetched_at || !Number.isFinite(Date.parse(entry.fetched_at))) {
      failures.push(`${FLOOR_SIGNALS_PATH} ${kind} ${key} has no parseable fetched_at`);
    }
  };
  for (const [slug, entry] of Object.entries(data.signals ?? {})) {
    checkEntry(slug, entry, 'signal');
    if (knownSlugs && !knownSlugs.has(slug)) {
      warnings.push(
        `${FLOOR_SIGNALS_PATH} names ${slug}, which is not in data/bills.json — the chamber scheduled a bill this build does not hold yet (the sync picks it up on its own update); nothing renders for it until then`
      );
    }
  }
  for (const [citation, entry] of Object.entries(data.nominations ?? {})) {
    checkEntry(citation, entry, 'nomination');
  }
  const liveCount = Object.values(data.signals ?? {}).filter((s) => s.stale !== true).length;
  notes.push(
    `floor-signals: ${Object.keys(data.signals ?? {}).length} bill signal(s) (${liveCount} live), ${Object.keys(data.nominations ?? {}).length} nomination(s), sources ${Object.entries(meta.sources ?? {}).map(([k, v]) => `${k}=${v.status}`).join(', ') || 'none'}`
  );
  return { failures, warnings, notes };
}

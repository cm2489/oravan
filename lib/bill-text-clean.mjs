/**
 * Pure bill-text selection, XML/HTML cleaning, division/title extraction,
 * chunking for mega-bills (>400k chars), and word-boundary headline clipping.
 *
 * I/O-free so scripts/bill-decode.mjs, lib/decode-batch.mjs, and unit specs
 * share a single implementation.
 *
 * REBUILT 2026-11-28 after the independent check of PR #581 measured it on
 * real GPO bill XML (BILLS-118s1409rs, BILLS-118hr4366enr, BILLS-118hr2670rh,
 * BILLS-118s2226rs, all public domain, from govinfo.gov):
 *   - struck text is marked by ATTRIBUTES in real files (`changed="deleted"`,
 *     `reported-display-style="strikethrough"`) and by `<deleted-phrase>`,
 *     not only by element names, and the same element name nests (a
 *     `<section>` inside a `<quoted-block>` inside a `<section>`), so the
 *     cleaner is a tag scanner that matches each dropped element to its own
 *     closing tag rather than a regex over tag names;
 *   - XML carries no literal "DIVISION A" / "TITLE I" / "SEC." text (a
 *     division is `<division><enum>A</enum><header>…</header>`), so the
 *     cleaner writes those heading lines out itself, from the structure, and
 *     never from the bill's own table of contents or from quoted law.
 */

/** A bill at or under this many cleaned characters is decoded in one call. */
export const SINGLE_CALL_MAX_CHARS = 400_000;
/** The most cleaned characters one chunk call of a split bill reads. */
export const CHUNK_MAX_CHARS = 300_000;

const ENTITY_MAP = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  sect: '§',
};

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&([a-z]+);/gi, (m, name) => ENTITY_MAP[name.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

/**
 * Prefer Congress.gov Formatted XML when present, falling back to Formatted Text (HTML).
 * @param {any} version
 * @returns {{ url: string, format: 'xml' | 'html' } | null}
 */
export function preferredTextUrl(version) {
  const formats = Array.isArray(version?.formats) ? version.formats : [];
  const xml = formats.find((f) => f?.type === 'Formatted XML' && f?.url);
  if (xml) return { url: xml.url, format: 'xml' };
  const html = formats.find((f) => f?.type === 'Formatted Text' && f?.url);
  if (html) return { url: html.url, format: 'html' };
  return null;
}

// ---------------------------------------------------------------------------
// The tag scanner
// ---------------------------------------------------------------------------

/** Comments, processing instructions, doctype, CDATA, tags, text, stray '<'. */
const TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?[A-Za-z][^>]*>|[^<]+|</g;
const TAG_RE = /^<(\/)?([A-Za-z][\w:.-]*)([\s\S]*?)(\/)?>$/;

function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs ?? '');
  return m ? (m[1] ?? m[2] ?? '') : null;
}

/**
 * Elements whose whole content is text a committee or a clerk STRUCK. Real
 * GPO XML uses `<deleted-phrase>` (with reported-display-style
 * "strikethrough"); the HTML names are kept for the Formatted Text fallback.
 * Their opposite numbers (`<added-phrase>`, `changed="added"`) are live text
 * and are never dropped.
 */
const STRUCK_ELEMENTS = new Set(['deleted-phrase', 'struck-through', 'struck-text', 'amendment-strike', 'strike', 'del', 's']);

/** Non-operative wrapper noise: header metadata, the cover form (its official
 *  title already rides in every prompt), the enrolled attestation, styles. */
const NOISE_ELEMENTS = {
  xml: new Set(['metadata', 'form', 'editorial', 'attestation', 'endorsement', 'style', 'script']),
  html: new Set(['head', 'style', 'script', 'metadata', 'editorial']),
};

/**
 * True when this start tag opens STRUCK text. The three markers real files
 * carry, and only those: `changed="deleted"`, `reported-display-style=
 * "strikethrough"`, a struck element name — plus, for the HTML fallback, an
 * inline `line-through` style. `changed="not-changed"` and `changed="added"`
 * are live text (an amendment in the nature of a substitute is
 * `changed="added"`), so they never match.
 */
export function isStruckTag(name, attrs, format = 'xml') {
  const n = String(name ?? '').toLowerCase();
  if (STRUCK_ELEMENTS.has(n)) return true;
  if ((attr(attrs, 'changed') ?? '').toLowerCase() === 'deleted') return true;
  if ((attr(attrs, 'reported-display-style') ?? '').toLowerCase() === 'strikethrough') return true;
  if (format === 'html' && /line-through/i.test(attr(attrs, 'style') ?? '')) return true;
  return false;
}

const XML_BLOCK = new Set([
  'legis-body', 'resolution-body', 'engrossed-amendment-body', 'amendment-body', 'preamble', 'whereas',
  'official-title', 'enacting-clause', 'official-title-amendment',
  'division', 'title', 'subtitle', 'chapter', 'subchapter', 'part', 'subpart',
  'section', 'subsection', 'paragraph', 'subparagraph', 'clause', 'subclause', 'item', 'subitem',
  'quoted-block', 'toc', 'toc-entry', 'p', 'list', 'list-item', 'continuation-text',
  'appropriations-major', 'appropriations-intermediate', 'appropriations-small',
  'table', 'row', 'pagebreak', 'block', 'graphic',
]);
const HTML_BLOCK = new Set(['p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'blockquote', 'pre', 'section']);

/** Structural headings written out as text lines (XML only). */
const STRUCT_LABEL = { division: 'DIVISION', title: 'TITLE', subtitle: 'Subtitle', section: 'SEC.' };

/**
 * One pass over the tokens. `noDrop` holds token indexes whose drop must be
 * skipped (a start tag whose closing tag never came — see cleanBillMarkup).
 * Returns the text, or the index of the first unclosed drop.
 */
function scan(tokens, format, noDrop) {
  const out = [];
  const isXml = format === 'xml';
  const noise = NOISE_ELEMENTS[isXml ? 'xml' : 'html'];
  const block = isXml ? XML_BLOCK : HTML_BLOCK;
  let drop = null; // { name, depth, at }
  let quoted = 0; // depth inside <quoted-block>: quoted law, never a heading of THIS bill
  let toc = 0; // depth inside a <toc>
  let pending = null; // { kind, phase: 'enum' | 'label' | 'header', enumText }
  const emit = (s) => { out.push(s); };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('<!--') || tok.startsWith('<?') || (tok.startsWith('<!') && !tok.startsWith('<![CDATA['))) continue;
    const m = tok.startsWith('<') && tok.length > 1 ? TAG_RE.exec(tok) : null;

    if (drop) {
      if (m && m[2].toLowerCase() === drop.name) {
        if (m[1]) {
          drop.depth--;
          if (drop.depth === 0) { drop = null; emit(' '); }
        } else if (!m[4]) {
          drop.depth++;
        }
      }
      continue;
    }

    if (!m) {
      const text = tok.startsWith('<![CDATA[') ? tok.slice(9, -3) : tok;
      if (pending?.phase === 'enum') pending.enumText += text;
      else emit(text);
      continue;
    }

    const closing = Boolean(m[1]);
    const name = m[2].toLowerCase();
    const attrs = m[3] ?? '';
    const selfClosing = Boolean(m[4]) || (!isXml && name === 'br');

    if (!closing && !selfClosing && !noDrop.has(i)) {
      const topLevelToc = isXml && name === 'toc' && quoted === 0;
      if (isStruckTag(name, attrs, format) || noise.has(name) || topLevelToc) {
        drop = { name, depth: 1, at: i };
        continue;
      }
    }

    if (isXml) {
      if (name === 'quoted-block' && !selfClosing) quoted += closing ? -1 : 1;
      if (name === 'toc' && !selfClosing) toc += closing ? -1 : 1;
      if (quoted < 0) quoted = 0;
      if (toc < 0) toc = 0;

      if (!closing && !selfClosing && STRUCT_LABEL[name] && quoted === 0 && toc === 0) {
        emit('\n');
        pending = { kind: name, phase: 'await-enum', enumText: '' };
        continue;
      }
      if (pending) {
        if (name === 'enum' && pending.phase === 'await-enum' && !closing) { pending.phase = 'enum'; continue; }
        if (name === 'enum' && pending.phase === 'enum' && closing) {
          // "412 ." occurs in real enums; the heading line reads "SEC. 412."
          const e = decodeEntities(pending.enumText).replace(/\s+/g, ' ').trim().replace(/\s+\.$/, '.');
          const label = STRUCT_LABEL[pending.kind];
          if (pending.kind === 'section') emit(`${label} ${/\.$/.test(e) ? e : `${e}.`}`);
          else emit(`${label} ${e}`);
          pending.phase = 'label';
          continue;
        }
        if (name === 'header' && !closing && (pending.phase === 'label' || pending.phase === 'await-enum')) {
          if (pending.phase === 'label') emit(pending.kind === 'section' ? ' ' : '—');
          pending.phase = 'header';
          continue;
        }
        if (name === 'header' && closing && pending.phase === 'header') {
          emit('\n');
          pending = null;
          continue;
        }
        if (pending.phase !== 'header' && pending.phase !== 'enum') {
          // Something other than enum/header came first (a title whose
          // heading sits in an <appropriations-major>): the label stands
          // alone on its line and the heading follows on the next one.
          pending = null;
        }
      }
    }

    if (block.has(name)) emit('\n');
    else emit(' ');
  }

  if (drop) return { unclosedAt: drop.at };
  return { text: out.join('') };
}

/**
 * Clean raw Congressional XML or HTML bill markup:
 * - removes STRUCK text: every element whose start tag carries
 *   `changed="deleted"` or `reported-display-style="strikethrough"`, and every
 *   struck element (`<deleted-phrase>`, and `<strike>`/`<del>`/`<s>` in HTML),
 *   each matched to ITS OWN closing tag, so same-name nesting is handled;
 * - keeps every live element, including `changed="added"` (an amendment in
 *   the nature of a substitute) and `changed="not-changed"`;
 * - removes non-operative noise (<metadata>, the cover <form>, <attestation>,
 *   styles) and, in XML, the bill's own top-level table of contents (every
 *   entry repeats a heading the body carries; quoted tables of contents
 *   inside amendments are kept);
 * - in XML, writes each division, title, subtitle and section of THIS bill as
 *   a heading line (`DIVISION A—…`, `TITLE I—…`, `Subtitle A—…`, `SEC. 101. …`)
 *   — never for quoted law inside a <quoted-block>;
 * - preserves block line breaks.
 *
 * A start tag whose closing tag never arrives is NOT allowed to swallow the
 * rest of the document: that one tag is dropped and its content kept.
 *
 * @param {string} raw
 * @param {'xml' | 'html'} [format='html']
 * @returns {string}
 */
export function cleanBillMarkup(raw, format = 'html') {
  const tokens = String(raw ?? '').match(TOKEN_RE) ?? [];
  const noDrop = new Set();
  let res = scan(tokens, format, noDrop);
  // Bounded: each retry pins one more token; malformed input cannot loop.
  while (res.unclosedAt !== undefined) {
    noDrop.add(res.unclosedAt);
    res = scan(tokens, format, noDrop);
  }
  return decodeEntities(res.text)
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f\v ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

// Upper-case and a dash (or nothing) after the number: "TITLE I—Procurement",
// "TITLE II", "DIVISION A -- X". Never "Title I of the Social Security Act is
// amended", which is body text, not a heading.
const DASH = '(?:—|–|--|-|:)';
const DIVISION_RE = new RegExp(`^DIVISION\\s+([A-Z]{1,3}|\\d{1,3})(?:\\s*${DASH}\\s*(.*?))?\\s*$`);
const TITLE_RE = new RegExp(`^TITLE\\s+([IVXLCDM]+|\\d{1,3})(?:\\s*${DASH}\\s*(.*?))?\\s*$`);
const HEADING_LIKE = /^(SEC\.|SECTION|Subtitle|TITLE|DIVISION)\b/;

function nextLineTitle(lines, i) {
  const next = (lines[i + 1] ?? '').trim();
  return next && next.length <= 140 && !HEADING_LIKE.test(next) ? next : '';
}

/**
 * Extract the divisions and titles of THIS bill, with the character offset
 * of each heading line, plus a concise TOC string for the prompt.
 *
 * A text that prints its own table of contents before its body (the HTML
 * fallback does; cleaned XML does not) names each heading twice. The LAST
 * occurrence is the body's, so it wins: divisions by id, titles by
 * (division, id) — titles restart at I in every division.
 * @param {string} cleanText
 */
export function extractBillStructure(cleanText) {
  const lines = String(cleanText ?? '').split('\n');
  const rawDivs = [];
  const rawTitles = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const d = DIVISION_RE.exec(line);
    if (d) {
      const id = d[1].toUpperCase();
      rawDivs.push({ label: `DIVISION ${id}`, id, title: (d[2] ?? '').trim() || nextLineTitle(lines, i), charOffset: offset });
    } else {
      const t = TITLE_RE.exec(line);
      if (t) {
        const id = t[1].toUpperCase();
        rawTitles.push({ label: `TITLE ${id}`, id, title: (t[2] ?? '').trim() || nextLineTitle(lines, i), charOffset: offset });
      }
    }
    offset += lines[i].length + 1;
  }

  const lastBy = (items, key) => {
    const m = new Map();
    for (const it of items) m.set(key(it), it);
    return [...m.values()].sort((a, b) => a.charOffset - b.charOffset);
  };
  const divisions = lastBy(rawDivs, (d) => d.id);
  const divisionAt = (off) => {
    let id = null;
    for (const d of divisions) if (d.charOffset <= off) id = d.id;
    return id;
  };
  const titles = lastBy(
    rawTitles.map((t) => ({ ...t, division: divisions.length >= 2 ? divisionAt(t.charOffset) : null })),
    (t) => `${t.division ?? ''}|${t.id}`
  );

  const tocLines = [];
  if (divisions.length > 0) {
    for (const d of divisions) tocLines.push(d.title ? `${d.label}: ${d.title}` : d.label);
  } else if (titles.length > 0) {
    for (const t of titles.slice(0, 20)) tocLines.push(t.title ? `${t.label}: ${t.title}` : t.label);
    if (titles.length > 20) tocLines.push(`... (${titles.length - 20} more titles)`);
  }

  return { divisions, titles, toc: tocLines.join('\n') };
}

// ---------------------------------------------------------------------------
// Splitting the very longest bills
// ---------------------------------------------------------------------------

/** End offsets inside [start, end) for pieces no longer than max, cut at the
 *  last "SEC." heading, else line, else space, past 40% of the window. */
function cutPoints(text, start, end, max) {
  const cuts = [];
  let pos = start;
  while (end - pos > max) {
    const slice = text.slice(pos, pos + max);
    const floor = max * 0.4;
    let at = slice.lastIndexOf('\nSEC. ');
    if (at <= floor) at = slice.lastIndexOf('\n');
    if (at <= floor) at = slice.lastIndexOf(' ');
    const cut = at > floor ? pos + at + 1 : pos + max;
    cuts.push(cut);
    pos = cut;
  }
  cuts.push(end);
  return cuts;
}

const fullLabel = (u) => (u.title ? `${u.label} — ${u.title}` : u.label);

/**
 * Atomic pieces of the text, in order and covering every character exactly
 * once: one per top-level unit (division, or title when the bill has no
 * divisions), a unit too long for one chunk split at its titles, and a span
 * still too long split at SEC./line boundaries. Text before the first unit
 * (short title, references) rides with the first piece.
 */
function atomicPieces(text, structure, max) {
  const divs = structure.divisions.length >= 2 ? structure.divisions : [];
  const units = divs.length
    ? divs.map((d) => ({ kind: 'division', u: d }))
    : structure.titles.length >= 2
      ? structure.titles.map((t) => ({ kind: 'title', u: t }))
      : [];
  const pieces = [];
  if (units.length === 0) {
    const cuts = cutPoints(text, 0, text.length, max);
    let s = 0;
    cuts.forEach((e, k) => { pieces.push({ start: s, end: e, division: null, title: null, part: cuts.length > 1 ? [k + 1, cuts.length] : null }); s = e; });
    return pieces;
  }
  for (let k = 0; k < units.length; k++) {
    const start = k === 0 ? 0 : units[k].u.charOffset;
    const end = k + 1 < units.length ? units[k + 1].u.charOffset : text.length;
    const division = units[k].kind === 'division' ? units[k].u : null;
    const topTitle = units[k].kind === 'title' ? units[k].u : null;
    if (end - start <= max) {
      pieces.push({ start, end, division, title: topTitle, part: null, whole: true });
      continue;
    }
    // Too long: split a division at its own titles; then any span still too
    // long at SEC./line boundaries.
    const inner = division
      ? structure.titles.filter((t) => t.division === division.id && t.charOffset > start && t.charOffset < end)
      : [];
    const bounds = [{ at: start, title: null }, ...inner.map((t) => ({ at: t.charOffset, title: t }))];
    for (let b = 0; b < bounds.length; b++) {
      const s0 = bounds[b].at;
      const e0 = b + 1 < bounds.length ? bounds[b + 1].at : end;
      if (e0 <= s0) continue;
      const cuts = cutPoints(text, s0, e0, max);
      let s = s0;
      cuts.forEach((e, c) => {
        pieces.push({
          start: s, end: e, division, title: bounds[b].title ?? topTitle,
          part: cuts.length > 1 ? [c + 1, cuts.length] : null, whole: false,
        });
        s = e;
      });
    }
  }
  return pieces;
}

/**
 * The label of one chunk: exactly the divisions it holds, and — for a
 * division it holds only part of — exactly the titles (and part numbers) it
 * holds of it.
 */
function groupBy(pieces, keyOf) {
  const groups = [];
  for (const p of pieces) {
    const key = keyOf(p);
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, pieces: [] }; groups.push(g); }
    g.pieces.push(p);
  }
  return groups;
}

/** "" for whole spans, else "part 2 of 3" / "parts 2–3 of 3". */
function partsText(ps) {
  const nums = ps.filter((p) => p.part).map((p) => p.part[0]);
  if (nums.length === 0) return '';
  const n = ps.find((p) => p.part).part[1];
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return lo === hi ? `part ${lo} of ${n}` : `parts ${lo}–${hi} of ${n}`;
}

function chunkLabel(pieces, allPieces) {
  const groups = groupBy(pieces, (p) => (p.division ? `D:${p.division.id}` : p.title ? `T:${p.title.id}` : 'none'));
  const parts = groups.map((g) => {
    const first = g.pieces[0];
    if (g.key === 'none') {
      const pt = partsText(g.pieces);
      return pt ? pt.charAt(0).toUpperCase() + pt.slice(1) : 'Full text';
    }
    if (!first.division) {
      const pt = partsText(g.pieces);
      return `${fullLabel(first.title)}${pt ? ` (${pt})` : ''}`;
    }
    const total = allPieces.filter((p) => p.division?.id === first.division.id).length;
    if (g.pieces.length === total) return fullLabel(first.division);
    const inner = groupBy(g.pieces, (p) => (p.title ? p.title.label : 'opening provisions')).map((tg) => {
      const pt = partsText(tg.pieces);
      return pt ? `${tg.key}, ${pt}` : tg.key;
    });
    return `${fullLabel(first.division)} (${inner.join('; ')})`;
  });
  return parts.join('; ');
}

/**
 * Prepare cleaned full bill text without a 60k truncation cliff:
 * - <= SINGLE_CALL_MAX_CHARS: single-call full-text decode
 * - larger: contiguous chunks of at most CHUNK_MAX_CHARS that together hold
 *   every character exactly once, cut at division boundaries (then titles,
 *   then SEC./line boundaries), each labelled with exactly what it holds.
 */
export function prepareBillForDecode(
  cleanText,
  { singleCallMaxChars = SINGLE_CALL_MAX_CHARS, chunkMaxChars = CHUNK_MAX_CHARS } = {}
) {
  const text = String(cleanText ?? '');
  const structure = extractBillStructure(text);
  const isMultiDivision = structure.divisions.length >= 2;
  const base = { text, divisions: structure.divisions, titles: structure.titles, toc: structure.toc, isMultiDivision };

  if (text.length <= singleCallMaxChars) {
    return { ...base, mode: 'single', chunks: [{ label: isMultiDivision ? 'All divisions' : 'Full text', text, start: 0, end: text.length, divisions: structure.divisions.map((d) => d.id) }] };
  }

  const pieces = atomicPieces(text, structure, chunkMaxChars);
  const groups = [];
  let cur = [];
  for (const p of pieces) {
    const curStart = cur.length ? cur[0].start : p.start;
    if (cur.length && p.end - curStart > chunkMaxChars) { groups.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) groups.push(cur);

  const chunks = groups.map((g) => {
    const start = g[0].start;
    const end = g[g.length - 1].end;
    return {
      label: chunkLabel(g, pieces),
      text: text.slice(start, end),
      start,
      end,
      divisions: [...new Set(g.map((p) => p.division?.id).filter(Boolean))],
    };
  });

  return { ...base, mode: chunks.length > 1 ? 'chunked' : 'single', chunks };
}

// ---------------------------------------------------------------------------
// Headlines
// ---------------------------------------------------------------------------

/** True when a trailing straight double quote CLOSES a quotation (an even
 *  number of them in the string), false when it is left dangling open. */
function closesQuote(s) {
  return ((s.match(/"/g) ?? []).length % 2) === 0;
}

/**
 * Clip a headline cleanly at a word boundary without truncating a word mid-token.
 * A closing quotation mark is kept; a dangling opening one is removed.
 * @param {string} str
 * @param {number} [maxChars=110]
 * @returns {string}
 */
export function clipAtWordBoundary(str, maxChars = 110) {
  const s = String(str ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxChars) return s;

  const slice = s.slice(0, maxChars);
  let cut = slice;
  // If we landed mid-word (the character right after the slice isn't whitespace/punctuation end),
  // step back to the last space whenever that preserves a reasonable headline (>=40% of budget).
  if (s[maxChars] && !/\s/.test(s[maxChars])) {
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace >= Math.floor(maxChars * 0.4)) {
      cut = slice.slice(0, lastSpace);
    }
  }
  for (;;) {
    const before = cut;
    cut = cut.replace(/[\s,;:\-–—«“(]+$/g, '');
    if (cut.endsWith('"') && !closesQuote(cut)) cut = cut.slice(0, -1);
    if (cut === before) break;
  }
  return cut.trim();
}

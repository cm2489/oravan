/**
 * Pure bill-text selection, XML/HTML cleaning, division/title extraction,
 * chunking for mega-bills (>400k chars), and word-boundary headline clipping.
 *
 * I/O-free so scripts/bill-decode.mjs, lib/decode-batch.mjs, and unit specs
 * share a single implementation.
 */

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

/**
 * Clean raw Congressional XML or HTML bill markup:
 * - removes struck/deleted statutory text (<struck-through>, <strike>, <del>, <s>, <deleted-phrase>, etc.)
 * - removes <editorial>, <metadata>, <form>, <style>, <script> noise
 * - preserves block line breaks so divisions/titles/sections stay parseable
 *
 * @param {string} raw
 * @param {'xml' | 'html'} [format='html']
 * @returns {string}
 */
export function cleanBillMarkup(raw, format = 'html') {
  let s = String(raw ?? '');
  // Drop processing instructions and HTML/XML comments first.
  s = s.replace(/<\?[\s\S]*?\?>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');

  // Remove struck/deleted blocks and non-operative markup (even nested tags of different names).
  const dropBlockTags = [
    'struck-through',
    'struck-text',
    'amendment-strike',
    'deleted-phrase',
    'strike',
    'del',
    's',
    'editorial',
    'metadata',
    'form',
    'style',
    'script',
  ];
  for (const tag of dropBlockTags) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'gi');
    s = s.replace(re, ' ');
  }

  // Insert newlines at structural boundaries before stripping remaining tags.
  if (format === 'xml') {
    s = s.replace(
      /<\/?(?:division|title|subtitle|chapter|subchapter|part|section|quoted-block|p|div|header|toc|toc-entry|enum|text)\b[^>]*>/gi,
      '\n'
    );
  } else {
    s = s.replace(/<\/?(?:p|div|br|h[1-6]|li|tr|blockquote|pre|section)\b[^>]*>/gi, '\n');
  }

  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);

  return s
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f\v]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

const DIVISION_RE = /^DIVISION\s+([A-Z0-9]+)(?:\s*[—–\-:]+\s*(.+))?$/i;
const TITLE_RE = /^TITLE\s+([IVXLCDM]+|\d+)(?:\s*[—–\-:]+\s*(.+))?$/i;

/**
 * Extract top-level divisions and titles plus a concise TOC string from cleaned bill text.
 * @param {string} cleanText
 */
export function extractBillStructure(cleanText) {
  const lines = String(cleanText ?? '').split('\n');
  const divisions = [];
  const titles = [];
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const divMatch = DIVISION_RE.exec(line);
    if (divMatch) {
      let title = (divMatch[2] ?? '').trim();
      if (!title && i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        if (next && next.length <= 140 && !/^(SEC\.|SECTION|TITLE|DIVISION)\b/i.test(next)) {
          title = next;
        }
      }
      divisions.push({
        label: `DIVISION ${divMatch[1].toUpperCase()}`,
        id: divMatch[1].toUpperCase(),
        title,
        charOffset: offset,
      });
    } else {
      const titleMatch = TITLE_RE.exec(line);
      if (titleMatch) {
        let title = (titleMatch[2] ?? '').trim();
        if (!title && i + 1 < lines.length) {
          const next = lines[i + 1].trim();
          if (next && next.length <= 140 && !/^(SEC\.|SECTION|SUBTITLE|TITLE)\b/i.test(next)) {
            title = next;
          }
        }
        titles.push({
          label: `TITLE ${titleMatch[1].toUpperCase()}`,
          id: titleMatch[1].toUpperCase(),
          title,
          charOffset: offset,
        });
      }
    }
    offset += lines[i].length + 1;
  }

  const tocLines = [];
  if (divisions.length > 0) {
    for (const d of divisions) {
      tocLines.push(d.title ? `${d.label}: ${d.title}` : d.label);
    }
  } else if (titles.length > 0) {
    for (const t of titles.slice(0, 20)) {
      tocLines.push(t.title ? `${t.label}: ${t.title}` : t.label);
    }
    if (titles.length > 20) tocLines.push(`... (${titles.length - 20} more titles)`);
  }

  return {
    divisions,
    titles,
    toc: tocLines.join('\n'),
  };
}

function splitLongSpan(spanText, chunkMaxChars, labelPrefix = '') {
  if (spanText.length <= chunkMaxChars) return [{ label: labelPrefix, text: spanText }];
  const parts = [];
  let pos = 0;
  let idx = 1;
  while (pos < spanText.length) {
    let end = Math.min(pos + chunkMaxChars, spanText.length);
    if (end < spanText.length) {
      const slice = spanText.slice(pos, end);
      const secBreak = slice.lastIndexOf('\nSEC.');
      const lineBreak = slice.lastIndexOf('\n');
      const spaceBreak = slice.lastIndexOf(' ');
      if (secBreak > chunkMaxChars * 0.4) end = pos + secBreak;
      else if (lineBreak > chunkMaxChars * 0.4) end = pos + lineBreak;
      else if (spaceBreak > chunkMaxChars * 0.4) end = pos + spaceBreak;
    }
    const piece = spanText.slice(pos, end).trim();
    if (piece) {
      parts.push({
        label: labelPrefix ? `${labelPrefix} (part ${idx++})` : `Part ${idx++}`,
        text: piece,
      });
    }
    pos = end;
  }
  return parts;
}

/**
 * Prepare cleaned full bill text without a 60k truncation cliff:
 * - <= 400k chars: single-call full-text decode
 * - > 400k chars: deterministic division-boundary (or SEC./line-boundary) chunking
 */
export function prepareBillForDecode(
  cleanText,
  { singleCallMaxChars = 400_000, chunkMaxChars = 300_000 } = {}
) {
  const text = String(cleanText ?? '');
  const structure = extractBillStructure(text);
  const isMultiDivision = structure.divisions.length >= 2;

  if (text.length <= singleCallMaxChars) {
    return {
      mode: 'single',
      text,
      chunks: [{ label: isMultiDivision ? 'All divisions' : 'Full text', text }],
      divisions: structure.divisions,
      titles: structure.titles,
      toc: structure.toc,
      isMultiDivision,
    };
  }

  const chunks = [];
  if (structure.divisions.length >= 2) {
    const divs = structure.divisions;
    // Include any preamble before Division A with the first chunk.
    let groupStart = 0;
    let groupLabel = `${divs[0].label}${divs[0].title ? ` — ${divs[0].title}` : ''}`;

    for (let i = 1; i <= divs.length; i++) {
      const nextOffset = i < divs.length ? divs[i].charOffset : text.length;
      const spanLen = nextOffset - groupStart;
      if (i === divs.length || nextOffset - groupStart > chunkMaxChars) {
        const end = i === divs.length ? text.length : divs[i].charOffset;
        const segment = text.slice(groupStart, end).trim();
        if (segment.length <= chunkMaxChars) {
          chunks.push({ label: groupLabel, text: segment });
        } else {
          chunks.push(...splitLongSpan(segment, chunkMaxChars, groupLabel));
        }
        if (i < divs.length) {
          groupStart = divs[i].charOffset;
          groupLabel = `${divs[i].label}${divs[i].title ? ` — ${divs[i].title}` : ''}`;
        }
      } else if (spanLen <= chunkMaxChars && divs[i]) {
        groupLabel = `${groupLabel}; ${divs[i].label}`;
      }
    }
  } else {
    chunks.push(...splitLongSpan(text, chunkMaxChars));
  }

  return {
    mode: chunks.length > 1 ? 'chunked' : 'single',
    text,
    chunks,
    divisions: structure.divisions,
    titles: structure.titles,
    toc: structure.toc,
    isMultiDivision,
  };
}

/**
 * Clip a headline cleanly at a word boundary without truncating a word mid-token.
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
  return cut.replace(/[\s,;:\-–—"«(]+$/g, '').trim();
}

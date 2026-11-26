/**
 * Pure post-decode quality checks (word-boundary headline checks and
 * multi-division summary coverage checks). I/O-free and $0 runtime cost.
 */

const STOPWORDS = new Set([
  'about', 'after', 'other', 'purposes', 'federal', 'united', 'states', 'national',
  'general', 'related', 'matters', 'program', 'programs', 'appropriations', 'fiscal',
  'division', 'title', 'chapter', 'section', 'under', 'their', 'these', 'those',
]);

/**
 * Check that a decoded headline respects the ceiling without ending in a
 * cut-off fragment near the cap.
 * @param {string} headline
 * @param {number} [maxChars=110]
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkHeadlineWordBoundary(headline, maxChars = 110) {
  const s = String(headline ?? '').trim();
  if (!s) return { ok: false, reason: 'empty headline' };
  if (s.length > maxChars) {
    return { ok: false, reason: `headline length ${s.length} exceeds ${maxChars}` };
  }
  if (/[\s,;:\-–—"«(]$/.test(s)) {
    return { ok: false, reason: 'headline ends with trailing dangling punctuation' };
  }
  // If a headline hits exact maxChars with no terminal punctuation, it was likely slice()-truncated.
  if (s.length === maxChars && !/[.!?'"”»)]$/.test(s)) {
    return { ok: false, reason: `headline hits exact ${maxChars}-char slice boundary without clean termination` };
  }
  return { ok: true };
}

/**
 * For multi-division bills (>=2 divisions), verify that each major division is
 * reflected in the summary (by division label or distinctive title keyword).
 * @param {string} summary
 * @param {Array<{ id: string, label?: string, title?: string }>} divisions
 * @returns {{ ok: boolean, covered: string[], missing: string[] }}
 */
export function checkDivisionCoverage(summary, divisions) {
  if (!Array.isArray(divisions) || divisions.length < 2) {
    return { ok: true, covered: [], missing: [] };
  }
  const body = String(summary ?? '').toLowerCase();
  const covered = [];
  const missing = [];

  for (const div of divisions) {
    const id = String(div.id ?? '').trim();
    const labelHit = id ? new RegExp(`\\bdivision\\s+${id}\\b`, 'i').test(body) : false;
    const keywords = String(div.title ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 5 && !STOPWORDS.has(w));
    const keywordHit = keywords.some((kw) => body.includes(kw));

    const name = div.title ? `Division ${id} (${div.title})` : `Division ${id}`;
    if (labelHit || keywordHit) covered.push(name);
    else missing.push(name);
  }

  return { ok: missing.length === 0, covered, missing };
}

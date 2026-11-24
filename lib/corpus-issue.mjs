/**
 * The nightly corpus issues comment only on what is NEW (2026-11-23).
 *
 * WHY. The journey-corpus (#268) and scaffold-corpus (#398) tripwires in
 * .github/workflows/sync-bills.yml used to post tonight's whole report on
 * their open issue every night a finding stood, so one unread sentence became
 * a comment a night for weeks (61 and 53 comments by 2026-11-23), each one an
 * email to the owner. His answer of 2026-11-23 (card `emails`, option a):
 * "One plain note every Monday at 9 AM ET, and the robot threads go quiet".
 *
 * WHAT CHANGES, AND WHAT DOES NOT. Nothing about the verdicts: the journey
 * sweep's allow-list still fails a vacuous or crashed night, and the scaffold
 * filing stays continue-on-error. Only the comment on an ALREADY-OPEN issue is
 * gated: it posts when tonight's report holds a finding that no earlier text
 * in that issue (its body or any comment) already holds. A repeat night posts
 * nothing. A new issue is still opened exactly as before.
 *
 * WHAT A "FINDING" IS. Both reports list each sentence as a bullet naming the
 * bill in bold, with the record's sentence quoted under it:
 *
 *   - **sjres-124-119** — no matcher places this sentence in a chamber (…):
 *     > The motion to discharge fell when the point of order was well taken.
 *
 * Such a finding is already present when one earlier text holds both the
 * slug and the quoted sentence. A bullet with no quote (the scaffold sweep's
 * "the sweep itself" problems) is compared with its numbers blanked, because
 * those lines carry tonight's counts. A report with no bullet at all (the
 * error bodies) is keyed on its quoted lines, or failing that its first line,
 * with links and numbers blanked, so a run id or a date never makes a repeat
 * look new.
 *
 * Import-free and clock-free, so the unit suite loads it directly.
 */

/** Marks the one "the sweep is clean" comment, so a clean night says it once. */
export const CLEAN_MARKER = '<!-- corpus-sweep-clean -->';

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const blankNumbers = (s) => squash(s).replace(/https?:\/\/\S+/g, '<link>').replace(/\d+/g, '#');

/**
 * The findings in one report, each as the text it is matched on.
 *
 * @param {string} reportMd
 * @returns {Array<{ slug: string | null, quote: string | null, line: string | null }>}
 */
export function reportFindings(reportMd) {
  const lines = String(reportMd ?? '').split('\n');
  /** @type {Array<{ slug: string | null, quote: string | null, line: string | null }>} */
  const items = [];
  let current = null;
  const strayQuotes = [];
  for (const raw of lines) {
    const bullet = /^-\s+(.*)$/.exec(raw);
    if (bullet) {
      const slug = /^\*\*([^*]+)\*\*/.exec(bullet[1]);
      current = { slug: slug ? slug[1].trim() : null, quote: null, bullet: bullet[1] };
      items.push(current);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      if (current && /^\s+>/.test(raw)) {
        current.quote = squash([current.quote, quote[1]].filter(Boolean).join(' '));
      } else {
        strayQuotes.push(squash(quote[1]));
      }
      continue;
    }
    if (!/^\s/.test(raw)) current = null;
  }

  const findings = items.map((it) =>
    it.quote ? { slug: it.slug, quote: it.quote, line: null } : { slug: it.slug, quote: null, line: blankNumbers(it.bullet) }
  );
  if (findings.length) return findings;
  if (strayQuotes.length) return strayQuotes.map((q) => ({ slug: null, quote: q, line: null }));
  const first = lines.find((l) => l.trim());
  return first ? [{ slug: null, quote: null, line: blankNumbers(first) }] : [];
}

/**
 * Is this finding already in one of the issue's earlier texts?
 *
 * @param {{ slug: string | null, quote: string | null, line: string | null }} finding
 * @param {string[]} texts  the issue body and every comment body
 */
export function findingSeen(finding, texts) {
  return texts.some((t) => {
    if (finding.quote) {
      // Quote markers dropped first, so a sentence wrapped over two quoted
      // lines still reads as the one sentence it is.
      const flat = squash(String(t ?? '').replace(/^[ \t]*>[ \t]?/gm, ''));
      return flat.includes(finding.quote) && (!finding.slug || flat.includes(finding.slug));
    }
    return Boolean(finding.line) && blankNumbers(t).includes(finding.line);
  });
}

/**
 * The findings tonight's report holds that the issue does not. Empty means a
 * repeat night: post nothing.
 *
 * @param {string} reportMd
 * @param {string[]} texts
 */
export function unseenFindings(reportMd, texts) {
  return reportFindings(reportMd).filter((f) => !findingSeen(f, texts));
}

/** The one comment a clean sweep leaves on a still-open issue. */
export function cleanComment(date) {
  return [
    CLEAN_MARKER,
    `The nightly sweep of ${date} came back clean: every sentence this issue named is read now. This issue can be closed.`,
  ].join('\n');
}

/**
 * A clean night comments only when the issue's newest text is not already
 * the clean note — once per clean-up, never once a night.
 *
 * @param {string[]} texts  body first, then comments oldest first
 */
export function needsCleanComment(texts) {
  const last = texts.length ? texts[texts.length - 1] : '';
  return !String(last).includes(CLEAN_MARKER);
}

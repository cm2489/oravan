/*
 * THE SHORT-LABEL BUDGET for `Chip tone="ai"`.
 *
 * The ai chip sets its text in tracked capitals at 12px/700. That is a LABEL
 * voice, built for two to five words ("AI-decoded"). Fed a disclosure
 * sentence it renders 5–8 lines of shouting capitals — measured 2026-09-25 at
 * 390×844: /bills 172 characters in 5 lines, a question page's vehicles note
 * 261 characters in 8 lines — which is exactly the "bold-uppercase disclosure
 * paragraph" the owner demoted to a caption on 2026-08-01. Anything longer
 * than this budget is a sentence, and a sentence goes in `AiNote`.
 *
 * Counted per word, in BOTH locales (Spanish runs longer, and the budget is
 * the same for both — a longer ES budget would only ship Spanish "labels"
 * that are sentences). Separator glyphs ("·", "—") are not words.
 *
 * Pinned by tests/ai-label.unit.spec.ts, which scans every `<Chip tone="ai">`
 * call site and checks the message key it prints in en.json and es.json.
 */
export const AI_LABEL_MAX_WORDS = 6;

/** Words in a label: whitespace-separated runs that carry a letter or digit. */
export function aiLabelWordCount(label: string): number {
  return label.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

import { formatCitation } from './format';
import type { Bill, Stance } from './types';

/*
 * The ONE call-script prompt builder (extracted from app/api/script/route.ts
 * for S21/F7 pregen): both the live route and scripts/pregen-scripts.mjs
 * import this, so the two paths can never drift into two different scripts
 * for the same (bill, stance, locale) - a pregenerated script must be
 * byte-for-byte what the route would have generated on demand.
 *
 * Deliberate behavior this preserves unchanged from the route's original
 * inline prompt: the model is always given the bill's ENGLISH ai_summary as
 * input content, in both locales - only `langLine` changes to ask for
 * Spanish output. The route never reads data/bills-es.json's decoded
 * overlay (lib/core's localizeBill) for this endpoint, so neither does
 * pregen; passing a locale-localized bill here would compute a different
 * content-version hash and a different prompt than the route ever has,
 * silently forking the two paths on day one.
 */

export const SCRIPT_MODEL = 'claude-sonnet-5';
export const SCRIPT_MAX_TOKENS = 520;
export const STANCES: Stance[] = ['support', 'oppose', 'undecided'];

const STANCE_LINES: Record<Stance, string> = {
  support: 'The caller SUPPORTS this bill and urges the member to vote for it.',
  oppose: 'The caller OPPOSES this bill and urges the member to vote against it.',
  undecided:
    "The caller is CONCERNED about this bill and has not settled on support or opposition. The script must register that concern, name the ONE thing that worries them (grounded in the summary), and ask that their concern be noted for the member along with where the member stands - phrased as something for the office to record, never as live questions to the staffer. The staffer only tallies positions; the script must not expect answers or a conversation.",
};

function langLine(lang: 'en' | 'es'): string {
  return lang === 'es'
    ? 'Write the script in natural, warm Latin American Spanish (tú form). Use the placeholders [TU NOMBRE] and [TU CIUDAD O CÓDIGO POSTAL].'
    : 'Write the script in plain, warm English at an 8th-grade reading level. Use the placeholders [YOUR NAME] and [YOUR TOWN OR ZIP].';
}

export interface ScriptPromptInput {
  /** Always the raw (English) bill - see the module note above. */
  bill: Pick<Bill, 'bill_type' | 'bill_number' | 'short_title' | 'title' | 'ai_summary' | 'status'>;
  stance: Stance;
  lang: 'en' | 'es';
}

/** The exact 30-second call-script prompt, shared by the route and pregen. */
export function buildScriptPrompt({ bill, stance, lang }: ScriptPromptInput): string {
  const citation = formatCitation(bill.bill_type, bill.bill_number);

  return `Write a 30-second phone script for a constituent calling a member of Congress about this bill.

Bill: ${citation} — ${bill.short_title ?? bill.title}
Plain-language summary: ${bill.ai_summary ?? bill.title}
Current status: ${bill.status}

${STANCE_LINES[stance]}

${langLine(lang)}

Rules:
- 60-90 words. It must be comfortably readable aloud in 30 seconds.
- Structure: greeting + name placeholder + constituent location placeholder, the bill by its number, the position, ONE concrete reason grounded in the summary, a clear ask, thanks.
- Refer to the bill exactly as "${citation}" - do not alter, translate, or extend that citation.
- Works equally well read to a live staffer or left as a voicemail.
- Strictly nonpartisan tone: no party language, no attacks, no alarmism, no advocacy-group jargon.
- Do not invent facts beyond the summary provided.
- Plain text only: no markdown, no asterisks, no bullet points, no headers.
- Output ONLY the script text, no commentary.`;
}

// TYPE-ONLY, and it must stay type-only: lib/core/nominations.ts imports
// data/nominations.json (~520 KB) at module scope and is deliberately kept out
// of the lib/core barrel (see its header). `import type` is erased at compile
// time, so this module names a Nomination's fields without any importer —
// lib/scriptcache.ts among them — pulling a byte of the corpus.
import type { Nomination } from './core/nominations';
import type { Stance } from './types';

/*
 * THE SENATE-NOMINATION CALL-SCRIPT PROMPT — a FORK of lib/scriptprompt.ts,
 * not a parameterization of it, and the reason is one line in that file:
 *
 *   "The exact same script is read verbatim to the caller's U.S.
 *    Representative's office and, separately, to both of the caller's U.S.
 *    Senators' offices - so it must never assume, name, or imply a single
 *    chamber."
 *
 * Chamber-neutrality is that prompt's LOAD-BEARING promise, stated in its
 * opening sentence and enforced again in its rules. A nomination inverts it:
 * advice and consent is the Senate's alone (lib/journey.ts VOTING_CHAMBERS,
 * Article II §2 cl. 2), so a nomination script that refuses to name a chamber
 * cannot say the one true thing about the call — that the vote belongs to the
 * senators and to nobody else. Reusing that builder with a flag would have
 * left one function whose first sentence is false half the time. Two prompts,
 * two version lineages, no shared string.
 *
 * ── WHAT GROUNDS THE SCRIPT, AND WHY IT IS NOT A DECODE ────────────────────
 *
 * lib/scriptprompt.ts grounds its script in `bill.ai_summary` — a model-written
 * plain-language decode, because a bill's own text is unreadable. A nomination
 * has no such problem: Congress.gov's `description` is already ONE plain
 * complete English sentence naming the person, the post, and whom they would
 * replace ("Jeffrey Brodsky, of Florida, to be a Governor of the United States
 * Postal Service … vice William Zollars, term expired."). 845 of the 859
 * civilian records of the 119th Congress carry one.
 *
 * So this prompt is grounded in the GOVERNMENT'S OWN SENTENCE, verbatim, and
 * Oravan adds no decode step for nominations. That is a deliberate refusal,
 * not an omission: a decode would cost Anthropic spend to restate a sentence
 * that is already plain, and it would open a new AI-provenance surface — one
 * more machine-written claim about a named private citizen — that nobody asked
 * for. `nominations.noDecodeNote` says so on the page, because every other
 * card on this site carries a decode and an unexplained absence reads as a gap.
 *
 * ── THE RULE THAT MATTERS MOST HERE ────────────────────────────────────────
 *
 * The record names a PERSON. It says nothing whatever about their career,
 * their views, their qualifications, or their fitness — and a model asked for
 * "one concrete reason" to support or oppose a named individual will invent
 * exactly those things if it is not stopped. That would be a fabricated claim
 * about a private citizen, published under an Oravan label, and it would break
 * "nonpartisan by construction" in the same stroke.
 *
 * The prompt therefore forbids any characterization of the nominee and points
 * the reason at the OFFICE — what the post does and why the caller cares who
 * holds it — which is the only thing the record actually supports. That rule
 * is stated three times below (in the grounding line, in the stance lines, and
 * in the Rules block) on purpose: it is the one rule whose failure is a
 * defamation risk rather than a copy defect.
 */

/*
 * Prompt version — the cache-invalidation tag for the NOMINATION generation
 * logic, with its own lineage independent of lib/scriptprompt.ts's
 * PROMPT_VERSION. Folded into lib/scriptcache.ts's nominationContentVersion(),
 * so a prompt edit here is a clean cache miss for every
 * (nomination, stance, audience, locale) and reaches users on the next
 * request. Bumping the bill prompt must NOT invalidate nomination scripts and
 * vice versa, which is the whole reason these are two constants.
 *   v1 — initial fork (2026-08-06): chamber-SPECIFIC by design, two audiences,
 *        grounded in Congress.gov's own description sentence, no decode.
 */
export const NOMINATION_PROMPT_VERSION = '1';

/*
 * WHO THE SCRIPT IS BEING READ TO. A bill script has no such axis — it is one
 * script for every office — but a nomination has exactly two audiences and
 * they are asked for different things:
 *
 *   senator  holds the vote. The ask is the vote.
 *   house    holds NO vote and no formal role. The ask is that they press the
 *            two senators they share a state with (owner ruling 2026-08-06,
 *            the same ruling that produced `bill.nominationHousePress`). The
 *            script must never imply the representative can vote on this.
 *
 * Enumerated `as const` so a third audience cannot be added without the
 * route's validation, the cache key, and AUDIENCE_LINES all learning it —
 * tests/nomination-script.unit.spec.ts pins the table total over this set.
 */
export const NOMINATION_AUDIENCES = ['senator', 'house'] as const;

export type NominationAudience = (typeof NOMINATION_AUDIENCES)[number];

/** The caller's position on CONFIRMING the nominee. Same three stances a bill
 *  takes — the axis is the same question ("what do you want done?"), only the
 *  vote it names is different. Reused rather than forked so the panel's stance
 *  control, the call log, and the ghost templates all keep working unchanged. */
const STANCE_LINES: Record<NominationAudience, Record<Stance, string>> = {
  senator: {
    support:
      'The caller SUPPORTS this nomination and asks the senator to vote to confirm.',
    oppose:
      'The caller OPPOSES this nomination and asks the senator to vote against confirming.',
    undecided:
      "The caller is CONCERNED about this nomination and has not settled on support or opposition. The script must register that concern and name the ONE thing that worries them - which must be about the POST and what it decides, never a claim about the nominee. Close with a self-contained statement asking the office to log the caller's concern and noting that the caller is watching for the senator's position before deciding - phrased as a statement or a request-to-record, NEVER as a question aimed at the staffer, since it may be left on a voicemail.",
  },
  house: {
    support:
      "The caller SUPPORTS this nomination and asks the representative to urge the state's two senators to vote to confirm.",
    oppose:
      "The caller OPPOSES this nomination and asks the representative to urge the state's two senators to vote against confirming.",
    undecided:
      "The caller is CONCERNED about this nomination and has not settled on support or opposition. The script must register that concern and name the ONE thing that worries them - which must be about the POST and what it decides, never a claim about the nominee - and ask the representative to raise it with the state's two senators. Close with a self-contained statement asking the office to log the caller's concern, NEVER as a question aimed at the staffer, since it may be left on a voicemail.",
  },
};

/** The audience-specific framing block. The `house` one carries the honest
 *  account of what that office can and cannot do — the same three facts
 *  `bill.nominationHousePress` gives the reader in the panel, so the spoken
 *  script and the surrounding copy can never tell two different stories. */
const AUDIENCE_LINES: Record<NominationAudience, string> = {
  senator: `The script is read verbatim to BOTH of the caller's U.S. Senators' offices, separately. The Senate alone votes on nominations, so the script SHOULD address the office as a Senate office and SHOULD name the confirmation vote as the ask. Address the recipient as "Senator" or as "your office" - never "Representative," "Congressman," "Congresswoman," or "Congressperson," and never the Spanish "representante" or "congresista."`,
  house: `The script is read to the caller's U.S. REPRESENTATIVE's office. The representative has NO VOTE on this nomination and no formal role in it - the Senate decides it alone - and the script must never state or imply otherwise. Never ask the representative to vote, to support, or to oppose the nomination. The ask is that the representative press the two U.S. Senators from the caller's own state, publicly or privately. The script SHOULD say plainly that the caller knows the House has no vote here, so the office understands why the call was made. Address the recipient as "Representative" or as "your office" - never "Senator," and never the Spanish "senador" or "senadora."`,
};

function langLine(lang: 'en' | 'es'): string {
  return lang === 'es'
    ? 'Write the script in natural, warm Latin American Spanish (tú form). Use the placeholders [TU NOMBRE] and [TU CIUDAD O CÓDIGO POSTAL].'
    : 'Write the script in plain, warm English at an 8th-grade reading level. Use the placeholders [YOUR NAME] and [YOUR TOWN OR ZIP].';
}

export interface NominationScriptPromptInput {
  /** The stored record, verbatim — never a localized or rewritten copy. Like
   *  the bill builder, the model always receives the government's ENGLISH
   *  sentence as input content in both locales; only `langLine` changes to ask
   *  for Spanish output. `nominee_description` MUST be non-null: 14 of the 859
   *  civilian records (all Foreign Service promotion lists) carry none, and
   *  there is nothing to ground a script in for those. The caller gates on it —
   *  see app/api/script/route.ts. */
  nomination: Pick<
    Nomination,
    'citation' | 'nominee_description' | 'organization' | 'status' | 'last_action_text'
  >;
  stance: Stance;
  audience: NominationAudience;
  lang: 'en' | 'es';
}

/** The exact 30-second nomination call-script prompt. */
export function buildNominationScriptPrompt({
  nomination,
  stance,
  audience,
  lang,
}: NominationScriptPromptInput): string {
  const { citation } = nomination;
  // The government's own sentence is the ONLY substantive input. The caller
  // guarantees it is present; the fallback keeps this function total rather
  // than throwing inside a request handler, and is never reached in practice.
  const record = nomination.nominee_description ?? '';

  return `Write a 30-second phone script for a constituent calling a congressional office about a presidential nomination pending before the U.S. Senate.

${AUDIENCE_LINES[audience]}

Nomination: ${citation}
The Senate's own description of it, word for word: ${record}${
    nomination.organization ? `\nReceiving body: ${nomination.organization}` : ''
  }
Where it stands: ${nomination.status}${
    nomination.last_action_text ? `\nThe Senate's own last recorded action: ${nomination.last_action_text}` : ''
  }

${STANCE_LINES[audience][stance]}

${langLine(lang)}

Rules:
- 60-90 words. It must be comfortably readable aloud in 30 seconds.
- Structure: greeting + name placeholder + constituent location placeholder, the nomination by its number, the position, ONE concrete reason, a clear ask, thanks.
- NEVER characterize the nominee. The description above states only who they are, what post they are up for, and whom they would replace - it says NOTHING about their record, experience, views, politics, competence, or fitness. Do not praise them, criticize them, describe their career, guess at their positions, or attribute any belief or action to them. Inventing any of that would be a fabricated claim about a named private citizen.
- The ONE concrete reason must therefore be about the POST, not the person: what the office or body does, and why the caller cares who holds it. Ground it in the description and the receiving body above, and nowhere else.
- Greeting must be time-neutral: e.g. "Hello, my name is..." / "Hola, me llamo...". NEVER use a time-of-day greeting ("good morning," "good afternoon," "good evening," "buenos días," "buenas tardes," "buenas noches," or similar) - calls happen at any hour, including after business hours.
- No ambiguous "this" or "it": never use a bare "this" or "it" as a sentence's subject unless its antecedent is the noun immediately before it. Name what is being referred to instead - the nomination by its number, "this nomination," or the position or concern by name - so no sentence can be misheard as meaning the opposite of what is intended.
- Refer to the nomination exactly as "${citation}" - do not alter, translate, or extend that citation.
- Must work equally well read to a live staffer or left as a voicemail: the final sentence has to be a self-contained statement - never a question mark, and never a request whose meaning depends on a spoken reply or a callback.
- Strictly nonpartisan tone: no party language, no naming of the President or of any party, no attacks, no alarmism, no advocacy-group jargon.
- Do not invent facts beyond the record provided.
- Plain text only: no markdown, no asterisks, no bullet points, no headers.
- Output ONLY the script text, no commentary.`;
}

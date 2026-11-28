/** Pure rule for the commit-trailer check (scripts/check-commit-trailer.mjs; owner's answer T20, 2026-10-03; Antigravity handoff 2026-11-26). */

// Legacy Claude helper models (2026-11-12) and Antigravity / Gemini tiers (2026-11-26).
// The orchestrator's own commits are rare and may name Fable only when ALLOW_FABLE_TRAILER=1 is set.
export const ALLOWED_MODELS = ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 5.5'];
export const ALLOWED_ANTIGRAVITY_TRAILERS = [
  'Antigravity',
  'Gemini 4 Pro',
  'Gemini 4 Flash',
  'Gemini 4 Flash-Lite',
];

const LOOSE_TRAILER = /^Co-Authored-By:\s*Claude\b/im;
const LOOSE_TRAILER_G = /^Co-Authored-By:\s*Claude\b/gim;
const TRAILER = /^Co-Authored-By:\s*(Claude\b[^<\n]*?)\s*<noreply@anthropic\.com>\s*$/gim;

const LOOSE_AG_TRAILER = /^Co-Authored-By:\s*(Antigravity|Gemini)\b/im;
const LOOSE_AG_TRAILER_G = /^Co-Authored-By:\s*(Antigravity|Gemini)\b/gim;
const AG_TRAILER = /^Co-Authored-By:\s*((?:Antigravity|Gemini)\b[^<\n]*?)\s*<[^>\n]+>\s*$/gim;

/** @returns {string | null} a refusal line, or null when the message passes. */
export function checkMessage(message, { authorName = '', isMerge = false, env = {} } = {}) {
  const subject = (message.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '').trim();
  if (isMerge || /^Merge /.test(subject)) return null;
  if (authorName === 'oravan-sync' && subject.startsWith('chore(data):')) return null;

  // A human or plain-message commit carries no AI trailer lines at all: allowed.
  // core.hooksPath is shared by every worktree of the repo, so the hook must never block the owner.
  const hasSession = /^Claude-Session:\s*\S+/m.test(message);
  const mentionsClaude = LOOSE_TRAILER.test(message);
  const mentionsAntigravity = LOOSE_AG_TRAILER.test(message);
  if (!hasSession && !mentionsClaude && !mentionsAntigravity) return null;

  if (mentionsAntigravity) {
    const agModels = [...message.matchAll(AG_TRAILER)].map((m) => m[1].trim());
    if (agModels.length === 0 || agModels.length < (message.match(LOOSE_AG_TRAILER_G) ?? []).length) {
      return 'Commit refused: no valid "Co-Authored-By: <Antigravity|Gemini Model> <email>" trailer.';
    }
    for (const model of agModels) {
      if (!ALLOWED_ANTIGRAVITY_TRAILERS.includes(model)) {
        return `Commit refused: trailer names "${model}"; allowed: ${ALLOWED_ANTIGRAVITY_TRAILERS.join(', ')}.`;
      }
    }
    if (!hasSession && !mentionsClaude) return null;
  }

  const models = [...message.matchAll(TRAILER)].map((m) => m[1].trim());
  if (models.length === 0 || models.length < (message.match(LOOSE_TRAILER_G) ?? []).length) {
    return 'Commit refused: no valid "Co-Authored-By: Claude <Model> <noreply@anthropic.com>" trailer.';
  }
  const allowFable = env.ALLOW_FABLE_TRAILER === '1';
  for (const model of models) {
    if (/fable/i.test(model)) {
      if (allowFable) continue;
      return `Commit refused: trailer names "${model}"; helpers never run on Fable (the orchestrator sets ALLOW_FABLE_TRAILER=1 for its own commit).`;
    }
    if (!ALLOWED_MODELS.includes(model)) {
      return `Commit refused: trailer names "${model}"; allowed: ${ALLOWED_MODELS.join(', ')}.`;
    }
  }
  if (!hasSession) {
    return 'Commit refused: no "Claude-Session:" line.';
  }
  return null;
}

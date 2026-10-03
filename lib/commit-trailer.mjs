/** Pure rule for the commit-trailer check (scripts/check-commit-trailer.mjs; owner's answer T20, 2026-10-03). */

// The models a helper may name. The orchestrator's own commits are rare and may
// name Fable 5.1 only when the orchestrator itself wrote the change: it sets
// ALLOW_FABLE_TRAILER=1 for that commit.
export const ALLOWED_MODELS = ['Claude Opus 5.5', 'Claude Sonnet 5.5'];

const TRAILER = /^Co-Authored-By:\s*(Claude\b[^<\n]*?)\s*<noreply@anthropic\.com>\s*$/gim;

/** @returns {string | null} a refusal line, or null when the message passes. */
export function checkMessage(message, { authorName = '', isMerge = false, env = {} } = {}) {
  const subject = (message.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '').trim();
  if (isMerge || /^Merge /.test(subject)) return null;
  if (authorName === 'oravan-sync' && subject.startsWith('chore(data):')) return null;

  const models = [...message.matchAll(TRAILER)].map((m) => m[1].trim());
  if (models.length === 0) {
    return 'Commit refused: no "Co-Authored-By: Claude <Model> <noreply@anthropic.com>" trailer.';
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
  if (!/^Claude-Session:\s*\S+/m.test(message)) {
    return 'Commit refused: no "Claude-Session:" line.';
  }
  return null;
}

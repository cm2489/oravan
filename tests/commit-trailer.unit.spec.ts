import { expect, test } from '@playwright/test';
import { checkMessage } from '../lib/commit-trailer.mjs';

/*
 * The local commit-msg hook's rule (owner's answer T20, 2026-10-03): a helper's
 * commit names the model that wrote it, never Fable.
 */
const SESSION = 'Claude-Session: https://claude.ai/code/session_x';
const msg = (model: string, subject = 'Fix a thing') =>
  `${subject}\n\nBody.\n\nCo-Authored-By: ${model} <noreply@anthropic.com>\n${SESSION}\n`;

test('a Sonnet 5.5 and an Opus 5.5 trailer with a session line pass', () => {
  expect(checkMessage(msg('Claude Sonnet 5.5'))).toBeNull();
  expect(checkMessage(msg('Claude Opus 5.5'))).toBeNull();
});

test('a Fable trailer fails', () => {
  expect(checkMessage(msg('Claude Fable 5.1'))).toMatch(/Fable/);
});

test('a human commit with no Claude lines passes', () => {
  expect(checkMessage('Fix a thing\n\nPlain body.\n')).toBeNull();
});

test('a session line without a valid Claude trailer fails (a helper that forgot)', () => {
  expect(checkMessage(`Fix a thing\n\n${SESSION}\n`)).toMatch(/no valid "Co-Authored-By/);
  expect(
    checkMessage(`Fix\n\nCo-Authored-By: Claude Sonnet 5.5 <other@example.com>\n${SESSION}\n`),
  ).toMatch(/no valid "Co-Authored-By/);
});

test('an unlisted model fails, and a missing session line fails', () => {
  expect(checkMessage(msg('Claude Haiku 4'))).toMatch(/allowed/);
  expect(
    checkMessage('Fix\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\n'),
  ).toMatch(/Claude-Session/);
});

test('a pipeline data commit is exempt even with a bad Claude line; others are not', () => {
  const data = 'chore(data): hot-bill refresh 2026-10-03T17Z\n';
  expect(checkMessage(data, { authorName: 'oravan-sync' })).toBeNull();
  const bad = `${data}\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\n${SESSION}\n`;
  expect(checkMessage(bad, { authorName: 'oravan-sync' })).toBeNull();
  expect(checkMessage(bad, { authorName: 'Someone' })).not.toBeNull();
});

test('a merge commit is exempt', () => {
  expect(checkMessage("Merge branch 'main' into x\n")).toBeNull();
  expect(checkMessage('Anything\n', { isMerge: true })).toBeNull();
});

test('ALLOW_FABLE_TRAILER=1 passes a Fable trailer', () => {
  expect(checkMessage(msg('Claude Fable 5.1'), { env: { ALLOW_FABLE_TRAILER: '1' } })).toBeNull();
});

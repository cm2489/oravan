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

test('a missing trailer fails', () => {
  expect(checkMessage(`Fix a thing\n\n${SESSION}\n`)).toMatch(/no "Co-Authored-By/);
});

test('an unlisted model fails, and a missing session line fails', () => {
  expect(checkMessage(msg('Claude Haiku 4'))).toMatch(/allowed/);
  expect(
    checkMessage('Fix\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\n'),
  ).toMatch(/Claude-Session/);
});

test('a pipeline data commit is exempt; the same subject from anyone else is not', () => {
  const data = 'chore(data): hot-bill refresh 2026-10-03T17Z\n';
  expect(checkMessage(data, { authorName: 'oravan-sync' })).toBeNull();
  expect(checkMessage(data, { authorName: 'Someone' })).not.toBeNull();
  expect(checkMessage('Fix a thing\n', { authorName: 'oravan-sync' })).not.toBeNull();
});

test('a merge commit is exempt', () => {
  expect(checkMessage("Merge branch 'main' into x\n")).toBeNull();
  expect(checkMessage('Anything\n', { isMerge: true })).toBeNull();
});

test('ALLOW_FABLE_TRAILER=1 passes a Fable trailer', () => {
  expect(checkMessage(msg('Claude Fable 5.1'), { env: { ALLOW_FABLE_TRAILER: '1' } })).toBeNull();
});

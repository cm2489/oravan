/*
 * "Production serves a build that already contains our commit" — the ONE
 * copy, used by scripts/verify-deploy.mjs and pinned by
 * tests/verify-deploy.unit.spec.ts. Stdlib only (git via child_process), so
 * the deploy check still runs on a bare Actions runner.
 *
 * Why (2026-10-04, pipeline doctor): the nightly of 2026-10-03 (run
 * 37142341446) pushed data commit 3fdb1fd, then six merges landed on main
 * within twenty minutes. The host built the newest head and skipped the
 * intermediate one, so production served 372af6f — a descendant of 3fdb1fd,
 * carrying every byte of that night's data — and the exact-SHA poll timed
 * out red. That red also skipped the IndexNow ping, the CI dispatch and the
 * call-script pre-generation behind it. A build that descends from the
 * pushed commit proves the same thing the exact SHA proves: the deploy
 * pipeline is alive and the data is live.
 *
 * Failure posture: any git error answers false, so the poll keeps waiting
 * exactly as it did before. A shallow history that cannot see the path also
 * answers false. Nothing here can turn a dropped deploy green.
 */
import { spawnSync } from 'node:child_process';

const SHA = /^[0-9a-f]{40}$/;

/**
 * Does `seenSha` (the build production serves) descend from `expectSha`
 * (the commit this run pushed)? Fetches `ref` from `remote` first, shallowly,
 * so a newer main head the runner has never seen becomes visible.
 *
 * @param {string} expectSha
 * @param {string | null} seenSha
 * @param {{ cwd?: string, remote?: string, ref?: string, depth?: number }} [opts]
 * @returns {boolean}
 */
export function buildDescendsFrom(expectSha, seenSha, opts = {}) {
  const { cwd = process.cwd(), remote = 'origin', ref = 'main', depth = 200 } = opts;
  if (!SHA.test(expectSha ?? '') || !SHA.test(seenSha ?? '')) return false;
  if (expectSha === seenSha) return true;
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  // Best-effort: if the fetch fails, the objects may already be present.
  git(['fetch', '--quiet', `--depth=${depth}`, remote, ref]);
  return git(['merge-base', '--is-ancestor', expectSha, seenSha]).status === 0;
}

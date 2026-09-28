/**
 * THE PRIVATE OPS TRACKER — where the operator-only issue writers post.
 *
 * cm2489/oravan is public, and so is everything its Actions runs write: an
 * issue, a comment, a run log, a job summary. (Checked 2026-09-28: a daily
 * metrics run page answers 200 to a signed-out request, and that run's log
 * ended "daily metrics digest posted for 2026-09-26 (mcp total …; site page
 * views …)".) The daily metrics digest carries traffic numbers — MCP calls,
 * script generations, site page views, the distinct-address estimate — and
 * the pipeline-health report carries the day's spend estimate. On the owner's
 * 2026-09-27 "keep going" on the recommendation to keep the code public and
 * move beta feedback and the traffic digest to a private ops repo, those
 * writers post to OPS_REPO below instead.
 *
 * NO FALLBACK TO THE PUBLIC REPO, by construction:
 *   - the ONLY token that can write to OPS_REPO is the Actions secret named
 *     OPS_TOKEN_ENV (a fine-grained PAT, Issues read/write on OPS_REPO);
 *   - when it is missing, opsDestination() returns { ok: false } and carries
 *     no repo at all, so a caller has nothing to post to — it writes a
 *     number-free notice to the job summary (withheldSummary) and a
 *     ::warning:: to the log, and exits 0;
 *   - daily-metrics.yml holds `issues: read`, not `issues: write`, so even a
 *     bug that aimed a write at the public repo with the runner's own
 *     GITHUB_TOKEN would be refused by GitHub.
 * The withheld notice deliberately carries no number: a job summary on a
 * public repo is as public as an issue, so "write the digest to the summary
 * instead" would re-publish exactly what this module exists to move.
 *
 * TWO TOKENS, ONE PROCESS. The digest job READS the public repo (the Actions
 * run list and logs the pipeline-health report is built from, and the open
 * issues the "Awaiting your word" section lists) with the runner's
 * GITHUB_TOKEN, and WRITES to OPS_REPO with the PAT. `gh` reads GH_TOKEN
 * before GITHUB_TOKEN, so the PAT is injected as GH_TOKEN on the ops calls
 * only (opsGhEnv) and stripped from the public calls (publicGhEnv). The
 * workflow must therefore never set GH_TOKEN at step level on the compute
 * step: it would silently point every public read at a token that cannot
 * see the public repo's Actions. tests/ops-repo.unit.spec.ts pins that.
 *
 * WHAT STAYS PUBLIC, and why — every other issue writer in this repo:
 *   moment-watch.yml    `moment-candidate` issues and the standing
 *                       `moment-review` issue. moment-approve.yml runs on
 *                       the `approve-moment` label being added to a
 *                       candidate issue IN THIS REPO (an `issues: labeled`
 *                       event), and a label event in another repository
 *                       cannot trigger this repository's workflow — moving
 *                       them would break the approve path. They carry the
 *                       public record and an AI draft, no traffic or spend.
 *   moment-approve.yml  comments on those same candidate issues.
 *   refresh-legislators.yml
 *                       `data-vacancy` and the standing `redistricting-watch`
 *                       board — vacant seats and map changes, public record.
 *   sync-bills.yml      `journey-corpus` and `scaffold-corpus` — floor
 *                       sentences from the Congressional Record.
 * None of them posts a traffic or spend number.
 *
 * Pure: no I/O except writeJobSummary, which appends to the file GitHub names
 * in GITHUB_STEP_SUMMARY and does nothing without it.
 */
import { appendFileSync } from 'node:fs';

/** This codebase's repository. Public. Read-only from the digest job. */
export const PUBLIC_REPO = 'cm2489/oravan';

/** The private operator tracker (created 2026-09-28, private, one collaborator). */
export const OPS_REPO = 'cm2489/oravan-ops';

/** The Actions secret (and env var) holding the PAT that can write to OPS_REPO. */
export const OPS_TOKEN_ENV = 'OPS_ISSUES_TOKEN';

/**
 * Where an operator-only writer may post, or why it may not.
 *
 * Never returns PUBLIC_REPO, whatever the environment says: there is no
 * override variable to point it anywhere else, on purpose — an override is
 * exactly how a misconfiguration would put traffic numbers back in public.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ ok: true, repo: string, token: string } | { ok: false, reason: string }}
 */
export function opsDestination(env = process.env) {
  const raw = env?.[OPS_TOKEN_ENV];
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token) {
    return {
      ok: false,
      reason: `${OPS_TOKEN_ENV} is not set in this environment, so nothing can be posted to the private ops tracker (${OPS_REPO}); nothing is posted to the public repo instead.`,
    };
  }
  return { ok: true, repo: OPS_REPO, token };
}

/**
 * The environment for a `gh` call that WRITES to (or reads) OPS_REPO:
 * GH_TOKEN, which `gh` prefers over GITHUB_TOKEN, is the ops PAT.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} token
 */
export function opsGhEnv(env, token) {
  return { ...env, GH_TOKEN: token };
}

/**
 * The environment for a `gh` call that READS the public repo: GH_TOKEN
 * removed, so `gh` falls through to the runner's GITHUB_TOKEN (locally, to
 * whatever `gh auth` holds).
 *
 * @param {Record<string, string | undefined>} env
 */
export function publicGhEnv(env) {
  const rest = { ...env };
  delete rest.GH_TOKEN;
  return rest;
}

/**
 * A reference to an issue that reads correctly from inside OPS_REPO: bare
 * `#N` for an ops issue, `cm2489/oravan#N` for a public one — a bare `#N` in
 * an ops comment would link to the ops repo's own issue N.
 *
 * @param {string} repo
 * @param {number} number
 */
export function issueRefFromOps(repo, number) {
  return repo === OPS_REPO ? `#${number}` : `${repo}#${number}`;
}

/**
 * The job-summary notice written when a writer is withheld. It says what was
 * not posted, why, and how to arm it — and carries NO number, because this
 * summary is on a public repo's run page.
 *
 * @param {{ what: string, reason: string }} input
 * @returns {string}
 */
export function withheldSummary({ what, reason }) {
  return [
    `### ${what}: not posted`,
    '',
    reason,
    '',
    `To arm it, add a fine-grained personal access token with **Issues: read and write** on \`${OPS_REPO}\` ` +
      `as this repository's Actions secret \`${OPS_TOKEN_ENV}\`. The numbers stay in the counters database ` +
      'and the next armed run reads them; nothing is lost but the day\'s comment.',
    '',
    '_This summary is public, so it deliberately shows no traffic or spend figure._',
    '',
  ].join('\n');
}

/**
 * Append markdown to the run's job summary. A no-op (returns false) outside
 * Actions, where GITHUB_STEP_SUMMARY is unset.
 *
 * @param {string} markdown
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean} whether anything was written
 */
export function writeJobSummary(markdown, env = process.env) {
  const file = env?.GITHUB_STEP_SUMMARY;
  if (!file) return false;
  appendFileSync(file, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8');
  return true;
}

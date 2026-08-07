import { expect, test } from '@playwright/test';
import {
  buildNominationScriptPrompt,
  NOMINATION_AUDIENCES,
  NOMINATION_PROMPT_VERSION,
  type NominationAudience,
} from '../lib/nomination-script';
import { buildScriptPrompt, PROMPT_VERSION } from '../lib/scriptprompt';
import { contentVersion, nominationContentVersion, scriptKey } from '../lib/scriptcache';
import { STORED_NOMINATION_STATUSES } from '../lib/nomination-status.mjs';
import en from '../messages/en.json';
import es from '../messages/es.json';
import type { Stance } from '../lib/types';

/*
 * THE NOMINATION CALL SCRIPT — the prompt, its two audiences, and the cache
 * key that keeps them apart.
 *
 * Everything here is pure: no network, no Anthropic call, no corpus. The
 * prompt is a string, so the rules that matter are assertions about that
 * string. That is a real limit and worth stating — this suite proves the model
 * is TOLD the right things, not that it obeys them. What it can and does stop
 * is the class of failure that has actually happened in this codebase: a rule
 * silently dropped in an edit, a cache key that serves one audience's script
 * for the other, and a status the UI has no label for.
 */

const NOMINATION = {
  citation: 'PN852-1',
  nominee_description:
    'Jeffrey Brodsky, of Florida, to be a Governor of the United States Postal Service for a term expiring December 8, 2029, vice William Zollars, term expired.',
  organization: 'United States Postal Service',
  status: 'exec_calendar' as const,
  last_action_text: 'Placed on Senate Executive Calendar. Calendar No. 838.',
};

const build = (audience: NominationAudience, stance: Stance = 'support', lang: 'en' | 'es' = 'en') =>
  buildNominationScriptPrompt({ nomination: NOMINATION, stance, audience, lang });

/* ------------------------------------------------------------------ *
 * 1 · Chamber specificity — the reason this is a FORK of
 *     lib/scriptprompt.ts and not a flag on it.
 * ------------------------------------------------------------------ */
test.describe('chamber specificity', () => {
  test('the bill prompt promises chamber-neutrality; the nomination prompt must not inherit it', () => {
    const bill = buildScriptPrompt({
      bill: {
        bill_type: 'hr',
        bill_number: 1,
        short_title: 'A Bill',
        title: 'A Bill',
        ai_summary: 'It does a thing.',
        status: 'committee',
      },
      stance: 'support',
      lang: 'en',
    });
    // The bill prompt's load-bearing sentence, quoted from the file it lives in.
    expect(bill).toContain('never assume, name, or imply a single chamber');
    for (const audience of NOMINATION_AUDIENCES) {
      expect(build(audience), audience).not.toContain(
        'never assume, name, or imply a single chamber'
      );
    }
  });

  test('the senator script names the Senate and the confirmation vote', () => {
    const p = build('senator');
    expect(p).toContain('Senate');
    expect(p).toContain('vote to confirm');
    // …and forbids the other chamber's titles, so a script written for two
    // Senate offices can never address one of them as a House member.
    expect(p).toContain('never "Representative,"');
  });

  test('the House script says the representative has NO vote, and never asks for one', () => {
    const p = build('house');
    expect(p).toContain('NO VOTE on this nomination and no formal role');
    expect(p).toContain('never state or imply otherwise');
    expect(p).toContain('Never ask the representative to vote');
    // The ask is the senators the caller shares a state with — the owner's
    // 2026-08-06 ruling, in the same words `bill.nominationHousePress` uses.
    expect(p).toContain('press the two U.S. Senators from');
    expect(p).toContain('never "Senator,"');
  });

  test('no stance ever asks a representative to vote on the nomination', () => {
    for (const stance of ['support', 'oppose', 'undecided'] as Stance[]) {
      const p = build('house', stance);
      expect(p, stance).not.toMatch(/asks the representative to vote (to confirm|against)/);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2 · The rule whose failure is a defamation risk, not a copy defect.
 *
 *     The record names a private citizen and says NOTHING about their
 *     record, views, or fitness. A model asked for "one concrete reason"
 *     to support or oppose a named person will invent exactly those
 *     things unless it is stopped, and the invention would publish under
 *     an Oravan label. This is pinned on every audience and every stance
 *     because an edit that drops it from one branch drops it silently.
 * ------------------------------------------------------------------ */
test('every audience × stance carries the no-characterization rule and the office-not-person reason', () => {
  for (const audience of NOMINATION_AUDIENCES) {
    for (const stance of ['support', 'oppose', 'undecided'] as Stance[]) {
      const p = build(audience, stance);
      const at = `${audience}/${stance}`;
      expect(p, at).toContain('NEVER characterize the nominee');
      expect(p, at).toContain('about the POST, not the person');
      expect(p, at).toContain('fabricated claim about a named private citizen');
      expect(p, at).toContain('Do not invent facts beyond the record provided');
    }
  }
});

/* ------------------------------------------------------------------ *
 * 3 · The rules carried over from the bill script. Each one was written
 *     for a reason recorded in lib/scriptprompt.ts's own comments, and
 *     none of those reasons stops applying because the vehicle changed.
 * ------------------------------------------------------------------ */
test('the inherited script rules survive the fork', () => {
  for (const audience of NOMINATION_AUDIENCES) {
    const p = build(audience);
    expect(p, audience).toContain('Greeting must be time-neutral');
    expect(p, audience).toContain('calls happen at any hour');
    expect(p, audience).toContain('left as a voicemail');
    expect(p, audience).toContain('never a question mark');
    expect(p, audience).toContain('Strictly nonpartisan tone');
    expect(p, audience).toContain('60-90 words');
    expect(p, audience).toContain('Plain text only');
  }
});

test('the government record is quoted verbatim and the citation is fixed', () => {
  const p = build('senator');
  expect(p).toContain(NOMINATION.nominee_description);
  expect(p).toContain(NOMINATION.last_action_text);
  expect(p).toContain(NOMINATION.organization);
  expect(p).toContain(`Refer to the nomination exactly as "${NOMINATION.citation}"`);
});

test('only the language line changes between locales — the record input stays English', () => {
  const enPrompt = build('senator', 'support', 'en');
  const esPrompt = build('senator', 'support', 'es');
  // Same deliberate behavior lib/scriptprompt.ts documents: the model always
  // receives the government's English sentence; only the output language asks
  // to change.
  expect(esPrompt).toContain(NOMINATION.nominee_description);
  expect(esPrompt).toContain('Latin American Spanish');
  expect(enPrompt).toContain('8th-grade reading level');
  expect(enPrompt.replace('Write the script in plain, warm English at an 8th-grade reading level. Use the placeholders [YOUR NAME] and [YOUR TOWN OR ZIP].', '')).toBe(
    esPrompt.replace('Write the script in natural, warm Latin American Spanish (tú form). Use the placeholders [TU NOMBRE] and [TU CIUDAD O CÓDIGO POSTAL].', '')
  );
});

/* ------------------------------------------------------------------ *
 * 4 · The cache key. Two different scripts exist for the same
 *     (slug, stance, lang) — one per audience — and the cache must never
 *     serve one for the other. The audience rides INSIDE the version
 *     hash (see lib/scriptcache.ts) so the key SHAPE stays the single
 *     shape scripts/check-key-namespaces.mjs gates on.
 * ------------------------------------------------------------------ */
test.describe('nominationContentVersion', () => {
  const record = NOMINATION.nominee_description;

  test('the two audiences never share a version', () => {
    expect(nominationContentVersion(record, 'senator')).not.toBe(
      nominationContentVersion(record, 'house')
    );
  });

  /*
   * …AND THE KEY THE CACHE IS ACTUALLY READ AND WRITTEN WITH DIFFERS, which is
   * the claim that matters and is one composition step away from the one above.
   * Asserted the day the panel started REQUESTING the house audience
   * (2026-08-06): until then the branch was unreachable, so a collision between
   * the two audiences was a latent bug rather than a live one. Both halves are
   * pinned — the keys differ, and they differ ONLY in the version segment, so
   * the five-segment shape scripts/check-key-namespaces.mjs gates on is
   * untouched.
   */
  test('the composed cache key differs by audience, and only in the version segment', () => {
    const base = { slug: 'pn-852-1-119', stance: 'support', lang: 'en' as const };
    const senator = scriptKey({ ...base, version: nominationContentVersion(record, 'senator') });
    const house = scriptKey({ ...base, version: nominationContentVersion(record, 'house') });
    expect(senator).not.toBe(house);
    expect(senator.slice(0, senator.lastIndexOf(':'))).toBe(house.slice(0, house.lastIndexOf(':')));
  });

  test('it is stable for the same inputs and moves when the record does', () => {
    expect(nominationContentVersion(record, 'senator')).toBe(
      nominationContentVersion(record, 'senator')
    );
    expect(nominationContentVersion(record + ' (corrected)', 'senator')).not.toBe(
      nominationContentVersion(record, 'senator')
    );
  });

  /*
   * The two prompt lineages are independent ON PURPOSE: bumping the bill
   * prompt must not invalidate every nomination script, and vice versa. This
   * pins that they are separate inputs rather than the same constant read
   * twice — with equal values they would still collide the day one is bumped.
   */
  test('the bill and nomination version hashes are separate lineages', () => {
    expect(typeof PROMPT_VERSION).toBe('string');
    expect(typeof NOMINATION_PROMPT_VERSION).toBe('string');
    expect(contentVersion(record)).not.toBe(nominationContentVersion(record, 'senator'));
  });
});

/* ------------------------------------------------------------------ *
 * 5 · Every status the mapper can return has a label, in BOTH locales.
 *
 *     The same failure lib/moments.ts's signal-type pin exists to stop,
 *     one corpus over: next-intl falls through to printing the raw key,
 *     so a missing `unclassified` label would put the literal string
 *     "unclassified" on a nomination card in both languages rather than
 *     throwing. `unclassified` is included deliberately — it is the
 *     honest verdict when no rule matched, and it needs neutral,
 *     claim-free copy more than any classified status does.
 * ------------------------------------------------------------------ */
test('every STORED_NOMINATION_STATUSES member has an EN and ES label', () => {
  const enStatus = en.nominations.status as Record<string, string>;
  const esStatus = es.nominations.status as Record<string, string>;
  for (const status of STORED_NOMINATION_STATUSES) {
    expect(enStatus, `en ${status}`).toHaveProperty(status);
    expect(esStatus, `es ${status}`).toHaveProperty(status);
    expect(enStatus[status].length, `en ${status}`).toBeGreaterThan(0);
    expect(esStatus[status].length, `es ${status}`).toBeGreaterThan(0);
  }
  // And nothing extra: a label with no status behind it is a label the UI can
  // never reach, which is how a stale vocabulary survives a rename.
  expect(Object.keys(enStatus).sort()).toEqual([...STORED_NOMINATION_STATUSES].sort());
  expect(Object.keys(esStatus).sort()).toEqual([...STORED_NOMINATION_STATUSES].sort());
});

import { expect, test } from '@playwright/test';
import { lintForbidden, maskPartyVoteCounts } from '../lib/moments-gate.mjs';

/*
 * A PARTY COUNT ON A RECORDED VOTE IS A RECORD FACT (2026-09-29, the owner's
 * card l12; docs/constitution-log.md#party-counts-2026-09-29).
 *
 * The owner, 2026-09-26: "You handle the rule change. This is not that big of
 * a deal to me, I just need it to work." The nonpartisan lint (lintForbidden)
 * rejected any party name, so it also rejected how a roll call divided. The
 * exception is narrow: a COUNT of a party's members, tied to a recorded vote
 * position or tally, is masked before the table runs. These pin both
 * directions, in both languages.
 */

const PARTY = { en: 'party name', es: 'nombre de partido' } as const;

test.describe('a party count tied to a recorded vote passes', () => {
  const clean: [keyof typeof PARTY, string][] = [
    ['en', 'Every Democrat and 3 Republicans voted yes.'],
    ['en', 'All 47 Democrats voted against it; 3 Republicans voted for it.'],
    ['en', 'The resolution failed 49–51: every Republican voted no, and all 45 Democrats and 2 independents voted yes.'],
    ['en', 'Republicans: 4 yea, 49 nay.'],
    ['en', '3 Republican senators voted yes.'],
    ['en', 'All but two Republicans voted no.'],
    ['en', 'It passed 52–48, with 3 Republicans voting yes.'],
    ['en', 'Three Republicans joined every Democrat in voting yes.'],
    ['en', 'Democrats voted 45–2 for the amendment.'],
    ['en', 'No Republicans voted in favor.'],
    ['en', 'Two Democrats did not vote.'],
    ['es', 'Todos los demócratas y 3 republicanos votaron a favor.'],
    ['es', 'Los 47 demócratas votaron en contra.'],
    ['es', 'Tres senadores republicanos votaron a favor.'],
    ['es', 'Ningún republicano votó a favor.'],
    ['es', 'Republicanos: 4 a favor, 49 en contra.'],
    ['es', 'Tres republicanos se unieron a todos los demócratas para votar a favor.'],
    ['es', 'Dos demócratas no votaron.'],
  ];
  for (const [lang, text] of clean) {
    test(`${lang}: ${text}`, () => {
      expect(lintForbidden(text, lang)).toEqual([]);
    });
  }
});

test.describe('party-coded advocacy still fails', () => {
  const dirty: [keyof typeof PARTY, string, string[]][] = [
    // No count: a party as an actor.
    ['en', 'Republicans want to gut the rule', [PARTY.en]],
    ['en', 'Democrats are trying to protect it', [PARTY.en]],
    ['en', 'Republicans voted no.', [PARTY.en]],
    // A count, but no recorded position: a motive, a request, an addressee.
    ['en', 'Every Republican voted to gut the program.', [PARTY.en]],
    ['en', 'Tell every Democrat to vote yes.', [PARTY.en]],
    ['en', 'Call the 3 Republicans who voted yes.', [PARTY.en]],
    // Never a count.
    ['en', 'The GOP voted no.', [PARTY.en]],
    ['en', 'The Democratic Party voted as a bloc.', [PARTY.en]],
    // The mask takes out the count and nothing else in the sentence.
    ['en', 'Every Democrat voted yes to stop the war.', ['stop']],
    ['en', 'All 53 Republicans voted to block it.', ['block', PARTY.en]],
    ['en', '3 Republicans voted yes, and Democrats want to stop it.', ['stop', PARTY.en]],
    ['es', 'Los republicanos aprobaron la medida.', [PARTY.es]],
    ['es', 'Los republicanos votaron en contra.', [PARTY.es]],
    ['es', 'Todos los demócratas quieren detener la ley.', ['detener', PARTY.es]],
    ['es', 'Pide a cada republicano que vote no.', [PARTY.es]],
  ];
  for (const [lang, text, words] of dirty) {
    test(`${lang}: ${text}`, () => {
      expect(lintForbidden(text, lang).sort()).toEqual([...words].sort());
    });
  }
});

test('the mask changes only the count phrase', () => {
  expect(maskPartyVoteCounts('Every Democrat and 3 Republicans voted yes to stop the war.', 'en')).toBe(
    '  to stop the war.',
  );
  expect(maskPartyVoteCounts('No party count here.', 'en')).toBe('No party count here.');
  expect(maskPartyVoteCounts('Los republicanos votaron en contra.', 'es')).toBe('Los republicanos votaron en contra.');
});

test('the quoted-title escape still runs first', () => {
  expect(lintForbidden('the "Stop Harmful Schemes Act" of 2026', 'en')).toEqual([]);
});

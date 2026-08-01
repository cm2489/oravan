import { expect, test } from '@playwright/test';
import { getMoments } from '../lib/moments';
import {
  getMomentSearchTeasers,
  matchMoments,
  type MomentSearchTeaser,
} from '../lib/moments-ui';

/*
 * Search pinning (spec §7.3). The matcher is the whole feature: it runs on
 * every keystroke in the bills browser and decides whether a reader who typed
 * a story's name is shown the question it belongs to or the dead end "No bills
 * match" — which is exactly what "ukraine" returned for a year while
 * data/moments.json carried the alias all along.
 *
 * These pin the rules, corpus-free (hand-built teasers) so they can't rot when
 * a moment opens or settles, plus two facts about the real corpus that the
 * pure matcher cannot state on its own.
 */

const teaser = (over: Partial<MomentSearchTeaser> & { id: string }): MomentSearchTeaser => ({
  name: 'A question',
  dek: 'A one-line dek.',
  aliases: [],
  ...over,
});

const UKRAINE = teaser({
  id: 'ukraine-aid',
  name: 'The Ukraine aid question',
  aliases: ['ukraine', 'ukraine aid', 'kyiv'],
});

const FUNDING = teaser({
  id: 'government-funding',
  name: 'The government funding deadline',
  aliases: ['shutdown', 'continuing resolution'],
});

const ALL = [UKRAINE, FUNDING];
const ids = (ms: MomentSearchTeaser[]) => ms.map((m) => m.id);

test.describe('matchMoments — the ≥2-character floor', () => {
  test('a one-character query matches nothing, even though every alias contains it', () => {
    // 'u' is inside "ukraine"; 'a' is inside every string in the fixture. A
    // single letter is not a search, and pinning on one would put a moment
    // above the results the instant the reader started typing.
    expect(matchMoments('u', ALL)).toEqual([]);
    expect(matchMoments('a', ALL)).toEqual([]);
  });

  test('an empty or whitespace-only query matches nothing', () => {
    expect(matchMoments('', ALL)).toEqual([]);
    expect(matchMoments('   ', ALL)).toEqual([]);
  });

  test('two characters is the floor, not three', () => {
    expect(ids(matchMoments('uk', ALL))).toEqual(['ukraine-aid']);
  });
});

test.describe('matchMoments — bidirectional containment', () => {
  test('a partial word matches the alias that contains it (still typing)', () => {
    expect(ids(matchMoments('ukr', ALL))).toEqual(['ukraine-aid']);
    expect(ids(matchMoments('shut', ALL))).toEqual(['government-funding']);
  });

  test('a whole sentence matches the alias it contains (typed a phrase)', () => {
    expect(ids(matchMoments('what is happening in ukraine today', ALL))).toEqual(['ukraine-aid']);
    expect(ids(matchMoments('is there going to be a shutdown', ALL))).toEqual([
      'government-funding',
    ]);
  });

  test('trims and lowercases both sides', () => {
    expect(ids(matchMoments('  UKRAINE  ', ALL))).toEqual(['ukraine-aid']);
    expect(ids(matchMoments('KYIV', ALL))).toEqual(['ukraine-aid']);
  });

  test('a query that matches nothing returns nothing', () => {
    expect(matchMoments('zzzzqqq', ALL)).toEqual([]);
  });

  test('one query may pin more than one moment', () => {
    const both = [
      teaser({ id: 'a', name: 'A', aliases: ['border'] }),
      teaser({ id: 'b', name: 'B', aliases: ['border wall'] }),
    ];
    expect(ids(matchMoments('border', both))).toEqual(['a', 'b']);
  });
});

test.describe('matchMoments — the name matches too', () => {
  test('the localized name matches even when no alias repeats it', () => {
    // "deadline" is in the name and in none of the aliases.
    expect(ids(matchMoments('deadline', ALL))).toEqual(['government-funding']);
    expect(ids(matchMoments('the government funding deadline', ALL))).toEqual([
      'government-funding',
    ]);
  });

  test('a moment with no aliases at all is still findable by name', () => {
    const bare = [teaser({ id: 'bare', name: 'The redistricting question' })];
    expect(ids(matchMoments('redistricting', bare))).toEqual(['bare']);
  });
});

test.describe('matchMoments — degenerate aliases cannot pin everything', () => {
  test('a one-character alias is ignored in both directions', () => {
    // Without the floor, `query.includes(alias)` would make "a" pin this
    // moment for essentially every query a reader could type.
    const junk = [teaser({ id: 'junk', name: 'Zzz', aliases: ['a', '  ', 'ukraine'] })];
    expect(matchMoments('what is happening today', junk)).toEqual([]);
    expect(ids(matchMoments('ukraine', junk))).toEqual(['junk']);
  });
});

test.describe('getMomentSearchTeasers — live only, localized, aliases carried', () => {
  test('pins exactly the live moments — never stale, settled, or retired', () => {
    const live = getMoments().filter((m) => m.state === 'live');
    const teasers = getMomentSearchTeasers('en');
    expect(ids(teasers).sort()).toEqual(live.map((m) => m.id).sort());
    // The rule app/[locale]/moments/page.tsx states in prose: stale still
    // renders on that page, and is dropped from the strip and from pinning.
    for (const m of getMoments()) {
      if (m.state !== 'live') expect(ids(teasers)).not.toContain(m.id);
    }
  });

  test('each locale carries its own name, dek, and alias list', () => {
    const en = getMomentSearchTeasers('en');
    const es = getMomentSearchTeasers('es');
    expect(ids(en)).toEqual(ids(es));
    const byId = new Map(getMoments().map((m) => [m.id, m]));
    for (const t of en) {
      const m = byId.get(t.id)!;
      expect(t.name).toBe(m.name.en);
      expect(t.aliases).toEqual(m.aliases.en);
      expect(t.dek.length).toBeGreaterThan(0);
    }
    for (const t of es) {
      const m = byId.get(t.id)!;
      expect(t.name).toBe(m.name.es);
      expect(t.aliases).toEqual(m.aliases.es);
    }
  });

  test('every live alias, in both locales, actually pins its own moment', () => {
    // The round trip: a curator writes an alias, and a reader who types it
    // lands on that moment. A one-character alias would silently never fire.
    for (const locale of ['en', 'es'] as const) {
      const teasers = getMomentSearchTeasers(locale);
      for (const t of teasers) {
        for (const alias of t.aliases) {
          expect(ids(matchMoments(alias, teasers)), `${t.id}/${locale}: "${alias}"`).toContain(t.id);
        }
      }
    }
  });
});

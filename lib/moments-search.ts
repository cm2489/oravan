/*
 * The Big Question search matcher — the ONE piece of Moments logic the
 * browser runs. components/BillsBrowser.tsx ('use client') calls
 * `matchMoments` on every keystroke, so everything this file imports ships to
 * every visitor as JavaScript.
 *
 * KEEP THIS FILE IMPORT-FREE. It used to live in lib/moments-ui.ts, which
 * reads the bill, nomination, Moments and moment-updates corpora at module
 * scope; importing one pure function from there put all of data/ — a single
 * 23 MB client chunk — on /bills and on every page that prefetches it (the
 * 2026-09-27 audit, card a6). The server side of the feature stays where it
 * was: lib/moments-ui.ts `getMomentSearchTeasers` builds the teasers on the
 * server and the page passes them in as props, so the browser gets two short
 * localized strings and an alias list per question, never a corpus.
 *
 * Two gates hold the line: scripts/check-client-imports.mjs fails CI if any
 * 'use client' module can reach a data/ file through its imports, and
 * scripts/check-client-bundle.mjs fails it if a built client chunk carries
 * corpus text or outgrows its size budget.
 *
 * lib/moments-ui.ts re-exports both names below, so server code and the unit
 * specs keep importing them from there unchanged.
 */

/**
 * A live moment reduced to exactly what a pinned search row needs: the two
 * strings it RENDERS (name, dek) and the strings it MATCHES ON and never
 * renders.
 */
export interface MomentSearchTeaser {
  id: string;
  /** Localized display name. */
  name: string;
  /** First sentence of the localized summary — AI-drafted, labeled at the
   *  render site like every other dek. */
  dek: string;
  /**
   * SEARCH-ONLY, NEVER RENDERED — the contract lib/moments.ts states on the
   * field itself. Aliases are the words the press uses ("shutdown",
   * "strikes on iran"); a moment's NAME is the neutral one we chose. Echoing
   * an alias back to a reader would put a headline's framing in our voice on
   * a nonpartisan surface, so no consumer of this type may print them.
   */
  aliases: string[];
}

/**
 * Two characters. Below that every query matches something under the
 * containment rule below ("a" is inside "war powers"), which is not a search
 * result, it is noise on top of the reader's actual results.
 */
const MIN_QUERY = 2;

/**
 * Which moments a query pins. Pure — no data access, no clock, no locale
 * logic — so the browser can call it on every keystroke and a unit test can
 * pin its rules without the corpus.
 *
 * BIDIRECTIONAL CONTAINMENT, because the two failures are opposite shapes:
 *   - the reader is still typing: "ukr" is a prefix of the alias "ukraine"
 *   - the reader typed a sentence: "war with iran today" CONTAINS the alias
 * A one-directional `alias.includes(q)` catches only the first. The same
 * containment runs against the localized name, so someone who typed the
 * moment's actual title finds it whether or not an alias repeats it.
 *
 * Aliases shorter than MIN_QUERY are skipped in the query-contains-alias
 * direction as well; a one-letter alias would pin every query in the corpus.
 */
export function matchMoments<T extends MomentSearchTeaser>(query: string, teasers: T[]): T[] {
  const q = query.trim().toLowerCase();
  if (q.length < MIN_QUERY) return [];
  return teasers.filter((m) => {
    if (m.name.toLowerCase().includes(q)) return true;
    return m.aliases.some((raw) => {
      const alias = raw.trim().toLowerCase();
      if (alias.length < MIN_QUERY) return false;
      return alias.includes(q) || q.includes(alias);
    });
  });
}

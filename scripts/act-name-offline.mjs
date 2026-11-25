/**
 * OFFLINE comparison of the newsdesk's nickname bridge and the rebuilt
 * act-name matcher (scripts/newsdesk-match.mjs, "act-name matcher"), over a
 * file of real headlines and a bill corpus. No network, no model, no cost,
 * and nothing written: it prints one JSON document to stdout.
 *
 * Why it exists: the owner's answer of 2026-11-15 on card 120, "Rebuild it to
 * match only real act names and acronyms, test it offline on two weeks of
 * headlines ($0), and show you the matches before it goes live." The live
 * newsdesk does not call the rebuilt matcher; this script is how its matches
 * are shown before anything changes.
 *
 * Usage:
 *   node scripts/act-name-offline.mjs [headlines.json] [bills.json] [press-names.json]
 * Defaults: tests/fixtures/nickname-search/headlines.json, data/bills.json,
 * data/press-names.json. The headlines file is an array of
 * { title, outlet, date, url? }. The bills file is data/bills.json's shape
 * (or the frozen subset tests/fixtures/nickname-search/bills.json).
 *
 * What it can and cannot reproduce: the live bridge runs only on headlines
 * that tiers 1 to 3 all missed, and resolves them against ONE Congress.gov
 * list of recently updated bills fetched that hour. Offline there is no list
 * and no tier-3 model call, so the bridge here resolves against the corpus
 * instead, and `bridge_slot` marks the headlines tiers 1 and 2 leave with no
 * signal at all (the ones the live bridge would see without tier 3).
 */
import { readFileSync } from 'node:fs';
import {
  buildActNameIndex,
  buildBillIndex,
  buildListIndex,
  extractNicknameTokens,
  findCitations,
  headlineForMatching,
  looksLegislative,
  matchActNames,
  matchLocal,
  matchNickname,
} from './newsdesk-match.mjs';

const slugOf = (b) => `${b.bill_type}-${b.bill_number}-${b.congress_number}`.toLowerCase();

/** Run both matchers over the headlines. Pure: inputs in, result out.
 *  @param {{ headlines: any[], bills: any[], pressNames?: any }} input */
export function runOffline({ headlines, bills, pressNames }) {
  const added = pressNames?.bills ?? {};
  const actIndex = buildActNameIndex(
    bills.map((b) => ({
      slug: slugOf(b),
      title: b.title,
      press_names: b.press_names ?? [],
      names: added[slugOf(b)]?.add ?? [],
    }))
  );
  const listIndex = buildListIndex(
    bills.map((b) => ({ congress: b.congress_number, type: b.bill_type, number: b.bill_number, title: b.title }))
  );
  const billIndex = buildBillIndex(bills);
  const rows = headlines.map((h) => {
    const title = headlineForMatching(h.title, h.url);
    const cites = findCitations(title);
    const local = cites.length ? null : matchLocal(title, billIndex);
    const legislative = looksLegislative(title);
    const tokens = extractNicknameTokens(title);
    const old = matchNickname(tokens, listIndex);
    const rebuilt = matchActNames(title, actIndex);
    return {
      title: h.title,
      outlet: h.outlet,
      date: h.date,
      t1_citation: cites.map((c) => c.slug),
      t2: local ? local.tier : null,
      legislative,
      // The live bridge sees a headline only when t1 and t2 found nothing and
      // it looks legislative (plus headlines t3 declined, not reproducible here).
      bridge_slot: cites.length === 0 && local === null && legislative,
      old: old ? { slug: old.slug, tokens } : null,
      rebuilt,
    };
  });
  return {
    headlines: rows.length,
    old_matches: rows.filter((r) => r.old).length,
    old_matches_in_bridge_slot: rows.filter((r) => r.old && r.bridge_slot).length,
    rebuilt_credited: rows.filter((r) => r.rebuilt.credited.length).length,
    rebuilt_credited_in_bridge_slot: rows.filter((r) => r.rebuilt.credited.length && r.bridge_slot).length,
    rebuilt_shared_only: rows.filter((r) => !r.rebuilt.credited.length && r.rebuilt.shared.length).length,
    bridge_slot: rows.filter((r) => r.bridge_slot).length,
    refused_press_names: actIndex.refused.length,
    act_names_indexed: actIndex.byKey.size,
    rows,
  };
}

// Script body only when executed directly (the repo's argv[1] guard), so a
// unit test can import runOffline without reading any file.
if (/(^|\/)act-name-offline\.mjs$/.test(process.argv[1] ?? '')) {
  const [hPath = 'tests/fixtures/nickname-search/headlines.json', bPath = 'data/bills.json', pPath = 'data/press-names.json'] =
    process.argv.slice(2);
  const headlines = JSON.parse(readFileSync(hPath, 'utf8'));
  const bills = JSON.parse(readFileSync(bPath, 'utf8'));
  let pressNames = null;
  try {
    pressNames = JSON.parse(readFileSync(pPath, 'utf8'));
  } catch {
    pressNames = null;
  }
  process.stdout.write(JSON.stringify(runOffline({ headlines, bills, pressNames }), null, 2) + '\n');
}

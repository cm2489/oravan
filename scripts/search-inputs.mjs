/**
 * Search-input generation — the ONE code path that produces press_names and
 * news_query for a bill, used by scripts/sync-bills.mjs (new bills, one extra
 * Haiku call per decode) and scripts/backfill-search-inputs.mjs (existing
 * corpus). A single shared prompt means the eval harness measures exactly
 * what production will do.
 *
 * press_names: up to 3 names journalists would plausibly print for this bill
 * (acronym, common shorthand, the short title as the press renders it).
 * news_query: a 2-4 term subject query for bills covered by topic rather
 * than name (CRA joint resolutions especially). Either may be null.
 */

export const SEARCH_INPUT_MODEL = 'claude-haiku-4-5-20251001';

function parseTagged(text) {
  const out = {};
  const re = /^\[([A-Z_]+)\]\s*\n?([\s\S]*?)(?=^\[[A-Z_]+\]|\s*$)/gm;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2].trim();
  return out;
}

export async function generateSearchInputs(anthropic, bill) {
  const msg = await anthropic.messages.create({
    model: SEARCH_INPUT_MODEL,
    max_tokens: 200,
    messages: [{ role: 'user', content: `You are indexing a US congressional bill for news search. Produce the search handles a news-archive query would actually match.

Bill: ${bill.bill_type.toUpperCase()} ${bill.bill_number} (${bill.congress_number}th Congress)
Official title: ${bill.title}
Decoded headline: ${bill.ai_headline ?? '(none)'}
What it does: ${bill.ai_sections?.tldr ?? bill.ai_summary?.slice(0, 200) ?? '(unknown)'}

RULES:
- PRESS_NAMES: up to 3 names a journalist would plausibly print for THIS bill, one per " | " separator, ONLY if each appears in or is directly derivable from the official title: the short title as commonly rendered (drop "of 2025"-style year suffixes), and an acronym ONLY if the title's own initials naturally spell it (e.g. "Safeguard American Voter Eligibility Act" -> "SAVE Act"). Each max 60 chars. NEVER invent an alternative name, paraphrase, or acronym that the title does not literally support. NEVER output a bill citation (HR 123, S. 45, SJRES 9) as a name. If the official title is a formal long title ("To amend...", "To establish...", "A joint resolution...", "An act..."), the bill has NO press name: output exactly NONE.
- NEWS_QUERY: exactly one anchor term plus ONE quoted 2-3 word subject phrase: the anchor is the most distinctive agency/entity name, the phrase is the regulated thing or action. Format: ANCHOR "subject phrase". Example: EPA "power plant". Every search term is ANDed, so fewer, sharper terms find more — never more than these two parts plus at most one extra term. Avoid generic terms (bill, act, law, legislation, vote, congress). REQUIRED whenever PRESS_NAMES is NONE — derive it from the headline and description above; NONE is only acceptable here when PRESS_NAMES has at least one name AND no distinctive subject exists.
- Plain text only.

Output exactly this tagged format, each tag on its own line followed by its content:
[PRESS_NAMES]
[NEWS_QUERY]` }],
  });
  const p = parseTagged(msg.content[0].text.trim());

  let press_names = null;
  if (p.PRESS_NAMES && p.PRESS_NAMES !== 'NONE') {
    const names = p.PRESS_NAMES.split('|').map((n) => n.trim()).filter(Boolean)
      .filter((n) => n.length <= 60).slice(0, 3);
    if (names.length) press_names = names;
  }

  let news_query = null;
  if (p.NEWS_QUERY && p.NEWS_QUERY !== 'NONE') {
    // Normalize rather than reject: strip operators/commas, then TRIM to at
    // most 3 AND-terms (a quoted phrase counts as one). Live-tested: 2-3
    // terms find coverage, 7+ find nothing — and a silently dropped query
    // regresses the bill to citation-only, the exact failure being fixed.
    const cleaned = p.NEWS_QUERY.replace(/[|()+,]/g, ' ').replace(/\s+/g, ' ').trim();
    const tokens = (cleaned.match(/"[^"]+"|\S+/g) ?? []).slice(0, 3);
    if (tokens.length >= 2) news_query = tokens.join(' ');
  }

  return { press_names, news_query };
}

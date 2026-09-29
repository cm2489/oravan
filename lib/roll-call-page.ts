/*
 * THE READABLE PAGE FOR ONE ROLL CALL — where a vote card's "Official record"
 * link goes.
 *
 * A roll call's `source` (data/votes.json, written by scripts/sync-votes.mjs)
 * is the record's DATA FILE: the file the parser read, and it stays that. Each
 * chamber also publishes the same roll call as a web page, and that page is
 * what a reader should land on. The Senate's XML names no stylesheet, so a
 * browser shows it as a raw tree; the Clerk's XML only draws through an XSL
 * stylesheet. Each page links back to the exact data file it shows ("XML" on
 * senate.gov, "XML View" on clerk.house.gov), so nothing is lost.
 *
 *   https://clerk.house.gov/evs/2025/roll006.xml
 *     -> https://clerk.house.gov/Votes/20256
 *   https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00250.xml
 *     -> https://www.senate.gov/legislative/LIS/roll_call_votes/vote1192/vote_119_2_00250.htm
 *
 * Both shapes are the ones each chamber links itself, read live on 2026-09-29:
 * the Senate's vote menu (roll_call_lists/vote_menu_119_2.htm) links the .htm
 * beside the .xml, and the Clerk's vote list (/Votes/MemberVotes) links
 * /Votes/<year><roll> with the roll unpadded (/Votes/20256 is roll 6 of 2025).
 * The padded form (/Votes/2025006) shows the same page; the unpadded one is
 * the Clerk's own. The logic is closed PR #376's `memberListPage`, moved to a
 * module that imports no data so a card of any kind can use it.
 *
 * CHECKED, ALL OF THEM: on 2026-09-29 every one of the 594 stored roll calls'
 * pages was fetched, a few seconds apart, and each page had to name its own
 * roll call — the roll number, Congress, session and date, and a link to the
 * very data file stored as `source` — not merely answer 200. That matters
 * because neither site errors on a missing vote: the Clerk answers 200 with
 * "Roll Call Vote not found", and the Senate redirects to a "not available"
 * page. The PR "Official-record links open the readable page, not a data file"
 * gives the counts.
 *
 * ANY OTHER SHAPE comes back unchanged, so the link always reaches the
 * official record, in the worst case as its data file. The unit spec
 * (tests/roll-call-page.unit.spec.ts) fails if a stored roll call ever takes
 * that path, so a new shape is noticed rather than silently linked raw.
 *
 * Pure and data-free: no JSON import, safe on any server or client module.
 */

const HOUSE_XML = /^https:\/\/clerk\.house\.gov\/evs\/(\d{4})\/roll(\d+)\.xml$/;
const SENATE_XML =
  /^(https:\/\/www\.senate\.gov\/legislative\/LIS\/roll_call_votes\/vote\d{4}\/vote_\d{3}_\d_\d{5})\.xml$/;

/**
 * The chamber's human-readable page for the roll call whose data file is
 * `source`, or `source` itself when it is not one of the two known shapes.
 */
export function rollCallPage(source: string): string {
  const house = HOUSE_XML.exec(source);
  if (house) return `https://clerk.house.gov/Votes/${house[1]}${Number(house[2])}`;
  const senate = SENATE_XML.exec(source);
  if (senate) return `${senate[1]}.htm`;
  return source;
}

/**
 * Hourly headline-triggered bill resync (Part 2 of the 2026-07-16
 * spend-reduction pair; Part 1 is scripts/decode-gate.mjs +
 * scripts/sync-bills.mjs). Owner directive: a news-headline trigger with
 * ALL-IN cost under $5/day.
 *
 *   node --env-file=.env.local scripts/newsdesk.mjs
 *
 * Needs CONGRESS_API_KEY + ANTHROPIC_API_KEY.
 *
 * ---- TIER-0 SOURCES: the government's own record (added 2026-07-23) ----
 * Before any press feed is consulted, four verified, free, zero-lean
 * Congress.gov/docs.house.gov signal feeds are ingested (all shapes
 * verified live 2026-07-23; parsers in newsdesk-match.mjs):
 *   house-floor-today.xml / senate-floor-today.xml - item title IS the
 *     bill number ("H.R.8884"); today's floor action, citation-grade.
 *   most-viewed-bills.xml - weekly single item; description is an <ol> of
 *     the top-10 with explicit numbers + congress tags; ONLY 119th-congress
 *     entries are accepted.
 *   docs.house.gov/billsthisweek/YYYYMMDD/YYYYMMDD.xml (Monday of the
 *     current week, US/Eastern) - the LOOK-AHEAD signal: bills scheduled
 *     days before the vote. A 404 just means no session week - clean no-op.
 * These fire WITHOUT the ≥2-outlet guardrail (they are the government's own
 * record, not press interpretation - no outlet lean exists to guard
 * against) and are logged loudly as TIER0 FIRE lines. They draw from their
 * own, higher decode caps (TIER0_DECODE_CAP/TIER0_DAILY_DECODE_CAP below).
 * This closed the 2026-07-23 gap where the week's biggest bills (NDAA
 * H.R.8800, the CR, the SAVE America Act) never triggered because
 * mainstream headlines use nicknames, not bill numbers.
 * Tier-0 refresh cadence is once per bill per FLOOR WINDOW (2026-08-08),
 * not once per bill per UTC day: Congress.gov publishes day D's floor
 * actions on D+1 between 13:35 and 14:00 UTC, so a single daily slot spent
 * by an early-morning run pushed that day's record to the next day. Three
 * windows - pre (00:00-13:59), record (14:00-18:59), session
 * (19:00-23:59) - each get their own slot; the measured evidence is in
 * newsdesk-match.mjs's floorBucket comment. This changes only how often a
 * FREE congress.gov refresh may happen; the decode budgets below are
 * per-run and per-UTC-day and are untouched by it.
 *
 * ---- PRESS SOURCES: free RSS only, no paid APIs ----
 * NEWS_API_KEY / TheNewsAPI is deliberately NOT used here — that quota
 * belongs to scripts/sync-coverage.mjs, and the reason is ownership, not
 * exhaustion. (Until 2026-09-25 this line said sync-coverage "already exceeds
 * its own daily quota some nights", citing pipeline-audit.md §4. The nightly
 * logs no longer show that: the 2026-09-24 run processed 600 bills with a
 * handful of per-minute 429 back-offs and no daily-quota stop, and the
 * September 2026 news-band audit found no quota stop in the nights it read.)
 * Politically-balanced
 * basket of 11 feeds (leans per data/media-bias.json), the original six
 * verified live 2026-07-16, the three 2026-07-23 additions marked *, the
 * 2026-08-12 rebalance addition marked ** and the 2026-09-25 right-lean
 * replacement marked ***:
 *   The Hill      thehill.com    center   https://thehill.com/homenews/feed/
 *   The Hill Senate* thehill.com center   https://thehill.com/homenews/senate/feed/
 *   The Hill House*  thehill.com center   https://thehill.com/homenews/house/feed/
 *                 (three feeds, ONE outlet: corroboration counts DISTINCT
 *                  outlet domains, so the Hill sub-feeds widen recall
 *                  without triple-counting thehill.com toward the
 *                  ≥2-outlet rule)
 *   Roll Call     rollcall.com   unrated  https://rollcall.com/feed/
 *                 (congress-focused trade pub, not AllSides-rated;
 *                  included for direct legislative signal, not lean
 *                  balance — and, since 2026-08-12, counted toward NO
 *                  corroboration on the conversation lamp's side, which
 *                  admits rated outlets only; see lib/conversation.mjs)
 *   NPR Politics  npr.org        center   https://feeds.npr.org/1014/rss.xml
 *   Fox News      foxnews.com    right    https://moxie.foxnews.com/google-publisher/politics.xml
 *   Reason***     reason.com     right    https://reason.com/latest/feed/
 *                 (replaced washingtontimes.com, which never delivered from
 *                  CI; see "THE 2026-09-25 RIGHT-LEAN SWAP" below)
 *   CBS News      cbsnews.com    left     https://www.cbsnews.com/latest/rss/politics
 *   Politico*     politico.com   left     https://rss.politico.com/congress.xml
 *   CNBC Politics** cnbc.com     center   https://www.cnbc.com/id/10000113/device/rss/rss.html
 *   Google News   (per-article)  spans    https://news.google.com/rss/search?q=congress%20bill%20when:1d&hl=en-US&gl=US&ceid=US:en
 *                 many leans - each item carries a <source url="…"> tag
 *                 that resolves to a bare outlet domain, giving true
 *                 per-article outlet attribution from one aggregator feed.
 *
 * THE 2026-08-12 REBALANCE (critic B-4), and why it had to happen before the
 * conversation lamp could ship. The basket was 1 right + 2 left + 2 center
 * rated outlets, which is a construction that leans: a story the left covers
 * was structurally likelier to reach the ≥2-outlet bar than one the right
 * covers, and the SINGLE right feed dying — the way apnews.com's did, silently,
 * with a 404 — would have skewed cross-spectrum admission with nothing on the
 * page to say so. "Nonpartisan by construction" is a claim about the
 * construction. Two rated feeds were added, both vetted live 2026-08-12 the
 * same way the original six were (fetch, confirm 200, parse with this repo's
 * own parseFeed, confirm real congress-relevant items, confirm every item link
 * resolves to the domain data/media-bias.json rates):
 *   washingtontimes.com  RIGHT  20 items, 20 dated, 5 congress-relevant
 *                        ("Dem senators accuse Belgian diamond group…",
 *                        "Left wing of Democratic Party wins showdown Senate
 *                        race in Minnesota"), all links on washingtontimes.com
 *   cnbc.com             CENTER 30 items, 30 dated, 7-10 congress-relevant
 *                        ("Russia sanctions bill honoring Lindsey Graham
 *                        breezes through Senate, heads to House"), all links
 *                        on cnbc.com
 * Basket is now 2 right + 2 left + 3 center rated outlets (Hill counted once)
 * + 1 unrated congress trade pub + 1 cross-outlet aggregator, and no lean
 * depends on a single feed staying alive.
 * CORRECTION (2026-09-25): that last sentence was true of the construction and
 * false in operation from the first run. washingtontimes.com returned HTTP 403
 * to the GitHub runner on the first newsdesk run after the rebalance merged
 * (2026-08-12 21:59Z) and on all 21 runs sampled from then through 2026-09-25,
 * while the same URL answered 200 to the same user-agent from a non-runner
 * address. Why runners are refused is unverified (the site is behind
 * Cloudflare; rss.politico.com is too, and it delivers). The vetting above was
 * done from a non-runner address, which cannot see a block on runner
 * addresses, and the dark-lean alarm below counts per LEAN, so Fox alone kept
 * the right lean `ok`. For six weeks the right half of this basket was one
 * feed, and nothing said so. The per-feed alarm below is what says so now,
 * and the feed was replaced the same day (next section).
 *
 * ---- THE 2026-09-25 RIGHT-LEAN SWAP ----
 * washingtontimes.com (403 from every runner, above) is out; reason.com is in,
 * so the basket is again 2 right + 2 left + 3 center rated outlets. The
 * replacement had to clear two bars the 2026-08-12 vetting never applied: the
 * outlet's own robots.txt AND its terms, and — because a laptop cannot see a
 * runner block — the per-feed alarm as its reachability proof. All 25 domains
 * data/media-bias.json rates right are accounted for below (foxnews.com is the
 * incumbent, washingtontimes.com the feed being replaced), checked on
 * 2026-09-25 with this script's own USER_AGENT for every fetch (no other
 * user-agent was tried against any refusal):
 *   washingtonexaminer.com  /tag/congress/feed/ 200, 10 items, 3 match-
 *     eligible. Robots allow it. TERMS (re-read in a real browser 2026-09-25;
 *     the page renders client-side, so a plain GET cannot read it; "Last
 *     updated and effective: 06/08/2026"): "You are further granted a right to
 *     implement the RSS feeds or APIs offered by our Sites if you have entered
 *     into an agreement with us for such use", and "With the exception of
 *     search engines, you agree that you will not use any robot, spider, or
 *     other automatic device … to monitor or copy our web pages … without
 *     prior written permission". (The same page also says "a commercial web
 *     site is permitted to integrate and display our RSS feeds and APIs
 *     subject to these Terms of Service"; the specific RSS clause and the
 *     robot clause both still ask for an agreement or written permission.)
 *     Out without that agreement.
 *   nypost.com              /politics/feed/ 200. ROBOTS.TXT NOTICE:
 *     "Collection of content and other data on nypost.com through automated
 *     means is prohibited unless you have express written permission". Out.
 *   pjmedia.com  /feed 200, 1 match-eligible of 20. Its footer links Salem
 *     Media's terms (cdn.townhall.com/web/privacypolicy/termsofuse.htm,
 *     effective 2019-11-05), which forbid using "an automatic device (such as
 *     a robot or spider) … to copy or 'scrape' the Website or Service Content
 *     for any purpose (except … bona fide search engines) without our express
 *     written permission". Out.
 *   breitbart.com, dailycaller.com  terms forbid bots/automated access. Out.
 *   thedispatch.com, theblaze.com   terms forbid scraping/downloading pages
 *     by automated means. Out.
 *   dailysignal.com  feed 200, but its terms pages answer this user-agent
 *     with 403, so its terms could not be read. Out.
 *   thefederalist.com  /feed/ 200 (Cloudflare), 20 items over ~36h, 3 match-
 *     eligible (all t3). Robots allow /feed/. NO terms-of-use page was found:
 *     /terms-of-use/ is a 404 and the footer links only a privacy policy.
 *     That is UNVERIFIED as "no terms" — a missing page is not proof there are
 *     none — so it was not chosen; it is the candidate to re-check first.
 *   spectator.us  does not resolve (DNS) — the US edition now lives on
 *     spectator.com, which data/media-bias.json does not rate, so its links
 *     would count toward nothing. Out.
 *   nationalreview.com /news/feed/ 403; newsmax.com timeout at 20s;
 *     townhall.com, americanthinker.com 404; thepostmillennial.com 0 items;
 *     dailywire, spectator.org, theamericanconservative, oann, marketwatch:
 *     0 legislative-looking items in the sample.
 *   freebeacon.com  200, ~5 items/day, 3 match-eligible of 20. Terms forbid
 *     "unauthorized automated means to compile information" (whether a
 *     published RSS feed counts as authorized is a judgement). The alternate.
 *   wnd.com  200, 2 match-eligible of 24. No automated-access clause.
 *     Passed over.
 *   reason.com  /latest/feed/ is the feed its own RSS button links to; 200,
 *     48 items over ~53h (~21/day, the Washington Times' volume), every link
 *     on reason.com, served by nginx (not Cloudflare, the front the Times
 *     refused runners from — though rss.politico.com is also Cloudflare and
 *     delivers, so the front alone predicts nothing). Robots: `Disallow:`
 *     (nothing). Terms (reason.com/terms-of-use/, read in full): no clause on
 *     robots, scraping, crawling, automated access or RSS. They do say:
 *     content is "intended for your personal, noncommercial use only"; "You
 *     may not … transmit or distribute in any way any material from the
 *     Websites except as provided"; "Accessing the Websites, in any manner,
 *     for the purpose of obtaining information … constitutes use of the
 *     Websites such that these Terms of Use bind the party accessing the
 *     Websites"; and "You are free to link to and cite the Websites so long as
 *     the context does not state or imply any sponsorship".
 *     WHAT THIS SCRIPT DOES WITH A REASON ITEM — the same as with every feed:
 *     it reads the headline and link; a headline t1/t2 leave ambiguous is SENT
 *     TO ANTHROPIC'S API (the t3 Haiku batch) to pick a bill; and since
 *     conversation/v2 (lib/conversation.mjs B-5) the ARTICLE LINK behind each
 *     outlet's observation of a bill is stored in data/conversation.json and
 *     committed to this public repository (no page or MCP tool renders the
 *     links as of 2026-09-25; the file itself is public). Linking is the use
 *     the terms expressly allow; whether sending headline text to a model API
 *     is "transmit"ting material, and whether this project's use is
 *     "noncommercial", are the owner's calls — the second is the same question
 *     that already stands over the CC BY-NC AllSides table.
 *     WHAT IT IS WORTH, honestly: Reason restores the 2-right CONSTRUCTION, but
 *     the sample showed no bill-specific recall. All 7 match-eligible items
 *     were ambiguous t3 candidates (0 by citation, 0 by local match); 4 of the
 *     7 were "White House" headlines offered S. 4430 (White House Safety and
 *     Security Act) — the false-positive shape the floor-disambiguation
 *     change (#303) removes from looksLegislative — and under that change 3 of
 *     48 remain, none about a specific bill. Reason is libertarian and covers
 *     Congress through regulation, spending and civil liberties more than
 *     floor mechanics.
 *     THE VOLOKH CONSPIRACY: 16 of the 48 items are under reason.com/volokh/ —
 *     a law-professor group blog Reason hosts, whose masthead reads "Mostly
 *     law professors | Sometimes contrarian | Often libertarian | Always
 *     independent" and links an "Editorial Independence" page. Its posts
 *     arrive as reason.com items, so they count as right-rated reason.com
 *     press and their links are stored as reason.com evidence. 2 of the 7
 *     match-eligible items were Volokh posts (0 of the 3 left under the
 *     looksLegislative fix). Whether AllSides' rating of Reason covers the
 *     Volokh posts was not verified. Dropping items whose link path starts
 *     /volokh/ is a one-line filter, and it is the owner's call, not made here.
 *     /tag/congress/feed/ WAS MEASURED AND REJECTED: it has 48 items too, but
 *     they span 2026-03-10 to 2026-09-22 (about 1.7 a week; the newest was
 *     79h old at fetch), and nothing in this script filters by pubDate — the
 *     lamp dates every observation by the run day (observeOutlets `today`).
 *     Its first fetch, and every fetch after a seen-cache eviction, would feed
 *     six months of backlog through the matcher and count months-old stories
 *     as this week's coverage. Fewer Volokh posts (2 of 48) do not buy that.
 * The match-eligible counts are ONE point-in-time fetch each, not a rate.
 * AllSides' own 5-point ratings for these outlets were not re-read (allsides.com
 * answers this user-agent with 403); data/media-bias.json rates all of them
 * right, and that table is what the code counts.
 * The feeds ALREADY in the basket were not re-vetted against their terms in
 * this pass. One was spot-checked and it matters: Fox's terms (last revised
 * 2025-08-27) say "Except as expressly permitted in these Terms of Use, you
 * may not copy, download, stream, scrape, … frame, deep-link, make available
 * or otherwise use any Content", and no RSS permission was found in them. The
 * "deep-link" in that list bears on conversation/v2 too: the committed file,
 * public in this repository, now stores links to individual foxnews.com
 * articles. The bar applied to the replacement is stricter than the one the
 * basket was built on; whether to hold the incumbents to it is an owner
 * decision.
 *
 * Dead/rejected candidates during verification — 2026-07-16/23:
 * apnews.com/hub/politics.rss and apnews.com/rss (both 404 — AP discontinued
 * most public RSS), politico.com/rss/politics08.xml (403; the congress.xml
 * feed above works), feeds.washingtonpost.com/rss/politics (200 but an
 * empty/stub body). 2026-08-12 rebalance sweep: dailycaller.com/section/
 * politics/feed (404), townhall.com/api/rss/columnists (404),
 * api.axios.com/feed/politics (404), apnews.com/hub/politics.rss (404 again —
 * still dead), reuters.com arc outboundfeeds politics (404),
 * feeds.a.dj.com/rss/RSSPolitics.xml (403), bloomberg.com politics site.xml
 * (403), newsmax.com/rss/Politics/1 (connection timeout at 20s),
 * rssfeeds.usatoday.com Washington (200 with zero parseable items — the
 * washingtonpost shape), freebeacon.com/politics/feed (200 with zero
 * parseable items). Rated-but-passed-over on congress relevance:
 * nationalreview.com (1/20), thedispatch.com (1/10), dailysignal.com (1/20),
 * nypost.com/politics (5/20 but heavily NY-local), washingtonexaminer.com
 * /tag/congress (3/10, healthy — named here as "the first alternate if either
 * addition dies"; its terms, read on 2026-09-25, require an agreement for RSS
 * use, so it was not that alternate — see THE 2026-09-25 RIGHT-LEAN SWAP).
 *
 * ---- THE DARK-LEAN ALARM (critic B-4, 2026-08-12) ----
 * A rebalanced basket that quietly loses a side is the same failure with extra
 * steps, so per-lean liveness is tracked in the same cache the darkness
 * tripwire uses: for every rated lean the basket carries, the last day any of
 * THAT LEAN's own feeds returned an item. A lean silent for
 * DARK_LEAN_ALARM_DAYS (7) emits a loud ::warning:: and is written into
 * data/conversation.json's source_status, where the gate re-surfaces it. Only
 * the basket's own named feeds count as a lean being live — an aggregator
 * article that happens to resolve to a right-rated domain does not, because
 * the thing being watched is whether the vetted basket still covers the
 * spectrum, not whether Google News does.
 *
 * ---- THE PER-FEED DARK ALARM (2026-09-25) ----
 * The lean alarm above has a blind spot the Washington Times feed fell straight
 * into: a lean reads `ok` while ANY feed of that lean is alive, so a dead feed
 * with a live sibling never trips it. Every named feed in SOURCES is therefore
 * tracked on its own as well (rollFeedHealth / darkFeeds / feedStatuses in
 * lib/conversation.mjs), in the same cache: a feed that returns nothing — a
 * non-200, a thrown fetch, or a 200 whose body parses to zero items — for
 * FEED_DARK_ALARM_DAYS (3) days emits a ::warning:: naming the feed, its lean
 * and its last failure, and is written into data/conversation.json's
 * `source_status.feeds`. From there scripts/check-conversation.mjs (CI),
 * scripts/verify-sync.mjs (nightly) and the pipeline-health digest all
 * re-surface it. Only a feed's STATUS moving (ok <-> dark) counts as a
 * material change to the committed file, so a feed missing one hour is not a
 * commit. This alarm is also the ONLY reachability test a feed gets from a
 * runner: vetting from a laptop cannot see a block on runner addresses, and
 * this repo does not run live-network probes in CI, so the first newsdesk runs
 * after a feed is added are its proof, and this alarm names a failing feed three
 * days after its first failed run (for a feed never seen live, that is the
 * fourth UTC day of failures).
 *
 * ---- Matching, cheapest first (full design in scripts/newsdesk-match.mjs) ----
 * t1 citation regex (free) -> t2 local token overlap against corpus
 * titles+press_names+news_query, rare tokens weighted double (free) -> t3
 * ONE batched claude-haiku-4-5-20251001 call for headlines t2 leaves
 * ambiguous, skipped entirely (zero API calls) when that batch is empty ->
 * nickname bridge: legislative-looking headlines t1/t2/t3 ALL missed get
 * their distinctive capitalized/quoted act-name tokens resolved against
 * ONE per-run Congress.gov recently-updated list (fetchRecentlyUpdated,
 * NICKNAME_LIST_LIMIT bills, fetched lazily and reused across headlines) —
 * the "brand-new big bill covered only by name" path. Bridge matches are
 * press-derived, so they still need ≥2-outlet corroboration.
 *
 * ---- Trigger rule (nonpartisan guardrail, non-negotiable) ----
 * A bill fires only if (a) extracted from a tier-0 GOVERNMENT feed (no
 * outlet lean exists, so no corroboration applies - logged loudly), (b)
 * matched by an explicit citation from ANY outlet, or (c) matched by
 * t2/t3/nickname-bridge and corroborated by >=2 DISTINCT REAL outlets -
 * an article whose outlet can't be resolved to a domain (a Google News item
 * with a missing/unparseable <source url>) contributes its headline but NOT
 * corroboration, since counting it as a second newsroom let one outlet's
 * story corroborate itself (2026-08-09; countDistinctOutlets) -
 * accumulated across runs via the seen-headlines cache (newsdesk-match.mjs's
 * decideFires; pending single-outlet holds expire after 7 days and are
 * summarized in every run's log). See that module's header comment for
 * why single-outlet triggering on a soft match would be a partisan-skew
 * prioritization channel that data/media-bias.json's display-only lean
 * normalization does nothing to prevent. Trigger sources must stay
 * lean-diverse (press) or lean-free (government) - never a single-lean
 * channel.
 *
 * ---- ON FIRE ----
 * Refresh the bill's status/last_action_date (free) via the SAME shared
 * syncOneBill (scripts/bill-decode.mjs) sync-bills.mjs uses. If the bill
 * is NOT already in the corpus — possible for a tier-0 extraction, a t1
 * citation match, or a nickname-bridge match; t2/t3 can only ever resolve
 * to a bill already in data/bills.json, by construction — decode it via
 * that same decode-before-publish path, force-bypassing the priority gate
 * (the trigger's own signal IS the worthiness gate here). Bounded by
 * per-run AND per-UTC-day caps in TWO separate budgets: press fires spend
 * NEWSDESK_DECODE_CAP/NEWSDESK_DAILY_DECODE_CAP, tier-0 government fires
 * spend their own higher TIER0_DECODE_CAP/TIER0_DAILY_DECODE_CAP (daily
 * counts persisted in the cache file) — see "Cost ceiling" below.
 *
 * ---- Dedupe (no hourly commits) ----
 * A seen-headlines cache (hash of normalized title+outlet) at
 * .newsdesk-cache/seen.json persists across runs via actions/cache in
 * newsdesk.yml — restored from the most recent previous run (a
 * restore-key prefix match) and always saved under a fresh run-scoped key,
 * so GitHub's own "evict caches unused for 7 days" policy ages out stale
 * state automatically with no TTL bookkeeping needed here. The same file
 * also carries `pendingOutlets` (the per-slug outlet sets the >=2-outlet
 * rule accumulates across runs), `dailyDecodes` (the cost ceiling) and
 * `feedHealth` (the consecutive-darkness streak). The `seen` set holds three
 * namespaced key kinds, all hashes, never feed content: headline keys, tier-0
 * (slug, day, window) refresh slots, and failedDecodeKey holds for a slug
 * whose decode paid and failed today.
 * Cache miss (first run ever, an evicted cache, or a corrupt file)
 * degrades gracefully to empty state in loadCache(): a bill that's already
 * fresh just gets refreshed again (idempotent no-op), and an
 * already-decoded bill is never re-decoded (bySlug.has(slug) governs that,
 * not the cache).
 *
 * ---- Cost ceiling ----
 * Haiku (t3): most hourly runs' ambiguous batch is empty, so the LLM call
 * is skipped entirely (resolveWithHaiku) at $0; on an active-news hour a
 * ~20-40-headline batch at small prompts runs roughly $0.002-0.005/call.
 * Expected ~$0.12/day summed across 24 runs on a newsy day — an upper
 * estimate; many real days are lower. Trigger decodes (Sonnet 5,
 * ~$0.07-0.15/bill, same model/cost as sync-bills.mjs): a typical day
 * triggers 0 brand-new-bill decodes ($0, since a fired bill is almost
 * always already in the corpus and only needs a free refresh); a busy day
 * with 1-3 genuine new-bill triggers costs ~$0.07-0.45. The PER-RUN cap
 * (NEWSDESK_DECODE_CAP=3) alone does not bound the DAILY total — 24 runs x
 * 3 would allow up to ~$10.80/day in an implausible black-swan scenario —
 * so NEWSDESK_DAILY_DECODE_CAP=10 is a second, code-enforced ceiling
 * (~$0.70-1.50/day even then). Tier-0 government fires (2026-07-23) have
 * their own budget: TIER0_DECODE_CAP=6/run, TIER0_DAILY_DECODE_CAP=20/day.
 * On a typical day tier-0 adds ~$0: floor-scheduled bills are almost
 * always already in the corpus (free refresh); the daily cap only matters
 * in a black-swan week of brand-new floor bills, where the combined
 * code-enforced hard ceiling becomes 10+20=30 decodes ≈ $2.10-4.50 + the
 * ~$0.12 Haiku spend — still inside the owner's all-in <$5/day directive
 * at the very top of this header. The nickname bridge adds at most ONE
 * free Congress.gov list request per run and no LLM calls of its own. See
 * the introducing PRs' reports for the full typical/busy/hard-ceiling cost
 * tables.
 * Both budgets are charged on the ATTEMPT, not the success (2026-08-09).
 * Until then only outcome 'added' was counted, so a decode that reached the
 * model and then threw — bill-decode.mjs's shape check rejecting a reply with
 * a missing tag, which is deterministic for a given verbose bill — spent two
 * Sonnet calls, charged the caps nothing, and left its slug unmarked, so the
 * same bill re-fired every hour for the rest of the day: unbounded paid
 * retries of a failure that could not succeed, right through a ceiling
 * described above as code-enforced. syncOneBill now reports `decodeAttempted`
 * and chargeableDecode charges on it; the free outcomes (refreshed, gated,
 * budget, and any failure before the first model call) never reach it. A slug
 * that paid and failed also gets a failedDecodeKey held for the rest of the
 * UTC day, so a deterministic failure costs at most one decode per day
 * instead of one per hour.
 *
 * ---- Failure visibility (2026-08-09) ----
 * Every feed here can throw, or serve a 200 with an empty/stub body, and the
 * run still exits 0 looking exactly like a quiet news hour — the shape that
 * would let a total ingest outage sit green for a week. So the run judges its
 * own intake (assessFeeds): all tier-0 feeds failing, or half the press
 * basket returning nothing, each emit a ::warning:: visible in the Actions
 * summary. A FULLY dark run (every tier-0 feed failed AND every press feed
 * silent — the only state that can't be an upstream coincidence) increments a
 * consecutive-darkness counter persisted in the same cache file, and at
 * FEED_DARK_ESCALATE_RUNS=6 in a row — six hours of receiving nothing at all —
 * the run emits ::error:: and exits 1. One caveat, stated where it bites: a
 * non-zero exit skips the newsdesk.yml steps after this script, including the
 * sibling Moment-updates collector. That is the intended trade at six hours
 * dark (a human is needed either way, and the collector is incremental — the
 * next healthy run re-collects), and nothing is lost from THIS script, which
 * by definition fired nothing and wrote nothing on a dark run.
 *
 * ---- Boundaries ----
 * Writes data/bills.json, data/bills-es.json and data/conversation.json, and
 * nothing else. NEVER writes data/floor-signals.json (the sibling step below
 * owns it; this script only reads it) and NEVER writes data/moment-updates.json.
 * NEVER writes data/coverage.json — that stays scripts/sync-coverage.mjs's
 * (TheNewsAPI, display-only enrichment of already-known bills). A future
 * integration could have sync-coverage.mjs prioritize newsdesk-triggered
 * slugs first in its own urgency-ordered nightly queue; out of scope here.
 * Never touches data/sync-state.json's nightly cursor — same reasoning as
 * scripts/hot-bills.mjs: a same-day refresh/trigger pass is not the
 * nightly backlog scan's own progress signal.
 * ---- RE-DECODE TRIGGER (2026-08-12) ----
 * A fifth thing this script can spend on, under the SAME tier-0 budget as
 * everything above and never a new one: re-reading a bill whose stored decode
 * no longer describes the document Congress is acting on. Eligibility is the
 * top of the docket ladder only — a bill named in data/floor-signals.json's
 * T0 announcements, or one whose own action text says a floor vote is
 * ripening — and the verdict is pure and tested (redecodeVerdict in
 * scripts/floor-signals-parse.mjs): the decode predates the bill's latest
 * action, or the title Congress serves is no longer the title we hold (the
 * vehicle swap that left an AGOA decode on the continuing resolution's page).
 * A null decoded_at with a matching title never fires, which is what keeps the
 * pre-2026-08-12 backlog from eating a day's cap the first time it runs.
 *
 * ---- THE CONVERSATION LAMP: data/conversation.json (2026-08-12) ----
 * A sixth thing this script does, and the only one that writes a file of its
 * own. Everything above is about TRIGGERING — which bill to refresh, which
 * decode to re-run. This is about EVIDENCE: which rated outlets carried a
 * story matched to which bill in the last 7 days — and, since conversation/v2,
 * the link to that story — and what congress.gov's own weekly most-viewed list
 * says, written down where it can be audited a month later. The full design, and the four critic patches it enforces at write
 * time, live in lib/conversation.mjs's header. Three things matter here:
 *
 *   1. THE TRIGGER MACHINERY IS UNTOUCHED. `pendingOutlets`, its 7-day TTL and
 *      its delete-on-fire all behave exactly as they did; decideFires still
 *      decides fires. The lamp keeps its OWN accumulator (every press match
 *      this run, including t1 citations, which the trigger path short-circuits
 *      past) and reads its own committed file. Nothing here can change what
 *      fires, and nothing that fires can erase the lamp's evidence.
 *   2. IT NEVER TOUCHES THE DOCKET. Conversation selects and captions the news
 *      band and contributes a C-tier input to Moment candidates. Crown,
 *      shortlist, /bills bands and the MCP pool stay ordered by lib/docket.mjs
 *      alone.
 *   3. IT SPENDS NO NEW BUDGET. A bill ENTERING corroborated state (≥2 RATED
 *      outlets inside the window — an unrated domain corroborates nothing)
 *      with a stale decode queues through the SAME chargeableDecode path under
 *      the SAME press caps as any other press fire. Most-viewed alone never
 *      queues anything (critic B-2). The only extra network is up to
 *      CONVERSATION_TITLE_CHECKS_PER_RUN free Congress.gov refreshes, spent
 *      only on a C1 entrant whose decode stamp looks fine — the vehicle-swap
 *      check that heals an AGOA decode sitting on a continuing resolution.
 *
 * The file is COMMITTED and written ONLY on a material change (a new outlet, a
 * new day for one already recorded, a most-viewed transition, a window prune,
 * a source status change) — every observation is stored at day granularity
 * precisely so an hourly cron cannot become an hourly deploy.
 *
 * SIBLING STEP: scripts/floor-signals.mjs runs immediately BEFORE this one in
 * newsdesk.yml and owns data/floor-signals.json alone — this script only ever
 * READS that file, and treats it as absent when it can't. Neither writes the
 * other's files.
 * SIBLING STEP: scripts/moment-updates.mjs runs immediately after this one in
 * newsdesk.yml and owns data/moment-updates.json alone — it reads this
 * script's output (data/bills.json) and never writes anything this script
 * touches, so neither has to know about the other beyond this line.
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  buildConversation,
  CONVERSATION_PATH,
  conversationEvidence,
  conversationPool,
  DARK_LEAN_ALARM_DAYS,
  darkFeeds,
  darkLeans,
  enteredCorroborated,
  FEED_DARK_ALARM_DAYS,
  feedStatuses,
  leanOf,
  leanStatuses,
  normalizeArticleUrl,
  rollFeedHealth,
  rollLeanHealth,
  shouldWrite as shouldWriteConversation,
} from '../lib/conversation.mjs';
import { loadJSON, redecodeBill, syncOneBill } from './bill-decode.mjs';
import { fetchRecentlyUpdated, slugOf } from './congress-fetch.mjs';
import {
  FLOOR_SIGNALS_PATH,
  redecodeCandidates,
  redecodeVerdict,
} from './floor-signals-parse.mjs';
import {
  anyDataChanged,
  assessFeeds,
  buildBillIndex,
  buildFloorRecord,
  buildListIndex,
  buildT3Prompt,
  chargeableDecode,
  decideFires,
  extractBillsThisWeekSlugs,
  extractFloorFeedSlugs,
  extractMostViewedRanked,
  extractMostViewedSlugs,
  extractNicknameTokens,
  failedDecodeKey,
  FEED_DARK_ESCALATE_RUNS,
  findCitations,
  floorBucket,
  FLOOR_RECORD_SOURCES,
  hashHeadline,
  headlineForMatching,
  looksLegislative,
  matchLocal,
  matchNickname,
  mondayOfWeekET,
  parseFeed,
  PENDING_OUTLETS_TTL_DAYS,
  prunePendingOutlets,
  rollDailyDecodes,
  rollFeedDarkness,
  rollFloorRecord,
  summarizePendingOutlets,
  tier0SeenKey,
  UNRESOLVED_OUTLET,
} from './newsdesk-match.mjs';
import { classifyApiError } from './api-billing.mjs';
import { bumpCounter, recordApiError, setCounter } from './run-counters.mjs';

// ---- Press-fire decode budget (unchanged from the 2026-07-16 design) ----
const NEWSDESK_DECODE_CAP = Number(process.env.NEWSDESK_DECODE_CAP ?? 3);
const NEWSDESK_DAILY_DECODE_CAP = Number(process.env.NEWSDESK_DAILY_DECODE_CAP ?? 10);
// ---- Tier-0 (government signal) decode budget ----
// Separate, slightly HIGHER caps than the press budget: tier-0 slugs come
// from the government's own floor schedules/most-viewed record — the
// highest-precision signal that exists — so a busy floor week must not
// starve behind the press caps, while both per-run and per-UTC-day bounds
// keep the black-swan ceiling code-enforced (header "Cost ceiling").
const TIER0_DECODE_CAP = Number(process.env.NEWSDESK_TIER0_DECODE_CAP ?? 6);
const TIER0_DAILY_DECODE_CAP = Number(process.env.NEWSDESK_TIER0_DAILY_DECODE_CAP ?? 20);
// The nickname bridge's ONE per-run Congress.gov list request: how many
// recently-updated bills to resolve extracted act-name tokens against.
// 100 ≈ several days of legislative motion — a brand-new bill big enough
// to be covered by nickname is essentially always inside this window.
const NICKNAME_LIST_LIMIT = Number(process.env.NEWSDESK_NICKNAME_LIST_LIMIT ?? 100);
// The conversation lamp's only extra network: FREE Congress.gov refreshes
// spent checking whether a newly-corroborated bill's title is still the title
// we hold (the vehicle swap that left an AGOA decode on the continuing
// resolution). Only a C1 entrant whose decode stamp already looks fine costs
// one, and entering C1 is rare by construction — five is a ceiling, not a
// budget. No model call, no cent, ever.
const CONVERSATION_TITLE_CHECKS_PER_RUN = Number(process.env.NEWSDESK_CONVERSATION_TITLE_CHECKS ?? 5);
const CACHE_DIR = process.env.NEWSDESK_CACHE_DIR ?? '.newsdesk-cache';
const CACHE_FILE = `${CACHE_DIR}/seen.json`;
const T3_MAX_HEADLINES = Number(process.env.NEWSDESK_T3_MAX_HEADLINES ?? 40);
const T3_MODEL = 'claude-haiku-4-5-20251001';
const USER_AGENT = 'Mozilla/5.0 (compatible; OravanNewsdesk/1.0; +https://oravan.org)';
// Congress.gov sits behind Cloudflare, which challenges bare-bones request
// UAs (plain curl is blocked); a normal browser-shaped UA passes the RSS
// endpoints cleanly (verified live 2026-07-23, along with the fact that
// the crawler-style USER_AGENT above ALSO currently passes — the explicit
// browser UA is used for tier-0 anyway so a future Cloudflare tightening
// against "compatible;" bot UAs can't silently kill the highest-precision
// signal).
const TIER0_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// See the header comment for the full basket rationale + verification
// dates (including the 2026-08-12 rebalance's live vetting and its
// dead/rejected candidate list). `domain` is what the ≥2-outlet rule counts,
// so the three Hill feeds deliberately share one domain (one outlet, wider
// recall) — and it is also the key data/media-bias.json is looked up by, which
// is what makes each feed's lean a fact rather than an assertion here.
const SOURCES = [
  { name: 'The Hill', domain: 'thehill.com', url: 'https://thehill.com/homenews/feed/' },
  { name: 'The Hill Senate', domain: 'thehill.com', url: 'https://thehill.com/homenews/senate/feed/' },
  { name: 'The Hill House', domain: 'thehill.com', url: 'https://thehill.com/homenews/house/feed/' },
  { name: 'Roll Call', domain: 'rollcall.com', url: 'https://rollcall.com/feed/' },
  { name: 'NPR Politics', domain: 'npr.org', url: 'https://feeds.npr.org/1014/rss.xml' },
  { name: 'Fox News Politics', domain: 'foxnews.com', url: 'https://moxie.foxnews.com/google-publisher/politics.xml' },
  // The second RIGHT-rated outlet (critic B-4), since 2026-09-25. It replaces
  // washingtontimes.com, which answered every GitHub runner with HTTP 403 from
  // the day the 2026-08-12 rebalance added it. Chosen on terms as much as on
  // lean: see the header's "THE 2026-09-25 RIGHT-LEAN SWAP" for the candidates
  // whose robots.txt or terms ruled them out, what this script sends and stores
  // from it, and the Volokh Conspiracy posts its feed carries. Whether a RUNNER
  // can reach it is proven only by the first newsdesk runs after merge; if it is
  // refused too, the per-feed alarm names it three days after its first failed
  // run.
  { name: 'Reason', domain: 'reason.com', url: 'https://reason.com/latest/feed/' },
  { name: 'CBS News Politics', domain: 'cbsnews.com', url: 'https://www.cbsnews.com/latest/rss/politics' },
  { name: 'Politico Congress', domain: 'politico.com', url: 'https://rss.politico.com/congress.xml' },
  // 2026-08-12 rebalance: a third CENTER-rated outlet, and the one with the
  // highest measured congress-relevance of the vetted candidates.
  { name: 'CNBC Politics', domain: 'cnbc.com', url: 'https://www.cnbc.com/id/10000113/device/rss/rss.html' },
  { name: 'Google News (congress bill query)', domain: null, url: 'https://news.google.com/rss/search?q=congress%20bill%20when:1d&hl=en-US&gl=US&ceid=US:en' },
];

// Tier-0 government signal feeds (header "TIER-0 SOURCES"). Each entry's
// extract() turns the raw body into citation-grade slugs; `weekly` marks
// the docs.house.gov look-ahead file whose 404 on a no-session week is a
// clean no-op, not an error.
const TIER0_SOURCES = [
  {
    label: 'house-floor-today',
    url: () => 'https://www.congress.gov/rss/house-floor-today.xml',
    extract: extractFloorFeedSlugs,
  },
  {
    label: 'senate-floor-today',
    url: () => 'https://www.congress.gov/rss/senate-floor-today.xml',
    extract: extractFloorFeedSlugs,
  },
  {
    label: 'most-viewed-bills',
    url: () => 'https://www.congress.gov/rss/most-viewed-bills.xml',
    extract: extractMostViewedSlugs,
    // The conversation lamp needs what the trigger path never did: the RANK
    // congress.gov published and the week label it printed. Same parse, same
    // request, no extra fetch — extractMostViewedSlugs is now a projection of
    // this, so the two can never disagree about which bills are on the list.
    extractExtra: extractMostViewedRanked,
  },
  {
    label: 'house-bills-this-week',
    url: () => {
      const monday = mondayOfWeekET();
      return `https://docs.house.gov/billsthisweek/${monday}/${monday}.xml`;
    },
    extract: extractBillsThisWeekSlugs,
    okOn404: true, // no session scheduled this week - nothing to look ahead to
  },
];

/** Fetch one tier-0 source and extract its slugs, plus whatever richer shape
 *  that source carries for the conversation lamp (`extra`, most-viewed only).
 *  Returns an empty result on an allowed 404; throws on anything else so
 *  Promise.allSettled surfaces it as a per-source failure without killing the
 *  run. */
async function fetchTier0(src) {
  const res = await fetch(src.url(), {
    signal: AbortSignal.timeout(20_000),
    headers: { 'User-Agent': TIER0_USER_AGENT },
  });
  if (res.status === 404 && src.okOn404) return { slugs: [], extra: null };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  return { slugs: src.extract(body), extra: src.extractExtra ? src.extractExtra(body) : null };
}

async function fetchFeed(src) {
  const res = await fetch(src.url, {
    signal: AbortSignal.timeout(20_000),
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return parseFeed(xml).map((it) => ({
    title: it.title,
    link: it.link,
    pubDate: it.pubDate,
    outlet: it.source ?? src.domain,
    feedName: src.name,
  }));
}

function loadCache() {
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    // pendingOutlets: slug -> { outlets: domain[], updated: ISO }. A cache
    // written by the pre-2026-07-23 shape (slug -> domain[]) is migrated in
    // place with `updated = now`, restarting its 7-day TTL - the safe
    // direction (a hold lives slightly longer once, never fires early).
    const pendingOutlets = {};
    for (const [slug, v] of Object.entries(raw.pendingOutlets ?? {})) {
      pendingOutlets[slug] = Array.isArray(v)
        ? { outlets: v, updated: new Date().toISOString() }
        : v;
    }
    return {
      seen: new Set(raw.seen ?? []),
      pendingOutlets,
      dailyDecodes: raw.dailyDecodes ?? null, // {date: 'YYYY-MM-DD', count, tier0Count}
      feedHealth: raw.feedHealth ?? null, // {consecutiveDark}
      // {left|center|right: {last_live, first_dark}} - critic B-4's per-lean
      // liveness. Losing it costs at most one alarm cycle: rollLeanHealth
      // starts a lean's clock at today rather than reading a missing record as
      // infinitely dark, which fails toward silence exactly like feedHealth.
      leanHealth: raw.leanHealth ?? null,
      // {feed name: {url, domain, lean, last_live, first_dark, last_error}} -
      // the per-FEED liveness the lean record cannot see (header "THE PER-FEED
      // DARK ALARM"). Losing it is covered twice: rollFeedHealth re-seeds a
      // feed the committed file already calls dark, and any other feed starts
      // its clock today.
      feedLiveness: raw.feedLiveness ?? null,
      // Slugs that ENTERED corroborated state and whose re-decode the press
      // budget deferred. Carried so a bill does not lose its heal simply
      // because it was corroborated on a busy hour; dropped as soon as it
      // stops being corroborated or the re-decode resolves.
      conversationRedecodeQueue: Array.isArray(raw.conversationRedecodeQueue) ? raw.conversationRedecodeQueue : [],
    };
  } catch {
    // Cache miss (first run, evicted, or corrupt) - degrade gracefully.
    // See the header comment: firing again on an already-handled bill is
    // idempotent, so losing this state costs a little redundant work, not
    // correctness.
    return {
      seen: new Set(),
      pendingOutlets: {},
      dailyDecodes: null,
      feedHealth: null,
      leanHealth: null,
      feedLiveness: null,
      conversationRedecodeQueue: [],
    };
  }
}

function saveCache(cache) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify({
    seen: [...cache.seen],
    pendingOutlets: cache.pendingOutlets,
    dailyDecodes: cache.dailyDecodes,
    feedHealth: cache.feedHealth,
    leanHealth: cache.leanHealth,
    feedLiveness: cache.feedLiveness,
    conversationRedecodeQueue: cache.conversationRedecodeQueue,
  }));
}

/** ONE batched Haiku call resolving t2-ambiguous headlines against their
 *  own short candidate lists. Never trusts a slug the batch didn't offer -
 *  a hallucinated slug from the model can't enter the pipeline.
 *  The prompt itself is built by newsdesk-match.mjs's buildT3Prompt (pure, so
 *  the tests pin exactly what the model reads): each candidate carries its
 *  latest action date, status and floor-record note, which is what lets t3
 *  tell twelve identically-worded war-powers resolutions apart (2026-09-26). */
async function resolveWithHaiku(anthropic, batch, { today } = {}) {
  // Counters, not log prose, are what the post-commit honesty alarm reads
  // (scripts/check-run-honesty.mjs). The two graceful degradations below are
  // correct for the RUN - no headline may cost a bill its refresh - and that
  // is exactly why the run must record that the tier went dark, or an hour
  // with a dead t3 reads identically to a quiet news hour.
  //
  // WRITTEN BEFORE THE EMPTY-BATCH RETURN, and that placement is the whole
  // point (2026-09-18, verifier fix). This is the only counter the newsdesk
  // job writes on its common path - most hourly runs batch nothing and decode
  // nothing, so nothing else here calls run-counters at all. Behind the early
  // return, a quiet hour left NO counter file, and check-run-honesty.mjs reads
  // an absent file as `instrumented: false` and reds the run. That would have
  // painted most of the 24 hourly runs a day red for being quiet - exactly the
  // alarm fatigue this alarm's own header forbids. Zero is a measurement.
  setCounter('t3Batched', batch.length);
  if (batch.length === 0) return new Map(); // skip t3 entirely - zero API calls
  let text;
  try {
    const msg = await anthropic.messages.create({
      model: T3_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: buildT3Prompt(batch, { today }) }],
    });
    text = msg.content[0]?.type === 'text' ? msg.content[0].text : '';
  } catch (e) {
    console.error(`t3 Haiku call failed: ${e.message}`);
    recordApiError(classifyApiError(e));
    bumpCounter('t3Failed');
    return new Map(); // degrade gracefully - no t3 matches this run
  }
  try {
    const jsonText = text.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(jsonText);
    const out = new Map();
    for (const row of parsed) {
      if (row && typeof row.i === 'number' && typeof row.slug === 'string') {
        const validOffer = batch[row.i]?.candidates.some((c) => c.slug === row.slug);
        if (validOffer) out.set(row.i, row.slug);
      }
    }
    setCounter('t3Resolved', out.size);
    return out;
  } catch (e) {
    console.error(`t3 JSON parse failed: ${e.message}`);
    // A reply the parser cannot read is the tier being dark just as surely as
    // a thrown request is - the batch was offered and nothing came back.
    bumpCounter('t3Failed');
    return new Map();
  }
}

// ---- main ----
const anthropic = new Anthropic({ maxRetries: 8 });
const bills = loadJSON('data/bills.json');
const es = loadJSON('data/bills-es.json');
// The AllSides lean table. Display-only everywhere else in the app; HERE it is
// the B-3 gate — an outlet absent from this map corroborates nothing on the
// conversation lamp, and it is also what tells the run whether a whole lean of
// the basket has gone dark (B-4).
const bias = loadJSON('data/media-bias.json').outlets ?? {};
const bySlug = new Map(bills.map((b) => [slugOf(b), b]));
const billIndex = buildBillIndex(bills);
const cache = loadCache();

const todayUTC = new Date().toISOString().slice(0, 10);
// Rolls at UTC midnight and at UTC midnight ONLY - never on a floor-window
// transition (rollDailyDecodes takes no window argument by construction).
// This is the cost invariant behind the three-window seen-key below.
cache.dailyDecodes = rollDailyDecodes(cache.dailyDecodes, todayUTC);

// ---- Tier-0: government signal feeds (fire without press corroboration) ----
// Dedupe key is (slug, UTC day, floor window), NOT the feed item title: the
// floor feeds republish the same bill numbers all day, so one refresh per
// bill per window is the intended cadence. Three windows rather than one
// per day because Congress.gov publishes day D's floor actions on D+1
// between 13:35 and 14:00 UTC - a single daily slot spent by an early
// morning run misses that day's record entirely. The measured evidence and
// the window boundaries are in newsdesk-match.mjs's floorBucket comment.
// The window is resolved ONCE here so a run that straddles a boundary
// spends and marks the same slot. Only the key's HASH enters the cache -
// never feed content (the never-republish rule).
const floorWindow = floorBucket();
const tier0Key = (slug) => tier0SeenKey(slug, todayUTC, floorWindow);
console.log(`newsdesk tier-0 [${floorWindow} window, ${todayUTC}]: fetching ${TIER0_SOURCES.length} government signal feeds`);
const tier0Results = await Promise.allSettled(TIER0_SOURCES.map(fetchTier0));
const tier0Slugs = new Map(); // slug -> source label (first source to carry it wins)
let tier0Failed = 0; // hard failures only - an empty floor feed is a recess day
// The most-viewed list with its published ranks and week label, for the
// conversation lamp. null when that one feed failed - the lamp then simply
// records no most-viewed observation this run (its source_status says so) and
// nothing about the press half changes.
let mostViewedRanked = null;
tier0Results.forEach((r, i) => {
  const { label } = TIER0_SOURCES[i];
  if (r.status !== 'fulfilled') {
    tier0Failed++;
    console.error(`  tier-0 ${label} FAILED: ${r.reason?.message ?? r.reason}`);
    return;
  }
  const { slugs, extra } = r.value;
  if (extra) mostViewedRanked = extra;
  const fresh = slugs.filter((slug) => !cache.seen.has(tier0Key(slug)));
  console.log(`  tier-0 ${label}: ${slugs.length} bill(s), ${fresh.length} not yet handled in the ${floorWindow} window`);
  for (const slug of fresh) if (!tier0Slugs.has(slug)) tier0Slugs.set(slug, label);
});

console.log(`newsdesk: fetching ${SOURCES.length} press feeds`);
const results = await Promise.allSettled(SOURCES.map(fetchFeed));
const items = [];
// "Silent" = threw OR returned zero items. The second half matters as much as
// the first: a 200 with an empty/stub body (the shape that killed
// feeds.washingtonpost.com's politics feed) never reaches Promise.allSettled's
// rejected branch and is indistinguishable from a quiet news hour unless it is
// counted here. A US-politics RSS feed with zero items is broken, not calm.
let pressSilent = 0;
// Critic B-4: which RATED leans the basket claims to carry, and which of them
// actually produced something this run. Per FEED, deliberately — an aggregator
// article that resolves to a right-rated domain does not prove the basket's own
// right-lean feeds are alive, and it is the basket's spectrum coverage that the
// ≥2-outlet rule and the conversation lamp both rest on.
const basketLeans = new Set(SOURCES.map((s) => leanOf(s.domain, bias)).filter(Boolean));
const liveLeans = new Set();
// The per-FEED observation the lean set above deliberately flattens: which
// named feed returned how many items, and why it returned none. Rolled into
// the per-feed dark alarm further down (header "THE PER-FEED DARK ALARM").
const feedObservations = [];
results.forEach((r, i) => {
  const lean = leanOf(SOURCES[i].domain, bias);
  if (r.status === 'fulfilled') {
    items.push(...r.value);
    if (r.value.length === 0) pressSilent++;
    else if (lean) liveLeans.add(lean);
    console.log(`  ${SOURCES[i].name}: ${r.value.length} items${r.value.length === 0 ? ' (EMPTY - counted as silent)' : ''}`);
  } else {
    pressSilent++;
    console.error(`  ${SOURCES[i].name} FAILED: ${r.reason?.message ?? r.reason}`);
  }
  const delivered = r.status === 'fulfilled' ? r.value.length : 0;
  feedObservations.push({
    name: SOURCES[i].name,
    url: SOURCES[i].url,
    domain: SOURCES[i].domain,
    lean,
    items: delivered,
    error: r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : delivered === 0 ? '0 items' : null,
  });
});

// ---- the darkness tripwire ----------------------------------------------
// Every feed above can fail, or serve a stub body, and the run still walks to
// a clean exit 0 that reads exactly like an ordinary quiet hour - which is
// how a total ingest outage stays invisible behind a wall of green checks.
// Judge the intake, say so out loud, and persist a streak so a sustained
// blackout eventually reds the build (assessFeeds / rollFeedDarkness).
const health = assessFeeds({
  tier0Total: TIER0_SOURCES.length,
  tier0Failed,
  pressTotal: SOURCES.length,
  pressSilent,
});
if (health.tier0Dark) {
  console.log(`::warning::newsdesk: ALL ${TIER0_SOURCES.length} tier-0 government feeds failed this run - the highest-precision signal is dark (no floor schedule, no most-viewed, no look-ahead)`);
}
if (health.pressDegraded) {
  console.log(`::warning::newsdesk: ${pressSilent} of ${SOURCES.length} press feeds returned nothing (failed or empty body) - corroboration recall is degraded this run`);
}
cache.feedHealth = rollFeedDarkness(cache.feedHealth, health.dark);
if (health.dark) {
  console.log(`::warning::newsdesk: FULLY DARK run - zero tier-0 feeds and zero press items. Consecutive dark runs: ${cache.feedHealth.consecutiveDark}/${FEED_DARK_ESCALATE_RUNS}`);
}

// Dedupe against the seen-headlines cache: skip anything already processed
// in a previous run (see the header comment's Dedupe section).
const newItems = items.filter((it) => !cache.seen.has(hashHeadline(it.title, it.outlet)));
console.log(`${items.length} headlines fetched, ${newItems.length} new (not previously seen)`);

// data/floor-signals.json, written by the sibling step (scripts/floor-signals.mjs)
// immediately before this script, and read-only here. Loaded before matching
// because the t3 floor record below reads its tier-0 announcements; the
// re-decode trigger further down reads the same object.
const floorSignals = (() => {
  try {
    return JSON.parse(readFileSync(FLOOR_SIGNALS_PATH, 'utf8'));
  } catch {
    // No file yet (before floor-signals.mjs's first run), or an unreadable
    // one. The trigger simply falls back to its T1 half — this must never
    // cost the newsdesk its refreshes.
    return null;
  }
})();

// ---- the floor record t3 reads (2026-09-26) ------------------------------
// Which measures a chamber's own record put on the floor in the last
// FLOOR_RECORD_HOURS: EVERY slug this run's floor-today feeds and the House
// weekly schedule list (not only the ones still unrefreshed in this window -
// this is about naming the measure a headline reports on, not about spending a
// refresh), the rolling memory of earlier runs' floor feeds (the feeds roll
// over to the next legislative day while a vote's coverage keeps arriving for a
// day or two), and floor-signals.json's live tier-0 announcements. The measured
// failure it closes: the 2026-09-24 Senate vote on H.Con.Res. 89 fired tier-0,
// yet its coverage was routed to S.J.Res. 185, an identically-worded resolution
// last acted on in June (newsdesk-match.mjs, "the floor record").
// It changes only WHICH candidates t3 is offered and what it is told about them
// (offerFloorFamily, buildT3Prompt): no fire, no budget, no docket position.
// The memory rides the same actions/cache directory as seen.json but in its own
// file, so nothing seen.json carries can collide with it; a lost cache costs
// the memory and nothing else. Only slugs and dates are stored - never feed
// content.
const FLOOR_RECORD_FILE = `${CACHE_DIR}/floor-record.json`;
const floorObservations = [];
tier0Results.forEach((r, i) => {
  const { label } = TIER0_SOURCES[i];
  if (r.status !== 'fulfilled' || !FLOOR_RECORD_SOURCES[label]) return;
  for (const slug of r.value.slugs) floorObservations.push({ slug, source: label });
});
const floorMemory = rollFloorRecord(
  (() => {
    try {
      return JSON.parse(readFileSync(FLOOR_RECORD_FILE, 'utf8'));
    } catch {
      return null; // first run, evicted or corrupt - this run's feeds still count
    }
  })(),
  floorObservations,
  Date.now()
);
try {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(FLOOR_RECORD_FILE, JSON.stringify(floorMemory));
} catch (e) {
  console.error(`floor record not persisted (${e.message}) - next run starts from its own feeds`);
}
const floorRecord = buildFloorRecord({ persisted: floorMemory, signals: floorSignals?.signals, nowMs: Date.now() });
console.log(
  `t3 floor record (${floorRecord.size}): ${[...floorRecord].map(([slug, f]) => `${slug} ${f.kind}${f.chamber ? `:${f.chamber}` : ''}${f.date ? ` ${f.date}` : ''}`).join(', ') || 'none'}`
);

const citationSlugs = new Set();
const t3Batch = [];
const t3Items = []; // parallel to t3Batch
// Ambiguous, legislative-looking headlines past the per-run t3 cap. Left OUT
// of the seen-set below so the next run offers them to t3 (2026-09-26): until
// then they were marked seen with the rest, which made "over the cap this
// hour" mean "never matched". The cap - and so the one Haiku call per run and
// its size - is unchanged; a headline waits an hour instead of being lost.
const t3Overflow = new Set();
const localOutletsBySlug = new Map(); // this run's t2/t3/bridge outlet contributions, per slug
const bridgeItems = []; // legislative-looking headlines t1/t2 missed entirely - nickname-bridge input

// An article whose outlet can't be resolved to a real domain is still
// recorded - it is evidence, and its headline still has to be deduped - but
// it is filed under UNRESOLVED_OUTLET, which countDistinctOutlets refuses to
// count toward the >=2-outlet rule. Before 2026-08-09 it went in as the
// literal string 'unknown' and counted as a whole second newsroom, so one
// outlet's story arriving twice (its own feed, plus the same story as an
// unattributable Google News item) cleared a guardrail that exists to require
// two independent ones. See countDistinctOutlets in newsdesk-match.mjs.
// The conversation lamp's OWN accumulator, parallel to the trigger's and
// deliberately not the same set. Two differences, both load-bearing:
//   - it records t1 CITATION matches too, which the trigger path short-circuits
//     past (a citation fires on its own, so it never needs to accumulate) —
//     but "The Hill wrote about H.R. 6500 today" is exactly the evidence a
//     caption is made of;
//   - nothing here is ever deleted on fire. The trigger spends corroboration
//     when it acts; the evidence of what was published does not stop being
//     true because we acted on it.
// And one thing the trigger's set never needed (conversation/v2, critic B-5):
// the ARTICLE LINK, first one per outlet per slug per run, so every count the
// band prints traces to a story a reader can open. An item whose link is not a
// checkable http(s) URL is not recorded here at all — counted below, so a feed
// that starts serving odd links shows up in the log instead of as a quietly
// thinner band. (parseFeed already drops items with no link, so in practice
// this counter should read 0.)
const conversationOutlets = new Map(); // slug -> Map<outlet, url>
let conversationLinkless = 0;
const addConversationOutlet = (slug, it) => {
  const url = normalizeArticleUrl(it.link);
  if (!url) {
    conversationLinkless++;
    return;
  }
  if (!conversationOutlets.has(slug)) conversationOutlets.set(slug, new Map());
  const outlets = conversationOutlets.get(slug);
  const outlet = it.outlet ?? UNRESOLVED_OUTLET;
  if (!outlets.has(outlet)) outlets.set(outlet, url);
};

const addLocalOutlet = (slug, it) => {
  if (!localOutletsBySlug.has(slug)) localOutletsBySlug.set(slug, new Set());
  localOutletsBySlug.get(slug).add(it.outlet ?? UNRESOLVED_OUTLET);
  addConversationOutlet(slug, it);
};

for (const it of newItems) {
  // The headline as the matcher reads it: a Google News title loses its
  // trailing " - Outlet" (headlineForMatching). The raw it.title is still what
  // the seen-set hashes, so no dedupe key moves.
  const title = headlineForMatching(it.title, it.link);
  const citations = findCitations(title);
  if (citations.length > 0) {
    for (const c of citations) {
      citationSlugs.add(c.slug);
      addConversationOutlet(c.slug, it);
    }
    continue; // citation tier wins outright - no need to also run t2/t3
  }
  const local = matchLocal(title, billIndex, { floorRecord });
  if (local?.tier === 't2') {
    addLocalOutlet(local.slug, it);
  } else if (local?.tier === 'ambiguous' && looksLegislative(title)) {
    if (t3Batch.length < T3_MAX_HEADLINES) {
      t3Batch.push({ title, candidates: local.candidates });
      t3Items.push(it);
    } else {
      t3Overflow.add(it); // over the cap: retried next run, never marked seen
    }
  } else if (local === null && looksLegislative(title)) {
    // t2 can only ever resolve to a bill already in the corpus, by
    // construction - so a legislative-looking headline with NO local
    // signal at all is exactly the "brand-new big bill covered by name"
    // case. Hand it to the nickname bridge below.
    bridgeItems.push(it);
  }
  // else: not legislative-looking (dropped).
}

const t3Results = await resolveWithHaiku(anthropic, t3Batch, { today: todayUTC });
console.log(`t3: ${t3Batch.length} headline(s) batched${t3Batch.length ? '' : ' (skipped - empty batch)'}, ${t3Results.size} resolved`);
if (t3Overflow.size > 0) {
  console.log(`t3 overflow: ${t3Overflow.size} ambiguous headline(s) past the ${T3_MAX_HEADLINES}-headline cap left unseen - offered to t3 next run`);
}
t3Items.forEach((it, i) => {
  const slug = t3Results.get(i);
  if (slug) addLocalOutlet(slug, it);
  else bridgeItems.push(it); // t3 declined every candidate - last chance is the bridge
});

// ---- Nickname bridge: t1/t2/t3 all missed ----
// ONE lazy Congress.gov list request per run (skipped entirely when no
// headline needs it), reused across all bridge headlines - see the header.
// Bridge matches are press-derived and flow into the SAME
// localOutletsBySlug accumulator, so the >=2-outlet guardrail applies to
// them unchanged.
if (bridgeItems.length > 0) {
  try {
    const listIndex = buildListIndex(await fetchRecentlyUpdated(NICKNAME_LIST_LIMIT));
    let hits = 0;
    for (const it of bridgeItems) {
      const match = matchNickname(extractNicknameTokens(headlineForMatching(it.title, it.link)), listIndex);
      if (match) {
        hits++;
        addLocalOutlet(match.slug, it);
      }
    }
    console.log(`nickname bridge: ${bridgeItems.length} headline(s) checked against ${listIndex.length} recently-updated bills, ${hits} matched`);
  } catch (e) {
    console.error(`nickname bridge skipped (list fetch failed): ${e.message}`);
  }
}

// Merge this run's t2/t3/bridge outlet contributions into the persisted
// pending state (stamping `updated` for the 7-day TTL), prune expired
// holds, THEN decide fires - corroboration accumulates across runs rather
// than resetting hourly (decideFires's header comment has the reasoning).
const nowISO = new Date().toISOString();
for (const [slug, outlets] of localOutletsBySlug) {
  const merged = new Set(cache.pendingOutlets[slug]?.outlets ?? []);
  for (const o of outlets) merged.add(o);
  cache.pendingOutlets[slug] = { outlets: [...merged], updated: nowISO };
}
const { kept, expired } = prunePendingOutlets(cache.pendingOutlets);
cache.pendingOutlets = kept;
if (expired.length > 0) {
  console.log(`pending holds expired unfired (>${PENDING_OUTLETS_TTL_DAYS}d without a 2nd outlet): ${expired.join(', ')}`);
}
console.log(summarizePendingOutlets(cache.pendingOutlets));
const pendingOutletsMap = new Map(
  Object.entries(cache.pendingOutlets).map(([slug, entry]) => [slug, new Set(entry.outlets)])
);
const { fired, reason } = decideFires(citationSlugs, pendingOutletsMap, tier0Slugs);
for (const [slug, label] of tier0Slugs) {
  // Loud by design: every guardrail bypass is individually visible in the
  // run log, with its government source named.
  console.log(`TIER0 FIRE: ${slug} <- ${label} (government record; bypasses the >=2-outlet press guardrail by design)`);
}
console.log(`fired this run: ${fired.size}${fired.size ? ' (' + [...fired].map((s) => `${s}:${reason.get(s)}`).join(', ') + ')' : ''}`);

// ---- ON FIRE: refresh (free) or decode (gated by per-budget caps) ----
// Two decode budgets, keyed off the fire reason: tier-0 government fires
// spend TIER0_*, everything press-derived spends NEWSDESK_*. decideFires
// lists tier-0 slugs first, so the highest-precision signal is never
// starved by a same-run press burst.
const forceSlugs = new Set(fired); // the trigger's own signal stands in for the status gate
const outcomes = [];
// The title Congress.gov served this run, per slug. Free — every syncOneBill
// call already fetched the bill detail — and it is the only way to notice a
// VEHICLE SWAP, since refreshBillFields deliberately never writes `title`.
// Kept here rather than re-fetched below so a bill that fired AND sits at the
// top of the ladder is not fetched twice.
const servedTitles = new Map();
let pressDecodesThisRun = 0;
let tier0DecodesThisRun = 0;
for (const slug of fired) {
  const [type, number] = slug.split('-');
  const isTier0 = (reason.get(slug) ?? '').startsWith('tier0');
  // Per-slug daily backoff: this slug already paid for a decode today and the
  // decode failed. A failure inside decode() - the shape check rejecting a
  // reply with a missing tag - is deterministic for a given bill, so retrying
  // it this hour buys the same failure at the same price. Suppressing only
  // the DECODE (not the whole sync) keeps a free refresh available if the
  // bill reaches the corpus by some other path in the meantime.
  const decodeFailedToday = cache.seen.has(failedDecodeKey(slug, todayUTC));
  const allowDecode = !decodeFailedToday && (isTier0
    ? tier0DecodesThisRun < TIER0_DECODE_CAP && cache.dailyDecodes.tier0Count < TIER0_DAILY_DECODE_CAP
    : pressDecodesThisRun < NEWSDESK_DECODE_CAP && cache.dailyDecodes.count < NEWSDESK_DAILY_DECODE_CAP);
  const result = await syncOneBill({ type, number }, { allowDecode, forceSlugs, bills, es, bySlug, anthropic });
  outcomes.push(result.outcome);
  if (result.fetchedTitle) servedTitles.set(slug, result.fetchedTitle);
  // Charged on the ATTEMPT, not the success: a decode that reached the model
  // and then threw spent exactly what a decode that landed spent. Before
  // 2026-08-09 only 'added' was charged, so a deterministic decode failure
  // cost the caps nothing and re-fired every hour, all day - unbounded paid
  // retries of something that could not succeed. The free outcomes
  // (refreshed/gated/budget, and a failure before the first model call) never
  // set decodeAttempted, so none of them can be charged. See chargeableDecode.
  if (chargeableDecode(result)) {
    if (isTier0) { tier0DecodesThisRun++; cache.dailyDecodes.tier0Count++; }
    else { pressDecodesThisRun++; cache.dailyDecodes.count++; }
    if (result.outcome !== 'added') {
      // Paid and failed - hold this slug's decode for the rest of the UTC day.
      cache.seen.add(failedDecodeKey(slug, todayUTC));
    }
  }
  if (result.outcome === 'refreshed' || result.outcome === 'added') {
    delete cache.pendingOutlets[slug]; // corroboration spent - a future re-fire needs fresh corroboration
  }
  if (isTier0) {
    // Mark the (slug, day, window) triple handled ONLY when the sync
    // actually landed (refreshed/added): a transient failure or a
    // decode-cap 'budget' deferral leaves the key unseen so the next hourly
    // run retries, while a handled bill won't re-fire from the same feeds
    // until the next floor window opens. Unchanged behavior per slot - the
    // slot is just no longer the whole day.
    if (result.outcome === 'refreshed' || result.outcome === 'added') {
      cache.seen.add(tier0Key(slug));
    }
  }
  const note = decodeFailedToday
    ? ' [decode suppressed: an earlier decode of this bill failed today - retries tomorrow]'
    : chargeableDecode(result) && result.outcome !== 'added'
      ? ' [decode attempted and failed - charged against the cap, held until tomorrow]'
      : '';
  console.log(`  ${slug}: ${result.outcome} (${reason.get(slug)})${note}`);
}

// ---- RE-DECODE TRIGGER: a bill about to be seen, explained from the wrong
// ---- document (design A6 + critic A-8) ----------------------------------
//
// Everything above answers "has this bill moved". This answers a different
// question the corpus could not previously ask: "is what we SAY about this
// bill still about this bill". The measured failure is hr-6500-119 — the
// Senate spent a week voting a continuing resolution under a bill number
// whose stored decode, headline and Spanish twin all described the AGOA
// Extension Act, on the page a reader would open to find out what the vote
// was about.
//
// WHO IS ELIGIBLE: only bills entering the two loudest rungs of the ladder —
// T0, the chamber's own announcement (data/floor-signals.json, written by
// scripts/floor-signals.mjs immediately before this script), and T1, a floor
// motion ripening in the record. A stale decode on a bill nobody is about to
// see is not worth a cent.
//
// WHAT IT SPENDS: the EXISTING tier-0 budget, no new one. Re-decodes queue
// behind this run's tier-0 fires and stop at the same per-run and per-UTC-day
// caps, so the code-enforced daily ceiling in this script's header is
// unchanged. The per-slug failed-decode hold applies too: a decode that pays
// and fails is not retried until tomorrow.
//
// WHAT KEEPS IT QUIET: redecodeVerdict refuses to fire on a null decoded_at
// with a matching title (critic A-8). The whole pre-2026-08-12 corpus has a
// null stamp, and reading "unknown" as "stale" would have spent the entire
// daily cap on day one re-explaining decodes that were fine.
//
// `floorSignals` is data/floor-signals.json, loaded (null-tolerant) above the
// matching loop, where the t3 floor record reads it first.
const candidates = redecodeCandidates({ signals: floorSignals?.signals, bills, now: Date.now() });
console.log(
  `re-decode: ${candidates.length} candidate(s) at the front of the ladder (${candidates.filter((c) => c.tier === 't0').length} T0, ${candidates.filter((c) => c.tier === 't1').length} T1)`
);
for (const cand of candidates) {
  const bill = bySlug.get(cand.slug);
  if (!bill) continue; // a T0 signal for a bill we don't hold yet is the fire path's job, not this one
  // The served title is only worth a free Congress.gov call for the T0 set —
  // the vehicle-swap case is by construction a bill the chamber has just
  // scheduled. T1 candidates are judged on their decode stamp alone. A bill
  // that already fired this run has its served title in hand from that call.
  let fetchedTitle = servedTitles.get(cand.slug) ?? null;
  if (cand.tier === 't0' && fetchedTitle === null) {
    const refresh = await syncOneBill(
      { type: bill.bill_type, number: String(bill.bill_number) },
      { allowDecode: false, forceSlugs: new Set(), bills, es, bySlug, anthropic }
    );
    outcomes.push(refresh.outcome);
    fetchedTitle = refresh.fetchedTitle ?? null;
    if (fetchedTitle) servedTitles.set(cand.slug, fetchedTitle);
  }
  const verdict = redecodeVerdict({
    decodedAt: bill.decoded_at ?? null,
    lastActionDate: bill.last_action_date ?? null,
    corpusTitle: bill.title,
    fetchedTitle,
    textVerifiedAt: bill.decode_text_verified_at ?? null,
  });
  if (!verdict.redecode) continue;
  if (cache.seen.has(failedDecodeKey(cand.slug, todayUTC))) {
    console.log(`  ${cand.slug}: re-decode suppressed (${verdict.reason}) - an earlier decode failed today, retries tomorrow`);
    continue;
  }
  if (tier0DecodesThisRun >= TIER0_DECODE_CAP || cache.dailyDecodes.tier0Count >= TIER0_DAILY_DECODE_CAP) {
    console.log(`  ${cand.slug}: re-decode deferred (${verdict.reason}) - tier-0 decode budget spent for this ${tier0DecodesThisRun >= TIER0_DECODE_CAP ? 'run' : 'day'}`);
    continue;
  }
  const result = await redecodeBill(cand.slug, { anthropic, es, bySlug, title: verdict.reason === 'vehicle-swap' ? fetchedTitle : null });
  outcomes.push(result.outcome);
  if (chargeableDecode(result)) {
    tier0DecodesThisRun++;
    cache.dailyDecodes.tier0Count++;
    if (result.outcome !== 'redecoded') cache.seen.add(failedDecodeKey(cand.slug, todayUTC));
  }
  console.log(`  ${cand.slug}: ${result.outcome} (re-decode: ${verdict.reason}, ${cand.tier.toUpperCase()})`);
}

// ---- THE CONVERSATION LAMP (design B1/B2 + critics B-1..B-4) -------------
//
// Everything above decided what to REFRESH. This writes down what was
// PUBLISHED — which rated outlets carried a story matched to which bill, and
// what congress.gov's own most-viewed list said — into a committed file, so
// that a month from now the question "why did the site show this bill that
// week" has an answer that is not "the Actions cache, which GitHub deleted".
//
// It changes no ranking. It fires no trigger. The only thing it can spend is
// the press decode budget already declared above, and only on the one case it
// exists to heal: a bill the press has JUST corroborated whose stored decode
// no longer describes the document Congress is acting on.
const conversationNow = Date.parse(nowISO);
// ONE "today" per run, and it is the same one the decode budget and the tier-0
// refresh slots are keyed by (todayUTC, captured before the first fetch): a run
// that straddles UTC midnight must not file its evidence under one date and
// its spend under another.
const today = todayUTC;
const previousConversation = (() => {
  try {
    return JSON.parse(readFileSync(CONVERSATION_PATH, 'utf8'));
  } catch {
    return null; // first run, or an unreadable file - build from scratch
  }
})();

// Critic B-4: a lean that has gone quiet is an alarm, not a silence.
cache.leanHealth = rollLeanHealth(cache.leanHealth, { basketLeans, liveLeans, today });
for (const alarm of darkLeans(cache.leanHealth, { today })) {
  console.log(
    `::warning::newsdesk: no ${alarm.lean}-rated feed in the press basket has produced an item for ${alarm.darkDays} days (last live ${alarm.lastLive ?? 'never'}; alarm at ${DARK_LEAN_ALARM_DAYS}). Cross-spectrum corroboration is skewed while this lasts - a story that side covers is structurally harder to corroborate, and every caption built on those counts inherits the skew. Check the ${alarm.lean}-rated feed URLs in scripts/newsdesk.mjs's SOURCES.`
  );
}

// The per-feed half, independent of the lean verdict above: a lean stays `ok`
// while ANY of its feeds lives, which is exactly how washingtontimes.com sat at
// HTTP 403 for six weeks with the right lean reading `ok` (header "THE
// PER-FEED DARK ALARM").
cache.feedLiveness = rollFeedHealth(cache.feedLiveness, {
  feeds: feedObservations,
  today,
  committed: previousConversation?._meta?.source_status?.feeds ?? null,
});
for (const dark of darkFeeds(cache.feedLiveness, { today })) {
  console.log(
    `::warning::newsdesk: press feed "${dark.name}" (${dark.domain ?? 'aggregator'}${dark.lean ? `, ${dark.lean}-rated` : ''}) has returned nothing for ${dark.darkDays} days (last live ${dark.lastLive ?? 'never, in the history this run can see'}; last failure: ${dark.lastError ?? 'unknown'}; alarm at ${FEED_DARK_ALARM_DAYS}). ${dark.lean ? `The ${dark.lean} lean can read ok while this lasts if another ${dark.lean}-rated feed is alive, so the basket is narrower than its construction claims. ` : ''}Fix or replace it in scripts/newsdesk.mjs's SOURCES - after checking the replacement's robots.txt and terms, and never by changing the user-agent to get past a block.`
  );
}

const mostViewedStatus = mostViewedRanked
  ? {
      status: 'ok',
      week: mostViewedRanked.week ?? null,
      week_label: mostViewedRanked.weekLabel ?? null,
      entries: mostViewedRanked.entries.length,
      checked_at: nowISO,
    }
  : {
      // The feed failed this run. Say so rather than let a missing list read as
      // "nothing is being read" - the stored week stays whatever it was, and
      // existing observations age out of the window on their own.
      status: 'error',
      week: previousConversation?._meta?.source_status?.most_viewed?.week ?? null,
      week_label: null,
      entries: 0,
      checked_at: nowISO,
    };

const nextConversation = buildConversation({
  previous: previousConversation,
  outletsBySlug: conversationOutlets,
  mostViewed: mostViewedRanked,
  bias,
  sourceStatus: {
    press: {
      status: health.dark ? 'dark' : health.pressDegraded ? 'degraded' : 'ok',
      feeds_total: SOURCES.length,
      feeds_silent: pressSilent,
      checked_at: nowISO,
    },
    most_viewed: mostViewedStatus,
    leans: leanStatuses(cache.leanHealth, { today }),
    feeds: feedStatuses(cache.feedLiveness, { today }),
  },
  now: conversationNow,
  today,
});

const pool = conversationPool(nextConversation, { today });
console.log(
  `conversation: ${Object.keys(nextConversation.slugs).length} slug(s) tracked, ${pool.filter((p) => p.tier === 'c1').length} corroborated (C1), ${pool.filter((p) => p.tier === 'c2').length} most-viewed+ (C2)`
);
if (conversationLinkless > 0) {
  console.log(
    `::warning::newsdesk: ${conversationLinkless} matched press item(s) carried no checkable http(s) link and were NOT recorded as conversation evidence (critic B-5: a count must trace to a story a reader can open). Check the feed that served them in scripts/newsdesk.mjs's SOURCES.`
  );
}

// ---- the re-decode half: only what the press JUST corroborated ------------
// Entering C1 is the trigger, not being C1 (a bill corroborated three days ago
// does not re-queue every hour), and C2 never queues anything at all - critic
// B-2, because congress.gov's view counts are the cheapest input here to game
// and must not be able to spend a cent on their own.
const stillC1 = new Set(pool.filter((p) => p.tier === 'c1').map((p) => p.slug));
const redecodeQueue = [
  ...new Set([
    ...enteredCorroborated({ previous: previousConversation, next: nextConversation, today }),
    ...(cache.conversationRedecodeQueue ?? []),
  ]),
]
  .filter((slug) => stillC1.has(slug))
  .sort();
const deferredRedecodes = [];
let conversationTitleChecks = 0;
if (redecodeQueue.length > 0) {
  console.log(`conversation re-decode: ${redecodeQueue.length} newly-corroborated candidate(s) - ${redecodeQueue.join(', ')}`);
}
for (const slug of redecodeQueue) {
  const bill = bySlug.get(slug);
  if (!bill) continue; // corroborated press for a bill we don't hold yet is the fire path's job
  let fetchedTitle = servedTitles.get(slug) ?? null;
  const judge = () =>
    redecodeVerdict({
      decodedAt: bill.decoded_at ?? null,
      lastActionDate: bill.last_action_date ?? null,
      corpusTitle: bill.title,
      fetchedTitle,
      textVerifiedAt: bill.decode_text_verified_at ?? null,
    });
  let verdict = judge();
  // The stamp alone said no. The remaining question is the expensive-to-miss
  // one - has the vehicle been swapped under the decode - and answering it
  // costs one FREE Congress.gov call, capped per run. Only asked when the
  // bill did not already fire this run (which would have supplied the title).
  if (!verdict.redecode && fetchedTitle === null && conversationTitleChecks < CONVERSATION_TITLE_CHECKS_PER_RUN) {
    conversationTitleChecks++;
    const refresh = await syncOneBill(
      { type: bill.bill_type, number: String(bill.bill_number) },
      { allowDecode: false, forceSlugs: new Set(), bills, es, bySlug, anthropic }
    );
    outcomes.push(refresh.outcome);
    fetchedTitle = refresh.fetchedTitle ?? null;
    if (fetchedTitle) servedTitles.set(slug, fetchedTitle);
    verdict = judge();
  }
  if (!verdict.redecode) {
    console.log(`  ${slug}: no re-decode needed (${verdict.reason})`);
    continue;
  }
  if (cache.seen.has(failedDecodeKey(slug, todayUTC))) {
    console.log(`  ${slug}: re-decode suppressed (${verdict.reason}) - an earlier decode of this bill failed today, retries tomorrow`);
    continue;
  }
  if (pressDecodesThisRun >= NEWSDESK_DECODE_CAP || cache.dailyDecodes.count >= NEWSDESK_DAILY_DECODE_CAP) {
    // Held in the cache rather than dropped: the file below will record this
    // bill as corroborated, so next hour it is no longer ENTERING C1 and would
    // silently lose its heal. It stays queued until it resolves or falls out
    // of C1.
    deferredRedecodes.push(slug);
    console.log(`  ${slug}: re-decode deferred (${verdict.reason}) - press decode budget spent for this ${pressDecodesThisRun >= NEWSDESK_DECODE_CAP ? 'run' : 'day'}; still queued`);
    continue;
  }
  const result = await redecodeBill(slug, {
    anthropic,
    es,
    bySlug,
    title: verdict.reason === 'vehicle-swap' ? fetchedTitle : null,
  });
  outcomes.push(result.outcome);
  if (chargeableDecode(result)) {
    pressDecodesThisRun++;
    cache.dailyDecodes.count++;
    if (result.outcome !== 'redecoded') cache.seen.add(failedDecodeKey(slug, todayUTC));
  }
  const ev = conversationEvidence(nextConversation.slugs[slug], { today });
  console.log(
    `  ${slug}: ${result.outcome} (re-decode: ${verdict.reason}, C1 on ${ev.ratedOutlets} rated outlets across ${ev.leanSpread.join('/') || 'no'} lean(s))`
  );
}
// Cap the carried queue: it can only ever hold currently-corroborated bills,
// but a cap is what keeps a pathological week from growing the cache forever.
cache.conversationRedecodeQueue = deferredRedecodes.slice(0, 25);

// ---- persist: cache always, data files only if something actually changed ----
// Every headline this run touched (matched or not, fired or not) is marked
// seen so it isn't reprocessed next hour - EXCEPT the t3 overflow, which this
// run never looked at: those stay unseen and are offered to t3 next run
// (2026-09-26; before then "over the cap" meant "never matched"). The one
// accepted tradeoff: a
// citation-matched brand-new bill that hits BOTH decode caps this run
// ('budget' outcome) still gets its headline marked seen, so it won't
// retrigger from that exact article next hour - but a genuinely newsworthy
// bill almost always accumulates fresh headlines hour over hour, and even
// absent that, the nightly sync's own priority gate (scripts/decode-gate.mjs)
// will pick it up within a day once it has real recorded motion.
for (const it of newItems) {
  if (!t3Overflow.has(it)) cache.seen.add(hashHeadline(it.title, it.outlet));
}
saveCache(cache);

// The conversation file has its OWN material-change rule and its own reasons
// to move, so it is written independently of the corpus: an hour that fired
// nothing can still have learned that a second rated outlet picked up a bill,
// and an hour that re-decoded a bill may have learned nothing new about the
// conversation. Both are normal; neither should drag the other into a commit.
if (shouldWriteConversation({ previous: previousConversation, next: nextConversation })) {
  writeFileSync(CONVERSATION_PATH, `${JSON.stringify(nextConversation, null, 2)}\n`);
  console.log(`DONE: wrote ${CONVERSATION_PATH}`);
} else {
  console.log(`DONE: no material change - ${CONVERSATION_PATH} untouched (an hourly run must not produce a deploy)`);
}

if (anyDataChanged(outcomes)) {
  writeFileSync('data/bills.json', JSON.stringify(bills));
  writeFileSync('data/bills-es.json', JSON.stringify(es));
  const refreshedCount = outcomes.filter((o) => o === 'refreshed').length;
  const addedCount = outcomes.filter((o) => o === 'added').length;
  console.log(`DONE: ${refreshedCount} refreshed, ${addedCount} added+decoded; corpus ${bills.length}`);
} else {
  console.log('DONE: no data changes this run - nothing written (the workflow commit step will no-op)');
}

// LAST, and after saveCache: the streak has to survive the failure it causes,
// or the next run starts over at 1 and the build never actually reds. The
// workflow's cache-save step is `if: always()`, and the write above already
// happened, so both halves of that hold.
if (cache.feedHealth.escalate) {
  console.log(`::error::newsdesk has been fully dark for ${cache.feedHealth.consecutiveDark} consecutive hourly runs (>=${FEED_DARK_ESCALATE_RUNS}) - every tier-0 government feed failed and every press feed returned nothing, for ${cache.feedHealth.consecutiveDark} hours straight. This is an ingest outage, not a quiet news day: no bill can trigger a refresh or a decode while it lasts. Check network egress from the runner, then each feed URL in scripts/newsdesk.mjs's SOURCES/TIER0_SOURCES.`);
  process.exit(1);
}

# Oravan Embeds — launch kit (KTD-8 outreach)

**Status:** ready for the KTD-8 send. **Sends:** week of Oct 26, 2026, immediately after S16 ships the free-tier embed MVP (`docs/ideation/2026-07-05-build-gtm-strategy.md` §1.3 S16, §8; sequencing ruling at §1.3 line "KTD-8's sends move to the week of Oct 26"). **Read window:** 14 days, Referer-nominate + manual-confirm, landing ~Nov 9–13.

**What this is not:** a press embargo. Per §2.2.3's pattern for ongoing service-journalism partnerships (Factchequeado, El Tímpano, Conecta Arizona), this is a resource/partnership pitch, not an embargoed exclusive — no date/time coordination, two-touch cap still applies (§2.3), first touch and one follow-up only.

**Where recipients land:** every link in this kit points at `{SITE_ORIGIN}/embeds` — the public configurator + docs page (S16). That page is the entire onboarding: pick a widget, pick a bill, copy a snippet, done. No sales call, no signup, no account.

---

## 1. Outreach email template

Subject line options (pick one, keep it factual, no exclamation points — same house style as the press-kit pitch in §2.4):

- `A free, no-tracking embed for your site: find-your-rep and bill explainer widgets`
- `Oravan: a civic widget with nothing to disclose about your visitors`

Body:

```
Hi {FirstName},

I'm Colby, the solo builder behind Oravan (https://{SITE_ORIGIN}) — a free,
nonpartisan tool that helps people find their federal representatives and
understand active bills in plain language, in English and Spanish.

I'm reaching out because Oravan now ships two free, self-serve widgets you
can drop into {OrgName}'s own pages with one script tag:

  - Representative lookup: a reader types a ZIP code, gets their three
    federal representatives with every phone number that reaches them.
  - Bill card: one bill's plain-language headline, current status, and a
    freshness date — useful inside a story about that bill.

Both are built the way I'd want a civic tool to work if I were the one
embedding it: a cross-origin iframe, so nothing on {OrgName}'s own page can
read anything a visitor types into the widget; zero cookies; zero
third-party requests; no address field ever asked for inside the embed
(that stays only on Oravan's own site, one click away). These aren't just
claims — they're enforced by automated tests in the public repository,
on every change, before it ships.

You can see both widgets, configure one for your own use, and copy the
exact snippet here, no account needed:

  {SITE_ORIGIN}/embeds

It's free with attribution (a small "Powered by Oravan" link), nonpartisan
by construction, and AI-drafted content is always labeled as such. If it's
useful to {OrgName}'s readers, I'd love to hear about it — and if it's not
a fit, no worries at all.

Thanks for your time,
Colby
Oravan — {SITE_ORIGIN}
```

Placeholders: `{FirstName}`, `{OrgName}`, `{SITE_ORIGIN}` (today: the value in `lib/site.ts`'s `SITE_ORIGIN` constant — swap to the post-rename domain once that lands, per that file's own header comment).

**Follow-up (send once, 2–3 business days after no response — §2.3's best-supported gap, and the two-touch cap this kit inherits from the citizen-product outreach mechanics):**

```
Hi {FirstName}, following up in case this got buried — happy to answer any
questions about how the embed works, or just to hear it's not a fit. Either
way, thanks for a look: {SITE_ORIGIN}/embeds
```

**Target list:** this kit intentionally does not duplicate a target roster — reuse the vetted, partisan-coding-checked lists already assembled in `docs/ideation/2026-07-05-build-gtm-strategy.md` §2.2 (journalists/newsletters), §2.2.2 (creators), and §2.2.3 (Spanish-language outlets), plus LION (Local Independent Online News), INN (Institute for Nonprofit News), and library-listserv contacts per the embeds spec's own build estimate (`docs/ideation/2026-07-02-embeds-spec.md` §6, "launch kit (LION/INN/library-listserv outreach email, demo pages)"). Every recipient still needs the same partisan-coding review §2.2's table applies before a first send — this kit doesn't relax that bar.

---

## 2. One-pager: the embed's pitch

**What it is.** Two free, self-serve widgets — a representative lookup and a bill-explainer card — that any site can embed with one `<script>` tag. Built from the same static civic data that powers Oravan's own citizen site: current members of Congress, district offices, and a nightly-refreshed, bilingual, AI-decoded (and human-reviewed) plain-language summary of every active federal bill.

**The one claim that matters, made verifiable rather than promised:** *"This widget collects nothing about your visitors — and because it's a cross-origin iframe, even your own page's scripts can't see what they type into it."* That's not a policy statement; it's the browser enforcing an origin boundary. Zero cookies, zero third-party requests, no address field inside the iframe, and no visitor data reaching Oravan beyond an ordinary page load — all four are asserted by automated tests in Oravan's own public repository, not just this copy.

**Who it's for.** Newsrooms embedding a bill card inside a story. Libraries and civic-education sites offering a rep-lookup tool with no vendor contract and no data-sharing agreement to review. Nonpartisan civic organizations that want a neutral utility, not a mobilization platform.

**What's free, what's not (yet).** The free tier is full-function with one requirement: a "Powered by Oravan" attribution link stays visible in the widget footer, always. Both widgets take the same theming (accent, corner radius, font — validated server-side), and a brandless-chrome option removes the Oravan name from widget titles and fallback labels while keeping the attribution link (S5a). Removing attribution itself is reserved for licensed partners; there is no paid tier live today — licensing terms, the AI call-script action panel, and usage stats remain a later phase (V1.1, `docs/ideation/2026-07-02-embeds-spec.md` §4) and are not part of this outreach's offer. Partner-facing overview: /partners.

**The neutrality commitment, in Colby's own words (verbatim, settled — `docs/ideation/2026-07-05-build-gtm-strategy.md` §3):**

> "The moneyed segment (advocacy orgs) buys advocate-data capture — lists, CRMs, conversion funnels. Oravan's constitution forbids building those mechanics for anyone, which resolves the 'would you sell to advocacy groups?' fork without touching partisanship: Oravan sells neutral utilities to institutions that need neutrality, and never builds capture mechanics for any customer. If an advocacy org embeds the free widget, that's fine — it's a utility, like embedding a map; attribution keeps it legibly Oravan's voice, and the ToS bars misrepresenting Oravan's neutrality. What's never for sale: stance-shaping, member capture, unlabeled white-label of the call flow."

**Why now.** Google's Civic Information API's Representatives lookup and the ProPublica Congress API — the two free sources newsrooms and libraries used to build this kind of tool on — are both dead (April 2025 and July 2024 respectively). Oravan's rep-lookup embed is a direct, no-cost replacement for that specific hole, not a new category of ask.

**Bilingual by construction, not as an add-on.** Every widget ships with an always-visible EN/ES toggle. A host page can set the default language; it can never remove Spanish. This is the same constitutional bilingual-parity rule that governs every other surface Oravan ships.

**Try it / configure one:** `{SITE_ORIGIN}/embeds`

---

## 3. Manual install-confirmation protocol

Per the settled measurement design (`docs/ideation/2026-07-05-build-gtm-strategy.md` §1.3 "Sequencing ruling," ledger item F3): the 20-email outreach's read is a **GTM/prioritization signal, not a build/kill gate** — embeds are core regardless of what this reads. The protocol below is the *human* half of that measurement; the *technical* half (referrer truncation at ingestion — registrable domain + count only, truncated before persistence) is F3's own scope, owned by S15 running concurrently with this sprint. This document describes the process that machinery feeds, not a claim that this PR built it.

**The design, stated plainly: Referer nominates, Colby confirms.**

1. **Nominate.** Each embed pageview's (truncated, registrable-domain-only) Referer is a *candidate* installed domain — never a confirmed one on its own. Referer is client-controlled and forgeable; a single spoofed header must never, by itself, count as an install or trigger any downstream action.
2. **Confirm.** Before a nominated domain counts toward the outreach read, Colby visits that domain directly and visually confirms a live, working Oravan embed is actually rendering there — a real page-load fixture, not a header claim. This is a manual, human step by design; it is the one place in the entire embeds product where a claim about the outside world converts into a number Oravan reports on.
3. **Count.** Only manually-confirmed domains contribute to the 14-day read (~Nov 9–13). The read answers one question: did outreach accelerate adoption relative to the free tier's organic baseline? It does not gate whether the paid tier or any further embed investment happens — that was the ruling that promoted embeds to a core, non-gated build component in the first place.

**What this protocol deliberately does not do:** it does not identify or log individual visitors to any embed (that's the F3/S15 privacy-hardening boundary, unrelated to and stricter than this install-confirmation process); it does not treat an unconfirmed Referer nomination as a citable number in any grant application or press material; and it does not run automatically — the confirmation step is manual by design, not a missing automation.

---

## Appendix: where the rest of the launch material lives

- Configurator + public docs (the artifact every link above sends to): `{SITE_ORIGIN}/embeds`
- Product spec: `docs/ideation/2026-07-02-embeds-spec.md`
- Build/GTM strategy, embeds sections: `docs/ideation/2026-07-05-build-gtm-strategy.md` §1, §2.2–2.5, §3, §8
- Outreach target lists (journalists, creators, Spanish-language outlets — partisan-coding-checked): same strategy doc, §2.2, §2.2.2, §2.2.3
- Citizen-product press kit checklist (shared house style, not embed-specific): same strategy doc §2.5

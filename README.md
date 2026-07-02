# Rostra

**Your line to Congress · Tu línea con el Congreso**

Rostra is free, nonpartisan civic infrastructure: find your federal representatives, understand active bills in plain language (English and Spanish), get a 30-second call script, and make the call — in under 5 minutes, with no account.

The name is the **Rostra**: the platform in the Roman Forum where citizens stood to address the public and the powerful — the original place a voice met power. Latin roots are the shared ancestry of English and Spanish alike.

## Design principles

1. **Zero accounts.** ZIP code, interests, and call history live in `localStorage` on the visitor's device. No server-side user data exists — nothing to breach, leak, or subpoena. This is the core privacy posture for at-risk users, not a missing feature.
2. **Static-first.** Bills, legislators, district offices, and ZIP→district mappings are static JSON in `data/`, baked into ~1,000 statically generated pages. Fast, nearly free to host, resilient under load. The only dynamic endpoints are `/api/script` (AI script generation, cached per bill+stance+language, IP rate-limited), `/api/reps` (pure lookup), `/api/district` (stateless split-ZIP address refinement: proxies the Census geocoder so the visitor's IP never reaches census.gov; the address is never stored or logged), and `/api/heartbeat` (the anonymous call tally).
3. **Bilingual as a first-class feature.** Full EN/ES UI via `next-intl`; scripts are generated in the user's language.
4. **The call moment is the product.** Voicemail is legitimized (offices tally it identically), after-hours calling is encouraged, district offices are listed alongside DC, and outcomes (spoke / voicemail / couldn't reach) are logged locally.
5. **Honest about AI.** Every generated summary and script is labeled, editable, and reviewed by the human before any call.
6. **Accessible by default.** Semantic landmarks, skip link, visible focus, `prefers-reduced-motion`, 44px+ touch targets, AA contrast.

## Data sources

| File | Source | Refresh |
|---|---|---|
| `data/bills.json` | Decoded bill corpus (Congress.gov bills + AI plain-language summaries) | Manual export for now; steady-state pipeline TBD |
| `data/legislators.json` | [unitedstates/congress-legislators](https://github.com/unitedstates/congress-legislators) (public domain) + district offices | `scripts/process-data.py` |
| `data/zip-districts.json` | [OpenSourceActivismTech/us_zipcodes_congress](https://github.com/OpenSourceActivismTech/us_zipcodes_congress) | same |
| `data/coverage.json` | Real news articles about top-band bills via [TheNewsAPI](https://www.thenewsapi.com/), AI-relevance-filtered (Haiku) | `scripts/sync-coverage.mjs` (nightly, gated on `NEWS_API_KEY`) |
| `data/media-bias.json` | Outlet political-lean ratings by [AllSides](https://www.allsides.com/media-bias/ratings), used under CC BY-NC with attribution | Vendored snapshot |

Portraits are served from the public-domain [unitedstates/images](https://github.com/unitedstates/images) project.

### The "Read" section (outlet-bias coverage)

Each top bill's page shows real third-party articles about it, labeled by the **outlet's** political lean (Left / Center / Right) — reusing AllSides' publication-level ratings, never a Rostra-invented one. Rostra takes no stance and authors no partisan text: the only AI use is a cheap relevance gate (is this article about this bill?). The ingestion runs nightly in CI and bakes results to JSON, so the site still makes **zero runtime third-party calls**. Without `NEWS_API_KEY` the sync is a no-op and the section renders nothing; a small hand-built real sample (`data/coverage.json`) keeps it demoable. Lean is shown by **text label + position only — never party colors** (a hard rule; see `DESIGN.md`).

## Develop

```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local   # script generation + decode/relevance
echo "NEWS_API_KEY=..." >> .env.local               # optional; enables the "Read" coverage sync
npm run dev
```

`npm run build` statically generates every bill page in both locales.

## Known v1 caveats

- ZIP→district mapping is ZCTA-based; a split ZIP shows all candidate districts by default (senators are unaffected). Entering a street address — optional, sent once by POST, never stored or logged — narrows it to the actual district via a server-proxied Census-geocoder lookup; the all-candidates view remains the graceful fallback whenever the geocoder can't help. The geocoder request pins the "119th Congressional Districts" layer, which needs a bump when the Census rolls the vintage to the 120th.
- Script cache and rate limits are in-memory per serverless instance — fine at demo scale, should move to a shared store before heavy traffic.
- Spanish bill *summaries* are not yet pre-translated (UI and scripts are fully bilingual).
- Bill corpus is a snapshot; no live sync yet.
- "Read" coverage exists only for top-band bills (the long tail shows nothing); the ES locale shows the same English articles with localized chrome; outlets absent from `data/media-bias.json` appear without a lean chip.

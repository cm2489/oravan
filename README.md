# Cabina

**Your line to Congress · Tu línea con el Congreso**

Cabina is free, nonpartisan civic infrastructure: find your federal representatives, understand active bills in plain language (English and Spanish), get a 30-second call script, and make the call — in under 5 minutes, with no account.

The name is the Spanish word for *booth*: **cabina telefónica** (phone booth), **cabina de votación** (voting booth).

## Design principles

1. **Zero accounts.** ZIP code, interests, and call history live in `localStorage` on the visitor's device. No server-side user data exists — nothing to breach, leak, or subpoena. This is the core privacy posture for at-risk users, not a missing feature.
2. **Static-first.** Bills, legislators, district offices, and ZIP→district mappings are static JSON in `data/`, baked into ~1,000 statically generated pages. Fast, nearly free to host, resilient under load. The only dynamic endpoints are `/api/script` (AI script generation, cached per bill+stance+language, IP rate-limited) and `/api/reps` (pure lookup).
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

Portraits are served from the public-domain [unitedstates/images](https://github.com/unitedstates/images) project.

## Develop

```bash
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local   # only secret; script generation
npm run dev
```

`npm run build` statically generates every bill page in both locales.

## Known v1 caveats

- ZIP→district mapping is ZCTA-based; split-ZIP addresses see all candidate districts (senators are unaffected). A street-address fallback is a v2 candidate.
- Script cache and rate limits are in-memory per serverless instance — fine at demo scale, should move to a shared store before heavy traffic.
- Spanish bill *summaries* are not yet pre-translated (UI and scripts are fully bilingual).
- Bill corpus is a snapshot; no live sync yet.

# Product

## Register

product

> The app screens (feed, bill detail, reps, impact) are the working surface. The landing page leans brand but shares the same system.

## Users

U.S. residents who want Congress to hear them but have never called a congressional office. Bilingual by design: everything ships in English and Spanish together. English is the primary audience; Spanish (~5–7% of users) is a pass/fail quality gate, never a co-equal design driver (owner weighting, 2026-07). Three audiences shape every decision: (1) first-time callers who are nervous and need the mechanics demystified; (2) Spanish-dominant residents underserved by every existing tool in this space; (3) at-risk users (immigrants, activists, marginalized groups) for whom a stored political profile is a real-world hazard. Mobile-first, often a few spare minutes, possibly a slow connection.

## Product Purpose

Oravan is free, nonpartisan civic infrastructure: find your three members of Congress by ZIP, read any active bill in plain language, get a 30-second editable call script in your language, and make the call — or leave an after-hours voicemail, which counts identically. Zero accounts: all personal data lives in the visitor's browser. Success is a nervous first-timer completing a call in under 5 minutes and feeling like it counted.

## Brand Personality

**The lit platform at night.** A public place to stand and be heard, warmly lit against a dark civic landscape — trustworthy, always open. Three words: welcoming, plain-spoken, steady.

- Colour, shape and type: see `docs/current-direction.md`. (Until 2026-09-27 this line restated `DESIGN.md`'s July 2026 palette, which the owner retired on 2026-09-25; that palette is kept as a dated record in `docs/history/DESIGN-2026-07-24.md`.)
- Plain language is the product. 8th-grade reading level. The decoded translation always beats the official text for prominence.
- Calm confidence, never urgency-theater. Anxiety is met with reassurance (voicemail is legitimate, staffers don't debate you).

## Anti-references

- **Partisan/activist tools**: tribal red/blue, "fight/resist" verbs, alarm and outrage mechanics.
- **Generic SaaS**: gradient heroes, icon-card grids, dashboard templates, hero metrics.
- **Government officialdom**: bureaucratic density, legalese adopted as product voice.
- **Gamified engagement**: badges, streaks, leaderboards, public profiles.

## Design Principles

1. **Zero accounts is sacred.** Nothing personal ever touches a server. Every design choice must survive the question "does this require knowing who the user is?"
2. **Decode, don't display.** Plain language leads; official text is the reference, not the voice.
3. **Both languages are first-class.** Nothing ships in English that doesn't ship in Spanish.
4. **Lower the call barrier.** Voicemail parity, after-hours framing, "a staffer just tallies your position" reassurance, edit-until-it-sounds-like-you scripts.
5. **Honest about AI.** Every generated artifact is labeled, and nothing publishes unless the automated gates pass (bilingual parity, the official record attached, schema). The nightly decode path is not human-reviewed and the product never claims it is; Big Question text is written by AI too and publishes on the same automated gates, and nothing on the site says a person reviews it. Nonpartisan wording is a drafting instruction on decodes and an enforced vocabulary lint on Big Questions only — never the same guarantee, never described as one. (Amended 2026-08-02 to match CLAUDE.md's 2026-07-25 correction — the previous "human-reviewed" wording here was the same false claim. Amended 2026-08-06 to drop "forbidden-vocabulary lint" from the gate list: it runs on Big Questions, never on decodes — see `docs/constitution-log.md#ai-content-2026-08-06-vocab` for the measurement. Corrected 2026-09-27: this line said Big Question entries were hand-reviewed, which stopped being true on 2026-09-25, when the owner ruled that Big Questions run fully automatically and #280 changed the site copy to match.)
6. **Accessible by default.** WCAG AA contrast, keyboard-complete flows, visible focus, 44px targets, reduced-motion.

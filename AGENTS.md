# AGENTS.md

Agent-facing project context. `CLAUDE.md` holds the hard rules and
architecture; `README.md` holds the product constitution; `DESIGN.md` holds
the visual system. This file carries what design tooling reads directly.

## Design Context

Register: product (per PRODUCT.md), with brand-register front doors — `/`,
`/why-call`, `/about`, `/partners`, `/questions` (route renamed from `/moments` in this train). Scope design commands to a
named route so the register follows the surface.

Personas (project-specific; design critiques should walk these alongside the
generic set):

- **María — Spanish-dominant first-time caller.** Reads and calls in Spanish
  only. Any English leak, machine-translation seam, or string that runs long
  in Spanish is a finding, not a nit. She is nervous about calling a
  government office at all; every extra step before the script is a place
  she leaves.
- **The nervous first-timer.** Has never called a congressional office and
  half-believes they'll be debated or quizzed. Every surface that touches
  the call must lower the barrier: voicemail parity, "a staffer just tallies
  your position," edit-until-it-sounds-like-you. Urgency theater or
  advocacy tone breaks trust instantly.
- **The at-risk reader.** Immigrant, activist, or member of a marginalized
  group for whom a stored political profile is a real-world hazard. Reads
  privacy claims skeptically and checks them. Anything that looks like
  tracking, an account, or a server-side record of their position is
  disqualifying — even a false impression of one.
- **The partner-org evaluator.** A newsroom or library deciding whether to
  embed Oravan's widgets. Judges the configurator and embed surfaces like a
  professional: theming fidelity, attribution honesty, accessibility of the
  embedded result on THEIR site.

Non-negotiables the personas enforce: nonpartisan by construction (no party
colors, no advocacy language, either locale); AI content labeled at first
contact; WCAG AA and 44px targets; both languages first-class with English
the primary audience and Spanish a pass/fail quality gate.

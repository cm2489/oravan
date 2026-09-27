# Accessibility — the method

The rule is page 1, rule 7 of `CLAUDE.md`: semantic HTML; visible focus; AA contrast on every enforced pair, computed, not eyeballed; 44px targets (a link inline in a sentence is exempt); reduced motion honoured; no horizontal overflow at 320px. This page is how to meet it.

Moved here from `DESIGN.md` on 2026-09-27, when `DESIGN.md` was retired (its Focus and Contrast sections, the accessibility floor, and the reduced-motion paragraphs; the rest of that file is `docs/history/DESIGN-2026-07-24.md`). **The method binds; the token names and ratios below are the July 2026 values.** They are computed against the tokens in `app/globals.css` as they stood on that date. When the rebuild changes the tokens (see `docs/current-direction.md`), recompute every pair with `lib/contrast.ts` and update this page in the same PR — a ratio copied from here onto a new palette is exactly the eyeballing rule 7 forbids.

## The floor

Semantic HTML, visible focus, AA contrast, 44px touch targets. A link sitting inline inside a sentence is exempt from the 44px floor (WCAG 2.5.8) — inflating it breaks the line. Everything else uses `min-h-11` (44px) or better.

Gates: `tests/bill-a11y.spec.ts` sweeps the bill page (at rest and with the call panel open) for targets under 44×44 with exactly that inline exemption, and for visible focus; the other pages have no such sweep yet (the 2026-09-27 audit, SY-56). `tests/contrast.unit.spec.ts` pins the contrast math. The `webkit-320` Playwright project runs every test tagged `@reflow` at 320px, where WCAG 1.4.10 is specified.

## Focus

Two-tone by construction, and that is the only reason it passes 1.4.11.

A 3px `ink` ring alone on a `go`-filled button is **2.75:1** — a fail. So the ring is never adjacent to the fill. A filled control swaps its **own** border to the gap tone on focus. Add `ring-gap` to any solid button and the stack reads outward:

```
go fill │ paper border 6.43 │ paper gap │ ink ring 17.66 │ paper page 17.66
```

Every adjacency clears 3:1. Ground contexts retune the two tones:

- `.on-dark` — any ink enamel ground (footer, voicemail, transcript title bar). Ring = paper (17.66 on ink), gap = ink.
- `.on-go` — the green enamel panel. Ring = paper (9.75 on go-deep), gap = go-deep. Stack: `white fill │ go-deep border 9.75 │ go-deep gap │ white ring 9.75 │ go-deep panel 9.75`.

Focus is **never** removed. With the July tokens it is never drawn in `go`, because `go` is what buttons are filled with, and a green ring on a green button is 1.00:1 — the general form of that rule is: never draw the ring in the colour of the thing it surrounds.

## Contrast

Every enforced pair is computed with `lib/contrast.ts` (WCAG 2.x) against the rendered hex — not eyeballed, not inherited from a mockup comment. **The full ledger is the comment block at the top of `app/globals.css`.** Recompute it if any value changes.

Three results for the July tokens that you must know before you build on them:

1. **`line-strong` on `wash` is 2.97:1 — 1% short of 3:1.** It clears on paper (3.24). An *enabled* component's `line-strong` edge must therefore have `paper` on at least one side; a component whose own ground is `wash` takes an `ink-2` edge (7.23) instead. The one place the reference puts a `line-strong` edge on a `wash` fill is a **disabled** control, and 1.4.11 exempts inactive components. Do not "fix" this by lightening `wash` or by promoting `line` to an edge.
2. **`go` and `alert` sit 1.19:1 apart in luminance** — to a deuteranope they are near-identical. `alert` is therefore never the sole carrier of meaning: a failure always also carries a 3px rule, a bold text label, and the right ARIA (`aria-invalid`, `role="alert"`). Color is the third signal, never the first.
3. **Fill colors are not boundaries.** `urgent` on paper is 1.54:1 and `tint` on paper is 1.15:1, and both are fine — the amber chip is found by its ink text (11.44) and the printed date, not by being yellow, and `tint` is always carrying ink text. But any *control* on a tinted ground still takes a `line-strong` or `ink` edge.

## Reduced motion

`prefers-reduced-motion: reduce` collapses every transition and animation globally, in `app/globals.css`.

**Transforms survive on purpose.** The stamp's tilt is *static geometry*, not motion, so it must still be there when motion is off. Never express a permanent shape as an animation.

Reduced motion is a first-class path, not a disabled one: crossfade or instant, same information, same order (clause 4 of the motion contract in `docs/current-direction.md`).

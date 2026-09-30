# Accessibility — the method

The rule is page 1, rule 7 of `CLAUDE.md`: semantic HTML; visible focus; AA contrast on every enforced pair, computed, not eyeballed; 44px targets (a link inline in a sentence is exempt); reduced motion honoured; no horizontal overflow at 320px. This page is how to meet it.

Moved here from `DESIGN.md` on 2026-09-27, when `DESIGN.md` was retired (its Focus and Contrast sections, the accessibility floor, and the reduced-motion paragraphs; the rest of that file is `docs/history/DESIGN-2026-07-24.md`). **The method binds; the ratios below are computed for the warm-paper, bottle-green tokens (colour direction c, the owner's pick of 2026-09-30; recomputed with `lib/contrast.ts` that day).** They replaced the July 2026 values. When the rebuild changes the tokens again (see `docs/current-direction.md`), recompute every pair with `lib/contrast.ts` and update this page in the same PR — a ratio copied from here onto a new palette is exactly the eyeballing rule 7 forbids.

## The floor

Semantic HTML, visible focus, AA contrast, 44px touch targets. A link sitting inline inside a sentence is exempt from the 44px floor (WCAG 2.5.8) — inflating it breaks the line. Everything else uses `min-h-11` (44px) or better.

Gates: `tests/bill-a11y.spec.ts` sweeps the bill page (at rest and with the call panel open) for targets under 44×44 with exactly that inline exemption, and for visible focus; the other pages have no such sweep yet (the 2026-09-27 audit, SY-56). `tests/contrast.unit.spec.ts` pins the contrast math. The `webkit-320` Playwright project runs every test tagged `@reflow` at 320px, where WCAG 1.4.10 is specified.

## Focus

Two-tone by construction, and that is the only reason it passes 1.4.11.

A 3px `ink` ring alone on a `go`-filled button is **2.24:1** — a fail. So the ring is never adjacent to the fill. A filled control swaps its **own** border to the gap tone on focus. Add `ring-gap` to any solid button and the stack reads outward:

```
go fill │ paper border 7.36 │ paper gap │ ink ring 16.50 │ paper page 16.50
```

Every adjacency clears 3:1. Ground contexts retune the two tones:

- `.on-dark` — any ink enamel ground (footer, voicemail, transcript title bar). Ring = paper (16.50 on ink), gap = ink.
- `.on-go` — the green enamel panel. Ring = paper (11.32 on go-deep), gap = go-deep. Stack: `paper fill │ go-deep border 11.32 │ go-deep gap │ paper ring 11.32 │ go-deep panel 11.32`.
- `.on-band` — the masthead band (the site header on `go-deep`). Ring = paper (11.32 on the band, where the default ink ring would be 1.46), gap = go-deep. Unlike `.on-go` it leaves the type's line-heights alone.

Focus is **never** removed. It is never drawn in `go`, because `go` is what buttons are filled with, and a green ring on a green button is 1.00:1 — the general form of that rule is: never draw the ring in the colour of the thing it surrounds.

## Contrast

Every enforced pair is computed with `lib/contrast.ts` (WCAG 2.x) against the rendered hex — not eyeballed, not inherited from a mockup comment. **The full ledger is the comment block at the top of `app/globals.css`.** Recompute it if any value changes.

Three results for the current tokens that you must know before you build on them:

1. **`line-strong` clears 3:1 on both grounds: 4.24 on paper, 3.89 on wash.** The July palette missed on wash by 0.03 (2.97), which forced an enabled component's `line-strong` edge to keep `paper` on one side; this palette lifts that restriction. If a future palette misses again, do not "fix" it by lightening `wash` or by promoting `line` (1.30 on paper, decorative only) to an edge.
2. **`go` and `alert` sit 1.24:1 apart in luminance** (alert and ink: 2.78) — to a deuteranope go and alert are near-identical. `alert` is therefore never the sole carrier of meaning: a failure always also carries a 3px rule, a bold text label, and the right ARIA (`aria-invalid`, `role="alert"`). Color is the third signal, never the first.
3. **Fill colors are not boundaries.** `urgent` (the lamp) on paper is 1.47:1 and `tint` on paper is 1.14:1, and both are fine — a lamp is found by its ink text (11.20) and, on a control, its ink edge (a picked stance) or `line-strong` edge (the House finder), and the Today floor notice by its printed date, not by being yellow; `tint` is always carrying ink text. But any *control* on a tinted ground still takes a `line-strong` or `ink` edge.

The masthead band adds three text pairs, all in the ledger: the wordmark and nav on the band (paper on go-deep, 11.32), the trust line (go-pale on go-deep, 8.26) and the inverted language switch (go-deep on paper, 11.32).

## Reduced motion

`prefers-reduced-motion: reduce` collapses every transition and animation globally, in `app/globals.css`.

**Transforms survive on purpose.** The stamp's tilt is *static geometry*, not motion, so it must still be there when motion is off. Never express a permanent shape as an animation.

Reduced motion is a first-class path, not a disabled one: crossfade or instant, same information, same order (clause 4 of the motion contract in `docs/current-direction.md`).

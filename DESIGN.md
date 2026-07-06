# Design

Tokens live in `app/globals.css` under `@theme` (Tailwind v4). Use them; never raw hex in components.

## Color

| Token | Value | Role |
|---|---|---|
| `paper` | #F3ECDD | page background (aged cream page stock) |
| `paper-deep` | #E4D9C0 | recessed surfaces (footer, decoded card, how-it-works band) |
| `surface` | #FBF8F0 | raised card surface: brighter page stock that lifts off paper without going clinical `#fff` |
| `ink` | #2A2318 | primary text (iron-gall ink) |
| `ink-soft` | #51473A | secondary text |
| `ink-faint` | #6B6152 | meta text (AA on both papers) |
| `night` | #1B1611 | header/hero band, solid dark buttons |
| `brass` | #82632A | the tarnished-brass accent (renamed from the Cabina-era `booth` in the Oravan migration, PR-1): step numerals, active tab, focus ring, filled CTAs (with `paper` text) |
| `brass-bright` | #D9B65C | brass on dark grounds (mobile active tab, OG tag lines) |
| `brass-deep` | #6B5223 | pressed/hover state for brass-filled controls |
| `brass-soft` | #F1E7C9 | tag pills, info panels |
| `line` | #DDD2BB | hairlines, borders |
| `moss` / `moss-soft` | #3E6B4C / #E1EBDD | success |
| `clay` / `clay-soft` | #8C4C2A / #F1E1D3 | errors, destructive |

Strategy: restrained-plus — warm near-black carries the shell, brass is the single accent (~5-10%), warm `surface` cards on warm paper. Brass-filled controls carry `paper` text (5.3:1) and darken on hover (`brass-deep`), never brighten.

**Outlet-lean is never color-coded (hard rule).** The "Read" section labels each article by its outlet's lean (Left / Center / Right). Lean is conveyed by **text label + a neutral 3-segment position glyph only** — `ink` for the active segment, `line` for the rest. Never red/blue or any party color, and never the `brass` accent (reserved for AI/brand). This keeps the feature nonpartisan and avoids party-coding, in line with `CLAUDE.md`.

## Type

- Display: **Fraunces** (`font-display`) — headings, wordmark, stat numerals.
- Body: **Source Sans 3** (`font-sans`).
- Body measure capped with `max-w-prose`.

## Shape & elevation

- `radius-card` 1rem (cards), `radius-control` 0.5rem (buttons, inputs).
- One shadow: `shadow-lift` (subtle). No nested cards: inside a card use hairline dividers (`border-t border-line`), not bordered boxes.

## Interaction

- Focus: 3px amber outline, never removed.
- Touch targets ≥44px; mobile nav is a fixed bottom tab bar (4 tabs, amber active state).
- `prefers-reduced-motion` kills transitions globally.

## Components

`Header` (night band + bottom tabs), `Footer`, `ZipForm`, `BillCard` (teaser), `BillsBrowser` (search + chip filters + urgency bands), `RepCard` (portrait + DC line + collapsible local offices), `ActionPanel` (stance → script → call → outcome), `CoverageSection` (the "Read" section: third-party articles + neutral lean chips + hover/tap snippet preview), `LocaleSwitcher`.

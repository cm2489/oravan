# Design

Tokens live in `app/globals.css` under `@theme` (Tailwind v4). Use them; never raw hex in components.

## Color

| Token | Value | Role |
|---|---|---|
| `paper` | #FAF6EE | page background |
| `paper-deep` | #F2EBDC | recessed surfaces (footer, decoded card, how-it-works band) |
| `ink` | #18203A | primary text, solid buttons |
| `ink-soft` | #4A5168 | secondary text |
| `ink-faint` | #5C6276 | meta text (AA on both papers) |
| `night` | #11182E | header/hero band, button hover |
| `booth` | #E8A317 | the amber booth light: logo chip, step numerals, active tab, focus ring |
| `booth-bright` | #F2B33D | amber on dark (mobile active tab) |
| `booth-soft` | #FBEED2 | tag pills, info panels |
| `line` | #E2D9C6 | hairlines, borders |
| `moss` / `moss-soft` | #3E6B4F / #E4EEE7 | success |
| `clay` / `clay-soft` | #A14D3A / #F6E5DF | errors, destructive |

Strategy: restrained-plus — navy carries the shell, amber is the single accent (~5-10%), white cards on warm paper.

## Type

- Display: **Bricolage Grotesque** (`font-display`) — headings, wordmark, stat numerals.
- Body: **Public Sans** (`font-sans`).
- Body measure capped with `max-w-prose`.

## Shape & elevation

- `radius-card` 1rem (cards), `radius-control` 0.5rem (buttons, inputs).
- One shadow: `shadow-lift` (subtle). No nested cards: inside a card use hairline dividers (`border-t border-line`), not bordered boxes.

## Interaction

- Focus: 3px amber outline, never removed.
- Touch targets ≥44px; mobile nav is a fixed bottom tab bar (4 tabs, amber active state).
- `prefers-reduced-motion` kills transitions globally.

## Components

`Header` (night band + bottom tabs), `Footer`, `ZipForm`, `BillCard` (teaser), `BillsBrowser` (search + chip filters + urgency bands), `RepCard` (portrait + DC line + collapsible local offices), `ActionPanel` (stance → script → call → outcome), `LocaleSwitcher`.

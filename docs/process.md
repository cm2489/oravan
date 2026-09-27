# Process

How work is handed back to the owner, how big work is delegated, and what every brief carries. These are the owner's standing process rules; they are not hard rules (page 1 is `CLAUDE.md`), and they do not need an amendment to change — a newer word from the owner replaces a line here, with its date.

Moved here from `CLAUDE.md` on 2026-09-27 with Constitution v2, unchanged except where marked.

## How work is handed back

- **Anything Colby has to do himself gets stated in bold, as a numbered step-by-step sequence** — every command, every click, in the order they must happen, with any blocking dependency between steps called out. Never a prose paragraph he has to reverse-engineer into actions. If a step can't be verified in advance, say so on that step rather than after the list.
- **Anything visual — mockups, drafts, renders, comparisons, reports — opens in its own tab, formatted.** Publish it as an Artifact and hand over the URL. **Never hand back a Markdown file as a deliverable**, and never make him read a design out of terminal output or a scratchpad path. Scratchpad files are working state, not deliverables.
- **Review window (standing rule, ruled 2026-08-09):** whenever Colby needs to put eyes on something running, Claude spins up the dev server(s), publishes a summary artifact saying what to look at and why, and opens a new Chrome window with one tab per stop, in walk order. Never a bare URL list in terminal output.

## How big work is delegated

Adopted 2026-08-09, on the owner's directive to hand off larger chunks of work with less back-and-forth. The operating contract for any multi-PR, multi-day, or "bring this to done" handoff:

- **Lifecycle:** brief → plan with a definition of done per step → Colby approves the plan → execution (ultracode multi-agent orchestration) → mandatory verification pass → report artifact + PRs → Colby merges, with a recommended merge order stated once at wrap-up, never mid-session.
- **Models:** the orchestrating Claude keeps the judgment work — synthesis, design rulings, final review. Subagents default to Opus 5.5 — owner directive 2026-09-24: *"all subagents should be running on opus 5.5 from now on"*. A subagent moves up only when its task genuinely requires it, and every exception is recorded in the report with its reason. *(Changed 2026-09-27: the orchestrator's model name is dropped, so the one model named here is the owner's dated directive; when he names another, replace this line.)*
- **Every brief states:** the goal; the definition of done — *verified* done (CI green, tests passing, live checks), never "work completed"; **decision boundaries** — what Claude decides alone vs. what parks for Colby; a budget/scale ceiling for anything with a bill (paid API calls, Actions minutes); and the deliverable format. A brief missing one of these gets the gap asked about at plan time, not discovered mid-run.
- **Parking lot:** when a thread blocks on Colby mid-run, Claude parks that thread, keeps working everything else, and batches the questions for wrap-up. Conflicts with a page-1 hard rule and money decisions are the exceptions — they surface immediately (see "When something conflicts" in `CLAUDE.md`); nothing else interrupts the run. *(Changed 2026-09-27: this pointed at the retired "Constitutional conflicts" section.)*
- **Checkpoints:** on runs longer than one sitting, a checkpoint artifact stays current as phases complete, so Colby can peek at progress without interrupting.

## The brief template

Added 2026-09-27 from the 2026-09-27 audit (§6, "Briefs"). A brief carries the five fields above and two blocks, and nothing else:

```text
Goal:
Definition of done (verified):
Decision boundaries (Claude decides / parks for Colby):
Budget ceiling (paid calls, Actions minutes):
Deliverable format:

Hard rules that apply:            by number from CLAUDE.md page 1 — usually 3, 4, 5, 7, 8
Current-direction lines that apply: copied from docs/current-direction.md with their dates
```

- Owner words are quoted with their date and their object, or linked to the card that holds them — never paraphrased, and never summarised as a verdict he did not give.
- No "DESIGN.md tokens only", no "never suppress" about a design hook, no "the owner's verdicts are…". A tool's findings are nudges the owner outranks.
- For a fresh-eyes ask, the blind-run protocol is the brief: sterile agents, the browser only, never the repo.

## Rebuild checklist: embed lockstep

Moved from `DESIGN.md` on 2026-09-27 (its "Embed lockstep" section). The same-PR obligation is page 1, rule 12; this is how to meet it.

`app/embed/embed.css` is **not** Tailwind and **not** `globals.css` — an iframe payload stays small and self-contained, so it **hand-copies** the palette. That copy is a standing lockstep obligation: **any change to the `@theme` color block in `app/globals.css` must land in `app/embed/embed.css` in the same PR.** The embed's own architecture rules stand: every color flows through the private `--_*` tokens, component rules never use `@media (prefers-color-scheme)`, and the focus ring falls back to **ink**, not accent.

The embed also uses **system fonts, not `next/font`** — it does not get Franklin or Besley, and it must not add a webfont link.

The embed's default light/dark pair has four mirrors, named in `lib/embed-theme.ts` beside `MODE_DEFAULTS`: that constant, `app/embed/embed.css`'s `:root` fallbacks, `components/EmbedConfigurator.tsx`'s `DEFAULT_*`, and `lib/contrast.ts`'s ink pair — four mirrors, one move.

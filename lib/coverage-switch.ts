/*
 * THE ONE SWITCH for the "How it's being covered" box (the bill page's "Read"
 * section) and the outlet-lean ratings shown with it.
 *
 * Off since 2026-11-25. The owner's card that day, "'How it's being covered':
 * remove it, as both reviewers say?", answered "Remove it everywhere for now"
 * ("The box and the outlet ratings come off bill and Big Question pages. The
 * code and the stored articles stay, switched off, so it can return."), with
 * his note: "I want to bring this back but in a more measured way at some
 * point. This feature was messy and never worked right to begin with."
 *
 * While it is false, nothing a visitor can reach renders the box, its outlet
 * list, its lean labels, its notes, or the Big Question vehicle cards' outlet
 * count that was read off the same list:
 *   - lib/coverage.ts `coverageShownOnBillPage` returns no articles, and both
 *     the bill page and the Big Question page read through it;
 *   - app/[locale]/bills/[id]/page.tsx does not mount CoverageSection;
 *   - components/CoverageSection.tsx returns null on its own as well.
 * The nightly sync, data/coverage.json, data/media-bias.json and the code stay
 * as they are. The home page's "In the news" rail does NOT read this switch
 * (the owner decides that one separately).
 *
 * TO TURN IT BACK ON: set this to true. The specs that expect the box
 * (tests/coverage.spec.ts, tests/twin-coverage.spec.ts,
 * tests/coverage-box-hidden.spec.ts) run again on that flip, and their
 * "switch off" tests skip; tests/coverage-switch.unit.spec.ts pins both sides.
 * Then make /citations' `licenseCoverage` and `asOfBody` describe the box
 * again (messages/en.json and messages/es.json, hard rule 4).
 *
 * Import-free on purpose: the client component and the test runner read it
 * without pulling data/coverage.json into either.
 */
export const COVERAGE_BOX_ON: boolean = false;

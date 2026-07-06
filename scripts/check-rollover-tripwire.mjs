/*
 * 119th -> 120th Congress rollover tripwire, CLI wrapper (S24, two-clock
 * model). Runs weekly from refresh-legislators.yml. Pure logic lives in
 * lib/rollover-tripwire.mjs (unit-tested with fixture dates in
 * tests/rollover-tripwire.unit.spec.ts) - this just calls it against the
 * real clock and prints a GitHub Actions annotation. Never fails the
 * workflow: see lib/rollover-tripwire.mjs for why this is a warning, not a
 * gate, until the deadline is actually close.
 */
import { rolloverWarning } from '../lib/rollover-tripwire.mjs';

const msg = rolloverWarning(new Date());
if (msg) {
  console.log(`::warning::${msg}`);
} else {
  console.log('rollover tripwire: not yet due (before 2026-12-01) - nothing to warn about.');
}

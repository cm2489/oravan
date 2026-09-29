/*
 * A ZIP THAT CROSSES A STATE LINE (2026-09-29).
 *
 * 109 ZIPs in data/zip-districts.json have districts in more than one state:
 * 19973 is Delaware's at-large seat and Maryland's 1st, and 82082 touches
 * Colorado, Nebraska and Wyoming. /api/reps answers such a ZIP with every
 * touched state's senators, so a list of names alone gives the reader no way
 * to tell which two are theirs. Their state decides that, so each surface
 * that lists them prints the state beside the name, in the pattern the
 * settled box and the vote strip already use: "Christopher A. Coons (DE)".
 *
 * A ZIP inside one state prints exactly what it printed before. The label is
 * only for the case where the list itself cannot say whose it is.
 *
 * The answer is read off the lookup the surface already holds (each member's
 * `state`, and each vacant seat's), so this adds no request, and it needs no
 * roster: pure, and safe for a client bundle.
 */

/** True when the members a ZIP lookup returned, or its vacant seats, sit in
 *  more than one state. */
export function crossesStateLine(
  members: readonly { state: string }[],
  vacancies: readonly { state: string }[] = []
): boolean {
  const states = new Set<string>();
  for (const m of members) states.add(m.state);
  for (const v of vacancies) states.add(v.state);
  return states.size > 1;
}

/** "Christopher A. Coons (DE)" when the ZIP crosses a state line, and the bare
 *  name when it does not. The state is the two-letter code the roster holds;
 *  it reads the same in both languages. */
export function nameWithState(member: { name: string; state: string }, crossState: boolean): string {
  return crossState ? `${member.name} (${member.state})` : member.name;
}

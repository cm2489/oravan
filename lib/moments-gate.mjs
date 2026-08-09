/**
 * Moments gate logic — the pure half of scripts/check-moments.mjs, split out
 * the same way lib/rollover-tripwire.mjs / lib/redistricting-watch.mjs back
 * their check scripts: this module has deliberately ZERO imports (and no
 * import.meta) so tests/moments.unit.spec.ts can import it under Playwright's
 * transform, exactly like lib/urgency.mjs. The CLI wrapper does the file I/O.
 *
 * What the gate enforces (moments spec §4.1):
 *   - schema: every field the spec's data model requires, with the right shape
 *   - bilingual parity: every user-facing EN field has a non-empty ES sibling
 *   - vehicles: a known `kind` (optional; absent means "bill") and a slug that
 *     resolves in THAT kind's corpus — data/bills.json or data/nominations.json
 *   - callable records: a NOMINATION vehicle must carry Congress.gov's
 *     description sentence, because that sentence is the only thing its call
 *     script is ever grounded in. See the rule at the vehicle loop.
 *   - qualifying_signal: known type, non-empty https refs, ≥2 refs for `press`
 *   - dates: `opened` and `review_by` present, YYYY-MM-DD, parseable
 *   - cap: at most 6 stored-live moments
 *   - forbidden-vocabulary lint over name/summary/role in BOTH languages —
 *     the versioned word list from the spec (§3.3), so refusals are legible
 *     as mechanics. The lint is the tripwire; owner review is the real gate.
 *
 * Deliberate softenings, documented so they read as decisions, not drift:
 *   - A vehicle in a terminal status is a WARNING for vehicles that already
 *     exist on the baseline, and a FAILURE for newly added ones (owner
 *     ruling 2026-08-09). The spec says "non-terminal at merge time" for a
 *     NEW moment, and the lifecycle (§4.3) requires settled moments — all
 *     vehicles terminal — to persist in the file through the end of the
 *     Congress. The two used to be irreconcilable in one blanket rule, so
 *     terminality was warning-only and human review enforced at-creation.
 *     Now `opts.baselineVehicles` (a Set of "momentId|slug" pairs from the
 *     baseline file, wired by scripts/check-moments.mjs from origin/main)
 *     tells the two cases apart: a pair on the baseline warns as before —
 *     settled moments keep passing — and a pair NOT on the baseline fails,
 *     so "there is a call to make" can never be false at birth. Escape
 *     hatch for a deliberate retrospective moment: `_terminal_ok: "<reason>"`
 *     on the vehicle downgrades the failure to a warning carrying the
 *     reason. Note an id RENAME makes every vehicle of that moment read as
 *     new — a renamed settled moment needs the escape hatch too. Without a
 *     baseline (opts absent: unit fixtures, no-git contexts) behavior is
 *     unchanged: warning only.
 *   - A past `review_by` on a live moment is a WARNING, not a failure, for
 *     the same reason: the read-time lifecycle (lib/moments.ts) already
 *     demotes it to 'stale' honestly; CI redness on unrelated PRs helps
 *     nobody. Presence + parseability ARE hard failures.
 */

/** The 12 CRS-anchored categories — MUST match lib/taxonomy.ts's CATEGORIES
 *  (pinned equal by tests/moments.unit.spec.ts; this copy exists because
 *  this module stays import-free — see the header). */
export const CATEGORIES = [
  'jobs_economy',
  'health',
  'national_security',
  'environment_energy',
  'government_democracy',
  'crime_justice',
  'family_community',
  'education',
  'immigration',
  'ai_technology',
  'housing',
  'rights_liberties',
];

export const SIGNAL_TYPES = [
  'tier0_floor',
  'tier0_scheduled',
  'tier0_most_viewed',
  // The Senate Executive Calendar — a nomination's own scheduling signal. See
  // lib/moments.ts's QUALIFYING_SIGNAL_TYPES for why it is not `tier0_floor`.
  // ORDER MATTERS: scripts/check-moments.mjs compares the two lists in order.
  'tier0_exec_calendar',
  'press',
];

/** The vehicle kinds a moment may cite — MUST match lib/moments.ts's
 *  VEHICLE_KINDS (pinned equal by tests/moments.unit.spec.ts AND asserted at
 *  runtime by scripts/check-moments.mjs; local copy keeps this module
 *  import-free, see the header). */
export const VEHICLE_KINDS = ['bill', 'nomination'];

/**
 * THE ONE normalizer, gate-side. `kind` is OPTIONAL on the wire and its
 * absence means 'bill' — which is what every vehicle authored before
 * 2026-08-06 already is, and why this discriminator needed no data migration.
 * Mirrors lib/moments.ts's `vehicleKind` exactly; the unit suite pins the two
 * against each other on the same inputs, because a default that disagrees
 * across the gate/reader boundary is worse than no default at all.
 */
export function vehicleKind(v) {
  return v?.kind ?? 'bill';
}

/** The data file each kind's slugs must resolve in — only ever used to make
 *  the violation message name the file the author has to go look at. */
export const VEHICLE_SOURCE_FILES = {
  bill: 'data/bills.json',
  nomination: 'data/nominations.json',
};

/**
 * Hosts a `context_refs` entry may cite — the institutional record only
 * (v2 spec §5, the project records (kept out of this repo)). CRS auto-discovery
 * was refuted 2026-07-25 (the list endpoint has no bill filter), so these
 * links are hand-curated when a moment opens; the allowlist is what keeps
 * the "grounded in the record" claim mechanical rather than aspirational.
 */
export const CONTEXT_REF_KINDS = ['crs', 'cbo', 'gao'];
export const CONTEXT_REF_HOSTS = new Set([
  'crsreports.congress.gov',
  'www.congress.gov',
  'congress.gov',
  'www.cbo.gov',
  'cbo.gov',
  'www.gao.gov',
  'gao.gov',
]);

/** Terminal bill statuses — MUST match lib/urgency.mjs's TERMINAL_STATUSES
 *  (pinned equal by tests/moments.unit.spec.ts; local copy keeps this module
 *  import-free). Only used to WARN, never to fail — see the header. */
export const TERMINAL_VEHICLE_STATUSES = new Set(['signed', 'vetoed']);

/** Terminal SENATE NOMINATION statuses — MUST match lib/nomination-status.mjs's
 *  TERMINAL_NOMINATION_STATUSES (same pin, same reason: this module imports
 *  nothing, so the copy is asserted equal at runtime by
 *  scripts/check-moments.mjs and in the unit suite). Also warn-only. */
export const TERMINAL_NOMINATION_VEHICLE_STATUSES = new Set([
  'confirmed',
  'returned',
  'withdrawn',
]);

/** The two vocabularies do not overlap and must never be swapped: asking the
 *  bill set about a confirmed nomination answers "not terminal", which is how
 *  a finished vehicle would keep reading as live. Total over VEHICLE_KINDS. */
const TERMINAL_STATUSES_BY_KIND = {
  bill: TERMINAL_VEHICLE_STATUSES,
  nomination: TERMINAL_NOMINATION_VEHICLE_STATUSES,
};

/*
 * Forbidden vocabulary — the versioned list from the moments spec §3.3:
 * imperative advocacy verbs aimed at the reader (fight/resist/stop/save/
 * defend/block and the Spanish equivalents), plus crisis/attack/scheme
 * outside a quoted official title, plus party names used as adversary
 * framing (moment prose describes a question, never a party). Regexes cover
 * common inflections; word boundaries keep neutral compounds ("stopgap")
 * clean. Spanish stems are chosen to avoid common false positives:
 * "salvo" (= "except"), "bloque" (= voting bloc), "defensa/defensivo"
 * (descriptive military vocabulary) are deliberately NOT matched.
 *
 * WHY THE SPANISH LIST USES LOOKAROUNDS AND THE ENGLISH ONE USES `\b`
 * (fixed 2026-08-09; the bug shipped with the list). JavaScript's `\b` is
 * ASCII-only: it fires between a `[A-Za-z0-9_]` character and anything else,
 * and an accented vowel is "anything else". So a trailing `\b` after "ó"
 * NEVER fires — /\bluchó\b/ does not match "luchó por la enmienda", and the
 * same held for salvó, bloqueó, atacó, defendió and resistió. Five of the ten
 * banned Spanish verbs silently passed in their most natural past tense, on a
 * path where nobody reads the sentence before it publishes — the nightly
 * moment-updates revisions run this table through lintRevisionText and commit
 * straight to `main`, so the lint IS the check. `(?<!\p{L})…(?!\p{L})`
 * with the `u` flag is the boundary that means what `\b` was here to mean:
 * "not adjacent to another letter, in any alphabet". The English list keeps
 * `\b` because every one of its words is ASCII on both edges — the same
 * reason scripts/moment-draft.mjs's FUTURE_VOTE.es is written unaccented and
 * matched against a de-accented probe instead.
 *
 * The two boundaries are NOT interchangeable in one respect worth stating:
 * `\b` also breaks on `_`, and `(?!\p{L})` does not. No entry below is ever
 * matched against an identifier, and a Spanish sentence carrying
 * "bloqueó_algo" is not a case this lint exists for.
 */

/** Not-a-letter on both sides, in any alphabet — see the note above on why
 *  `\b` cannot do this job for accented Spanish. Composes a source string
 *  into a `u`-flagged, case-insensitive regex. */
const esWord = (source) => new RegExp(`(?<!\\p{L})(?:${source})(?!\\p{L})`, 'iu');
export const FORBIDDEN = {
  en: [
    { word: 'fight', re: /\bfight(s|ing)?\b|\bfought\b/i },
    { word: 'resist', re: /\bresist(s|ed|ing)?\b/i },
    { word: 'stop', re: /\bstop(s|ped|ping)?\b/i },
    { word: 'save', re: /\bsave(s|d)?\b|\bsaving\b/i },
    { word: 'defend', re: /\bdefend(s|ed|ing)?\b/i },
    { word: 'block', re: /\bblock(s|ed|ing)?\b/i },
    { word: 'crisis', re: /\bcris[ie]s\b/i },
    { word: 'attack', re: /\battack(s|ed|ing)?\b/i },
    { word: 'scheme', re: /\bscheme(s|d)?\b|\bscheming\b/i },
    { word: 'party name', re: /\bdemocrats?\b|\bdemocratic party\b|\brepublicans?\b|\bGOP\b/i },
  ],
  es: [
    { word: 'luchar', re: esWord('luch(?:a|as|an|e|en|ó|ar|ando)') },
    { word: 'resistir', re: esWord('resist(?:e|en|es|ir|ió|iendo|encia)') },
    { word: 'detener', re: esWord('deten(?:er|ga|gan|iendo)|detien(?:e|en)|detuv\\w+') },
    { word: 'salvar', re: esWord('salv(?:ar|a|an|e|en|ó|ando|emos)') },
    { word: 'defender', re: esWord('defend(?:er|amos|iendo|ió)|defiend(?:e|en|a|an)') },
    { word: 'bloquear', re: esWord('bloque(?:ar|a|an|e|en|ó|ando|o|os)') },
    { word: 'crisis', re: esWord('crisis') },
    { word: 'ataque', re: esWord('ataqu(?:e|es)|atac(?:a|an|ar|ó|ando)') },
    { word: 'esquema', re: esWord('esquem(?:a|as)') },
    { word: 'nombre de partido', re: esWord('demócratas?|republicanos?') },
  ],
};

/** Remove quoted spans ("…", “…”, «…») so an official title like the
 *  "Stop Harmful Schemes Act" never trips the lint (spec §3.3: crisis/attack/
 *  scheme are forbidden "outside a quoted official title"). */
export function stripQuoted(text) {
  return text
    .replace(/"[^"]*"/g, ' ')
    .replace(/“[^”]*”/g, ' ')
    .replace(/«[^»]*»/g, ' ');
}

/** Forbidden-vocabulary lint for one string. Returns the matched list words
 *  (empty array = clean). `lang` is 'en' or 'es'. */
export function lintForbidden(text, lang) {
  const t = stripQuoted(String(text));
  return (FORBIDDEN[lang] ?? []).filter(({ re }) => re.test(t)).map(({ word }) => word);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isStringArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);

/** A {en, es} pair of non-empty strings — the bilingual-parity unit. */
function checkLocalized(value, path, out) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    out.push(`${path}: must be an object { en, es }`);
    return false;
  }
  let ok = true;
  for (const lang of ['en', 'es']) {
    if (!isNonEmptyString(value[lang])) {
      out.push(`${path}.${lang}: missing or empty — every EN field needs its ES sibling (bilingual-parity hard rule)`);
      ok = false;
    }
  }
  return ok;
}

function checkVocab(value, path, out) {
  for (const lang of ['en', 'es']) {
    if (!isNonEmptyString(value?.[lang])) continue;
    for (const word of lintForbidden(value[lang], lang)) {
      out.push(`${path}.${lang}: forbidden vocabulary "${word}" — moments describe the question, never a position (spec §3.3)`);
    }
  }
}

/**
 * Validate a moments object against the spec's data model.
 *
 * `slugsByKind` and `statusFor` are keyed/dispatched BY VEHICLE KIND rather
 * than taking a bare slug, because a slug alone cannot say which corpus it
 * belongs to. The `pn-…` and bill namespaces are structurally disjoint, so a
 * mis-kinded vehicle resolves in neither and fails loudly here.
 *
 * @param {Record<string, any>} moments   parsed data/moments.json shape
 * @param {Record<string, Set<string>>} slugsByKind  { bill: full_identifier set
 *        from data/bills.json, nomination: slug set from data/nominations.json }
 * @param {(vehicle: {slug: string, kind?: string}) => string | undefined} statusFor
 *        status lookup for a vehicle, in its own corpus
 * @param {{ now?: number, describedNominationSlugs?: Set<string>, baselineVehicles?: Set<string> }} [opts]
 *        `describedNominationSlugs` is the subset of the nomination corpus whose
 *        `nominee_description` is a non-empty string — see the callable-record
 *        rule below. Omitting it is not a way to skip that rule: a nomination
 *        vehicle then fails with a violation naming the omission.
 *        `baselineVehicles` is the Set of "momentId|slug" pairs already on the
 *        baseline file (main), for the new-vehicle terminality rule — see the
 *        header. Omitting it skips that rule (warning-only behavior).
 * @returns {{ violations: string[], warnings: string[] }}
 */
export function checkMoments(moments, slugsByKind, statusFor, opts = {}) {
  const now = opts.now ?? Date.now();
  const describedNominationSlugs = opts.describedNominationSlugs;
  const violations = [];
  const warnings = [];

  if (!moments || typeof moments !== 'object' || Array.isArray(moments)) {
    return { violations: ['data/moments.json: root must be an object keyed by moment id'], warnings };
  }

  let liveCount = 0;

  for (const [id, m] of Object.entries(moments)) {
    const at = (f) => `${id}.${f}`;
    if (!ID_RE.test(id)) violations.push(`${id}: moment id must be a lowercase kebab slug`);
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      violations.push(`${id}: entry must be an object`);
      continue;
    }

    // name + summary: bilingual, vocabulary-linted
    for (const field of ['name', 'summary']) {
      if (checkLocalized(m[field], at(field), violations)) checkVocab(m[field], at(field), violations);
    }

    // aliases: search-only (never rendered) — parity checked, vocab deliberately NOT
    // linted (spec §3.3: one-sided nicknames may live here, from both directions)
    if (!m.aliases || typeof m.aliases !== 'object') {
      violations.push(`${at('aliases')}: must be an object { en: [...], es: [...] }`);
    } else {
      for (const lang of ['en', 'es']) {
        if (!isStringArray(m.aliases[lang])) {
          violations.push(`${at('aliases')}.${lang}: must be a non-empty array of strings`);
        }
      }
    }

    if (!CATEGORIES.includes(m.category)) {
      violations.push(`${at('category')}: "${m.category}" is not one of the 12 categories in lib/taxonomy.ts`);
    }

    // vehicles: ≥1, each resolving in the corpus, each role bilingual + linted
    if (!Array.isArray(m.vehicles) || m.vehicles.length === 0) {
      violations.push(`${at('vehicles')}: must be a non-empty array — a moment without a real vehicle may not exist (spec §3.1)`);
    } else {
      m.vehicles.forEach((v, i) => {
        const vp = at(`vehicles[${i}]`);
        if (!v || typeof v !== 'object') {
          violations.push(`${vp}: must be an object { slug, role }`);
          return;
        }
        /* kind: OPTIONAL, and its absence means 'bill' (see vehicleKind).
           Validated BEFORE anything uses it — an unrecognized value must be
           rejected here rather than indexing a slug set that does not exist,
           where a typo like "nominaton" would read as a missing corpus
           instead of as the typo it is. `kind` is left null on failure so the
           slug checks below skip rather than guess which file to look in. */
        let kind = null;
        if (v.kind !== undefined && !VEHICLE_KINDS.includes(v.kind)) {
          violations.push(`${vp}.kind: ${JSON.stringify(v.kind)} is not one of ${VEHICLE_KINDS.join(' | ')} — omit the field entirely for a bill, which is what its absence means`);
        } else {
          kind = vehicleKind(v);
        }
        if (!isNonEmptyString(v.slug)) {
          violations.push(`${vp}.slug: missing`);
        } else if (kind !== null) {
          const slugs = slugsByKind?.[kind];
          const status = statusFor(v);
          if (!slugs || !slugs.has(v.slug)) {
            violations.push(`${vp}.slug: "${v.slug}" does not exist in ${VEHICLE_SOURCE_FILES[kind]} — never invent ${kind} facts`);
          } else {
            if (v._terminal_ok !== undefined && !isNonEmptyString(v._terminal_ok)) {
              violations.push(`${vp}._terminal_ok: must be a non-empty reason string when present — an empty escape hatch reads as a decision nobody made`);
            }
            if (TERMINAL_STATUSES_BY_KIND[kind].has(status)) {
              const isNew = opts.baselineVehicles !== undefined && !opts.baselineVehicles.has(`${id}|${v.slug}`);
              if (isNew && !isNonEmptyString(v._terminal_ok)) {
                violations.push(`${vp}.slug: "${v.slug}" is in a terminal status (${status}) and is newly added — a new vehicle must be live at merge time (spec §3.1), or its copy claims a call that no longer exists. For a deliberate retrospective moment (or a settled moment whose id was renamed), set _terminal_ok: "<reason>" on the vehicle`);
              } else if (isNonEmptyString(v._terminal_ok)) {
                warnings.push(`${vp}.slug: "${v.slug}" is in a terminal status (${status}), accepted by _terminal_ok: ${JSON.stringify(v._terminal_ok)}`);
              } else {
                warnings.push(`${vp}.slug: "${v.slug}" is in a terminal status (${status}) — fine for a settled moment, review if this moment is newly opened`);
              }
            } else if (kind === 'nomination' && status === 'unclassified') {
              /* Not terminal, but no call script either: lib/journey.ts's
                 liveCallTargetForNomination returns null for `unclassified`
                 (the record did not state a stage, so nothing is claimed) and
                 app/api/script therefore answers 422 for it. WARN rather than
                 fail, for the same reason terminality warns: status is derived
                 from the Senate's own sentence and the nightly sync rewrites
                 it, so a hard rule here would redden CI on unrelated PRs the
                 day a vehicle's action text changed shape. The reviewer is who
                 this line is for. */
              warnings.push(`${vp}.slug: "${v.slug}" has an unclassified status — the record did not state a stage, so /api/script refuses it (422) and its page carries no call script; check the record before this moment publishes`);
            }
            /*
             * THE CALLABLE-RECORD RULE, nominations only (2026-08-06).
             *
             * `moments.howMadeRule3` promises a reader that a question's page
             * and call script already work, and
             * `moments.vehiclesLedeNominations` promises support and oppose
             * scripts one tap away. Nothing checked it: a nomination whose
             * Congress.gov record carries no description sentence passed
             * VEHICLE_KINDS and the terminal set, then landed on a page with
             * no dial, no stance control and no script (see NoAskPanel in
             * app/[locale]/nominations/[slug]/page.tsx), because that sentence
             * is the ONLY thing a nomination script is ever grounded in —
             * there is no decode to fall back on, by design
             * (lib/nomination-script.ts's header). 14 of the 857 civilian
             * records are such records; one of them is live.
             *
             * HARD, unlike the two warnings above, and the difference is
             * monotonicity. A status moves in both directions with every
             * nightly sync, so a hard rule on it reddens unrelated PRs. A
             * description does not: scripts/nominations-fetch.mjs only ever
             * ASSIGNS `nominee_description` when the API supplies one and
             * never clears it, so a vehicle that passes this rule at merge
             * cannot fail it later.
             *
             * FAILS CLOSED when the caller did not wire the set. A gate that
             * quietly stops checking is worse than no gate — the same rule
             * scripts/check-moments.mjs states over its own drift scans.
             */
            if (kind === 'nomination') {
              if (!(describedNominationSlugs instanceof Set)) {
                violations.push(`${vp}: checkMoments was called without opts.describedNominationSlugs, so the callable-record rule could not run on a nomination vehicle — wire it the way scripts/check-moments.mjs does; do not drop the rule`);
              } else if (!describedNominationSlugs.has(v.slug)) {
                violations.push(`${vp}.slug: "${v.slug}" has no nominee_description in ${VEHICLE_SOURCE_FILES[kind]} — that sentence is the only thing its call script is grounded in, so /api/script refuses it (422) and its page renders no call at all. A moment may not cite a vehicle it cannot call (moments.howMadeRule3, moments.vehiclesLedeNominations)`);
              }
            }
          }
        }
        if (checkLocalized(v.role, `${vp}.role`, violations)) checkVocab(v.role, `${vp}.role`, violations);
      });
    }

    // qualifying_signal: the clickable evidence a reviewer audits (spec §3.1 rule 2)
    const qs = m.qualifying_signal;
    if (!qs || typeof qs !== 'object') {
      violations.push(`${at('qualifying_signal')}: missing — every moment records its qualifying evidence`);
    } else {
      if (!SIGNAL_TYPES.includes(qs.type)) {
        violations.push(`${at('qualifying_signal')}.type: "${qs.type}" is not one of ${SIGNAL_TYPES.join(' | ')}`);
      }
      if (!isStringArray(qs.refs)) {
        violations.push(`${at('qualifying_signal')}.refs: must be a non-empty array of URLs`);
      } else {
        for (const ref of qs.refs) {
          if (!/^https:\/\//.test(ref)) violations.push(`${at('qualifying_signal')}.refs: "${ref}" is not an https URL`);
        }
        if (qs.type === 'press' && qs.refs.length < 2) {
          violations.push(`${at('qualifying_signal')}.refs: press signal needs ≥2 refs from lean-diverse outlets (spec §3.1 rule 2)`);
        }
      }
    }

    // context_refs: OPTIONAL hand-curated institutional grounding for the v2
    // state summaries (v2 spec §5) — CRS/CBO/GAO links a reviewer added when
    // the moment opened. Optional because v1 moments predate the field; when
    // present it must be non-empty (an empty list is a claim of grounding
    // with no ground) and every entry must point at the institutional record.
    if (m.context_refs !== undefined) {
      if (!Array.isArray(m.context_refs) || m.context_refs.length === 0) {
        violations.push(`${at('context_refs')}: when present, must be a non-empty array of { kind, url } refs`);
      } else {
        m.context_refs.forEach((r, i) => {
          const rp = at(`context_refs[${i}]`);
          if (!r || typeof r !== 'object' || Array.isArray(r)) {
            violations.push(`${rp}: must be an object { kind, url, title? }`);
            return;
          }
          if (!CONTEXT_REF_KINDS.includes(r.kind)) {
            violations.push(`${rp}.kind: "${r.kind}" is not one of ${CONTEXT_REF_KINDS.join(' | ')}`);
          }
          if (!isNonEmptyString(r.url) || !/^https:\/\//.test(r.url)) {
            violations.push(`${rp}.url: must be an https URL`);
          } else {
            let host = '';
            try {
              host = new URL(r.url).hostname;
            } catch {
              // fall through to the allowlist failure below with host = ''
            }
            if (!CONTEXT_REF_HOSTS.has(host)) {
              violations.push(`${rp}.url: host "${host}" is not an allowlisted institutional source (crsreports.congress.gov / congress.gov / cbo.gov / gao.gov)`);
            }
          }
          // title is optional; when present it renders, so parity applies.
          if (r.title !== undefined) checkLocalized(r.title, `${rp}.title`, violations);
        });
      }
    }

    // dates
    for (const field of ['opened', 'review_by']) {
      const val = m[field];
      if (!isNonEmptyString(val) || !DATE_RE.test(val) || !Number.isFinite(new Date(val).getTime())) {
        violations.push(`${at(field)}: missing or not a parseable YYYY-MM-DD date`);
      }
    }
    if (
      m.status === 'live' &&
      isNonEmptyString(m.review_by) &&
      Number.isFinite(new Date(m.review_by).getTime()) &&
      now >= new Date(m.review_by).getTime() + 86_400_000
    ) {
      warnings.push(`${at('review_by')}: ${m.review_by} has passed — this moment reads as 'stale' until a reviewed PR renews or retires it`);
    }

    // stored status: live | retired only ('settled' is computed, never stored)
    if (m.status !== 'live' && m.status !== 'retired') {
      violations.push(`${at('status')}: "${m.status}" — stored status must be "live" or "retired" (settled is computed at read time, never stored)`);
    }
    if (m.status === 'live') liveCount++;
  }

  if (liveCount > 6) {
    violations.push(`data/moments.json: ${liveCount} live moments — the cap is 6 (scarcity keeps curation honest, spec §4.3)`);
  }

  return { violations, warnings };
}

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
 *   - vehicles: every slug resolves in data/bills.json
 *   - qualifying_signal: known type, non-empty https refs, ≥2 refs for `press`
 *   - dates: `opened` and `review_by` present, YYYY-MM-DD, parseable
 *   - cap: at most 6 stored-live moments
 *   - forbidden-vocabulary lint over name/summary/role in BOTH languages —
 *     the versioned word list from the spec (§3.3), so refusals are legible
 *     as mechanics. The lint is the tripwire; owner review is the real gate.
 *
 * Deliberate softenings, documented so they read as decisions, not drift:
 *   - A vehicle in a terminal status is a WARNING, not a failure. The spec
 *     says "non-terminal at merge time" for a NEW moment, but the lifecycle
 *     (§4.3) requires settled moments — all vehicles terminal — to persist
 *     in the file through the end of the Congress. A hard terminal check
 *     would turn every legitimately-settled moment into a red CI on
 *     unrelated PRs. Human review enforces the at-creation rule.
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

export const SIGNAL_TYPES = ['tier0_floor', 'tier0_scheduled', 'tier0_most_viewed', 'press'];

/** Terminal bill statuses — MUST match lib/urgency.mjs's TERMINAL_STATUSES
 *  (pinned equal by tests/moments.unit.spec.ts; local copy keeps this module
 *  import-free). Only used to WARN, never to fail — see the header. */
export const TERMINAL_VEHICLE_STATUSES = new Set(['signed', 'vetoed']);

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
 */
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
    { word: 'luchar', re: /\bluch(a|as|an|e|en|ó|ar|ando)\b/i },
    { word: 'resistir', re: /\bresist(e|en|es|ir|ió|iendo|encia)\b/i },
    { word: 'detener', re: /\bdeten(er|ga|gan|iendo)\b|\bdetien(e|en)\b|\bdetuv\w+\b/i },
    { word: 'salvar', re: /\bsalv(ar|a|an|e|en|ó|ando|emos)\b/i },
    { word: 'defender', re: /\bdefend(er|amos|iendo|ió)\b|\bdefiend(e|en|a|an)\b/i },
    { word: 'bloquear', re: /\bbloque(ar|a|an|e|en|ó|ando|o|os)\b/i },
    { word: 'crisis', re: /\bcrisis\b/i },
    { word: 'ataque', re: /\bataqu(e|es)\b|\batac(a|an|ar|ó|ando)\b/i },
    { word: 'esquema', re: /\besquem(a|as)\b/i },
    { word: 'nombre de partido', re: /\bdemócratas?\b|\brepublicanos?\b/i },
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
 * @param {Record<string, any>} moments   parsed data/moments.json shape
 * @param {Set<string>} billSlugs         full_identifier set from data/bills.json
 * @param {(slug: string) => string | undefined} statusFor  bill status lookup
 * @param {{ now?: number }} [opts]
 * @returns {{ violations: string[], warnings: string[] }}
 */
export function checkMoments(moments, billSlugs, statusFor, opts = {}) {
  const now = opts.now ?? Date.now();
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
        if (!isNonEmptyString(v.slug)) {
          violations.push(`${vp}.slug: missing`);
        } else if (!billSlugs.has(v.slug)) {
          violations.push(`${vp}.slug: "${v.slug}" does not exist in data/bills.json — never invent bill facts`);
        } else if (TERMINAL_VEHICLE_STATUSES.has(statusFor(v.slug))) {
          warnings.push(`${vp}.slug: "${v.slug}" is in a terminal status (${statusFor(v.slug)}) — fine for a settled moment, review if this moment is newly opened`);
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

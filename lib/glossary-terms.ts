/*
 * THE GLOSSARY'S DATA TABLE — one row per term, and no prose.
 *
 * Expanded 2026-09-28 from twelve terms to the list below, on the owner's
 * note on the UX inventory (C05/G13): "We need to expand the glossary. I'd
 * rather it be too many definitions than not enough. Users shouldn't feel dumb
 * if they don't know something when reading the site and it shouldn't take
 * them away from the page."
 *
 * WHAT A ROW HOLDS
 *
 *   id        The permanent anchor (`/glossary#cloture`). APPEND ONLY: a
 *             rename breaks every link anyone ever sent, so the first twelve
 *             keep their ids and their order, and new terms go at the end.
 *   category  Which section of /glossary prints it (GLOSSARY_CATEGORIES in
 *             lib/glossary.ts). Order within a section is alphabetical by
 *             the reader's own language, so it is not stored here.
 *   source    The official, public-domain page the entry is based on, read
 *             when the entry was written. /glossary prints it under the
 *             entry. Senate entries point at the Senate glossary's own
 *             anchor; House entries at the Rules of the House; budget and
 *             civic entries at Treasury, Census, the Archives' transcription
 *             of the Constitution, or the U.S. Code.
 *   match     The phrases, per language, that are marked automatically where
 *             they already appear in decoded text and record text
 *             (lib/glossary-match.ts). Matched case-insensitively, as whole
 *             words, longest phrase first, at most once per term per section.
 *             An EMPTY list is a decision, not an omission: the word is too
 *             common or too ambiguous to mark on sight ("committee",
 *             "amendment", "floor", "bill"), or it was measured against the
 *             committed decode corpus and marked the wrong thing — "riders"
 *             were transit riders, "override" was state-law preemption,
 *             "debt limit" was a bankruptcy threshold, "special rule" was a
 *             hospital payment rule, "subcommittee" was an agency panel. A
 *             term with no phrases still gets its entry, and still gets
 *             wired by hand where the copy means it.
 *             A NARROW list is the same decision made for one word: bare
 *             "shutdown" was an engine's emissions shutdown, an oil well's,
 *             a reactor's and a farm's before it was ever a lapse in funding,
 *             so the shutdown entry lists only the phrases that mean the
 *             government one; bare "federal debt" was federal debt
 *             COLLECTION and the federal debt CEILING (reviewed 2026-09-28).
 *
 * NEAR MISSES (GLOSSARY_NEAR_MISSES, at the end) are longer phrases that
 * contain a listed phrase and mean something else — "a government shutdown
 * of their mine" is a regulator closing a mine. The matcher reads them as
 * plain text, so the shorter phrase inside them stays unmarked.
 *
 * THE PROSE lives in messages/en.json + messages/es.json under
 * `glossary.terms.<id>` (CLAUDE.md rule 5), and is pinned in both languages
 * by tests/glossary.unit.spec.ts.
 *
 * NOT FOR THE BROWSER. Nothing here is imported by a 'use client' module: the
 * server resolves a term to its two strings and hands the popover only those
 * (components/GlossaryTerm.tsx), so a page ships the definitions it shows and
 * nothing else (the #313 bundle gate, scripts/check-client-bundle.mjs).
 */

export type GlossaryCategory =
  | 'floor'
  | 'committees'
  | 'lawmaking'
  | 'votes'
  | 'budget'
  | 'nominations'
  | 'people';

interface GlossaryEntryShape {
  readonly id: string;
  readonly category: GlossaryCategory;
  readonly source: string;
  readonly match: { readonly en: readonly string[]; readonly es: readonly string[] };
}

export const GLOSSARY_ENTRIES = [
  {
    id: 'cloture',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#cloture',
    match: { en: ['cloture'], es: ['cierre del debate', 'cloture'] },
  },
  {
    id: 'unanimous-consent',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#unanimous_consent',
    match: { en: ['unanimous consent'], es: ['consentimiento unánime'] },
  },
  {
    id: 'motion-to-proceed',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#motion_to_proceed_to_consider',
    match: { en: ['motion to proceed'], es: ['moción para considerar'] },
  },
  {
    id: 'cloture-on-the-motion-to-proceed',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#cloture',
    match: { en: ['cloture on the motion to proceed'], es: ['cierre del debate sobre la moción para considerar'] },
  },
  {
    id: 'legislative-calendar',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#Calendar_of_Business',
    match: { en: ['Senate Legislative Calendar', 'Legislative Calendar'], es: ['Calendario Legislativo'] },
  },
  {
    id: 'union-calendar',
    category: 'floor',
    source: 'https://clerk.house.gov/legislative/house-rules.pdf',
    match: { en: ['Union Calendar'], es: ['Union Calendar'] },
  },
  {
    id: 'executive-calendar',
    category: 'nominations',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#Executive_Calendar',
    match: { en: ['Executive Calendar'], es: ['Calendario Ejecutivo'] },
  },
  {
    id: 'reported-by-committee',
    category: 'committees',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#committee_report',
    match: { en: ['reported by committee', 'reported by the committee'], es: ['dictaminada por el comité', 'dictaminado por el comité', 'reportado por el comité'] },
  },
  {
    id: 'amendment-in-the-nature-of-a-substitute',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#amendment_in_the_nature_of_a_substitute',
    match: { en: ['amendment in the nature of a substitute'], es: ['enmienda sustitutiva integral'] },
  },
  {
    id: 'budget-reconciliation',
    category: 'budget',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#reconciliation',
    match: { en: ['budget reconciliation', 'reconciliation bill', 'reconciliation process'], es: ['reconciliación presupuestaria'] },
  },
  {
    id: 'cra-disapproval',
    category: 'lawmaking',
    source: 'https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title5-section802&num=0&edition=prelim',
    match: { en: ['Congressional Review Act'], es: ['Ley de Revisión del Congreso'] },
  },
  {
    id: 'pro-forma-session',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#pro_forma_session',
    match: { en: ['pro forma session'], es: ['sesión pro forma', 'sesiones pro forma'] },
  },
  {
    id: 'filibuster',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#filibuster',
    match: { en: ['filibuster'], es: ['filibusterismo', 'filibustero'] },
  },
  {
    id: 'hold',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#hold',
    match: { en: ['Senate hold', 'placed a hold', 'place a hold'], es: [] },
  },
  {
    id: 'quorum',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#quorum',
    match: { en: ['quorum call', 'quorum'], es: ['quórum'] },
  },
  {
    id: 'recess',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#recess',
    match: { en: ['congressional recess', 'Senate recess', 'House recess'], es: ['receso del Congreso', 'receso del Senado', 'receso de la Cámara'] },
  },
  {
    id: 'adjournment',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#adjourn',
    match: { en: ['adjournment', 'adjourned', 'adjourns'], es: ['levantó la sesión', 'levantar la sesión'] },
  },
  {
    id: 'adjournment-sine-die',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#adjournment_sine_die',
    match: { en: ['sine die'], es: ['sine die'] },
  },
  {
    id: 'session',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#session',
    match: { en: [], es: [] },
  },
  {
    id: 'lame-duck-session',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#lame_duck_session',
    match: { en: ['lame-duck session', 'lame duck session', 'lame-duck', 'lame duck'], es: ['pato cojo'] },
  },
  {
    id: 'legislative-day',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#legislative_day',
    match: { en: ['legislative day'], es: ['día legislativo', 'días legislativos'] },
  },
  {
    id: 'floor',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#floor',
    match: { en: [], es: [] },
  },
  {
    id: 'point-of-order',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#point_of_order',
    match: { en: ['point of order'], es: ['cuestión de orden'] },
  },
  {
    id: 'germaneness',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#germane',
    match: { en: ['germane', 'nongermane', 'non-germane', 'germaneness'], es: [] },
  },
  {
    id: 'amendment-tree',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#amendment_tree',
    match: { en: ['amendment tree', 'filling the tree', 'fill the tree'], es: ['árbol de enmiendas'] },
  },
  {
    id: 'motion-to-table',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#motion_to_table',
    match: { en: ['motion to table', 'motion to lay on the table'], es: ['moción para dejar sobre la mesa'] },
  },
  {
    id: 'motion-to-reconsider',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#motion_to_reconsider',
    match: { en: ['motion to reconsider'], es: ['moción de reconsideración', 'moción para reconsiderar'] },
  },
  {
    id: 'suspension-of-the-rules',
    category: 'floor',
    source: 'https://clerk.house.gov/legislative/house-rules.pdf',
    match: { en: ['suspension of the rules', 'suspend the rules', 'under suspension'], es: ['suspensión de las reglas'] },
  },
  {
    id: 'discharge-petition',
    category: 'floor',
    source: 'https://clerk.house.gov/legislative/house-rules.pdf',
    match: { en: ['discharge petition'], es: ['petición de descargo'] },
  },
  {
    id: 'special-rule',
    category: 'floor',
    source: 'https://rules.house.gov/about/special-rule-types',
    match: { en: [], es: [] },
  },
  {
    id: 'rules-committee',
    category: 'floor',
    source: 'https://rules.house.gov/about/special-rule-types',
    match: { en: ['Rules Committee', 'Committee on Rules'], es: ['Comité de Reglas'] },
  },
  {
    id: 'motion-to-recommit',
    category: 'floor',
    source: 'https://clerk.house.gov/legislative/house-rules.pdf',
    match: { en: ['motion to recommit'], es: ['moción para devolver'] },
  },
  {
    id: 'previous-question',
    category: 'floor',
    source: 'https://clerk.house.gov/legislative/house-rules.pdf',
    match: { en: ['previous question'], es: ['cuestión previa'] },
  },
  {
    id: 'committee-of-the-whole',
    category: 'floor',
    source: 'https://www.house.gov/the-house-explained',
    match: { en: ['Committee of the Whole'], es: ['Comité Plenario'] },
  },
  {
    id: 'house-calendar',
    category: 'floor',
    source: 'https://clerk.house.gov/legislative/house-rules.pdf',
    match: { en: ['House Calendar'], es: ['House Calendar'] },
  },
  {
    id: 'executive-session',
    category: 'nominations',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#executive_session',
    match: { en: ['executive session'], es: ['sesión ejecutiva'] },
  },
  {
    id: 'vote-a-rama',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#votearama',
    match: { en: ['vote-a-rama', 'vote-arama'], es: ['vote-a-rama'] },
  },
  {
    id: 'congressional-record',
    category: 'floor',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#Congressional_Record',
    match: { en: ['Congressional Record'], es: ['Congressional Record'] },
  },
  {
    id: 'daily-digest',
    category: 'floor',
    source: 'https://www.govinfo.gov/help/crec',
    match: { en: ['Daily Digest'], es: ['Daily Digest'] },
  },
  {
    id: 'committee',
    category: 'committees',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#committee',
    match: { en: [], es: [] },
  },
  {
    id: 'subcommittee',
    category: 'committees',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#subcommittee',
    match: { en: [], es: [] },
  },
  {
    id: 'standing-committee',
    category: 'committees',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#standing_committee',
    match: { en: ['standing committee'], es: ['comité permanente'] },
  },
  {
    id: 'select-committee',
    category: 'committees',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#select_or_special_committee',
    match: { en: ['select committee'], es: ['comité selecto'] },
  },
  {
    id: 'joint-committee',
    category: 'committees',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#joint_committee',
    match: { en: [], es: [] },
  },
  {
    id: 'hearing',
    category: 'committees',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#hearing',
    match: { en: ['committee hearing', 'congressional hearing', 'confirmation hearing', 'Senate hearing', 'House hearing'], es: ['audiencia de confirmación', 'audiencia en el Congreso', 'audiencia del comité', 'audiencia celebrada en comité'] },
  },
  {
    id: 'markup',
    category: 'committees',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#markup',
    match: { en: ['markup'], es: ['markup'] },
  },
  {
    id: 'referral',
    category: 'committees',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#referral',
    match: { en: ['referred to committee', 'referred to the committee'], es: ['remitido al comité', 'remitido a comité'] },
  },
  {
    id: 'committee-report',
    category: 'committees',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#committee_report',
    match: { en: ['committee report'], es: ['informe del comité'] },
  },
  {
    id: 'ranking-member',
    category: 'committees',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#ranking_member',
    match: { en: ['ranking member'], es: ['ranking member'] },
  },
  {
    id: 'conference-committee',
    category: 'committees',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#conference_committee',
    match: { en: ['conference committee', 'conferees'], es: ['comisión mixta', 'comité de conferencia'] },
  },
  {
    id: 'conference-report',
    category: 'committees',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#joint_explanatory_statement',
    match: { en: ['conference report'], es: ['informe de conferencia', 'informe de la comisión mixta'] },
  },
  {
    id: 'oversight',
    category: 'committees',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#oversight',
    match: { en: ['congressional oversight'], es: ['supervisión del Congreso'] },
  },
  {
    id: 'bill',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#bill',
    match: { en: [], es: [] },
  },
  {
    id: 'measure',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#measure',
    match: { en: [], es: [] },
  },
  {
    id: 'act',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#act',
    match: { en: [], es: [] },
  },
  {
    id: 'joint-resolution',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#joint_resolution',
    match: { en: ['joint resolution'], es: ['resolución conjunta', 'resoluciones conjuntas'] },
  },
  {
    id: 'concurrent-resolution',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#concurrent_resolution',
    match: { en: ['concurrent resolution'], es: ['resolución concurrente', 'resoluciones concurrentes'] },
  },
  {
    id: 'simple-resolution',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#simple_resolution',
    match: { en: ['simple resolution'], es: ['resolución simple'] },
  },
  {
    id: 'sense-of-congress',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#simple_resolution',
    match: { en: ['sense of Congress', 'sense of the Senate', 'sense of the House'], es: ['sentido del Congreso', 'opinión del Congreso'] },
  },
  {
    id: 'amendment',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#amendment',
    match: { en: [], es: [] },
  },
  {
    id: 'rider',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#rider',
    match: { en: ['policy rider', 'policy riders'], es: [] },
  },
  {
    id: 'companion-bill',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#companion_bill_or_measure',
    match: { en: ['companion bill', 'companion legislation'], es: ['proyecto gemelo', 'proyecto complementario'] },
  },
  {
    id: 'sponsor',
    category: 'lawmaking',
    source: 'https://clerk.house.gov/legislative/house-rules.pdf',
    match: { en: [], es: [] },
  },
  {
    id: 'cosponsor',
    category: 'lawmaking',
    source: 'https://clerk.house.gov/legislative/house-rules.pdf',
    match: { en: ['cosponsor', 'cosponsored', 'co-sponsor', 'co-sponsored'], es: ['copatrocinador', 'copatrocinadores', 'copatrocinado'] },
  },
  {
    id: 'engrossed-bill',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#engrossed_bill',
    match: { en: ['engrossed bill', 'engrossed'], es: ['engrossed'] },
  },
  {
    id: 'enrolled-bill',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#enrolled_bill',
    match: { en: ['enrolled bill'], es: ['enrolled bill'] },
  },
  {
    id: 'veto',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#veto',
    match: { en: ['veto', 'vetoes', 'vetoed'], es: ['veto', 'vetos', 'vetó', 'vetado', 'vetada'] },
  },
  {
    id: 'pocket-veto',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#pocket_veto',
    match: { en: ['pocket veto'], es: ['veto de bolsillo'] },
  },
  {
    id: 'veto-override',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#veto_override',
    match: { en: ['veto override', 'override the veto', 'override a veto', 'override his veto', 'override her veto', 'overrode the veto', 'override the President\'s veto'], es: ['anular el veto', 'superar el veto', 'anulación del veto'] },
  },
  {
    id: 'enacted',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#enacted',
    match: { en: ['became law', 'signed into law'], es: ['se convirtió en ley', 'promulgado como ley', 'promulgada como ley'] },
  },
  {
    id: 'public-law',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#public_law',
    match: { en: ['public law'], es: ['ley pública'] },
  },
  {
    id: 'private-law',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#private_law',
    match: { en: ['private law'], es: ['ley privada'] },
  },
  {
    id: 'us-code',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#US_code',
    match: { en: ['U.S. Code', 'United States Code', 'U.S.C.'], es: ['Código de los Estados Unidos', 'Código de EE. UU.', 'Código de EE.UU.', 'U.S. Code'] },
  },
  {
    id: 'codify',
    category: 'lawmaking',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#US_code',
    match: { en: ['codify', 'codifies', 'codified', 'codifying', 'codification'], es: ['codifica', 'codificar', 'codificaría'] },
  },
  {
    id: 'executive-order',
    category: 'lawmaking',
    source: 'https://www.federalregister.gov/presidential-documents/executive-orders',
    match: { en: ['executive order'], es: ['orden ejecutiva', 'órdenes ejecutivas'] },
  },
  {
    id: 'roll-call-vote',
    category: 'votes',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#roll_call_vote',
    match: { en: ['roll call vote', 'roll-call vote', 'roll call', 'roll-call'], es: ['votación nominal', 'votaciones nominales'] },
  },
  {
    id: 'recorded-vote',
    category: 'votes',
    source: 'https://clerk.house.gov/legislative/house-rules.pdf',
    match: { en: ['recorded vote'], es: ['votación registrada', 'votaciones registradas'] },
  },
  {
    id: 'voice-vote',
    category: 'votes',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#voice_vote',
    match: { en: ['voice vote'], es: ['votación a viva voz', 'votación por voz'] },
  },
  {
    id: 'yea-and-nay',
    category: 'votes',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#roll_call_vote',
    match: { en: ['yeas and nays', 'yea', 'nay', 'yeas', 'nays'], es: ['yea', 'nay'] },
  },
  {
    id: 'present-vote',
    category: 'votes',
    source: 'https://clerk.house.gov/legislative/house-rules.pdf',
    match: { en: ['voted present', 'voting present', 'answered present'], es: ['votó presente'] },
  },
  {
    id: 'not-voting',
    category: 'votes',
    source: 'https://clerk.house.gov/legislative/house-rules.pdf',
    match: { en: ['not voting'], es: [] },
  },
  {
    id: 'tie-vote',
    category: 'votes',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#president_of_the_Senate',
    match: { en: ['tie vote', 'tie-breaking vote', 'tiebreaking vote', 'break a tie', 'break the tie'], es: ['voto de desempate', 'desempatar'] },
  },
  {
    id: 'simple-majority',
    category: 'votes',
    source: 'https://www.house.gov/the-house-explained/the-legislative-process',
    match: { en: ['simple majority', 'simple-majority'], es: ['mayoría simple'] },
  },
  {
    id: 'supermajority',
    category: 'votes',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#veto_override',
    match: { en: ['supermajority', 'two-thirds vote', 'two-thirds majority', 'two-thirds of both chambers', 'two-thirds of each chamber', 'three-fifths'], es: ['mayoría calificada', 'dos tercios de ambas cámaras', 'dos tercios de cada cámara', 'tres quintos'] },
  },
  {
    id: 'appropriations',
    category: 'budget',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#appropriation',
    match: { en: ['appropriation', 'appropriations', 'appropriated'], es: ['ley de asignaciones', 'proyecto de asignaciones', 'proyectos de asignaciones', 'Comité de Asignaciones', 'asignaciones presupuestarias'] },
  },
  {
    id: 'authorization',
    category: 'budget',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#authorization',
    match: { en: ['reauthorization', 'reauthorize', 'reauthorizes', 'reauthorized', 'authorization of appropriations', 'authorized to be appropriated'], es: ['reautorización', 'reautoriza', 'reautorizar', 'reautorizado', 'reautorizada'] },
  },
  {
    id: 'budget-resolution',
    category: 'budget',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#budget_resolution',
    match: { en: ['budget resolution'], es: ['resolución presupuestaria'] },
  },
  {
    id: 'continuing-resolution',
    category: 'budget',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#continuing_resolution',
    match: { en: ['continuing resolution', 'continuing appropriations'], es: ['resolución de continuidad', 'resolución continua'] },
  },
  {
    id: 'omnibus',
    category: 'budget',
    source: 'https://www.govinfo.gov/features/federal-appropriations-fiscal-year-2024',
    match: { en: ['omnibus appropriations', 'omnibus spending bill', 'omnibus bill', 'minibus'], es: ['ómnibus', 'minibús'] },
  },
  {
    id: 'supplemental-appropriations',
    category: 'budget',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#supplemental_appropriation',
    match: { en: ['supplemental appropriation', 'supplemental appropriations', 'supplemental funding bill'], es: ['asignaciones suplementarias', 'asignación suplementaria'] },
  },
  {
    id: 'fiscal-year',
    category: 'budget',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#fiscal_year',
    match: { en: ['fiscal year', 'fiscal years'], es: ['año fiscal', 'años fiscales'] },
  },
  {
    id: 'budget-authority',
    category: 'budget',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#budget_authority',
    match: { en: ['budget authority', 'outlays'], es: ['autoridad presupuestaria'] },
  },
  {
    id: 'mandatory-spending',
    category: 'budget',
    source: 'https://fiscaldata.treasury.gov/americas-finance-guide/federal-spending/',
    match: { en: ['mandatory spending'], es: ['gasto obligatorio'] },
  },
  {
    id: 'discretionary-spending',
    category: 'budget',
    source: 'https://fiscaldata.treasury.gov/americas-finance-guide/federal-spending/',
    match: { en: ['discretionary spending', 'discretionary funding'], es: ['gasto discrecional'] },
  },
  {
    id: 'entitlement',
    category: 'budget',
    source: 'https://fiscaldata.treasury.gov/americas-finance-guide/federal-spending/',
    match: { en: ['entitlement program', 'entitlement programs'], es: [] },
  },
  {
    id: 'deficit',
    category: 'budget',
    source: 'https://fiscaldata.treasury.gov/americas-finance-guide/national-deficit/',
    match: { en: ['budget deficit', 'federal deficit', 'deficit spending'], es: ['déficit presupuestario', 'déficit federal'] },
  },
  {
    id: 'national-debt',
    category: 'budget',
    source: 'https://fiscaldata.treasury.gov/americas-finance-guide/national-debt/',
    match: { en: ['national debt', 'federal debt reduction'], es: ['deuda nacional', 'deuda federal'] },
  },
  {
    id: 'debt-limit',
    category: 'budget',
    source: 'https://home.treasury.gov/policy-issues/financial-markets-financial-institutions-and-fiscal-service/debt-limit',
    match: { en: ['debt ceiling', 'statutory debt limit', 'federal debt limit', 'public debt limit', 'raising the debt limit', 'raise the debt limit', 'suspend the debt limit'], es: ['techo de deuda', 'techo de la deuda', 'límite de la deuda', 'límite de endeudamiento federal'] },
  },
  {
    id: 'government-shutdown',
    category: 'budget',
    source: 'https://www.opm.gov/policy-data-oversight/pay-leave/furlough-guidance/',
    match: { en: ['government shutdown', 'government shutdowns', 'lapse in appropriations', 'during a shutdown', 'averting a shutdown', 'avoid a shutdown'], es: ['cierre del gobierno', 'cierre de gobierno'] },
  },
  {
    id: 'cbo-cost-estimate',
    category: 'budget',
    source: 'https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title2-section653&num=0&edition=prelim',
    match: { en: ['Congressional Budget Office', 'CBO'], es: ['Oficina de Presupuesto del Congreso', 'CBO'] },
  },
  {
    id: 'sequestration',
    category: 'budget',
    source: 'https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title2-section901a&num=0&edition=prelim',
    match: { en: ['sequestration', 'sequester'], es: ['secuestro presupuestario'] },
  },
  {
    id: 'earmark',
    category: 'budget',
    source: 'https://clerk.house.gov/legislative/house-rules.pdf',
    match: { en: ['earmark', 'earmarks', 'congressionally directed spending'], es: ['earmark', 'earmarks'] },
  },
  {
    id: 'rescission',
    category: 'budget',
    source: 'https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title2-section683&num=0&edition=prelim',
    match: { en: ['rescission bill', 'rescissions bill', 'rescission package', 'rescissions package'], es: [] },
  },
  {
    id: 'tax-credit',
    category: 'budget',
    source: 'https://www.irs.gov/credits-and-deductions-for-individuals',
    match: { en: ['tax credit', 'tax credits', 'refundable credit'], es: ['crédito fiscal', 'créditos fiscales', 'crédito tributario', 'créditos tributarios'] },
  },
  {
    id: 'tax-deduction',
    category: 'budget',
    source: 'https://www.irs.gov/credits-and-deductions-for-individuals',
    match: { en: ['tax deduction', 'tax deductions'], es: ['deducción fiscal', 'deducciones fiscales'] },
  },
  {
    id: 'nomination',
    category: 'nominations',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#nomination',
    match: { en: ['nomination', 'nominations', 'nominee'], es: ['nominación', 'nominaciones'] },
  },
  {
    id: 'advice-and-consent',
    category: 'nominations',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#advice_and_consent',
    match: { en: ['advice and consent'], es: ['consejo y consentimiento'] },
  },
  {
    id: 'confirmation',
    category: 'nominations',
    source: 'https://www.senate.gov/about/powers-procedures/nominations.htm',
    match: { en: ['Senate confirmation', 'confirmed by the Senate', 'Senate-confirmed', 'Senate confirmed'], es: ['confirmación del Senado', 'confirmado por el Senado', 'confirmada por el Senado'] },
  },
  {
    id: 'returned-nomination',
    category: 'nominations',
    source: 'https://www.senate.gov/legislative/nom_rtn.htm',
    match: { en: ['returned to the President'], es: ['devuelta al Presidente'] },
  },
  {
    id: 'treaty',
    category: 'nominations',
    source: 'https://www.senate.gov/about/powers-procedures/treaties.htm',
    match: { en: ['treaty', 'treaties'], es: [] },
  },
  {
    id: 'resolution-of-ratification',
    category: 'nominations',
    source: 'https://www.senate.gov/about/powers-procedures/treaties.htm',
    match: { en: ['resolution of ratification'], es: ['resolución de ratificación'] },
  },
  {
    id: 'impeachment',
    category: 'nominations',
    source: 'https://www.senate.gov/about/powers-procedures/impeachment.htm',
    match: { en: ['impeachment', 'impeach', 'impeached', 'articles of impeachment'], es: ['juicio político'] },
  },
  {
    id: 'congress',
    category: 'people',
    source: 'https://www.senate.gov/general/common/generic/NewCongress_faq.htm',
    match: { en: [], es: [] },
  },
  {
    id: 'speaker-of-the-house',
    category: 'people',
    source: 'https://www.house.gov/the-house-explained',
    match: { en: ['Speaker of the House', 'House Speaker'], es: ['presidente de la Cámara', 'presidenta de la Cámara'] },
  },
  {
    id: 'majority-leader',
    category: 'people',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#floor_leaders',
    match: { en: ['majority leader'], es: ['líder de la mayoría'] },
  },
  {
    id: 'minority-leader',
    category: 'people',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#floor_leaders',
    match: { en: ['minority leader'], es: ['líder de la minoría'] },
  },
  {
    id: 'whip',
    category: 'people',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#whip',
    match: { en: ['majority whip', 'minority whip', 'party whip', 'whip count'], es: ['whip'] },
  },
  {
    id: 'president-pro-tempore',
    category: 'people',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#president_pro_tempore',
    match: { en: ['president pro tempore', 'pro tempore'], es: ['presidente pro tempore', 'pro tempore'] },
  },
  {
    id: 'presiding-officer',
    category: 'people',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#presiding_officer',
    match: { en: ['presiding officer'], es: [] },
  },
  {
    id: 'president-of-the-senate',
    category: 'people',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#president_of_the_Senate',
    match: { en: ['President of the Senate'], es: ['presidente del Senado'] },
  },
  {
    id: 'parliamentarian',
    category: 'people',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#parliamentarian',
    match: { en: ['parliamentarian'], es: ['parlamentario del Senado', 'parlamentaria del Senado'] },
  },
  {
    id: 'caucus',
    category: 'people',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#caucus',
    match: { en: ['congressional caucus'], es: [] },
  },
  {
    id: 'congressional-district',
    category: 'people',
    source: 'https://www.house.gov/the-house-explained',
    match: { en: ['congressional district', 'congressional districts'], es: ['distrito congresional', 'distritos congresionales'] },
  },
  {
    id: 'at-large',
    category: 'people',
    source: 'https://www.archives.gov/founding-docs/constitution-transcript',
    match: { en: ['at-large', 'at large seat', 'at large district'], es: ['at-large', 'distrito único'] },
  },
  {
    id: 'delegate',
    category: 'people',
    source: 'https://www.house.gov/the-house-explained',
    match: { en: ['nonvoting delegate', 'non-voting delegate', 'Delegate to the House'], es: [] },
  },
  {
    id: 'resident-commissioner',
    category: 'people',
    source: 'https://www.house.gov/the-house-explained',
    match: { en: ['Resident Commissioner'], es: ['comisionado residente', 'comisionada residente'] },
  },
  {
    id: 'apportionment',
    category: 'people',
    source: 'https://www.census.gov/topics/public-sector/congressional-apportionment/about.html',
    match: { en: ['congressional apportionment', 'reapportionment', 'apportionment of Representatives'], es: ['reparto de escaños'] },
  },
  {
    id: 'redistricting',
    category: 'people',
    source: 'https://www.census.gov/programs-surveys/decennial-census/about/rdo.html',
    match: { en: ['redistricting', 'redistrict', 'redistricted'], es: ['redistritación', 'redistribución de distritos'] },
  },
  {
    id: 'special-election',
    category: 'people',
    source: 'https://www.senate.gov/about/origins-foundations/electing-appointing-senators.htm',
    match: { en: ['special election', 'special elections'], es: ['elección especial', 'elecciones especiales'] },
  },
  {
    id: 'vacancy',
    category: 'people',
    source: 'https://clerk.house.gov/Members/ViewVacancies',
    match: { en: ['vacant seat', 'vacant seats'], es: ['escaño vacante', 'escaños vacantes'] },
  },
  {
    id: 'member-elect',
    category: 'people',
    source: 'https://clerk.house.gov/Members/ViewVacancies',
    match: { en: ['member-elect', 'senator-elect', 'representative-elect'], es: ['senador electo', 'senadora electa', 'representante electo', 'representante electa'] },
  },
  {
    id: 'senate-class',
    category: 'people',
    source: 'https://www.senate.gov/about/research-tools/glossary.htm#class',
    match: { en: ['Senate class'], es: ['clase del Senado'] },
  },
  {
    id: 'inspector-general',
    category: 'people',
    source: 'https://www.ignet.gov/content/frequently-asked-questions',
    match: { en: ['inspector general', 'inspectors general', 'Office of Inspector General', 'Office of the Inspector General'], es: ['inspector general', 'inspectores generales', 'Oficina del Inspector General'] },
  },
  {
    id: 'gao',
    category: 'people',
    source: 'https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title31-section702&num=0&edition=prelim',
    match: { en: ['Government Accountability Office', 'GAO', 'Comptroller General'], es: ['Oficina de Rendición de Cuentas del Gobierno', 'Oficina de Rendición de Cuentas', 'GAO', 'Contralor General'] },
  },
] as const satisfies readonly GlossaryEntryShape[];

/**
 * Phrases the matcher reads and leaves PLAIN, per language: each contains a
 * listed phrase but means something else, so it must win over the shorter
 * phrase inside it (longest first) and then mark nothing. Each one comes from
 * a sentence in the committed corpus or the shape next to it, and is pinned in
 * tests/glossary.unit.spec.ts. A possessive after "shutdown of" is the tell:
 * it is someone's operation being closed, not the government's funding
 * running out.
 */
export const GLOSSARY_NEAR_MISSES: { readonly en: readonly string[]; readonly es: readonly string[] } = {
  en: [
    'government shutdown of their',
    'government shutdown of its',
    'government shutdown of his',
    'government shutdown of her',
    'during a shutdown of',
  ],
  es: [],
};

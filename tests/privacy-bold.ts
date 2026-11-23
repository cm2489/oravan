/*
 * The phrases /privacy bolds, per paragraph, in both languages. Shared by
 * tests/privacy-emphasis.unit.spec.ts (the catalog and next-intl's parse of
 * it) and tests/privacy-emphasis.spec.ts (the rendered page, by role).
 *
 * Owner's pick, 2026-09-29, reviewing the privacy-versions page: Version 2,
 * "bold key phrases, no new words, no headers". The English phrases are that
 * page's list, word for word. The Spanish phrases carry the same promise in
 * the Spanish sentence's own order: where English bolds "no user accounts",
 * Spanish takes the verb too ("no tiene cuentas de usuario"), because the
 * negation sits in front of it.
 *
 * p5, the closing line, is semibold as a whole, as it shipped, so it bolds
 * nothing inside.
 *
 * p2's third phrase lost a word on 2026-09-29: it said "one-tap button"
 * ("de una sola vez"), and the erase on the record page asks first, so the
 * promise now names no step count (tests/copy-truth.unit.spec.ts).
 *
 * p7's second phrase names its subject since 2026-11-12 (owner's pick that
 * day): it said the street address is "never stored or written to any log",
 * and Oravan can speak only for its own code, not for the Census Bureau's
 * logs, so the phrase is now "never stores it or writes it to any log" with
 * Oravan as the subject in front of it.
 *
 * p9's second phrase changed the same day: "no address is stored and none
 * can be recovered" claimed more than hard rule 1 does (while the day lasts,
 * someone holding the counts database and the day's key could test whether
 * a given address visited), so the phrase is now "this count stores no
 * address" and the sentence after it says what holds until the day ends.
 *
 * p9's two phrases became plural on 2026-11-23 (the owner's answer that day,
 * card `people`, option b): a second site-wide daily number joined the first
 * (the addresses that opened a page the way a browser does), so "one number
 * a day" / "this count" became "two numbers a day" / "these counts". Same
 * promise, same words otherwise.
 *
 * Step 2 the same day (the reading signal, app/api/seen) made it "three
 * numbers a day", and changed p4's bold phrase: it said "No analytics
 * trackers", and Oravan's own script now reports, once per page load, the
 * kind of page a person scrolled or tapped on. That is first-party analytics
 * with no identifier, so the phrase now promises exactly what holds: "No
 * third-party analytics, no advertising pixels, no cookies at all."
 */
export type PrivacyParagraph = 'p1' | 'p2' | 'p3' | 'p7' | 'p4' | 'p8' | 'p9' | 'p5';

export const PRIVACY_BOLD: Record<'en' | 'es', Record<PrivacyParagraph, readonly string[]>> = {
  en: {
    p1: ['no user accounts', 'never ask you to give us your name or email', 'one optional exception'],
    p2: [
      "stored only in your browser's local storage, on your device",
      'used in memory, never stored',
      'button that erases all of it',
    ],
    p3: ['not linked to any identity', "don't keep a log tying addresses to political positions"],
    p7: ['type your street address', 'never stores it or writes it to any log', 'Only the district number comes back.'],
    p4: ['No third-party analytics, no advertising pixels, no cookies at all.'],
    p8: ['daily counts, none of them tied to a visitor', 'never which one'],
    p9: ['three numbers a day for the whole site', 'these counts store no address'],
    p5: [],
  },
  es: {
    p1: ['no tiene cuentas de usuario', 'nunca pedimos que nos des tu nombre ni tu correo', 'una sola excepción opcional'],
    p2: [
      'se guardan únicamente en el almacenamiento local de tu navegador, en tu dispositivo',
      'se usa en memoria, nunca se guarda',
      'un botón que lo borra todo',
    ],
    p3: ['no se vinculan a ninguna identidad', 'no guardamos registros que liguen direcciones con posiciones políticas'],
    p7: ['escribir tu dirección', 'nunca la guarda ni la escribe en ningún registro', 'Solo regresa el número del distrito.'],
    p4: ['Sin analítica de terceros, sin píxeles publicitarios, sin cookies en absoluto.'],
    p8: ['conteos diarios sencillos, ninguno ligado a un visitante', 'nunca cuál en concreto'],
    p9: ['tres números al día para todo el sitio', 'estos conteos no guardan ninguna dirección'],
    p5: [],
  },
};

export const PRIVACY_PARAGRAPHS = Object.keys(PRIVACY_BOLD.en) as PrivacyParagraph[];

/** A catalog string as the page renders it: the words, without the tags. */
export const withoutTags = (message: string) => message.replace(/<\/?strong>/g, '');

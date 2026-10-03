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
    p7: ['type your street address', 'never stored or written to any log', 'Only the district number comes back.'],
    p4: ['No analytics trackers, no advertising pixels, no cookies at all.'],
    p8: ['daily counts, none of them tied to a visitor', 'never which one'],
    p9: ['one number a day for the whole site', 'no address is stored and none can be recovered'],
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
    p7: ['escribir tu dirección', 'nunca se guarda ni se escribe en ningún registro', 'Solo regresa el número del distrito.'],
    p4: ['Sin rastreadores de analítica, sin píxeles publicitarios, sin cookies en absoluto.'],
    p8: ['conteos diarios sencillos, ninguno ligado a un visitante', 'nunca cuál en concreto'],
    p9: ['un solo número al día para todo el sitio', 'ninguna dirección se guarda ni puede recuperarse'],
    p5: [],
  },
};

export const PRIVACY_PARAGRAPHS = Object.keys(PRIVACY_BOLD.en) as PrivacyParagraph[];

/** A catalog string as the page renders it: the words, without the tags. */
export const withoutTags = (message: string) => message.replace(/<\/?strong>/g, '');

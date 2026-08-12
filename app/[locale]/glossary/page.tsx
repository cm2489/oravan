import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { hreflangAlternates } from '@/lib/hreflang';
import { GLOSSARY_TERM_IDS } from '@/lib/glossary';

/*
 * THE PROCEDURAL GLOSSARY PAGE (issue #181).
 *
 * The owner's ruling on the issue was "do both" — this page AND an in-place
 * popover on the term. This is the half that has none of the popover's risks:
 * a plain, statically generated, keyboard-and-screen-reader-trivial document
 * with one stable anchor per term, so `/glossary#cloture` is a link anyone can
 * send and every popover has somewhere to point.
 *
 * BUILT LIKE /citations, on purpose. Same `article` + `max-w-read` column,
 * same one-cap-on-the-column rule (DESIGN.md's measure section: per-block caps
 * produce a staggered right edge), same hairline-ruled `section` + `h2` + `p`
 * rhythm. A reader who has read the citability page should recognise this as
 * the same kind of document, because it is one.
 *
 * WHY `section` + `h2` AND NOT `dl`. A definition list is the tempting
 * markup, and it is the wrong one here: `<dt>`'s content model forbids heading
 * content, so every term would stop being a heading — no `h2` in the document
 * outline, nothing for a screen reader's heading list, and no landing target
 * with a name when someone follows `#cloture` from a popover. The section/
 * heading pair keeps all three, and it is what /citations already does.
 *
 * WHAT THE COPY MAY SAY is fixed by the issue and enforced by
 * tests/glossary.unit.spec.ts: 2–4 sentences of mechanics, no stakes, no
 * dates, no predictions. The two calendar entries state the no-schedule fact
 * outright, because "on the calendar" is exactly the phrase a reader is most
 * likely to have mistaken for a scheduled vote (see DESIGN.md's still-open
 * printed-date ruling for why this product is careful there).
 *
 * NO AI LABEL, and that is not an oversight: this is hand-authored UI copy in
 * messages/*.json, the same class of string as every other page's prose, and
 * it goes through the owner's own review on this PR. The AI label belongs on
 * generated content (decodes, scripts, Big Question summaries), and putting
 * one here would make the label mean less everywhere it is true.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'glossary' });
  return {
    title: t('title'),
    description: t('metaDescription'),
    alternates: hreflangAlternates(locale, '/glossary'),
  };
}

export default async function GlossaryPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('glossary');

  return (
    <article className="mx-auto max-w-read px-4 py-12">
      {/* one cap on the column, not one per block */}
      <div className="max-w-read">
        <h1 className="text-h2-loud font-extrabold">{t('title')}</h1>
        <p className="mt-4 text-lede text-ink-2">{t('intro')}</p>
        <p className="mt-3 text-sm text-ink-2">{t('scopeNote')}</p>

        {/* THE INDEX. Eleven entries is past the point where a reader should
            have to scroll to find out what is here. Ink links, not green:
            these move you around inside a document you are already reading —
            they do not go anywhere, and `go` is spent on actions and content
            links. Two columns from 40rem so the list is one glance rather
            than a third of a screen. */}
        {/* `mt-12`, not `mt-10`: 40px is off the space scale — DESIGN.md's
            machine-readable block (#226) names p-10/40px explicitly as one of
            the four rungs that are not part of it. */}
        <nav aria-labelledby="glossary-index" className="mt-12 border-t-[3px] border-ink pt-4">
          <h2
            id="glossary-index"
            className="text-2xs leading-tight font-extrabold tracking-[0.1em] text-ink-2 uppercase"
          >
            {t('indexLabel')}
          </h2>
          <ul className="mt-1 grid list-none sm:grid-cols-2 sm:gap-x-6">
            {GLOSSARY_TERM_IDS.map((id) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="inline-flex min-h-11 items-center text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
                >
                  {t(`terms.${id}.term`)}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {GLOSSARY_TERM_IDS.map((id) => (
          /* The id IS the term id, and it is a permanent public string: every
             popover's "Full glossary →" and anything anyone has ever pasted
             resolves here. See lib/glossary.ts. */
          <section key={id} id={id} className="mt-8 scroll-mt-8 border-t border-line pt-6">
            <h2 className="text-h3 font-extrabold">{t(`terms.${id}.term`)}</h2>
            <p className="mt-2">{t(`terms.${id}.body`)}</p>
          </section>
        ))}
      </div>
    </article>
  );
}

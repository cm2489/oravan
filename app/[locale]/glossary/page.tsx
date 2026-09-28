import type { Metadata } from 'next';
import { ExternalLink } from 'lucide-react';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { Chip } from '@/components/system/Chip';
import { Link } from '@/i18n/navigation';
import { hreflangAlternates } from '@/lib/hreflang';
import { GLOSSARY_CATEGORIES, GLOSSARY_ENTRIES } from '@/lib/glossary';

/*
 * THE GLOSSARY PAGE (issue #181; expanded 2026-09-28, UX inventory C05).
 *
 * The owner kept it and asked for more entries ("I'd rather have too many
 * than too little"), and on the same day took it out of the reading path: a
 * glossed term anywhere on the site now opens its definition in place and no
 * longer links here. So this page is the reference — every entry, in one
 * statically generated document, with one stable anchor per term
 * (`/glossary#cloture` still resolves for anything anyone ever sent).
 *
 * BUILT LIKE /citations: the same `article` + `max-w-read` column and the
 * same hairline-ruled `section` + heading + `p` rhythm.
 *
 * SECTIONS, NOT ONE LIST. With well over a hundred entries, a flat index of
 * every term would be several screens of links before the first definition
 * on a phone. So the index jumps to seven sections, and each section lists
 * its terms alphabetically in the reader's own language (a Spanish reader
 * looks for "Veto de bolsillo" under V). Headings: h2 per section, h3 per
 * term — `section` + heading rather than `dl`, because `<dt>` cannot hold a
 * heading and every term needs to be one (outline, screen-reader heading
 * list, and a landing target with a name).
 *
 * THE SOURCE LINE. Each entry is based on an official, public-domain page,
 * read when the entry was written (lib/glossary-terms.ts), and prints that
 * page's site under it. The link text is the site's own name, which is the
 * same in both languages; the pages it opens are in English, so the link
 * says so with `hrefLang`.
 *
 * THE AI LABEL (2026-09-28, CLAUDE.md rule 4: "Every AI-written word is
 * labeled where it first appears"). The definitions live in messages/*.json
 * like UI copy, but they were drafted by AI from the official pages cited
 * under each — so this page says so once, above the first of them, with the
 * site's own unboxed AI caption (`Chip tone="ai"`, as on the bill page and
 * /questions), and every in-place box on the rest of the site says so again
 * (components/GlossaryTerm.tsx). The label links to the AI-content policy on
 * /citations — the site's one page on how its AI content is made and marked —
 * in this page's quiet source-link style, as a full 44px target.
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

/** "www.senate.gov" → "senate.gov": the name a reader recognises. */
function siteOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '');
}

export default async function GlossaryPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('glossary');
  const tc = await getTranslations('common');
  const collator = new Intl.Collator(locale, { sensitivity: 'base' });

  const sections = GLOSSARY_CATEGORIES.map((category) => ({
    category,
    entries: GLOSSARY_ENTRIES.filter((e) => e.category === category)
      .map((e) => ({ ...e, term: t(`terms.${e.id}.term`), body: t(`terms.${e.id}.body`) }))
      .sort((a, b) => collator.compare(a.term, b.term)),
  }));

  return (
    <article className="mx-auto max-w-read px-4 py-12">
      {/* one cap on the column, not one per block */}
      <div className="max-w-read">
        <h1 className="text-h2-loud font-extrabold">{t('title')}</h1>
        <p className="mt-4 text-lede text-ink-2">{t('intro')}</p>
        <p className="mt-3 text-sm text-ink-2">{t('scopeNote')}</p>
        {/* The AI label, above the first definition, and where it is made
            and marked. See the header. */}
        <p
          data-glossary-page-ai-note
          className="mt-4 flex flex-wrap items-center gap-x-4 text-sm text-ink-2"
        >
          <Chip tone="ai" marker={tc('aiMarker')}>
            {t('pageAiNote')}
          </Chip>
          <Link
            href="/citations#ai-policy"
            className="inline-flex min-h-11 items-center underline decoration-line-strong underline-offset-4 hover:decoration-ink"
          >
            {t('aiPolicyLink')}
          </Link>
        </p>

        {/* THE INDEX: the seven sections. Ink links, not green — they move
            you around inside a document you are already reading. */}
        <nav aria-labelledby="glossary-index" className="mt-12 border-t-[3px] border-ink pt-4">
          <h2
            id="glossary-index"
            className="text-2xs leading-tight font-extrabold tracking-[0.1em] text-ink-2 uppercase"
          >
            {t('indexLabel')}
          </h2>
          <ul className="mt-1 grid list-none sm:grid-cols-2 sm:gap-x-6">
            {sections.map(({ category }) => (
              <li key={category}>
                <a
                  href={`#section-${category}`}
                  className="inline-flex min-h-11 items-center text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
                >
                  {t(`categories.${category}`)}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {sections.map(({ category, entries }) => (
          <section
            key={category}
            id={`section-${category}`}
            aria-labelledby={`section-${category}-h`}
            className="mt-12 scroll-mt-8 border-t-[3px] border-ink pt-4"
          >
            <h2 id={`section-${category}-h`} className="text-h3 font-extrabold">
              {t(`categories.${category}`)}
            </h2>
            {entries.map((e) => (
              /* The id IS the term id, and it is a permanent public string:
                 anything anyone has ever pasted resolves here. */
              <section key={e.id} id={e.id} className="mt-6 scroll-mt-8 border-t border-line pt-6">
                <h3 className="text-lg font-extrabold">{e.term}</h3>
                <p className="mt-2">{e.body}</p>
                <p className="text-sm text-ink-2">
                  <a
                    href={e.source}
                    hrefLang="en"
                    rel="noopener noreferrer"
                    target="_blank"
                    className="inline-flex min-h-11 items-center gap-1.5 underline decoration-line-strong underline-offset-4 hover:decoration-ink"
                  >
                    {t('sourceLabel', { site: siteOf(e.source) })}
                    <ExternalLink className="h-4 w-4 flex-none" aria-hidden />
                  </a>
                </p>
              </section>
            ))}
          </section>
        ))}
      </div>
    </article>
  );
}

import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { hreflangAlternates } from '@/lib/hreflang';
import { dataAsOfString } from '@/lib/freshness';
import {
  AI_LABEL_TEXT,
  LICENSE_AI_CONTENT,
  LICENSE_PUBLIC_DOMAIN,
  MCP_ENDPOINT_URL,
  SOURCE,
  TOOL_INFO,
  TOOL_NAMES,
} from '@/lib/core/mcp';

/*
 * S12 — the public MCP server docs page (docs/ideation/2026-07-05-build-gtm-
 * strategy.md §1.3 S12; canonical-source playbook item 11 in
 * docs/ideation/2026-07-02-mcp-spec.md §4). Low-key, citizen-site register,
 * same as every other page: what the server is, its literal endpoint (not
 * printed anywhere else a person can read), the 5 tools, an example client
 * config, the privacy posture, and the citation envelope.
 *
 * Every fact quoted here is read from the one place it's already defined,
 * never re-typed: TOOL_INFO/MCP_ENDPOINT_URL/SOURCE/AI_LABEL_TEXT/LICENSE_*
 * all live in lib/core/mcp.ts, the same module app/api/mcp/[transport]/
 * route.ts imports for the live server. A visitor reading this page sees
 * exactly what the server actually sends - not a hand-copied second draft
 * that can silently drift, the same discipline app/[locale]/citations/
 * page.tsx already established for the envelope fields.
 *
 * Tool titles/descriptions stay English-only on this bilingual page, on
 * purpose - see TOOL_INFO's own doc comment and t('toolsLangNote') below for
 * why: they're protocol metadata a calling AI model reads, not prose a
 * person reads, the same distinction route.ts's header comment draws.
 * Everything a tool call actually hands back to a conversation - the
 * envelope's source/ai_label/license text below - IS bilingual, and both
 * language versions are shown here regardless of which locale route this is,
 * same pattern as the citations page.
 */

const EXAMPLE_CLIENT_CONFIG = `{
  "mcpServers": {
    "oravan": {
      "url": "${MCP_ENDPOINT_URL}"
    }
  }
}`;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'mcp' });
  return { title: t('title'), alternates: hreflangAlternates(locale, '/mcp') };
}

/** Local twin of citations/page.tsx's BilingualQuote - kept page-local
 *  rather than shared, since it's ~15 lines of presentational JSX and this
 *  page's smallest-surface brief is to not touch the citations page beyond
 *  its one added link. */
function BilingualQuote({
  en,
  es,
  langEnglish,
  langSpanish,
}: {
  en: string;
  es: string;
  langEnglish: string;
  langSpanish: string;
}) {
  return (
    <div className="mt-3 space-y-2 rounded-control border-l-[3px] border-ink bg-wash px-4 py-3 text-sm">
      <p lang="en">
        <span className="font-semibold text-ink-2">{langEnglish}: </span>
        {en}
      </p>
      <p lang="es">
        <span className="font-semibold text-ink-2">{langSpanish}: </span>
        {es}
      </p>
    </div>
  );
}

export default async function McpPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('mcp');
  // langEnglish/langSpanish are the citations page's own translated labels -
  // reused rather than redefined a second time in this namespace, so the two
  // pages can never disagree on how to name a language.
  const tc = await getTranslations('citations');
  const dataAsOf = await dataAsOfString(locale);

  return (
    <article className="mx-auto max-w-5xl px-4 py-12">
      {/* one cap on the column, not one per block */}
      <div className="max-w-read">
        <h1 className="text-h2-loud font-extrabold">{t('title')}</h1>
        <p className="mt-4 text-lede text-ink-2">{t('intro')}</p>

        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-h3 font-extrabold">{t('endpointTitle')}</h2>
          <p className="mt-2">{t('endpointBody')}</p>
          <p className="mt-3 text-sm text-ink-2">{t('endpointLabel')}</p>
          <p className="mt-1 break-all rounded-control bg-wash px-4 py-3 font-mono text-sm">
            {MCP_ENDPOINT_URL}
          </p>
        </section>

        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-h3 font-extrabold">{t('connectTitle')}</h2>
          <p className="mt-2">{t('connectBody')}</p>
          <pre className="mt-3 overflow-x-auto rounded-control bg-ink-deep p-4 text-xs text-paper">
            <code>{EXAMPLE_CLIENT_CONFIG}</code>
          </pre>
        </section>

        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-h3 font-extrabold">{t('toolsTitle')}</h2>
          <p className="mt-2">{t('toolsIntro')}</p>
          <dl className="mt-4 space-y-4">
            {TOOL_NAMES.map((name) => (
              <div key={name} className="rounded-control bg-wash p-4">
                <dt>
                  <code className="font-mono text-sm font-semibold">{name}</code>
                  <span className="ml-2 text-sm text-ink-2">{TOOL_INFO[name].title}</span>
                </dt>
                <dd className="mt-1.5 text-sm text-ink-2" lang="en">
                  {TOOL_INFO[name].description}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm text-ink-2">{t('toolsLangNote')}</p>
        </section>

        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-h3 font-extrabold">{t('privacyTitle')}</h2>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>{t('privacyNoAccounts')}</li>
            <li>{t('privacyRateLimit')}</li>
            <li>{t('privacyNoLogging')}</li>
          </ul>
          <Link
            href="/privacy"
            className="mt-4 inline-flex min-h-12 items-center gap-2 rounded-control border-2 border-ink px-5 font-bold text-ink no-underline hover:bg-ink hover:text-paper"
          >
            {t('privacyLinkText')} →
          </Link>
        </section>

        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-h3 font-extrabold">{t('envelopeTitle')}</h2>
          <p className="mt-2">{t('envelopeBody')}</p>
          <BilingualQuote
            en={SOURCE.en}
            es={SOURCE.es}
            langEnglish={tc('langEnglish')}
            langSpanish={tc('langSpanish')}
          />
          <BilingualQuote
            en={AI_LABEL_TEXT.en}
            es={AI_LABEL_TEXT.es}
            langEnglish={tc('langEnglish')}
            langSpanish={tc('langSpanish')}
          />
        </section>

        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-h3 font-extrabold">{t('licenseTitle')}</h2>
          <dl className="mt-2 space-y-4 text-sm">
            <div>
              <dt className="font-semibold text-ink-2">{t('licenseOfficialLabel')}</dt>
              <dd className="mt-0.5">
                <BilingualQuote
                  en={LICENSE_PUBLIC_DOMAIN.en}
                  es={LICENSE_PUBLIC_DOMAIN.es}
                  langEnglish={tc('langEnglish')}
                  langSpanish={tc('langSpanish')}
                />
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-ink-2">{t('licenseAiLabel')}</dt>
              <dd className="mt-0.5">
                <BilingualQuote
                  en={LICENSE_AI_CONTENT.en}
                  es={LICENSE_AI_CONTENT.es}
                  langEnglish={tc('langEnglish')}
                  langSpanish={tc('langSpanish')}
                />
              </dd>
            </div>
          </dl>
        </section>

        <section className="mt-8 rounded-control bg-wash p-6 md:p-8">
          <h2 className="text-h3 font-extrabold">{t('freshnessTitle')}</h2>
          <p className="mt-2">{t('freshnessBody', { asOfField: 'as_of' })}</p>
          <p className="mt-3 rounded-control bg-paper px-4 py-3 text-sm font-semibold tabular-nums">
            {dataAsOf}
          </p>
          <Link
            href="/citations"
            className="mt-4 inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline underline-offset-2 hover:text-go-deep"
          >
            {t('citationsLinkText')} →
          </Link>
        </section>
      </div>
    </article>
  );
}

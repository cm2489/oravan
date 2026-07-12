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
    <div className="mt-2 max-w-prose space-y-2 rounded-control border border-line bg-paper-deep px-3 py-2 text-sm">
      <p lang="en">
        <span className="font-semibold text-ink-soft">{langEnglish}: </span>
        {en}
      </p>
      <p lang="es">
        <span className="font-semibold text-ink-soft">{langSpanish}: </span>
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
    <article className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="font-display text-4xl font-bold">{t('title')}</h1>
      <p className="mt-4 max-w-prose text-lg leading-relaxed text-ink-soft">{t('intro')}</p>

      <section className="mt-10">
        <h2 className="font-display text-2xl font-bold">{t('endpointTitle')}</h2>
        <p className="mt-2 max-w-prose leading-relaxed">{t('endpointBody')}</p>
        <p className="mt-3 text-sm text-ink-soft">{t('endpointLabel')}</p>
        <p className="mt-1 break-all rounded-control border border-line bg-paper-deep px-3 py-2 font-mono text-sm">
          {MCP_ENDPOINT_URL}
        </p>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-2xl font-bold">{t('connectTitle')}</h2>
        <p className="mt-2 max-w-prose leading-relaxed">{t('connectBody')}</p>
        <pre className="mt-3 overflow-x-auto rounded-control border border-line bg-night p-4 text-xs text-paper">
          <code>{EXAMPLE_CLIENT_CONFIG}</code>
        </pre>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-2xl font-bold">{t('toolsTitle')}</h2>
        <p className="mt-2 max-w-prose leading-relaxed">{t('toolsIntro')}</p>
        <dl className="mt-4 space-y-4">
          {TOOL_NAMES.map((name) => (
            <div key={name} className="rounded-card border border-line bg-surface p-4">
              <dt>
                <code className="font-mono text-sm font-semibold">{name}</code>
                <span className="ml-2 text-sm text-ink-soft">{TOOL_INFO[name].title}</span>
              </dt>
              <dd className="mt-1.5 max-w-prose text-sm leading-relaxed text-ink-soft" lang="en">
                {TOOL_INFO[name].description}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 max-w-prose text-sm leading-relaxed text-ink-soft">{t('toolsLangNote')}</p>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-2xl font-bold">{t('privacyTitle')}</h2>
        <ul className="mt-2 max-w-prose list-disc space-y-2 pl-5 leading-relaxed">
          <li>{t('privacyNoAccounts')}</li>
          <li>{t('privacyRateLimit')}</li>
          <li>{t('privacyNoLogging')}</li>
        </ul>
        <Link
          href="/privacy"
          className="mt-3 inline-flex min-h-[44px] items-center gap-1.5 rounded-control border-2 border-ink px-5 py-3 font-semibold hover:bg-paper-deep"
        >
          {t('privacyLinkText')} →
        </Link>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-2xl font-bold">{t('envelopeTitle')}</h2>
        <p className="mt-2 max-w-prose leading-relaxed">{t('envelopeBody')}</p>
        <BilingualQuote en={SOURCE.en} es={SOURCE.es} langEnglish={tc('langEnglish')} langSpanish={tc('langSpanish')} />
        <BilingualQuote
          en={AI_LABEL_TEXT.en}
          es={AI_LABEL_TEXT.es}
          langEnglish={tc('langEnglish')}
          langSpanish={tc('langSpanish')}
        />
      </section>

      <section className="mt-10">
        <h2 className="font-display text-2xl font-bold">{t('licenseTitle')}</h2>
        <dl className="mt-2 max-w-prose space-y-4 text-sm leading-relaxed">
          <div>
            <dt className="font-semibold text-ink-soft">{t('licenseOfficialLabel')}</dt>
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
            <dt className="font-semibold text-ink-soft">{t('licenseAiLabel')}</dt>
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

      <section className="mt-10 rounded-card border border-line bg-paper-deep p-6 md:p-8">
        <h2 className="font-display text-2xl font-bold">{t('freshnessTitle')}</h2>
        <p className="mt-2 max-w-prose leading-relaxed">{t('freshnessBody', { asOfField: 'as_of' })}</p>
        <p className="mt-3 rounded-control border border-line bg-surface px-3 py-2 text-sm font-semibold">
          {dataAsOf}
        </p>
        <Link
          href="/citations"
          className="mt-4 inline-flex min-h-[44px] items-center gap-1.5 font-semibold underline hover:no-underline"
        >
          {t('citationsLinkText')} →
        </Link>
      </section>
    </article>
  );
}

import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { hreflangAlternates } from '@/lib/hreflang';
import { SITE_ORIGIN, feedPaths } from '@/lib/site';
import { MCP_ENDPOINT_URL, TOOL_NAMES } from '@/lib/core/mcp';

/*
 * /follow — every way to keep up with Oravan that exists TODAY, on one calm
 * page (plan item B8: "a citizen can find the feed in one click from any
 * page" — the footer's Follow column links here and to each feed directly).
 *
 * Nothing on this page is a second copy of a fact that lives elsewhere:
 *   - the feed paths come from lib/site.ts's feedPaths(), the same helper
 *     the footer and /embeds read;
 *   - the MCP connection URL and the tool names come from lib/core/mcp.ts,
 *     the module the live server (app/api/mcp/[transport]) registers its
 *     tools from — so the count printed here is TOOL_NAMES.length and can't
 *     drift from what the server actually offers.
 *
 * The broadcast-channels section is EMPTY BY DESIGN. No social or messaging
 * account exists yet, so there is nothing to link; the section says so
 * rather than being left out, so a reader who came looking for one gets a
 * plain answer instead of an absence. When a channel opens, it is added
 * here — never linked before the account exists.
 *
 * Static: no searchParams, no headers — tests/static-rendering.spec.ts
 * asserts both locales prerender.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'follow' });
  return { title: t('title'), alternates: hreflangAlternates(locale, '/follow') };
}

/** One feed row: a one-line explanation, then the full address as the link. */
function FeedAddress({ title, body, path, type }: { title: string; body: string; path: string; type: string }) {
  return (
    <div className="mt-6">
      <h3 className="text-lg font-bold">{title}</h3>
      <p className="mt-1">{body}</p>
      <a
        href={path}
        type={type}
        className="mt-2 inline-flex min-h-11 items-center break-all font-mono text-sm font-semibold text-go underline underline-offset-2 hover:text-go-deep"
      >
        {`${SITE_ORIGIN}${path}`}
      </a>
    </div>
  );
}

export default async function FollowPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('follow');
  const feeds = feedPaths(locale);

  return (
    <article className="mx-auto max-w-read px-4 py-12">
      {/* one cap on the column, not one per block */}
      <div className="max-w-read">
        <h1 className="text-h2-loud font-extrabold">{t('title')}</h1>
        <p className="mt-4 text-lede text-ink-2">{t('intro')}</p>

        <section aria-labelledby="follow-feeds" className="mt-8 border-t border-line pt-6">
          <h2 id="follow-feeds" className="text-h3 font-extrabold">
            {t('feedsTitle')}
          </h2>
          <p className="mt-2">{t('feedsBody')}</p>
          <FeedAddress
            title={t('rssTitle')}
            body={t('rssBody')}
            path={feeds.xml}
            type="application/rss+xml"
          />
          <FeedAddress
            title={t('jsonTitle')}
            body={t('jsonBody')}
            path={feeds.json}
            type="application/json"
          />
          <p className="mt-4 text-sm text-ink-2">{t('feedLangNote')}</p>
        </section>

        <section aria-labelledby="follow-mcp" className="mt-8 border-t border-line pt-6">
          <h2 id="follow-mcp" className="text-h3 font-extrabold">
            {t('mcpTitle')}
          </h2>
          <p className="mt-2">{t('mcpBody')}</p>
          <p className="mt-3 text-sm text-ink-2">{t('mcpUrlLabel')}</p>
          <p
            data-testid="follow-mcp-url"
            className="mt-1 break-all rounded-control bg-wash px-4 py-3 font-mono text-sm"
          >
            {MCP_ENDPOINT_URL}
          </p>
          <p className="mt-3 text-sm text-ink-2">{t('mcpToolsLabel', { count: TOOL_NAMES.length })}</p>
          <ul data-testid="follow-mcp-tools" className="mt-1 grid gap-1">
            {TOOL_NAMES.map((name) => (
              <li key={name}>
                <code className="font-mono text-sm">{name}</code>
              </li>
            ))}
          </ul>
          <Link
            href="/mcp"
            className="mt-4 inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline underline-offset-2 hover:text-go-deep"
          >
            {t('mcpLink')} <span aria-hidden>→</span>
          </Link>
        </section>

        <section aria-labelledby="follow-embeds" className="mt-8 border-t border-line pt-6">
          <h2 id="follow-embeds" className="text-h3 font-extrabold">
            {t('embedsTitle')}
          </h2>
          <p className="mt-2">{t('embedsBody')}</p>
          <Link
            href="/embeds"
            className="mt-4 inline-flex min-h-11 items-center gap-1.5 font-semibold text-go underline underline-offset-2 hover:text-go-deep"
          >
            {t('embedsLink')} <span aria-hidden>→</span>
          </Link>
        </section>

        {/* Empty by design — see the header comment. A recessed `wash` panel
            with an ink-2 edge (line-strong on wash is 2.97:1), the same
            treatment /partners gives its licensing note. */}
        <section
          aria-labelledby="follow-broadcast"
          data-testid="follow-broadcast"
          className="mt-8 rounded-control border border-ink-2 bg-wash p-6"
        >
          <h2 id="follow-broadcast" className="text-h3 font-extrabold">
            {t('broadcastTitle')}
          </h2>
          <p className="mt-2">{t('broadcastBody')}</p>
        </section>
      </div>
    </article>
  );
}

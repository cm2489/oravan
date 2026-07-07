import { expect, test, type Response } from '@playwright/test';
import en from '../messages/en.json';
import es from '../messages/es.json';
import { startCrossOriginHost } from './helpers';

/*
 * S13 — public/embed.js on a synthetic host page, exercising the actual
 * embed seam end to end: script tag -> injected iframe -> ZIP lookup ->
 * auto-resize postMessage. Also where this sprint's two hard privacy
 * assertions live: zero cookies anywhere in the flow, and zero requests to
 * any origin other than this app's own - the widget's "collects nothing,
 * calls no one else" claim, test-asserted rather than just documented
 * (docs/ideation/2026-07-02-embeds-spec.md §2.3).
 *
 * The host page is served from a throwaway plain-http server on its own
 * ephemeral port - a genuine cross-origin page relative to the app under
 * test (127.0.0.1:X vs localhost:PW_PORT), not a page.setContent() page.
 * That matters here specifically: WebKit's frame-ancestors matching treats
 * a page.setContent() page as an opaque ("null") origin and refuses to
 * frame anything under `frame-ancestors *` from it - a real HTTP origin is
 * both the more realistic "any third-party host" simulation AND the one
 * that actually exercises the CSP carve-out this sprint ships.
 */

function hostHtml(baseURL: string) {
  return `<!doctype html><html><body>
    <div id="host-slot"></div>
    <script src="${baseURL}/embed.js" data-oravan-widget="rep-lookup" data-locale="en" data-target="host-slot"></script>
  </body></html>`;
}

/*
 * S14 — the same loader, now also asked to inject the bill-card widget:
 * `data-oravan-widget="bill-card"` plus `data-slug` (and, untested here,
 * the optional `data-accent`/`data-radius`/`data-font` theming attrs —
 * tests/embed-bill-card.spec.ts drives those directly against the widget
 * page since the loader is a pure pass-through for them).
 */
function billCardHostHtml(baseURL: string, locale: 'en' | 'es', slug: string) {
  return `<!doctype html><html><body>
    <div id="host-slot"></div>
    <script src="${baseURL}/embed.js" data-oravan-widget="bill-card" data-locale="${locale}" data-slug="${slug}" data-target="host-slot"></script>
  </body></html>`;
}

const BILL_IFRAME_SELECTOR = 'iframe[data-oravan-embed="bill-card"]';
const DECODED_SLUG = 'hr-5582-119';
const ES_DECODED_SLUG = 'sjres-99-119';

const IFRAME_SELECTOR = 'iframe[data-oravan-embed="rep-lookup"]';

/*
 * Each test below spins up a real ad-hoc HTTP server and a full cross-origin
 * iframe round-trip (navigation -> script -> iframe load -> fetch -> render).
 * Under this suite's standard parallel worker count that's measurably slower
 * than the 30s file default on a busy run (observed 30-34s here) even though
 * every step individually is fast - so this group gets explicit headroom
 * rather than a budget tuned to an idle machine.
 */
test.describe.configure({ timeout: 60_000 });

test('the loader injects an iframe and the widget renders inside it', async ({ page, baseURL }) => {
  const host = await startCrossOriginHost(hostHtml(baseURL!));
  try {
    await page.goto(host.url);
    const iframeEl = page.locator(IFRAME_SELECTOR);
    await expect(iframeEl).toHaveAttribute('title', /.+/);
    await expect(iframeEl).toHaveAttribute('sandbox', /allow-scripts/);
    // allow-same-origin is intentional here (see public/embed.js's comment):
    // this iframe hosts Oravan's own first-party widget, not untrusted
    // third-party content, and same-origin fetch (the ZIP lookup) needs it.
    await expect(iframeEl).toHaveAttribute('sandbox', /allow-same-origin/);
    await expect(iframeEl).not.toHaveAttribute('sandbox', /allow-top-navigation/);

    const frame = page.frameLocator(IFRAME_SELECTOR);
    await expect(frame.getByText(en.embed.frameTitle)).toBeVisible();
  } finally {
    await host.close();
  }
});

test('auto-resize: the iframe height changes once the widget renders results', async ({
  page,
  baseURL,
}) => {
  const host = await startCrossOriginHost(hostHtml(baseURL!));
  try {
    await page.goto(host.url);
    const iframeEl = page.locator(IFRAME_SELECTOR);
    await expect(iframeEl).toBeVisible();
    const before = await iframeEl.evaluate((el) => (el as HTMLIFrameElement).style.height);

    const frame = page.frameLocator(IFRAME_SELECTOR);
    await frame.getByLabel(en.home.zipLabel).fill('78501');
    await frame.getByRole('button', { name: en.home.zipCta }).click();
    await expect(frame.getByText('Monica De La Cruz')).toBeVisible();

    await expect(async () => {
      const after = await iframeEl.evaluate((el) => (el as HTMLIFrameElement).style.height);
      expect(after).not.toBe(before);
    }).toPass({ timeout: 15_000 });
  } finally {
    await host.close();
  }
});

test('zero cookies and zero third-party requests across the whole embed flow', async ({
  page,
  baseURL,
}) => {
  const base = new URL(baseURL!);
  const html = hostHtml(baseURL!);
  const host = await startCrossOriginHost(html);
  try {
    const outsideRequests: string[] = [];
    page.on('request', (req) => {
      let url: URL;
      try {
        url = new URL(req.url());
      } catch {
        return;
      }
      if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return;
      // Same-origin to the app (expected: /embed.js, the iframe doc,
      // /api/reps) or the throwaway host server itself (expected: the one
      // page we asked it to serve) are both fine. Anything else is the
      // real-world "third-party request" this claim promises never happens.
      if (url.origin !== base.origin && url.origin !== host.origin) {
        outsideRequests.push(req.url());
      }
    });

    const responses: Response[] = [];
    page.on('response', (res) => responses.push(res));

    await page.goto(host.url);
    const frame = page.frameLocator(IFRAME_SELECTOR);
    await frame.getByLabel(en.home.zipLabel).fill('78501');
    await frame.getByRole('button', { name: en.home.zipCta }).click();
    await expect(frame.getByText('Monica De La Cruz')).toBeVisible();

    expect(
      outsideRequests,
      `unexpected third-party request(s): ${outsideRequests.join(', ')}`
    ).toEqual([]);

    for (const res of responses) {
      expect(res.headers()['set-cookie'], `${res.url()} set a cookie`).toBeUndefined();
    }
    expect(await page.context().cookies()).toHaveLength(0);
  } finally {
    await host.close();
  }
});

test('bill-card via the loader: EN renders the decoded headline + AI label on a genuine cross-origin host', async ({
  page,
  baseURL,
}) => {
  const host = await startCrossOriginHost(billCardHostHtml(baseURL!, 'en', DECODED_SLUG));
  try {
    await page.goto(host.url);
    const iframeEl = page.locator(BILL_IFRAME_SELECTOR);
    await expect(iframeEl).toHaveAttribute('sandbox', /allow-same-origin/);

    const frame = page.frameLocator(BILL_IFRAME_SELECTOR);
    await expect(
      frame.getByText('Hospitals and insurers must publish real prices under HR 5582')
    ).toBeVisible();
    await expect(frame.getByText(en.og.aiDecoded, { exact: true })).toBeVisible();
  } finally {
    await host.close();
  }
});

test('bill-card via the loader: ES renders Spanish copy on a genuine cross-origin host', async ({
  page,
  baseURL,
}) => {
  const host = await startCrossOriginHost(billCardHostHtml(baseURL!, 'es', ES_DECODED_SLUG));
  try {
    await page.goto(host.url);
    const frame = page.frameLocator(BILL_IFRAME_SELECTOR);
    // The ES corpus carries its own translated headline (lib/core/bills.ts's
    // localizeBill), not the EN one.
    await expect(
      frame.getByText('El Senado busca restablecer extensiones automáticas de permisos de trabajo')
    ).toBeVisible();
    await expect(frame.getByText(es.og.aiDecoded, { exact: true })).toBeVisible();
    await expect(frame.getByText(en.og.aiDecoded, { exact: true })).toHaveCount(0);
  } finally {
    await host.close();
  }
});

test('bill-card via the loader: zero cookies and zero third-party requests', async ({
  page,
  baseURL,
}) => {
  const base = new URL(baseURL!);
  const html = billCardHostHtml(baseURL!, 'en', DECODED_SLUG);
  const host = await startCrossOriginHost(html);
  try {
    const outsideRequests: string[] = [];
    page.on('request', (req) => {
      let url: URL;
      try {
        url = new URL(req.url());
      } catch {
        return;
      }
      if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return;
      if (url.origin !== base.origin && url.origin !== host.origin) {
        outsideRequests.push(req.url());
      }
    });

    const responses: Response[] = [];
    page.on('response', (res) => responses.push(res));

    await page.goto(host.url);
    const frame = page.frameLocator(BILL_IFRAME_SELECTOR);
    await expect(
      frame.getByText('Hospitals and insurers must publish real prices under HR 5582')
    ).toBeVisible();

    expect(
      outsideRequests,
      `unexpected third-party request(s): ${outsideRequests.join(', ')}`
    ).toEqual([]);
    for (const res of responses) {
      expect(res.headers()['set-cookie'], `${res.url()} set a cookie`).toBeUndefined();
    }
    expect(await page.context().cookies()).toHaveLength(0);
  } finally {
    await host.close();
  }
});

test('the loader script itself stays well under the 5KB budget', async ({ request, baseURL }) => {
  const res = await request.get(`${baseURL}/embed.js`);
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(5 * 1024);
  // Loader responses carry no cookie either - it's a static asset, but the
  // privacy claim is "zero cookies on the embed origin", full stop.
  expect(res.headers()['set-cookie']).toBeUndefined();
});

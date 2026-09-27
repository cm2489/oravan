import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { billSlug, getBill } from '../lib/core';
import { districtsForZip, getLegislator } from '../lib/core/reps';
import { getAllNominations, nominationSlug } from '../lib/core/nominations';
import { getMoments } from '../lib/moments';
import { briefWindow } from '../lib/today';
import {
  callableBillSlug,
  decodedBills,
  decodedBillSlug,
  firstHouseRepName,
  splitZip,
  undecodedBillSlug,
} from './corpus-samples';
import {
  DYNAMIC_ROUTE_PROBES,
  LOCALE_DIR,
  localeProbes,
  localeRoutes,
  localeTopSegments,
  localeUrl,
  staticLocalePages,
  unresolvedLocaleRoutes,
} from './routes';

/*
 * The registry and the fixtures are what five sweep specs (hreflang, sitemap,
 * static-rendering, zero-cookies, frame-posture) trust for their coverage, so
 * each is checked here against an independent reading of the same fact. A
 * walker bug that returned too few routes would otherwise make every one of
 * those specs pass on less than the whole site.
 */

test.describe('tests/routes.ts reads the whole app/[locale] tree', () => {
  test('the walker finds exactly the page and route files a flat recursive listing finds', () => {
    const files = (fs.readdirSync(LOCALE_DIR, { recursive: true }) as string[])
      .filter((rel) => /(^|[\\/])(page|route)\.(tsx|ts|jsx|js)$/.test(rel))
      // The walker skips private (_x) folders and parallel-route (@x) slots,
      // which serve no URL; so does this listing.
      .filter((rel) => !rel.split(/[\\/]/).some((part) => part.startsWith('_') || part.startsWith('@')));
    expect(files.length).toBeGreaterThan(0);
    expect(localeRoutes()).toHaveLength(files.length);

    const topDirs = [...new Set(files.map((rel) => rel.split(/[\\/]/)).filter((p) => p.length > 1).map((p) => p[0]))];
    expect(localeTopSegments()).toEqual(topDirs.sort());
  });

  test('the homepage is a static page and every static pattern is a real folder', () => {
    const pages = staticLocalePages();
    expect(pages).toContain('/');
    for (const p of pages.filter((x) => x !== '/')) {
      expect(fs.existsSync(path.join(LOCALE_DIR, ...p.slice(1).split('/'))), p).toBe(true);
    }
  });

  test('every dynamic route has a probe, and every probe fills its own route pattern', () => {
    expect(unresolvedLocaleRoutes()).toEqual([]);
    for (const route of localeRoutes().filter((r) => r.dynamic)) {
      const probe = DYNAMIC_ROUTE_PROBES[route.pattern]();
      const re = new RegExp(
        '^' +
          route.pattern
            .split('/')
            .map((seg) => (seg.startsWith('[...') ? '.+' : seg.startsWith('[') ? '[^/]+' : seg))
            .join('/') +
          '$'
      );
      expect(probe, `${route.pattern} probe`).toMatch(re);
    }
    // No probe left for a route that is gone.
    const patterns = new Set(localeRoutes().map((r) => r.pattern));
    expect(Object.keys(DYNAMIC_ROUTE_PROBES).filter((p) => !patterns.has(p))).toEqual([]);
  });

  test('every dynamic probe names a record the committed corpus holds', () => {
    const tail = (pattern: string) => DYNAMIC_ROUTE_PROBES[pattern]().split('/').pop()!;
    expect(getBill(tail('/bills/[id]'))).toBeDefined();
    expect(getMoments().find((m) => m.id === tail('/questions/[id]'))?.state).not.toBe('retired');
    expect(getLegislator(tail('/reps/[bioguide]'))).toBeDefined();
    expect(getAllNominations().map(nominationSlug)).toContain(tail('/nominations/[slug]'));
    expect(briefWindow()).toContain(tail('/today/[date]'));
    // The catch-all probe must match NO real route's static path.
    expect(staticLocalePages()).not.toContain(DYNAMIC_ROUTE_PROBES['/[...rest]']());
  });

  test('URLs follow the as-needed locale prefix; handlers always spell the locale', () => {
    expect(localeUrl('en', '/')).toBe('/');
    expect(localeUrl('es', '/')).toBe('/es');
    expect(localeUrl('en', '/about')).toBe('/about');
    expect(localeUrl('es', '/about')).toBe('/es/about');
    expect(localeUrl('en', '/manifest.webmanifest', 'handler')).toBe('/en/manifest.webmanifest');
    const probes = localeProbes();
    expect(probes).toHaveLength(localeRoutes().length * 2);
  });
});

test.describe('tests/corpus-samples.ts picks bills that have the property it names', () => {
  test('decoded bills carry the full decode in both languages and both record dates', () => {
    const bills = decodedBills();
    expect(bills.length).toBeGreaterThan(1);
    for (const b of bills.slice(0, 2)) {
      expect(b.ai_headline && b.ai_summary && b.ai_sections?.what).toBeTruthy();
      expect(b.introduced_date && b.last_action_date).toBeTruthy();
    }
    expect(decodedBillSlug(0)).not.toBe(decodedBillSlug(1));
  });

  test('the undecoded bill has no AI content at all', () => {
    const b = getBill(undecodedBillSlug())!;
    expect(b.ai_headline ?? null).toBeNull();
    expect(b.ai_summary ?? null).toBeNull();
    expect(b.ai_sections ?? null).toBeNull();
    expect(decodedBills().map(billSlug)).not.toContain(undecodedBillSlug());
  });

  test('the callable bill is a decoded H.R./S. bill still in committee', () => {
    const b = getBill(callableBillSlug())!;
    expect(['hr', 's']).toContain(b.bill_type);
    expect(b.status).toBe('committee');
    expect(decodedBills().map(billSlug)).toContain(callableBillSlug());
  });

  test('the split ZIP spans two or more districts and names a sitting House member', () => {
    const zip = splitZip();
    expect(districtsForZip(zip).length).toBeGreaterThan(1);
    expect(firstHouseRepName(zip).length).toBeGreaterThan(0);
  });
});

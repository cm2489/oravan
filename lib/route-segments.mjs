/*
 * EVERY NAME THAT CAN BE THE FIRST SEGMENT OF A URL ON THIS SITE, read from
 * the tree (2026-11-14). next.config.ts reads it at BUILD time and reserves
 * every one of them against name addresses (lib/short-address.ts,
 * nameAddressAllowed), so a route added later can never be shadowed by a
 * bill's name: the build that adds the route also drops the name.
 * tests/short-address-names.unit.spec.ts checks it against the route
 * registry the sweep specs use (tests/routes.ts) and against a hand-made
 * list, so the two readings cannot drift apart unnoticed.
 *
 * Build time and specs only: it reads the filesystem, so it is never
 * imported by proxy.ts or by anything a page renders.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} root the repository root (process.cwd() at build time)
 * @param {readonly string[]} locales
 * @returns {string[]} sorted, lower-cased; each file also without its extension
 */
export function topRouteSegments(root, locales = ['en', 'es']) {
  const names = new Set();
  const add = (name) => {
    names.add(name.toLowerCase());
    names.add(name.replace(/\.[^.]+$/, '').toLowerCase()); // robots.ts serves /robots.txt
  };
  // A folder's entries, looking inside route groups ((group) adds no segment)
  // and skipping private (_x) and parallel (@x) folders and dynamic segments.
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('_') || e.name.startsWith('@') || e.name.startsWith('[')) continue;
      if (e.isDirectory() && e.name.startsWith('(') && e.name.endsWith(')')) {
        walk(join(dir, e.name));
        continue;
      }
      add(e.name);
    }
  };
  walk(join(root, 'app'));
  walk(join(root, 'app', '[locale]'));
  for (const locale of locales) {
    add(locale);
    walk(join(root, 'app', locale));
  }
  walk(join(root, 'public'));
  return [...names].sort();
}

/**
 * Ship-nothing-unmeant gate: everything in public/ deploys to production
 * verbatim, and internal design mockups + create-next-app boilerplate were
 * found shipping there. CI fails if public/ contains anything not on this
 * explicit allowlist — adding a real asset means adding it here, on purpose,
 * in the same PR. Stdlib only.
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { INDEXNOW_KEY } from './indexnow-urls.mjs';

// embed.js (S13): the ~5KB dependency-free loader that injects the embed
// widget's iframe on a host page - see public/embed.js and
// app/embed/rep-lookup. icons/* (migration S2): the maskable PWA icons
// referenced by app/manifest.ts. apple-touch-icon.png (S8 launch-prep): the
// iOS home-screen icon, root-probed by Safari. All generated from the brand
// mark by scripts/gen-app-icons.mjs. Everything else still ships nothing from
// public/ (the browser favicon lives at app/icon.svg and portraits are
// hotlinked from unitedstates/images).
// walkthrough/{en,es}/step-{1..4}.png (2026-08-01, PR #140): the homepage
// screencast walkthrough's frames — real captures of the real flow, one set
// per locale, rendered by components/HomeScreencast.tsx. Deliberately
// committed (they ship): regenerate against a running dev server when the
// featured corpus moves, and keep the two locales' sets in step. The player
// is unmounted since 2026-09-28 (owner, UX inventory H18: off until the
// UI/UX is settled); the frames stay so it can return as it was.
// <INDEXNOW_KEY>.txt (2026-09-27 audit, SY-19): the IndexNow ownership file,
// served at the site root so search engines can check that the nightly
// ping (scripts/indexnow-ping.mjs) comes from this host. It holds a PUBLIC
// key, by design - see scripts/indexnow-urls.mjs's header. The name comes
// from that module's constant, so rotating the key cannot leave a stale
// file allowed here.
const ALLOWLIST = new Set([
  'embed.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'apple-touch-icon.png',
  `${INDEXNOW_KEY}.txt`,
  ...['en', 'es'].flatMap((locale) =>
    [1, 2, 3, 4].map((step) => `walkthrough/${locale}/step-${step}.png`)
  ),
]);

function walk(dir, prefix = '') {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(full).isDirectory() ? walk(full, rel) : [rel];
  });
}

const files = existsSync('public') ? walk('public') : [];
const unexpected = files.filter((f) => !ALLOWLIST.has(f));

if (unexpected.length) {
  for (const f of unexpected) {
    console.error(
      `::error::public/${f} is not on the allowlist (scripts/check-public-allowlist.mjs). Everything in public/ ships to production — if this file is meant to ship, add it to the allowlist in the same PR.`
    );
  }
  process.exit(1);
}
console.log(
  `public/ allowlist check passed (${files.length} file(s), ${ALLOWLIST.size} allowed)`
);

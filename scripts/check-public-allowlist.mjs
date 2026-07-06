/**
 * Ship-nothing-unmeant gate: everything in public/ deploys to production
 * verbatim, and internal design mockups + create-next-app boilerplate were
 * found shipping there. CI fails if public/ contains anything not on this
 * explicit allowlist — adding a real asset means adding it here, on purpose,
 * in the same PR. Stdlib only.
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// embed.js (S13): the ~5KB dependency-free loader that injects the embed
// widget's iframe on a host page - see public/embed.js and
// app/embed/rep-lookup. icons/* (migration S2): the maskable PWA icons
// referenced by app/manifest.ts, generated from the brand mark by
// scripts/gen-app-icons.mjs. Everything else still ships nothing from
// public/ (the favicon lives at app/icon.svg and portraits are hotlinked
// from unitedstates/images).
const ALLOWLIST = new Set(['embed.js', 'icons/icon-192.png', 'icons/icon-512.png']);

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

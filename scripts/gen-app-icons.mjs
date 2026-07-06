// Generate the maskable PWA app icons referenced by app/manifest.ts
// (/icons/icon-192.png + /icons/icon-512.png) from the locked Oravan lone-O
// mark: a paper mark centered on an ink tile with safe-zone padding.
// Reads the masters in assets/brand/ and recolors them, so there's no path
// duplication here. Re-run with: node scripts/gen-app-icons.mjs
import sharp from 'sharp';
import { readFile, mkdir } from 'node:fs/promises';

const INK = '#2A2318';
const PAPER = '#F3ECDD';

const markMaster = await readFile('assets/brand/oravan-mark.svg', 'utf8');
const paperMark = markMaster.replace(/currentColor/g, PAPER);

await mkdir('public/icons', { recursive: true });

for (const size of [192, 512]) {
  // Mark at 60% of the canvas keeps it inside the maskable safe zone (center 80%).
  const inner = Math.round(size * 0.6);
  const mark = await sharp(Buffer.from(paperMark)).resize(inner, inner).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: INK } })
    .composite([{ input: mark, gravity: 'center' }])
    .png()
    .toFile(`public/icons/icon-${size}.png`);
  console.log(`wrote public/icons/icon-${size}.png`);
}

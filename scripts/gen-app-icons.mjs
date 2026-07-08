// Generate the app icons from the locked Oravan lone-O mark: a paper mark on
// an ink tile. Reads the masters in assets/brand/ and recolors them, so
// there's no path duplication here. Re-run with: node scripts/gen-app-icons.mjs
//   - public/icons/icon-192.png + icon-512.png : maskable PWA icons (app/manifest.ts)
//   - public/apple-touch-icon.png              : iOS home-screen icon (root-probed)
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

// iOS "Add to Home Screen" auto-probes /apple-touch-icon.png and uses it
// directly (no <link> needed). Apple applies its own rounded-corner mask and
// expects an opaque, near-full-bleed square — so the mark sits at 72% (fuller
// than the maskable icons' 60%) with no transparency. 180x180 is Apple's
// current recommended size.
{
  const size = 180;
  const inner = Math.round(size * 0.72);
  const mark = await sharp(Buffer.from(paperMark)).resize(inner, inner).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: INK } })
    .composite([{ input: mark, gravity: 'center' }])
    .removeAlpha() // drop the (all-opaque) alpha channel — Apple wants flat RGB
    .png()
    .toFile('public/apple-touch-icon.png');
  console.log('wrote public/apple-touch-icon.png');
}

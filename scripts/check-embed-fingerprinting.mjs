/**
 * Embed no-fingerprinting/no-analytics static gate (S15). The embed's
 * marquee claim is "collects nothing about your visitors" — the network-
 * trace Playwright tests (tests/embed-loader.spec.ts) already enforce the
 * NETWORK half (zero cookies, zero third-party requests). This gate covers
 * the other half: first-party JS that could still build a cross-site
 * VISITOR FINGERPRINT without ever leaving the embed origin as an obvious
 * "third-party request" (canvas/audio/font/hardware signals), or that pulls
 * in an analytics/tag-manager SDK.
 *
 * Two closed denylists, scanned as literal source-text substrings across
 * every first-party file the embed ships (app/embed/**, components/embed/
 * **, public/embed.js, lib/embed-theme.ts, lib/embed-referrer.ts):
 *
 *   FINGERPRINTING_APIS — canvas readback (toDataURL/getImageData),
 *     canvas-font-metrics (measureText), AudioContext fingerprinting, the
 *     Font Access API / font-enumeration surfaces, WebRTC's
 *     RTCPeerConnection (a classic local-IP-leak vector), and the
 *     hardware/display signals (navigator.plugins/mimeTypes/
 *     hardwareConcurrency/deviceMemory, screen.colorDepth/pixelDepth) most
 *     fingerprinting libraries combine into an entropy vector.
 *   ANALYTICS_IDENTIFIERS — common analytics/tag-manager globals (gtag, the
 *     classic Google Analytics `ga(...)` queue, Facebook Pixel's `fbq`,
 *     Matomo's `_paq`, Mixpanel, Amplitude, Segment's `analytics.js`,
 *     Plausible, Microsoft Clarity, Hotjar).
 *
 * HONEST LIMITS (this is a grep gate, not a behavioral scanner — stated
 * plainly, not oversold): it matches literal source text, so it cannot
 * catch dynamic construction (`window['getImage' + 'Data']`), a
 * renamed/aliased import, or a fingerprinting call introduced through a
 * future dependency's own source. `node_modules` is out of scope by
 * design — this gate scans first-party embed code only, the same surface
 * the ledger asks a code reviewer to be able to trust. It is a tripwire for
 * code review, not a proof of absence; the network-trace Playwright tests
 * remain the enforceable claim for what actually leaves the browser.
 *
 * `--self-test` runs every rule against seeded violation fixtures and exits
 * nonzero if any seeded violation goes undetected — same convention as
 * scripts/check-key-namespaces.mjs (tests/embed-fingerprinting.spec.ts runs
 * both modes).
 *
 * Stdlib only, like the repo's other CI gates.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

const SCAN_DIRS = ['app/embed', 'components/embed'];
const SCAN_FILES = ['public/embed.js', 'lib/embed-theme.ts', 'lib/embed-referrer.ts'];
const EXTENSIONS = ['.ts', '.tsx', '.js'];

const FINGERPRINTING_APIS = [
  'getImageData',
  'toDataURL',
  'measureText',
  'AudioContext',
  'webkitAudioContext',
  'RTCPeerConnection',
  'queryLocalFonts',
  'document.fonts',
  'navigator.plugins',
  'navigator.mimeTypes',
  'navigator.hardwareConcurrency',
  'navigator.deviceMemory',
  'screen.colorDepth',
  'screen.pixelDepth',
];

const ANALYTICS_IDENTIFIERS = [
  'gtag(',
  'fbq(',
  '_paq',
  'mixpanel',
  'amplitude',
  'plausible(',
  'clarity(',
  'hotjar',
  'analytics.js',
  'segment.com',
];

/** Every needle that appears in `text`, as {needle, line} (first occurrence each). */
function findNeedles(text, needles) {
  const hits = [];
  for (const needle of needles) {
    const idx = text.indexOf(needle);
    if (idx === -1) continue;
    const line = text.slice(0, idx).split('\n').length;
    hits.push({ needle, line });
  }
  return hits;
}

/** Scan one file's text, return violations: { rule, file, line, detail }. */
export function scanText(file, text) {
  const violations = [];
  for (const { needle, line } of findNeedles(text, FINGERPRINTING_APIS)) {
    violations.push({
      rule: 'fingerprinting-api',
      file,
      line,
      detail: `fingerprinting-shaped API "${needle}" found in embed code`,
    });
  }
  for (const { needle, line } of findNeedles(text, ANALYTICS_IDENTIFIERS)) {
    violations.push({
      rule: 'analytics-identifier',
      file,
      line,
      detail: `analytics/tag-manager identifier "${needle}" found in embed code`,
    });
  }
  return violations;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (EXTENSIONS.some((e) => full.endsWith(e))) out.push(full);
  }
  return out;
}

function scanRepo() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    const full = join(ROOT, dir);
    if (existsSync(full)) files.push(...walk(full));
  }
  for (const f of SCAN_FILES) {
    const full = join(ROOT, f);
    if (existsSync(full)) files.push(full);
  }
  const violations = [];
  for (const full of files) {
    const rel = relative(ROOT, full).replaceAll('\\', '/');
    violations.push(...scanText(rel, readFileSync(full, 'utf8')));
  }
  return violations;
}

// Seeded violations: every rule must catch its fixture, or the gate is broken.
const SELF_TEST_FIXTURES = [
  {
    name: 'canvas readback (toDataURL)',
    file: 'components/embed/FixtureWidget.tsx',
    text: "const png = canvas.toDataURL('image/png');",
    rule: 'fingerprinting-api',
  },
  {
    name: 'canvas readback (getImageData)',
    file: 'components/embed/FixtureWidget.tsx',
    text: 'const pixels = ctx.getImageData(0, 0, w, h);',
    rule: 'fingerprinting-api',
  },
  {
    name: 'canvas font-metrics probing (measureText)',
    file: 'components/embed/FixtureWidget.tsx',
    text: "const width = ctx.measureText('probe').width;",
    rule: 'fingerprinting-api',
  },
  {
    name: 'AudioContext fingerprinting',
    file: 'components/embed/FixtureWidget.tsx',
    text: 'const ac = new AudioContext();',
    rule: 'fingerprinting-api',
  },
  {
    name: 'font enumeration (document.fonts)',
    file: 'components/embed/FixtureWidget.tsx',
    text: 'const installed = [...document.fonts].length;',
    rule: 'fingerprinting-api',
  },
  {
    name: 'WebRTC local-IP-leak vector (RTCPeerConnection)',
    file: 'app/embed/fixture/page.tsx',
    text: 'const pc = new RTCPeerConnection();',
    rule: 'fingerprinting-api',
  },
  {
    name: 'hardware entropy signal (navigator.hardwareConcurrency)',
    file: 'app/embed/fixture/page.tsx',
    text: 'const cores = navigator.hardwareConcurrency;',
    rule: 'fingerprinting-api',
  },
  {
    name: 'Google Analytics gtag call',
    file: 'public/embed.js',
    text: "gtag('event', 'widget_view');",
    rule: 'analytics-identifier',
  },
  {
    name: 'Facebook Pixel call',
    file: 'app/embed/fixture/page.tsx',
    text: "fbq('track', 'PageView');",
    rule: 'analytics-identifier',
  },
  {
    name: 'Matomo queue reference',
    file: 'public/embed.js',
    text: "_paq.push(['trackPageView']);",
    rule: 'analytics-identifier',
  },
  {
    name: 'Hotjar reference',
    file: 'app/embed/fixture/page.tsx',
    text: 'window.hotjar_id = 123;',
    rule: 'analytics-identifier',
  },
];

// A clean sample must produce zero violations — proves the gate doesn't
// flag ordinary embed code (guards against a gate that flags everything
// and gets ignored).
const SELF_TEST_CLEAN = [
  {
    file: 'components/embed/FixtureWidget.tsx',
    text: "const el = document.querySelector('.re-card');\nel.style.color = 'red';\nconst count = reps.length;",
  },
];

function selfTest() {
  let failed = false;
  for (const fixture of SELF_TEST_FIXTURES) {
    const hits = scanText(fixture.file, fixture.text);
    if (!hits.some((v) => v.rule === fixture.rule)) {
      console.error(`::error::self-test: seeded violation NOT caught: ${fixture.name} (expected rule "${fixture.rule}")`);
      failed = true;
    }
  }
  for (const sample of SELF_TEST_CLEAN) {
    const hits = scanText(sample.file, sample.text);
    if (hits.length > 0) {
      console.error(`::error::self-test: clean sample false-positived in ${sample.file}: ${hits[0].rule} — ${hits[0].detail}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(
    `embed-fingerprinting gate self-test: all ${SELF_TEST_FIXTURES.length} seeded violations caught, ${SELF_TEST_CLEAN.length} clean sample(s) pass`
  );
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  const violations = scanRepo();
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`::error file=${v.file},line=${v.line}::[${v.rule}] ${v.detail}`);
    }
    process.exit(1);
  }
  console.log(
    'embed fingerprinting/analytics gate clean: no known fingerprinting-shaped API or analytics identifier found in first-party embed code'
  );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main();
}

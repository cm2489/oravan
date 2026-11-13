import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import legislators from '../data/legislators.json';
import thumbs from '../data/portrait-thumbs.json';
import missing from '../data/portrait-missing.json';
import {
  THUMB_HEIGHT,
  THUMB_WIDTH,
  encodeThumb,
  runThumbs,
  serializeThumbs,
  sourceUrl,
} from '../scripts/portrait-thumbs.mjs';
import { PORTRAIT_DATA_PREFIX, inlinePortrait, portraitsFor, withPortraits } from '../lib/member-portraits';
import { membersFor } from '../lib/members';

/*
 * The members page's inline pictures (owner, 2026-11-12): the nightly script
 * that cuts them (scripts/portrait-thumbs.mjs) and the server reader that puts
 * them in the lookup's answer (lib/member-portraits.ts). No network: the
 * script's fetch is injected, and the image it encodes is generated here.
 */

const THUMBS = thumbs as Record<string, string>;
const ROSTER = legislators as { bioguide: string }[];

/** A 450 x 550 JPEG like the source's, with a gradient so the picture is not one colour. */
async function fakePortrait(): Promise<Buffer> {
  const w = 450;
  const h = 550;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      raw[i] = x % 256;
      raw[i + 1] = y % 256;
      raw[i + 2] = (x + y) % 256;
    }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer();
}

function okResponse(bytes: Buffer) {
  return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
}

test.describe('scripts/portrait-thumbs.mjs', () => {
  test('encodeThumb cuts the picture to the card frame at three times its size, in WebP', async () => {
    const b64 = await encodeThumb(sharp, await fakePortrait());
    const meta = await sharp(Buffer.from(b64, 'base64')).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([THUMB_WIDTH, THUMB_HEIGHT]);
    expect([THUMB_WIDTH, THUMB_HEIGHT]).toEqual([72 * 3, 88 * 3]);
  });

  test('a run adds new members, keeps the ones it has, drops the departed, skips the known-missing, and survives failures', async () => {
    const now = new Date('2026-11-12T12:00:00Z');
    const asked: string[] = [];
    const errors: string[] = [];
    const out = await runThumbs({
      legislators: [
        { bioguide: 'A000001' }, // new: fetched
        { bioguide: 'B000002' }, // already in the file: kept, not fetched
        { bioguide: 'C000003' }, // 404 upstream: left out
        { bioguide: 'D000004' }, // known missing, checked yesterday: not asked
        { bioguide: 'E000005' }, // the fetch throws: left out, the run goes on
        { bioguide: 'not-an-id' },
      ],
      thumbs: { B000002: 'kept', Z000009: 'departed' },
      missing: { D000004: { firstMissing: '2026-10-01', lastChecked: '2026-11-11' } },
      fetchImpl: async (url: string) => {
        asked.push(url);
        if (url.includes('C000003')) return { ok: false, status: 404 };
        if (url.includes('E000005')) throw new Error('network down');
        return okResponse(Buffer.from('jpeg'));
      },
      encode: async () => 'encoded',
      now,
      log: () => {},
      error: (m: string) => errors.push(m),
    });
    expect(out.thumbs).toEqual({ A000001: 'encoded', B000002: 'kept' });
    expect(Object.keys(out.thumbs)).toEqual(['A000001', 'B000002']);
    expect(asked.sort()).toEqual([sourceUrl('A000001'), sourceUrl('C000003'), sourceUrl('E000005')].sort());
    expect({ added: out.added, kept: out.kept, dropped: out.dropped, knownMissing: out.knownMissing, failed: out.failed }).toEqual({
      added: 1,
      kept: 1,
      dropped: 1,
      knownMissing: 1,
      failed: 2,
    });
    expect(errors.join('\n')).toContain('C000003 source fetch failed (status 404)');
    expect(errors.join('\n')).toContain('E000005 failed - network down');
  });

  test('a known-missing member is asked again once the re-check comes round', async () => {
    const asked: string[] = [];
    await runThumbs({
      legislators: [{ bioguide: 'D000004' }],
      thumbs: {},
      missing: { D000004: { firstMissing: '2026-09-01', lastChecked: '2026-09-01' } },
      fetchImpl: async (url: string) => {
        asked.push(url);
        return { ok: false, status: 404 };
      },
      encode: async () => 'x',
      now: new Date('2026-11-12T12:00:00Z'),
      log: () => {},
      error: () => {},
    });
    expect(asked).toEqual([sourceUrl('D000004')]);
  });

  test('the file is one member per line, sorted, and parses back', () => {
    const text = serializeThumbs({ B000002: 'bb', A000001: 'aa' });
    expect(text).toBe('{\n  "A000001": "aa",\n  "B000002": "bb"\n}\n');
    expect(JSON.parse(text)).toEqual({ A000001: 'aa', B000002: 'bb' });
    expect(serializeThumbs({})).toBe('{}\n');
  });
});

test.describe('data/portrait-thumbs.json', () => {
  test('is written the way the script writes it', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('data/portrait-thumbs.json', 'utf8')).toBe(serializeThumbs(THUMBS));
  });

  test('every picture is a 216 x 264 WebP', async () => {
    for (const [bioguide, b64] of Object.entries(THUMBS)) {
      expect(bioguide).toMatch(/^[A-Z]\d{6}$/);
      const meta = await sharp(Buffer.from(b64, 'base64')).metadata();
      expect([meta.format, meta.width, meta.height], bioguide).toEqual(['webp', THUMB_WIDTH, THUMB_HEIGHT]);
    }
  });

  test('covers the roster: every sitting member has a picture or is known to have none upstream', () => {
    // A member added to the roster since the last nightly run may be missing
    // for a night (the card shows the initials), so this allows a few.
    const without = ROSTER.filter((l) => !THUMBS[l.bioguide] && !(l.bioguide in (missing as Record<string, unknown>)));
    expect(without.map((l) => l.bioguide).length, without.map((l) => l.bioguide).join(', ')).toBeLessThanOrEqual(5);
    expect(Object.keys(THUMBS).length).toBeGreaterThan(ROSTER.length * 0.9);
  });
});

test.describe('lib/member-portraits.ts', () => {
  test('a member with a picture gets a data: address; one without gets null', () => {
    const withPicture = Object.keys(THUMBS)[0];
    expect(inlinePortrait(withPicture)).toBe(`${PORTRAIT_DATA_PREFIX}${THUMBS[withPicture]}`);
    const noPicture = Object.keys(missing as Record<string, unknown>).find((b) => !THUMBS[b]);
    expect(noPicture, 'data/portrait-missing.json names a member with no picture').toBeTruthy();
    expect(inlinePortrait(noPicture!)).toBeNull();
    expect(inlinePortrait('Z999999')).toBeNull();
    expect(inlinePortrait('__proto__')).toBeNull();
  });

  test('the answer carries each member it shows once, and nothing else', () => {
    const split = membersFor('91711')!;
    expect(split.districts.length).toBeGreaterThan(1);
    const portraits = portraitsFor(split);
    const shown = new Set(split.districts.flatMap((d) => d.reps.map((r) => r.bioguide)));
    expect(Object.keys(portraits).sort()).toEqual([...shown].filter((b) => THUMBS[b]).sort());
    for (const src of Object.values(portraits)) expect(src.startsWith(PORTRAIT_DATA_PREFIX)).toBe(true);
  });

  test('plain for a page, a promise for a lookup made with JavaScript; nothing for no members', async () => {
    const plain = withPortraits(membersFor('78501'))!;
    expect(plain.portraits).toEqual(portraitsFor(membersFor('78501')!));
    // Survives the page's JSON round trip (the no-JavaScript answer).
    expect(JSON.parse(JSON.stringify(plain))).toEqual(plain);

    const later = withPortraits(membersFor('78501'), true)!;
    expect(later.portraits).toBeInstanceOf(Promise);
    expect(await later.portraits).toEqual(plain.portraits);

    expect(withPortraits(null)).toBeNull();
    const none = withPortraits(membersFor('00000'))!;
    expect(none.portraits).toBeUndefined();
    expect(membersFor('78501')!.portraits).toBeUndefined(); // membersFor itself stays picture-free
  });
});

import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readSwf, swfExports, swfFonts, swfImports, swfTagCounts, SwfTagCode } from './swf.ts';

const text = (value: string): number[] => [...new TextEncoder().encode(value), 0];
const u16 = (value: number): number[] => [value & 0xff, value >> 8];
const u32 = (value: number): number[] => [
  value & 0xff,
  (value >> 8) & 0xff,
  (value >> 16) & 0xff,
  (value >>> 24) & 0xff,
];

/** A tag: short header, or long when asked or when the body is 63 bytes or more. */
function tag(code: number, body: number[], long = false): number[] {
  if (!long && body.length < 0x3f) return [...u16((code << 6) | body.length), ...body];
  return [...u16((code << 6) | 0x3f), ...u32(body.length), ...body];
}

/** `count` bits of a value, the highest first. */
const bitsOf = (value: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => Math.floor(value / 2 ** (count - 1 - i)) % 2);

/** A RECT of 0..1280 × 0..720 pixels in twips: 16-bit signed fields. */
function rect(): number[] {
  const bits = [
    ...bitsOf(16, 5),
    ...bitsOf(0, 16),
    ...bitsOf(25600, 16),
    ...bitsOf(0, 16),
    ...bitsOf(14400, 16),
  ];
  while (bits.length % 8 !== 0) bits.push(0);
  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    bytes.push(bits.slice(i, i + 8).reduce((byte, bit) => byte * 2 + bit, 0));
  }
  return bytes;
}

function movie(signature: 'FWS' | 'CWS' | 'CFX'): Uint8Array {
  const body = [
    ...rect(),
    ...u16(30 << 8),
    ...u16(1),
    ...tag(SwfTagCode.exportAssets, [
      ...u16(2),
      ...u16(5),
      ...text('Z.png'),
      ...u16(6),
      ...text('Arrow'),
    ]),
    ...tag(SwfTagCode.importAssets2, [
      ...text('gfxfontlib.swf'),
      1,
      0,
      ...u16(1),
      ...u16(7),
      ...text('$EverywhereMediumFont'),
    ]),
    // DefineFont3: id, flags (bold), language, name, 3 glyphs (rest left out).
    ...tag(SwfTagCode.defineFont3, [
      ...u16(8),
      0x01,
      1,
      16,
      ...new TextEncoder().encode('Futura Condensed'),
      ...u16(3),
    ]),
    // A sprite holding a long-header tag and its own end.
    ...tag(SwfTagCode.defineSprite, [
      ...u16(9),
      ...u16(1),
      ...tag(SwfTagCode.doAction, [0], true),
      ...tag(SwfTagCode.end, []),
    ]),
    ...tag(SwfTagCode.gfxExporterInfo, [1, 2, 3]),
    ...tag(SwfTagCode.showFrame, []),
    ...tag(SwfTagCode.end, []),
  ];
  const length = 8 + body.length;
  const head = [
    ...Array.from({ length: 3 }, (_, i) => signature.charCodeAt(i)),
    15,
    ...u32(length),
  ];
  if (signature === 'FWS') return Uint8Array.from([...head, ...body]);
  return Uint8Array.from([...head, ...deflateSync(Uint8Array.from(body))]);
}

describe('readSwf', () => {
  it('reads the header and the stage', () => {
    const { header } = readSwf(movie('FWS'));
    expect(header).toMatchObject({ signature: 'FWS', version: 15, compressed: false, gfx: false });
    expect(header.frameSize).toEqual({ xMin: 0, xMax: 25600, yMin: 0, yMax: 14400 });
    expect(header.frameRate).toBe(30);
    expect(header.frameCount).toBe(1);
  });

  it('inflates zlib movies, Flash and Scaleform alike', () => {
    const plain = readSwf(movie('FWS'));
    for (const signature of ['CWS', 'CFX'] as const) {
      const compressed = readSwf(movie(signature));
      expect(compressed.header.compressed).toBe(true);
      expect(compressed.header.gfx).toBe(signature === 'CFX');
      expect(compressed.bytes.subarray(8)).toEqual(plain.bytes.subarray(8));
    }
  });

  it('lists tags, a sprite holding its own', () => {
    const swf = readSwf(movie('FWS'));
    expect(swf.tags.map((t) => t.code)).toEqual([
      SwfTagCode.exportAssets,
      SwfTagCode.importAssets2,
      SwfTagCode.defineFont3,
      SwfTagCode.defineSprite,
      SwfTagCode.gfxExporterInfo,
      SwfTagCode.showFrame,
      SwfTagCode.end,
    ]);
    const sprite = swf.tags[3];
    expect(sprite?.children?.map((t) => t.code)).toEqual([SwfTagCode.doAction, SwfTagCode.end]);
    expect(swfTagCounts(swf).get('doAction')).toBe(1);
  });

  it('reads exports, imports and fonts', () => {
    const swf = readSwf(movie('FWS'));
    expect(swfExports(swf)).toEqual([
      { id: 5, name: 'Z.png' },
      { id: 6, name: 'Arrow' },
    ]);
    expect(swfImports(swf)).toEqual([
      { url: 'gfxfontlib.swf', symbols: [{ id: 7, name: '$EverywhereMediumFont' }] },
    ]);
    expect(swfFonts(swf)).toEqual([
      { id: 8, name: 'Futura Condensed', bold: true, italic: false, glyphs: 3, code: 75 },
    ]);
  });

  it('rejects what is not a movie, and a tag running past the end', () => {
    expect(() => readSwf(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a SWF/);
    const broken = movie('FWS').slice(0, -6);
    expect(() => readSwf(broken)).toThrow();
  });
});

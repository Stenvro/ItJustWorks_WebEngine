import { describe, expect, it } from 'vitest';
import { buildFrame, literalBlock, literalFrame } from '../../../tests/helpers/lz4-frame.ts';
import { FormatError } from '../binary-reader.ts';
import { decodeLz4Block, decompressLz4Frame } from './lz4.ts';

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function decodeBlock(block: number[], outputSize: number): Uint8Array {
  const src = Uint8Array.from(block);
  const dst = new Uint8Array(outputSize);
  const end = decodeLz4Block(src, 0, src.length, dst, 0);
  expect(end).toBe(outputSize);
  return dst;
}

describe('decodeLz4Block', () => {
  it('kopieert literals en een match', () => {
    // 3 literals "abc", dan match offset 3, lengte 9
    expect(text(decodeBlock([0x35, ...ascii('abc'), 3, 0], 12))).toBe('abcabcabcabc');
  });

  it('herhaalt een patroon bij overlappende matches', () => {
    expect(text(decodeBlock([0x16, ...ascii('a'), 1, 0], 11))).toBe('a'.repeat(11));
  });

  it('leest verlengde literal- en matchlengtes', () => {
    const literals = Array.from({ length: 20 }, (_, i) => 65 + i);
    expect([...decodeBlock([0xf0, 5, ...literals], 20)]).toEqual(literals);
    // match 15 + 255 + 1 + 4 = 275
    expect(text(decodeBlock([0x1f, ...ascii('x'), 1, 0, 255, 1], 276))).toBe('x'.repeat(276));
  });

  it('kopieert lange niet-overlappende matches', () => {
    const literals = Array.from({ length: 40 }, (_, i) => i);
    const out = decodeBlock([0xff, 25, ...literals, 40, 0, 21], 80);
    expect([...out]).toEqual([...literals, ...literals]);
  });

  it.each([
    ['offset 0', [0x10, 0x61, 0, 0]],
    ['offset voor het begin', [0x10, 0x61, 2, 0]],
    ['afgebroken offset', [0x10, 0x61, 1]],
    ['literals voorbij het einde', [0x50, 0x61]],
  ])('gooit FormatError bij %s', (_, block) => {
    const src = Uint8Array.from(block);
    expect(() => decodeLz4Block(src, 0, src.length, new Uint8Array(64), 0)).toThrow(FormatError);
  });

  it('gooit als de uitvoer niet past', () => {
    const src = Uint8Array.from([0x16, 0x61, 1, 0]);
    expect(() => decodeLz4Block(src, 0, src.length, new Uint8Array(5), 0)).toThrow(/groter/);
  });
});

describe('decompressLz4Frame', () => {
  const sample = ascii('Skyrim belongs to the Nords! '.repeat(5000));

  it('decomprimeert een literal-only frame over meerdere blocks met checksum', () => {
    const frame = literalFrame(sample);
    expect(decompressLz4Frame(frame, sample.length, { verifyChecksums: true })).toEqual(sample);
  });

  it('ondersteunt opgeslagen blocks, contentgrootte en block-checksums', () => {
    const data = ascii('hello world');
    const frame = buildFrame([{ data, stored: true }], {
      blockChecksum: true,
      contentSize: data.length,
      contentChecksumOf: data,
    });
    expect(text(decompressLz4Frame(frame, data.length, { verifyChecksums: true }))).toBe(
      'hello world',
    );
  });

  it('laat matches verwijzen naar eerdere blocks bij gekoppelde blocks', () => {
    const blocks = [{ data: literalBlock(ascii('abcd')) }, { data: Uint8Array.of(0x00, 4, 0) }];
    const linked = buildFrame(blocks, { independentBlocks: false });
    expect(text(decompressLz4Frame(linked, 8))).toBe('abcdabcd');

    const independent = buildFrame(blocks, { independentBlocks: true });
    expect(() => decompressLz4Frame(independent, 8)).toThrow(/match-offset/);
  });

  it('leest aaneengesloten frames en slaat skippable frames over', () => {
    const skippable = Uint8Array.of(0x50, 0x2a, 0x4d, 0x18, 2, 0, 0, 0, 0xaa, 0xbb);
    const input = Uint8Array.from([
      ...literalFrame(ascii('foo')),
      ...skippable,
      ...literalFrame(ascii('bar')),
    ]);
    expect(text(decompressLz4Frame(input, 6))).toBe('foobar');
  });

  it('gooit bij een verkeerde magic, header-checksum of uitvoergrootte', () => {
    const frame = literalFrame(ascii('foo'));
    const badMagic = frame.slice();
    badMagic[0] = 0;
    expect(() => decompressLz4Frame(badMagic, 3)).toThrow(/magic/);

    const badChecksum = frame.slice();
    badChecksum[6] = (badChecksum[6] ?? 0) ^ 0xff;
    expect(() => decompressLz4Frame(badChecksum, 3)).toThrow(/header-checksum/);

    expect(() => decompressLz4Frame(frame, 4)).toThrow(/3 bytes gedecomprimeerd, 4 verwacht/);
  });

  it('gooit bij een verkeerde content-checksum als verificatie aan staat', () => {
    const frame = literalFrame(ascii('foo'));
    frame[frame.length - 1] = (frame[frame.length - 1] ?? 0) ^ 0xff;
    expect(() => decompressLz4Frame(frame, 3, { verifyChecksums: true })).toThrow(/content/);
    expect(text(decompressLz4Frame(frame, 3))).toBe('foo');
  });
});

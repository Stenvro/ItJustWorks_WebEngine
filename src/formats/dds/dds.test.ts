import { describe, expect, it } from 'vitest';
import { FormatError } from '../binary-reader.ts';
import { parseDds } from './dds.ts';

interface HeaderOptions {
  readonly width: number;
  readonly height: number;
  readonly mips?: number;
  readonly fourCC?: string;
  readonly rgb?: { bits: number; masks: [number, number, number, number]; alpha?: boolean };
  readonly cubemap?: boolean;
  readonly dx10?: { dxgi: number; arraySize?: number; cube?: boolean };
}

/** Builds a DDS header (plus DX10 header if requested) followed by `data`. */
function dds(options: HeaderOptions, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(128 + (options.dx10 ? 20 : 0));
  const view = new DataView(header.buffer);
  header.set(new TextEncoder().encode('DDS '));
  view.setUint32(4, 124, true);
  view.setUint32(8, 0x1007 | (options.mips ? 0x20000 : 0), true);
  view.setUint32(12, options.height, true);
  view.setUint32(16, options.width, true);
  view.setUint32(28, options.mips ?? 0, true);
  view.setUint32(76, 32, true);
  const code = options.dx10 ? 'DX10' : options.fourCC;
  if (code) {
    view.setUint32(80, 0x4, true);
    header.set(new TextEncoder().encode(code), 84);
  } else if (options.rgb) {
    view.setUint32(80, 0x40 | (options.rgb.alpha ? 0x1 : 0), true);
    view.setUint32(88, options.rgb.bits, true);
    options.rgb.masks.forEach((mask, i) => {
      view.setUint32(92 + i * 4, mask, true);
    });
  }
  view.setUint32(112, options.cubemap ? 0x200 : 0, true);
  if (options.dx10) {
    view.setUint32(128, options.dx10.dxgi, true);
    view.setUint32(132, 3, true);
    view.setUint32(136, options.dx10.cube ? 0x4 : 0, true);
    view.setUint32(140, options.dx10.arraySize ?? 1, true);
  }
  return Uint8Array.from([...header, ...data]);
}

const filled = (length: number, value = 0xab): Uint8Array => new Uint8Array(length).fill(value);

describe('parseDds', () => {
  it('reads a DXT1 texture with its mip chain', () => {
    // 8x8: mips 8x8 (4 blocks), 4x4 (1), 2x2 (1), 1x1 (1); 8 bytes per block
    const texture = parseDds(dds({ width: 8, height: 8, mips: 4, fourCC: 'DXT1' }, filled(56)));
    expect(texture.format).toBe('bc1-rgba-unorm');
    expect(texture.mipCount).toBe(4);
    expect(texture.levels.map((l) => [l.width, l.size, l.bytesPerRow, l.rows])).toEqual([
      [8, 32, 16, 2],
      [4, 8, 8, 1],
      [2, 8, 8, 1],
      [1, 8, 8, 1],
    ]);
    expect(texture.data.length).toBe(56);
  });

  it('reads cubemaps as six layers', () => {
    const texture = parseDds(
      dds({ width: 4, height: 4, fourCC: 'DXT5', cubemap: true }, filled(96)),
    );
    expect(texture.cubemap).toBe(true);
    expect(texture.layerCount).toBe(6);
    expect(texture.levels.map((l) => l.offset)).toEqual([0, 16, 32, 48, 64, 80]);
  });

  it('reads DX10 headers, including sRGB', () => {
    const texture = parseDds(dds({ width: 4, height: 4, dx10: { dxgi: 99 } }, filled(16)));
    expect(texture.format).toBe('bc7-rgba-unorm');
    expect(texture.srgb).toBe(true);
  });

  it('keeps 32-bit BGRA as-is and converts other layouts to RGBA8', () => {
    const bgra = parseDds(
      dds(
        {
          width: 1,
          height: 1,
          rgb: { bits: 32, masks: [0xff0000, 0xff00, 0xff, 0xff000000], alpha: true },
        },
        Uint8Array.of(1, 2, 3, 4),
      ),
    );
    expect(bgra.format).toBe('bgra8unorm');
    expect([...bgra.data]).toEqual([1, 2, 3, 4]);

    // 24-bit BGR without alpha → RGBA8 with alpha 255
    const rgb = parseDds(
      dds(
        { width: 2, height: 1, rgb: { bits: 24, masks: [0xff0000, 0xff00, 0xff, 0] } },
        Uint8Array.of(10, 20, 30, 40, 50, 60),
      ),
    );
    expect(rgb.format).toBe('rgba8unorm');
    expect([...rgb.data]).toEqual([30, 20, 10, 255, 60, 50, 40, 255]);

    // 16-bit 5:6:5 scales each channel to 0-255
    const rgb565 = parseDds(
      dds(
        { width: 1, height: 1, rgb: { bits: 16, masks: [0xf800, 0x7e0, 0x1f, 0] } },
        Uint8Array.of(0xff, 0xff),
      ),
    );
    expect([...rgb565.data]).toEqual([255, 255, 255, 255]);
  });

  it('keeps the complete mips of a truncated file', () => {
    const texture = parseDds(dds({ width: 8, height: 8, mips: 4, fourCC: 'DXT1' }, filled(40)));
    expect(texture.mipCount).toBe(2);
    expect(texture.levels).toHaveLength(2);
  });

  it('rejects other files and missing base levels', () => {
    expect(() => parseDds(new TextEncoder().encode('NOPE'.repeat(40)))).toThrow(/Not a DDS/);
    expect(() => parseDds(dds({ width: 8, height: 8, fourCC: 'DXT1' }, filled(8)))).toThrow(
      FormatError,
    );
    expect(() => parseDds(dds({ width: 4, height: 4, fourCC: 'XXXX' }, filled(8)))).toThrow(
      /FourCC/,
    );
  });
});

// DDS textures. Block-compressed formats go to the GPU as-is; the few uncompressed
// legacy layouts are converted to RGBA8. Format: docs/formats/dds.md

import { BinaryReader, FormatError } from '../binary-reader.ts';

/** Texture formats, named after their WebGPU equivalents. */
export type DdsFormat =
  | 'bc1-rgba-unorm'
  | 'bc2-rgba-unorm'
  | 'bc3-rgba-unorm'
  | 'bc4-r-unorm'
  | 'bc4-r-snorm'
  | 'bc5-rg-unorm'
  | 'bc5-rg-snorm'
  | 'bc6h-rgb-ufloat'
  | 'bc6h-rgb-float'
  | 'bc7-rgba-unorm'
  | 'rgba8unorm'
  | 'bgra8unorm'
  | 'r8unorm'
  | 'rg8unorm';

export interface DdsLevel {
  /** Array layer (cubemap face or array slice). */
  readonly layer: number;
  readonly mip: number;
  readonly width: number;
  readonly height: number;
  /** Offset and size within `DdsTexture.data`. */
  readonly offset: number;
  readonly size: number;
  readonly bytesPerRow: number;
  /** Rows of blocks (compressed) or pixels. */
  readonly rows: number;
}

export interface DdsTexture {
  readonly format: DdsFormat;
  /** The file asks for sRGB sampling (DX10 *_SRGB formats). */
  readonly srgb: boolean;
  readonly width: number;
  readonly height: number;
  readonly mipCount: number;
  /** 6 for cubemaps, otherwise the array size (usually 1). */
  readonly layerCount: number;
  readonly cubemap: boolean;
  /** Layer-major: all mips of layer 0, then layer 1, ... */
  readonly levels: readonly DdsLevel[];
  readonly data: Uint8Array;
}

const DDSD_MIPMAPCOUNT = 0x20000;
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;
const DDPF_LUMINANCE = 0x20000;
const DDSCAPS2_CUBEMAP = 0x200;
const DDS_RESOURCE_MISC_TEXTURECUBE = 0x4;
const HEADER_SIZE = 128;

interface FormatInfo {
  readonly format: DdsFormat;
  /** Bytes per 4x4 block, or 0 for uncompressed formats. */
  readonly blockBytes: number;
  /** Bytes per pixel for uncompressed formats. */
  readonly pixelBytes: number;
  readonly srgb: boolean;
}

const compressed = (format: DdsFormat, blockBytes: number, srgb = false): FormatInfo => ({
  format,
  blockBytes,
  pixelBytes: 0,
  srgb,
});
const uncompressed = (format: DdsFormat, pixelBytes: number, srgb = false): FormatInfo => ({
  format,
  blockBytes: 0,
  pixelBytes,
  srgb,
});

const FOURCC_FORMATS: Readonly<Record<string, FormatInfo>> = {
  DXT1: compressed('bc1-rgba-unorm', 8),
  DXT2: compressed('bc2-rgba-unorm', 16),
  DXT3: compressed('bc2-rgba-unorm', 16),
  DXT4: compressed('bc3-rgba-unorm', 16),
  DXT5: compressed('bc3-rgba-unorm', 16),
  ATI1: compressed('bc4-r-unorm', 8),
  BC4U: compressed('bc4-r-unorm', 8),
  BC4S: compressed('bc4-r-snorm', 8),
  ATI2: compressed('bc5-rg-unorm', 16),
  BC5U: compressed('bc5-rg-unorm', 16),
  BC5S: compressed('bc5-rg-snorm', 16),
};

/** DXGI_FORMAT values found in DX10 headers. */
const DXGI_FORMATS: Readonly<Record<number, FormatInfo>> = {
  28: uncompressed('rgba8unorm', 4),
  29: uncompressed('rgba8unorm', 4, true),
  49: uncompressed('rg8unorm', 2),
  61: uncompressed('r8unorm', 1),
  71: compressed('bc1-rgba-unorm', 8),
  72: compressed('bc1-rgba-unorm', 8, true),
  74: compressed('bc2-rgba-unorm', 16),
  75: compressed('bc2-rgba-unorm', 16, true),
  77: compressed('bc3-rgba-unorm', 16),
  78: compressed('bc3-rgba-unorm', 16, true),
  80: compressed('bc4-r-unorm', 8),
  81: compressed('bc4-r-snorm', 8),
  83: compressed('bc5-rg-unorm', 16),
  84: compressed('bc5-rg-snorm', 16),
  87: uncompressed('bgra8unorm', 4),
  88: uncompressed('bgra8unorm', 4), // B8G8R8X8: alpha ignored by the shaders
  91: uncompressed('bgra8unorm', 4, true),
  95: compressed('bc6h-rgb-ufloat', 16),
  96: compressed('bc6h-rgb-float', 16),
  98: compressed('bc7-rgba-unorm', 16),
  99: compressed('bc7-rgba-unorm', 16, true),
};

/** Legacy uncompressed layout that needs per-pixel conversion to RGBA8. */
interface MaskedLayout {
  readonly bytes: number;
  readonly masks: readonly [number, number, number, number];
  readonly luminance: boolean;
}

function fourCCString(value: number): string {
  return String.fromCharCode(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    value >>> 24,
  );
}

function levelSize(
  info: FormatInfo | MaskedLayout,
  width: number,
  height: number,
): [number, number] {
  if ('blockBytes' in info && info.blockBytes > 0) {
    const bytesPerRow = Math.max(1, Math.ceil(width / 4)) * info.blockBytes;
    return [bytesPerRow, Math.max(1, Math.ceil(height / 4))];
  }
  const pixelBytes = 'pixelBytes' in info ? info.pixelBytes : info.bytes;
  return [width * pixelBytes, height];
}

/** Extracts a channel with an arbitrary bit mask and scales it to 0-255. */
function channel(pixel: number, mask: number): number {
  if (mask === 0) return 255;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  const max = mask >>> shift;
  return Math.round((((pixel & mask) >>> shift) * 255) / max);
}

function convertMasked(source: Uint8Array, layout: MaskedLayout, pixelCount: number): Uint8Array {
  const out = new Uint8Array(pixelCount * 4);
  const [r, g, b, a] = layout.masks;
  for (let i = 0; i < pixelCount; i++) {
    let pixel = 0;
    for (let byte = 0; byte < layout.bytes; byte++) {
      pixel |= (source[i * layout.bytes + byte] ?? 0) << (8 * byte);
    }
    pixel >>>= 0;
    const red = channel(pixel, r);
    out[i * 4] = red;
    out[i * 4 + 1] = layout.luminance ? red : channel(pixel, g);
    out[i * 4 + 2] = layout.luminance ? red : channel(pixel, b);
    out[i * 4 + 3] = channel(pixel, a);
  }
  return out;
}

export function parseDds(bytes: Uint8Array): DdsTexture {
  const reader = new BinaryReader(bytes);
  if (reader.fourCC() !== 'DDS ') throw new FormatError('Not a DDS file', 0);
  if (reader.u32() !== 124) throw new FormatError('Invalid DDS header size', 4);
  const flags = reader.u32();
  const height = reader.u32();
  const width = reader.u32();
  reader.skip(8); // pitch/linear size, depth
  const declaredMips = reader.u32();
  reader.skip(44); // reserved
  reader.skip(4); // pixel format size
  const pixelFlags = reader.u32();
  const fourCC = reader.u32();
  const rgbBitCount = reader.u32();
  const masks: [number, number, number, number] = [
    reader.u32(),
    reader.u32(),
    reader.u32(),
    reader.u32(),
  ];
  reader.skip(4); // caps
  const caps2 = reader.u32();
  reader.seek(HEADER_SIZE);

  if (width === 0 || height === 0) throw new FormatError(`Invalid size ${width}x${height}`, 12);

  let info: FormatInfo | undefined;
  let masked: MaskedLayout | undefined;
  let cubemap = (caps2 & DDSCAPS2_CUBEMAP) !== 0;
  let arraySize = 1;

  if (pixelFlags & DDPF_FOURCC) {
    const code = fourCCString(fourCC);
    if (code === 'DX10') {
      const dxgi = reader.u32();
      reader.u32(); // resource dimension
      const misc = reader.u32();
      arraySize = Math.max(1, reader.u32());
      reader.u32(); // misc flags 2
      info = DXGI_FORMATS[dxgi];
      if (!info) throw new FormatError(`Unsupported DXGI format ${dxgi}`, 128);
      if (misc & DDS_RESOURCE_MISC_TEXTURECUBE) cubemap = true;
    } else {
      info = FOURCC_FORMATS[code];
      if (!info) throw new FormatError(`Unsupported DDS FourCC ${JSON.stringify(code)}`, 84);
    }
  } else if (pixelFlags & (DDPF_RGB | DDPF_LUMINANCE)) {
    const alpha = (pixelFlags & DDPF_ALPHAPIXELS) !== 0;
    const [r, g, b, a] = masks;
    if (
      rgbBitCount === 32 &&
      r === 0xff0000 &&
      g === 0xff00 &&
      b === 0xff &&
      (a === 0xff000000 || !alpha)
    ) {
      info = uncompressed('bgra8unorm', 4);
    } else if (rgbBitCount === 32 && r === 0xff && g === 0xff00 && b === 0xff0000) {
      info = uncompressed('rgba8unorm', 4);
    } else if (rgbBitCount % 8 === 0 && rgbBitCount <= 32) {
      masked = {
        bytes: rgbBitCount / 8,
        masks: [r, g, b, alpha ? a : 0],
        luminance: (pixelFlags & DDPF_LUMINANCE) !== 0,
      };
    } else {
      throw new FormatError(`Unsupported uncompressed DDS layout (${rgbBitCount} bits)`, 88);
    }
  } else {
    throw new FormatError(`Unsupported DDS pixel format flags 0x${pixelFlags.toString(16)}`, 80);
  }

  const layout = info ?? masked;
  if (!layout) throw new FormatError('Unknown DDS layout', 80);
  const layerCount = (cubemap ? 6 : 1) * arraySize;
  const mipCount = flags & DDSD_MIPMAPCOUNT ? Math.max(1, declaredMips) : 1;
  const dataStart = reader.offset;

  // Plan the levels as stored. A file may end early: keep the complete mips only.
  const stored: {
    layer: number;
    mip: number;
    width: number;
    height: number;
    offset: number;
    size: number;
    bytesPerRow: number;
    rows: number;
  }[] = [];
  let offset = dataStart;
  let availableMips = mipCount;
  for (let layer = 0; layer < layerCount; layer++) {
    for (let mip = 0; mip < mipCount; mip++) {
      const w = Math.max(1, width >>> mip);
      const h = Math.max(1, height >>> mip);
      const [bytesPerRow, rows] = levelSize(layout, w, h);
      const size = bytesPerRow * rows;
      if (offset + size > bytes.length) {
        if (layer === 0 && mip > 0) {
          availableMips = mip;
          break;
        }
        throw new FormatError(`DDS data ends inside layer ${layer} mip ${mip}`, offset);
      }
      stored.push({ layer, mip, width: w, height: h, offset, size, bytesPerRow, rows });
      offset += size;
    }
    if (availableMips < mipCount) {
      if (layerCount > 1) throw new FormatError('DDS array or cubemap with missing mips', offset);
      break;
    }
  }

  if (masked) {
    // Convert to RGBA8 level by level.
    const converted = stored.map((level) => ({
      level,
      pixels: convertMasked(
        bytes.subarray(level.offset, level.offset + level.size),
        masked,
        level.width * level.height,
      ),
    }));
    const total = converted.reduce((sum, c) => sum + c.pixels.length, 0);
    const data = new Uint8Array(total);
    let position = 0;
    const levels = converted.map(({ level, pixels }) => {
      data.set(pixels, position);
      const result: DdsLevel = {
        ...level,
        offset: position,
        size: pixels.length,
        bytesPerRow: level.width * 4,
        rows: level.height,
      };
      position += pixels.length;
      return result;
    });
    return {
      format: 'rgba8unorm',
      srgb: false,
      width,
      height,
      mipCount: availableMips,
      layerCount,
      cubemap,
      levels,
      data,
    };
  }

  if (!info) throw new FormatError('Unknown DDS layout', 80);
  const data = bytes.slice(dataStart, offset);
  const levels = stored.map((level) => ({ ...level, offset: level.offset - dataStart }));
  return {
    format: info.format,
    srgb: info.srgb,
    width,
    height,
    mipCount: availableMips,
    layerCount,
    cubemap,
    levels,
    data,
  };
}

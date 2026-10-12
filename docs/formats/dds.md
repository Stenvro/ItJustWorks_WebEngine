# DDS textures

Implementation: `src/formats/dds/dds.ts`. Verified on all 32,945 vanilla textures
(`node tools/dds-stats.ts`): 0 failures.

## Vanilla formats

| Count  | Format     | Source in file                      |
| ------ | ---------- | ----------------------------------- |
| 18,074 | BC3 (DXT5) | FourCC `DXT5`                       |
| 9,990  | BGRA8      | uncompressed, 32-bit masks          |
| 4,462  | BC1 (DXT1) | FourCC `DXT1`                       |
| 247    | RGBA8      | converted from other masked layouts |
| 172    | BC2 (DXT3) | FourCC `DXT3`                       |

58 cubemaps (`textures\cubemaps\`), no texture arrays, no BC5/BC7 in vanilla (mods use
them, so DX10 headers and BC4-BC7 are supported too). All block-compressed textures have
sizes that are multiples of 4, which WebGPU requires.

## Layout

- `DDS ` + 124-byte header; pixel format at offset 76. FourCC `DX10` adds a 20-byte header
  (DXGI format, dimension, misc flags with 0x4 = cube, array size).
- Mip count only counts if header flag `0x20000` is set.
- Data order: per layer (cube face), the full mip chain. Block-compressed levels use
  `max(1, ceil(w/4)) × max(1, ceil(h/4))` blocks of 8 (BC1/BC4) or 16 bytes.
- Mip chains usually stop at 4x4; that is fine for WebGPU.
- Uncompressed 32-bit BGRA/RGBA goes to the GPU as-is; other masked layouts (24-bit, 16-bit,
  luminance) are converted to RGBA8.
- A file that ends inside the mip chain keeps its complete mips; a missing base level is an
  error.

## Colour space

Skyrim's renderer works in gamma space: textures are sampled as UNORM, not sRGB. The parser
reports `srgb` for DX10 `*_SRGB` formats so the renderer can decide.

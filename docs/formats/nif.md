# NIF (Skyrim Special Edition)

Implementation: `src/formats/nif/`. Little-endian. Sources: niftools `nif.xml`, NifSkope.

Verified on all 22,761 vanilla meshes: every supported block is consumed byte for byte
(`node tools/nif-stats.ts --parse` reports 0 problems).

## Versions

- Header line `Gamebryo File Format, Version 20.2.0.7` + `\n`, then version `0x14020007`,
  endian byte (1 = little), user version **12**, block count.
- Bethesda stream header: BS version **100** for SSE. One vanilla file still has BS 83
  (Skyrim LE); the parser handles the few BS-version conditions that differ.
- Export strings in the BS header: u8 length **including** the null, then the characters.

## Header layout after the BS header

| Field             | Type                        |
| ----------------- | --------------------------- |
| block type count  | u16                         |
| block types       | SizedString (u32 + chars)   |
| block type index  | u16 per block (mask 0x7FFF) |
| block sizes       | u32 per block               |
| string count      | u32                         |
| max string length | u32                         |
| strings           | SizedString                 |
| group count       | u32, then u32 per group     |

Because every block size is known, unsupported block types are skipped safely and each
supported parser is checked to consume its block exactly. A block that fails is reported
in `NifFile.problems` and kept as `unknown`; the rest of the file stays usable.

Footer: u32 root count + i32 refs. Refs are block indices; −1 = none. Strings in blocks
are i32 indices into the header string table (−1 = empty).

## Notable fields

- **NiAVObject**: flags u32 (BS > 26), translation, rotation as 9 floats **row by row**
  (Gamebryo streams `m[row][col]` and applies `v' = R·v`), scale, collision ref. No
  property list for BS > 34.
- **NiNode**: children refs, then effects refs (BS < 130). Subclasses add trailing fields
  (NiSwitchNode: flags u16 + active index u32; NiBillboardNode: mode u16; BSTreeNode:
  two bone lists; BSMultiBoundNode: ref + culling mode; BSOrderedNode: vec4 + byte;
  BSValueNode: i32 + byte; BSRangeNode family: 3 bytes; NiLODNode: ref;
  BSMasterParticleSystem: u16 + refs).
- **BSLightingShaderProperty**: the **shader type (u32) comes before** the NiObjectNET
  fields (nif.xml declares it inside NiObjectNET with `onlyT`). Extra fields per shader
  type: 1 env map scale; 5 skin tint; 6 hair tint; 7 parallax passes + scale; 11 multi-layer
  (4 values incl. a vec2); 14 sparkle vec4; 16 eye cubemap scale + two reflection centers.
- **BSEffectShaderProperty**: source texture and greyscale texture are SizedStrings; four
  bytes (clamp mode, lighting influence, env map min LOD, unused) sit between them and the
  falloff floats.
- **NiAlphaProperty**: flags u16 (bit 0 blend, bits 1-4 src, 5-8 dst, bit 9 test, 10-12 test
  function) + threshold u8.

## BSTriShape (SSE geometry)

After NiAVObject: bounding sphere (vec3 + radius), skin ref, shader ref, alpha ref,
BSVertexDesc (u64), triangle count (**u16** for BS < 130), vertex count u16, data size u32,
then (if data size > 0) the vertex data and u16 triangles. SSE then has a **particle data
size** u32 (and half-precision particle geometry if non-zero).

Data size is always `vertexCount × stride + triangleCount × 6`; the parser checks it.

BSVertexDesc (u64): low nibbles = stride/4, then offsets/4 for UV, UV2, normal, tangent,
color, skinning, landscape data, eye data; **bits 44-55** are the attribute flags
(vertex 0x1, UV 0x2, normal 0x8, tangent 0x10, colors 0x20, skinned 0x40, eye 0x100,
full precision 0x400). SSE always stores positions as 3 floats, followed by the bitangent X
float when tangents are present.

Per-vertex layout (SSE): position f32×3, bitangent X f32, UV f16×2, normal u8×3 + bitangent
Y, tangent u8×3 + bitangent Z, color u8×4, skin weights f16×4 + indices u8×4, eye data f32.
Normals and tangents map 0..255 to −1..1. The raw buffer goes to the GPU unchanged.

Skinned shapes have data size 0: their vertices live in NiSkinPartition (TODO(M7)).
BSDynamicTriShape (faces) appends a u32 byte size and xyzw float positions.

## NiTriShape / NiTriShapeData (older geometry, 246 vanilla blocks)

NiTriShape: data ref, skin ref, material data (count, string refs, extra data, active
index, needs-update byte), shader ref, alpha ref. BSLODTriShape adds three u32 LOD sizes.

NiTriShapeData: group id, vertex count u16, keep/compress flags, vertices, data flags u16,
material CRC u32 (BS > 34), normals (+ tangents and bitangents if data flags & 0x1000),
bounding sphere, vertex colors (RGBA floats), **one** UV set if data flags & 1,
consistency flags, additional data ref, triangle count, triangle point count, triangles,
match groups.

## Hidden objects

- Objects named `EditorMarker` (any block type) are helper geometry for the Creation Kit,
  e.g. activator trigger volumes; the engine never draws them (1,012 vanilla meshes have one).
- BSXFlags bit `0x20` on the root (editor marker) hides the whole model.
- Base objects with record flag `0x800000` (is marker) are never drawn (see esm.md).

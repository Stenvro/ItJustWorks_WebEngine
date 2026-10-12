# Plugins: ESM / ESP / ESL

Implementation: `src/formats/esm/` (format), `src/world/record-db.ts` (load order),
`src/world/cell-records.ts` and `cell-loader.ts` (cells). Sources: UESP "Skyrim Mod:Mod File
Format", xEdit (TES5Edit) record definitions.

Verified on all 10 vanilla + Creation Club plugins: 1,188,920 records, 107,085 of them
compressed, all decompress and split into fields (`node tools/esm-stats.ts --verify`).

## Structure

A plugin is a TES4 record followed by top-level groups. Everything is little-endian.

**Record header (24 bytes):** type `char[4]`, data size u32, flags u32, form id u32,
version control u32, form version u16 (44 for SSE), unknown u16.

**Group header (24 bytes):** `GRUP`, group size u32 (**including** the header), label u32,
group type i32, version control u32, unknown u32.

| Group type | Label        | Contents                                |
| ---------- | ------------ | --------------------------------------- |
| 0          | record type  | top-level group (e.g. all STAT records) |
| 1          | WRLD form id | world children                          |
| 2 / 3      | block number | interior cell block / sub-block         |
| 4 / 5      | y i16, x i16 | exterior cell block / sub-block         |
| 6          | CELL form id | cell children (follows its CELL record) |
| 7          | DIAL form id | topic children (INFO)                   |
| 8 / 9      | CELL form id | persistent / temporary references       |

**Fields:** type `char[4]` + size u16 + data. A field `XXXX` (size 4) holds a u32 size for
the next field, whose own size is then 0.

**Compressed records** (flag `0x40000`): data = u32 decompressed size + zlib stream
(`src/formats/zlib/inflate.ts`, TypeScript, Adler-32 checked).

Record flags used so far: `0x1` master (TES4), `0x20` deleted, `0x80` localized (TES4),
`0x200` light/ESL (TES4), `0x400` persistent (REFR), `0x800` initially disabled,
`0x40000` compressed, `0x800000` **is marker** on base objects (STAT, FURN, ...: editor
markers such as XMarker, never drawn).

## Indexing

The index reads only headers, in 8 MB chunks, into typed arrays (Skyrim.esm: 869,688 records
in ~0.9 s in Node). Each group stores the range of records it contains, so "all references of
a cell" is a range lookup. Form ids are sorted for binary search.

## Form ids

A stored form id's top byte indexes the plugin's MAST list; a value equal to the number of
masters means "this plugin". Global (load-order) form ids:

- full plugins: `modIndex << 24 | id & 0xFFFFFF` (mod index 00-FD);
- light plugins (ESL): `0xFE000000 | lightIndex << 12 | id & 0xFFF`.

Form id 0 means "none" (it is also the TES4 header's id). The winning version of a record is
the one in the last plugin (in load order) that contains it.

## Localized strings

Localized plugins (TES4 flag `0x80`) store u32 ids in text fields (FULL, DESC, ...). Tables:
`strings\<plugin>_<language>.STRINGS` (null-terminated), `.DLSTRINGS` and `.ILSTRINGS`
(u32 length incl. null + text). Header: count u32, data size u32, (id u32, offset u32) × count.
Vanilla files live in `Skyrim - Interface.bsa`; Creation Club ones in their own BSA.

Encoding: SSE's English tables are **mostly UTF-8**, but some DL/IL strings contain bytes that
are not valid UTF-8. Strings are therefore decoded as UTF-8 where valid and as Windows-1252
otherwise.

## Cells

**CELL:** DATA flag `0x1` = interior. XCLL (92 bytes): ambient, directional and fog-near colours
(rgba u8), fog near/far f32, directional rotation XY/Z i32 (degrees), directional fade, fog
clip distance, fog power, directional ambient (6 colours for ±X/±Y/±Z, specular colour, fresnel
power), fog far colour, fog max, light fade begin/end, **inherit flags** u32 (which values come
from the LTMP lighting template instead).

**LGTM:** DATA uses the same layout up to offset 88; its directional ambient is in DALC.

**REFR / ACHR:** NAME base form id, DATA position (3 f32) + rotation (3 f32, radians), XSCL
scale, XESP enable parent (form id + flags; `0x1` = opposite state).

- Rotation is clockwise (Z is a compass heading: +Y north turns to +X east) and composed
  X·Y·Z, as Gamebryo's `NiMatrix3::FromEulerAnglesXYZ`. Verified visually on Breezehome.
- Enabled state at game start: initially-disabled flag, or the enable parent's state
  (inverted with the opposite flag). Breezehome's furniture hangs off "WhiterunPlayerHouse..."
  markers that are disabled until the upgrades are bought, so the house starts mostly empty,
  as in the game.
- **XRDS** on light references is an **offset** added to the LIGH radius (vanilla values
  range from −322 to +55; a negative absolute radius would be meaningless).

**LIGH:** DATA (48 bytes): time i32, radius u32, colour rgba u8, flags u32, falloff exponent,
FOV, near clip, flicker parameters. FNAM: fade (brightness). Flag `0x20` = off by default.

**World models:** MODL for most base types, MOD2 (male world model) for ARMO.

# BSA v105 (Skyrim Special Edition)

Implementation: `src/formats/bsa/bsa.ts`. Everything little-endian. Sources: UESP
"Skyrim Mod:Archive File Format", BSArch, the lz4 frame/block specification.

Verified on all 23 vanilla archives (173,941 files): hashes, offsets and
uncompressed sizes match (`node tools/bsa-list.ts <archive> --verify`).

## Header (36 bytes)

| Offset | Type    | Field                                                               |
| ------ | ------- | ------------------------------------------------------------------- |
| 0      | char[4] | `BSA\0`                                                             |
| 4      | u32     | version: **105** (SSE). 104 = Oldrim (zlib), not used by SSE        |
| 8      | u32     | offset of the folder records (always 36)                            |
| 12     | u32     | archive flags (see below)                                           |
| 16     | u32     | number of folders                                                   |
| 20     | u32     | number of files                                                     |
| 24     | u32     | total length of folder names: **incl.** null, **excl.** length byte |
| 28     | u32     | total length of file names (incl. nulls)                            |
| 32     | u16     | content types (meshes 0x1, textures 0x2, ...): informational        |
| 34     | u16     | padding                                                             |

Archive flags: `0x1` folder names, `0x2` file names, `0x4` compressed by default,
`0x8`/`0x10`/`0x20`/`0x80` retain hints (no effect on reading), `0x40` Xbox 360
(big-endian, not supported), `0x100` embedded file names, `0x200` XMem.

## Layout

1. **Folder records** (24 bytes in v105, 16 in v104): hash u64, file count u32,
   padding u32, offset u64.
   - The offset points to the folder's file record block **plus**
     `totalFileNameLength`. Actual position = offset − totalFileNameLength.
2. **File record blocks**, per folder: bstring folder name (u8 length incl. null, characters,
   null) if flag `0x1`, then 16 bytes per file: hash u64, size u32, offset u32 (absolute).
   - Size: bit 30 (`0x40000000`) **inverts** the default compression for this file;
     the actual size is `size & 0x3FFFFFFF`.
3. **Name block** if flag `0x2`: all file names as null-terminated strings, in
   the same order as the file records.
4. **Data**. Per file:
   - if flag `0x100`: bstring with the full path (u8 length, **without** null);
   - if compressed: u32 original size, followed by **one LZ4 frame**;
   - otherwise: the raw bytes.

Names are Windows-1252. Paths are looked up in lowercase (A-Z only, like
C `tolower`) with backslashes.

A folder's files lie one after another in the data, so the VFS reads the archives through a
block cache (`src/formats/block-cache.ts`, 16 MB of 64 KB blocks): a file of 64 KB or less
comes with its block, and the next small file of the folder is mostly in it already. A new
game's scripts (Misc.bsa) took 3,524 reads one after another; now 285 blocks
([esm.md](esm.md#reading-records)). Larger files (textures, most animations) are read as
before.

## Hash

64 bits; folders hash the whole path, files only the name (extension separately):

- low (32 bits): `last + (second-to-last << 8, only if length > 2) + (length << 16) +
(first << 24)` over the name without extension, OR'd with a flag per extension:
  `.kf` 0x80, `.nif` 0x8000, `.dds` 0x8080, `.wav` 0x80000000.
- high (32 bits): `h = h * 0x1003F + c` over characters 1..n−3 of the stem, plus the same
  rolling hash over the extension (including the dot), modulo 2³².

Archives without names (flags 0x1/0x2 off) are searched by hash only; `BsaArchive.get`
supports that too.

## Vanilla archives

| Archive(s)                | Flags | Compression | Embedded names |
| ------------------------- | ----- | ----------- | -------------- |
| Textures0-8               | 0x107 | all         | yes            |
| Meshes0/1                 | 0x087 | all         | no             |
| Animations                | 0x007 | all         | no             |
| Sounds, Misc              | 0x013 | none        | no             |
| Voices_en0, Interface     | 0x003 | none        | no             |
| Creation Club, \_Resource | 0x083 | none        | no             |

## LZ4 frames in vanilla

- FLG `0x60` (independent blocks) and sometimes `0x40` (**linked** blocks: matches
  refer back to previous blocks; the decoder must decode the whole frame into one
  buffer).
- Maximum block size varies: 64 KB to 4 MB (BD `0x40`-`0x70`).
- No block or content checksums, no content size, no dictionary. The
  header checksum (`xxh32(descriptor) >> 8 & 0xFF`) is present and is verified.

The TypeScript decoder (`src/formats/lz4/lz4.ts`) achieves ~400-650 MB/s including
disk I/O in Node; fast enough to not use WASM for now.

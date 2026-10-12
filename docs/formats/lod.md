# Distant LOD

Beyond the loaded cells (uGridsToLoad 5: the 5×5 cells around the camera) Skyrim draws
pre-generated LOD: terrain, distant water, objects and trees. Parsers:
`src/formats/lod/lod.ts`; selection: `src/world/lod.ts`; drawing: `src/shell/world-lod.ts`.
`node tools/lod-info.ts [--meshes]` checks every worldspace's LOD data (all vanilla files
parse).

## Settings: `lodsettings\<world>.lod`

16 bytes: i16 south-west cell x, i16 south-west cell y, u32 stride (cells per side of the
LOD grid), u32 lowest level (4), u32 highest level (32; Japhet's Folly 16). Tamriel:
−96, −96, 256 → cells −96..159. A child worldspace uses its LOD world's files (WRLD PNAM
`0x2`: WhiterunWorld draws Tamriel's).

## Blocks

A block covers `level` × `level` cells from a south-west cell aligned to the grid
(south-west corner + k × level). File names: `<world>.<level>.<x>.<y>.<ext>` with x, y the
block's south-west cell; `<world>` is the editor id in lowercase.

- **Terrain** `meshes\terrain\<world>\<name>.btr`: a NIF. Node `chunk` holds the land
  (BSTriShape, attributes position + UV, BSLightingShaderProperty type 18 "LOD landscape
  noise" with `textures\terrain\<world>\<name>.dds` and `_n.dds`). The shape's own transform
  is a scale of `level` and no translation: positions are block-local (0..4096 before the
  scale); the block's origin is `x, y × 4096`. Node `WATER` holds the distant water: shapes
  without a shader (positions only), at the water's height — drawn with the world's LOD water
  type (WRLD NAM3, else NAM2). Level 4 water shapes are BSSubIndexTriShape with one segment per
  cell. Tamriel has complete grids: 2304/576/144/36 blocks of levels 4/8/16/32.
- **Objects** `meshes\terrain\<world>\objects\<name>.bto`: NIF, levels 4/8/16 (only blocks
  with objects; 517/152/48 in Tamriel). BSSubIndexTriShapes named `Obj`, `objsnow`, `objHD`,
  `objsnowHD`, `objash`, `objashHD` (Solstheim) and the same with `-LargeRef` (objects of
  large references); textures in the atlas `textures\terrain\<world>\objects\<world>.objects.dds`.
  The shader is type 0 with SLSF2 `LOD_Objects` (`0x4`) or `HD_LOD_Objects` (`0x80000000`,
  with vertex colours). `snow` / `ash` shapes get the engine's LOD snow or ash (see
  [esm.md](esm.md#directional-materials)). Level 4 blocks have one segment per cell (up to 16;
  index = first index, count = triangles), **column by column**: segment i is cell
  (x + ⌊i / 4⌋, y + i mod 4) (3947 of 3953 non-empty Tamriel segments lie in that cell; the
  rest are objects reaching over a border). Larger blocks have a single segment. An object
  belongs to the segment of its reference's cell, so it is never split. The shape's transform
  places it in world space (translation = block origin).
- **Trees** `meshes\terrain\<world>\trees\<name>.btt`: level 4 only. u32 group count, then per
  group: u32 tree type, u32 count, count × 32 bytes (position f32×3, z rotation f32, scale f32,
  reference form id u32, 8 unused). Some Dragonborn blocks have more bytes after the declared
  groups; only the declared groups are read.
- **Tree types** `meshes\terrain\<world>\trees\<world>.lst`: u32 count, then 32 bytes each:
  u32 index, f32 width, f32 height, f32 u0, v0, u1, v1 (atlas rectangle, top-left and
  bottom-right), u32 unused. Atlas: `textures\terrain\<world>\trees\<world>treelod.dds`.

**BSSubIndexTriShape** (SSE): a BSTriShape followed by u32 segment count and per segment u8
flags, u32 first index, u32 triangle count.

## Choosing blocks

Starting from the largest blocks, a block is split into its four children while the camera
is closer to it (horizontally, to its nearest point) than the distance up to which the
smaller size is used: level 4 up to fBlockLevel0Distance (35000), level 8 up to
fBlockLevel1Distance (70000), level 16 up to twice that, level 32 beyond; nothing past
fBlockMaximumDistance (250000) — SkyrimPrefs.ini Ultra values. Object LOD uses the same
blocks (level 32 as its four level-16 blocks); tree LOD covers the level-4 blocks within
fTreeLoadDistance (75000). A block stays on screen until every block replacing it has loaded,
so the view has no holes while the camera moves.

## Where the loaded cells are

The engine hides LOD inside loaded cells (per-cell segments for objects, fLODLandDropAmount
230 for the land). Here the LOD landscape (shader types 9 and 18), LOD water and tree
billboards discard pixels in a cell that is loaded and ready, from a 7×7 bit mask around the
camera in the frame uniforms, so streaming cells replace their LOD exactly. Object LOD leaves
out whole segments instead, like the engine: the segments of loaded cells, and for
`-LargeRef` shapes also those of cells whose large references are loaded (an 11×11 mask).
Object LOD casts no shadows.

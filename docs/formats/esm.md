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

## Reading records

`RecordDatabase` reads the plugins through a block cache (`src/formats/block-cache.ts`): a
record of 64 KB or less is read with its whole 64 KB block, and the blocks read last (32 MB of
them, least recently used out first) are kept. Larger reads (a scan's 8 MB chunks, the largest
records) go to the file and are not kept; what a read returns is a copy, so a record kept for
long does not keep its block. In the browser every read is a round trip of about the same cost
whatever its size (a `Blob` slice, or with `?devdata` an HTTP range request): read one by one,
the records of a cell or the persistent references a quest searches waited on one round trip
each. Records sit in the file by group (a cell's references together, a top group's records
together), so most reads land in a block already read: a new game (`node tools/papyrus-run.ts
--new-game`) reads 4,413 blocks and serves 20,241 reads from them, where it read 24,654 times.
The archives' small files go through a cache of their own the same way (16 MB: a script's
parents and the scripts after it, a cell's small meshes; [bsa.md](bsa.md)).

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

**LGTM:** DATA uses the same layout up to offset 88; its directional ambient is in DALC. Some
templates have a 72-byte DATA that stops after the directional ambient (offset 40–71): no fog
far colour (use the near one), fog max (1) or light fade distances.

**REFR / ACHR:** NAME base form id, DATA position (3 f32) + rotation (3 f32, radians), XSCL
scale, XESP enable parent (form id + flags; `0x1` = opposite state).

- Rotation is clockwise (Z is a compass heading: +Y north turns to +X east) and composed
  X·Y·Z, as Gamebryo's `NiMatrix3::FromEulerAnglesXYZ`. Verified visually on Breezehome.
- Enabled state at game start: initially-disabled flag, or the enable parent's state
  (inverted with the opposite flag). Breezehome's furniture hangs off "WhiterunPlayerHouse..."
  markers that are disabled until the upgrades are bought, so the house starts mostly empty,
  as in the game.
- **What switches enable-parent markers** is decided by scripts, never by names. A room's
  walls, doors and furniture follow the same marker, so they switch together.
  - **Player homes** (`src/world/player-home.ts`) are played in the Papyrus VM
    (`src/scripting/`, see [pex.md](pex.md)). Purchases are dialogue responses (INFO) whose
    fragment script names a marker of the cell, plus the gold-taking responses of the same
    quests; one counts if playing it on a new game changes a reference of the cell. Its label
    is the topic text (DIAL FULL) with `<Global=X>` replaced by the global's value.
    HearthFire houses are built as a player does: `BuyProperty`, then repeatedly craft the
    first BYOH recipe (COBJ) whose conditions hold, in `BYOHHouseBuildingMasterList` order,
    finishing everything available before drafting another wing (drafting a layout removes
    the other layout tokens), and furnish each finished room from its
    `RoomMasterLists` entry. Recipes that enable nothing (`EnableList[i]` is None, the
    "Remove Workbench" parts) are skipped. Main hall styles B and C need
    `iHouseStyles ≥ 2/3` (it is 1), so only style A is ever built.
  - **Quest and scene states** (`src/world/cell-upgrades.ts`): the other roots. They start as
    placed; a `X_Disable` / `XStart` counterpart switches with `X_Enable` / `X`.
  - `Enable`/`Disable` on a reference that has an enable parent does nothing (the parent
    decides); HearthFire's cellar data relies on that.
  - The player reference (0x14) is created by the engine; no plugin contains it.
- **XRDS** on light references is an **offset** added to the LIGH radius (vanilla values
  range from −322 to +55; a negative absolute radius would be meaningless).

**LIGH:** DATA (48 bytes): time i32, radius u32, colour rgba u8, flags u32, falloff exponent,
FOV, near clip, flicker: frequency (stored as 1 / period in seconds: 0.333 is one cycle every
3 s), intensity amplitude (how far the light dims below its fade; it never brightens),
movement amplitude (units). FNAM: fade (brightness). Flag `0x20` = off by default. Lights
flicker only within fFlickeringLightDistance (1024) of the camera and fade out from
fLightLODStartFade (3500, High preset) over fLightLODRange (500).

**World models:** MODL for most base types, MOD2 (male world model) for ARMO.

## Worldspaces

**Group layout:** a WRLD record is followed by its children group (type 1, label = WRLD id).
That holds the **persistent cell** (a CELL record directly in the group, with its persistent
children) and exterior **blocks** (type 4, label: y in the low and x in the high i16, 32×32
cells), which hold **sub-blocks** (type 5, same label layout, 8×8 cells), which hold the CELL
records. A cell's grid position is in XCLC (x, y i32); `floor(cell / 8)` is its sub-block.
`RecordDatabase.exteriorCell` reads only the one sub-block it needs.

**WRLD:** WNAM parent world, PNAM (u16) what the child takes from its parent (`0x1` land,
`0x2` LOD, `0x4` map, `0x8` water, `0x10` climate, `0x20` imagespace, `0x40` sky), CNAM climate,
NAM2 water, NAM3 LOD water + NAM4 its height, ZNAM music type, DNAM default land height and
default water height (f32 each), DATA flags (`0x1` small world, `0x2` can't fast travel, `0x8` no LOD water, `0x10`
no landscape, `0x20` no sky, `0x40` fixed dimensions, `0x80` no grass).

- A world with the no-sky flag (`0x20`, e.g. Blackreach) draws no sky dome, sun, moons, stars,
  clouds or sky statics; its weather still gives the light, fog and precipitation.
- City worlds (WhiterunWorld, SolitudeWorld, …) have PNAM `0x7f`: their landscape is
  Tamriel's LAND at the same grid position, and their own CELLs hold only the objects.
- Persistent references (NPCs, doors, map markers) live in the persistent cell, not in the
  exterior cell they stand in; the loader sorts them into cells by position.
- A cell's water height is its XCLW, else the world's default (DNAM). Values beyond ±1e9
  mean "no water". DNAM is the land data (xEdit: "Land Data"): every world that uses its
  parent's land (PNAM 0x1: the city worlds, WindhelmPitWorldspace, KatariahWorld) has none,
  and every world with one uses its own land, so the default heights come from the land world,
  also where the water type does not (KatariahWorld: its own DefaultWaterKatariahWorld at
  Tamriel's −14000; read as 0 its ship stood under water).
- A grid position without a CELL record holds nothing (not even the parent world's land):
  the LOD stays visible there. Around a city world's few cells, the parent's LOD (terrain,
  water, objects) shows what lies outside.
- The world map (`src/world/worldspace.ts`, used by `docs/ui.md` "The map"): MNAM is 28 bytes
  (16 in older plugins). It holds the usable width and height (i32 each, the old 2D map's;
  unused), the NW and SE cells (i16 x, y each), then the camera's min height, max height and
  initial pitch (f32: Tamriel 50000, 80000, 50; Solstheim 31000, 48000, 70). ONAM (4 f32: scale,
  x, y, z offset) puts the world's places on its map world: position × scale + offset
  (Blackreach 2.5 under Tamriel; the East Empire Warehouse 0.0001 at Solitude's docks; −1 for
  Sovngarde and Apocrypha: no map). MODL is the map's cloud model (Solstheim's
  `DLC02\Sky\DLC2WorldMapCloudBank_Low.nif`; Tamriel has none).

**Large references** (SSE, `src/world/large-references.ts`): big objects (mountains, cliffs,
city walls, forts) are loaded in full detail in a wider grid than the normal cells
(uLargeRefLODGridSize 11 × 11 around the camera, versus uGridsToLoad 5 × 5); there their LOD
shapes `obj-LargeRef` give way while the other LOD stays. Each plugin's version of a WRLD
record lists in RNAM fields the large references _it_ adds (Tamriel: 160,247 entries for
34,034 references in Skyrim.esm, a few hundred in Update.esm and the DLC), so all versions
are merged. RNAM: i16 cell Y, i16 cell X, u32 count, then per reference its form id, i16 Y and
i16 X of the cell it is placed in. A reference is listed under every cell its bounds reach
into (its own cell and mostly the 8 neighbours). With the camera in a cell, the references
listed for the cells of the 11 × 11 grid around it are shown: the cells outside the loaded
5 × 5 get a scene of only those references (with the cell's enable state). As the camera moves
a cell the set listed for a cell at the grid's edge grows or shrinks by the references that
only reach into the cells it entered or left: a scene is made again only when its cell wants
references it lacks (with those it had: a camera going to and fro over a border, a fight near
one, loads each cell once more at most), and none is made where the full cell is still kept
just outside the grid. Reloading on every change read and inflated some fifty cells' records
on the main thread per border crossing.

## Landscape

**LAND** (one per exterior cell, a child of its CELL): a 33×33 grid of points 128 units apart
(the outer rows are shared with the neighbours), stored row by row from the south-west corner.

- **VHGT:** f32 offset, then 33×33 i8 deltas and 3 unused bytes. The first delta of a row adds
  to the first point of the previous row; the others add to the point before them in the row.
  Height = value × 8.
- **VNML:** 33×33 × 3 i8 normal (signed; verified on all vanilla records). **VCLR:** 33×33 RGB
  u8 vertex colours (most records have none: white).
- **Textures** are per quadrant (0 south-west, 1 south-east, 2 north-west, 3 north-east; 17×17
  points each, sharing the middle row and column). **BTXT**: base LTEX, quadrant u8, 3 unused.
  **ATXT**: LTEX, quadrant u8, unused u8, layer u16; followed by **VTXT**: entries of position
  u16 (0..288 in the quadrant's 17×17 grid), 2 unused bytes, opacity f32. Layers are stacked in
  layer order, each covering what is below by its opacity.
- **Defaults:** a quadrant without BTXT, a BTXT/ATXT naming LTEX 0 (13,000 vanilla layers) or an
  LTEX that does not exist (0x844 in Skyrim.esm) is drawn with `landscape\dirt02.dds`.
- Vanilla quadrants have at most 6 layers (7 textures); the shader blends 8.
- **LTEX:** TNAM texture set (TXST: TX00 diffuse, TX01 normal), SNAM specular exponent (30;
  80 for river beds), INAM (SSE) flags: `0x1` snow (the diffuse alpha is its snow mask).
  Textures repeat 6 times per cell (`fLandTextureTilingMult` 3 per half cell).

`node tools/land-audit.ts` checks every LAND record: heights, layer counts, and that each land
texture resolves to files that exist and parse.

## Emittance

**REFR XEMI** (form id; 9182 vanilla references): an outside colour for the reference
(`src/world/emittance.ts`). It names a LIGH (its colour; candle and Dwemer lights, 1/3 of the
uses) or a REGN whose weather list holds one weather made for this: FXLightRegionSunlight
(sunlight colour bright by day, dark blue at night), FXLightRegionInvertWindowWhiterun /
…Windhelm (white at night, black by day), FXLightRegionCaveBlueSkylight, or an ordinary
region (WeatherMountains: its most likely weather). The colour is the weather's **sunlight**
colour at the current hour, blended over the times of day like the sky. Which references use
it: FX glow fills, mist and dust-beam effects, sunlight bounce and window fill lights in
interiors, and buildings with window glow maps (WRHouseWind01: glow shapes with SLSF1
External_Emittance, emissive multiple 2.5).

- Lighting shapes with External_Emittance (`0x20000000`) emit the XEMI colour × their
  emissive multiple (glow shapes: × the glow map); without XEMI their own emissive colour.
- Effect shapes with External_Emittance and Effect_Lighting are lit by the XEMI colour instead
  of the scene's ambient and sun (the effect shader's DLightColor), plus point lights.
- A LIGH reference with XEMI takes that colour.

## Trees

**TREE CNAM** (48 bytes, 12 × f32): trunk flexibility, branch flexibility, trunk amplitude,
front / back / side amplitude, front / back / side frequency, leaf flexibility, leaf amplitude,
leaf frequency (e.g. ReachTree01: leaves 2 and 1; pines: 2 and 1.5). Tree models have a
BSLeafAnimNode root (172 vanilla trees: leaves only) or a BSTreeNode (71, the pines: the
shapes are skinned to a trunk bone and branch bones, its two bone lists). Shapes with SLSF2
Tree_Anim flutter in the wind (lighting shader TreeParams, see
[rendering.md](../rendering.md#lighting-shader)). The trunk and branch values move the
BSTreeNode bones (its first list the trunk's, "Bones 1", its second the branches'). The
Creation Kit computes the amplitudes and frequencies from the flexibilities (pines: trunk 0,
branch 2.75 → front / back / side amplitude 0.08 / 0.11 / 0.09, frequency 1.38 / 1.38 / 1.10,
that is branch × 0.03 / 0.04 / 0.033 and branch / 2, branch × 0.4); it documents only that the
trunk moves horizontally and the branches in every direction. How the engine turns them into
motion is not documented; `src/animation/tree-sway.ts` swings each bone about its own x and z
axes by the amplitudes (radians) at the frequencies (radians per second) times the weather's
wind speed, the trunk about the model's horizontal axes (TODO(M13): the engine's formula). The
motion is the model's: every placement of a tree model sways alike, turned with the reference.

## Grass

**LTEX GNAM** (repeated): the GRAS that grow on a land texture (29 vanilla textures).
**GRAS:** MODL mesh, DATA 32 bytes: density u8 (percent), min slope u8, max slope u8 (degrees),
unused u8, units from water u16, unused u16, water rule u32 (1 above at least, 2 above at most,
3 below at least, 4 below at most, 5 either at least, 6 either at most, 7 either at most above,
8 either at most below), position range f32, height range f32, color range f32, wave period
f32, flags u8 (`0x1` vertex lighting, `0x2` uniform scaling, `0x4` fit to slope), 3 unused.

**Placement** (`src/world/grass.ts`; the engine's algorithm is not documented, so this follows
the data's meaning): each grass type of a cell's land textures has its own grid of candidate
points every iMinGrassSize (20) units, offset randomly by the position range. A point gets a
plant with probability density × how much the type's textures cover it there (base and
layers, as the terrain blends them), if the ground's slope is within range and the water rule
holds against the cell's water height. Size varies by ±height range (only up without uniform
scaling), brightness by −color range, rotation freely; fit to slope tilts the plant to the
ground normal. The random numbers hash the grid point and the type, so a cell always grows
the same grass. Plants shrink away from fGrassStartFadeDistance (7000, Ultra) over 1000 units
and sway with the weather's wind (wave period: seconds per sway at 60 Hz scale,
approximated).

## Climate and weather

**CLMT:** WLST weather list (12-byte entries: WTHR, chance u32 %, GLOB), FNAM sun texture,
GNAM sun glare texture, MODL night sky model (`sky\stars.nif`), TNAM 6 bytes: sunrise begin,
sunrise end, sunset begin, sunset end (u8 each, in 10-minute units: 33 = 5:30), volatility,
moons (bits 0–5 days per phase, `0x40` Masser, `0x80` Secunda). Vanilla: 5:30–10:00 and
16:00–20:30 everywhere except Blackreach and Apocrypha.

**WTHR:**

- The clock the sky follows runs at the **TimeScale** global (GLOB FLTV; Skyrim.esm: 20, a game
  day in 72 real minutes), read from the load order; the dev panel speeds it up 2×, 5×, 10× or
  20× (as the console's `set timescale`). The sky follows it (sun, moons, clouds, colours,
  weather); animations (fire, water, trees, people) run in real time, as in the game.
- Cloud layers: texture fields `00TX`, `10TX`, … `90TX`, `:0TX`, … (the first character is
  `'0' + layer`), RNAM / QNAM one byte per layer: Y / X scroll speed, `(b − 127) / 1270`
  (−0.1..0.1; read as texture widths per game minute, so the clouds follow the clock: UESP and
  the Creation Kit give no unit; per real second they scrolled three times too fast and
  ignored the TimeScale, unlike the game's clouds in timelapses. TODO(M13): compare with the
  game; SkyrimClear's upper layers 0.03, the storm and overcast weathers 0), PNAM
  32 × 4 times × RGBA u8 colours, JNAM 32 × 4 times × f32 alpha, NAM1
  disabled-layer bits, LNAM layer count (4 or 29). Many disabled or transparent layers name
  textures that do not ship; only TESTCloudyRain shows a missing one.
- NAM0: 17 colours × 4 times (sunrise, day, sunset, night) × RGBA u8: 0 sky upper, 1 fog
  near, 2 unused, 3 ambient, 4 sunlight, 5 sun, 6 stars, 7 sky lower, 8 horizon, 9 effect
  lighting, 10/11 cloud LOD diffuse/ambient, 12 fog far, 13 sky statics, 14 water multiplier,
  15 sun glare, 16 moon glare. Shorter tables (13/14 entries) default the rest (fog far and
  sky statics black, the others white).
- FNAM fog (8 f32): day near, day far, night near, night far, day power, night power, day
  max, night max.
- DATA (19 bytes, xEdit): wind speed, 2 unused, trans delta (`/1020`: 0..0.25), sun glare,
  sun damage, precipitation fade in/out, thunder fade in/out, thunder frequency, flags
  (`0x01` pleasant, `0x02` cloudy, `0x04` rainy, `0x08` snow, `0x10`/`0x20` aurora always
  visible / follows the sun), lightning RGB, visual effect begin/end, wind direction (0..360),
  wind range (0..180). Unit values are `/255`.
- IMSP 4 × IMGS (per time of day), DALC × 4 (32 bytes each: six RGBA colours for +X, −X, +Y,
  −Y, +Z, −Z, specular RGBA, fresnel f32), MNAM precipitation (SPGD), NNAM visual effect,
  SNAM sounds (SNDR + type), TNAM sky statics, MODL aurora model.

**REGN:** RDAT (type u32: 2 objects, 3 weather, 4 map, 5 land, 6 grass, 7 sound; override u8;
priority u8; 2 unused) heads each tab's data; the weather tab is followed by RDWT (12-byte
entries like WLST). The sound tab is followed by RDMO (the region's music type, MUSC) and RDSA
(12-byte entries: SNDR, u32 weather classifications it plays in — 0x1 pleasant, 0x2 cloudy,
0x4 rainy, 0x8 snowy — and f32 chance: 1 for every looping sound, 0.01–0.1 for the others).
A cell's regions are its XCLR form ids.

**Which weather:** the weather region around the player among the cell's regions (an area
of the region holds the player; a tab marked Override beats priority), else the climate's
list (Tamriel's SkyrimClimate has a single weather: its land cells have weather regions,
e.g. WeatherTundra around Whiterun, WeatherWhiterun inside the city world). How the sky picks
from the list, how long a weather lasts (the climate's volatility) and how scripts hold one:
[rendering.md](../rendering.md) ("Weather"). An interior's XCCM names the region its sky and
weather come from; CELL DATA `0x80` Show Sky, `0x100` Use Sky Lighting; WRLD LTMP a
worldspace's lighting template (its sky shows only the dome).

**Time of day** (`src/world/sky-state.ts`): sunrise colours peak halfway through the climate's
sunrise, sunset colours halfway through its sunset. From sunrise begin, night fades into
sunrise; from the middle, sunrise into day (complete at sunrise end); the evening runs the
same way backwards. Fog distances exist for day and night only and follow the night weight.
Stars fade in with the night weight (NAM0 stars is only their tint: most weathers keep it
white all day); the moons show outside full day and fade out between `fMasserAngleFadeStart`
and `End` degrees above the horizon.

**Sun path:** the sun is on the horizon in the east a quarter hour before the middle of
sunrise and in the west a quarter hour after the middle of sunset (Community Shaders' sky
sync, which reproduces vanilla), on an arc tilted 95° from the horizon (just north of the
zenith). At night the directional light comes from the mirrored direction above the horizon
with the night sunlight colour.

**Game settings** used: `fSunXExtreme` (400, sun distance in sky units), `iMasserSize` 90,
`iSecundaSize` 40, `fMasser/SecundaAngleFadeStart/End` 35/20, `fStarsRotateDays` 1.0027 and
axis `fStarsRotateX/Y/ZAxis` (−0.09, 0.35, 1), `fAuroraFadeInStart` 19, `fAutoraFadeIn` 20,
`fAutoraFadeOut` 6 (sic), `fWeatherTransAccel` 16. INI defaults: `fSunBaseSize` 425,
`fSunGlareSize` 600.

**Sky meshes:** `sky\atmosphere.nif` (dome, radius 500, horizon ring at z 0): vertex colour
red weights the horizon colour, green the lower sky, blue the upper sky; alpha fades the
bottom 18 units. `sky\clouds.nif`: 29 shapes, the root's children in layer order. Stars:
the climate's MODL (constellations, galaxy, stars; radius 16). Moon textures:
`sky\masser_<phase>.dds`, `secunda_<phase>.dds` with phases full, three_wan, half_wan,
one_wan, new, one_wax, half_wax, three_wax; `sky\moonshadow.dds` hides the stars behind
the dark part. `node tools/weather-info.ts` checks every climate and weather against the
files they name; `node tools/weather-info.ts SkyrimClear 13` prints one weather's sky.

**Precipitation** (SPGD, `src/world/precipitation.ts`; 12 records): DATA (48 bytes) gravity
velocity, rotation velocity (degrees/s), particle size X and Y, centre offset min and max,
initial rotation range (f32), atlas columns and rows (u32), type u32 (0 rain, 1 snow), box size
u32, density f32; ICON the particle texture (rain: `effects\fxraindrops.dds`, 4 × 2 thin
streaks; snow: `fxsnowsoftsub.dds`, 4 × 4 soft flakes). During a change of weather the new
weather's precipitation starts at its Precipitation Begin Fade In (share of the transition)
and the old one's ends at its End Fade Out. How it is drawn: [../rendering.md](../rendering.md#precipitation).

**Lightning** (`src/world/lightning.ts`): thunder frequency 255 (all calm weathers) has
none; storms use 246 (rain), 203 (snow), the Storm Call shout 15, so lower values flash more
often: read as a mean of value/255 × 30 seconds between flashes, at random (exponential
waits). A flash (a strike, a re-strike after 0.28 s, 0.6 s in all) adds the lightning colour
to the sky colours and half of it to ambient and fog; thunder fades in and out with weather
changes like precipitation (Thunder Begin Fade In, End Fade Out). The interval's scale is
inferred: TODO(M13) compare with the original. Thunder sounds follow the flashes
([audio.md](../audio.md#ambience)).

**Sky statics and aurora:** TNAM (87 weathers) lists STATs drawn in the sky — mostly the
distant cloud banks `skyinv_clouddistant*.nif` (effect meshes about 11600 units across with
scrolling cloud sheets, lit by the weather), also Sovngarde's sky; MODL (38 weathers, the
`_A` variants among them) is the aurora, `skyskyrimaurora.nif`: three skinned effect
shapes (rest pose) whose UV and alpha controllers make it ripple. Both follow the camera and
fade with weather changes; the aurora also fades in from `fAuroraFadeInStart` to
`fAutoraFadeIn` and out until `fAutoraFadeOut`, and with the flag `0x20` turns with the sun's
heading. They are drawn without fog, scaled up (statics × 100, aurora × 3000) so they lie
behind the landscape's LOD with the same angular size (`src/shell/sky-objects.ts`).

## Water

**WATR:** SNAM open sound (the water's ambient loop: 26 vanilla types), TNAM material (MATT:
footsteps in it; 5 puddle types MaterialWaterPuddle, 2 blood waters MaterialWater, 51 none),
ANAM opacity (0–100), FNAM flags (`0x1` causes damage, `0x8` flow map, `0x10` blend normals),
NAM2/NAM3/NAM4 the three noise layers' normal maps (SSE; older files use three NNAM; vanilla names
`Data\Textures\Water\DefaultWater.dds`: the path is relative to Data), INAM imagespace modifier, DNAM 228 bytes (232 in SSE with the flow map scale). DNAM as 4-byte
values (UESP numbering − 1): 4 sun specular power, 5 reflectivity, 6 fresnel, 8/9 above-water
fog near/far, 10/11/12 shallow / deep / reflection colour (RGBA u8), 18–22 displacement,
24 noise falloff, 25–27 wind direction (degrees) and 28–30 wind speed per layer, 33 fog
amount, 35–37 underwater fog amount/near/far, 38 refraction magnitude, 39 specular power,
41 specular radius, 42 specular brightness, 43–45 UV scale and 46–48 amplitude per layer,
49 reflection magnitude, 50 sun sparkle magnitude, 51 sun specular magnitude, 52–55 depth
properties (reflections, refraction, normals, specular), 56 sun sparkle power, 57 flow map
scale.

**Where water is:**

- **Interior cells have no water plane:** 138 vanilla interiors set the flag, all with XCLW 0;
  59 of them lie mostly below it (the Dark Brotherhood Sanctuary, the Ragged Flagon, Ysgramor's
  Tomb), and none is flooded in the game (CommonLibSSE: TESObjectCELL::GetExteriorWaterHeight is
  minus infinity indoors). Indoors, water is placed: water activators (the player swims in
  their bounds) and water meshes.
- **Cell water:** CELL DATA flag `0x2`, XCLW height (FLT_MAX: the world's DNAM default; a few
  vanilla cells hold ±2^31 or 2^32, which mean none), XCWT type, else the world's NAM2.
  Lakes and rivers are cell water at their own height: the White River east of Whiterun is
  at −4700 (cells 5..9, −4) and −5050 further north-east; Tamriel's sea default is −14000.
- **Water activators:** ACTI with WNAM (90 vanilla): `water\water1024.nif`, puddles, the
  Whiterun and Markarth water features. Their meshes use BSWaterShaderProperty (nif.xml: shader
  flags 1/2, UV offset/scale, water shader flags u8, water direction u8, unknown u16).
- Other water meshes get DefaultWater (`0x18`).
- **Flow maps:** rivers (FNAM `0x8`) move along `textures\water\<plugin>\flow.<x>.<y>.dds`,
  64×64 BGRA8 per cell, row 0 at the north edge. R/G encode a unit direction around 128
  (R east, G north); alpha is 1 − flow strength (255 where nothing flows).

**The water shader** (`src/render/shaders/water.wgsl`) draws after the opaque scene, from
copies of its colour and depth: three noise layers scrolled by wind (rivers: along the flow
map, two phases half a period apart), refraction of the scene below shifted by the waves,
depth fog over the distance the view travels through the water towards the shallow/deep
colours (times the weather's water multiplier), screen-space reflections of the scene with
the sky dome as fallback, fresnel, and the sun's specular and sparkle. Approximated
(TODO(M13)): the flow speed (160 units/s at full strength), how opacity and the depth
properties enter, the engine's planar reflection pass, displacement and rain ripples.

## Imagespaces

**IMGS** (xEdit names): HNAM 9 f32: eye adapt speed, bloom blur radius, bloom threshold,
bloom scale, receive bloom threshold, white, sunlight scale, sky scale, eye adapt strength.
CNAM: saturation, brightness, contrast. TNAM: tint amount, red, green, blue. DNAM: depth of
field strength, distance, range, and a fourth f32 packing the blur radius and a "no sky" flag
as 2 + 8 × radius + 4 × no sky (xEdit's "Sky / Blur Radius"; vanilla values 2, 6, 22, 30, 34,
38, 42; weather imagespaces: strength 0.4–0.9, distance 0–25000, range 2500–27500, radius
2–5, mostly no sky). Two vanilla records
use ENAM instead (14 f32: the HDR values without white and adapt strength, then saturation,
brightness, contrast, 4 unused). Vanilla weather values: speed 35–45, radius 7, threshold
0.5–0.75, scale 3–5.5, receive 0.2–0.65, white 0.875–1, sunlight scale 2–3, sky scale 0–0.1,
strength 5–8; saturation 1.4–2.3, brightness 1.1–1.4, contrast 1.4–1.55, tint 0.4–0.8.

Where they apply: a weather's IMSP per time of day (blended with the time-of-day weights and
across weather transitions); an interior's XCIM, else DefaultImageSpaceInterior (`0x160`;
728 of 761 vanilla interiors have their own).

**The HDR shader** (`src/render/post.ts`), reconstructed from Community Shaders' ISHDR.hlsl,
which reproduces the vanilla shader:

1. Eye adaptation: the scene's average luminance (Rec. 709 weights, samples clamped to 50)
   is followed by two running averages x and y at different rates; each frame moves an
   average by `rate · Δ`, at least 1/256 and never past the target. The image is multiplied
   by y / x, so adaptation is temporary: brighter for a moment after going into the dark.
2. Tone curve: `L (p L + 1) / (L + 1)` per channel with `p = 1 / white²` (white 1 leaves
   the image unchanged).
3. Bloom: blurred bright parts are added where the image is darker than the receive
   threshold: `c += saturate(receive − c) · bloom`.
4. Grading: `brightness · lerp(lerp(lum, c, saturation), lum · tint, tint amount)`, then
   contrast around the adapted luminance x: `lerp(x, c, contrast)`.
5. Fade: `lerp(c, fade colour, fade amount)`, the image-space modifiers' full-screen colour
   (ISHDR's `Fade` constant; 0 without modifiers).

The directional light is multiplied by the imagespace's sunlight scale. Not documented, so
approximated (TODO(M13)): how eye adapt speed and strength become the two rates (here
`1 − e^(−dt · value / 10)` for x and y), how the bright pass uses threshold and scale (here
`max(c − threshold, 0) · scale`, blurred at quarter resolution with σ = radius / 2) and what
sky scale does (not applied).

## Image-space modifiers

**IMAD** (256 in the vanilla load order, `src/world/image-space-modifier.ts`; xEdit
wbDefinitionsTES5.pas, CommonLibSSE `ImageSpaceModifierData` / `TESImageSpaceModifier`;
`node tools/imad-info.ts [editor id]` lists them or samples one). DNAM is 0xF4 bytes:

| Offset | Content                                                                                |
| ------ | -------------------------------------------------------------------------------------- |
| 0x00   | u32 animatable (bool in the first byte)                                                |
| 0x04   | f32 duration (seconds)                                                                 |
| 0x08   | 21 × (u32 mult key count, u32 add key count): channels 0–16 HDR, 17–20 cinematic       |
| 0xB0   | u32 key counts: tint, blur radius, double vision, radial blur strength, ramp up, start |
| 0xC8   | u32 radial blur "use target" (bool)                                                    |
| 0xCC   | f32 radial blur centre x, y (vanilla 0.5, 0.5)                                         |
| 0xD4   | u32 key counts: depth of field strength, distance, range                               |
| 0xE0   | u8 depth of field "use target", u8 depth of field flags, 2 bytes padding               |
| 0xE4   | u32 key counts: radial blur ramp down, down start, fade colour, motion blur strength   |

The counts repeat the subrecords' sizes (equal in every vanilla record), so the keys are read
from the subrecords. Float curves are arrays of (f32 time, f32 value): BNAM blur radius, VNAM
double vision, RNAM/SNAM/UNAM/NAM1/NAM2 radial blur strength, ramp up, start, ramp down, down
start, WNAM/XNAM/YNAM depth of field strength, distance, range, NAM4 full-screen motion blur.
Colour curves are arrays of (f32 time, f32 r, g, b, a): TNAM tint (alpha: the amount), NAM3
fade colour. The multiply/add channels are curves too, under the signatures `chr(i) + "IAD"`
(mult) and `chr(0x40 + i) + "IAD"` (add) for channel i: `\0IAD`/`@IAD` .. `\x14IAD`/`TIAD`.
Channels: 0 eye adapt speed, 1 bloom blur radius, 2 bloom threshold, 3 bloom scale, 4 and 5
"target lum min/max" (Fallout's names; read as receive bloom threshold and white, which sit
there in IMGS HNAM), 6 sunlight scale, 7 sky scale, 8–16 unused (8 read as eye adapt
strength by its HNAM position; only ISMExterior keys 8 and 11–13), 17 saturation, 18
brightness, 19 contrast, 20 unused. TODO(M13): check channels 4, 5 and 8 in the game.

Depth of field flags: bits 0–1 the mode (CommonLibSSE `DepthOfFieldMode`: 0 front and back,
1 front, 2 back, 3 none), bit 2 "no sky", bits 3–5 (xEdit: unknown) read as the blur radius
0–7 of the Creation Kit's form (vanilla 0x00, 0x01, 0x02, 0x0A, 0x20, 0x38; TODO(M13)).

Key times are shares of the duration (0–1): the Creation Kit keeps keys in proportion when
the duration changes (some static records hold stray keys at times 3, 5 or 10). An animatable
modifier plays its keys over its duration; one that is not animatable ignores the duration
(Creation Kit) and stays at its keys at time 0 until removed: ISMTween (`0x434BB`, behind the
menus) is brightness + −0.15, FadeToBlackHoldImod (`0xF756E`) a black fade at alpha 1, while
FadeToBlackImod (animated, 3 s) fades to black and FadeToBlackBackImod (2 s) back. Between
keys the values are linear and held past the ends. LowHealthImod (`0x10C445`): animated, 1 s,
a red tint, blur and radial blur peaking at 0.36.

## Add-on nodes

**ADDN** (92 records, `parseAddonNode` in `src/world/cell-records.ts`): MODL (the attached
model, almost always a master particle system in `meshes\mps\`), DATA i32 (the node index,
unique), DNAM u16 master particle system cap + u16 flags, SNAM (a looping sound; no vanilla
add-on node has one, so playing it is mod support: TODO(M12)). A
mesh's BSValueNode named `AddOnNode<index>` with that value gets the model attached there
(candle flames 49, torch fire 46 and embers 7, fires 24/25, chimney smoke 56; see
[nif.md](nif.md#particles)). The engine shares one master system among all nodes up to the
cap; here every node gets its own copy of the system, which looks the same.

## Decals

**TXST** (`parseTextureSet` in `src/world/decal.ts`): TX00–TX07 texture paths (diffuse,
normal/specular, ...), DNAM u16 flags (`0x1` no specular map, `0x2` facegen textures, `0x4`
model-space normals) and, for decals, **DODT** (36 bytes): min width, max width, min height,
max height, depth, shininess, parallax scale (f32), parallax passes u8, flags u8 (`0x1`
parallax, `0x2` alpha blending, `0x4` alpha testing, `0x8` no subtextures; vanilla values also
set `0x70`), 2 unknown bytes, colour RGBA u8 (multiplies the texture; scorch marks are black).

**Placed decals:** 3210 vanilla REFRs have a TXST base (46 texture sets: blood, scorch marks,
puddles, giant and riekling paint, thieves' shadow marks, snow transitions). Each projects along
its reference's **+Y axis**; the texture spans X (width) and Z (height). Size: between min and
max (4 in 10 placements have a range; chosen by the reference's form id here, width and height
together), times the reference's scale. Without the no-subtextures flag the texture is a 2×2
atlas of variants, one per placement. The references sit 40–120 units in front of the surface
they mark (Dragonsreach basement, Bleak Falls Barrow, Embershard: floors, an altar top, a cave
ramp), so the decal goes onto the first surface along +Y within 512 units, as a ray finds it
against the cell's placed shapes and its landscape (`src/render/decal-projection.ts`). The
engine builds the decal on the whole triangles touching its box, so it runs over steps; here
the box reaches at least half the decal's size along Y. Decals follow their reference's enable
state like other objects. Parallax (no vanilla placed decal uses it): TODO(M13), with the
lighting shader's parallax.

## Directional materials

Snow, ash, moss, ice and the Falmer glow that the engine lays over the upward-facing parts of
statics (`src/world/material-object.ts`, `node tools/material-info.ts [editor id]`). Sources:
CommonLibSSE-NG (`BSMaterialObject::DIRECTIONAL_DATA`, `TESObjectSTATData`), Nukem9's
decompiled `BSLightingShader` (constant setup) and Community Shaders' near-vanilla
Lighting.hlsl (v0.7.4, the pixel shader).

**STAT DNAM** (8 or 12 bytes): f32 max angle (30–120 in the CK), MATO form id, SSE: u32 flags
(`0x1` "considered snow": the snow shader's mask, rim light and sparkles). About 2,600 vanilla
statics name a material (SnowMaterialObject1P 691, IceShader01 839, SnowMaterialObjectLight1P
169, the Falmer glows 211); 69 only count as snow.

**MATO DATA** (52 bytes; 48 in the DLCs, without the flags): f32 falloff scale, falloff bias,
noise UV scale, material UV scale, projection vector (3 × f32), normal dampener, single-pass
colour (3 × f32, 0..1), i32 single pass, u32 flags (`0x1` snow; no vanilla record sets it).
**DNAM** (repeated): the material's properties as complete embedded NIF files (Gamebryo
20.2.0.7, BS version 100 or 83): a BSLightingShaderProperty (with its texture set) or a
BSEffectShaderProperty, and an NiAlphaProperty. MODL is only the editor's preview.

- **Single pass** (all snow and ash `…1P`, VolcanicSulfurCrystalsLite): the static's own
  lighting shapes blend to the material. The engine's ProjectedUVParams come from an NiColorA
  (r, g, b, a) as x = (1 − a)·r, z = b, w = (1 − a)·g + a; here r = falloff scale, g = falloff
  bias, b = 1 / noise UV scale and a = cos(max angle) (inferred: at 90° the material's values
  apply unchanged, the "Light" variants use smaller angles for less cover, larger angles cover
  more). A pixel gets the material where `dot(n, up) · vertex alpha − x · noise − w > 0`, with
  the mapped normal `n` and `textures\effects\projectednoise.dds` at z × (world y, −world x).
  With bEnableProjecteUVDiffuseNormals (on in the launcher presets) the colour is
  `projecteddiffuse.dds` (at 0.2 × the noise coordinates, fProjectedUVDiffuseNormalTilingScale)
  times the single-pass colour, blended in by smoothstep(saturate(5 · (0.1 + weight))); the
  projected normal maps only feed the screen-space normals. The projection vector is unused.
- **Multi-pass** (IceShader01, the glacier and ice-wall snow, the Falmer glows): the engine
  turns the static into a BSMultiIndexTriShape whose extra index list holds the triangles
  facing against the projection vector within the max angle, and draws them again with the
  material's shader, always with the multi-index snow (sparkle) technique: its diffuse texture
  at (1 / material UV scale) × the projected coordinates, its normal map at the mesh's UVs
  flattened by the normal dampener, cut off where the weight above is negative, and sparkle
  glints from `projectednormal.dds` (SparkleParams of a type 14 shader, else 1). An effect
  shader as material (VolcanicSulfurCrystals, not placed) shows where
  `dot(normal, direction) > 0.4 + 0.2 · noise`.
- **Object LOD**: shapes named `objsnow` / `objsnowHD` get SnowLODMaterial (Skyrim.esm
  `0x050372`, at fLODSnowThresholdAngle 100°) and SnowLODMaterialHD (`0x06ae38`, at
  fHDLODSnowThresholdAngle 87°), `objash` / `objashHD` on Solstheim AshLODMaterialMtns1P
  (Dragonborn.esm `0x032720`). No record refers to them. HD shapes add
  (vertex alpha − 0.5) × 2.5 to the weight (their vertex alpha is 0.38–0.5).

## Scripts and conditions

**VMAD** (scripts attached to a record): i16 version (5), i16 object format (1: form id, alias,
unused; 2: unused, alias, form id), u16 script count; per script a wstring name, a status byte
(version ≥ 4) and its properties (wstring name, u8 type, status byte, value). Types: 1 object,
2 wstring, 3 int, 4 float, 5 bool, 11–15 arrays of those (u32 count). After the scripts:

- INFO: u8 (2), u8 flags (0x1 begin, 0x2 end fragment), wstring fragment script, then per
  flag u8, wstring script, wstring function.
- QUST: u8 (2), u16 fragment count, wstring fragment script, per fragment u16 stage, i16, i32
  log entry, u8, wstring script, wstring function; then u16 alias count, each with an object
  value (its alias id), i16 version, i16 object format and its own scripts.
- PERK (xEdit's wbScriptFragmentsPerk): u8 (2), wstring fragment script, u16 fragment count,
  per fragment u16 index (an entry point's EPF3 fragment), i16, u8, wstring script, wstring
  function (`Fragment_N`, N not the index: the VampireFeed perk's index 1 is Fragment_15). The
  13 vanilla PERK VMADs all read.

The fragment script is also listed among the scripts with its property values. The index of
which forms each INFO/QUST script names (`src/world/script-references.ts`) reads only INFO and
QUST records: about 125 ms for all vanilla plugins.

**CTDA** (conditions, 32 bytes): u8 operator (high 3 bits: `== != > >= < <=`) and flags
(0x01 OR, 0x04 compare with a global), float comparison value (or global form id), u16
function index, u16 padding, param 1, param 2, u32 run-on, reference, i32 param 3. A following
CIS1/CIS2 holds a string parameter (e.g. the variable for `GetVMQuestVariable`, function 629).
Function names by index: `src/scripting/condition-functions.ts` (UESP's list, 734). Run-on 7
(event data) names the event member in param 3: two letters (`R1`, `L1`, ...). **GetEventData**
(576) packs its event function in param 1's low 16 bits (0 GetIsID, 1 IsInList, 2 GetValue,
3 HasKeyword, 4 GetItemValue) and the member's two letters in its high 16 bits (`K1` keyword,
`L1`/`L2` locations, `R1`/`R2` references, `V1`/`V2` values, `O1` an object form); param 2
is the data (a form). Functions that take an alias (GetIsAliasRef, GetInCurrentLocAlias, ...)
take its id in param 1; GetActorValue and its kin the actor value index.
OR-flagged conditions join the next one into a group; all groups must hold. Recipes use
`GetItemCount` (47, on the player), `GetGlobalValue` (74), `GetVMQuestVariable` (629) and
`GetInCurrentLoc` (359).

**Quest aliases:** ALST starts a reference alias, ALLS a location alias (u32 id); ALFR / ALFL
give its forced reference / location.

**Scripts of placed references:** a reference runs the scripts of its own VMAD and of its base
(TrapOilPool on a toggleable fire beside the base's DLC1VCEmberToggleScript). 827 scripts on
placeable bases handle OnCellLoad, OnLoad, OnCellAttach or OnInit, e.g.
RemovableTorchSconce01SCRIPT, which on cell load puts a torch in its sconce (PlaceAtMe of
RemovableTorch01) and enables its linked chain (the torch's light), or DLC1VCEmberToggleScript,
which disables a toggleable fire's light. The script runtime runs them as their cells load,
with the natives they call (PlaceAtMe, EnableLinkChain, PlayAnimation into the object's
behavior graph, ...): sconces get their torches, lights go on and off as the scripts say
([scripting.md](../scripting.md), "The world").

## Collision layers

COLL records (`src/physics/collision-layers.ts`): EDID, DESC, BNAM index u32 (the SkyrimLayer a
HavokFilter names), FNAM debug colour, GNAM flags u32 (`0x1` trigger volume, `0x2` sensor, `0x4`
navmesh obstacle), MNAM name, INTV interactables count, CNAM the layers it collides with (form
ids). SSE has 55 (indices 0–54); the lists are symmetric. A pair collides if either lists the
other. The character controller is L_CHARCONTROLLER (30); it collides with static, anim
static, clutter, trees, props, terrain, ground, invisible walls, collision boxes and the stair
helpers (31, which collide with nothing else). Ray and shape queries take the layer of what
asks: the camera L_CAMERA (39), the crosshair L_ITEMPICKER (40).

## Material types

MATT (`src/world/material-type.ts`): EDID, PNAM parent, MNAM name ("StairsStone"), CNAM Havok
display colour, BNAM buoyancy f32, FNAM flags u32 (`0x1` stairs, `0x2` arrows stick), HNAM
impact data set. Collision shapes name their material by an id: the CRC-32 (table 0xEDB88320,
start 0, **no final inversion**) of the lower-case MNAM, e.g. "stairsstone" → 899511101. On
surfaces of a material with the stairs flag the character controller climbs whole steps (the
vanilla stair meshes have risers of 16 and 24 units).

## Impacts

**IPDS** (impact data set, 313; `src/world/impact-records.ts`): PNAM entries of 8 bytes,
a material (MATT) and the impact (IPCT) for hitting it. Named by MATT HNAM (50 of 80
materials; physics impacts), WEAP INAM (a weapon's hits and its arrows'; fists the race's
NAM5) and BIDS (blocks and bashes), MGEF's impact data (a spell's impact), EXPL's (where an
explosion bursts), HAZD's and the footstep sets (FSTP); the users: `src/shell/combat-impacts.ts`,
`src/shell/magic-projectiles.ts`, `src/shell/actor-sounds.ts`.
**IPCT** (impact, 663): DATA (24 bytes) f32 effect duration, u32 orientation (0 surface
normal, 1 projectile vector, 2 projectile reflection), f32 angle threshold (degrees), f32
placement radius, u32 sound level (0 loud, 1 normal, 2 silent, 3 very loud), u32 flags (0x1 no
decal data); DODT decal data, DNAM / ENAM texture sets, SNAM sound (the light impact's), NAM1
sound 2 (the heavy impact's), NAM2 hazard, MODL effect model. PHYGenericMetalLightImpactSet
(MaterialMetalLight) gives PHYGenericMetalSmallImpact for stone: PHYGenericMetalLightLSD /
PHYGenericMetalLightHSD.

## Footsteps

**FSTS** (footstep set, 52; `src/world/footstep-records.ts`): XCNT five u32 counts, DATA the
footsteps (FSTP form ids) of the five sections in order. Their content says what the sections
are: in every human set (DefaultFootstepSet, FSTArmorLight / Heavy, FSTBarefoot) the impact
sets of the first are named Sneak, of the second Sprint (FootSprintLeft / Right), of the third
Run and of the fourth Walk; the fifth is empty for humans and holds creatures' noises (not the
walk / run forward and alternate names the counts are documented with). **FSTP** (footstep,
191): DATA the impact data set (IPDS), ANAM the animation event it answers. Named by ARMA
**SNDD** (FSTArmorLight 37 addons, DefaultFootstepSet 34, FSTArmorHeavy 15, FSTBarefoot 14,
creatures' own). **LTEX MNAM**: the land texture's material (MATT).

## Movement types

MOVT (`src/world/movement.ts`): EDID, MNAM name (what the behavior graph asks for:
"NPCDefault", "NPCSprinting", "NPCSneaking", "NPCSwimming"), SPED 11 f32 (10 in older
records): left walk, left run, right walk, right run, forward walk, forward run, back walk, back
run (units per second), rotate in place walk, rotate in place run, rotate while moving run
(radians per second); INAM directional, movement speed and rotation speed thresholds. The
player's speeds (NPC_Default_MT): walk 80.1 forward, run 370; back 71.9 / 205.3; sprint 500;
sneak 47.2 / 222. A direction between the four axes moves at the point of the ellipse through
the speeds of its quadrant.

## Doors, arrivals and collision primitives

- **XTEL** (REFR, 32 bytes): destination door, position vec3, rotation vec3 (radians), no alarm
  u32. A load door takes the player to the position and heading in its XTEL; the destination
  door's cell (and that cell's worldspace) is where they arrive. The door's own XTEL is "in front
  of the other door". Opening a worldspace without a destination arrives as the game would
  bring the player in: in front of the load door nearest to the starting cell (the XTEL of the
  door on the other side), else at the nearest map marker (STAT 0x10, where fast travel
  arrives). Interiors arrive in front of their own door. Only doors there at the start of a
  new game count, on both sides: a reference is there if its enable parent is (inverted by the
  XESP flag; along the chain), else unless flagged initially disabled (`enabledAtGameStart`).
- **REFR record flag `0x20000000` "Don't Havok Settle":** a simulated object stays where it was
  placed (even floating) until something touches it; others settle under gravity once their
  cell's collision is complete (the engine's warm start, `[HAVOK] fWarmStartMaxTime`).
- **XPRM** (32 bytes): bounds vec3, colour RGB + f32, type u32 (1 box, 2 sphere, 3 portal box,
  4 line). The bounds are a box's half extents and a sphere's radius in x (observed in the
  original: it makes a box primitive of the three values as they are, and the box holds a point
  within plus or minus each on its axes; a sphere takes x as its radius; a plane x and z, a
  line x with `[Display] fLinePrimitiveWidth`). Taken as full sizes, every trigger and
  collision box was half as wide, deep and tall as the game's: MQ101DASetStage25, the strip
  across Helgen's tower room the player sets stage 25 of MQ101DragonAttack in (330 × 121 × 127),
  was missed by a player standing in the room by Ralof, and the opening stalled there. References to the engine's **CollisionMarker**
  (STAT 0x21) are invisible collision: boxes and spheres on the layer in **XTRI** (u32), else
  L_COLLISIONBOX. RoomMarker, PortalMarker and PlaneMarker primitives are rooms, portals and
  occlusion planes (no collision); activators' primitives are triggers, whose scripts hear
  the player come and go (OnTriggerEnter, OnTriggerLeave; [scripting.md](../scripting.md)).

## Rooms, portals and occluders

Culling markers are references of hard-coded STAT bases (`src/world/cell-rooms.ts`):

- **RoomMarker (0x1F)**: the room's box is XPRM's half extents (XMBO repeats them), placed by
  the reference (rotation and scale). **XRMR**: u8 linked room count, u8 flags (0x40 has
  image space INAM, 0x80 has lighting template LNAM), u16 unused; then one **XLRM** (form id)
  per linked room. Dragonsreach has 9 rooms, Bleak Falls Barrow 34; rooms overlap at doorways.
- **PortalMarker (0x20)**: a rectangle in the reference's local XZ plane, XPRM x and z its half
  width and height (y is 1). **XPOD**: two form ids, the rooms it joins. Every vanilla portal
  checked joins two room markers of its own cell.
- **PlaneMarker (0x17)**: an occluder. In Tamriel round Whiterun they are occlusion boxes
  (XPRM type 1, e.g. 128 × 1126 × 725 half extents): thin walls hiding what is behind them.
- **MultiBoundMarker (0x15)**: XMBO half extents, the box of the references grouped on it.
- LIGH DATA flag **0x2000** is Portal-strict: the light lights only the room it stands in.

## Navigation meshes

**NAVM** (`src/world/navmesh.ts`): where actors walk, a child record of a cell (19,201 in the
vanilla load order). Its **NVNM** field (UESP "NVNM Field"; xEdit `wbNVNM`; OpenMW's ESM4
loader; CommonLibSSE `BSNavmesh`): version u32 (12); a pathing cell: type u32 (0xA5E9A03C,
below), the worldspace (form id, 0 for interiors), then for interiors the cell (form id), for
worldspaces the grid (y i16, x i16; xEdit `wbNVNMParentDecider`: every worldspace, not only
Tamriel; read as a form id, x's high byte is rewritten as a plugin index); vertices (count u32,
then x y z f32 each, in world coordinates); triangles (count u32, then 16 bytes each: three
vertex indices u16, an i16 per edge 0–1, 1–2, 2–0, flags u16, cover u16); edge links (count u32,
then type u32, NAVM form id, triangle u16); door triangles (count u32, then triangle u16, type
u32, door reference form id); cover triangles (count u32, then u16 each); the search grid:
divisor u32, cell size x y f32, bounds min and max (x y z f32 each), then divisor² cells, each a
count u32 and its triangles (u16). Every vanilla NVNM is read to its last byte
(`node tools/navmesh-info.ts --verify`). 8 NVNMs of exterior cells (7 in CWTestHold, one in
DLC01Boneyard) name their CELL with worldspace 0 instead of a grid; NAVI has the grid.

- **Triangle flags** (xEdit; CommonLibSSE `BSNavmeshTriangle`): `0x1`, `0x2`, `0x4` edge 0–1,
  1–2, 2–0 is a link, `0x8` deleted, `0x10` no large creatures, `0x20` overlapping, `0x40`
  preferred, `0x200` water, `0x400` door (2,129 triangles, all in the door list; 3 more flagged
  without a door), `0x800` found.
- **Edges**: without its link flag an edge's i16 is the triangle across it in the same mesh (−1
  for none); with it, an index into the edge links (xEdit `wbEdgeLinksTo`). Vanilla: 233,870
  linked edges for as many links, each link used by exactly one edge, every index in range; the
  triangle across links back for 233,804 (30 do not; 36 links name a triangle beyond the other
  mesh's count). `triangleNeighbour(navmesh, triangle, edge)` returns the local triangle or the
  link.
- **Edge link types** (CommonLibSSE `EDGE_EXTRA_INFO_TYPE`): 0 portal (229,170): the edge goes
  on in another mesh's triangle, never in the same mesh nor into another worldspace; the meshes
  do not share vertices, but the edge lies on an edge of the linked triangle (horizontally within
  1 unit for 97.7 %, within 16 for all but 10; heights within 32 for 98.9 %). 1 ledge up and 2
  ledge down (2,350 each, in pairs, 1,930 within the same mesh): a jump from a lower edge up onto
  the triangle on top, and the drop back. 3 enable/disable portal: none. The edge link on disk
  has no edge of the other triangle (the engine's `BSNavmeshTriangleEdgePortal` does).
- **Type hashes**: the u32 before a pathing cell (always 0xA5E9A03C) and a door (always
  0xE48B73F3) is the engine's class: CRC-32 of `PathingCell`, `PathingDoor` with initial value 0
  and no final XOR (xEdit `wbCRCValuesEnum`; SNDR's 0x1EEF540A is `BGSStandardSoundDef` alike).
- **Cover** (xEdit's note on `wbNavmeshCoverFlags`; CommonLibSSE `TraversalFlag`): edge 0–1 in
  bits 0–5, edge 1–2 in bits 6–11 (edge 2–0 has none): a 4-bit value (0 open, 1 wall without
  cover, 2 ledge, 3 unused, 4–14 cover value × 16 units high, 15 full cover), then 0x10 left and
  0x20 right; 0x4000 generated by the Creation Kit; bits 12, 13 and 15 never set. Vanilla:
  600,446 edges with a value (592,194 of them with nothing across: where the mesh ends at a wall
  or ledge; ledge 88,767, full cover 155,968, value 1 seven times, 3 never). The cover triangles
  are those with a value on either edge (572,998; 7 more are not listed); 28,702 have only
  0x4000.

## Navmesh info map

**NAVI** (`src/world/navmesh-info.ts`; xEdit `NAVI`; CommonLibSSE `NavMeshInfoMap`,
`BSNavmeshInfo`, `BSPrecomputedNavmeshInfoPathMap`): one record, 0x12FB4, which every plugin
that touches navmeshes overrides (8 of the 10 vanilla plugins; not Curios and \_ResourcePack).
The versions are merged in load order: a plugin's entries replace those before it navmesh by
navmesh (`node tools/navmesh-info.ts --navi`).

- **NVER** u32: 12.
- **NVMI**, one per navmesh: NAVM form id; flags u32; location (x y z f32: the middle of its
  vertices, within 1 unit for 18,694 of 18,696); preferred f32 (the share of its triangles
  flagged preferred, 0–1; within 0.001 for 18,687); edge links and preferred edge links (each a
  count u32 and NAVM form ids); door links (count u32, then type u32 0xE48B73F3 and the door
  reference); island data (u8 present, then bounds min and max x y z f32, triangles: count u32
  and three u16 each, vertices: count u32 and x y z f32 each); a pathing cell as in NVNM (type,
  worldspace, cell or grid; the NAVM sits in that cell or worldspace for all 18,696).
- **Links**: edge and preferred edge links together are exactly the other navmeshes the NVNM's
  edge links lead into, portals and ledges (18,696 of 18,696); the preferred ones are those
  reached over an edge of a preferred triangle, the plain ones the rest (never both; the engine
  keeps one array, `adjacentMeshesArray`, the preferred from `preferredStartIndex` on). Door
  links are the NVNM's door references (18,696 of 18,696).
- **Flags**: 0x20 (xEdit "Is Island") exactly when island data follows (10,290 entries); 0x40
  (xEdit "Not Edited") on exactly the 10 road markers' navmeshes. Island data is a coarse copy
  of the navmesh (fewer triangles for 8,361, as many for 1,928); what makes the Creation Kit
  store it is not documented: not missing links (6,978 of them have edge links).
- **NVPP** (precomputed paths): paths (count u32, then each a count u32 and NAVM form ids) and
  road markers (count u32, then NAVM form id and index u32). With m markers the paths are an m
  × m matrix: path `from × m + to` runs from marker `from`'s navmesh to marker `to`'s (100 of
  100), each step to an edge-linked navmesh (6,202 of 6,202, about a cell: median 3,940 units).
  Vanilla: 10 markers in Tamriel, 100 paths of 1–129 navmeshes (6,302 in all); every plugin
  carries the same paths, with markers and matrix in another order.
- **NVSI**: form ids (to the end of the field) of navmeshes the plugin deletes; they leave the
  map. Vanilla: 71 (Update 6, Dawnguard 59, HearthFires 5, Dragonborn 1), each a deleted NAVM
  record without NVNM.
- Vanilla entries per plugin: Skyrim.esm 15,462, Update 313, Dawnguard 1,873, HearthFires 132,
  Dragonborn 1,732, the three Creation Club masters 13, 11 and 13; merged 18,697 navmeshes. The
  505 NAVMs of `NavMeshGenCellDUPLICATE001` (a scratch cell) have no entry; one entry (0x28E37)
  has no NAVM.

**The navmesh graph** (`src/world/navmesh-graph.ts`; `node tools/navmesh-info.ts --graph`): a
node per entry with its neighbours (its edge links into navmeshes the map has; symmetric but
for 5) and doors. A door leads (REFR XTEL) to its destination door and on to the navmeshes with
that door on them (2,113 of the 2,162 door links), else to the navmesh under the arrival point
(XTEL's position, within 256 units in height: 27). 22 lead nowhere: their arrival point lies
off every navmesh, 17–2,230 units from the nearest triangle (11 exits into Tamriel, 5 into the
test cells CTest and E3demoBleakFallsBarrow); the routes (`src/ai/routes.ts`, docs/ai.md,
"Routes") lead through such a door to the navmesh nearest its arrival point. TODO(M13): how the
engine paths through it is not documented. The engine keeps a location on either side of a door
(CommonLibSSE `PathingDoor` forward and backward locations); the arrival point stands in for the
far one: for 2,110 of the 2,113 the navmesh there is the one with the destination door.
Vanilla: 4,270 connected components (edges and doors taken either way); 3,419 navmeshes with
neither edges nor doors (598 interior, 2,252 in Tamriel). The largest component, 12,591
navmeshes: Tamriel 9,408 of its 13,011 (which fall in 2,720 components), Solstheim 1,379 of
1,517, 738 interior navmeshes, Falmer Valley 214, Soul Cairn 182, Blackreach 118 and the city
worldspaces. Interiors: 1,386 navmeshes in 742 cells; 754 (654 cells) reach a worldspace
through doors, 738 (643 cells) Tamriel's main component. Sovngarde (864 navmeshes, 286
components) and Skuldafn are not reached from it through doors.

## Sounds

Records behind every sound (`src/world/sound-records.ts`; files: [audio.md](audio.md)):

- **SNDR** (sound descriptor, 3186): CNAM type (always 0x1EEF540A, standard), GNAM category
  (SNCT), SNAM the descriptor it replaces when its conditions hold, **ANAM** file names (one per
  file; one is picked at random), ONAM output model (SOPM), CTDA conditions, **LNAM** (u8, u8
  looping: 0 none, 8 loop, 16 envelope fast, 32 envelope slow; u8, u8 rumble), **BNAM** (s8
  frequency shift %, s8 frequency variance %, u8 priority, u8 dB variance, u16 static
  attenuation in dB × 100). Older records (63) have FNAM flags instead (bit 4: loop). Looping
  plays the file's loop region (`smpl`, else the whole file) until stopped; with an envelope
  the part before the loop is the attack and the part after it the release: stopping an
  envelope-fast sound jumps to the release, an envelope-slow one finishes its pass through the
  loop and plays on into the release (Creation Kit wiki).
- **File names** are stored as the editor saw them: `Data\Sound\FX\...\x.wav` (4917),
  `fx\...` (1138), `\Data\...`, even `c:\...\data\sound\...`: the path is what follows
  `data\`, under `sound\` (`music\` for music tracks). The engine also takes the other
  extension: music tracks name `.wav`, the files are `.xwm`. 6322 of the 6372 vanilla names
  resolve; 50 point at files never shipped (they play nothing).
- **SOPM** (output model): NAM1 (u8 flags: 0x1 attenuates with distance, 0x2 rumble; u8, u8; u8
  reverb send %), MNAM (u32: 0 3D with HRTF, 1 fixed speaker levels), ONAM (speaker levels
  0–100 for mono, stereo-left and stereo-right input: L R C LFE RL RR BL BR), **ANAM** (4
  unused bytes, f32 min distance, f32 max distance, 5 × u8 curve, 3 bytes). The curve is the
  volume in percent at five points from the minimum to the maximum distance (`100,50,20,5,0`
  for most sounds, `0,50,100,50,0` for distant layers that are quiet close by); beyond the
  maximum a sound is inaudible (CommonLibSSE: DoGetAudibility). How the engine spaces the five
  points is not documented: here evenly, interpolated linearly (TODO(M13): compare with the
  game).
- **SNCT** (category): FULL, FNAM (0x1 mute when submerged, 0x2 has a settings slider), PNAM
  parent, VNAM volume (u16 / 65535), UNAM the slider's default. Vanilla's tree:
  `_AudioCategoryMaster` (0.9) → PausedDuringMenuLoad → SFX (0.9) → SFXFadeDuringDialogue →
  FST, FSTnpc (0.7), AMB, NPCKillMove, PausedDuringMenuFade → MAG, AMBr, MuteSubmerged;
  master → PausedDuringMenu → VOCGeneral (0.9) → VOC, NonVOC; master → MUS (0.7); SFX → UI.
- **SOUN** (sound marker): SDSC, the descriptor a placed marker plays.
- **ASPC** (acoustic space): object bounds, SNAM ambient loop (SNDR), RDAT region whose sounds
  play (interiors), BNAM reverb (REVB). Cells name theirs in XCAS; exterior areas are placed
  ASPC references (their bounds).
- **REVB** (reverb): DATA (14 bytes) = XAudio2's I3DL2 parameters: u16 decay time ms, u16 HF
  reference Hz, s8 room dB, s8 room HF dB, s8 reflections dB, s8 reverb dB, u8 decay HF ratio
  × 100, u8 reflections delay ("scaled"), u8 reverb delay ms, u8 diffusion %, u8 density %, u8.
  DefaultReverb has everything at −100 dB (none).

## Music

- **MUSC** (music type, 64): FNAM flags (0x01 plays one selection, 0x02 abrupt transition,
  0x04 cycle tracks, 0x08 maintain track order, 0x20 ducks the current track, 0x40 does not
  queue), PNAM (u16 priority, u16 ducking dB × 100), WNAM f32 fade duration, TNAM tracks
  (MUST).
- **MUST** (music track, 309): CNAM type (0x6ED7E048 single track 283, 0x23F678C3 palette 21,
  0xA1A9C4D5 silent track 5), FLTV duration (silent tracks), DNAM fade-out, ANAM the file, BNAM
  the finale (what combat music ends with), LNAM loop (f32 start, f32 end, u32 count), FNAM cue
  points (f32 seconds: where a track may be left), CITC + CTDA conditions (day, night, ...),
  SNAM a palette's tracks: its layers, separated by NULL entries (the exploration palettes have
  two, A and B, each single pieces and `_MUSExploreSILENT10/15` silences; duration 120 s,
  fade-out 15 s).
- Priority: the lower the number, the more important (combat 2, discoveries 3, exploration 49,
  dungeons 50, taverns 55). Conditions use GetCurrentTime (86), GetIsCurrentWeather (48) and
  GetCombatTargetHasKeyword (707, combat against dragons: the player's combat target's keywords,
  `src/shell/combat-target-keywords.ts`; `src/audio/sound-conditions.ts`).
- Where music comes from: cells (XCMO; 667 of 761 interiors, Breezehome MUSTownTest),
  regions (RDMO under a sound RDAT), worldspaces (ZNAM: Tamriel `_NONE`, the city worlds
  MUSTownTest, Blackreach MUSDungeonIce), else the default object DFMS (MUSExploreTestb).
  `tools/music-info.ts` lists them.

## Actors

What a placed actor (ACHR) looks like (`src/world/actor-records.ts`, `actors.ts`; check:
`node tools/actor-info.ts --audit`: all 12945 vanilla placements resolve, three name FaceGen
files the data lacks).

**NPC\_:** ACBS 24 bytes: flags u32 (0x1 female, 0x2 essential, 0x20 unique, 0x80 PC level
multiplier, ...), magicka and stamina offsets i16, level u16 (×1000 multiplier with 0x80), calc
min / max level, speed multiplier, disposition, **template flags** u16 at 18 (0x1 traits, 0x2
stats, 0x4 factions, 0x8 spells, 0x10 AI data, 0x20 AI packages, 0x80 base data, 0x100
inventory, 0x200 script, 0x400 default package list, 0x800 attack data, 0x1000 keywords),
health offset, bleedout override. TPLT template (NPC_ or LVLN), RNAM race, WNAM own skin
(ARMO), DOFT / SOFT default and sleep outfit, PNAM head parts (HDPT, repeated), HCLF hair colour
(CLFM), FTST head texture set, QNAM skin tone (3 × f32, 0..1), NAM6 height multiplier, NAM7
weight (0..100), NAM9 face morphs (18 f32 + 4 bytes), NAMA face parts, CNTO inventory (form id,
count), tint layers TINI / TINC / TINV / TIAS, PKID AI packages (PACK, repeated, in order), SNAM
factions (form id, rank i8, 3 unused). ACHR record flag 0x200: the actor starts dead.
Its stats (`src/world/actor-stats-records.ts`): **DNAM** 52 bytes: the 18 skills u8 (actor
values 6..23: one-handed .. enchanting), their 18 offsets u8, health, magicka, stamina u16 (as
the Creation Kit calculated them: base from race, class and level, plus the offset), unused
u16, far away model distance f32, geared up weapons u8. **AIDT** 20 bytes: aggression,
confidence, energy, morality, mood, assistance u8 (actor values 0..5), flags u8 (0x1 aggro
radius), unused, warn / warn-or-attack / attack radii u32. CNAM class, SPLO spells and shouts,
PRKR perks (form id, rank u8, 3 unused), CRIF crime faction, INAM death item, KWDA keywords,
ZNAM combat style, GNAM gift filter. Actor values by index: `src/world/actor-values.ts`
(UESP's "Actor Value Indices", 164).

**RELA** DATA 16 bytes: parent NPC\_, child NPC\_, rank u16 (0 lover .. 8 archnemesis; scripts'
GetRelationshipRank gives 4 − it), flags u16 (0x8000 secret), association type (ASTP).
**FACT** XNAM per other faction: form id, modifier i32, combat reaction u32 (0 neutral, 1 enemy,
2 ally, 3 friend).

**RACE:** DATA (128 or 164 bytes): 7 skill / bonus pairs (actor value u8, 0xFF none; bonus i8),
height male / female (f32 at 16, 20), weight (24, 28), flags u32 at 32 (0x1 playable, 0x2
FaceGen head, 0x4 child, ...), starting health, magicka, stamina, base carry weight, base mass
(f32 at 36..52), acceleration, deceleration, size u32 at 64, ..., health, magicka and stamina
regeneration (f32 at 84, 88, 92), unarmed damage and reach (96, 100). SPLO racial abilities.
WNAM skin.
Zero-length MNAM / FNAM mark the male and female half of what follows: at the top **ANAM**
the skeleton (`Actors\Character\Character Assets\skeleton.nif`); after NAM1 the body egt
models; after **NAM3** MODL the behavior project (`Actors\Character\DefaultMale.hkx`); after
NAM0 the head data (HEAD default head parts, DFTM / DFTF default face texture, presets, hair
colours, tints). HCLF default hair colour (2 form ids), RNAM armor race, NAM8 morph race.

**Combat and movement** (`src/ai/race-combat-records.ts`; `node tools/combat-info.ts --race
NordRace`, `--audit`: every vanilla RACE and NPC\_ reads without a problem). RACE DATA (all 171
vanilla ones 164 bytes) further: acceleration and deceleration rate f32 at 56, 60; size u32 at
64 (0 small 19 races, 1 medium 130, 2 large 11, 3 extra large 11); head, hair, shield biped
object i32 at 68, 72, 80 and body at 104 (slot − 30, −1 none); injured health fraction f32 at
76; aim angle tolerance at 108, flight radius 112 (UESP: unknown; DragonRace 400), angular
acceleration rate 116, angular tolerance 120; Flags 2 u32 at 124 (0x1 use advanced avoidance:
90 races, 0x2 non-hostile 13, 0x10 allow mounted combat 3); mount, dismount and mount camera
offset (3 × vec3 at 128; xEdit's defaults without them). The flags at 32 go on past the look's:
0x200 immobile, 0x400 not pushable, 0x800 no combat in water, 0x80000 regenerates health in
combat, 0x100000 can't open doors, 0x400000 no knockdowns, 0x40000000 can dual wield,
0x80000000 avoids roads, ... (`RaceAiFlag`); record flag 0x80000 ("critter?") on 10 races.
**ATKD** (44 bytes) and **ATKE** (the behavior graph event, right after it), one pair per
attack: damage mult, attack chance, attack spell (SPEL / SHOU), flags u32 (0x1 ignore weapon,
0x2 bash, 0x4 power, 0x8 left: every left-hand event has it, CommonLibSSE's "charge" does not
fit; 0x10 rotating, 0x80000000 override data), attack angle and strike angle (degrees:
attackStart_MC_1HMLeft −90 / 85), stagger, attack type (KYWD: PowerAttackTypeForward, ...),
knockdown, recovery time, stamina mult. Vanilla: 2155 attacks on 165 races, 202 events
(bashStart on 85 races, AttackStartH2HRight 54, ...), 667 with an attack type, 230 with a spell.
ATKR: the race whose attacks it uses (only DLC1LD_ForgemasterRace: DwarvenCenturionRace).
**WKMV / RNMV / SWMV / FLMV / SNMV / SPMV:** the walk, run, swim, fly, sneak and sprint MOVT
(82, 80, 16, 6, 9 and 2 races; the default objects DMWL .. DMSP name NPC_Default_MT,
NPC_Swimming_MT, NPC_Sneaking_MT and AIControlledNPC_Sprinting_MT); **MTYP + SPED** (the 11
floats of MOVT's SPED): the race's own speeds of a movement type (11 on 10 races). **VNAM**
equipment flags u32 (0x1 hand to hand, 0x2 .. 0x40 the one- and two-handed weapons, 0x80 bow,
0x100 staff, 0x200 spell, 0x400 shield, 0x800 torch, 0x1000 crossbow; bits 13+ are set).
**NPC\_** further: ATKR (1040 NPC\_, 708 naming their own race), ATKD / ATKE overriding the
race's attack of that event (124 NPC\_, all vampires: attackPowerStartForward, power and
override data, damage 3), the override package lists (FLST) SPOR spectator, OCOR observe
corpse, GWOR guard warn, ECOR combat (2, 0, 0 and 235 NPC\_; 59 combat lists) and DPLT the
default package list (3220 NPC\_, 15 lists, DefaultMasterPackageList on 2618). With a template,
ATKR and ATKD come from it under template flag 0x800, the package lists under 0x400, ZNAM under
0x10 (UESP). Quest aliases carry their own SPOR / OCOR / GWOR / ECOR after their ALST (3, 2, 2 and 265
vanilla); WEAP VNAM is the weapon's detection sound level (0 loud, 1 normal, 2 silent) and MGEF
DATA at 140 the casting sound level (3 very loud) (`src/ai/detection-records.ts`).

**ARMO:** BOD2 (slots u32, armor type u32) or the older BODT (slots u32, flags u8 + 3 unused,
armor type u32), MODL armor addons (ARMA, repeated), TNAM template armor. **ARMA:** BODT /
BOD2, RNAM primary race, MODL further races (repeated), DNAM 12 bytes: priority male u8,
female u8, weight slider male u8, female u8 (0x2: `_0` and `_1` models blended by weight),
2 unknown, detection sound value u8, unknown u8, weapon adjust f32; MOD2 / MOD3 world model
male / female (MOD2 for both without MOD3), MOD4 / MOD5 first person; MO2S..MO5S texture swaps
(count u32, then per swap the shape name as u32 length + text, the TXST and the shape index
u32); NAM0..NAM3 skin texture sets (male, female, first person male, female). **OTFT** INAM:
form ids (ARMO or LVLI). **LVLN / LVLI:** LVLD chance none u8, LVLF flags u8 (0x1 all levels
up to the actor's, 0x2 each item of the count, LVLI 0x4 use all), LVLG chance global, LVLO
12 bytes (level u16, unused u16, form id, count u16, unused u16). **CLFM** CNAM RGBA bytes.
**HDPT:** PNAM type (0 misc, 1 face, 2 eyes, 3 hair, 4 facial hair, 5 scar, 6 eyebrows), HNAM
extra parts, NAM0 / NAM1 pairs: a u32 file type (0 race morph, 1 Tri: the expressions; 2
chargen morph) and its TRI file (under meshes\), MODL, TNAM texture set, CNAM colour, RNAM
valid races. NPC\_ **VTCK** names the voice type (VTYP): its editor id is the folder of the
actor's spoken lines, `sound\voice\<plugin>\<voice type>\`; FULL the name (of the
NPC\_ its base data comes from, template flag 0x80).

**Resolving a look:** a leveled base picks one entry: of those up to the actor's level, the
highest level's (or any, with flag 0x1), at random (seeded by the reference, so a reference
always looks the same; at the level of its encounter zone or the player, by its level modifier: docs/gameplay.md). Each leveled
list on the template chain is picked once per actor (`src/world/actor-templates.ts`), so its
look and what its scripts see (stats, factions, spells) come from the same picks. Traits
(race, sex, head, skin, colours, size) come from the end of the template chain while the
traits flag is set, the outfit while the inventory flag is. An armor wears the addons that fit
the race (RNAM or MODL), else those of the race's armor race; one without addons takes its
template's. Each biped slot belongs to one armor addon (the higher priority, then the later
piece); a piece shows when it owns its first slot (TODO(M13): the engine's assignment is not
documented), the skin (the actor's WNAM, else the race's) where armor leaves its first slot
free. Within every shown model, a BSDismemberSkinInstance partition is hidden when its slot
belongs to another piece: a cuirass's forearms under long gauntlets, the head's hair (131, 141) under a helmet on slot 31, the whole head (130, 230) under one on slot 30. Size: race
height × NAM6, times the reference's scale.

**FaceGen:** races with the FaceGen head flag show a prebuilt head per actor base (of the
traits NPC_): `meshes\actors\character\facegendata\facegeom\<plugin>\<id>.nif` and the tint
`textures\...\facetint\<plugin>\<id>.dds`, the plugin that defines the form and its id
without the mod index (8 hex digits). The head NIF holds every head part as a skinned
BSDynamicTriShape under BSFaceGenNiNodeSkinned, named after the head part's editor id; its
expression TRI (the Tri file of that HDPT, found among the NPC's PNAM parts, its race's default
head parts and the parts they bring along) has the same vertices in the same order. The head
is baked with the actor's weight: its neck seam meets the body blended at that weight
closer than with the TRI's SkinnyMorph applied again (measured on light NPCs: 1.9 against 2.1
units, 2.3 for the heaviest body), so SkinnyMorph is left to heads made at run time (the
player's).

## Character creation

What the race menu edits (`src/world/chargen-records.ts`, `src/gameplay/chargen.ts`,
`chargen-catalog.ts`, `chargen-morphs.ts`; check: `node tools/chargen-info.ts NordRace m`,
`tests/chargen.int.test.ts` rebuilds vanilla NPC heads and face tints from their records).

**RACE head data**, once per sex: `NAM0` then a zero-length `MNAM` (male) or `FNAM` (female),
then INDX u32 + HEAD default head part pairs; four **MPAI** u32 (0 nose, 1 brow, 2 eyes, 3
lips) each followed by **MPAV** (32 bytes = 8 u32): bit n of the words = type n offered (eye
types run into the second word: bit 0 there is type 32). Only bits below the GMST counts
(iNoseMorphCount 31, iBrowMorphCount 20, iEyeMorphCount 38, iLipMorphCount 31) mean anything;
unused bits are 1 (NordRace male nose 0x001fff3e: types 1–5, 8–20; eyes 0x001ffe3e +
0xffffff80). **RPRM / RPRF** face presets (NPC\_, ACBS flag 0x4; 10 per sex for every playable
race), **AHCM / AHCF** hair colours (CLFM), **FTSM / FTSF** complexions (TXST; TX04 is the
face detail map), **DFTM / DFTF** the default one. Then the **tint layers**: TINI u16 index,
TINT mask path (under `textures\`; absent on 4 vanilla layers), TINP u16 mask type (absent:
not editable; 1 lip colour, 2 cheek, 3 eyeliner, 4 eye socket upper, 5 lower, 6 skin tone, 7
war paint, 8 laugh lines, 9 cheek lower, 10 nose, 11 chin, 12 neck, 13 forehead, 14 dirt),
TIND default colour (CLFM, often absent), then presets of TINC colour (CLFM) + TINV **f32**
default value + TIRS u16 id (every vanilla TINC has its TINV and TIRS). Top level: FULL and
DESC (lstrings, the menu's description), DATA flags 0x1 playable (the ten vanilla races; not
the vampire races), HCLF the default hair colour of male and female (2 form ids), TINL the
total tint count, NAM8 the race whose race morph the head parts use.

**NPC\_ face:** **NAM9** 76 bytes: 18 f32 in −1..1 and 4 bytes (0 or 0x7F7FFFFF). **NAMA** 4
i32: nose type, unknown (−1), eye type, mouth type. Tint layers **TINI** u16 (the race layer),
**TINC** 4 bytes RGBA (alpha unused), **TINV i32** = value × 100 (unlike RACE's f32), **TIAS**
i16 = the race preset's TIRS (−1 none). QNAM (skin tone, 3 f32 0..1) is the skin tone layer's
colour (MQ101ImperialSoldierUnaggressive02: 0.718, 0.612, 0.569 = TINC b7 9c 91); the Player
record has no skin tone layer, only QNAM. **HDPT DATA** u8: 0x1 playable, 0x2 male, 0x4
female, 0x8 extra part (only with another part's HNAM), 0x10 use solid tint; **RNAM** a FLST of
the races that may choose it. The menu's list of a type: playable, of the sex, not an extra
part, the race in RNAM (NordRace male: eyes 22, hair 29, facial hair 46, scars 13, brows 12).

**Head shape** (fitted on the baked FaceGen heads, then rebuilt exactly): a head part's shape
is its model's own positions (the BSDynamicTriShape of its NIF; the TRI files' base meshes
differ from it by up to 0.48 units, MaleHeadNord 0.055, FemaleHeadNord 0.22) plus, from its
TRI files (HDPT NAM0 0 race, 2 chargen, 1 expressions; same vertex order), by morph name
(case-insensitive): the race morph named after the race (NAM8's, else its own editor id) at
1; each NAM9 value on one morph of a pair with weight |value|; `NoseType<n>`, `EyesType<n>`,
`LipType<n>` for the NAMA types at 1; `SkinnyMorph` (expression TRI) at 1 − NAM7 / 100. A
part lacking a morph skips it (JawBack is in no male head TRI; type 0 has none).

| NAM9 | slider           | < 0            | > 0              |
| ---- | ---------------- | -------------- | ---------------- |
| 0    | Nose Length      | NoseShort      | NoseLong         |
| 1    | Nose Height      | NoseDown       | NoseUp           |
| 2    | Jaw Height       | **JawUp**      | **JawDown**      |
| 3    | Jaw Width        | JawNarrow      | JawWide          |
| 4    | Jaw Forward      | JawBack        | JawForward       |
| 5    | Cheekbone Height | CheeksDown     | CheeksUp         |
| 6    | Cheekbone Width  | CheeksIn       | CheeksOut        |
| 7    | Eye Height       | EyesMoveDown   | EyesMoveUp       |
| 8    | Eye Width        | EyesMoveIn     | EyesMoveOut      |
| 9    | Brow Height      | BrowDown       | BrowUp           |
| 10   | Brow Width       | BrowIn         | BrowOut          |
| 11   | Brow Forward     | BrowBack       | BrowForward      |
| 12   | Mouth Height     | LipMoveDown    | LipMoveUp        |
| 13   | Mouth Forward    | LipMoveIn      | LipMoveOut       |
| 14   | Chin Width       | ChinThin       | ChinWide         |
| 15   | Chin Length      | **ChinMoveUp** | **ChinMoveDown** |
| 16   | Chin Forward     | Overbite       | Underbite        |
| 17   | Eye Depth        | EyesBack       | EyesForward      |

Rows 2 and 15 run against the slider names. UESP's NAM9 list has 6 as "cheeks forward / back"
and 17 as "−1 forward": the fit says otherwise. Rebuilt heads of three Nord men and two Nord
women match the FaceGen heads within 0.04 units (head, mouth, eyes, brows, hair, hairline; 0
for eyes and mouths). TODO(M13): beards stay up to 0.08 off, and no combination of their morphs
fits better than 0.06.

**Face tint** (FaceGen shader slot 6; baked as `facetint\<plugin>\<id>.dds`, 512×512 BC3): the
actor's tint layers in stored (ascending TINI) order, each the race layer's mask with its
**red** channel as coverage: `dst = lerp(dst, colour / 255, mask.r / 255 × TINV / 100)`. The
skin tone mask is all white at value 1, so the start colour does not matter. Mean error against
the baked textures: 1.2–2.8 / 255 (the alpha channel as coverage: 107 / 255).

**Face textures:** the baked face's texture set is its complexion's (FTST) moved for the
FaceGen shader: TX00 diffuse and TX01 normal map in slots 0 and 1, **TX03** (the subsurface
map, `MaleHead_sk.dds`) in slot 2, **TX04** (the detail map, `MaleHeadDetail_Age40.dds`) in
slot 3, the face tint in slot 6, TX07 (specular) in slot 7 (`facegeom\skyrim.esm\0010A1AA.nif`
against SkinHeadMaleNordComplexion_Age40). The head part's own NIF (MaleHead.nif) leaves 3 and
6 empty; the engine fills them for the player's head (`faceTextureSlots`).

## AI packages

**PACK** (`src/ai/package-records.ts`; check: `node tools/package-info.ts --parse`: 7633
vanilla packages, 126 of them templates, 240 with a procedure tree of their own). After UESP and
xEdit, in field order:

- **VMAD** with a fragment section after the scripts: u8 (2), u8 flags (0x1 begin, 0x2 end,
  0x4 change), wstring fragment script (PF\_…), then per flag in that order u8 (1), wstring
  script, wstring function. 449 packages have scripts, 435 fragments: 153 on begin, 334 on
  end, 116 on change.
- **PKDT** 12 bytes: misc flags u32 (0x4 must complete, 0x400 once per day, 0x2000 preferred
  speed, 0x20000 always sneak, 0x800000 weapon drawn, 0x20000000 wear sleep outfit, ...),
  type u8 (18 a package, 19 a template), interrupt override u8 (0 none, 1 spectator, 2 observe
  dead, 3 guard warn, 4 combat), preferred speed u8 (walk, jog, run, fast walk), unknown u8,
  interrupt flags **u16** (0x1 hellos to the player, 0x2 random conversations, 0x4 observe
  combat, 0x8 greet corpses, 0x10 reactions to the player's actions, 0x20 friendly fire
  comments, 0x40 aggro radius, 0x80 idle chatter, 0x200 world interactions), 2 unknown bytes.
  UESP and xEdit agree on the u16: the 2 bytes after it are garbage in 96 packages (0x0004,
  0x2C65, ...), which reading a u32 took for flags.
- **PSDT** 12 bytes: month i8 (−1 any), day of week i8 (−1 any, 0 Sundas .. 6 Loredas, 7
  weekdays, 8 weekends, 9 Morndas / Middas / Fredas, 10 Tirdas / Turdas), date u8 (0 any),
  hour i8 (−1 any time), minute i8, 3 unused, duration u32 in minutes. Vanilla: 1977 start
  hours, 53 days of the week, no months or dates.
- **CTDA** conditions on when it may run, then the idles it plays (110 packages): **IDLF** u8
  (0x1 run in sequence, 0x4 do once; 0x8, undocumented, in 109 of the 110), IDLC u8 their
  count, **IDLT** f32 the idle timer (non-zero in 15), **IDLA** the IDLE form ids (89 lists of
  one, 17 of two, 1 of three, 3 of four), IDLB (not in vanilla). **CNAM** the combat style
  (142 packages), **QNAM** owner quest, **PKCU** 12 bytes: data input count (the number of
  inputs in every vanilla package), the template package (its tree runs with this package's
  inputs), the Creation Kit's version counter.
- **Public data inputs:** each **ANAM** (Bool, Int, Float, ObjectList, Location, SingleRef,
  TargetSelector, Topic) is followed by its value: CNAM (u8 bool, i32, f32; an ObjectList's
  f32 is not documented), **PLDT** (type i32: 0 near reference, 1 in cell, 2 near the package
  start, 3 near the editor location, 4 an object, 5 an object type, 6 near the linked
  reference of a keyword, 8 / 9 alias reference / location, 12 near self; the form or alias
  id; radius i32), **PTDA** (type i32: 0 a specific reference, 1 an object, 2 an object type,
  3 the linked reference of a keyword, 4 a reference alias, 6 self; the form, type or alias
  id; count i32), PDTO / TPIC topics. Then one **UNAM** (u8 id) per input in the same order,
  and **XNAM** ends them. An alias location's value (9) is an alias id like an alias
  reference's (8), not a form id (xEdit; vanilla: 4 in CR01BeastPackage and Hearthfire's
  BYOHAdoption_FamilyPetGoHome). Vanilla PLDTs: 5189 near a reference, 768 near the editor
  location, 755 alias references, 603 in a cell, 599 linked references, 487 near self, 470
  near the package start, 2 alias locations, and 18 of type 11 in two Hearthfire urchin
  packages (values 24–32; xEdit leaves the type unknown).
- **Procedure tree** (templates, and packages without one): branches in depth-first order,
  each an **ANAM** (Procedure, Sequence, Simultaneous, Random, Stacked), CITC condition count
  and its CTDA, **PRCB** (u32 the branch's child count, u32 flags: 0x1 repeat when complete,
  82 vanilla branches), for procedures **PNAM** the procedure (Travel, Sit, Sleep, Patrol,
  Sandbox, Guard, UseIdleMarker, ForceGreet, ... 30 in vanilla), FNAM flags (0x1 success
  completes the package), **PKC2** the ids of the inputs it takes (u8, repeated; 255 none)
  and **PFO2** 16 bytes, the flags the procedure overrides while it runs: package flags u32
  set, u32 cleared, interrupt flags u16 set, u16 cleared, u8 preferred speed (with the
  preferred speed flag set), 3 garbage bytes (75 procedures; TravelVariableSpeed's walk, jog,
  run and fast walk). Older packages have **PFOR** instead (40 procedures), 12 bytes laid out
  as PFO2's first 12 (xEdit leaves it unknown; vanilla sets ignore combat, weapon drawn,
  preferred speed). One per procedure; PatrolAndHunt has two different PFO2 on one, three
  templates two equal PFOR: the last counts.
- **Procedure data:** UNAM id, BNAM the name the Creation Kit shows ("Patrol Start", "Sleep
  Location", "Target"), PNAM u32 (1: public).
- **POBA / POEA / POCA** on begin / end / change: **INAM** the idle played, **PDTO** the topic
  said (u32 0 a topic: DIAL form id, 1 a subtype: four characters). Vanilla: idles on begin in
  3 packages, on end in 22, topics on begin in 3 (CWMission07Ambush...), on end in 3
  (TelravTravel...). SCHR (1152 empty 20-byte script headers), SCDA, SCTX, QNAM and TNAM
  between them are leftovers of earlier Creation Kit versions.

## Quests

**QUST** (`src/world/quest-records.ts`; check: `node tools/quest-info.ts --parse`: 2338 quests,
443 starting with the game, 7150 stages, 2074 objectives, 16099 aliases). After UESP:

- **DNAM** 12 bytes: flags u8 (0x01 start game enabled, 0x04 wilderness encounter, 0x08 allow
  repeated stages), flags u8 (0x01 run once, 0x02 exclude from dialogue export, 0x04 warn on
  alias fill failure), priority u8, unknown u8, unknown i32, type u32 (0 none, 1 main quest,
  2 Mages' Guild, ..., 9 Civil War, 10 Dawnguard, 11 Dragonborn). ENAM the story manager event
  that starts it (four characters: ADIA 900 quests, SCPT 264, CLOC 172, KILL 15, ...).
- CTDA dialogue conditions, then after an empty **NEXT** the event's conditions.
- Stages: **INDX** (i16 index, u8 flags: 0x02 start-up, 0x04 shut-down, 0x08 keep instance
  data, i8), each with log entries: **QSDT** u8 (0x01 completes the quest, 0x02 fails it),
  CTDA, CNAM the journal text (localized), NAM0 the next quest. VMAD's fragments belong to a
  stage's log entry: only the fragment of the entry that happens (the first whose conditions
  hold) runs. (MQ101's early stages have a debug entry after the real one: running all of a
  stage's fragments asked "Who did you befriend while escaping from Helgen?" on a new game.)
- Objectives: **QOBJ** i16 index, FNAM flags (0x1 ORed with the previous), NNAM text, then
  targets: **QSTA** (alias i32, flags u32: 1 the compass ignores locks) with their CTDA.
- ANAM the next alias id, then the aliases from **ALST** (reference) / **ALLS** (location) to
  ALED: ALID name, FNAM flags (0x1 reserves, 0x2 optional, 0x4 quest object, 0x8 allow reuse,
  0x10 allow dead, 0x20 in loaded area, 0x40 essential, 0x80 allow disabled, ..., 0x800 no fill
  type, 0x2000 closest, 0x8000 initially disabled), ALFI the alias it is forced into, and its
  fill: ALFR / ALFL a forced reference / location; ALUA a unique actor (NPC_); ALCO a created
  object with ALCA (high bit: in, else at; the alias) and ALCL its level; ALEQ / ALEA another
  quest's alias; ALFA + ALRT a location alias's reference of a type (LCRT); ALFA (+ KNAM) a
  reference alias's location (the parent with the keyword); ALFE / ALFD a story manager event
  and its data;
  else Find Matching Reference by its CTDA (in the loaded area, closest, ALNA near an alias),
  or Forced: None (no fill type: scripts fill it). CTDA match conditions, KWDA keywords, CNTO
  items, ALSP spells, ALFC factions, **ALPC packages** (they run before the actor's own while
  the alias holds it), ALDN display name, SPOR / ECOR package lists. Vanilla fills: unique actor
  3537, forced 3275, a location's reference 2320, from an event 2055, matching 1544, none 985,
  created 968 (reference aliases).

## Story manager

The story manager's trees (`src/world/story-manager-records.ts`; check:
`node tools/story-manager.ts`: 658 nodes, 24 event types; `node tools/story-manager.ts SCPT`
prints one tree). After xEdit's definitions (UESP's pages leave the flags open):

- **SMEN** event node, **SMBN** branch node, **SMQN** quest node: PNAM parent, SNAM the
  previous sibling (0 for the first child: the children's order is this chain), CITC and CTDA
  conditions (CIS2 a variable name), DNAM flags, XNAM. Every SMEN's parent is the SMBN "Root".
- SMEN: ENAM the event type (four characters: SCPT script event, KILL, CLOC, ADIA, ...), DNAM
  node flags u32.
- SMBN: DNAM node flags u32 (0x1 random, else stacked; 0x2 warn if no child quest started).
- SMQN: DNAM u32: node flags in the low 16 bits as above, quest flags in the high 16 (0x1 do
  all before repeating, 0x2 shares event, 0x4 num quests to run); XNAM max concurrent quests
  (0: no limit), MNAM num quests to run, QNAM the quest count, then per quest NNAM (QUST), FNAM
  (0 or 2), RNAM hours until reset as f32 × 24 (the Creation Kit shows RNAM / 24 as hours;
  xEdit reads it so: WEDA02 1728 → 72 h, the bounty collector 1152 → 48 h).

## Scenes

**SCEN** (`src/ai/scene-records.ts`; check: `node tools/scene-info.ts --parse`: 2131 vanilla
scenes of 1282 quests, 10631 phases, 4821 actors, 16277 actions; one scene:
`node tools/scene-info.ts MQ101Scene1`, a quest's: `--quest MQ101`). After xEdit, with
CommonLibSSE's BGSScene / BGSSceneAction\* for the actor flags; in field order:

- **VMAD** with a fragment section after the scripts: u8 (2), u8 flags (0x1 begin, 0x2 end),
  wstring fragment script (SF\_…), per flag u8 (1), wstring script, wstring function; then u16
  phase fragment count, each u8 when (0x1 on the phase's start, 0x2 on its completion), u32
  the phase (0: the first), u8 (1), wstring script, wstring function. 708 scenes have
  scripts, 683 fragments: 179 on begin, 549 on end, 153 on a phase's start, 631 on its
  completion, and 7 with neither bit, 6 of them on phases their scene no longer has
  (MQ102ATimerScene, VC01VampirismCureRitual, DA03BarbasVileReunited).
- **FNAM** flags u32: 0x1 begin on quest start (956), 0x2 stop quest on end (851), 0x4 show
  all text (1394), 0x8 repeat conditions while true (17), 0x10 interruptible (55).
- **Phases**, each from **HNAM** to HNAM: NAM0 its name (often empty; "SetStage 15 - Get
  everyone moving on end"), CTDA its start conditions, **NEXT**, CTDA its completion
  conditions, NEXT, WNAM u32 its width in the scene editor. 775 phases have start
  conditions, 1608 completion conditions.
- **Actors**, each **ALID** i32 (an alias of the scene's quest), LNAM flags u32 (0x1 no player
  activation, 420; 0x2 optional, 291; CommonLibSSE adds 0x4 run only scene packages, 0x8 no
  command state, not in vanilla), DNAM behaviour flags u32 (0x2 death end, 0x4 / 0x8 combat
  pause / end, 0x10 / 0x20 dialogue pause / end, 0x40 / 0x80 observe combat pause / end;
  0x1 death pause is unused). 156 actors of early scenes (the towns' house and inn scenes:
  WinterholdInnScene01, TempleScene1, ...) have only their ALID; they take xEdit's default
  0x1A (death end, combat end, dialogue pause).
- **Actions**, each from an **ANAM** u16 type (0 dialogue 11895, 1 package 3496, 2 timer 886)
  to an empty ANAM: NAM0 name, ALID the actor whose row it is on (timers too), LNAM
  (undocumented, in no vanilla action), **INAM** u32 its index (the scene's INAM is the last
  given), FNAM flags u32 (0x8000 face target 2826, 0x10000 looping 116, 0x20000 headtrack the
  player 1081), **SNAM** / **ENAM** u32 the phases it starts and ends in. Then by type:
  dialogue **DATA** the topic (DIAL; 0 in 3110: the actor only looks), **HTID** i32 the actor
  it looks at (−1 none), DMAX / DMIN f32 seconds between lines when looping, DEMO u32 emotion
  (0 neutral .. 7 puzzled, as TRDT), DEVA u32 its value; package **PNAM** the packages
  (repeated; 54 actions have more than one); timer a second **SNAM** f32 seconds.
- **PNAM** the parent quest, **INAM** u32 the last action index, **VNAM** 16 bytes (1781
  scenes): for death, combat, dialogue and observe combat u32 each, what the scene sets for
  all its actors (0 set all normal, 1 pause, 2 end, 3 don't set all), then CTDA the scene's
  conditions (19 scenes).

SCHR, SCDA, SCTX, QNAM and SCRO in phases, actions and between the actions and PNAM, and an
extra NEXT there, are leftovers of earlier Creation Kit versions. MQ101 has 17 scenes; its
opening, MQ101Scene1 (begins on quest start), has 29 phases, 13 actors and 43 actions: 38
dialogue (Ralof's and the prisoner's lines in the cart, the look-ats between them), 4 timers
and a package (an Imperial soldier to the cart's greeting marker), its phases waiting on
`HasLoaded3D` of the player and MQ101's stages; its fragments set stage 15 and 14 as phases 2
and 5 complete, and 35 as it ends unless stage 2, 6 or 7 is done. MQ101Scene4, the execution, is the largest: 55
phases, 23 actors, 251 actions.

## Locations

**LCTN** (`parseLocation` in `src/world/actor-stats-records.ts`): PNAM parent location, KWDA
keywords, MNAM world location marker, RNAM radius, FNAM unreported crime faction, NAM1 music.
Its references are lists the master keeps and later plugins change: **LC\*\*** the master's
(LCPR persistent actors, 12 bytes: actor, cell or worldspace, grid x / y i16; LCUN unique
actors: NPC\_, ACHR, location; LCSR special references, 16 bytes: location reference type
LCRT, reference, cell or worldspace, grid; LCEC encounter cells; LCID; LCEP enable points),
**AC\*\*** those a plugin adds, **RC\*\*** those it removes (form ids). An override carries only
its own changes: Skyrim.esm's BleakFallsBarrowLocation lists the barrow's special references
(LCSR 224 bytes), Dawnguard.esm's override only four added ones (ACSR). The lists are therefore
read from every version of the record in load order: a version's LC\*\* replace them, AC\*\* add
to them, RC\*\* remove from them; the rest is the last version's.

## Default objects

**DOBJ** (one record, `src/world/default-objects.ts`): DNAM entries of 8 bytes, a four-letter
use code (u32, its characters in file order) and a form id: the forms the engine itself uses.
Skyrim.esm lists 303 (36 of them none); every later plugin's version lists only the uses it
sets (Update.esm 12 of 366 entries, the rest zero; the Survival Mode creation 7), so the
versions are merged use by use in load order. Audio: MDSC the music category
(AudioCategoryMUS), DFMS default music (MUSExploreTestb), BTMS combat music (MUSCombat), DTMS
death, SCMS success, LUMS level up (both MUSSpecialSuccess), DCMS dungeon cleared, SSSC
(`_NONE`), DDSC / NDSC / SFDC / PDMC / PIMC / PDLC / SMSC / TSSC categories, DOP2 / DOP3 /
POPM / P3OM / IOPM output models, RVBT the default reverb, UWLS the loop under water, DLMT the
landscape's material; PUSG / PDSG (and per item kind) the sounds of picking up and putting
down (`itemSound`, src/gameplay/inventory.ts). Low health: IMLH the modifier pulsed
(LowHealthImod 0010C445), HSSD / HFSD the slow and fast heartbeat loops
(UIHealthHeartbeatALPSD / BLPSD), HBLH the help message (src/gameplay/low-health.ts).

## Lens flares and volumetric lighting

Both are new in Skyrim SE (xEdit's TES5 definitions).

**VOLI** (`src/world/volumetric-lighting.ts`): twelve single-float fields: CNAM intensity, DNAM
custom colour contribution, ENAM / FNAM / GNAM the custom colour, HNAM density contribution,
INAM density size, JNAM wind speed, KNAM falling speed, LNAM phase contribution, MNAM phase
scattering, NNAM sampling range factor. 42 in the vanilla load order, all in Update.esm and the
DLCs (VLClearDay: intensity 2, VLClearSunrise/Sunset 4; every vanilla one has density 0.3 /
size 10 / wind 15 / falling 0.3 and range 40). Weathers name four in **WTHR HNAM** (16 bytes:
sunrise, day, sunset, night form ids; 87 of 108 weathers name some). The [Display] settings
fVolumetricLightingIntensity (2), bVolumetricLightingEnable and the 3D texture sizes per
quality scale and size the engine's froxel volume.

**LENS** (`src/world/lens-flare.ts`): CNAM colour influence, DNAM (before the sprites) fade
distance radius scale, LFSP the sprite count, then per sprite DNAM its id (string), FNAM its
texture, LFSD 36 bytes: tint (3 floats), width, height, position, angular fade, opacity, flags
(0x1 rotates, 0x2 shrinks when occluded). Named by **WTHR GNAM** (the sun's glare) and **LIGH
LNAM**. The vanilla load order has **no LENS records** and no weather names one: the sun's
flare is a plugin feature. [ImageSpace] bLensFlare and fLensFlareGlobalIntensity apply.

## Crafting

**COBJ** (constructible object: a recipe; `src/world/crafting-records.ts`, CLI
`tools/cobj-list.ts`): EDID; **COCT** u32 component count, then one **CNTO** per component (u32
form id, i32 count; it always matches COCT in the load order; an optional COED may follow each,
none in vanilla); **CTDA** conditions (run on the player, see "Scripts and conditions");
**CNAM** the created object; **BNAM** the workbench keyword; **NAM1** u16 created count (no NAM1:
one). 1614 recipes in the load order, every one with a BNAM, 7 without a CNAM (none created:
skipped). Components are MISC (ingots, leather, ...), INGR, ALCH (cooking), WEAP / ARMO / AMMO
(HearthFire, Dawnguard upgrades) and SLGM; never form lists. Counts: 1561 make one, the arrow
recipes 10 or 24. Conditions: GetItemCount (47, on PlayerRef: a recipe is listed only while the
player carries some of a material), HasPerk (448, the material's smithing perk),
EPTemperingItemIsEnchanted (659, tempering recipes: `!= 1 OR HasPerk ArcaneBlacksmith`,
evaluated on the item being improved), GetGlobalValue, HasSpell (264, staves),
GetVMQuestVariable, GetStageDone.

A recipe is **tempering** when it sits at a smithing bench (keyword
CraftingSmithingSharpeningWheel 251 recipes, all WEAP; CraftingSmithingArmorTable 339, ARMO):
its CNAM is the item improved, not an item made ("TemperWeaponIronSword" for IronSword). All
other workbench keywords make things: CraftingSmithingForge 309 (WEAP, ARMO, AMMO, the 4
HearthFire fittings), BYOHBuildingCarpenter 200, CraftingCookpot 70 (food), BYOHBuildingDrafting
51, DLC2StaffEnchanter 43, Camping_CampfireCookingShared 24 (Survival), CraftingSmelter 18,
CraftingTanningRack 17, BYOHCraftingOven 13, CraftingSmithingSkyforge 12, DLC1CraftingDawnguard
10, DLC1LD_CraftingForgeAetherium 3, isGrainMill 1, and one keyword per HearthFire furniture
piece. A workbench offers every recipe whose BNAM is one of its keywords (a Skyforge: the
forge's 309 and its own 12).

**FURN WBDT** (2 bytes): u8 bench type (0 none, 1 create object, 2 smithing weapon, 3
enchanting, 4 enchanting experiment, 5 alchemy, 6 alchemy experiment, 7 smithing armor; 4 and 6
unused), u8 the skill it trains (an actor value: 10 Smithing, 16 Alchemy, 23 Enchanting; 255 =
none). 468 furniture have WBDT bench 0 (not workbenches) and 47 are workbenches: forges and
anvils (1, Smithing, KWDA CraftingSmithingForge), the staff enchanter (1, Enchanting), smelters,
tanning racks, cooking pots and spits, the oven, the grain mill and the HearthFire tables (1,
no skill), the grindstone (2), the armor workbench (7), the arcane enchanters (3, Enchanting),
the disenchanting fonts DisenchantmentFont01 and DLC2ApocryphaFountain (3, no skill, no
keywords) and the alchemy labs (5, Alchemy). The bench types 1-5 match the crafting menu's
frames in order (ConstructibleObject, Smithing, EnchantConstruct, EnchantDestruct, Alchemy); 7
is Smithing too.

The constructible menu's categories (`src/gameplay/crafting.ts`) are CommonLib's
ConstructibleObjectMenu FilterFlags, an index each (flag `1 << index`): a created object goes
to the category of its first keyword that is one of the material **default objects** (WM\*\*
weapon materials, AO\*\* / AL\*\* / AH\*\* armor materials, WPNC / WPSM, JWLR jewelry, GCK1-GCK8
HearthFire categories, GCKX Aetherium), else Food (ALCH with ENIT flag 0x2), else Misc.

## Border regions

A region (REGN) with record flag `0x40` (Border Region, xEdit) bounds its worldspace (WNAM)
where the player cannot go (`src/world/border.ts`): one or more areas, each an **RPLI** (u32
edge fall-off, world units) followed by an **RPLD** (points: x, y f32 each). A point inside any
polygon of any of the worldspace's border regions is inside. Vanilla: Tamriel's
BorderRegionSkyrim (173 points) and Dawnguard's DLC1BorderRegionSkyrim (the north-west, Castle
Volkihar's coast; fall-off 1024), the Forgotten Vale (three areas), Solstheim and Apocrypha;
city worldspaces have none. What the fall-off does for a border is not documented (it is
ignored here). With `[General] bBorderRegionsEnabled` the player stops at the edge and the
game shows GMST sPlayerLeavingBorderRegion ("You cannot go that way.").

## INI settings

**The rule** (`src/world/ini-settings.ts`, `IniSettings`): a setting is its default compiled
into the executable, then the installation's `Skyrim_Default.ini` (the launcher copies it to the
player's Skyrim.ini), then the player's own INI files. Observed in the original: the
executable keeps two collections, the INI settings and the preference settings (those
SkyrimPrefs.ini holds: Display, LOD, Grass, Decals, GamePlay, SaveGame, the [MAIN] ones); the
launcher writes SkyrimPrefs.ini from a graphics preset (Low, Medium, High, Ultra.ini in the
installation) and the game writes its current values back. Skyrim.ini's values reach preference
settings too (the maintainer's SkyrimPrefs.ini carries Skyrim_Default.ini's fLightLODStartFade
3500, fGrassMinStartFadeDistance 0, fTreesMidLODSwitchDist 9999999), so this engine reads
Skyrim_Default.ini for both. The INI layer is the VFS's (`Vfs.ini`, docs/formats/load-order.md
"INI files"): Skyrim_Default.ini < the player's imported Skyrim.ini < SkyrimPrefs.ini < each
loaded plugin's `<Plugin>.ini`; over it the changes made in the settings menu
(`src/shell/preferences.ts`). `INI_DEFAULTS` therefore holds the executable's defaults,
never a preset's. Some defaults the executable sets as it starts (the dump of its stored values
shows 0 for them): iDifficulty 2, fHUDOpacity 1, bShowFloatingQuestMarkers 1, bSaveOnRest /
Wait / Travel 1 (bSaveOnPause 0), fAutosaveEveryXMins 15, fLightLODStartFade = fLightLODDefaultStartFade
(1000). Settings the executable names without a section are [MAIN]'s (bCrosshairEnabled,
fHUDOpacity, the bSaveOn*: where SkyrimPrefs.ini keeps them; `tools/setting-defaults.ts` looks
them up so).

Decisions (2026-10, against the executable's defaults with `tools/setting-defaults.ts`):
fLODFadeOutMultActors / Items / Objects 6, 3, 5 (the executable's; were High.ini's 9, 6, 9; the
settings menu's default positions are the executable's too; Ultra.ini: 15, 10, 30);
fLightLODStartFade 1000 (Skyrim_Default.ini's 3500 applies over it); fInventory3DItemPosX /
XWide −38 / −29 and fMagic3DItemPosX / XWide 34.7 / 26 (were STEP's Oldrim values −29 / −22, 29
/ 22); HAVOK fMaxTime 0.016666668 (1/60 as a float); iDifficulty 2, bShowFloatingQuestMarkers 1,
fHUDOpacity 1, fAutosaveEveryXMins 15 and the bSaveOn* (the executable's start-up values, kept).
fShadowLODStartFade and fSpecularLODStartFade are gone: SSE has no such settings (Oldrim's;
Skyrim_Default.ini's fShadowLODMaxStartFade, fSpecularLODMaxStartFade and fLightLODMaxStartFade
are read by nothing either), and its settings menu gives Shadow, Light and Specularity Fade no
ID. iHighlightSpeechOverlap and iMessageBoxMaxItems are never read by the engine
(fHighlightSpeechOverlap is). Those used now: `[Camera]` fOverShoulderPosX 30, fOverShoulderPosZ −10, fVanityModeMinDist 155,
fVanityModeMaxDist 600, fMinCurrentZoom −0.2, fMouseWheelZoomIncrement 0.075,
fMouseWheelZoomSpeed 0.8, fCameraCasterSize 15, and for the bleedout camera (the dead player's)
iBleedoutTransitionMillis 500, fCameraCasterBleedOutSize 5, fDefaultAutoVanityZoom 300; `[Controls]` bAlwaysRunByDefault 1,
fMouseHeadingSensitivity 0.0125, fMouseHeadingXScale 0.02, fMouseHeadingYScale 0.85, fZKeyDelay 0.2;
`[General]` bBorderRegionsEnabled 1; `[Audio]` ([audio.md](../audio.md)) fASFadeInTime 3,
fASFadeOutTime 8, fRegionLoopFadeInTime 6, fRegionLoopFadeOutTime 8,
fRegionRandomSoundPlacementBase 100, fRegionSoundPlacementRandomOffset 650,
fRegionSoundPlacementZOffset 256, uRegionSoundsAllowedPerUpdate 1, fMusicDuckingSeconds 6 and
fMusicUnDuckingSeconds 8 (Skyrim_Default.ini; 1 and 4 compiled in),
fMusicFinaleCrossFadeTimeIn 3, fMusicFinaleCrossFadeTimeOut 6, fMinSoundVel 60,
fCollisionSoundHeavyThreshold 160, iCollisionSoundTimeDelta 150, fWaterAudioFadeInSeconds 3,
fWaterAudioFadeOutSeconds 5, uWaterAudioAmbientAttenuation 2200, uWaterAudioAxisSamplePoints 8,
uWaterAudioSamplePointsToUse 8 (the compiled defaults as Step's INI guide lists them);
`[Display]` fDefaultWorldFOV 80, fNearDistance 15; `[HAVOK]` fInAirFallingCharGravityMult 1.35,
fUnsupportedGravMult 4, fMaxTime 1/60; `[Interface]` fActivatePickLength 180,
fActivatePickRadius 16. Wired in the settings sweep (behaviour observed in the original;
docs: [physics.md](../physics.md) for the camera, [ui.md](../ui.md), [audio.md](../audio.md),
[rendering.md](../rendering.md) for decals): `[Camera]` fPitchZoomOutMaxDist,
fCollisionRecoverySpeed / MinDist, f1st3rdSwitchDelay, `[Controls]` fTogglePOVDelay, and for
phase 7's camera states the chase, auto vanity, furniture, workbench and flying settings;
`[Display]` fDecalLifetime, `[Decals]` uMaxDecals; `[Interface]` iEnemyHealthDisplayTime /
Angle, fMaxSubtitleDistance, bShowSubtitleSpeakerName, iSubtitleSpeakerNameColor,
bShowCompass, bShowHUDMessages, fMenuKeyRepeatLong / Short; the settings menu's slider ends
(fGammaMin / Max, fMouseHeadingSensitivityMin / Max, fActorLODMin .. fObjectLODMax,
fGrassMin / MaxStartFadeDistance, fDynamicDOFBlurMultiplierMin / Max); `[Audio]`
fMenuModeFadeOutTime / InTime, fNonDialogVoiceDucking (FadeIn, FadeOut), fMaxHighlightRadius,
fNonHighlightSpeechAtten, fHighlightSpeechOverlap.

## Items

What a player can carry (`src/world/item-records.ts`, `node tools/item-info.ts`), after UESP and
xEdit's TES5 definitions:

| Type                   | Value / weight                                                                                                                                                                       | Also                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WEAP                   | DATA: value u32, weight f32, damage u16                                                                                                                                              | DNAM (100 bytes): animation type u8 @0, speed f32 @4, reach f32 @8, flags u16 @12 (0x80 non-playable), skill (actor value) i32 @76, stagger f32 @96; CRDT: critical damage u16 @0                                   |
| ARMO                   | DATA: value i32, weight f32                                                                                                                                                          | DNAM: armor rating × 100 (i32); BOD2: biped slots u32, armor type u32 (0 light, 1 heavy, 2 clothing); BODT (older): slots, flags, armor type @8; record flag 0x4: non-playable; MOD2/MOD4: male/female world models |
| AMMO                   | DATA: projectile, flags u32 (0x2 non-playable), damage f32, value u32 @12, weight f32 @16                                                                                            |                                                                                                                                                                                                                     |
| ALCH                   | DATA: weight f32; ENIT: value i32 @0                                                                                                                                                 | ENIT flags u32 @4: 0x2 food, 0x10000 medicine, 0x20000 poison                                                                                                                                                       |
| INGR, MISC, KEYM, SLGM | DATA: value i32, weight f32                                                                                                                                                          | SLGM: SOUL (u8, the soul held), SLCP (u8, its capacity)                                                                                                                                                             |
| BOOK                   | DATA (16 bytes): flags u8 (0x1 teaches a skill, 0x2 can't be taken, 0x4 teaches a spell), type u8 (255: a note), teaches i32 @4 (actor value or spell), value u32 @8, weight f32 @12 | CNAM: the item card's description                                                                                                                                                                                   |
| SCRL                   | DATA: value u32, weight f32                                                                                                                                                          | its effects                                                                                                                                                                                                         |
| LIGH                   | DATA (48 bytes): flags u32 @12 (0x2: can be carried), value u32 @40, weight f32 @44                                                                                                  | only carryable lights are items                                                                                                                                                                                     |

Every item but lights: YNAM and ZNAM, the sounds (SNDR) of picking it up and putting it down; where
an item names none the default objects do (PUSG/PDSG generic, PUSW/PDSW weapons, PUSA/PDSA armor,
PUSB/PDSB books, PUSI/PDSI ingredients). A reference's XCNT (i32) is how many of its base it is.

Effects (potions, ingredients, scrolls, enchantments): EFID (the magic effect), EFIT (magnitude
f32, area u32, duration u32), then the effect's CTDA. Magic effects (`src/world/magic-effects.ts`):
DATA flags u32 @0 (0x1 hostile, 0x200 no duration, 0x400 no magnitude, 0x800 no area, 0x8000
hidden in the interface), base cost f32 @4, magic skill i32 @12, archetype u32 @64, actor value
i32 @68; DNAM: the description, with `<mag>`, `<dur>`, `<area>` for the values.

## Spells and shouts

`src/world/spell-records.ts`, after UESP's SPEL, SHOU and WOOP pages:

- SPEL: SPIT (base cost u32 @0, flags u32 @4: 0x1 the cost is SPIT's own, 0x20000 a player's
  starting spell; type u32 @8: 0 spell, 1 disease, 2 power, 3 lesser power, 4 ability, 5
  poison, 10 addiction, 11 voice; charge time f32 @12, cast type u32 @16: 0 constant, 1 fire and
  forget, 2 concentration, 3 scroll; delivery u32 @20, cast duration f32 @24, range f32 @28,
  half-cost perk @32), ETYP (the hand or voice), then its effects as an item's.
- A spell's base cost, unless SPIT gives it: the sum over its effects of the effect's base cost ×
  (magnitude × duration / 10)^1.1, a magnitude under 1 counted as 1, a duration of 0 (and any for
  concentration spells) as 10.
- SHOU: FULL, DESC, and per word an SNAM (WOOP u32, its spell u32, recovery seconds f32).
- WOOP: FULL the word in the dragon tongue, TNAM its translation.
- A magic effect's minimum skill (u32 @40 of DATA) is its spells' level.
- The SPIT cost the plugins store is the Creation Kit's calculation when it was saved: it matches
  the calculation for 380 of the 418 vanilla fire and forget spells and 97 of the 118
  concentration spells without 0x1; the engine calculates (Flames stores 14 against its
  effect's 2.5 × 8^1.1 = 24.6; TODO(M13): the menu's figure against the game).

## Projectiles and explosions

`src/world/projectile-data.ts`, after xEdit (wbDefinitionsTES5 PROJ, EXPL) and CommonLibSSE
(BGSProjectileData, BGSExplosionData); check: `node tools/casting-info.ts <spell|shout>`,
`--audit`. The load order has 247 PROJ (missile 103, arrow 48, cone 47, flame 24, beam 15,
lobber 10) and 279 EXPL (86 with an enchantment).

- **PROJ DATA** (92 bytes): flags u16 @0 (0x1 hitscan, 0x2 explosion, 0x4 alternative trigger,
  0x8 muzzle flash, 0x20 can be disabled, 0x40 can be picked up, 0x80 supersonic, 0x100 pins
  limbs, 0x200 pass through small transparent, 0x400 disable combat aim correction), type u16
  @2 (1 missile, 2 lobber, 4 beam, 8 flame, 0x10 cone, 0x20 barrier, 0x40 arrow), gravity f32
  @4 (× the world's), speed @8 (units/s), range @12, light @16, muzzle flash light @20, tracer
  chance @24, the alternative trigger's proximity @28 and timer @32, explosion @36, sound @40,
  muzzle flash duration @44, fade duration @48, impact force @52, countdown sound @56, disable
  sound @60, default weapon source @64, cone spread @68 (degrees), collision radius @72,
  lifetime @76, relaunch interval @80 (a held concentration spell's sprays), decal (TXST) @84,
  collision layer @88. MODL its model, NAM1 the muzzle flash's, VNAM its sound level.
  FireboltProjectile01: missile, 2500 units/s, range 10000, radius 10; FlamesProjectile: flame,
  1000, range 768, relaunch 0.175 s; VoicePushProjectile01..03 (Unrelenting Force): cones of
  15°, 15°, 10° reaching 1000, 2000, 10000; arrows fall at 0.35 of the world's gravity.
- **EXPL DATA** (52 bytes): light @0, sound @4, second sound @8, impact data set @12, placed
  object @16, spawn projectile @20, force f32 @24, damage @28, radius @32, image-space radius
  @36, vertical offset mult @40, flags u32 @44 (0x2 always world orientation, 0x4 knock down
  always, 0x8 knock down by formula, 0x10 ignore line of sight, 0x20 push the source only, 0x40
  ignore the image-space swap, 0x80 chain, 0x100 no controller vibration), sound level @48.
  EITM the enchantment or spell it applies, MNAM its image-space modifier, MODL its model.
  Fireball01ImpactExplosion: radius 320, force 60, damage 2.

## Destructible objects

`src/world/destruction-records.ts`, after xEdit (wbDefinitionsTES5 wbDEST, DEBR); check:
`node tools/destruction-info.ts` (counts, stage flags, every object), `<editor id>` (one with
its explosions and debris models), `--refs` (the placed references, by object). The block can
sit on ACTI, ALCH, AMMO, ARMO, BOOK, CONT, DOOR, FLOR, FURN, INGR, KEYM, LIGH, MISC, MSTT,
NPC\_, PROJ, SCRL, SLGM, STAT, TACT, TREE and WEAP; the load order has 674 (ACTI 658: 600 ore
veins and gem deposits, traps, webs, barricades, frozen Falmer, ...; FURN 2, MSTT 2, NPC\_ 2,
PROJ 10) with 813 stages, and 3286 placed references of 340 of them. 6 DEBR.

- **DEST** (8 bytes): health i32 @0, stage count u8 @4, flags u8 @5 (0x1 VATS targetable, 0x2
  large actor destroys; 0 in every vanilla record), 2 unknown. Then per stage, in order:
- **DSTD** (20 bytes): health % u8 @0 (falling from stage to stage), index u8 @1 (its position),
  model damage stage u8 @2, flags u8 @3 (0x1 cap damage, 0x2 disable, 0x4 destroy, 0x8 ignore
  external damage), self damage per second i32 @4, explosion (EXPL) @8, debris (DEBR) @12,
  debris count i32 @16; then optionally **DMDL** (the stage's model, relative to meshes\),
  **DMDT** (its texture hashes) and **DMDS** (texture sets on its shapes: u32 count, then per
  entry the shape name as u32 length + text, the TXST and the shape index u32: the layout of
  ARMA's MO2S..MO5S; 496 stages, the ore veins' depleted rock taking their ground's texture);
  **DSTF** (empty) ends the stage.
- **DEBR**: per model a **DATA** (u8 percentage, the model's path, u8 flags: 0x1 has collision
  data) and its MODT. IceWraithDebris' percentages add up to 100; IceFormDebris lists eight
  pieces at 100 each. Several debris models have no collision of their own (IceFormChunk01..04,
  TentacleDebris) or a fixed one (DLC01 IceChunk01: a fixed sphere of mass 0).
- **BSDamageStage** (NIF, a BSRangeNode: min, max, current bytes): the subtree a model shows at
  model damage stages min..max; the files keep each one culled (the engine shows the current
  one). Seven vanilla models: the stockade barricade (DamageStage0..3, one per stage), the
  windmills (DamageStage0-1, their pins), the beehive (2-3), Bersi's urn (its decals), the
  lumber mill's log, an Apocrypha ring's rubble.
- Examples: MineOreIron01 health 100, one stage at 50 % (cap damage, ignore external) with
  MineOreDepleted01.nif (MineOreScript's DamageObject(50)); FXspiderWebKitDestructible health
  10, [99 % cap damage, FXSpiderwebStripExplosion] [0 %, its torn model and explosion];
  StockadeBarricade01Activator health 125, stages at 75/50/25 % (model damage stages 1..3) and 0
  % (StockadeBarricade01Stage04.nif); TrapOilPool01 health 100, [99 % cap, destroy, 16/s] [94 %
  12/s, TrapOilExplosionInitial] [12 % 1/s] [7 % disable]. No vanilla destruction explosion
  spawns a projectile; TrapOilExplosion01 places a fire hazard. No record of MQ101's Helgen
  tower, of the icicles or of the ice walls carries DEST; Dwemer columns and boulders do
  (DweDesColumn01Intact, DLC2DweDestructableColumn, CaveGBoulderDes01Intact: scripted, ignoring
  external damage).

## Idles and actions

`src/ai/idle-records.ts`, after xEdit (wbDefinitionsTES5 IDLE / AACT / IDLM, wbIdleAnimation),
CommonLibSSE-NG (TESIdleForm, BGSAction, BGSIdleCollection, BGSIdleMarker) and UESP's IDLE page;
check: `node tools/idle-info.ts --parse | --tree <action> [graph] | --idlm`. The load order has
4152 IDLE (winning versions: Skyrim.esm 3124, Dragonborn 509, Dawnguard 375, Update 109,
HearthFires 35), 71 AACT, 89 IDLM.

- **AACT** (an action): EDID, CNAM RGBA (only 2 of 71 have one). The engine performs actions
  (ActionIdle, ActionDraw, ActionRightAttack, ActionActivate, ActionMoveStart, ...); each is a
  root of the idle tree. 65 have idles; ActionShieldChange, ActionMoveRight, ActionMoveLeft,
  ActionStopEffect, ActionVoiceReady and ActionLook none.
- **IDLE**: EDID, CTDA conditions (CIS1 / CIS2 after their CTDA; 2215 idles have some, 111
  functions, most GetEquippedItemType 534, GetRandomPercent 372, GetPathingTargetAngleOffset
  344, GetSitting 322, IsEnteringInteractionQuick 292, HasKeyword 207), **DNAM** the behavior
  graph it is for (`Actors\Character\Behaviors\0_Master.hkx`; xEdit TES5 says "FileName", FO4
  "Behavior Graph"), **ENAM** the animation event sent to the actor's graph, **ANAM** two form
  ids: the parent (an AACT, an IDLE, or null: a loose idle) and the previous sibling (null: the
  first), **DATA** 6 bytes: looping seconds min / max u8 (both 255: forever), flags u8, an
  "animation group section" u8, replay delay u16. The Creation Kit wiki: sequence, blocking, no
  attacking, the looping seconds and the replay delay are no longer used. Flags: 0x1 on exactly
  the 373 loose idles (xEdit "Loose"; CommonLib calls it kParent), 0x2 sequence (1 idle), 0x4 no
  attacking (9: cow, goat, Dwarven spider idles), 0x8 blocking (none). Looping is 0/0 on 4148.
  The section byte is mostly printable ASCII (`r`, `t`, `e`, ...: 134 values), stray text.
- **IDLM** (an idle marker): record flag 0x20000000 a child can use it (24), OBND, then
  wbIdleAnimation (PACK has the same fields): **IDLF** u8 flags (CommonLib: 0x1 pick in
  sequence, 0x2 old pick conditions, 0x4 do once, 0x8 loose only, 0x10 not for sandboxing; 0x8
  on 62, 0x0 on 12, 0x18 on 5), **IDLC** u8 idle count (always IDLA's), **IDLT** f32 seconds
  between idles, **IDLA** the idles (IDLE form ids). 4 markers have none of these fields
  (EmptyIdleMarker, CaptiveIdleMarker, ...). Their idles: 97 loose, 33 in the ActionIdle tree
  (CowFeeding, the sabre cat's LayDownSleep, ...), 1 in ActionActivate's. No vanilla IDLM has a
  MODL.

**The tree** (the Creation Kit's Idle Animations window). Each idle hangs under its parent.
Under one parent, the idles of one **behavior graph** form a sibling list: each names the one
before it, the first none. An idle's graph is its DNAM, else its nearest parent idle's: 3337
idles name one, 815 inherit it, none is without. 50 graphs: the root behaviors of all 48
behavior projects races name (46 graphs; the root behavior is the project's
`hkbCharacterStringData` behaviorFilename), and 4 of objects (levers, a pull chain, a
projectile). 0_Master.hkx (characters) has 1688 idles, DraugrBehavior 176, DragonBehavior 126,
FalmerBehavior 99, HorseBehavior 94. The 1115
direct children of actions all name their graph and are one per graph (but for a Draugr root
both Dawnguard and Dragonborn add under ActionSummonedStart), 978 of them without conditions:
under ActionIdle NPCIdleRoot for characters, DogIdleRoot, DraugrIdleRoot, ... 36. Without the
graph a human would take the first (BoarIdleRoot).

Grouped by graph, the previous links chain up all but 15 pairs of siblings that name the same
previous (30 idles; without the grouping 1133): 6 in Skyrim.esm itself (BearLay and BearShake
both first, ...), 3 Dawnguard idles beside a vanilla first (FrozenExit, ...), 4 where two DLC
put an idle after the same one under Chair (Dawnguard's IdleBloodPortalActivate and
Dragonborn's IdleDLC02TentacleWordBurnRoot after IdleCartTravelDriver, HearthFires'
ChildSitOnKnees and Dragonborn's DLC2_ChildSitOnKnees after EnterTable, ...), 2 where Dawnguard
and Dragonborn both add an idle of the same editor id (DraugrGroundLayEnterInstant,
DraugrSummonedStartRoot). There the one later in the load order comes first (as if each plugin
put its idle right after the one it names); siblings no chain reaches follow in load order. 1
previous is no sibling: SabreCatTurnToRun, under SabreCatNoSpeed, which names
SkeeverBehavior.hkx inside the sabre cat's tree (with SabreCatTurnInPlace below it, the 2 idles
whose DNAM is not their parent's). 418 idles sit under a parent from another plugin; a later
plugin changes the parent or previous of 95 (Update.esm moves KillMove2HWB after
KillMove2HWChopKick; Dawnguard and Dragonborn relink the vanilla chair and furniture idles
around their own).

Idles per action (all graphs; characters'): ActionActivate 626 (31 graphs; 451),
ActionRightAttack 368 (20; 274), ActionIdle 315 (36; 94), ActionLeftAttack 258 (22; 96),
ActionRightPowerAttack 200 (6; 173), ActionPathStart 189, ActionPathEnd 128, ActionDeathWait 100,
ActionDraw 97 (44; 8), ActionForceEquip 96, ActionSheath 81 (41; 4), ActionStaggerStart 81, ...
1164 idles have children; 1170 have no event: 1144 of them are groups (with children), 26 empty
leaves (WitchlightRagdollInstant, SkeeverIdleWarn, AttackLeftHandForwardSprinting, ...). 20
idles have an event and children (CowMain_Idle sends IdleStop when none of its random children
is taken).

**Resolving an action** (`IdleTree.resolve`), observed in the original: a depth-first search
of the action's children for the actor's graph, in order. An idle whose conditions fail is
skipped with everything under it; one whose conditions hold is searched below first, and the
first child that resolves is the answer; if none does, the idle is the answer itself when it has
an event (or the blocking flag), and otherwise the search goes back up and on to its next
sibling. So a group whose conditions hold but none of whose children's do gives way to what
follows it (the killmoves' KillMoveFrontSideRoot before a mudcrab: the plain power attack after
it), and an idle with an event and children plays its own event only when no child qualifies
(KillingMoveSneakBackA). A sequence idle (flag 0x2; one vanilla: the dragon's flying snatch)
plays its first step (the engine starts the sequence afresh with each action). An answer
without an event plays nothing (the action fails). The conditions are valued as the engine does
([scripting.md](../scripting.md#conditions)): on the actor, the action's target as their target.
The vanilla trees end their random lists with an unconditioned fail-safe
(SpectatorTalkFailSafe, IdleHDFailAll, IdleVampireFeedFailsafe). An actor's graph is the root
behavior of its race's project (`behaviorGraphKey` of it). An idle played by
itself (a package, a script, an idle marker) also needs the conditions of the idles above it
(CommonLib `TESIdleForm::CheckConditions`, a_checkParentIdle: `IdleTree.holdsWithParents`).

## Furniture

`src/world/furniture-records.ts`, after xEdit (wbDefinitionsTES5 FURN) and CommonLibSSE-NG
(TESFurniture, TESObjectACTI, BSFurnitureMarker); check: `node tools/idle-info.ts --furn`. 515
FURN in the load order. WBDT is in "Crafting".

- **Record flags:** 0x80 is perch (1), 0x800000 is marker (74), 0x10000000 must exit to talk
  (184), 0x20000000 child can use (134); 0x8000 has distant LOD, 0x10000 random anim start and
  0x2000000 obstacle on none.
- **FNAM** u16 (TESObjectACTI flags): 0x1 no displacement, 0x2 ignored by sandbox (72).
- **KNAM** the interaction keyword (467): ActorTypeNPC 457, ActorTypeDragon 7,
  DLC2ActorTypeMiraak 2, DLC2RieklingKeyword 1.
- **MNAM** u32: bits 0-23 the active markers (bit n: the model's marker n), 0x2000000 disables
  activation (2), 0x4000000 is perch (5), 0x8000000 must exit to talk (184, the furniture with
  that record flag), 0x10000000 has a lean marker (2), 0x40000000 a sit marker (317),
  0x80000000 a sleep marker (189). On the 497 furniture with FNPR the last three are set exactly
  where FNPR has a marker of that type. CommonLib puts lean at 0x20000000, which no furniture
  sets; xEdit's 0x10000000 matches the data.
- **NAM1** the spell it gives its user (SPEL): none in vanilla.
- **Per marker** (200 furniture, 215 markers): **ENAM** u32 the marker's index in the model (0:
  200, 1: 11, 2: 4), **NAM0** u16 unknown (0, or 2 on 5) and u16 the entry points it cannot be
  entered from (0x1 front, 0x2 behind, 0x4 right, 0x8 left, 0x10 up), **FNMK** its keyword
  (only the executioner's block: isExecutioner, isExecutionerGuard).
- **FNPR** (one per marker of the model, 616 on 497 furniture): u16 type (1 sit 395, 2 sleep
  219, 4 lean 2), u16 the entry points it has (the same flags).
- **XMRK** the model the Creation Kit shows its markers with (64).

## Map markers

A map marker is a persistent REFR with XMRK (no data) followed by FNAM (flags u8: 0x1 visible on
the map from the start, 0x2 can be travelled to, 0x4 show all hidden), FULL (its name) and TNAM
(its type u8, the icon: in the vanilla data 0 .. 58, e.g. 2 towns, 4 caves, 36..52 the holds'
cities and keeps; then u8 unused) (`src/world/map-markers.ts`). Skyrim.esm and its DLC have 471.
They are found in one scan of the persistent REFRs (about 0.2 s in Node).

## Vendors

A faction with DATA flag 0x4000 trades (`FactionVendor`, `src/world/actor-stats-records.ts`,
after xEdit's FACT): VEND is the FLST of keywords it buys, VENC its merchant container (a REFR),
VENV (12 bytes) its start and end hour (u16 each), radius (u32), "only buys stolen items" (u8)
and "buys what is not in the list" (u8); PLVD its location; CITC then CTDA its conditions. Its
members (rank 0 or more) offer their services while the hour is within its hours and the
conditions hold (GetOffersServicesNow). An older reading took VEND for the hours: VEND is 4
bytes, the hours are in VENV.

## Dialogue

Topics, branches and infos (`src/world/dialogue-records.ts`, `src/world/dialogue.ts`,
`node tools/dialogue-info.ts <quest>`), after UESP and xEdit:

- DIAL: FULL (what the player says), PNAM priority, BNAM branch, QNAM quest, DATA (flags u8:
  0x1 do all before repeating; category u8: 0 topic, 1 favor, 2 scene, 3 combat, 4 favors, 5
  detection, 6 service, 7 miscellaneous; subtype u16), SNAM (the subtype's code: CUST, HELO,
  GBYE, HIT\_, SCEN, ...), TIFC u32 (the info count the Creation Kit saved; in 157 vanilla
  topics it differs from the infos their groups hold in the full load order). Its infos sit in
  its topic children group.
- DLBR: QNAM quest, TNAM u32 category (0 player dialogue, 1 favor dialogue: 2 of 4014
  branches), DNAM flags (0x1 top-level, 0x2 blocking, 0x4 exclusive), SNAM the starting topic.
- INFO: ENAM (flags u16: 0x1 goodbye, 0x2 random, 0x4 say once, 0x8 requires player
  activation, 0x40 invisible continue, 0x80 walk away, ...; reset hours u16), PNAM (the info it
  follows: a topic's infos are in this order), TCLT (the topics offered after it), DNAM (the
  info whose responses it shares), RNAM (the player's prompt), ANAM (the speaker), CNAM u8
  favor level (0 none, 1 small, 2 medium, 3 large; 2 vanilla infos medium, 213 without one),
  TWAT the topic said when the player walks away (665 infos), ONAM the sound output model it
  plays through (SOPM, 1963), CTDA conditions, and per response TRDT (emotion u32, emotion value u32, response number u8 @12,
  sound @16, flags u8 @20: 0x1 use the emotion animation), NAM1 (the text), SNAM / LNAM (the
  speaker's and listener's idles).

**Subtypes** (`src/world/dialogue-subtypes.ts`; check: `node tools/dialogue-info.ts
--subtypes`): 103 four-character codes (xEdit's subtype names) in the order of DATA's u16,
whose categories (the Creation Kit's dialogue tabs, INFO's "Quest Dialogue Tab") are ranges of
that order: player dialogue 0–3 (CUST custom, PFGT force greet, RUMO rumors, FVDL), favor
dialogue 4–13 (INTI intimidate, FLAT, BRIB, ASKG, GIFF, ASKF, FAVO, SHRE, FOLL, FRJT), scenes
14 (SCEN), favors 15–25 (SHOW, AGRE, REFU, FEXT, MREF and the six flying mount lines FM\*\*),
combat 26–54 (ATCK attack, POAT, BASH, HIT\_, FLEE, BLED, AVTH, DETH, GRST, BLOC, TAUT, ALKL,
the crimes STEA ... WTCR, the shouts VPSS ... VPEL), detection 55–65 (ALIL alert idle ...
DFDA), service 66–74 (SERU, REPA, TRAV, TRAI, BAEX, REEX, RECH, RCEX, TREX), miscellaneous
75–102 (OBCO, NOTI, TITG, GBYE goodbye, HELO hello, the reactions SWMW ... PICT, PURS, IDAT
shared info, the player's spells and shout PCPS / PCSS / PCSH, IDLE idle chatter, the breath
sounds BREA, ENBZ, EXBZ, OUTB, LWBS, and ACAC, PIRN, GRNT). Older topics keep older orders in
the stored u16 (an attack is 20, 25 or 26), so SNAM's code is what counts. The vanilla topics
use 83 subtypes; every topic has its subtype's category but 24 under player dialogue (21 SCEN,
one each HIT\_, DETH, HELO). `DialogueIndex.topicsOfSubtype` finds a subtype's topics of every
quest, `topicsOfCategory` a tab's.

A response's voice file is `Sound\Voice\<plugin>\<voice type>\<quest>_<topic>_<info>_<n>.fuz`:
the topic's quest's and the topic's editor ids (when longer than 25 characters together, the
quest's cut to 10 and the topic's to the rest of the 25: `MS13_MS13LucanQuestGiveBra_...`,
`DialogueGe_OfferServicesTo_...`; a topic without one leaves its part empty), the info's form
id as 8 hex digits without the load order index, the response's number. Checked against the
voice files of the load order: 43,326 of its 44,040 responses have one
(a topic cut to 15 after a short quest id missed 8,083 of them).

## Perk trees

A skill's AVIF (editor id "AV" + its name; Illusion's is still Oblivion's AVMysticism) holds its
perk tree after its own fields (CNAM its category, AVSK four floats: skill use mult, use offset,
improve mult, improve offset). One group per node, in this order: PNAM the perk (0 for the root,
whose grid fields are garbage), FNAM flags, XNAM / YNAM (u32) its grid column and row, HNAM /
VNAM (float) its offset from that grid point, SNAM the skill, CNAM (u32, repeated) the nodes it
leads to by their INAM, INAM (u32) the node's own index. `node tools/perk-info.ts` lists them.

A PERK: FULL, DESC, its requirements (the CTDA before its first effect, PRKE), DATA (u8 trait,
u8 level, u8 rank count, u8 playable, u8 hidden), NNAM the next rank (Armsman00 → 20 → 40 ...);
then its entries, each PRKE (u8 type: 0 quest stage, 1 ability, 2 entry point; u8 rank; u8
priority) to PRKF: DATA (a quest's form id and u16 stage; an ability's spell; an entry point's
u8 id, u8 function, u8 tab count), then for an entry point PRKC (s8 tab) + its CTDA per tab,
EPFT (u8 data type), EPF2 (a button label, lstring), EPF3 (u16 script flags, u16 fragment),
EPFD (EPFT 1 float; 2 two floats, an actor value stored as a float and a factor for the actor
value functions; 3 a leveled list; 4 / 5 a spell; 6 a string; 7 an lstring). Every tab count
the vanilla entries store is within the entry point's tabs (`node tools/perk-info.ts --audit`).
docs/gameplay.md ("Perks") has how the game runs them.

## Combat styles

CSTY (`src/ai/combat-style-records.ts`; `node tools/combat-info.ts --csty` lists every style
with its values and the NPC\_ naming it, `--audit` counts), after xEdit, CommonLibSSE
(TESCombatStyle.h) and UESP, all values f32:

- **CSGD** general: offensive, defensive and group offensive mult; equipment score mults of
  melee, magic, ranged, shout, unarmed and staff; avoid threat chance.
- **CSME** melee: attack staggered, power attack staggered, power attack blocking, bash, bash
  recoil, bash attack, bash power attack and special attack mult.
- **CSCR** close range: circle mult, fallback mult (dueling), flank distance, stalk time
  (flanking). **CSLR** long range: strafe mult.
- **CSFL** flight: hover chance, dive bomb chance, ground attack chance, hover time, ground
  attack time, perch attack chance, perch attack time, flying attack chance.
- **DATA** flags u32: 0x1 dueling, 0x2 flanking, 0x4 allow dual wielding. Record flag 0x80000
  is allow dual wielding too (xEdit, CommonLibSSE).

The engine reads none of these values directly: each is placed on a scale of its own game
settings (a chance, distance or time is Min + value × (Max − Min); flank distance is a
distance, stalk time a time), see [ai.md](../ai.md#style-values).

A field may stop early or be missing; what it leaves out has the Creation Kit's defaults
(UESP): group offensive and the equipment mults 1, avoid threat 0.2; melee 1, special attack
0.1; close range and strafe 0.2; flight 0.5, dive bomb 1, flying attack 0.75. The offensive and
defensive mults have none documented (read as 0.5, TODO(M13); every vanilla CSGD has them). Of
the 197 vanilla styles 50 store 7 of the 8 melee values, 36 five of the flight values (7 three,
6 seven), 7 eight general values and 8 two close-range ones; TestCombatStyleDefensive50 (one
NPC\_) has only the first two general values and an unknown 8-byte CSMD (UESP's
"TestDefensiveStyle"), and TestJGBrutalOffense two general values. Nine have no DATA, among
them csDraugrMissile (named by 84 NPC\_) and csDraugrTank (14): read as flags 0 (TODO(M13):
the engine's flags without DATA).
With DATA exactly one of dueling and flanking is set: dueling 169 (35 of them with dual
wielding), flanking 19 (3). The record flag is on 24 styles, 23 of them with DATA 0x4
(csWEMageShieldStaff without it). NPC\_ ZNAM (3879 NPC\_) names 153 styles (csHumanMissile 360,
csHumanMagic 290, ...); DefaultCombatstyle (form 0x3D) is the default object CSTY.

**AI game settings** are GMST values by editor id (`src/world/game-settings.ts`):
`node tools/gmst-info.ts --prefix fCombat` lists the settings whose editor id starts so with
their values and the plugin that sets them, `--ai` counts and lists the number settings of the
AI's families (Combat, Sneak, Detection, AI, Avoid, Block, Stagger, PowerAttack, Bleedout,
Sandbox, ...). The load order stores 1649 settings (568 floats, 96 integers, one bool, the rest
strings; 52 fCombat, 18 fSneak, one fDetection, 31 fAI, no fAvoid); settings it does not store
keep the engine's built-in values, which are not in the data.

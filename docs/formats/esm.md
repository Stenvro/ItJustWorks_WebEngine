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
5 × 5 get a scene of only those references (with the cell's enable state).

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

**Which weather:** the highest-priority weather region of the camera's cell, else the
climate's list (Tamriel's SkyrimClimate has a single weather: its cells all have weather
regions, e.g. WeatherTundra around Whiterun, WeatherWhiterun inside the city world). A weather
is picked by chance; it changes, with a transition, when the camera enters a cell whose list
does not have it.

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

The directional light is multiplied by the imagespace's sunlight scale. Not documented, so
approximated (TODO(M13)): how eye adapt speed and strength become the two rates (here
`1 − e^(−dt · value / 10)` for x and y), how the bright pass uses threshold and scale (here
`max(c − threshold, 0) · scale`, blurred at quarter resolution with σ = radius / 2) and what
sky scale does (not applied).

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
materials; physics impacts) and by weapons and projectiles (TODO(M11)).
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
- **XPRM** (32 bytes): bounds vec3 (full size; a sphere's radius in x), colour RGB + f32, type
  u32 (1 box, 2 sphere, 3 portal box, 4 line). References to the engine's **CollisionMarker**
  (STAT 0x21) are invisible collision: boxes and spheres on the layer in **XTRI** (u32), else
  L_COLLISIONBOX. RoomMarker, PortalMarker and PlaneMarker primitives are rooms, portals and
  occlusion planes (no collision); activators' primitives are triggers, whose scripts hear
  the player come and go (OnTriggerEnter, OnTriggerLeave; [scripting.md](../scripting.md)).

## Navigation meshes

**NAVM** (`src/world/navmesh.ts`): where actors walk, a child record of a cell (19,201 in the
vanilla load order). Its **NVNM** field (UESP "NVNM Field"; OpenMW's ESM4 loader): version u32
(12); a u32 not documented (a checksum or flags); the worldspace (form id, 0 for interiors), then
for Tamriel its grid (y i16, x i16), else the cell (form id); vertices (count u32, then x y z f32
each, in world coordinates); triangles (count u32, then 16 bytes each: three vertex indices u16,
the triangle across each edge 0–1, 1–2, 2–0 as i16, −1 for none, flags u16, cover u16); links
into other meshes (count u32, then type u32, NAVM form id, triangle u16); door triangles (count
u32, then triangle u16, type u32, door reference form id); cover triangles (count u32, then u16
each); the search grid: divisor u32, cell size x y f32, bounds min and max (x y z f32 each), then
divisor² cells, each a count u32 and its triangles (u16). Every vanilla NVNM is read to its last
byte (`node tools/navmesh-info.ts --verify`). Triangle flags (xEdit): `0x1`–`0x4` edge links,
`0x8` deleted, `0x10` no large creatures, `0x20` overlapping, `0x40` preferred, `0x200` water,
`0x400` door, `0x800` found.

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
  GetCombatTargetHasKeyword (707, combat against dragons: TODO(M10)).
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
always looks the same; TODO(M11): the level from encounter zones and the player). Each leveled
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

## AI packages

**PACK** (`src/ai/package-records.ts`; check: `node tools/package-info.ts --parse`: 7633
vanilla packages, 240 with a procedure tree of their own). After UESP, in field order:

- **PKDT** 12 bytes: misc flags u32 (0x4 must complete, 0x400 once per day, 0x2000 preferred
  speed, 0x20000 always sneak, 0x800000 weapon drawn, 0x20000000 wear sleep outfit, ...),
  type u8 (0x1 a template), interrupt override u8, preferred speed u8 (walk, jog, run, fast
  walk), unknown u8, interrupt flags u32.
- **PSDT** 12 bytes: month i8 (−1 any), day of week i8 (−1 any, 0 Sundas .. 6 Loredas, 7
  weekdays, 8 weekends, 9 Morndas / Middas / Fredas, 10 Tirdas / Turdas), date u8 (0 any),
  hour i8 (−1 any time), minute i8, 3 unused, duration u32 in minutes. Vanilla: 1977 start
  hours, 53 days of the week, no months or dates.
- **CTDA** conditions on when it may run, **QNAM** owner quest, **PKCU** 12 bytes: data input
  count, the template package (its tree runs with this package's inputs), version.
- **Public data inputs:** each **ANAM** (Bool, Int, Float, ObjectList, Location, SingleRef,
  TargetSelector, Topic) is followed by its value: CNAM (u8 bool, i32, f32; an ObjectList's
  f32 is not documented), **PLDT** (type i32: 0 near reference, 1 in cell, 2 near the package
  start, 3 near the editor location, 6 near the linked reference of a keyword, 8 / 9 alias
  reference / location, 12 near self; the form or alias id; radius i32), **PTDA** (type i32: 0
  a specific reference, 1 an object, 2 an object type, 3 the linked reference of a keyword, 4
  a reference alias, 6 self; the form, type or alias id; count i32), PDTO / TPIC topics. Then
  one **UNAM** (u8 id) per input in the same order, and **XNAM** ends them.
- **Procedure tree** (templates, and packages without one): branches in depth-first order,
  each an **ANAM** (Procedure, Sequence, Simultaneous, Random, Stacked), CITC condition count
  and its CTDA, **PRCB** (two u32s, undocumented: the first is the branch's child count in every
  vanilla package), for procedures **PNAM** the procedure (Travel, Sit, Sleep, Patrol, Sandbox,
  Guard, UseIdleMarker, ForceGreet, ... 30 in vanilla), FNAM flags (0x1 success completes the
  package) and **PKC2** the ids of the inputs it takes (u8, repeated; 255 none), PFO2 / PFOR
  undocumented.
- **Procedure data:** UNAM id, BNAM the name the Creation Kit shows ("Patrol Start", "Sleep
  Location", "Target"), PNAM u32 (1: public).
- **POBA / POEA / POCA** on begin / end / change: INAM idle, SCHR, TNAM, PDTO.

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
down (TODO(M9)).

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

The engine reads `Skyrim_Default.ini` over defaults compiled into the executable
(`src/world/ini-settings.ts`; the defaults as SSE's `saveini` writes them). Those used now:
`[Camera]` fOverShoulderPosX 30, fOverShoulderPosZ −10, fVanityModeMinDist 155,
fVanityModeMaxDist 600, fMinCurrentZoom −0.2, fMouseWheelZoomIncrement 0.075,
fMouseWheelZoomSpeed 0.8, fCameraCasterSize 15; `[Controls]` bAlwaysRunByDefault 1,
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
fUnsupportedGravMult 4, fMaxTime 0.0167; `[Interface]` fActivatePickLength 180,
fActivatePickRadius 16.

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
`node tools/dialogue-info.ts <quest>`), after UESP:

- DIAL: FULL (what the player says), PNAM priority, BNAM branch, QNAM quest, DATA (flags u8:
  0x1 do all before repeating; category u8: 0 topic, 1 favor, 2 scene, 3 combat, 4 favors, 5
  detection, 6 service, 7 miscellaneous; subtype u16), SNAM (the subtype's code: CUST, HELO,
  GBYE, HIT\_, SCEN, ...), TIFC (its info count). Its infos sit in its topic children group.
- DLBR: QNAM quest, TNAM category, DNAM flags (0x1 top-level, 0x2 blocking, 0x4 exclusive), SNAM
  the starting topic.
- INFO: ENAM (flags u16: 0x1 goodbye, 0x2 random, 0x4 say once, 0x8 requires player
  activation, 0x40 invisible continue, 0x80 walk away, ...; reset hours u16), PNAM (the info it
  follows: a topic's infos are in this order), TCLT (the topics offered after it), DNAM (the
  info whose responses it shares), RNAM (the player's prompt), ANAM (the speaker), CTDA
  conditions, and per response TRDT (emotion u32, emotion value u32, response number u8 @12,
  sound @16, flags u8 @20: 0x1 use the emotion animation), NAM1 (the text), SNAM / LNAM (the
  speaker's and listener's idles).

A response's voice file is `Sound\Voice\<plugin>\<voice type>\<quest>_<topic>_<info>_<n>.fuz`:
the topic's quest's and the topic's editor ids (cut to 10 and 15 characters when longer than 25
together; a topic without one leaves its part empty), the info's form id as 8 hex digits
without the load order index, the response's number. Checked against all 35,580 voiced
responses of the vanilla data.

## Perk trees

A skill's AVIF (editor id "AV" + its name; Illusion's is still Oblivion's AVMysticism) holds its
perk tree after its own fields (CNAM its category, AVSK four floats: skill use mult, use offset,
improve mult, improve offset). One group per node, in this order: PNAM the perk (0 for the root,
whose grid fields are garbage), FNAM flags, XNAM / YNAM (u32) its grid column and row, HNAM /
VNAM (float) its offset from that grid point, SNAM the skill, CNAM (u32, repeated) the nodes it
leads to by their INAM, INAM (u32) the node's own index. `node tools/perk-info.ts` lists them.

A PERK: FULL, DESC, its requirements (the CTDA before its first effect, PRKE), DATA (u8 trait,
u8 level, u8 rank count, u8 playable, u8 hidden), NNAM the next rank (Armsman00 → 20 → 40 ...);
then its effects (PRKE, DATA, PRKC + CTDA, EPFT, EPFD, PRKF).

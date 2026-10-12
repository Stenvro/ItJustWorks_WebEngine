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
NAM2 water, NAM3 LOD water + NAM4 its height, DNAM default land height and default water height
(f32 each), DATA flags (`0x1` small world, `0x2` can't fast travel, `0x8` no LOD water, `0x10`
no landscape, `0x20` no sky, `0x40` fixed dimensions, `0x80` no grass).

- City worlds (WhiterunWorld, SolitudeWorld, …) have PNAM `0x7f`: their landscape is
  Tamriel's LAND at the same grid position, and their own CELLs hold only the objects.
- Persistent references (NPCs, doors, map markers) live in the persistent cell, not in the
  exterior cell they stand in; the loader sorts them into cells by position.
- A cell's water height is its XCLW, else the water world's default (DNAM). Values beyond
  ±1e9 mean "no water".
- A grid position without a CELL record holds nothing (not even the parent world's land):
  the LOD stays visible there. Around a city world's few cells, the parent's LOD (terrain,
  water, objects) shows what lies outside.

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
BSTreeNode bones; how is not documented (TODO(M7): with the skinning of actors, which the
bones need).

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

- Cloud layers: texture fields `00TX`, `10TX`, … `90TX`, `:0TX`, … (the first character is
  `'0' + layer`), RNAM / QNAM one byte per layer: Y / X scroll speed, `(b − 127) / 1270`
  (−0.1..0.1), PNAM 32 × 4 times × RGBA u8 colours, JNAM 32 × 4 times × f32 alpha, NAM1
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
entries like WLST). A cell's regions are its XCLR form ids.

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
u32, density f32; ICON the particle texture (rain: `effectsxraindrops.dds`, 4 × 2 thin
streaks; snow: `fxsnowsoftsub.dds`, 4 × 4 soft flakes). During a change of weather the new
weather's precipitation starts at its Precipitation Begin Fade In (share of the transition)
and the old one's ends at its End Fade Out. How it is drawn: [../rendering.md](../rendering.md#precipitation).

**Lightning** (`src/world/lightning.ts`): thunder frequency 255 (all calm weathers) has
none; storms use 246 (rain), 203 (snow), the Storm Call shout 15, so lower values flash more
often: read as a mean of value/255 × 30 seconds between flashes, at random (exponential
waits). A flash (a strike, a re-strike after 0.28 s, 0.6 s in all) adds the lightning colour
to the sky colours and half of it to ambient and fog; thunder fades in and out with weather
changes like precipitation (Thunder Begin Fade In, End Fade Out). The interval's scale is
inferred: TODO(M13) compare with the original; thunder sounds: TODO(M6).

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

**WATR:** ANAM opacity (0–100), FNAM flags (`0x1` causes damage, `0x8` flow map, `0x10` blend
normals), NAM2/NAM3/NAM4 the three noise layers' normal maps (SSE; older files use three NNAM;
vanilla names `Data\Textures\Water\DefaultWater.dds`: the path is relative to Data), INAM
imagespace modifier, DNAM 228 bytes (232 in SSE with the flow map scale). DNAM as 4-byte
values (UESP numbering − 1): 4 sun specular power, 5 reflectivity, 6 fresnel, 8/9 above-water
fog near/far, 10/11/12 shallow / deep / reflection colour (RGBA u8), 18–22 displacement,
24 noise falloff, 25–27 wind direction (degrees) and 28–30 wind speed per layer, 33 fog
amount, 35–37 underwater fog amount/near/far, 38 refraction magnitude, 39 specular power,
41 specular radius, 42 specular brightness, 43–45 UV scale and 46–48 amplitude per layer,
49 reflection magnitude, 50 sun sparkle magnitude, 51 sun specular magnitude, 52–55 depth
properties (reflections, refraction, normals, specular), 56 sun sparkle power, 57 flow map
scale.

**Where water is:**

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
field strength, distance, range (+ optional blur radius / no-sky flags). Two vanilla records
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
unique), DNAM u16 master particle system cap + u16 flags, SNAM (looping sound: TODO(M6)). A
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
OR-flagged conditions join the next one into a group; all groups must hold. Recipes use
`GetItemCount` (47, on the player), `GetGlobalValue` (74), `GetVMQuestVariable` (629) and
`GetInCurrentLoc` (359).

**Quest aliases:** ALST starts a reference alias, ALLS a location alias (u32 id); ALFR / ALFL
give its forced reference / location.

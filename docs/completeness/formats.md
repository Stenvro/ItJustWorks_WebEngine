# File formats: completeness checklist

What "complete" means here: every file the local installation's load order and archives hold
(Skyrim.esm, Update.esm, Dawnguard, HearthFires, Dragonborn and the Creation Club content of
Skyrim.ccc) is parsed by our platform-independent readers in `src/formats/`, with nothing
unknown or skipped, each with a Node CLI in `tools/` and tests against the real files. An item
is **done** only when a sweep over the whole data shows it; **open** items say why.

## How it is measured

| Sweep                                 | What it covers                                                    |
| ------------------------------------- | ----------------------------------------------------------------- |
| `node tools/format-census.ts files`   | every file of the VFS by extension, with its reader               |
| `node tools/format-census.ts bsa`     | every archive in Data: names against hashes, every file read      |
| `node tools/format-census.ts esm`     | every (record type, subrecord) pair of the load order vs the code |
| `node tools/format-census.ts strings` | every string table of every language; FULL ids resolve            |
| `node tools/format-census.ts hkx`     | every Havok file by class; every animation sampled                |
| `node tools/nif-stats.ts --parse`     | every block of every mesh consumed exactly                        |
| `node tools/dds-stats.ts`             | every texture's format                                            |
| `node tools/pex-dump.ts --verify`     | every script                                                      |
| `node tools/audio-info.ts --audit`    | every .wav, .xwm and .fuz                                         |
| `node tools/lip-info.ts --all`        | the lip data of every voice line                                  |
| `node tools/tri-info.ts --all`        | every FaceGen morph file                                          |
| `node tools/lod-info.ts --meshes`     | lodsettings, tree lists and blocks, every terrain/object LOD mesh |
| `node tools/seq-info.ts`              | every SEQ file against its plugin's quests                        |
| `node tools/animdata-info.ts --parse` | the animation, animation set and speed data files                 |
| `node tools/swf-info.ts --all`        | every interface movie                                             |

The ESM sweep is static on our side: a subrecord counts as **read** for a record type when one
source file names both (references share one set; subrecords xEdit defines once for many types,
like OBND, MODL, KWDA, VMAD, CTDA, count where any file reads them; count subrecords like KSIZ
count with their entries; the old result-script leftovers SCHR, SCDA, SCTX, SCRO are unused).
**Read elsewhere** means the code reads that subrecord, but in files that do not name the
record type: to check by hand. **Unread** means no code reads it at all.

## Summary (2026-10-29, round 1)

The checklist has **154 items**: 34 format items below and the 120 record types of the load
order (the table at the end). **53 are done** (26 format items, 27 record types). The record types left open are the
bulk: 75 need their "read elsewhere" subrecords checked by hand, 18 have subrecords no code
reads.

Done this round: the last 17 NIF block types (now every one of the 143 the meshes use),
uncompressed Havok animations (the Creation Club fishing rod's clips), SEQ files, the
marketplace's archive (MarketplaceTextures.bsa, opened by the original's marketplace itself),
and the census tool.

## Archives, load order, settings

- [x] BSA v105: all 23 archives in Data, names checked against their hashes, all 172,961 files
      read and decompressed (24.2 GB, 0 failures). `src/formats/bsa`, `format-census bsa`.
- [x] MarketplaceTextures.bsa (the Creation Club menu's images): in no INI list and no
      plugin's; the original's marketplace opens it as it starts. Mounted below the others
      (`src/vfs/load-order.ts`; its rank is TODO(M13), its files are its own).
- [x] Load order: masters, Skyrim.ccc, plugins.txt, ESL slots. `src/vfs/load-order.ts`.
- [x] INI: Skyrim_Default.ini, the player's INIs, plugin INIs. `src/formats/ini`.

## Plugins (ESM/ESP/ESL)

- [x] Record and group headers, zlib-compressed records, XXXX sizes: 10 plugins, 1.2 million
      records, 0 failures. `src/formats/esm/record.ts`, `esm-stats --verify`.
- [x] String tables: all 270 (every language), 834,883 strings decoded, 0 failures.
      `src/formats/esm/strings.ts`, `format-census strings`.
- [x] Every FULL id of the 10 localized plugins resolves (34,958 ids, 0 unresolved).
- [ ] The other localized fields (DESC, BOOK CNAM, INFO NAM1 and RNAM, MESG ITXT, ...) are
      not swept for unresolved ids yet.
- [x] SEQ files: 7, every form id a quest of its plugin (HearthFires.esm's file predates its
      Update.esm master: its ids carry the old index). `src/formats/esm/seq.ts`, `seq-info`.
- [ ] SEQ use: which start-game-enabled quests the original starts from them (a plugin new to
      a save): M12.
- [ ] VMAD (script properties, fragments, aliases): `src/formats/esm/vmad.ts` has unit tests,
      but no sweep over every VMAD of the load order yet.

## Meshes (NIF 20.2.0.7, BS 100)

- [x] Every block type the meshes use has a parser and every block is consumed to its exact
      size: 143 types in 22,761 meshes (and the 10,662 LOD meshes), 0 problems.
      `src/formats/nif`, `nif-stats --parse`; `tests/assets.int.test.ts` fails on any unread
      block.
- [x] The 17 types that were skipped until this round: BSInvMarker, BSMultiBound,
      BSMultiBoundOBB, BSMultiBoundAABB, NiBooleanExtraData, NiStringsExtraData,
      NiFloatExtraData, NiBinaryExtraData, BSDecalPlacementVectorExtraData, BSBoneLODExtraData,
      BSLagBoneController, NiBSBoneLODController, NiPathInterpolator, NiLookAtInterpolator,
      NiMeshParticleSystem, NiMeshPSysData, BSPSysHavokUpdateModifier
      (`src/formats/nif/extra-blocks.ts` and the animation and particle parsers).
- [ ] Fields read past but not kept: 107 reads in `src/formats/nif` (mostly NiGeometryData's
      has-flags and the BS 100 constants of NiPSysData and the blend interpolators); to review
      one by one and keep what the engine uses.
- [x] The one BS 83 mesh (a Skyrim LE leftover) parses as well.

## Textures (DDS)

- [x] 32,945 textures, 0 failures: BC1, BC2, BC3, BGRA8 and RGBA8 (the vanilla data has no
      BC5 or BC7), 58 cubemaps, 378 without mipmaps. `src/formats/dds`, `dds-stats`.
- [x] The 119 book images (textures\interface\books\*.png, `img://` in book texts) are PNGs the
      browser decodes.

## Havok (HKX)

- [x] 7,735 files (packfiles and the Creation Club tagfiles, .hkt), 0 failures.
- [x] 6,130 animations sampled: spline-compressed (every vanilla clip) and, new this round,
      interleaved uncompressed ones (the fishing rod's cast and ready clips).
      `src/formats/hkx/animation.ts`, `format-census hkx`.
- [x] Behavior graphs: 363 of the 366 graphs meshes name load; the other 3 are faults of the
      data (two missing files, one project without a character). `hkx-info --audit`.
- [ ] The ragdoll physics of the 48 skeleton files (hkaRagdollInstance, hkpPhysicsData and 18
      more hkp classes in hkMemoryResourceContainer/Handle): not read; our ragdolls are built
      from skeleton.nif's bhk blocks. Which the original builds its bodies from: TODO(M13).
- [ ] Class members: packfile objects are read by member offset; no check yet that every
      serialized member of the 78 read classes is used.

## Scripts (PEX)

- [x] 14,302 scripts, 310,184 instructions, 0 failures. `src/formats/pex`, `pex-dump --verify`.

## Audio

- [x] 81,655 sound files (WAV, xWMA, FUZ), 0 broken. `src/formats/audio`, `audio-info --audit`.
- [x] Lip data of 74,070 voice lines, 0 failures. `src/formats/audio/lip.ts`, `lip-info --all`.
- [x] Bink video (video\bgs_logo.bik): ffmpeg.wasm turns it into MP4 (`src/audio/bink-video.ts`).

## Interface

- [x] 59 movies (53 .swf, 6 .gfx): header, tags, exported and imported symbols, fonts, which is
      what we read ourselves (Ruffle plays them). `src/formats/swf`, `swf-info --all`.
- [x] interface\*.txt: translations (`translation.ts`), fontconfig, credits; the control maps,
      gamepad and keyboard files of every platform folder (`src/formats/controlmap`).

## Animation data

- [x] meshes\animationdatasinglefile.txt, animationsetdatasinglefile.txt,
      speeddatasinglefile.txt and the per-project files (1,221). `src/formats/animdata`,
      `animdata-info --parse`.

## Faces and LOD

- [x] FaceGen morphs: 569 .tri, 0 failures. `src/formats/nif/tri.ts`, `tri-info --all`.
- [x] .egm: none in the installation.
- [x] LOD: 12 lodsettings, 9 tree lists (.lst), 386 tree blocks (.btt), 9,584 terrain and
      1,078 object LOD meshes (.btr, .bto: NIFs), no problems. `src/formats/lod`,
      `lod-info --meshes`.

## Saves (ESS)

There is no .ess in the installation, so these cannot be swept here: `ess-info` on a player's
saves measures them (`tests/sim-ess-import.int.test.ts` reads one).

- [ ] Change forms: references are read up to the actor data and animation parts (the actor
      part stops the read), cells partly, quests and NPCs partly, the other base types only
      their form flags (and factions' flags). `src/formats/ess/change-forms.ts`.
- [ ] Global data: 13 of 30 types read (Misc Stats, Player Location, TES, Global Variables,
      Created Objects, Effects, Weather, Audio, Sky Cells, Papyrus, Anim Objects, Timer,
      Synchronized Animations); open: Process Lists, Combat, Interface, Actor Causes, 104,
      Detection Manager, Location MetaData, Quest Static Data, StoryTeller, Magic Favorites,
      PlayerControls, Story Event Manager, Ingredient Shared, MenuControls, MenuTopicManager,
      Temp Effects, Main. `src/formats/ess/global-data.ts`.

## Files the original does not load

Shipped by mistake or for the editor; listed so the file census has no unknown extension:
.hkb, .hkc, .hkp (Havok editor sources beside the .hkt the game reads), .psd, .csv and .xlsx
(an image file and the console amiibo tables), and shadersfx\shaders011.fxp (the original's
compiled DirectX 11 shaders: our renderer has its own).

## Handed to other areas

Read now, used not yet (not counted here): the mesh particles of NiMeshParticleSystem (one
mesh; rendering), BSLagBoneController and NiBSBoneLODController (animation), BSInvMarker (the
inventory menu's turn and zoom), BSMultiBound boxes (room culling), NiPathInterpolator and
NiLookAtInterpolator (animated objects).

## Record types

`format-census esm`: 120 record types, 1,414 (record, subrecord) pairs: 700 read, 640 read
elsewhere (to check), 74 unread. "Unread" lists every subrecord no code reads; "read elsewhere"
the first eight by count (all of them: run the census). Notable unread ones: REFR XNDP (a
door's navmesh link), XPWR (water reflections), XALP (alpha), XLIB (a leveled item's base),
XPPA (patrol data), XACT (action flags), XATR (attach to), NPC_ CSDT/CSDI/CSDC (creature sound
overrides), CELL MHDT/TVDT (height and occlusion data), WRLD OFST (offset table), LCTN's
location reference lists (LCEC, LCID, LCEP and the AC/RC ones), RACE PHWT/PHTN (FaceGen phoneme
targets), the ARMA/ARMO texture hash lists (MO2T..MO5T), QUST FLTR and TES4 INTV/INCC (the
Creation Kit's own).

| Record | Records | Status | Subrecords | Unread                                                                                                        | Read elsewhere (to check)                     |
| ------ | ------: | ------ | ---------: | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| AACT   |      71 | done   |          2 |                                                                                                               |                                               |
| ACHR   |   13075 | open   |         23 | XPPA XIS2 XLRL                                                                                                | XLKR XLCM XRGD XRGB XPRD INAM PDTO XHOR       |
| ACTI   |    2713 | check  |         22 |                                                                                                               | PNAM KNAM                                     |
| ADDN   |      92 | check  |          6 |                                                                                                               | DATA DNAM                                     |
| ALCH   |     623 | done   |         15 |                                                                                                               |                                               |
| AMMO   |      78 | done   |         11 |                                                                                                               |                                               |
| ANIO   |      82 | done   |          4 |                                                                                                               |                                               |
| APPA   |      45 | open   |          6 | QUAL                                                                                                          | DATA                                          |
| ARMA   |    1171 | open   |         23 | MO2T MO3T MO4T MO5T                                                                                           | RNAM DNAM BODT SNDD BOD2 NAM0 NAM1 NAM2 (+2)  |
| ARMO   |    3915 | open   |         26 | MO2T MO4T                                                                                                     | RNAM BIDS BAMT                                |
| ARTO   |     320 | done   |          5 |                                                                                                               |                                               |
| ASPC   |      52 | check  |          5 |                                                                                                               | RDAT                                          |
| ASTP   |      20 | open   |          6 | MPRT FPRT MCHT FCHT                                                                                           | DATA                                          |
| AVIF   |     153 | check  |         14 |                                                                                                               | CNAM AVSK PNAM FNAM XNAM HNAM VNAM SNAM (+2)  |
| BOOK   |    1141 | done   |         14 |                                                                                                               |                                               |
| BPTD   |      49 | check  |         11 |                                                                                                               | BPTN BPNN BPNT BPNI BPND NAM1 NAM4 NAM5       |
| CAMS   |     194 | check  |          5 |                                                                                                               | DATA MNAM                                     |
| CELL   |   77337 | open   |         25 | MHDT TVDT XILL XWEM XWCU XWCS XWCN                                                                            | LTMP XCLW XCLR XLCN XCWT XCIM XCMO XCLL (+6)  |
| CLAS   |     159 | check  |          4 |                                                                                                               | DATA                                          |
| CLFM   |     181 | check  |          4 |                                                                                                               | CNAM FNAM                                     |
| CLMT   |       9 | check  |          7 |                                                                                                               | WLST TNAM FNAM GNAM                           |
| COBJ   |    1616 | done   |          8 |                                                                                                               |                                               |
| COLL   |      55 | open   |          8 | INTV                                                                                                          | FNAM                                          |
| CONT   |     629 | open   |         13 | COED                                                                                                          | CNTO                                          |
| CPTH   |     211 | check  |          6 |                                                                                                               | ANAM DATA SNAM                                |
| CSTY   |     200 | open   |          8 | CSMD                                                                                                          | CSGD CSME CSCR CSLR CSFL DATA                 |
| DEBR   |       6 | check  |          3 |                                                                                                               | DATA                                          |
| DIAL   |   20044 | check  |          8 |                                                                                                               | PNAM QNAM DATA SNAM TIFC BNAM                 |
| DLBR   |    4017 | check  |          5 |                                                                                                               | QNAM TNAM DNAM SNAM                           |
| DLVW   |    1517 | check  |          6 |                                                                                                               | QNAM DNAM ENAM BNAM TNAM                      |
| DOBJ   |       6 | done   |          1 |                                                                                                               |                                               |
| DOOR   |     330 | done   |         11 |                                                                                                               |                                               |
| DUAL   |       2 | check  |          3 |                                                                                                               | DATA                                          |
| ECZN   |     359 | done   |          2 |                                                                                                               |                                               |
| EFSH   |     280 | check  |          7 |                                                                                                               | ICON ICO2 NAM7 NAM8 NAM9                      |
| ENCH   |     766 | done   |          8 |                                                                                                               |                                               |
| EQUP   |       7 | check  |          3 |                                                                                                               | DATA PNAM                                     |
| EXPL   |     282 | check  |          8 |                                                                                                               | DATA MNAM                                     |
| EYES   |       8 | check  |          4 |                                                                                                               | ICON DATA                                     |
| FACT   |    1424 | check  |         21 |                                                                                                               | CRVA VENV XNAM PLVD VEND VENC CRGR WAIT (+7)  |
| FLOR   |     122 | check  |         13 |                                                                                                               | PNAM                                          |
| FLST   |    1231 | done   |          2 |                                                                                                               |                                               |
| FSTP   |     192 | check  |          3 |                                                                                                               | DATA ANAM                                     |
| FSTS   |      55 | check  |          3 |                                                                                                               | XCNT DATA                                     |
| FURN   |     517 | check  |         22 |                                                                                                               | PNAM KNAM ENAM NAM0 XMRK FNMK                 |
| GLOB   |    1260 | check  |          3 |                                                                                                               | FNAM                                          |
| GMST   |    1659 | done   |          2 |                                                                                                               |                                               |
| GRAS   |      60 | check  |          5 |                                                                                                               | DATA                                          |
| HAZD   |      51 | check  |          7 |                                                                                                               | DATA MNAM                                     |
| HDPT   |     814 | check  |         12 |                                                                                                               | DATA PNAM RNAM NAM0 NAM1 TNAM HNAM CNAM       |
| IDLE   |    4370 | done   |          8 |                                                                                                               |                                               |
| IDLM   |      94 | check  |          6 |                                                                                                               | IDLF IDLT IDLA                                |
| IMAD   |     295 | check  |         57 |                                                                                                               | DNAM BNAM VNAM TNAM NAM3 RNAM SNAM UNAM (+15) |
| IMGS   |     506 | check  |          6 |                                                                                                               | HNAM CNAM TNAM DNAM ENAM                      |
| INFO   |   41437 | check  |         24 |                                                                                                               | CNAM ENAM TRDT NAM1 NAM2 NAM3 PNAM TCLT (+11) |
| INGR   |     181 | done   |         15 |                                                                                                               |                                               |
| IPCT   |     663 | check  |         10 |                                                                                                               | DODT NAM1 NAM2 ENAM                           |
| IPDS   |     339 | check  |          2 |                                                                                                               | PNAM                                          |
| KEYM   |     381 | done   |         11 |                                                                                                               |                                               |
| KYWD   |    1290 | check  |          2 |                                                                                                               | CNAM                                          |
| LAND   |   54079 | check  |          7 |                                                                                                               | VNML VHGT ATXT VTXT BTXT VCLR                 |
| LCRT   |     483 | check  |          2 |                                                                                                               | CNAM                                          |
| LCTN   |     841 | open   |         25 | LCEC LCID LCEP ACID ACEP ACEC RCEC                                                                            | PNAM LCSR MNAM RNAM LCPR LCUN CNAM ACSR (+6)  |
| LGTM   |     131 | check  |          3 |                                                                                                               | DALC                                          |
| LIGH   |     506 | done   |          9 |                                                                                                               |                                               |
| LSCR   |     374 | check  |         10 |                                                                                                               | NNAM SNAM RNAM ONAM XNAM                      |
| LTEX   |     130 | check  |          7 |                                                                                                               | HNAM                                          |
| LVLI   |    4017 | check  |          7 |                                                                                                               | LVLD LVLF LVLO LVLG                           |
| LVLN   |     691 | open   |          9 | COED                                                                                                          | LVLD LVLF LVLO                                |
| LVSP   |      33 | check  |          6 |                                                                                                               | LVLD LVLF LVLO                                |
| MATO   |      74 | check  |          5 |                                                                                                               | DATA DNAM                                     |
| MATT   |      80 | check  |          7 |                                                                                                               | MNAM CNAM BNAM FNAM PNAM HNAM                 |
| MESG   |    1055 | check  |          9 |                                                                                                               | INAM DNAM TNAM ITXT QNAM                      |
| MGEF   |    1812 | check  |         10 |                                                                                                               | SNDD                                          |
| MISC   |    1063 | check  |         13 |                                                                                                               | ICON                                          |
| MOVT   |     107 | check  |          4 |                                                                                                               | MNAM SPED INAM                                |
| MSTT   |     838 | done   |         12 |                                                                                                               |                                               |
| MUSC   |      74 | check  |          5 |                                                                                                               | FNAM PNAM WNAM                                |
| MUST   |     352 | check  |         11 |                                                                                                               | CNAM ANAM DNAM BNAM FNAM LNAM                 |
| NAVI   |       8 | done   |          4 |                                                                                                               |                                               |
| NAVM   |   20064 | check  |          4 |                                                                                                               | PNAM NNAM                                     |
| NPC_   |    6626 | open   |         58 | CSDT CSDI CSDC                                                                                                | RNAM AIDT CNAM NAM5 NAM6 NAM7 NAM8 QNAM (+27) |
| OTFT   |     639 | check  |          2 |                                                                                                               | INAM                                          |
| PACK   |    7671 | check  |         37 |                                                                                                               | PKDT PSDT PKCU ANAM UNAM XNAM POBA INAM (+19) |
| PERK   |     532 | check  |         15 |                                                                                                               | DATA PRKE PRKF EPFT EPFD PRKC NNAM EPF3 (+1)  |
| PGRE   |      44 | done   |          5 |                                                                                                               |                                               |
| PHZD   |     394 | done   |          5 |                                                                                                               |                                               |
| PROJ   |     248 | check  |         12 |                                                                                                               | NAM1 VNAM NAM2                                |
| QUST   |    2455 | open   |         55 | FLTR ALNT                                                                                                     | NEXT ANAM FNAM ALID ENAM QSDT ALFE ALFD (+25) |
| RACE   |     214 | open   |         69 | MTNM UNES PHWT TINL PHTN                                                                                      | BOD2 MNAM ANAM VTCK PNAM UNAM NAM1 INDX (+45) |
| REFR   |  866240 | open   |         62 | XPPA XLIB XNDP XPWR XALP XMBR XACT XWCN XWCU XIS2 XTNM XATR XLRL XOCP XMBP XCVL XSPC XFVC XLTW XHTW XCZC XCZA | XLKR XRDS XLIG XRGD INAM XPRD PDTO XMBO (+5)  |
| REGN   |     389 | open   |         12 | RCLR RPLI RDOT RDMP                                                                                           | RDAT RDSA RDWT RDMO ICON                      |
| RELA   |     673 | done   |          2 |                                                                                                               |                                               |
| REVB   |      11 | check  |          2 |                                                                                                               | DATA                                          |
| RFCT   |     168 | done   |          2 |                                                                                                               |                                               |
| SCEN   |    2142 | done   |         29 |                                                                                                               |                                               |
| SCRL   |     109 | done   |         16 |                                                                                                               |                                               |
| SHOU   |     117 | check  |          5 |                                                                                                               | SNAM                                          |
| SLGM   |      20 | done   |         11 |                                                                                                               |                                               |
| SMBN   |     128 | check  |          8 |                                                                                                               | PNAM SNAM DNAM XNAM                           |
| SMEN   |      28 | check  |          7 |                                                                                                               | PNAM SNAM DNAM XNAM ENAM                      |
| SMQN   |     536 | check  |         13 |                                                                                                               | PNAM SNAM DNAM XNAM QNAM NNAM RNAM MNAM (+1)  |
| SNCT   |      18 | check  |          6 |                                                                                                               | FNAM VNAM PNAM UNAM                           |
| SNDR   |    3296 | check  |         10 |                                                                                                               | CNAM ANAM ONAM BNAM GNAM LNAM FNAM            |
| SOPM   |      86 | check  |          8 |                                                                                                               | MNAM NAM1 ANAM ONAM FNAM CNAM                 |
| SOUN   |    1191 | check  |          5 |                                                                                                               | SNDD                                          |
| SPEL   |    1561 | check  |         11 |                                                                                                               | EFIT                                          |
| SPGD   |      18 | check  |          3 |                                                                                                               | DATA ICON                                     |
| STAT   |   12626 | check  |          7 |                                                                                                               | MNAM                                          |
| TACT   |      30 | check  |          8 |                                                                                                               | PNAM                                          |
| TES4   |      10 | open   |          8 | INTV INCC                                                                                                     | DATA                                          |
| TREE   |     288 | done   |          9 |                                                                                                               |                                               |
| TXST   |     790 | check  |         11 |                                                                                                               | TX00 DNAM TX01 TX07 TX03 TX04 TX05 DODT (+1)  |
| VOLI   |      42 | check  |         13 |                                                                                                               | CNAM DNAM ENAM FNAM GNAM HNAM INAM JNAM (+4)  |
| VTYP   |     183 | check  |          2 |                                                                                                               | DNAM                                          |
| WATR   |      92 | check  |         18 |                                                                                                               | ANAM FNAM DATA DNAM GNAM NAM0 NAM1 NAM2 (+6)  |
| WEAP   |    3359 | check  |         29 |                                                                                                               | VNAM BAMT BIDS INAM SNAM XNAM NNAM UNAM       |
| WOOP   |     107 | check  |          3 |                                                                                                               | TNAM                                          |
| WRLD   |      94 | open   |         28 | OFST MHDT WCTR XWEM                                                                                           | ONAM NAMA DATA NAM0 NAM9 WNAM PNAM XLCN (+11) |
| WTHR   |     177 | check  |         55 |                                                                                                               | LNAM MNAM NNAM PNAM NAM0 FNAM DATA IMSP (+44) |

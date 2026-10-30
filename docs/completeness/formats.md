# File formats: completeness checklist

What "complete" means here: every file the local installation's load order and archives hold
(Skyrim.esm, Update.esm, Dawnguard, HearthFires, Dragonborn and the Creation Club content of
Skyrim.ccc) is parsed by our platform-independent readers in `src/formats/`, with nothing
unknown or skipped, each with a Node CLI in `tools/` and tests against the real files. An item
is **done** only when a sweep over the whole data shows it; **open** items say why.

## How it is measured

| Sweep                                     | What it covers                                                    |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `node tools/format-census.ts files`       | every file of the VFS by extension, with its reader               |
| `node tools/format-census.ts bsa`         | every archive in Data: names against hashes, every file read      |
| `node tools/format-census.ts esm`         | every subrecord of every record decoded by its layout             |
| `node tools/format-census.ts strings`     | every string table of every language; FULL ids resolve            |
| `node tools/format-census.ts hkx`         | every Havok file by class; every animation sampled                |
| `node tools/format-census.ts hkx-members` | every serialized member of every Havok object: read or not        |
| `node tools/hkx-physics.ts`               | the ragdoll physics of every skeleton file                        |
| `node tools/nif-stats.ts --parse`         | every block of every mesh consumed exactly                        |
| `node tools/dds-stats.ts`                 | every texture's format                                            |
| `node tools/pex-dump.ts --verify`         | every script                                                      |
| `node tools/audio-info.ts --audit`        | every .wav, .xwm and .fuz                                         |
| `node tools/lip-info.ts --all`            | the lip data of every voice line                                  |
| `node tools/tri-info.ts --all`            | every FaceGen morph file                                          |
| `node tools/lod-info.ts --meshes`         | lodsettings, tree lists and blocks, every terrain/object LOD mesh |
| `node tools/seq-info.ts`                  | every SEQ file against its plugin's quests                        |
| `node tools/animdata-info.ts --parse`     | the animation, animation set and speed data files                 |
| `node tools/swf-info.ts --all`            | every interface movie                                             |

The ESM sweep decodes every subrecord of every record of the load order by its layout
(`src/formats/esm/record-layouts.ts`, after xEdit's TES5 definitions; VMAD by `vmad.ts`): a
pair is **parsed** when every one of its subrecords consumes its data exactly, its form ids index
a master or the plugin and its string ids resolve. Nothing depends on names in source files.
Beside it the census lists, per record type, the subrecords no engine code outside
`src/formats` names (by source text): parsed, used by: open, which is the other areas' work.

## Summary (2026-10-30, round 8)

The checklist has **157 items**: 37 format items below and the 120 record types of the load
order (the table at the end). **155 are done** (35 format items, all 120 record types). Open:
the save game's change forms (every one of both saves reads to its end since round 8, but an
actor's AI process data is found by its shape, not decoded) and global data (every entry of
both saves reads to its last byte since round 8, but the weather's tail and two types no save
holds are kept as bytes).

Round 8 (the two real saves): the player's data read to its end (camera, quest log, perks,
tints, ...), the combat AI's objects (30 classes and the templates, the combat controller with
its blackboard and behaviour tree state, `src/formats/ess/combat.ts`), the combat table's
threats, the temp effects' third list; the import restores the player's experience, legendary
counts and perks; the SEQ files' quest set is built and its use known.

Round 6 (two real saves): the Papyrus data read to its last byte (u32 string indices and u64
handles in Special Edition saves, the stacks' frames, messages, suspended stacks and the
registrations), every change form type read to its end but ACHR after its movement data, and
every actor's actor values; the import takes the scripts' states and is checked against a real
save (the player's place, items, MQ101's stages, actor values).

Done this round: the change forms by the original's layouts for every flag UESP lists and every
extra data type the original writes data for (but Interaction and two package cases), actors
through their actor values, factions, leveled lists, the NPC attributes flag (no data), quest
objectives' states; the import applies actors' actor values and faction changes, quest
objectives (failed too) and leveled list additions.

Round 4: every Havok member set in the data is read (the 60 that were not: 723 of 753
read now, the rest zero in every file or not data), and the ones that change how a graph runs
are wired into the behavior runtime (silent events, the blender children's world-from-model
weight, the damping modifier's enable, bit bindings). The seven magic projects that failed to
load are projects without a loadable character: they give no graph, as in the original.

Round 3: the ragdoll physics of the 48 skeleton files (every serialized member of the
20 classes), every Havok class laid out as the original's class reflection says (which fixed the
foot IK driver info's flags and five object sizes), the member census (`format-census
hkx-members`), and readers for the 17 global data types that had none.

Round 2: every (record type, subrecord) pair parsed exactly (1,414 pairs; the 18 record
types with subrecords no code read among them), every VMAD of the load order (24,631) read to
its end, every localized field's string id resolved (105,535), and the NIF fields read past
reviewed: the ones the engine can use are kept, the rest are named below.

Round 1: the last 17 NIF block types, uncompressed Havok animations (the Creation Club fishing
rod's clips), SEQ files, the marketplace's archive and the census tool.

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
- [x] Every other localized field (DESC, BOOK CNAM, INFO NAM1 and RNAM, MESG ITXT, PERK EPF2,
      the GMST strings, ...): 105,535 string ids in all, 0 unresolved. `format-census esm`.
- [x] Every subrecord of every record has a layout and decodes exactly: 1,414 (record type,
      subrecord) pairs of 120 record types (the table at the end). `src/formats/esm/layout.ts`,
      `record-layouts.ts`, `format-census esm`, `tests/record-layouts.int.test.ts`.
- [x] SEQ files: 7, every form id a quest of its plugin (HearthFires.esm's file predates its
      Update.esm master: its ids carry the old index). `src/formats/esm/seq.ts`, `seq-info`.
- [x] SEQ use: observed in the original: as each plugin loads it reads `SEQ\<plugin>.SEQ`,
      moves every id into the load order by that plugin and adds it to one set of quests,
      which decides whose topics' infos load with the game (shared-info topics' and the set's
      quests'; the rest as their quest starts). `RecordDatabase.startGameQuests()`,
      `DialogueIndex.loadsWithGame()`, `tests/records.int.test.ts`. Ours reads every info at
      once, which changes no behaviour (TODO(M13): the deferred read, for memory).
- [x] VMAD (script properties, fragments, aliases): all 24,631 of the load order read to their
      last byte (every script, property, fragment and alias script). `src/formats/esm/vmad.ts`,
      `format-census esm`.

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
- [x] Fields read past: reviewed one by one (107 reads). Kept now: NiSwitchNode's flags,
      BSMultiBoundNode's multi bound and culling mode (the link to its BSMultiBound),
      BSOrderedNode's alpha sort bound, BSValueNode's flags, the min/max/current of BSRangeNode,
      BSBlastNode and BSDebrisNode, NiLODNode's LOD data, BSMasterParticleSystem's cap and
      systems, the LOD triangle counts of BSLODTriShape and BSMeshLODTriShape,
      bhkBlendCollisionObject's gains, NiControllerSequence's anim notes. Not kept, by design:
      the has-flags and BS 100 constants of NiGeometryData and NiPSysData (the arrays they
      announce are read or absent), the blend interpolators' runtime state (rewritten by the
      engine as it blends), the skin partition's copies of the vertex weights and bone indices
      (the vertex data has them), NiGeometry's pre-Skyrim material list (empty), NiCamera's
      viewport, the Havok CInfo padding, pointers and radius and scale copies, the compressed
      mesh's bit masks and bounding box (the chunks carry what decoding needs), the header's maximum string length
      and group sizes, and the unknowns of .tri files.
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
      data (two missing files, one project without a character). `hkx-info --audit`. The 7
      project files without a loadable character (6 under meshes\magic name a character file that
      is in no archive and are named by nothing; shoutimod.hkx names none) give no graph, as in
      the original (`projectHasCharacter`, docs/formats/hkx.md "Projects without a character").
- [x] The ragdoll physics of the 48 skeleton files (hkaRagdollInstance, hkpPhysicsData and the
      18 other classes: bodies, motions, shapes, constraints, motors, the resource container
      tree): 1,040 bodies, 1,922 constraint instances, 0 problems, every serialized member.
      `src/formats/hkx/physics.ts`, `hkx-physics`, `tests/hkx-physics.int.test.ts`. Which the
      original simulates: skeleton.nif's bhk bodies and constraints, matched by name to the HKX
      ragdoll skeleton's bones, as ours do (docs/formats/hkx.md, "Ragdoll physics").
- [x] Class layouts: the 99 classes the files hold (753 serialized members, the embedded
      structs with them) match the original's class reflection member for member
      (`layouts.ts`). Fixed: hkbFootIkDriverInfo's flags (no useTrackData; lockFeetWhenPlanted
      at 64, which our reader took from 65), five object sizes, the mapper's chain mappings.
- [x] Class members read: 723 of 753, every member set anywhere in the data
      (`format-census hkx-members`); 27 are zero or null in every file (runtime state, null
      pointers, empty arrays) and 3 are not data (two runtime binding indices, padding).
      Wired into the behavior runtime: silent events, world-from-model weights, the damping
      enable, bit bindings. Read but not applied yet (TODO(M13)): sync points, the powered
      ragdoll's world-from-model mode and bone weights, narrow quadruped foot IK, hkbNode user
      data. docs/formats/hkx.md, "Class members".

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

There is no .ess in the installation; two real saves of the maintainer's (New Game to Helgen
keep, 2026-10-30) are measured with `ess-info`, and `tests/sim-ess-import.int.test.ts` checks
and imports the first of them when it is there.

- [x] Papyrus data (global data 1001): read to its last byte on both saves (round 6). Special
      Edition widens the string indices to u32 and the VM handles to u64; the running stacks
      with their frames and code, function messages, suspended stacks and the game's script
      registrations are read (`src/formats/ess/papyrus.ts`). Their sizes for the parts no save
      held yet (queued unbinds, latent function queues, LOS events, the last five lists) are
      xEdit's (TODO(M13)).
- [ ] Change forms: every one of both saves (21,599) is read to its end, all 4,727 actors
      included (round 7: the movement controller, `src/formats/ess/movement.ts`; round 8: the
      player's data to its end, `player.ts`, and the combat AI's objects in 12 combat
      controllers and 6 combat pathing requests, `combat.ts`). Open: the AI process data
      (found by its shape, not decoded: its top level is known, the packages' running data by
      procedure and the animation stream's variables are not), a package the game made (in
      PACK and in the trespass and package-data extras), a grenade's constraints and the
      combat paths' classes (none in the saves; built from the original's layouts).
- [ ] Global data: every one of the 30 types has a reader, and `readGlobalData` (run by
      `ess-info` and the save test) says what each leaves. Round 8: every entry of both saves
      reads to its last byte (the combat table's threats are combat objects; temp effects
      have three lists). Open: kept as bytes where nothing documents them: 104 (in neither
      save), the story event manager's entries (none in the saves), the weather's tail; the
      combat search's detail is UESP's layout (none in the saves).

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

`format-census esm`: 120 record types, 1,414 (record, subrecord) pairs: **1,414 parsed exactly**
(every subrecord of every record), 0 with problems, 0 without a layout. 772 pairs are named by
engine code outside `src/formats`; the other 642 are parsed, used by: open (the last column, the
first eight by count: run the census for all). Notable among them: REFR XNDP (a door's navmesh
link), XPWR (water reflections), XALP (alpha), XLIB (a leveled item's base), XPPA (patrol
data), XACT (action flags), XATR (attach to), NPC_ CSDT/CSDI/CSDC (creature sound overrides),
CELL MHDT/TVDT (height and occlusion data), WRLD OFST (offset table), LCTN's location reference
lists, RACE PHWT/PHTN (FaceGen phoneme targets) and the ARMA/ARMO texture hash lists
(MO2T..MO5T).

| Record | Records | Status | Subrecords | Not named by engine code (use: other areas)   |
| ------ | ------: | ------ | ---------: | --------------------------------------------- |
| AACT   |      71 | parsed |          2 |                                               |
| ACHR   |   13075 | parsed |         23 | XLKR XLCM XRGD XRGB XPRD XPPA INAM PDTO (+3)  |
| ACTI   |    2713 | parsed |         22 | PNAM KNAM                                     |
| ADDN   |      92 | parsed |          6 | DATA DNAM                                     |
| ALCH   |     623 | parsed |         15 |                                               |
| AMMO   |      78 | parsed |         11 |                                               |
| ANIO   |      82 | parsed |          4 |                                               |
| APPA   |      45 | parsed |          6 | QUAL DATA                                     |
| ARMA   |    1171 | parsed |         23 | RNAM DNAM MO2T BODT MO3T SNDD BOD2 MO4T (+6)  |
| ARMO   |    3915 | parsed |         26 | MO2T MO4T BIDS BAMT                           |
| ARTO   |     320 | parsed |          5 |                                               |
| ASPC   |      52 | parsed |          5 | RDAT                                          |
| ASTP   |      20 | parsed |          6 | MPRT FPRT DATA MCHT FCHT                      |
| AVIF   |     153 | parsed |         14 | CNAM AVSK PNAM FNAM XNAM HNAM VNAM SNAM (+2)  |
| BOOK   |    1141 | parsed |         14 |                                               |
| BPTD   |      49 | parsed |         11 | BPTN BPNN BPNT BPNI BPND NAM1 NAM4 NAM5       |
| CAMS   |     194 | parsed |          5 | DATA MNAM                                     |
| CELL   |   77337 | parsed |         25 | LTMP XCLW XCLR MHDT TVDT XLCN XCWT XCIM (+13) |
| CLAS   |     159 | parsed |          4 | DATA                                          |
| CLFM   |     181 | parsed |          4 | CNAM FNAM                                     |
| CLMT   |       9 | parsed |          7 | WLST TNAM FNAM GNAM                           |
| COBJ   |    1616 | parsed |          8 |                                               |
| COLL   |      55 | parsed |          8 | FNAM INTV                                     |
| CONT   |     629 | parsed |         13 | CNTO COED                                     |
| CPTH   |     211 | parsed |          6 | ANAM DATA SNAM                                |
| CSTY   |     200 | parsed |          8 | CSGD CSME CSCR CSLR CSFL DATA CSMD            |
| DEBR   |       6 | parsed |          3 | DATA                                          |
| DIAL   |   20044 | parsed |          8 | PNAM QNAM DATA SNAM TIFC BNAM                 |
| DLBR   |    4017 | parsed |          5 | QNAM TNAM DNAM SNAM                           |
| DLVW   |    1517 | parsed |          6 | QNAM DNAM ENAM BNAM TNAM                      |
| DOBJ   |       6 | parsed |          1 |                                               |
| DOOR   |     330 | parsed |         11 |                                               |
| DUAL   |       2 | parsed |          3 | DATA                                          |
| ECZN   |     359 | parsed |          2 |                                               |
| EFSH   |     280 | parsed |          7 | ICON ICO2 NAM7 NAM8 NAM9                      |
| ENCH   |     766 | parsed |          8 |                                               |
| EQUP   |       7 | parsed |          3 | DATA PNAM                                     |
| EXPL   |     282 | parsed |          8 | DATA MNAM                                     |
| EYES   |       8 | parsed |          4 | ICON DATA                                     |
| FACT   |    1424 | parsed |         21 | CRVA VENV XNAM PLVD VEND VENC CRGR WAIT (+7)  |
| FLOR   |     122 | parsed |         13 | PNAM                                          |
| FLST   |    1231 | parsed |          2 |                                               |
| FSTP   |     192 | parsed |          3 | DATA ANAM                                     |
| FSTS   |      55 | parsed |          3 | XCNT DATA                                     |
| FURN   |     517 | parsed |         22 | PNAM KNAM ENAM NAM0 XMRK FNMK                 |
| GLOB   |    1260 | parsed |          3 | FNAM                                          |
| GMST   |    1659 | parsed |          2 |                                               |
| GRAS   |      60 | parsed |          5 | DATA                                          |
| HAZD   |      51 | parsed |          7 | DATA MNAM                                     |
| HDPT   |     814 | parsed |         12 | DATA PNAM RNAM NAM0 NAM1 TNAM HNAM CNAM       |
| IDLE   |    4370 | parsed |          8 |                                               |
| IDLM   |      94 | parsed |          6 | IDLF IDLT IDLA                                |
| IMAD   |     295 | parsed |         57 | DNAM BNAM VNAM TNAM NAM3 RNAM SNAM UNAM (+5)  |
| IMGS   |     506 | parsed |          6 | HNAM CNAM TNAM DNAM ENAM                      |
| INFO   |   41437 | parsed |         24 | CNAM ENAM TRDT NAM1 NAM2 NAM3 PNAM TCLT (+11) |
| INGR   |     181 | parsed |         15 |                                               |
| IPCT   |     663 | parsed |         10 | DODT NAM1 NAM2 ENAM                           |
| IPDS   |     339 | parsed |          2 | PNAM                                          |
| KEYM   |     381 | parsed |         11 |                                               |
| KYWD   |    1290 | parsed |          2 | CNAM                                          |
| LAND   |   54079 | parsed |          7 | VNML VHGT ATXT VTXT BTXT VCLR                 |
| LCRT   |     483 | parsed |          2 | CNAM                                          |
| LCTN   |     841 | parsed |         25 | PNAM LCSR MNAM RNAM LCEC LCPR LCID LCEP (+13) |
| LGTM   |     131 | parsed |          3 | DALC                                          |
| LIGH   |     506 | parsed |          9 |                                               |
| LSCR   |     374 | parsed |         10 | NNAM SNAM RNAM ONAM XNAM                      |
| LTEX   |     130 | parsed |          7 | HNAM                                          |
| LVLI   |    4017 | parsed |          7 | LVLD LVLF LVLO LVLG                           |
| LVLN   |     691 | parsed |          9 | LVLD LVLF LVLO COED                           |
| LVSP   |      33 | parsed |          6 | LVLD LVLF LVLO                                |
| MATO   |      74 | parsed |          5 | DATA DNAM                                     |
| MATT   |      80 | parsed |          7 | MNAM CNAM BNAM FNAM PNAM HNAM                 |
| MESG   |    1055 | parsed |          9 | INAM DNAM TNAM ITXT QNAM                      |
| MGEF   |    1812 | parsed |         10 | SNDD                                          |
| MISC   |    1063 | parsed |         13 | ICON                                          |
| MOVT   |     107 | parsed |          4 | MNAM SPED INAM                                |
| MSTT   |     838 | parsed |         12 |                                               |
| MUSC   |      74 | parsed |          5 | FNAM PNAM WNAM                                |
| MUST   |     352 | parsed |         11 | CNAM ANAM DNAM BNAM FNAM LNAM                 |
| NAVI   |       8 | parsed |          4 |                                               |
| NAVM   |   20064 | parsed |          4 | PNAM NNAM                                     |
| NPC_   |    6626 | parsed |         58 | RNAM AIDT CNAM NAM5 NAM6 NAM7 NAM8 QNAM (+30) |
| OTFT   |     639 | parsed |          2 | INAM                                          |
| PACK   |    7671 | parsed |         37 | PKDT PSDT PKCU ANAM UNAM XNAM POBA INAM (+19) |
| PERK   |     532 | parsed |         15 | DATA PRKE PRKF EPFT EPFD PRKC NNAM EPF3 (+1)  |
| PGRE   |      44 | parsed |          5 |                                               |
| PHZD   |     394 | parsed |          5 |                                               |
| PROJ   |     248 | parsed |         12 | NAM1 VNAM NAM2                                |
| QUST   |    2455 | parsed |         55 | NEXT ANAM FNAM ALID FLTR ENAM QSDT ALFE (+27) |
| RACE   |     214 | parsed |         69 | BOD2 MNAM ANAM MTNM VTCK PNAM UNAM NAM1 (+50) |
| REFR   |  866240 | parsed |         62 | XLKR XRDS XLIG XRGD INAM XPRD XPPA PDTO (+27) |
| REGN   |     389 | parsed |         12 | RCLR RPLI RDAT RDSA RDWT RDOT RDMO RDMP (+1)  |
| RELA   |     673 | parsed |          2 |                                               |
| REVB   |      11 | parsed |          2 | DATA                                          |
| RFCT   |     168 | parsed |          2 |                                               |
| SCEN   |    2142 | parsed |         29 |                                               |
| SCRL   |     109 | parsed |         16 |                                               |
| SHOU   |     117 | parsed |          5 | SNAM                                          |
| SLGM   |      20 | parsed |         11 |                                               |
| SMBN   |     128 | parsed |          8 | PNAM SNAM DNAM XNAM                           |
| SMEN   |      28 | parsed |          7 | PNAM SNAM DNAM XNAM ENAM                      |
| SMQN   |     536 | parsed |         13 | PNAM SNAM DNAM XNAM QNAM NNAM RNAM MNAM (+1)  |
| SNCT   |      18 | parsed |          6 | FNAM VNAM PNAM UNAM                           |
| SNDR   |    3296 | parsed |         10 | CNAM ANAM ONAM BNAM GNAM LNAM FNAM            |
| SOPM   |      86 | parsed |          8 | MNAM NAM1 ANAM ONAM FNAM CNAM                 |
| SOUN   |    1191 | parsed |          5 | SNDD                                          |
| SPEL   |    1561 | parsed |         11 | EFIT                                          |
| SPGD   |      18 | parsed |          3 | DATA ICON                                     |
| STAT   |   12626 | parsed |          7 | MNAM                                          |
| TACT   |      30 | parsed |          8 | PNAM                                          |
| TES4   |      10 | parsed |          8 | INTV INCC DATA                                |
| TREE   |     288 | parsed |          9 |                                               |
| TXST   |     790 | parsed |         11 | TX00 DNAM TX01 TX07 TX03 TX04 TX05 DODT (+1)  |
| VOLI   |      42 | parsed |         13 | CNAM DNAM ENAM FNAM GNAM HNAM INAM JNAM (+4)  |
| VTYP   |     183 | parsed |          2 | DNAM                                          |
| WATR   |      92 | parsed |         18 | ANAM FNAM DATA DNAM GNAM NAM0 NAM1 NAM2 (+6)  |
| WEAP   |    3359 | parsed |         29 | VNAM BAMT BIDS INAM SNAM XNAM NNAM UNAM       |
| WOOP   |     107 | parsed |          3 | TNAM                                          |
| WRLD   |      94 | parsed |         28 | ONAM NAMA DATA NAM0 NAM9 OFST WNAM PNAM (+15) |
| WTHR   |     177 | parsed |         55 | LNAM MNAM NNAM PNAM NAM0 FNAM DATA IMSP (+15) |

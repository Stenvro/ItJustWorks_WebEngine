# The original's savegames (.ess)

Import of the original Special Edition saves (M12). Sources: UESP "Skyrim Mod:Save File Format",
xEdit's `wbDefinitionsTES5Saves.pas` (layouts and their order), CommonLibSSE's `ChangeFlags`
enums (flag bits). Code: `src/formats/ess/` (parser, platform-independent), `src/save/ess-import.ts`
(the importer), `tools/ess-info.ts` (the CLI). No real save is in the repo; the tests write
synthetic ones (`ess-test-writer.ts`), and `tests/sim-ess-import.int.test.ts` reads the first save in
`Documents\My Games\Skyrim Special Edition\Saves` when there is one.

## The file

Little-endian. A string (`wstring`) is a u16 length and that many Windows-1252 bytes.

| What        | Size                                                               |
| ----------- | ------------------------------------------------------------------ |
| magic       | 13: `TESV_SAVEGAME`                                                |
| header size | u32 (what follows starts after it, whatever the reader reads)      |
| header      | version u32 (7-9 LE, 12 SE), save number u32, player name, level   |
|             | u32, location, game date, race editor id, sex u16, experience f32, |
|             | level-up experience f32, FILETIME u64, screenshot width and height |
|             | u32, compression u16 (SE only: 0 none, 1 zlib, 2 LZ4)              |
| screenshot  | width x height x 4 (SE: RGBA; LE: x 3, RGB)                        |
| SE: sizes   | uncompressed u32, compressed u32 (present even when uncompressed)  |
| body        | one LZ4 block (or zlib stream) of the uncompressed size            |

The body:

| What                | Size                                                                |
| ------------------- | ------------------------------------------------------------------- |
| form version        | u8 (78 with light plugins)                                          |
| plugin info size    | u32; then plugin count u8 and names; form version >= 78: light      |
|                     | plugin count u16 and names                                          |
| file location table | 10 u32 (offsets, the three tables' counts, change form count) + 60  |
| global data 1       | types 0-8: type u32, length u32, data                               |
| global data 2       | types 100-114                                                       |
| change forms        | see below                                                           |
| global data 3       | types 1000-1005; its count is one short (read on while the types go |
|                     | on rising)                                                          |
| form id array       | count u32, u32 each                                                 |
| visited worldspaces | count u32, u32 each                                                 |
| unknown table 3     | size u32, count u32, strings                                        |

The parser reads it in order and does not need the offsets.

**Reference ids** are 3 bytes, big-endian. The top 2 bits are the kind. 0 is an index (1-based)
into the form id array, and 0 itself is no form. 1 is a Skyrim.esm form, with the value as its
id. 2 is a created form (`0xFF000000 | value`). 3 is unknown.

**vsval** (a variable-size count): the low 2 bits of the first byte give the size (0: 1 byte, 1:
2, 2: 4), and the value is the rest, shifted right by 2.

## Global data

Read: 0 misc stats (count u32; name, category u8, value i32), 1 player location (next object id
u32, worldspace, cell x and y i32, worldspace, position; one more byte from form version 73), 2
TES, 3 global variables (vsval count; id, value f32), 4 created objects (weapon and armour
enchantments, potions, poisons), 5 effects, 6 weather (climate, weather, previous, two unknown,
region weather; the hour, the transition's start and how far it is; the rest kept as bytes), 7
audio, 8 sky cells, 1001 Papyrus, 1002 anim objects, 1003 timer, 1004 synchronised animations.

Tables 2 and 3's other types (`global-data-tables.ts`, after UESP's pages for each; built from
the documented layouts and tested by round trip, waiting on a real save, TODO(M12)): 100 process
lists (three floats, the next crime number, then the crimes of each of 7 types: witness and
serial numbers, type, stolen quantity, time, victim, criminal, item, owner, witnesses, bounty,
faction, cleared), 101 combat (the next combat number, combat groups with their members' five
positions, targets, fifteen float pairs and an optional search with an optional detail block,
then the actors' entries and a tail), 102 interface (help messages shown, the last used weapons,
spells and shouts; an extra part UESP sees "in certain situations", read when bytes are left),
103 actor causes (position, serial number, actor), 105 detection manager, 106 location
metadata, 107 quest static data (two lists of quest run data: a value's type 1, 2 and 4 are
references, 3 a number; three reference lists; per quest a list of number pairs; a flag), 108
story teller (a flag), 109 magic favourites (the favourites, then the hotkeys by position), 110
player controls, 111 story event manager (its entries' layout is undocumented: kept as bytes),
112 ingredient pairs found to share no effect, 113 menu controls, 114 menu topic manager (two
references), 1000 temp effects (the effect entries, then two lists of typed effects: types 0,
1, 3 to 11 documented; an undocumented type, such as 2, stops the read and keeps the rest), 1005
main (always empty; the table 3 count leaves it out). 104 has no documentation: kept as bytes.
`GLOBAL_DATA_READERS` maps every type to its reader; `ess-info` runs them on a save.

**Papyrus**: version u16, strings (u16 count), script types (name, parent, members: name and
type as string indices), objects (VM handle u32, script, u16 flags, i16 high word, reference id,
u8), detached objects, arrays (handle, type, the element script for object arrays, length),
the next active script id, the stacks (id, type). Then each object's data (handle, flags u8,
script, u32, a second u32 when flags & 4, the variables) and each array's elements. A variable
is a type byte and its value: null u32, object (script, handle), string (index), int, float,
bool u32, arrays (an array handle; object arrays have a script first).

The stacks' frames, function messages, suspended stacks and the registrations after them are not
read yet (TODO(M12)). Mapping them onto our resumable frames (`vm.restoreThreads`) needs each
frame's opcodes and arguments read. Until then imported scripts start with no running stacks and
no update registrations.

## Change forms

Each change form has a reference id, the change flags (u32), a type byte (low 6 bits: the type,
0 REFR to 48 ENCH; high 2 bits: the size of the two lengths, which are u8, u16 or u32), a version
u8, the stored length, the uncompressed length (0: not compressed; else zlib), then the data.

The data, as far as its layout is known (`readChangeForm` stops at the first unknown part and
says where). UESP's "Save File Format" pages give part of it; the rest is as the original writes
each flag's data, in its order. Counts written as vsval are the same 1, 2 or 4 byte form
everywhere (the original reserves one byte and widens it when the count is known).

- **Initial data** (references): for a created form, the cell or world, position, rotation, a
  flags byte and the base. For a reference whose cell changed or was promoted, the place, the new
  cell and its x and y as i16. For a moved one, the place. When havok-moved, a vsval-sized buffer
  follows. Detached cells have their worldspace index, x and y (i8 or i16) and detach time.
- **References** (REFR, ACHR and the projectiles PMIS, PGRE, PBEA, PFLA, PHZD, PBAR, PCON, PARW):
  ACHR first has its AI process level (i32, −1: none) and its state flags (u32). Then form
  flags (u32 + u16), base object, scale, the extra data list (when any of flags 0xA6021C40 is
  set; actors: 0xA6061840), the inventory (when inventory or leveled inventory is set: vsval
  count; item, delta i32, a vsval count of extra data lists) and the animation (a vsval size,
  then that many bytes).
- **Extra data**: a vsval count, then per entry its type byte (CommonLibSSE's ExtraDataType) and
  its data. The types the original writes data for: refIds (ReferenceHandle, Ownership, Global,
  ItemDropper, HeadingTarget, StartingWorldOrCell, CombatStyle, OpenCloseActivateRef,
  EncounterZone, AshPileRef, OutfitItem, SceneData, ForcedTarget, ForcedLandingMarker); a byte
  (Ghost, MapMarker, Hotkey, HasNoRumors, CanTalkToPlayer, ShouldWear, Soul); 4 bytes
  (LevCreaModifier, Rank, Health, TimeLeft, Charge, Scale, ObjectHealth, Radius, ActorCause,
  ActivateRefChildren, Flags); Count i16; UniqueID u16 + u32; PackageStartLocation (refId, xyz,
  u32); Package (two refIds, u32, three flag bytes); TresPassPackage (refId; a package the game
  made has its own data after it: open); RunOncePacks (vsval × refId + u8); Lock (level u8,
  flags u8, key, two u32); Teleport (position, rotation, u8, door); LeveledCreature (base,
  template, u32 change flags, then the base's NPC\_ change data by those flags); LeveledItem
  (i32 + u8); MagicCaster (the caster's common part: u32, refId, two u32, refId, u32; then two
  refIds); NonActorMagicTarget (refId; vsval × effects: refId, u8, vsval, a vsval-sized block);
  PlayerCrimeList (vsval × 8 bytes); Poison, ModelSwap, Ammo, FromAlias (refId + u32);
  FriendHits (vsval × f32); InfoGeneralTopic (wstring, 5 bytes, 4 refIds); TerminalState (2
  bytes); FactionChanges (vsval × faction refId + rank i8, a crime faction refId, u8);
  DismemberedLimbs (u16, two u32, u8, refId, vsval × 4 bytes + vsval × refId); PackageData (a
  type byte, 0xFF: none; else the package's running data: open); SayTopicInfoOnceADay (vsval ×
  refId + two u32); SayTopicInfo (refId, u8, u32, refId, vsval × (two wstrings, two u32, u8,
  three refIds, u8), i16, four refIds); GuardedRefData (vsval × refId, u32, u8);
  FollowerSwimBreadcrumbs (12 bytes, refId, u32, vsval × (12 bytes, refId, 12 bytes, refId,
  u8)); AliasInstanceArray (vsval × quest refId + alias id u32); PromotedRef (vsval × refId);
  AttachedArrows3D (vsval × arrows: a refId, and when it is not null a bone u16, and when that
  is not 0xFFFF 56 more bytes (TODO(M13): the transform's size); then two u16);
  TextDisplayData (two refIds, i32; when both are null and it is −2, the name as a wstring);
  Enchantment (refId + u16); RefrPath (88 bytes); GroupConstraint (u32, refId, two wstrings, 32
  bytes); ScriptedAnimDependence (u32 count × refId + u32); CachedScale (8 bytes). Interaction
  is open. Every other type is its type byte alone.
- **Actors** (ACHR, after the reference data): when there is no AI process: a byte, 13 u32
  (timers and counters), a refId, 18 bytes of state bits, a refId, a byte of which of the four
  magic casters follow (each: the common part, u32, refId, u32, a vsval-sized animation block),
  and the five spells in hand (refIds). With a process, its data comes first: its layout is not
  decoded (TODO(M13)), and the reader finds what follows by its shape. Then the modifier sets
  of health, magicka, stamina and voice points (each u32 3, then permanent, temporary and
  damage f32; damage is negative), the actor value storage (vsval × (actor value i32, base
  f32); vsval × (actor value i32, the three modifiers)), the added spells (u32 count ×
  refId), the movement data (a byte: 0 none; else open), u32, the combat data (a byte: 0 none;
  else open), u32 count × (refId, u32), two u32, a refId and a byte. The player's own data
  follows (TODO(M13)).
- **QUST**: form flags, quest flags u16 (CommonLibSSE: enabled 0x1, completed 0x2, failed 0x40,
  active 0x800), script delay f32, stages (vsval; stage u16, done bit 0), objectives (vsval;
  index u32, state u32: 1 displayed, 2 completed, 3 completed and displayed, 4 failed, 5 failed
  and displayed; dormant ones are not written), runtime data (a byte, the aliases: u32 count ×
  (alias id u32, a created flag u8, the reference; when created four more refIds), the
  location map: u32 count × (u32, refId), the story event: a byte, then its type, u32 count of
  parameters, each a type u32 and a refId, or for type 3 a u32), instance data (u32, vsval ×
  (id u32, vsval × (alias u32 + refId), vsval × (refId + u32), u16, u8)), already run u8. The
  current stage is not written.
- **NPC\_**: form flags, ACBS (24), factions (vsval × refId + rank i8), spell list (spells,
  leveled spells, shouts), AIDT (20), full name, DNAM (52: 18 skills, 18 skill offsets, health,
  magicka and stamina u16, 2 bytes, a f32, a byte and 3 bytes), class, race (current,
  original), face, gender, outfits. The attributes flag carries no data.
- **CELL**: form flags, flags u16, seen data, full name, owner.
- **FACT**: form flags, reactions (vsval × refId, modifier i32, group combat reaction u32),
  flags u32, crime (two u32 counts, a time f32, u32).
- **LVLN, LVLI, LVSP**: form flags, then for added objects a u8 count × (refId, level u16,
  count u16).
- **CONT** and the other base objects: form flags. Their own flags (BOOK teaches, INGR use,
  FLST added form, ECZN, LCTN, SMQN, RELA, SCEN, PACK, INFO said once, NOTE read, ...) are not
  read yet (TODO(M13)): what they hold is counted as undecoded.

## Import

`importEss(ess, world, request)` makes our `GameSave` (docs/formats/save.md). The Load page puts
it in the save store, and it loads through the same path as our own saves: the plugins are read
as for a new game, then the state is applied. Form ids move from the save's load order to ours by
plugin name, and forms of plugins not loaded are left out. What it applies:

- actors: their actor values (base values that changed, modifiers, damage) and the factions
  a script put them in or took them out of;
- the player: where they stand (their ACHR's moved place, else the player location table),
  level, name, race, the 18 skills and DNAM's health, magicka and stamina (TODO(M13): checked
  against a real save), factions, the base's spells and shouts; their inventory changes;
- globals (GameDaysPassed sets the clock) and misc stats;
- quests: running, completed, failed and active flags, the stages done (the current stage is
  the highest done: TODO(M13)), objectives (shown, completed, failed), alias references;
- the entries scripts added to leveled lists;
- references: moved (cell or world by the record's type), enabled or disabled, deleted, scale,
  owner, inventory changes (`GameSave.inventoryDeltas`, added to the records' inventories after
  the load), the open-state flag (TODO(M13): its data), references the game created;
- books read and locations cleared;
- the weather;
- Papyrus: each script instance's variables, by script level (a type's members follow its
  parents'), with object variables as handles to the instances' forms. The instance's state name
  and an alias script's alias id are TODO(M13).

Everything else is counted by change form type and flag (`REFR: lockExtra x 12`) and by where a
read stopped, then logged under `save` as not imported.

## In Play

The journal's System page, Load: the list ends with "Import .ess (a save of the original game)".
It opens a file picker (`showOpenFilePicker`, starting in Documents), imports the save as a new
save of ours named `Imported <player> <save number>`, and loads it.

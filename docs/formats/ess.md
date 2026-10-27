# The original's savegames (.ess)

Import of the original Special Edition saves (M12). Sources: UESP "Skyrim Mod:Save File Format",
xEdit's `wbDefinitionsTES5Saves.pas` (layouts and their order), CommonLibSSE's `ChangeFlags`
enums (flag bits). Code: `src/formats/ess/` (parser, platform-independent), `src/save/ess-import.ts`
(the importer), `tools/ess-info.ts` (the CLI). No real save is in the repo; the tests write
synthetic ones (`ess-test-writer.ts`), and `tests/ess-import.int.test.ts` reads the first save in
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
Table 2 and 1000 (temp effects) and 1005 (main) are kept as bytes.

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
says where):

- **Initial data** (references): for a created form, the cell or world, position, rotation, a
  flags byte and the base. For a reference whose cell changed or was promoted, the place, the new
  cell and its x and y as i16. For a moved one, the place. When havok-moved, a vsval-sized buffer
  follows. Detached cells have their worldspace index, x and y (i8 or i16) and detach time.
- **References**: ACHR has two u32 first, then form flags (u32 + u16), base object, scale, the
  extra data list (when any of flags 0xA6021C40 is set; actors: 0xA6061840), the inventory (when
  inventory or leveled inventory is set: vsval count; item, delta i32, extra data lists) and the
  animation buffer. The extra data types with known layouts: 0x0C, worn, worn left, package
  start location, package, trespass package, run-once packages, reference handle, follower,
  leveled creature modifier, ghost, ownership, global, rank, count, health and 0x27. Any other
  type stops the read. An actor's data after this (actor values, modifiers, life state) has no
  known layout yet (TODO(M13)).
- **QUST**: form flags, quest flags u16 (CommonLibSSE: enabled 0x1, completed 0x2, failed 0x40,
  active 0x800), script delay u32, stages (vsval; stage u16, done bit 0), objectives (vsval;
  index u32, status u32: displayed 1, completed 2), runtime data (aliases and their references,
  locations, the story event), instance data, already run u8.
- **NPC\_**: form flags, ACBS (24), factions, spell list (spells, leveled spells, shouts), AIDT
  (20), full name, DNAM skills (52), class, race (current, original), face, gender, outfits.
- **CELL**: form flags, flags u16, seen data, full name, owner. **FACT**: faction flags u32.
  Other base objects: form flags. Their other flags carry no data.

## Import

`importEss(ess, world, request)` makes our `GameSave` (docs/formats/save.md). The Load page puts
it in the save store, and it loads through the same path as our own saves: the plugins are read
as for a new game, then the state is applied. Form ids move from the save's load order to ours by
plugin name, and forms of plugins not loaded are left out. What it applies:

- the player: where they stand (their ACHR's moved place, else the player location table),
  level, name, race, the 18 skills and DNAM's health, magicka and stamina (TODO(M13): checked
  against a real save), factions, the base's spells and shouts; their inventory changes;
- globals (GameDaysPassed sets the clock) and misc stats;
- quests: running, completed, failed and active flags, the stages done (the current stage is
  the highest done: TODO(M13)), objectives, alias references;
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

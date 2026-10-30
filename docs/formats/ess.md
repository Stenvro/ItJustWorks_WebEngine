# The original's savegames (.ess)

Import of the original Special Edition saves (M12). Sources: UESP "Skyrim Mod:Save File Format",
xEdit's `wbDefinitionsTES5Saves.pas` (layouts and their order), CommonLibSSE's `ChangeFlags`
enums (flag bits). Code: `src/formats/ess/` (parser, platform-independent), `src/save/ess-import.ts`
(the importer), `tools/ess-info.ts` (the CLI). No real save is in the repo; the tests write
synthetic ones (`ess-test-writer.ts`), and `tests/sim-ess-import.int.test.ts` reads the first save in
`Documents\My Games\Skyrim Special Edition\Saves` when there is one, and a known one (a file
named `Save1_*.ess` there, or `SKYRIM_ESS`: a New Game save on the cart into Helgen) which it
checks section by section and imports: the player's place, the items gained, every MQ101 stage
done and the actor values must come out as the save holds them.

Two real saves (2026-10-30, the same load order with Survival Mode, Curios, Fishing and AdvDSGS)
read with `ess-info`: every global data entry with its reader, the Papyrus data to its last byte
(40k script instances, 430 arrays, the running stacks with their frames, the registrations),
every global data entry to its last byte but the temp effects' (one byte left, TODO(M13)) and
the second save's combat table (112 bytes left, TODO(M13)), and every change form to its end
but: the player's own data after its skills' experience (both saves), and in the second save
(a fight at Helgen) 6 actors' combat controllers and 6 actors' combat pathing requests, which
hold the combat AI's objects (their layouts are open, TODO(M13)). Every other actor (2,361 and
2,352 of 2,362 and 2,365) reads to its end, its movement controller included.

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
`GLOBAL_DATA_READERS` maps every type to its reader; `readGlobalData` runs one and says how
many bytes it left, and `ess-info` prints every entry not read to its end. Type 1 has one more
byte from form version 73 (read when there). Measured on the two saves: every reader ends
exactly but temp effects (one byte after the second list, both saves: its meaning is open) and
combat in the second save (112 bytes left where combats were running: the combat groups'
layout after UESP needs checking against the original's, TODO(M13)); 104 is in neither save.

**Papyrus** (read to its last byte on real saves: `ess-info`): version u16 (6 in Special
Edition saves), strings, script types (name, parent, members: name and type as string indices),
objects (VM handle, script, u16 flags, i16 high word, reference id, u8), detached objects,
arrays (handle, type, the element script for object arrays, length), the next active script
id, the stacks (id u32, type). Then each object's data (handle, flags u8, **its state name**,
u32, a second u32 when flags & 4, the variables) and each array's elements. A variable is a
type byte and its value: null u32, object (script, handle), string (index), int, float, bool
u32, arrays (an array handle; object arrays have a script first).

Special Edition saves (header version 12) widen two things the original release keeps narrow:
the string table's count and every string index are **u32** (u16 before), and the VM's object
and array handles are **u64** (u32 before; the stack ids stay u32). The original release's
layout is still read when the header says so.

Then, in order:

- Each running stack: id u32, two version bytes, its return value (a variable), flags u8, a
  byte, a u32 when flags bit 0 is set, a kind byte (1: a callback, 2: a value, 3: both; the
  callback is a u32-length name, QuestStage: reference id, u16, u8; ScenePhaseResults and
  SceneActionResults: reference id, u32; SceneResults: reference id; TopicInfo: nothing), the
  frames (u32 count, outermost call first), and a last byte when flags bit 1 is set and bit 0
  is not. A frame: its variable count u32, flags u8, function type u8, the script, the script
  the function was found on and the function's name (string indices), the state name (only for
  a function, not a property's getter or setter, and flags bit 0 clear), the opcode version
  (two bytes), the function itself as a compiled script writes it (return type, doc string,
  user flags u32, flags u8, u16 counts of parameters, locals and instructions; instruction
  arguments are a type byte and a value, with string indices), the instruction to run next
  u32, Self (a variable) and the parameters' and locals' values.
- The function messages (u32 count: a byte, u32, and when a byte says so a queued call: a byte,
  the script, the function, Self and the arguments) and the two suspended stack tables (u32
  count: u32, and the same optional queued call).
- A u32 (and a second when it is not 0), a u32 list, the queued unbinds (u32 count: handle,
  u32), and the registrations' version i16 (5).
- The game's registrations (CommonLibSSE's SkyrimVM members, read in that order): the
  Utility.Wait, WaitMenuMode and WaitGameTime calls (three u32 lists of stack id and i32 time);
  OnUpdate and OnUpdateGameTime registrations (u32 count: single-update byte, the time to send
  u32, the interval i32, then the game handle: u16, i16 high word, reference id: the object
  table's seven bytes without its last); Debug.OpenUserLog's logs (u32-length names); the four
  queues of latent functions' work (MoveTo, Enable, AddItem, ...: a type byte and the fields
  xEdit lists for it); the LOS events (viewer, target, two bytes); the sleep events and, from
  version 4, the tracked stats events (u32 lists of game handles); from version 5 the inventory
  event filters (handle, two u32 counts, then the items' and the lists' reference ids); a list
  of (reference id, byte); the animation event registrations (u32 count: reference id, then u32
  count of events: a u32-length name, a list of u32 pairs, the handles waiting on it); a list of
  u32 pairs; three lists by reference id; a list of (u32, u32 list).

Not seen in the two saves read, so their sizes are taken from xEdit's layouts and wait on a save
that holds them (TODO(M13)): queued unbinds, the latent functions' queues, LOS events, and the
last five lists.

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
  is not 0xFFFF the time it has been stuck u32, its translation (12 bytes), its rotation (the
  original writes the matrix as a quaternion: 16 bytes) and its scale f32; then two u16);
  TextDisplayData (two refIds, i32; when both are null and it is −2, the name as a wstring);
  Enchantment (refId + u16); RefrPath (88 bytes); GroupConstraint (u32, refId, two wstrings, 32
  bytes); ScriptedAnimDependence (u32 count × refId + u32); CachedScale (8 bytes); Interaction
  (its kind u32, the two references, a byte: both kinds the original has, a mount's and a
  reference's, add nothing of their own). Every other type is its type byte alone.
- **Projectiles** (PMIS, PGRE, PBEA, PFLA, PBAR, PCON, PARW, after the reference data, as
  observed in the original): 9 u32, the source and ammo, the shooter and target (refIds), the
  velocity (12 bytes), two u32, the rotation as a quaternion (16 bytes), 12 bytes, three u32, a
  form id u32 as is (−1: none), a byte and when it is set the item it carries (an inventory
  entry: refId, i32, vsval × extra data lists), the impacts (vsval × (position, normal, the
  reference hit, u32, u8, two u16, a material refId, two u32, u8)), 12 bytes, a refId, u32, a
  refId, u32. Then each kind's own: a missile and a barrier one u32; an arrow the missile's and
  two refIds; a flame two u32; a cone four u32 and 12 bytes; a beam a byte; a grenade a vsval
  count of its Havok constraints (TODO(M13): their layout; none in the saves read). **PHZD**
  (hazards): six u32 and two refIds.
- **Actors** (ACHR): the AI process level i32 (−1: none) and the state flags u32 come first,
  then the reference data. With a process, its data follows: its layout is not decoded
  (TODO(M13)), and the reader finds what comes after it by its shape (the four modifier sets
  below, each starting with 3). Then, for every actor: a byte, 13 u32 (timers and counters), a
  refId, the actor state (18 bytes), a refId, a byte of which of the four magic casters follow
  (each: the common part, u32, refId, u32, a vsval-sized animation block), the four spells and
  the power in hand (refIds), the modifier sets of health, magicka, stamina and voice points
  (each u32 3, then permanent, temporary and damage f32; damage is negative), the actor value
  storage (vsval × (actor value, base f32); vsval × (actor value, the three modifiers); the
  actor value is a signed byte widened to i32, so indices from 128 up read negative), the
  added spells (u32 count × refId). Then the movement controller's data (a byte: 0 none; else
  see "Movement" below), u32, the combat controller's data (a byte; else the combat AI's
  state, open: TODO(M13)), a u32 count (0: none; else that many refId and u32), two u32, a
  refId and a byte. The player's own data follows (see "The player").
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
- **CELL**: form flags, flags u16, seen data, full name, owner. The seen data is an exterior
  cell's one 32-byte map or an interior cell's vsval × (two bytes, 32 bytes); the save does not
  say which the cell is unless its detach data does, so the layout that ends the data is taken.
- **FACT**: form flags, reactions (vsval × refId, modifier i32, group combat reaction u32),
  flags u32, crime (two u32 counts, a time f32, u32).
- **LVLN, LVLI, LVSP**: form flags, then for added objects a u8 count × (refId, level u16,
  count u16).
- **Base objects** (as observed in the original; `EssChangeForm.base`): ACTI, FURN, TACT: the
  full name (flag 2), TACT also its voice type (flag 23). ARMO, BOOK, LIGH, MISC, APPA, WEAP,
  AMMO, KEYM: the value u32 (flag 1); BOOK then its flags byte (flag 5 or 6). INGR: which
  effects are known, 4 bytes (flag 31). ECZN: a byte (flag 1) and four u32 (flag 31). RELA: a
  relationship the game made writes its two NPCs and association, then the rank u32 (flag 1).
  FLST: u32 count × refId (flag 31). LCTN: two bytes (flag 31), vsval × (keyword refId, f32)
  (flag 30). SMQN: u32 count × u32. SCEN, whatever its flags: playing u8, u32, two bytes, the
  actions (u32 count: type u32, u32, a timer's two bytes, two flag bytes), two bytes, its time
  u32, the phases (u32 count × three bytes), four bytes. PACK: a package the game made writes
  its whole definition (open, TODO(M13); none in the saves read). INFO, CONT, DOOR, STAT, ALCH,
  IDLM, NOTE, NAVM, WOOP, MGEF, ENCH, CLAS: the form flags only.

## Movement

As observed in the original (`src/formats/ess/movement.ts`). The movement controller writes
through a pathing stream: values as usual, references as refIds, and **shared objects** by an
8-byte id (the object's address); the first time an object is written in an actor's save its
type and data follow the id, later only the id (0: none). The AI process's data writes some
before (the reader then takes an id followed by no known type as written there: TODO(M13),
from the AI process's decoded data). A type is the CRC-32 (reflected, start 0, no final
inversion) of the class name (`PathingRequest` 0x330EB0E3); the combat AI's generic requests
mix in their goal and search policies' ids by exclusive or.

The controller: the waiting messages (u32 count, each a type and its data), the points of a
static path (u32 count: a point, three floats, u32), u32, 7 switch bytes, the **arbiters** (u32
count: a type byte; 0 handler, 1 path manager (u32, request, path), 2 planner (a byte), 3 post
update (14 floats), 4 tweener (keys, a target, three transforms, four floats)), the **agents**
(u32 count: a type byte, 0x00 to 0x13 and 0x80 to 0x8A, each with its own fields: the path
followers' request and path, the avoiders' lists, the tweeners' targets, ...), then a byte:
whether the actor is loaded, and then its animation graphs' state (a byte; a byte for one
graph or a list; the graph's: a byte, a u32 count and 12 bytes each, or 4 zero bytes when it
was not found) and a byte for one more object (none in the saves).

A point: three floats, a cell (a type, then for `PathingCell` a worldspace refId and its grid
as i32, or an interior's refId), a refId, u16 and two bytes. A path (`BSPathingSolution`):
points with what to do there (a door message), two i32, two lists of smoothed points, two
bytes. A pathing request: its start and goal points, the spaces to avoid, limits, what it
holds locked (`PathingLockData`), its movement parameters (five floats), the forms it may use,
then what its kind adds (16 kinds, `PathingRequestFlyLand` and the others). A combat request
adds its actor, two words, its path and its combat objects (a u32 id with bit 0 set when the
type and data follow: their layouts are open, TODO(M13)).

## The player

After the actor's data (`src/formats/ess/player.ts`, as observed in the original): switches and
timers, a list of (u32, u64 milliseconds), game times relative to the save's, then the
**skills' experience** (CommonLibSSE's PlayerSkills: the level's experience and threshold, a
count of 18, each skill's level, experience, threshold and legendary count), a vector, a game
time and a list of (12 bytes, a game time). What follows (eight refIds, then lists in the
original's order) does not read to its end yet (TODO(M13)).

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
  parents'), with object variables as handles to the instances' forms, and the state each
  instance is in. An alias script's alias id is TODO(M13).
- the OnUpdate and OnUpdateGameTime registrations, each going on with the time it had left
  (the original saves the time to send on the VM's clock, which the timer table keeps at 0 in
  the saves read: so the time is what is left, TODO(M13) on a save where it is not; real time
  in milliseconds, game time in thousandths of an hour), single or repeating, on the form or
  the alias of the handle's high word;
- the forms scripts added to form lists (FLST).

Read but not imported yet (TODO(M13)): the running stacks (our resumable frames keep their own
code positions, not the compiled script's), the function messages, suspended stacks and waits,
the other registrations (sleep and tracked stats events, inventory filters, animation events);
the projectiles and hazards in flight; the base objects' other changes (values, names, known
ingredient effects, location keyword data, scenes' running state); the movement controller's
state (the engine plans its paths anew) and the player's skills' experience.

Everything else is counted by change form type and flag (`REFR: lockExtra x 12`) and by where a
read stopped, then logged under `save` as not imported.

## In Play

The journal's System page, Load: the list ends with "Import .ess (a save of the original game)".
It opens a file picker (`showOpenFilePicker`, starting in Documents), imports the save as a new
save of ours named `Imported <player> <save number>`, and loads it.

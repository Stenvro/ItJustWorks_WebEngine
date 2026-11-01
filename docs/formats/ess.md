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
read with `ess-info`: every global data entry with its reader and to its last byte, the
Papyrus data to its last byte (40k script instances, 430 arrays, the running stacks with their
frames, the registrations), and every change form to its end: all 4,727 actors with their AI
processes (see "AI process"), movement controllers, the 12 combat controllers and 6 combat
pathing requests of the second save (a fight at Helgen) with the combat AI's objects, and the
player's own data. Nothing is found by its shape any more.

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
enchantments, potions, poisons), 5 effects, 6 weather (as observed in the original, CommonLibSSE's
Sky members: climate, weather, previous, default and forced weather, region; the hour, the last
weather change and how far the transition is; the sky's flags, the last moon phase update, three
u32, a u32 and the fog power, the sky mode; a byte of which of the current and last weather's sky
effects follow, each a model reference effect as the temp effects' type 9), 7 audio, 8 sky
cells, 1001 Papyrus, 1002 anim objects, 1003 timer, 1004 synchronised animations.

Tables 2 and 3's other types (`global-data-tables.ts`, after UESP's pages for each; built from
the documented layouts and tested by round trip, waiting on a real save, TODO(M12)): 100 process
lists (three floats, the next crime number, then the crimes of each of 7 types: witness and
serial numbers, type, stolen quantity, time, victim, criminal, item, owner, witnesses, bounty,
faction, cleared), 101 combat (the next combat number, combat groups with their members' five
positions, targets, fifteen float pairs and an optional search with an optional detail block;
then, as observed in the original, the threats: a vsval count of a form and its combat object
(`CombatThreat`, see "Combat"), their time stamp, a count always 0, a list of references, a
time stamp and two timers; the search's detail, as observed in the original, is its
line-of-sight grid map written through a pathing stream of its own: a u32 count of grids (a u32
key, then the grid: a u32 count of cells, each a byte, a u32 count of bytes and the bytes, a
navmesh refId and a u32; then the grid's navmesh refId), a u32, a path point (see
"Movement") and two u32; UESP's layout is the case of one grid), 102 interface (help messages shown, the last used weapons,
spells and shouts; an extra part UESP sees "in certain situations", read when bytes are left),
103 actor causes (position, serial number, actor), 105 detection manager, 106 location
metadata, 107 quest static data (two lists of quest run data: a value's type 1, 2 and 4 are
references, 3 a number; three reference lists; per quest a list of number pairs; a flag), 108
story teller (a flag), 109 magic favourites (the favourites, then the hotkeys by position), 110
player controls, 111 story event manager (as observed in the original: the next event's number
u32, then a vsval count of the events told and not yet processed, each as a quest's runtime
data writes its event: its number u32, its type as SMEN's ENAM (four characters in a u32, first
in the low byte), a u32 count of data members, each a kind u32 and its value: 0 a reference, 2 a
location, 4 a keyword, 1 another form (refIds), 3 a number u32, a kind it does not know
nothing; the members are numbered by kind
in their order, as Keyword.SendStoryEvent's K1, L1, R1, R2, V1, V2 show), 112 ingredient pairs found to share no effect, 113 menu controls, 114 menu topic manager (two
references), 1000 temp effects (the effect entries, a u32, then three lists of typed effects,
as observed in the original (UESP knows two: the byte left after them was the third's empty
count): types 0, 1, 3 to 11 documented; an undocumented type, such as 2, stops the read and
keeps the rest), 1005
main (always empty; the table 3 count leaves it out). 104: observed in the original, its save
writes no entry of this type and its load reads nothing from one, so there is no layout (an
entry another program wrote is kept as bytes, as the original ignores it).
`GLOBAL_DATA_READERS` maps every type to its reader; `readGlobalData` runs one and says how
many bytes it left, and `ess-info` prints every entry not read to its end. Type 1 has one more
byte from form version 73 (read when there). Measured on the two saves: every reader ends
exactly, combat with nine combats running included; 104 is in neither save.

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
  u32); Package (two refIds, u32, three flag bytes); TresPassPackage (refId; a trespass package the
  game made writes its definition after it, see "AI process"); RunOncePacks (vsval × refId + u8); Lock (level u8,
  flags u8, key, two u32); Teleport (position, rotation, u8, door); LeveledCreature (base,
  template, u32 change flags, then the base's NPC\_ change data by those flags); LeveledItem
  (i32 + u8); MagicCaster (the caster's common part: u32, refId, two u32, refId, u32; then two
  refIds); NonActorMagicTarget (refId; vsval × effects: refId, u8, vsval, a vsval-sized block);
  PlayerCrimeList (vsval × 8 bytes); Poison, ModelSwap, Ammo, FromAlias (refId + u32);
  FriendHits (vsval × f32); InfoGeneralTopic (wstring, 5 bytes, 4 refIds); TerminalState (2
  bytes); FactionChanges (vsval × faction refId + rank i8, a crime faction refId, u8);
  DismemberedLimbs (u16, two u32, u8, refId, vsval × 4 bytes + vsval × refId); PackageData (a
  kind byte, 0xFF: none; else the running data of the package the Package extra names, see "AI
  process"); SayTopicInfoOnceADay (vsval ×
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
  two refIds; a flame two u32; a cone four u32 and 12 bytes; a beam a byte; a grenade (a mine) a vsval
  count of the decals stuck to it, each a simple decal: a byte (1: on a cell's land, the cell
  refId and which of its four quads u32; 0: the reference it is on), two texture set refIds,
  its origin and direction (12 bytes each), width, height and depth, its emitter's rotation (a
  3×3 matrix, 36 bytes), four bytes (subtexture, blending, alpha blending, parallax), the
  parallax scale u32 and passes u8, shininess, a u32, its colour (12 bytes), two bytes and from
  form version 36 a u32 (as observed in the original; what UESP took for Havok constraints). **PHZD**
  (hazards): six u32 and two refIds.
- **Actors** (ACHR): the AI process level i32 (−1: none) and the state flags u32 come first,
  then the reference data. With a process, its data follows (see "AI process"). Then, for every
  actor: a byte, 13 u32 (timers and counters), a
  refId, the actor state (18 bytes), a refId, a byte of which of the four magic casters follow
  (each: the common part, u32, refId, u32, a vsval-sized animation block), the four spells and
  the power in hand (refIds), the modifier sets of health, magicka, stamina and voice points
  (each u32 3, then permanent, temporary and damage f32; damage is negative), the actor value
  storage (vsval × (actor value, base f32); vsval × (actor value, the three modifiers); the
  actor value is a signed byte widened to i32, so indices from 128 up read negative), the
  added spells (u32 count × refId). Then the movement controller's data (a byte: 0 none; else
  see "Movement" below), u32, the combat controller's data (a byte: 0 none; else see
  "Combat"), a u32 count (0: none; else that many refId and u32), two u32, a refId and a
  byte. The player's own data follows (see "The player"). The AI process, the movement
  controller and the combat controller write through one stream per actor: an object they
  share is written once.
- **QUST**: form flags, quest flags u16 (CommonLibSSE: enabled 0x1, completed 0x2, failed 0x40,
  active 0x800), script delay f32, stages (vsval; stage u16, done bit 0), objectives (vsval;
  index u32, state u32: 1 displayed, 2 completed, 3 completed and displayed, 4 failed, 5 failed
  and displayed; dormant ones are not written), runtime data (a byte, the aliases: u32 count ×
  (alias id u32, a created flag u8, the reference; when created four more refIds), the
  location map: u32 count × (u32, refId), the story event that started it: a byte, then the event as the story event manager writes
  its events (global data 111)), instance data (u32, vsval ×
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
  no form flags (its save replaces the form's) and its whole definition as the AI process
  writes one ("AI process"), its kind (what its procedure adds) from its PKDT's type; a
  package of a plugin writes nothing. INFO, CONT, DOOR, STAT, ALCH,
  IDLM, NOTE, NAVM, WOOP, MGEF, ENCH, CLAS: the form flags only.

## AI process

As observed in the original (`src/formats/ess/process.ts`), through the actor's pathing stream.
Every process: two u32, a byte and when set its cached values (12 u32 and two u32-counted lists
of an actor value, a u32 and a byte); the **current package** (below); a byte, u32, a reference,
three u32, a byte, u16, a timer, a reference, a vsval count of references, a u32 count of
reference pairs, two references, a byte and a reference. Then by the process level (0 high to 3
low): from middle-low (2) a u32; from middle-high (1) its part: about sixty switches, values and
positions, five references, a u32, a vsval count of references, a second package slot (as the
current one), the objects it knows (a vsval count: a reference, a byte, a vsval and the object's
data prefixed by its size), a reference, the items equipped by hand (a vsval count: a reference,
u32, u8, u32, two references, five bytes), switches and timers; for the high process (0) inside
it, before the middle-high part's last byte: switches, values, positions and timers, eight
references, six held objects with a byte each, the dialogue it is in (a byte; lines with two
names, two u32, a byte, three references and a byte; a u16 and four references), points through
the pathing stream (eight values, two u32 and a reference each), a byte and when set a u32, a
point, a time stamp and a reference, the character controller's state prefixed by its size, two
bytes, a vsval count of (two u32, two references), a vsval count of reference effects (a
reference, two handles, a u32, a time stamp, a byte and when set a u32, three bytes, three points
and three time stamps), values, references and time stamps, a name, and a byte: whether it is
loaded (then its animation callbacks: two bytes, a byte and when set a name and a u32, a byte and
when set a name; the fourth and fifth of its five animation graphs' states through the animation
stream, as the movement controller writes one; two u16, a u32 and a byte); five bytes, values, two
references, a timer, values and a reference, two bytes, a u32, a time stamp and two bytes.

A **running package**: the package (0: none, and nothing follows); for a package the game made
(0xFF000000 and up) its procedure type (−1: none) and its definition: PKDT (12 bytes), a byte of
which follow (1 a package location, 2 a package target, 4 its own data), those,
a u32, then by procedure type: an alarm (21) a vsval count of (a byte, a u16) and a byte; a
dialogue (15, 28) three references and two bytes; a flee (22) two bytes, a point, a u32, three
bytes, two references and a vsval count of references; a trespass (23) five u32 and a reference;
a spectator (24) four u32, a byte, a point and a vsval count of (three u32, two points, two
bytes, two references); the others nothing. Then its running data's kind byte (0xFF: none) and
that data; three values (a u32, a game time f32, a u32), a u16, two bytes and its target.

The running data by kind: escort (2) a reference; sandbox (12) eight u32, four bytes, a u32, a
byte, a frame count, four u32, seven bytes, three references and a vsval count of (a point, a
reference); patrol (13) three u32, two bytes, a u32 and a vsval count of its points
(references); guard (14) three u32, a reference, three u32, a byte and a byte that says a
package target follows; use weapon (16) nothing; **custom** (18) the parameters it changed (a
vsval count: the parameter's index u8, its type's name and its value: Bool a byte, Int and Float
four bytes, SingleRef a package target, ObjectList a vsval count of items (two references, four
u32), Location a package location, LocWrapper a place (below), TargetSelector, Topic and Ref
nothing; a package of a plugin writes those that differ from the package's, one the game made all
of them), then its procedure tree's running state: the name of its root's kind ('' when none) and
that state.

A package target (PTDA): a kind byte, a u32, then by kind a reference (0, 1, 3) or a u32 (2, 4,
5). A package location (PLDT): a kind byte, the radius u32, then a reference (0 to 4), a u32 (5,
8, 9, 10), a byte (11) or nothing. A place a procedure goes to (a byte: whether there is one):
its kind's name, then LocRef (a reference, three u32, a byte), LocPt (a point, two references, two
u32, two bytes) or LocCell (an interior cell, a point).

The **procedure states**, by name (each a procedure of the package's tree): Sequence and Stacked
(the child's name and state, a u32: the child's index among the branch's), Simultaneous (a vsval
count of (index u32, child)), Random (child, its index u32, a vsval count of u32), Acquire (u32, reference, u32, reference, a byte and when set an
Activate state), Activate (the parameter it uses (0xFF: none), a reference, a place, two u32, two
bytes, a pathing request), DialogueActivate (two places, a reference, a dialogue target (a u32
kind, then a reference for 0, else a u32), a byte and when set a Dialogue state, a byte, a
request), Dialogue (u32, two references, a dialogue target, a byte), Done (nothing), Eat (a
reference, u32, two bytes), Escort (a place, a vsval count of references, two bytes, a request,
u32, a byte, two u32), Find (a place, u32), Flee (a place, a byte and when set a Travel state, a
point, six u32, a vsval count of references, two references, four bytes, a request), FlightGrab (a
reference, a request, two bytes), Follow (a reference, three places, three u32, a request, five
bytes), Guard and HoldPosition (a place), Hover (a place, a byte), KeepAnEyeOn (two places),
LockUnlock (a place, two bytes), Orbit (a byte, a place, a byte), Patrol (u32, a patrol's running
data as above, a byte and when set a UseIdleMarker state, a byte and when set a SitSleep state, a
request, three bytes), Sandbox (four u32, a byte, a time stamp, u32, a time stamp, four bytes,
u32, a byte, five u32, seven bytes, three references, a vsval count of (a point, a reference), a
place, a child (name and state), u32, a request, u32, a byte), Say (a byte), Shout (a place, a
byte and when set a Travel state, a reference, u32, a reference, three u32, a reference),
SitSleep (the parameter it uses, a byte, a byte and when set an Activate state), Travel (three
bytes, a place, the parameter it uses, a request), UseIdleMarker (a byte, two references, u32, a
request, a byte), UseMagic (two places, a byte and when set a Travel state, a reference, two u32,
two references, a u16, four u32), UseWeapon (two places, a byte and when set a Travel state, a
reference, u32, a reference, three u16, u32), Wait (u32), Wander (a place, u32, a byte, u32, a
request). A request is a shared object of the pathing stream (see "Movement").

Measured on the two saves: every actor's process reads to its end, 2,362 and 2,365 actors with
the AI process, movement and combat data after it. The custom packages' trees in them: Sequence,
Stacked, Simultaneous and SitSleep at the root, Travel, Sandbox, Activate and the others below.
A made package's own data (bit 4; none in the saves) is its data class's, which its PKDT's type
gives it when it is made (as observed in the original): follow (1) and escort (2) a u32 and a
byte that says a package location follows; eat (3), use an item (8) and ambush (9) that byte
and location; patrol (13) two bytes; dialogue (15, 28) a u32, three bytes, a u32, a byte, a u32,
a reference and that byte and location; use a weapon (16) six bytes, three u16, two u32, a
reference, a byte that says a package target follows and the location's byte; custom and
template packages (18, 19) nothing; the other types have no data.

## Movement

As observed in the original (`src/formats/ess/movement.ts`). The movement controller writes
through a pathing stream: values as usual, references as refIds, and **shared objects** by an
8-byte id (the object's address); the first time an object is written in an actor's save its
type and data follow the id, later only the id (0: none). The AI process's procedure states
write some before (their pathing requests), through the same stream. A type is the CRC-32 (reflected, start 0, no final
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
adds its actor, two words, its path and its combat objects (see "Combat").

## Combat

As observed in the original (`src/formats/ess/combat.ts`). The combat AI writes its objects
once per actor (and once in the combat table): a u32 id (0: none) with bit 0 set the first
time, then the object's type u32 and its data; later only the id. A type is the CRC-32 of the
class name as for the pathing objects; a template's is its own name's with its arguments'
mixed in by exclusive or (`CombatInventoryItemMagicT` with the item kind and the caster,
`CombatPathT` with the request and the destination; the generic combat path request's own id
is the hover request's name's with its goal and search policies' mixed in). In the data, a
**timer** is a game time and a duration (8 bytes), a **time stamp** a game time (4), a
**location** a point and its cell's refId, a **navmesh triangle** the navmesh's refId, a u16
and a u32.

The classes (data after the type): the aim controllers (a point, the target, three u32, a
timer; track target: a u32 and a byte more; melee: those and a u32; projectile: the
projectile's form, five more points, three u32, time stamps, a node name); the areas (a form,
u32, two bytes, a timer; radius and standard: a location and a u32; reference and hold
position: a reference and a timer more); the inventory items (the item and its count, a form
and a u32; melee, shield, one-handed block and torch: a u32; ranged: the ammo and two u32; the
magic items: six u32); the magic casters (their item, and offensive two timers, ward a timer,
restore a time stamp and two u32, reanimate a second object and a reference); the cover
search, its results and locations; the target location search, its results and locations; the
flanking search data; the target selectors (a reference, two u32; standard: a timer more); the
threats; the speed and disable controllers (a reference); the combat paths (a reference, three
u32, two timers, an object, then the request through the pathing stream, what the goal adds
(the search policy's state: its request and four flags) and the destination: none, a
location, locations, a reference (with its location, a u32 and a timer) or references).
Measured on the second save: cover searches, aim controllers (track target, projectile),
areas (standard, hold position), target selectors, inventory items (melee, ranged, one-handed
block, magic and shouts) and threats. The combat paths, in neither save, are the original's 14
templates (Standard to a location or a reference, MultiGoal and WeightedMultiGoal to locations
or references, StraightPath, RotatePath and Orbit to a location, Flight to a location or a
reference, Landing to a location, Hover and FlyingAttack with no destination; the hover
request's places: a vsval count of a point and seven values) and the 12 generic ones; each is
tested on a buffer written by its layout.

The **combat controller**: the attacker and its target (references), the combat group's id
u32, six switches, a float, a timer; the aim controllers, the current and previous one's
indices; the areas and the current one's index; the target selectors and the current and
previous one (objects); the combat state (switches, positions, timers, the positions it saw its
target at, forms, timers); the inventory (ratings, seven lists of items by kind, two equipped
sets, the items dropped with their time stamps, two form lists and a map); the **blackboard**,
a vsval count of named entries whose value's layout the name gives (the original's keys: the
`Magic…RestrictionTimer`s and `AcquireWeaponTimer` timers, the `CombatDisarmedTimeStamp`,
`CoverSearchFailedTimeStamp` and `FindAttackLocationFailedTimeStamp` time stamps,
`LastFleeDoor` a reference and a time stamp, `TargetUnreachableDistance` a float) and a u32;
and the behaviour tree controller: a u32, a byte, the running tree's state prefixed by its size
in bytes, a list of tree ids and the named trees' states.

## The player

After the actor's data (`src/formats/ess/player.ts`, as observed in the original, read to its
end): switches and timers, a list of (u32, u64 milliseconds), game times relative to the
save's, then the **skills' experience** (CommonLibSSE's PlayerSkills: the level's experience
and threshold, a count of 18, each skill's level, experience, threshold and legendary count), a
vector, a game time and a list of (12 bytes, a game time). Then eight refIds; the last actions
(u32, u32, refId); the **quest log** (quest, stage u16, flags u8); the **objectives** held
(quest, index u32, instance u32, u32); five u32; the **camera** (two bytes, the world and first
person fields of view, every camera state's own data in the original's order: first person,
third person, mount, bleedout, animated, dragon; the current state's index u32, the states
under it, two floats and a byte); a list of (refId, four u32); a refId, two u32, a refId, a
u32; a list of (refId, two u32); the **perks** (refId and rank u8), the same perks as refIds, a
list of (refId, u32); a byte, a byte (0xFF: none; else a u16), a refId, a point, a u32, three
refIds; the face's tints (three refIds, u32, two u32-counted lists of (index u16, colour u32,
alpha f32), a refId); u32 and a refId; a list of (refId, four u16); six bytes; a list of u32;
two refIds, a byte; a list of (refId, two u32); u32, three bytes, u32, refId, byte; a byte and
when set eight refIds (the forms before a transformation); u32, three bytes, u32 and a byte.
Every count written after its entries is a vsval like the others (the original reserves its
byte and widens it).

## Import

`importEss(ess, world, request)` makes our `GameSave` (docs/formats/save.md). The Load page puts
it in the save store, and it loads through the same path as our own saves: the plugins are read
as for a new game, then the state is applied. Form ids move from the save's load order to ours by
plugin name, and forms of plugins not loaded are left out. What it applies:

- actors: their actor values (base values that changed, modifiers, damage) and the factions
  a script put them in or took them out of; the package each ran (its AI process's current
  package) and whom it fought (its combat controller's target), for the actors the save has
  moved: our world save's actors (`GameSave.world`, docs/formats/save.md), so those of the
  loaded area go on with that package as they are placed, in the branch of its procedure tree
  it had reached: a Sequence's, Stacked's and Random's u32 is the index of the child it runs, a
  Simultaneous's children each keep theirs (every branch state of the saves read names a child
  there, whose procedure the child's state names: SitSleep for Sit and Sleep,
  DialogueActivate for ForceGreet). Of the procedures' own states (each keeps the references it
  names, the places it goes to as LocRef, LocPt or LocCell, and the procedures it runs inside:
  SitSleep's Activate, a Sandbox's activity, a Patrol's UseIdleMarker and SitSleep): a Patrol's
  point (its patrol data: a state u32, a timer f32, the index of the point it stands at or walks
  to, two switches, a u32, then its points from where it began; ours `SavedPackage.goal`, from
  which its patrol goes on), the furniture a SitSleep goes into (its Activate's reference, while
  the actor enters: `SavedActor.furniture`). A Travel's, an Escort's and a Sandbox's places are
  their package's (ours finds its path and picks its activity again from where the actor
  stands; TODO(M13): a Sandbox's timers and a Wander's point). The actor's state bytes (18, one
  per ActorState field): the third its sit and sleep state, the thirteenth its weapon's (2
  drawing, 3 drawn: `SavedActor.weaponDrawn`); TODO(M13): the others (the first's movement
  bits). A fighting actor's
  process package is its combat override package (ECOR), unless a scene's package action holds
  it; a scene package action whose package completed stays the actor's package while the action
  runs (GetCurrentPackage answers both so); an actor the save keeps at its
  record's place (it writes no place for it) stands there with its package (`essWorld(db,
ess)` reads those places ahead);
- the player: where they stand (their ACHR's moved place, else the player location table),
  level, name, race, the 18 skills and DNAM's health, magicka and stamina (TODO(M13): checked
  against a real save), factions, the base's spells and shouts; their inventory changes; the
  experience towards the next level (the character's and each skill's), the times each skill
  was made legendary, and the perks they have; the quest log's entries (each quest's stages'
  log entries, oldest first, and the journal's order by the newest); the camera: first person
  (its state 0) or third (9 to 12), and the world and first person fields of view (our world
  save's player; TODO(M13): a save made in another camera state goes back to the one under it);
- globals (GameDaysPassed sets the clock) and misc stats;
- quests: running, completed, failed and active flags, the stages done (the current stage is
  the highest done: TODO(M13)), objectives (shown, completed, failed), alias references, the
  story event that started each (its members numbered by kind, R1, L1, K1, V1, ...);
- the story event manager's events told and not yet processed: told again once the game has
  loaded (our saves keep them too; none in the saves read; TODO(M13): the started quest's
  OnStory arguments in the members' order, checked on Script Event only);
- the entries scripts added to leveled lists;
- references: moved (cell or world by the record's type), enabled or disabled, deleted, scale,
  owner, inventory changes (`GameSave.inventoryDeltas`, added to the records' inventories after
  the load), the open-state flag (TODO(M13): its data), references the game created;
- books read and locations cleared; infos said (their Say Once marks);
- actors' life state, the fifth of their saved state bytes (CommonLibSSE's ACTOR_LIFE_STATE: 2
  on the opening's executed and killed, 0 on the living; 6 restrained, 3 unconscious): dead,
  restrained, unconscious;
- locks (the Lock extra: level, flags with bit 0 locked, key): the level and whether locked;
- the scenes playing (SCEN): the first state word is the phase (−1: not begun, a start
  waiting); each action's last two bytes are running and done (package actions that run on
  done 1 1, lines said 0 1, packages running 1 0, not begun 0 0), its u32 a looping line's wait
  as a float (TODO(M13): seen once, 1.75); the cast from the quest's aliases;
- NPC_ bases: ACBS's essential, protected and invulnerable flags, the outfits; the player's face,
  sex and the player data's tint masks (index u16, colour RGBA bytes, alpha f32) as their
  appearance (TODO(M13): the body's weight is not found in the save: 50);
- the magic favorites and their hotkeys (global data 109);
- the sky (global data 6): the current weather, the one a change under way comes from, the
  weather scripts hold over the regions (the override: MQ101 forces its) and the one standing
  for the regions' choice, when the current came (`beginTime`, the time of day): our save's
  `sky`, which goes on with the change (TODO(M13): its share is ours from when it began; the
  original keeps its own, `weatherPercent`, 1 in the saves read); the climate, region and fog
  follow from where the player is;
- the music (global data 7): the types in play beside the location's, oldest first (the
  table's last form is the location's type, which follows from the place): our save's `music`,
  added again as it loads (MQ101's MUSDungeonChargen on the cart, MUSCombatBossChargen as Alduin
  attacks); TODO(M13): the first form (0 in the saves read);
- the interface (global data 102): the input events whose help messages the player has done
  (the names list: "Look", "Forward"), not shown again (`GameState.helpDone`); the weapons,
  spells and shouts used last (counted once each). TODO(M13): the help messages shown (one
  number, 252) and the two words beside it;
- the actor causes (global data 103): the actor each serial number blames, for the ActorCause
  extra data;
- the extra data of references and actors (each extra comes with its change flag in the saves
  read: Ownership, Lock, ReferenceHandle with itemExtraData, EncounterZone with
  encounterZoneExtra, PromotedRef with promoted, LeveledCreature with leveledActor,
  PackageStartLocation and Follower with packageExtraData, DismemberedLimbs with
  dismemberedLimbs; the rest with gameOnlyExtra): an item reference's holder (ReferenceHandle:
  the reference lies in that inventory, `ReferenceState.container`; the holder's entry names it
  back), the encounter zone the game gave a reference (all NoZoneZone in the saves read; it wins
  over its record's and cell's), a base a script swapped in (`ReferenceState.base`, which
  `baseOf` answers), the NPC_ a leveled actor's lists came down to (LeveledCreature's second
  form; the first is its base: `ActorState.leveledBase`, kept by the actor's templates rather
  than drawn again; TODO(M13): the changes to the generated base after them, none in the saves
  read), ActorCause, ExtraFlags' bit 0 (activation blocked; TODO(M13): the other bits, none set),
  Ghost, a map marker's flags (bit 0 shown, bit 1 travelled to), a name the player gave
  (TextDisplayData of kind −2; the others are an alias's name), where a package started and the
  packages run once a day that ran (TODO(M13): the byte beside each; counted run today); those
  that follow from what is applied: AliasInstanceArray, PromotedRef, SceneData, CachedScale,
  Follower; a rider and its horse (Interaction of kind 0: the kind u32, the rider, the horse, a
  byte; Elenwen beside the carts: `SavedActor.riding`; TODO(M13): the other kinds and the
  byte), the limbs cut off (DismemberedLimbs: after a u16, two u32, a byte and the actor, each
  limb's body part type u32 and the forms the actor wore as it came off, the decapitated head
  among them: `ActorState.dismembered`; TODO(M13): the five values), the magic on an object
  (NonActorMagicTarget: the object and its effects, each a magic item, a byte, a vsval and a
  sized block; none on the three objects of the saves read; TODO(M13): the effects' data).
  Not applied (logged by name): AttachedArrows3D (arrows stuck in a body: each the PROJ, the
  bone's index, a u32, its translation, its rotation as a quaternion and its scale; ours draws
  them, keeps none);
- inventory entries' extra data lists, each a stack of the item: what an actor wears or holds
  (Worn: on the body, or in the right hand for a weapon or torch; WornLeft: the left hand),
  put on after the inventory changes (`GameSave.worn`); health (a tempered item's, rounded to
  ours: 1.1, 1.2, ...), charge and soul as `GameState.itemStacks`; a weapon's poison. Outfit items
  (OutfitItem) are left out of the inventory change: ours puts the outfit on as the actor's
  inventory is first read (TODO(M13): its leveled pieces are ours, picked by the actor's seed).
  Count, LeveledItem, UniqueID, the quest aliases' and an alias's name follow from the rest;
  CannotWear on an item a cut limb took with it (the decapitated head: ours dresses the body
  from its limbs) follows from DismemberedLimbs, elsewhere it is logged;
- NPC_ bases other than the player's: the factions (the whole list as it stands, ranks), the 18
  skills (DNAM) and the AI data (AIDT's aggression, confidence, energy, morality, mood,
  assistance), over their records for every actor of the base (`ActorBaseState`; TODO(M13):
  DNAM's offsets, health, magicka, stamina, AIDT's aggro radii);
- cells: the detach time (whole game hours, as ours keeps `cellDetached`: 7 in saves whose
  clock reads 8.3 hours), what the player has seen (the local map's fog: 32 bytes, 16 × 16 bits
  per block, each 2 × 2 of ours; an exterior's one block, an interior's per part with its two
  signed bytes; TODO(M13): the block's size and the bits' order, and ours draws no fog on the
  exterior local map), a public place (the flags' 0x20, as the record's DATA; TODO(M13): 0x40
  and 0x200, whose meaning is not known), the owner;
- a quest's runs (instanceData: a u32, then each run's id, its aliases' references as alias id
  and reference, the text display globals' values as global and float, three bytes): the
  globals' values (`QuestState.instanceGlobals`); TODO(M13): the first u32 and the three bytes;
- a location's keyword data (LCTN bit 30: the values scripts set on its keywords);
- Papyrus: each script instance's variables, by script level (a type's members follow its
  parents'), with object variables as handles to the instances' forms, and the state each
  instance is in; an alias script's instance on its alias (the object table's high word is the
  alias id, −1 on every form's);
- the running stacks, as our waiting threads: our VM runs the compiled code, so each frame goes
  on at the instruction the save has it at (its function, script, state, Self and variables,
  params then locals); every frame of the saves read stands on its call (the callee's frame, or
  the native call its function message queued), which runs again as the message would have; a
  stack in a wait table (Wait real time, WaitMenuMode on the wall clock, WaitGameTime) waits for
  its clock (TODO(M13): the times as on the update registrations, no save read has one); the
  suspended stacks' calls start; TODO(M13): a stack's fragment callback, a property accessor's
  function type;
- the animation event registrations (by sender and lowercase name), the sleep and tracked stats
  registrations, the inventory event filters (items and form lists); TODO(M13): RegisterForLOS's
  (the save names viewer and target, not the registering object) and the latent functions'
  queued work (none in the saves read);
- the factions' reactions (FACT bit 2: the modifier and the group combat reaction to each);
- the OnUpdate and OnUpdateGameTime registrations, each going on with the time it had left
  (the original saves the time to send on the VM's clock, which the timer table keeps at 0 in
  the saves read: so the time is what is left, TODO(M13) on a save where it is not; real time
  in milliseconds, game time in thousandths of an hour), single or repeating, on the form or
  the alias of the handle's high word;
- the forms scripts added to form lists (FLST);
- the arrows lying in the world (PARW, the references the original made for arrows that hit the
  world: created, with their place and cell): a reference of the arrow's ammunition (the
  projectile's second form: bow, ammunition, shooter, ...), held where it stuck, falling where
  physics moved it (havokMoved), as ours makes one (src/shell/combat-projectiles.ts);
- the combat groups (global data 101): each member's target (the member is the first of its
  values), for a member whose own combat controller names none; ours puts the groups together
  again as their members fight. TODO(M13): a group's search (logged; none in the saves read),
  the members' other values, the groups' float pairs;
- the quest static data (global data 107): its fourth list is the quests running (the same 451
  quests in both saves whose change forms say they run, which those apply; a listed quest that
  does not run is logged). TODO(M13): the other three lists (empty in the saves read).

Read but not imported yet (TODO(M13)): the projectiles and hazards in flight; the base objects'
other changes (values, names, known ingredient effects; the scenes' clocks); the global data
tables of detection (105: each a reference with two values, 0, 2 or 3 and 0 or 7, whose meaning
is not known), the process lists (100: their three floats, −0.0168 twice and a value that
differs by save, meaning not known; the crimes, none in the saves read), temp effects (1000: the
decals on objects, as DecalFlameBurn01 on the opening's carts, its texture set, place, normal
and size; ours has no decal store to put them in) and the interface's help shown (102); the
movement controller's state (the engine plans its paths anew); the high process's timers and
held objects (six references with a byte each, whose meaning is not known); the combat
controllers' searches and objects; the graph variables of the animation change forms (REFR,
ACHR, PMIS, PFLA: the sized block is read past); the player's other lists.

Everything else is counted by change form type and flag (`REFR: lockExtra x 12`) and by where a
read stopped, then logged under `save` as not imported.

## In Play

The journal's System page, Load: the list ends with "Import .ess (a save of the original game)".
It opens a file picker (`showOpenFilePicker`, starting in Documents), imports the save as a new
save of ours named `Imported <player> <save number>`, and loads it.

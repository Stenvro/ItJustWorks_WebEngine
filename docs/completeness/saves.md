# Saves: completeness

What "100" means here (M12): an original save (`.ess`) imported resumes the game the original
saved, with every part of it the game uses applied (docs/formats/ess.md "Import"); and our own
save (docs/formats/save.md) keeps everything a running game holds, so a loaded game goes on as
the one saved would have. The format readers are complete (docs/completeness/formats.md); this
list is about what the import does with what is read, and what our save keeps.

The sweep `node tools/save-completeness.ts` (`--all` for every item with its status) measures
both machine-checkable parts:

- **The .ess part** reads the maintainer's own original saves at run time (Documents\My
  Games\Skyrim Special Edition\Saves; none is in the repo, the part is skipped without them)
  and imports each. A change form type's change flag is done when no save's import lists it as
  not imported (the import logs every flag set that it did not apply, by type); a global data
  table by the sweep's own table of what the import applies, checked against the import's log.
  Only the change form types and flags the saves read use are listed (the two saves: a new game
  on the cart, and one played on to Helgen Keep).
- **The own-save part** reads the runtime's stateful classes (src/scripting/runtime): each
  private field that is not a record or settings cache is done when its class's save method
  keeps it, or when the sweep's table says why no save needs it (derived from what is saved, or
  gone within a frame); else open. Every GameState field is saved (gameStateData writes them
  all); the runtime's public switches by SAVED_RUNTIME_FIELDS.

The world beside the scripts (the stage's actors, graphs, physics, audio, the sky) is kept by
hand below, against docs/formats/save.md.

## Count (2026-11-01, round 2)

| Part                          | Items | Done | Open |
| ----------------------------- | ----: | ---: | ---: |
| .ess header                   |     4 |    3 |    1 |
| .ess global data              |    30 |    7 |   23 |
| .ess change forms (flags)     |    68 |   39 |   29 |
| .ess other (import and hand)  |     4 |    3 |    1 |
| Own save: runtime fields      |   161 |  159 |    2 |
| Own save: the world (by hand) |    24 |   13 |   11 |
| Total                         |   291 |  224 |   67 |

(Round 1: 290 items, 211 done. The sweep itself prints 264 items: the ".ess other" part lists
only what the import still logs, so its three items done this round are kept by hand below.)

Round 2 built down:

- The AI process beyond the package: a running package goes on in the branch of its procedure
  tree it had reached (the procedure states' child indices, `procedurePath`: every one of some
  3,300 branch states in the saves read names a child at its index). The package an actor runs
  (GetCurrentPackage) is its combat override package (ECOR) while it fights, unless a scene's
  package action holds it, and a scene package action's package once it completed, while the
  action runs: as the saves keep both. A fight a load starts reads the actor's profile first, so
  its override package leashes it at once. The opening's import: 14 of the 16 living actors
  placed round the player run the package the save has them on (5 before; MQ101's archers on
  DefaultHoldPositionLinkedRef128, Ralof at the keep).
- Papyrus: the running stacks resume as our threads at the instruction the save has each frame
  at (our VM runs the compiled code, so the positions are the same: every frame read stands on
  its call, which runs again as its function message would); the suspended calls start; a stack
  in a wait table waits for its clock; the animation event, sleep, tracked stats and inventory
  filter registrations are put back. An alias script's instance lands on its alias (the object
  table's high word is the alias id, −1 on forms): before, every alias script's variables went
  to its quest.
- FACT reactions (bit 2): the modifier and the group combat reaction to each faction.
- Our own save: the casting delays and lesser power cooldowns, regeneration delays, NPC assaults
  answered, traps' contacts, Accumulate Magnitude growth, the share of an effect done at once and
  the summons fading (RuntimeSave.engines).

Round 1 wrote the sweep and this list, and built
down:

- Actors the save keeps where their records stand (it writes no place for them) and that run a
  package: placed at their records' places with it, as the moved ones are (208 per save were
  left to choose their packages anew). `essWorld(db, ess)` reads their records' places ahead.
- The actors' life state (their state bits' fifth byte, CommonLibSSE's ACTOR_LIFE_STATE): the
  executed prisoners and the opening's dead are dead after the import, the restrained
  restrained (ACHR lifeState, 16 forms).
- Locks (REFR lockExtra, 252 forms): the level and whether it is locked.
- The scenes playing (SCEN, 20 forms): each goes on in its phase, cast from its quest's
  aliases, its actions' states (running, done; a line's wait) as the save has them; a scene not
  begun yet waits to start.
- The player's appearance (NPC_ face and gender, the player data's tint masks): race, sex, head
  parts, hair colour, skin tone, complexion, face sliders and parts, tints.
- ACBS flags scripts set on a base (essential, protected, invulnerable) and the outfits
  (NPC_ baseData, defaultOutfit).
- Infos said (INFO, 179 forms): their Say Once marks.
- Magic favorites and their hotkeys (global data 109).

Checked by tests/sim-ess-import.int.test.ts "the opening, imported": the save played to Helgen
Keep imported into a fresh simulation: MQ101 at its stages, its dead dead, every reference the
save enables or disables so, the player a High Elf with their face, and the actors placed around
the player on the packages the save has them run (14 of 16 since round 2; two archers the save
has fighting do not take the fight up again). The cart save's import resumes its two running
stacks without a problem logged and keeps its registrations (the same file, "restores the
player's place").

## The .ess side

### Header

| Item                                       | Status | Where / why open                          |
| ------------------------------------------ | ------ | ----------------------------------------- |
| Header (name, level, race, location, date) | done   | ess-import.ts: our save header            |
| Screenshot                                 | open   | our saves write no thumbnail yet (M13)    |
| Plugins                                    | done   | formIdMapper: by name into our load order |
| Light plugins                              | done   | formIdMapper                              |

### Global data

| Table                        | Status | Where / why open                                                       |
| ---------------------------- | ------ | ---------------------------------------------------------------------- |
| 0 Misc Stats                 | done   | the runtime's stats                                                    |
| 1 Player Location            | done   | the player's place when their change form has none                     |
| 2 TES                        | open   | visited worldspaces, the cell grid                                     |
| 3 Global Variables           | done   | GameState globals; GameDaysPassed sets the clock                       |
| 4 Created Objects            | open   | made potions, poisons, enchantments (none in the saves read)           |
| 5 Effects                    | open   | image space modifiers running                                          |
| 6 Weather                    | open   | the current weather applied; its transition and the sky's other fields |
| 7 Audio                      | open   | the music playing                                                      |
| 8 Sky Cells                  | open   | not applied                                                            |
| 100 Process Lists            | open   | crimes being reported                                                  |
| 101 Combat                   | open   | the combat groups, their searches                                      |
| 102 Interface                | open   | help messages shown, the HUD                                           |
| 103 Actor Causes             | open   | not applied                                                            |
| 104 Unknown                  | open   | not in the saves read                                                  |
| 105 Detection Manager        | open   | not applied                                                            |
| 106 Location MetaData        | open   | not applied                                                            |
| 107 Quest Static Data        | open   | the quests' run data and instances                                     |
| 108 StoryTeller              | open   | not applied                                                            |
| 109 Magic Favorites          | done   | GameState favorites and hotkeys                                        |
| 110 PlayerControls           | open   | its fields' meaning not known                                          |
| 111 Story Event Manager      | done   | the events waiting, told again after the load                          |
| 112 Ingredient Shared        | open   | the ingredients' known effects                                         |
| 113 MenuControls             | open   | not applied                                                            |
| 114 MenuTopicManager         | open   | not applied                                                            |
| 1000 Temp Effects            | open   | decals, shaders, particles in the world                                |
| 1001 Papyrus                 | done   | instances, stacks, messages, waits, suspended calls, registrations     |
| 1002 Anim Objects            | open   | what actors hold                                                       |
| 1003 Timer                   | open   | not applied                                                            |
| 1004 Synchronized Animations | open   | paired animations under way                                            |
| 1005 Main                    | done   | empty in every save read                                               |

### Change forms

By type, each change flag the saves use (forms counted over both saves).

| Type | Flag                     | Forms | Status | Where / why open                                              |
| ---- | ------------------------ | ----: | ------ | ------------------------------------------------------------- |
| REFR | form flags               |  2880 | done   | enabled, deleted                                              |
| REFR | moved, havokMoved        |   299 | done   | the reference's place                                         |
| REFR | cellChanged, promoted    | 11305 | done   | its cell or worldspace                                        |
| REFR | inventory, leveledInv.   |   144 | done   | inventory changes added after the load                        |
| REFR | lockExtra                |   252 | done   | level, locked                                                 |
| REFR | itemExtraData            |   178 | open   | the items' extra data (soul, charge, poison)                  |
| REFR | animation                |    26 | open   | the object's graph state (ours keeps its own)                 |
| REFR | encounterZoneExtra       |   367 | open   | the zone a reference belongs to                               |
| REFR | gameOnlyExtra            |  1467 | open   | the game's own extra data                                     |
| REFR | baseObject               |    30 | open   | a base swapped by a script                                    |
| ACHR | form flags               |   286 | done   | enabled, deleted                                              |
| ACHR | moved, havokMoved, cell  |  2755 | done   | its place (and its package and fight there)                   |
| ACHR | promoted, scale          |  2088 | done   |                                                               |
| ACHR | inventory, leveledInv.   |  1254 | done   |                                                               |
| ACHR | lifeState                |    16 | done   | dead, unconscious, restrained                                 |
| ACHR | packageExtraData         |    67 | open   | the package's own extra data                                  |
| ACHR | dismemberedLimbs         |     1 | open   | the limbs cut off                                             |
| ACHR | leveledActor             |  2784 | open   | the leveled actor's generated base                            |
| ACHR | animation                |    49 | open   | the actor's graph state                                       |
| ACHR | encounterZoneExtra       |   516 | open   |                                                               |
| ACHR | gameOnlyExtra            |  1472 | open   |                                                               |
| NPC_ | baseData                 |    22 | done   | ACBS essential, protected, invulnerable                       |
| NPC_ | face, gender, race, name |     4 | done   | the player's appearance and name                              |
| NPC_ | defaultOutfit            |     1 | done   | the base's outfit                                             |
| NPC_ | factions                 |   264 | open   | the player's done; other bases' have no place in ours yet     |
| NPC_ | skills                   |    23 | open   | the player's done; other bases'                               |
| NPC_ | aiData                   |    23 | open   | aggression, confidence, ... set on a base                     |
| QUST | flags, alreadyRun        |  1828 | done   | running, completed, failed, active                            |
| QUST | stages                   |   232 | done   | stages done (the current stage: the highest done, TODO(M13))  |
| QUST | objectives, runtimeData  |   903 | done   | objectives, aliases, the story event                          |
| QUST | instanceData             |   244 | open   | the quest's instance data                                     |
| CELL | flags (bit 1)            |   225 | open   | the cell's flags                                              |
| CELL | exterior bits 29, 30     |   128 | open   | detach time: the cell reset clocks                            |
| CELL | seen data (bit 31)       |    30 | open   | the local map's fog                                           |
| INFO | said (bit 31)            |   179 | done   | Say Once marks                                                |
| SCEN | running state (bit 31)   |    20 | done   | phase, cast, actions                                          |
| FLST | added forms (bit 31)     |    50 | done   | the forms scripts added                                       |
| LVLI | added (bit 31)           |   100 | done   | leveled list additions                                        |
| LVLN | added (bit 31)           |     2 | done   |                                                               |
| FACT | reactions (bit 2)        |   114 | done   | modifier and combat reaction to each faction                  |
| FACT | crimeCounts (bit 31)     |     1 | open   | crime counts: the four values' meaning not known              |
| LCTN | keyword data (bit 30)    |   128 | open   | location keyword data                                         |
| SMQN | bit 31                   |    18 | open   | the story manager nodes' last run                             |
| PARW | moved, havokMoved, cell  |    32 | open   | arrows lying in the world (projectile change forms not taken) |
| PARW | encounterZoneExtra       |     4 | open   |                                                               |
| PMIS | moved                    |     1 | done   |                                                               |
| PMIS | animation                |     1 | open   |                                                               |
| PFLA | moved                    |     1 | done   |                                                               |
| PFLA | animation                |     1 | open   |                                                               |
| PGRE | form flags               |     4 | done   |                                                               |
| PHZD | form flags, moved        |    83 | done   |                                                               |
| PHZD | gameOnlyExtra            |     1 | open   |                                                               |

(The sweep lists each flag on its own line; rows here group flags that share a status.)

### Other parts the import lists

| Item                                                                | Status | Why open                                                                    |
| ------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------- |
| The package's branch reached; the package GetCurrentPackage answers | done   | procedurePath; combat override, scene package done                          |
| The procedures' own states, the process's timers and held objects   | open   | where a Travel goes, a Sandbox's activity, a Patrol's point: M13            |
| Papyrus running stacks                                              | done   | resumed at the compiled instruction (by hand: the import no longer logs it) |
| Papyrus messages, waits, registrations other than updates           | done   | LOS and latent functors: none in the saves read, logged if seen             |

## Our own save

### Runtime fields (the sweep)

161 fields: 159 done (kept by their class's save method, GameState, SAVED_RUNTIME_FIELDS, a
record or settings cache, or derived or gone within a frame as the sweep's table says), 2 open.
Round 2 gave the casting, progression, crime, magic engines and the traps' hits saveData and
loadData (RuntimeSave.engines; src/scripting/runtime/engine-save.test.ts):

| Field                      | Status | What is lost on a load                        |
| -------------------------- | ------ | --------------------------------------------- |
| casting-engine#casts       | open   | a cast being charged or held                  |
| casting-engine#shouting    | open   | a shout key held                              |
| casting-engine#lastCast    | done   | the AI's delays between casts (seconds ago)   |
| casting-engine#lesserUsed  | done   | lesser powers' cooldowns (seconds ago)        |
| crime-engine#npcAssaults   | done   | NPC assaults answered                         |
| magic-engine#accumulating  | done   | by the effect's key                           |
| magic-engine#did           | done   | by the effect's key                           |
| magic-engine#fadingSummons | done   | seconds left                                  |
| progression-engine#delays  | done   | seconds left                                  |
| trap-hits#entries          | done   | on the game's real time, which the save keeps |

### The world (by hand, against docs/formats/save.md)

| Item                                                             | Status | Where / why open                                        |
| ---------------------------------------------------------------- | ------ | ------------------------------------------------------- |
| References moved, enabled, deleted, created, taken, open, locked | done   | GameState references, created                           |
| Inventories, item stacks, containers' restock clocks             | done   | GameState inventories, itemStacks, restocked            |
| Actors on the stage: place, furniture, package, patrol point     | done   | world-save.ts SavedActor                                |
| Actors' fights (target, confidence), sneaking, weapon, flying    | done   | SavedActor                                              |
| Actors' state (dead, corpse poses, alpha, head tracking, ...)    | done   | GameState ActorState                                    |
| Animation graphs (actors, the player, placed objects)            | done   | tests/sim-save-graphs.int.test.ts                       |
| Vehicles (tethers, riders, a rider getting out)                  | done   | tests/sim-save-ride.int.test.ts                         |
| Quests, aliases, scenes, dialogue memory, story manager          | done   | RuntimeSave                                             |
| Papyrus: instances, threads' frames, update registrations        | done   | RuntimeSave threads, updates, registrations             |
| Translations, hazards, projectiles in flight                     | done   | RuntimeSave translations, GameSave hazards, projectiles |
| Time, weather, the player's stats, perks, effects, bounty, map   | done   | GameState, the sky's current weather                    |
| Crime (bounties, stolen items, jail), factions                   | done   | GameState                                               |
| The player's camera, sneaking, weapon, vehicle                   | done   | SavedPlayer                                             |
| Actors in cells not loaded as the game is saved                  | open   | their packages place them                               |
| A procedure's progress inside a step (a sandbox's activity)      | open   | it chooses again                                        |
| Graph transitions' blends, modifiers' states, behavior refs      | open   | docs/formats/save.md "Animation graphs"                 |
| Bleedout and paired animations' engine side                      | open   | their bookkeeping                                       |
| Physics bodies in motion (loose objects knocked about)           | open   | no velocities nor rest places kept beside projectiles   |
| The sky's transition between weathers                            | open   | the current weather only                                |
| The music playing (audio state)                                  | open   | music chooses again                                     |
| Combat groups' searches, detection levels                        | open   | the fight starts again                                  |
| Flame sprays, cone waves, a Magelight stuck to a wall            | open   | docs/formats/save.md                                    |
| Thumbnails                                                       | open   | none written                                            |
| Save on Pause, the Load list's character filter                  | open   | docs/formats/save.md "Not saved yet"                    |

## Next biggest open items

1. The extra data of references and actors (itemExtraData: souls, charges, poisons, 178 forms;
   encounter zones, 883; gameOnlyExtra, 2,940; leveled actors' generated bases, 2,784; baseObject
   swaps, 30): ours has no place for most of them yet (per-item extra data in inventories, a
   reference's zone, a leveled actor's base kept rather than drawn again).
2. The procedures' own states inside a branch (where a Travel goes, a Sandbox's activity and
   timers, a Patrol's point) and the high process's timers and held objects; the two archers of
   the opening that do not take their fight up again.
3. The global data tables still open: combat (groups, searches), detection, process lists
   (crimes being reported), audio (the music), temp effects, quest static data, interface.
4. NPC\_ bases' factions, skills and AI data a script changed (no place for other bases' in
   GameState yet); QUST instance data; CELL detach times and the local map's fog.
5. Our own save's world side: physics bodies in motion, the music, the sky's transition; casts
   being charged and shout keys held.

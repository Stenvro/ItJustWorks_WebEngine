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

## Count (2026-11-01, round 3)

| Part                          | Items | Done | Open |
| ----------------------------- | ----: | ---: | ---: |
| .ess header                   |     4 |    3 |    1 |
| .ess global data              |    30 |   10 |   20 |
| .ess change forms (flags)     |    68 |   55 |   13 |
| .ess other (import and hand)  |    10 |    3 |    7 |
| Own save: runtime fields      |   161 |  159 |    2 |
| Own save: the world (by hand) |    24 |   15 |    9 |
| Total                         |   297 |  245 |   52 |

(Round 2: 291 items, 224 done; round 1: 290, 211. The sweep itself prints 270 items: the ".ess
other" part lists only what the import still logs, so its three items done earlier are kept by
hand below. Round 3 made the import log each extra data type it does not apply by name, which
added six items there.)

Round 3 built down:

- The extra data of references and actors, each where ours keeps it (docs/formats/ess.md
  "Import"): an item reference's holder (itemExtraData), the encounter zone the game gave a
  reference (ReferenceState.encounterZone, which the progression engine reads first), a base a
  script swapped in (ReferenceState.base, which baseOf answers), a leveled actor's pick
  (ActorState.leveledBase: the actor's templates come down to it, not drawn again), the actor
  causes (global data 103), blocked activation, ghosts, map markers' flags, names the player
  gave, where packages started and the packages run once; inventory entries' extra data: what
  actors wear and hold (put on after the load), health, charge, soul, poison (outfit items left
  to the outfit ours puts on: before, every imported NPC carried its outfit twice).
- NPC\_ bases' factions, skills and AI data over their records (ActorBaseState, read by the
  actor engine); cells' detach times, public flag and seen data (the local map's fog); quest
  runs' text display globals (instanceData); locations' keyword data.
- The sky and the music, in both saves: the sky's change under way, override and default
  weathers (SkyWeather save and restore; the import from global data 6), the music types
  scripts added (global data 7); the help messages the player has done (GameState.helpDone,
  global data 102). A save notes where the loaded cells' moved objects are.
- The opening's two Imperial mages fighting Alduin beyond the fighters' reach of the player
  take their fight up again: an actor told to fight far away becomes a fighter
  (actor-combat.ts). All 16 living actors placed round the player run the save's package.

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
the player on the packages the save has them run (all 16 since round 3), the player wearing what
the save has them wear, MQ101's forced weather and boss music, the help done. The cart save's
import resumes its two running
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

| Table                        | Status | Where / why open                                                        |
| ---------------------------- | ------ | ----------------------------------------------------------------------- |
| 0 Misc Stats                 | done   | the runtime's stats                                                     |
| 1 Player Location            | done   | the player's place when their change form has none                      |
| 2 TES                        | open   | visited worldspaces, the cell grid                                      |
| 3 Global Variables           | done   | GameState globals; GameDaysPassed sets the clock                        |
| 4 Created Objects            | open   | made potions, poisons, enchantments (none in the saves read)            |
| 5 Effects                    | open   | image space modifiers running                                           |
| 6 Weather                    | done   | current, outgoing, override, default; when it came (GameSave.sky)       |
| 7 Audio                      | done   | the music types in play (GameSave.music; the location's from the place) |
| 8 Sky Cells                  | open   | not applied                                                             |
| 100 Process Lists            | open   | crimes being reported (none in the saves read); three floats unknown    |
| 101 Combat                   | open   | the combat groups, their searches                                       |
| 102 Interface                | open   | help done, last used applied; the help shown (meaning: TODO(M13))       |
| 103 Actor Causes             | done   | the actor each ActorCause extra blames                                  |
| 104 Unknown                  | open   | not in the saves read                                                   |
| 105 Detection Manager        | open   | not applied                                                             |
| 106 Location MetaData        | open   | not applied                                                             |
| 107 Quest Static Data        | open   | lists of quests whose meaning is not known (TODO(M13))                  |
| 108 StoryTeller              | open   | not applied                                                             |
| 109 Magic Favorites          | done   | GameState favorites and hotkeys                                         |
| 110 PlayerControls           | open   | its fields' meaning not known                                           |
| 111 Story Event Manager      | done   | the events waiting, told again after the load                           |
| 112 Ingredient Shared        | open   | the ingredients' known effects                                          |
| 113 MenuControls             | open   | not applied                                                             |
| 114 MenuTopicManager         | open   | not applied                                                             |
| 1000 Temp Effects            | open   | decals, shaders, particles in the world                                 |
| 1001 Papyrus                 | done   | instances, stacks, messages, waits, suspended calls, registrations      |
| 1002 Anim Objects            | open   | what actors hold                                                        |
| 1003 Timer                   | open   | not applied                                                             |
| 1004 Synchronized Animations | open   | paired animations under way                                             |
| 1005 Main                    | done   | empty in every save read                                                |

### Change forms

By type, each change flag the saves use (forms counted over both saves).

| Type | Flag                     | Forms | Status | Where / why open                                              |
| ---- | ------------------------ | ----: | ------ | ------------------------------------------------------------- |
| REFR | form flags               |  2880 | done   | enabled, deleted                                              |
| REFR | moved, havokMoved        |   299 | done   | the reference's place                                         |
| REFR | cellChanged, promoted    | 11305 | done   | its cell or worldspace                                        |
| REFR | inventory, leveledInv.   |   144 | done   | inventory changes added after the load                        |
| REFR | lockExtra                |   252 | done   | level, locked                                                 |
| REFR | itemExtraData            |   178 | done   | the item reference's holder (ReferenceState.container)        |
| REFR | animation                |    26 | open   | the object's graph state (ours keeps its own)                 |
| REFR | encounterZoneExtra       |   367 | done   | ReferenceState.encounterZone                                  |
| REFR | gameOnlyExtra            |  1467 | open   | applied but NonActorMagicTarget (3 forms): magic on objects   |
| REFR | baseObject               |    30 | done   | ReferenceState.base (baseOf)                                  |
| ACHR | form flags               |   286 | done   | enabled, deleted                                              |
| ACHR | moved, havokMoved, cell  |  2755 | done   | its place (and its package and fight there)                   |
| ACHR | promoted, scale          |  2088 | done   |                                                               |
| ACHR | inventory, leveledInv.   |  1254 | done   |                                                               |
| ACHR | lifeState                |    16 | done   | dead, unconscious, restrained                                 |
| ACHR | packageExtraData         |    67 | done   | the package's start; Follower (no data)                       |
| ACHR | dismemberedLimbs         |     1 | open   | the limbs cut off: the extra's data read past, not kept       |
| ACHR | leveledActor             |  2784 | done   | ActorState.leveledBase: the pick kept                         |
| ACHR | animation                |    49 | open   | the actor's graph state                                       |
| ACHR | encounterZoneExtra       |   516 | done   |                                                               |
| ACHR | gameOnlyExtra            |  1472 | open   | applied but Interaction (a rider, 1) and AttachedArrows3D (1) |
| NPC_ | baseData                 |    22 | done   | ACBS essential, protected, invulnerable                       |
| NPC_ | face, gender, race, name |     4 | done   | the player's appearance and name                              |
| NPC_ | defaultOutfit            |     1 | done   | the base's outfit                                             |
| NPC_ | factions                 |   264 | done   | ActorBaseState.factions over SNAM (the player's: their own)   |
| NPC_ | skills                   |    23 | done   | ActorBaseState.skills over DNAM (offsets: TODO(M13))          |
| NPC_ | aiData                   |    23 | done   | ActorBaseState.aiData over AIDT                               |
| QUST | flags, alreadyRun        |  1828 | done   | running, completed, failed, active                            |
| QUST | stages                   |   232 | done   | stages done (the current stage: the highest done, TODO(M13))  |
| QUST | objectives, runtimeData  |   903 | done   | objectives, aliases, the story event                          |
| QUST | instanceData             |   244 | done   | the runs' text display globals (instanceGlobals)              |
| CELL | flags (bit 1)            |   225 | done   | public (0x20); 0x40 and 0x200 unknown (listed below)          |
| CELL | exterior bits 29, 30     |   128 | done   | detach time: cellDetached (whole game hours)                  |
| CELL | seen data (bit 31)       |    30 | done   | GameState.seen (seenFromSave); no exterior fog drawn: M13     |
| INFO | said (bit 31)            |   179 | done   | Say Once marks                                                |
| SCEN | running state (bit 31)   |    20 | done   | phase, cast, actions                                          |
| FLST | added forms (bit 31)     |    50 | done   | the forms scripts added                                       |
| LVLI | added (bit 31)           |   100 | done   | leveled list additions                                        |
| LVLN | added (bit 31)           |     2 | done   |                                                               |
| FACT | reactions (bit 2)        |   114 | done   | modifier and combat reaction to each faction                  |
| FACT | crimeCounts (bit 31)     |     1 | open   | crime counts: the four values' meaning not known              |
| LCTN | keyword data (bit 30)    |   128 | done   | LocationState.keywordData                                     |
| SMQN | bit 31                   |    18 | open   | the story manager nodes' last run                             |
| PARW | moved, havokMoved, cell  |    32 | open   | arrows lying in the world (projectile change forms not taken) |
| PARW | encounterZoneExtra       |     4 | open   |                                                               |
| PMIS | moved                    |     1 | done   |                                                               |
| PMIS | animation                |     1 | open   |                                                               |
| PFLA | moved                    |     1 | done   |                                                               |
| PFLA | animation                |     1 | open   |                                                               |
| PGRE | form flags               |     4 | done   |                                                               |
| PHZD | form flags, moved        |    83 | done   |                                                               |
| PHZD | gameOnlyExtra            |     1 | done   | its ActorCause                                                |

(The sweep lists each flag on its own line; rows here group flags that share a status.)

### Other parts the import lists

| Item                                                                | Status | Why open                                                                    |
| ------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------- |
| The package's branch reached; the package GetCurrentPackage answers | done   | procedurePath; combat override, scene package done                          |
| The procedures' own states, the process's timers and held objects   | open   | where a Travel goes, a Sandbox's activity, a Patrol's point: M13            |
| Papyrus running stacks                                              | done   | resumed at the compiled instruction (by hand: the import no longer logs it) |
| Papyrus messages, waits, registrations other than updates           | done   | LOS and latent functors: none in the saves read, logged if seen             |
| CELL flags 0x40, 0x200                                              | open   | their meaning is not known (TODO(M13))                                      |
| ACHR extra Interaction                                              | open   | a rider and its horse: our save keeps no NPC riding (M13)                   |
| ACHR extra AttachedArrows3D                                         | open   | arrows stuck in a body: not kept by ours either                             |
| ACHR extra DismemberedLimbs                                         | open   | the parser reads past its data; ActorState.dismembered not filled           |
| REFR extra NonActorMagicTarget                                      | open   | magic effects on objects: the parser reads past them                        |
| ACHR item extra CannotWear                                          | open   | an item the actor may not wear: no place in ours                            |

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
| Physics bodies in motion (loose objects knocked about)           | open   | their places kept as saved; velocities not (M13)        |
| The sky's transition between weathers                            | done   | GameSave.sky (SkyWeather save, restore)                 |
| The music playing (audio state)                                  | done   | GameSave.music: script-added types (the track restarts) |
| Combat groups' searches, detection levels                        | open   | the fight starts again                                  |
| Flame sprays, cone waves, a Magelight stuck to a wall            | open   | docs/formats/save.md                                    |
| Thumbnails                                                       | open   | none written                                            |
| Save on Pause, the Load list's character filter                  | open   | docs/formats/save.md "Not saved yet"                    |

## Next biggest open items

1. The procedures' own states inside a branch (where a Travel goes, a Sandbox's activity and
   timers, a Patrol's point) and the high process's timers and held objects, in both saves.
2. The global data tables still open: combat (101: groups, searches) and detection (105) with
   our own save's combat groups' searches; temp effects (1000: decals, shaders, particles);
   process lists (100: no crime in the saves read), quest static data (107) and the interface's
   help shown (102), whose meaning is not known.
3. The graph states (REFR, ACHR, projectiles' animation: 77 forms) against ours, and the
   projectiles' change forms (PARW: arrows lying in the world).
4. The extra data left: a rider and its horse (Interaction; our save keeps no NPC riding
   either), arrows stuck in bodies, cut limbs, magic on objects, CannotWear; the generated
   base's changes after a LeveledCreature (none in the saves read).
5. Our own save's world side: bodies' velocities, casts being charged and shout keys held,
   combat searches, the track within a music type.

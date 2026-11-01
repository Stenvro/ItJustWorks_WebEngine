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

## Count (2026-11-01, round 1)

| Part                          | Items | Done | Open |
| ----------------------------- | ----: | ---: | ---: |
| .ess header                   |     4 |    3 |    1 |
| .ess global data              |    30 |    6 |   24 |
| .ess change forms (flags)     |    68 |   38 |   30 |
| .ess other (by the import)    |     3 |    0 |    3 |
| Own save: runtime fields      |   161 |  151 |   10 |
| Own save: the world (by hand) |    24 |   13 |   11 |
| Total                         |   290 |  211 |   79 |

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
the player on the packages the save has them run (5 of 16: Hadvar on his way to the keep and
Alduin's strafe by their scenes, the wounded in the road; the rest below).

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
| 1001 Papyrus                 | open   | instances, states, update registrations done; the rest below           |
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
| FACT | bit 2                    |   114 | open   | reactions                                                     |
| FACT | bit 31                   |     1 | open   | crime counts                                                  |
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

| Item                                                      | Status | Why open                                                       |
| --------------------------------------------------------- | ------ | -------------------------------------------------------------- |
| The AI process beyond its package                         | open   | the procedures' running states, the high process's timers: M13 |
| Papyrus running stacks                                    | open   | our frames keep their own code positions, not the compiled one |
| Papyrus messages, waits, registrations other than updates | open   | read, not applied                                              |

## Our own save

### Runtime fields (the sweep)

161 fields: 151 done (kept by their class's save method, GameState, SAVED_RUNTIME_FIELDS, a
record or settings cache, or derived or gone within a frame as the sweep's table says), 10 open:

| Field                      | Status | What is lost on a load                         |
| -------------------------- | ------ | ---------------------------------------------- |
| casting-engine#casts       | open   | a cast being charged or held                   |
| casting-engine#shouting    | open   | a shout key held                               |
| casting-engine#lastCast    | open   | the AI's delays between casts                  |
| casting-engine#lesserUsed  | open   | lesser powers' cooldowns                       |
| crime-engine#npcAssaults   | open   | NPC assaults answered (an alarm again)         |
| magic-engine#accumulating  | open   | Accumulate Magnitude effects' growth           |
| magic-engine#did           | open   | an effect's share done at once (its skill use) |
| magic-engine#fadingSummons | open   | summons fading out                             |
| progression-engine#delays  | open   | regeneration delays                            |
| trap-hits#entries          | open   | traps' hit timers by target                    |

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

1. The AI processes beyond the package (1615 actors a save): the procedures' running states,
   so a package resumed goes on in its step; then actors the save has on a package our AI does
   not choose (MQ101's soldiers on DefaultHoldPositionLinkedRef128 choose
   dunCGAlduinBaitStayAtLinkedRef here) and Ralof, saved going into the keep, who runs none.
2. Papyrus stacks, messages and the other registrations (an imported save's scripts in the
   middle of a function).
3. The extra data of references and actors (itemExtraData, encounter zones, gameOnlyExtra,
   leveled actors' bases, baseObject swaps).
4. The global data tables still open: combat, detection, process lists (crimes), audio (music),
   temp effects, quest static data, interface.
5. Our own save's world side: physics bodies in motion, the music, the sky's transition.

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

## Count (2026-11-03, round 10)

| Part                          | Items | Done | Open |
| ----------------------------- | ----: | ---: | ---: |
| .ess header                   |     4 |    4 |    0 |
| .ess global data              |    30 |   30 |    0 |
| .ess change forms (flags)     |    68 |   68 |    0 |
| .ess other (import and hand)  |    11 |   11 |    0 |
| Own save: runtime fields      |   162 |  162 |    0 |
| Own save: the world (by hand) |    30 |   29 |    1 |
| Total                         |   305 |  304 |    1 |

Round 10 settled from the original and built: table 100's number (the next crime's serial,
`GameState.nextCrime`, which our crime ledger numbers from), table 102's list (the tutorials
shown, by their default objects' places: 252 is the journal's) and the help part's last number
(the help message showing: none); graphs saved mid-transition blend on, with their modifiers'
own states and cyclic blends (an import's event-driven modifiers too), and a placed object's
skeletal graph keeps its behavior references; a sandbox's activity goes on after a load; a
bleedout and a paired animation (a killmove, its victim's deferred kill) go on to their end; a
loaded save's actors not placed yet are kept into the next save. Tests: ess-import.test.ts
"apply the controls ..." and "the actors of a loaded save not placed yet",
graph-save-events.int.test.ts "blends on from a transition caught mid-blend",
procedure-runs.test.ts "a sandbox after a load", actor-engine.test.ts "a deferred kill across
a save". The sweep: 264 items, all done (the runtime's deferred kills now saved).

Round 11: actors that left the stage during play keep their place, package and its progress in
later saves and go on through the same path as a loaded save's unplaced actors, and one walking
between load doors goes on from where it was (docs/formats/save.md, "Off the stage"). A lasting
effect saved before its first frame trains by that frame after the load: the sweep had counted
`magic-engine#firstFrame` as a record cache because its type names a promise, so it now tells a
function from a cached record. `magic-engine#objectHits` is transient: its key only names a
visual a view shows once, is in no game state and no save, and a load closes the views, so it
cannot meet one loaded from a save. Tests: tests/sim-save-offstage.int.test.ts,
tests/sim-actors-away-saved.test.ts, tests/sim-save-actor-state.int.test.ts "trains a lasting
effect". The sweep: 266 items, all done.

(Round 8: 305 items, 295 done; round 7: 304 items, 286 done; round 6: 303 items, 277 done; round 5: 299 items, 270 done; round 4: 299, 261; round 3: 297, 245; round 2: 291, 224; round 1: 290, 211. The
sweep itself prints 266 items: the ".ess other" part lists only what the import still logs, so
its items done are kept by hand below. Round 4 split the AI process's item in two (the
procedures' states, done; the high process's timers, open) and added NPCs riding to the world
part. Round 6: the runtime's new field (magic-engine#appearing, transient), the world part's
decals and animation objects, and its combat searches and detection levels split in two.)

Round 9 settled from the original and built: the high process's part (its countdowns, its
fade, the six head track targets by kind: the script's look-at applied, the rest asked every
frame by their systems), the cell flags' word (Warn To Leave: the owner warns an intruder off,
ours off limits; Hand Changed: nothing reads it), the character id the original writes into
every save's file name (the Load list groups by it; the race menu's naming rule), and the
created objects built again through the crafting engine. Tests: ess-import.test.ts "keep the
created objects, a cell's Warn To Leave and the file name's character", character-id.test.ts,
save-list.test.ts "tells characters apart by their id".

Round 8 read every global data table's meaning from the original (docs/formats/ess.md "Global
data", "What the tables hold") and applied what maps onto the runtime: the worldspaces' sky
cells (8: a reference in one is placed in its worldspace), the dead actors' last seen hours
(105: `GameState.deathHours`, which respawns and cleared locations count from), the activation
switched off and the camera switch's locks (110), the journal tabs (102) and the beast form
(113) as the runtime's `controls` and `beastForm`; 104, 106 (the aliases' reservations,
counted again), 108 (dropped by the original) and 1003 (Slow Time's rates, from the effect)
need nothing more. It split the world part's last row and built Save on Pause (the original
autosaves as the tween menu opens, within its health limit). Test: ess-import.test.ts "the
global data tables of controls, references and sky cells".

Round 7 added the world part's projectiles' graphs (done) and built down:

- Combat searches kept (src/ai/combat-search.ts `SavedCombatSearch`, src/ai/combat-groups.ts
  `SavedGroupTarget`, `SavedActor.fight`): a fighting actor keeps what its group knew of its
  target (stealth points, known or lost, where and when last known, detected, attacked from,
  heard, as seconds before the save) and its search (its place, step, seconds into it, looks,
  radius, the wander point); a loaded searcher goes on searching from there (no CombatToLost
  again, its time searched counting on to fDetectionStateExpireTime). The .ess's combat groups
  are read by what they hold (UESP's "members" are the group's targets, its "targets" the
  members: Alduin's group at Helgen holds the player and eleven soldiers as targets, Alduin as
  its one member); a group's search goes on with its members' fights and what the group knew (`essGroupFights`; its knowledge alone, put back, took two of Helgen's fighters off their saved packages: TODO(M13)). Tests:
  combat-search.test.ts, combat-groups.test.ts, ess-import.test.ts.
- Flame sprays, cone waves sweeping out and Magelights stuck where they struck kept by our save
  (`SavedProjectile.kind`: a spray's origin and seconds, a wave's apex, front and those it
  reached, a stuck light's seconds left), each with its model's graph (`SavedProjectile.graph`;
  85 of the 247 projectiles' models have one: `node tools/projectile-graphs.ts`). The .ess's
  missiles and flame sprays in flight (PMIS, PFLA) fly on (the Helgen save's firebolt and
  Alduin's breath) with their graphs by names, instead of standing as references of their
  projectiles. Tests: tests/sim-magic-projectiles-save.test.ts, tests/sim-ess-import.int.test.ts.
- The dead counts by actor base (global data 2: GetDeadCount), SMQN's runs (the game days each
  node last started each of its quests: the story manager's last starts), FACT's crime counts
  (CommonLibSSE's majorCrime, minorCrime and the resist arrest stamp), the ingredients' use
  counts and known effects (INGR, CommonLibSSE's IngredientItem game data; ours keeps
  `GameState.ingredientUses`); the menu topic manager (114) as a conversation's speakers.
- A trap's pushback (ProcessTrapHit) now pushes the actor's character controller as a hit's
  knockback does, by the trap's own pushback (src/gameplay/combat/knockback.ts trapPushback),
  instead of knocking it down.

Round 6 built down:

- A decal store for the world's decals (src/shell/combat-impacts.ts): each decal a hit or a
  spell leaves on the world keeps what it shows, what it lies on and its box in that space and
  its time left; `WorldSave.decals` keeps them and a loaded game builds them again on what they
  lie on. The temp effects (1000) go into it (`essTempDecals`: 38 decals of the Helgen save's 51
  entries, the burns on rubble, roads and the land of three cells; the layout and the land's
  space in docs/formats/ess.md). Tests: src/world/decal.test.ts, src/save/ess-import.test.ts,
  and the Helgen save's simulation keeps all 38 through a save made after the load.
- The anim objects actors hold (1002): `WorldSave.animObjects`, kept by our save and filled by
  the import, loaded and drawn on each actor as it is placed (the cart save's simulation: Hadvar
  holds his ledger and quill again, and a save made then keeps them).
- The music track playing (our save's `musicTrack`: the track and its position go on; the .ess
  table holds no track, docs/formats/ess.md), the loose objects' motion (`motions`), the
  actors' detection (`detection`): src/audio/music.test.ts, src/ai/detection-states.test.ts.

Round 5 built down:

- The animation graphs of the change forms (REFR 26, ACHR 49: docs/formats/ess.md "Animation
  graphs"): each graph's active machines' states, the clips' and sequences' times and every
  variable by name, read in all 77 forms of both saves; the import puts them back by names
  (`NamedGraphState`): an actor's (and the player's body and first person graphs) as its
  behavior files are reached, an object's as its 3D loads, a door without a graph by its
  Open or Close sequence. Checked in the cart save's simulation: over 1,000 words of the placed
  actors' graphs, more than 95% hold the save's values after the load.
- The arrows stuck in bodies (AttachedArrows3D): `WorldSave.attachedArrows`, kept by our save
  and filled by the import (the opening's soldier with three arrows), drawn again on their
  bones as their actors are placed (src/shell/combat-projectiles.ts).
- Tables empty in every save read (5 effects, 112 ingredients shared, 1004 synchronized
  animations): logged only when they hold something; the .ess screenshot (already the import's
  thumbnail) and our saves' thumbnails, which the list had open though they were kept.

Round 4 built down:

- The procedures' own states inside a branch (the process parser keeps each procedure's
  references, places and the procedures it runs inside): a Patrol goes on to the point it stood
  at or walked to (its patrol data's index into its points: `SavedPackage.goal`), an actor
  entering furniture by its SitSleep's Activate sits in it as it loads; the actors' state bytes
  give their weapons drawn (the thirteenth: WEAPON_STATE) beside the life state. A Travel's,
  Escort's and Sandbox's places are their packages' (ours finds them again).
- Global data: combat (101: each group member's fight by its target, for a member whose own
  controller names none; a search logged, none in the saves read) and quest static data (107:
  its fourth list is the 451 quests running, the same as the QUST change forms say).
- The arrows lying in the world (PARW): references of their ammunition where they lie.
- Extra data: a rider and its horse (Interaction: Elenwen beside the carts), the limbs cut off
  (DismemberedLimbs: the beheaded prisoner's head and what it wore), CannotWear on the head a cut
  limb took, NonActorMagicTarget (no effects on the objects of the saves read).
- Our own save: casts being charged or held and voice keys held (the casting engine's saveData),
  NPCs riding horses (`SavedActor.riding`, in the saddle again as both are placed).

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
| Screenshot                                 | done   | the import's thumbnail (essScreenshot)    |
| Plugins                                    | done   | formIdMapper: by name into our load order |
| Light plugins                              | done   | formIdMapper                              |

### Global data

| Table                        | Status | Where / why open                                                       |
| ---------------------------- | ------ | ---------------------------------------------------------------------- |
| 0 Misc Stats                 | done   | the runtime's stats                                                    |
| 1 Player Location            | done   | the player's place when their change form has none                     |
| 2 TES                        | done   | dead counts by base (GetDeadCount); cell table, last list: none read   |
| 3 Global Variables           | done   | GameState globals; GameDaysPassed sets the clock                       |
| 4 Created Objects            | done   | built again by the crafting engine under their ids (none in the saves) |
| 5 Effects                    | done   | image space modifiers running: empty in every save read (else logged)  |
| 6 Weather                    | done   | current, outgoing, override, default; when it came (GameSave.sky)      |
| 7 Audio                      | done   | the music types in play (GameSave.music); the table keeps no track     |
| 8 Sky Cells                  | done   | each worldspace's sky cell: its references placed in the worldspace    |
| 100 Process Lists            | done   | comment, crime check timers; the next crime's number (nextCrime)       |
| 101 Combat                   | done   | members' fights, their groups' knowledge and searches (SavedFight)     |
| 102 Interface                | done   | tutorials shown (252: HBJL), help done, last used, tabs; −2: none      |
| 103 Actor Causes             | done   | the actor each ActorCause extra blames                                 |
| 104 Unknown                  | done   | the original writes no entry and its load reads none                   |
| 105 Detection Manager        | done   | dead, disabled, last seen hour: dead actors' hours into deathHours     |
| 106 Location MetaData        | done   | reserving aliases per reference: counted again by the alias fill       |
| 107 Quest Static Data        | done   | the quests running (QUST change forms); 3 lists empty: TODO(M13)       |
| 108 StoryTeller              | done   | a byte the original's load reads and drops                             |
| 109 Magic Favorites          | done   | GameState favorites and hotkeys                                        |
| 110 PlayerControls           | done   | keys held, camera switch locks, activation off: controls applied       |
| 111 Story Event Manager      | done   | the events waiting, told again after the load                          |
| 112 Ingredient Shared        | done   | the ingredients' known effects: empty in every save read (else logged) |
| 113 MenuControls             | done   | tween and favorites keys on (1; off logged), beast form applied        |
| 114 MenuTopicManager         | done   | a conversation's speakers: none in every save read (else logged)       |
| 1000 Temp Effects            | done   | the world's decals into the decal store (WorldSave.decals)             |
| 1001 Papyrus                 | done   | instances, stacks, messages, waits, suspended calls, registrations     |
| 1002 Anim Objects            | done   | WorldSave.animObjects: loaded and drawn as each actor is placed        |
| 1003 Timer                   | done   | Slow Time's rates: from the effect on the player (0 in both saves)     |
| 1004 Synchronized Animations | done   | paired animations under way: empty in every save read (else logged)    |
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
| REFR | itemExtraData            |   178 | done   | the item reference's holder (ReferenceState.container)        |
| REFR | animation                |    26 | done   | by names (SavedGraph.named); a door's Open or Close           |
| REFR | encounterZoneExtra       |   367 | done   | ReferenceState.encounterZone                                  |
| REFR | gameOnlyExtra            |  1467 | done   | NonActorMagicTarget: no effects on the 3 objects              |
| REFR | baseObject               |    30 | done   | ReferenceState.base (baseOf)                                  |
| ACHR | form flags               |   286 | done   | enabled, deleted                                              |
| ACHR | moved, havokMoved, cell  |  2755 | done   | its place (and its package and fight there)                   |
| ACHR | promoted, scale          |  2088 | done   |                                                               |
| ACHR | inventory, leveledInv.   |  1254 | done   |                                                               |
| ACHR | lifeState                |    16 | done   | dead, unconscious, restrained                                 |
| ACHR | packageExtraData         |    67 | done   | the package's start; Follower (no data)                       |
| ACHR | dismemberedLimbs         |     1 | done   | ActorState.dismembered: the limb and what it wore             |
| ACHR | leveledActor             |  2784 | done   | ActorState.leveledBase: the pick kept                         |
| ACHR | animation                |    49 | done   | by names (ActorGraphState.named), the player's two graphs     |
| ACHR | encounterZoneExtra       |   516 | done   |                                                               |
| ACHR | gameOnlyExtra            |  1472 | done   | AttachedArrows3D: WorldSave.attachedArrows                    |
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
| CELL | flags (bit 1)            |   225 | done   | public (0x20), Warn To Leave (0x200: off limits), 0x40 kept   |
| CELL | exterior bits 29, 30     |   128 | done   | detach time: cellDetached (whole game hours)                  |
| CELL | seen data (bit 31)       |    30 | done   | GameState.seen (seenFromSave); no exterior fog drawn: M13     |
| INFO | said (bit 31)            |   179 | done   | Say Once marks                                                |
| SCEN | running state (bit 31)   |    20 | done   | phase, cast, actions                                          |
| FLST | added forms (bit 31)     |    50 | done   | the forms scripts added                                       |
| LVLI | added (bit 31)           |   100 | done   | leveled list additions                                        |
| LVLN | added (bit 31)           |     2 | done   |                                                               |
| FACT | reactions (bit 2)        |   114 | done   | modifier and combat reaction to each faction                  |
| FACT | crimeCounts (bit 31)     |     1 | done   | majorCrime, minorCrime kept; resist arrest stamp (M13: users) |
| LCTN | keyword data (bit 30)    |   128 | done   | LocationState.keywordData                                     |
| SMQN | bit 31                   |    18 | done   | each quest's last start (game days): the story manager's      |
| PARW | moved, havokMoved, cell  |    32 | done   | arrows lying in the world: references of their ammunition     |
| PARW | encounterZoneExtra       |     4 | done   |                                                               |
| PMIS | moved                    |     1 | done   |                                                               |
| PMIS | animation                |     1 | done   | the missile flies on, its graph by names (SavedProjectile)    |
| PFLA | moved                    |     1 | done   |                                                               |
| PFLA | animation                |     1 | done   | the spray flies on, its stream's graph by names               |
| PGRE | form flags               |     4 | done   |                                                               |
| PHZD | form flags, moved        |    83 | done   |                                                               |
| PHZD | gameOnlyExtra            |     1 | done   | its ActorCause                                                |

(The sweep lists each flag on its own line; rows here group flags that share a status.)

### Other parts the import lists

| Item                                                                | Status | Why open                                                                    |
| ------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------- |
| The package's branch reached; the package GetCurrentPackage answers | done   | procedurePath; combat override, scene package done                          |
| The procedures' own states inside the branch                        | done   | a Patrol's point, furniture being entered; Travel, Sandbox: their packages' |
| The high process's timers and six held objects                      | done   | head track targets by kind: the script's applied; countdowns restart        |
| Papyrus running stacks                                              | done   | resumed at the compiled instruction (by hand: the import no longer logs it) |
| Papyrus messages, waits, registrations other than updates           | done   | LOS and latent functors: none in the saves read, logged if seen             |
| CELL flags 0x40, 0x200                                              | done   | Warn To Leave: off limits; Hand Changed: no reader in the original          |
| ACHR extra Interaction                                              | done   | SavedActor.riding (both saves' riders)                                      |
| ACHR extra AttachedArrows3D                                         | done   | WorldSave.attachedArrows (drawn again on their bones)                       |
| ACHR extra DismemberedLimbs                                         | done   | ActorState.dismembered                                                      |
| REFR extra NonActorMagicTarget                                      | done   | no effects on the objects read (TODO(M13): the effects' data)               |
| ACHR item extra CannotWear                                          | done   | the head a cut limb took (follows from DismemberedLimbs)                    |

## Our own save

### Runtime fields (the sweep)

161 fields: all done (kept by their class's save method, GameState, SAVED_RUNTIME_FIELDS, a
record or settings cache, or derived or gone within a frame as the sweep's table says).
Round 2 gave the casting, progression, crime, magic engines and the traps' hits saveData and
loadData (RuntimeSave.engines; src/scripting/runtime/engine-save.test.ts):

| Field                      | Status | What is lost on a load                        |
| -------------------------- | ------ | --------------------------------------------- |
| casting-engine#casts       | done   | a cast being charged or held (SavedCast)      |
| casting-engine#shouting    | done   | a voice key held (seconds held)               |
| casting-engine#lastCast    | done   | the AI's delays between casts (seconds ago)   |
| casting-engine#lesserUsed  | done   | lesser powers' cooldowns (seconds ago)        |
| crime-engine#npcAssaults   | done   | NPC assaults answered                         |
| magic-engine#accumulating  | done   | by the effect's key                           |
| magic-engine#did           | done   | by the effect's key                           |
| magic-engine#fadingSummons | done   | seconds left                                  |
| magic-engine#firstFrame    | done   | the effects' keys: their training waits still |
| magic-engine#objectHits    | done   | transient: names a visual, in no save         |
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
| NPCs riding horses                                               | done   | SavedActor.riding (src/shell/actor-mounts.ts rideAgain) |
| Quests, aliases, scenes, dialogue memory, story manager          | done   | RuntimeSave                                             |
| Papyrus: instances, threads' frames, update registrations        | done   | RuntimeSave threads, updates, registrations             |
| Translations, hazards, projectiles in flight                     | done   | RuntimeSave translations, GameSave hazards, projectiles |
| Time, weather, the player's stats, perks, effects, bounty, map   | done   | GameState, the sky's current weather                    |
| Crime (bounties, stolen items, jail), factions                   | done   | GameState                                               |
| The player's camera, sneaking, weapon, vehicle                   | done   | SavedPlayer                                             |
| Actors in cells not loaded as the game is saved                  | done   | SavedActor.offStage, WorldSave.trips                    |
| A procedure's progress inside a step (a sandbox's activity)      | done   | SavedPackage.step (ProcedureRun.setStep)                |
| Graph transitions' blends, modifiers' states, behavior refs      | done   | SavedGraphFile transitions, modifiers, cyclic           |
| Projectiles' graphs (in flight, sprays' streams, stuck lights)   | done   | SavedProjectile.graph                                   |
| Bleedout and paired animations' engine side                      | done   | SavedActor.down, deferred kills (engines)               |
| Physics bodies in motion (loose objects knocked about)           | done   | WorldSave.motions, given back as each body settles      |
| The sky's transition between weathers                            | done   | GameSave.sky (SkyWeather save, restore)                 |
| The music playing (audio state)                                  | done   | GameSave.music, musicTrack: the track and its position  |
| Combat groups' searches                                          | done   | SavedActor.fight (the group's knowledge, the search)    |
| Detection levels, alerts, alarms, attacks                        | done   | WorldSave.detection (Detections.save, load)             |
| Decals on the world (blood, scorches, burns)                     | done   | WorldSave.decals (the decal store)                      |
| Animation objects actors hold                                    | done   | WorldSave.animObjects                                   |
| Flame sprays, cone waves, a Magelight stuck to a wall            | done   | SavedProjectile.kind                                    |
| Thumbnails                                                       | done   | save-screenshot.ts takeScreenshot                       |
| Save on Pause (autosave as the tween menu opens)                 | done   | src/shell/save-manager.ts (the reason `pause`)          |
| The Load list's character filter                                 | done   | src/save/character-id.ts (the id, the naming rule)      |

## Next biggest open items

1. Actors off the stage: what the kept records leave out is inferred (TODO(M13): the graph, the
   fight and a paired animation are not kept, a script's move ends a package's progress, the 512
   that left last), and what an actor would have done in the time since it left is not played
   out while its package stays the one saved.
2. The import's side of round 10's own-save work: the .ess Sandbox state's activity times, an
   actor's bleedout (its life state's dying, its bleedout seconds) and a paired animation
   (global data 1004, empty in the saves read), the help part's waiting messages into the HUD
   (none in the saves read; ours does not save them yet) (TODO(M13)).
3. Tutorials of a save written by an earlier runtime (1.5: numbered one lower).
4. The decals' details the .ess leaves unsettled: their age (none written: a whole lifetime from
   the load), the land entries' u32 (it differs between an entry's copies, one per shape it was
   made on), float1 and the second texture set (none in the saves read) (TODO(M13)).
5. What sets the cells' Hand Changed (0x40) at run time; the character's "modded" key.

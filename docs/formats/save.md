# Savegames (our own format)

The engine's own save format (M12). Import of the original `.ess` saves: docs/formats/ess.md. Code:
`src/save/save-codec.ts` (the container), `src/save/game-save.ts` (what a save holds),
`src/scripting/runtime/runtime-save.ts` and `ScriptRuntime.saveData` / `loadGame` (the scripts'
side), `PapyrusVm.savedInstances` / `restoreInstances` (script variables), `src/save/save-store.ts`
(IndexedDB), `src/shell/save-manager.ts` (names, autosaves) and `src/shell/play-mode.ts` (loading).

## The file

Little-endian:

| Offset | Size | What                                                                |
| ------ | ---- | ------------------------------------------------------------------- |
| 0      | 4    | `IJWS`                                                              |
| 4      | 4    | version (1)                                                         |
| 8      | 4    | header length _h_                                                   |
| 12     | _h_  | header: UTF-8 JSON (`SaveHeader`)                                   |
| 12+_h_ | 4    | thumbnail length _t_ (0 for none)                                   |
| …      | _t_  | thumbnail (a JPEG; none written yet: TODO(M13))                     |
| …      | rest | body: tagged JSON, raw deflate (`CompressionStream('deflate-raw')`) |

The header is readable without inflating the body (the save list reads only headers): name,
kind (`save`, `quicksave`, `autosave`), number, the player's name and level, the location's
name, game days passed, the real time it was made, and the plugins in load order (a load warns
about a missing one).

Tagged JSON keeps what JSON loses. An object with one of these keys is a tagged value:

| Tag  | Value                                                               |
| ---- | ------------------------------------------------------------------- |
| `$u` | `undefined`                                                         |
| `$n` | a number that is not finite (`"NaN"`, `"Infinity"`, `"-Infinity"`)  |
| `$b` | a bigint (decimal)                                                  |
| `$m` | a Map: `[[key, value], …]`                                          |
| `$s` | a Set: `[value, …]`                                                 |
| `$t` | a typed array: `{ $t: "u8" \| "f32" \| …, d: base64 of its bytes }` |
| `$h` | a Papyrus object handle: `[formId, type, alias]`                    |
| `$a` | a Papyrus array: `[value, …]`, with its number `$i`                 |
| `$r` | the Papyrus array numbered so before (the same array again)         |
| `$o` | a plain object whose own keys start with `$` (wrapped)              |

Any other class instance is refused while saving (state the save would lose silently). Papyrus
arrays keep their identity, as in the original's save: each array is written once with a number
(in the order the body is written) and after that as `{ $r: number }`, so two variables that held
one array hold one array after a load. (Arrays are passed and assigned by reference in the VM
too: a function that fills an array it was given fills its caller's.)

## The body

`GameSave`: `runtime` (below), `player` (position, rotation, cell or worldspace, scale: as
`ScriptRuntime.placement` gives it), `weather` (the sky's current weather), `sky` (the sky's
`SkySave`, src/world/sky-weather.ts: the current and outgoing weathers, the override and the
default, when the current came, an accelerated change's start: the change under way goes on
after the load, and the weather stands in the region the player is in rather than a new pick),
`music` (the music types scripts added, MusicType.Add, still in play: added again as it loads;
the location's type and the fights' follow from the world), `musicTrack` (`SavedMusicTrack`,
src/audio/music.ts: the type playing, its track, MUST, the seconds into it and the tracks left
in its pass: as that type next plays, within 10 seconds of the load, the track goes on from
there, then the rest of the pass), `unsaved` (what could not be saved,
logged again as it loads), `world` (the loaded world beside the scripts, below) and, from an
imported .ess, `inventoryDeltas` and `worn` (what actors wear beside their outfits, put on after
the deltas). As a save is made, the loaded cells' objects that physics moved note where they
are (moved-objects.ts, as a cell leaving the loaded area does), so they load where they were.

`WorldSave` (`src/save/world-save.ts`), the minimal state each system rebuilds itself from as
the world loads again, as the original's change forms hold it (nothing of the rendering):

- `actors`: every actor on the stage: its loaded cell (as the view keys it), feet and heading;
  the furniture it is in (sitting, sleeping, leaning: not one it walks to); its package
  (`SavedPackage`: which, completed and ended, where it began, the branch it ran as each
  branch's index among its parent's children, its Finds' results, the once-a-day packages' days,
  whether it ended and the actor sandboxed where it stood, its fallout: it does so again after the
  load, where before it stood done and could take its tree again from the root);
  its combat target and the confidence modifier its fight drew; whether a script set it sneaking
  (StartSneaking) and whether its weapon was out (below, "What actors keep"). As its cell loads it is placed there instead of where its package would
  put it, in its furniture at once; when its AI starts and chooses the saved package first, the
  package goes on without beginning again (no OnPackageStart, no begin fragment), its sequences
  from the child they had reached (a Simultaneous branch's children run anew); its fight (with that modifier) starts
  again once it and its target are on the stage. With its fight (`SavedFight`) it keeps what its
  combat group knew of the target (`SavedGroupTarget`, src/ai/combat-groups.ts: the stealth
  points, known or lost, where and when it was last known, detected, attacked from and heard,
  the times as seconds before the save; whether the group searched) and the search it made for
  it (`SavedCombatSearch`, src/ai/combat-search.ts: the place, its step (the wait, the run or
  walk, a look, a wander), the seconds left of a wait or look, the looks made, the seconds
  searched, the radius drawn and the wander point): as its fight is taken up again its group
  knows the target as it did and a searcher searches on from there (a walk under way is walked
  again from where it stands; no CombatToLost said again; it gives up once it has searched
  fDetectionStateExpireTime in all, counted from the search's start). The members' own
  detection levels are not kept: each one's next detection test tells its own. Saved actors whose cell goes before it is
  placed come back where their packages have them.
- `graphs`: the loaded objects whose graphs moved from their start (an event sent, a variable
  set): the sequences' graph (each active state machine's state in the order reached from the
  root, the variables scripts set) and the skeletal graph (each state machine's state by its
  place among the graph's machines, its variables), with how long each active sequence has
  played (`times`). As the object is placed again its graph starts there: a sequence goes on from
  its time, sending only the text keys ahead of it (the word of power saved as it plays still sends
  the "End" its script waits for; one long done is held at its end: a lever pulled stays down
  before its script's OnLoad). Saves without `times` hold them all at their ends. TODO(M13):
  machines inside behavior
  references. An imported .ess's objects keep theirs by names in `GameState.graphs`
  (`SavedGraph.named`, below "Animation graphs"), taken as their 3D loads.
- `attachedArrows` (`SavedAttachedArrow`): the arrows stuck in actors' bodies (the original's
  ExtraAttachedArrows3D), oldest first: the actor, the PROJ, the bone (its index in the actor's
  skeleton), its place on the bone (a 4x4 matrix) and the seconds it has been stuck. As the
  game loads each waits for its actor's body and is drawn on its bone for what is left of
  fAttachedArrowAgeMax (src/shell/combat-projectiles.ts); one already older is not.
- `decals` (`SavedDecal`): the world's decal store (src/shell/combat-impacts.ts; the original's
  temp effects): each decal a hit or a spell left on the world, its texture set and the impact
  it was made with, what it lies on (a reference and the node whose shapes take it, the land in
  world space, an imported save's cell land, or nothing known: projected), its clipping box in
  that space (so it stays on a reference that moved), its atlas quarter, the face limit of its
  impact's angle threshold and the seconds it has left. As the game loads each waits for what it
  lies on to be drawn and is built on its shapes again (forced: no spacing, no per-frame cap)
  for the time it had left; one whose time ran out goes. Taken by the view showing the world
  (a view without drawn shapes, the headless one, keeps them waiting and saves them again).
- `animObjects` (`SavedAnimObject`): the animation objects actors hold (the original's global
  data 1002): the actor, its ANIO, whether it is shown. As each actor is placed they are loaded
  on it and drawn (src/shell/actor-anim-objects.ts), since a graph put back by names raises no
  AnimObjLoad again; those of actors not yet placed are kept by a save made meanwhile.
- `motions` (`SavedMotion`): the loose objects in motion (an awake simulated body faster than
  1 unit or 0.05 radians a second): their velocity, given back as each body settles after the
  load (src/shell/play-session.ts), so one falling as the game is saved falls on.
- `detection` (`DetectionSave`, src/ai/detection-states.ts): what each actor knew of the others
  (noticed, searching, detected, with the level, when and where it last knew), who is alerted,
  alarmed, attacked and the lasting offences, as seconds before or after the save: put back as
  the senses' first frame runs, nothing told again.

`RuntimeSave.scenes` (`SceneDirector.saveData`): each playing scene's phase, cast, clock and
actions (status, done, a timer's seconds left), and the starts waiting for their actors or not
begun yet (Scene.Start marks a scene active; it begins in the scene system's next update: a save
taken between keeps it as a start, and the loaded game begins it). On load
a scene plays on in its phase (IsPlaying is true at once): its begin and that phase's start
fragments do not run again, its actions not done start again (a line is said again, a package
action gives its package again, a timer runs on), those done that still run keep their looks.

A dialogue action keeps what the original's keeps of it (observed in the original): whether it
runs, whether it is done, and a looping one's seconds before it speaks again. Not kept: that its
line is being said. So a line in progress as the game is saved is said again from its start
once the loaded scene goes on (a looping one said already, after what was left of its wait).
Its speaker's graph is kept (below, "Animation graphs"): one saved in the line's dialogue idle
stands in it from the load, and the line said again plays its idle again. Such an idle ends as
it does in play: the actor's next path stops it at once where its graph set bForceIdleStop (the
dialogue idles do), else its AI's IdleStop as it sets out (src/shell/actor-movers.ts).
TODO(M13): whether the line's end itself ends a looping dialogue idle (here it does not).
MQ101's Ralof, saved in his line's idle up at the block, stands in it until the line said again
is over and his scene's next phase sends him to the tower, as he does in a game not saved there.

After a load the scripts hear OnPlayerLoadGame (the player and its aliases). TODO(M13): the
original sends it once the loaded world is up; here as the scripts are ready, before the
player's cell loads.

`RuntimeSave`:

- `state`: every field of `GameState` (`src/scripting/runtime/game-state.ts`) by name. That is
  the player's and every actor's actor values, skills and experience, perks, spells and shouts,
  level, inventory and item stacks, equipment, race and looks, name; the clock and globals;
  quests (stages, objectives, aliases, log, story manager event); per-reference changes (moved,
  enabled, deleted, taken, destroyed, open, locked, owners, harvested, links, created
  references and created forms); actors' deaths and states; factions and crime (bounties,
  stolen items, jail, favor); locations (cleared) and the cell reset clocks (`cellVisits`,
  `cellDetached`, `zoneTimes`, `deathHours`); relationships, the local maps' fog, the map
  marker, favorites and hotkeys, books read, tutorials, active magic effects, the
  ingredients' known effects and use counts (`ingredientUses`), the dead counts by actor base,
  the factions' crime counts.
- `clocks`, `startDate`, `startDays`: the scheduler's real, game and wall clocks and the
  calendar's start.
- `fields`: the runtime's switches (`SAVED_RUNTIME_FIELDS`: controls, chargen, fast travel,
  beast form, time scale, perk points, last horse, god mode and the console's switches);
  `stats`, `wordsLearned`, `iniOverrides`.
- Registrations: update registrations (RegisterForUpdate, SingleUpdate and their GameTime
  forms) with the seconds or hours left until they fire, re-armed as they were on load;
  animation events, sleep and tracked stats, line of sight, inventory filters, form lists'
  additions, map markers (visible, travel).
- `initialized`: references whose scripts had their OnInit (none runs again on load);
  `seeded`: containers whose inventories were filled from their records.
- `dialogue` (infos said once, topics chosen, topics' infos said before repeating) and
  `storyManager` (when quests were last started, what each node started, and the events told
  and not yet processed: told again once the game has loaded, as the original saves its queue).
- `instances`: every script instance (quests, aliases, references, active magic effects): its
  object, script, state and variables per script level.

Beside the runtime's data the body keeps `hazards` (src/scripting/runtime/hazard-engine.ts
SavedHazard: each hazard standing, its HAZD, source, age, lifetime, seconds to its next hits and
radius; its reference comes back with the game's created references and the hazard engine tracks
it again as the save loads) and, in `world`, `projectiles` (src/save/world-save.ts
SavedProjectile: each projectile in flight and each lobber at rest, a rune waiting for its
trigger: its PROJ, the magic item it carries with its caster, how it was cast and dual casting,
its position, velocity, the units flown, its age and whether it rests). They fly on as the loaded
world's physics attaches (MagicProjectiles.restore). Beside missiles, lobbers and bolts it keeps
(`kind`) a flame's sprays (where each left the hand and the concentration seconds it carries:
its stream shows it there again, and the cast held, src/scripting/runtime/casting-engine.ts,
sprays on), a cone's wave sweeping out (its apex, direction, how far its front has come and
whom it reached: it sweeps on from there, not reaching them again, its look shown for the rest
of its way) and a Magelight stuck where it struck (its seconds left: its model and light stay
there that long). Each keeps its model's behavior graph (`graph`: most projectile models have
one, tools/projectile-graphs.ts; a spray's is its stream's) by its machines' states, put back as
its model loads; an imported .ess's by names.

## Loading

The world is rebuilt from the plugins as for a new game, except that no quest starts and no
OnInit runs: the quests' records are read, the save's state is put into the fresh `GameState`
(Maps and Sets filled in place), the quests' aliases hold their references again (the
runtime's index of the aliases holding each reference, from which an alias script hears its
reference's events, OnDeath among them, and by which aliases give their packages, factions and
names; and the reservations of the aliases that reserve what they hold: nothing of either is in
the save, both follow from the quests' alias fills), the script instances are made as the plugins attach them and
take the save's variables and states (their property setters do not run again), the update
registrations are re-armed, and the player's lasting effects are prepared. Play then loads the
player's cell or worldspace behind the loading screen (as a new game does) and puts back the
sky and the music (`restoreAmbience`; a save of before kept the weather alone, which comes at
once). What could not be matched (a script no longer attached, a variable gone, a missing
plugin) is logged under `save`.

## Papyrus threads

As the original, a save holds each waiting thread's frame stack (`RuntimeSave.threads`,
`SavedThread` in `src/scripting/papyrus-vm.ts`). The VM keeps every call frame as data: per
frame the function (its script, state and name, or a property's Get/Set; its instruction count,
so a changed script is not resumed), the pc, the locals (temps included), self, the script
instance (attached or a native type's) and the call depth. The thread keeps its origin (the
event sent to one instance, or the engine's call, with its arguments), whether it is an OnInit,
and its wait:

- `clock`: in `Utility.Wait`, `WaitGameTime` or `WaitMenuMode` (the clock and the reading it
  waits for; the clocks themselves are saved). The natives hand the VM the wait as data
  (`NativeCall.latent(promise, clock)`).
- `restart`: the innermost frame's instruction at pc has not begun and runs again: a thread past
  the frame's budget, waiting for a lock or another script's OnInit before a call or property,
  or for the next frame before a native handed to the main thread. With no frames, the origin
  starts again (a thread waiting to begin).

On load the frames are rebuilt and run on from the innermost: its wait first, then each caller
takes its callee's result at its call instruction (the destination of `callmethod`,
`callstatic`, `callparent`, `propget`) and goes on after it. A resumed OnInit holds its
instance's other events again. What cannot be resumed (a script, function or instance gone) is
logged under `save`.

A thread in a native whose JavaScript promise is in flight (Quest.Start, SetStage, a story event,
an animation event, a latent native waiting on the world) is saved at its call instruction and
calls the native again as it loads. Observed in the original: a call handed to the main thread
and not yet made is saved with its suspended stack and made on load, as ours; a latent native's
queued work is saved and finishes after the load without calling the native again (ours keeps a
clock wait as data that way; TODO(M13): the other latent natives' work queued apart,
docs/scripting.md "Threads").

Not held (logged as not saved, by where they are): a thread between a callee's return and its
caller taking the result, or in the full properties' Set functions before an OnInit
(TODO(M13)).

## Translations

TranslateTo's translations in progress (`RuntimeSave.translations`): the reference, where to,
the seconds the whole way takes, the share after which it is almost complete
(fRefTranslationAlmostDonePercent) and the seconds gone. After a load each goes on from there:
its almost-complete event if not yet told, then its end.

## The engines' timers

`RuntimeSave.engines` (each engine's saveData, put back by its loadData after the game state):
the casting engine's last casts by "actor:item" (the AI's delays between casts) and lesser
powers' last uses (their cooldowns), as seconds before the save on its own clock; the
regeneration delays by "reference:vital" (seconds left); the NPC assaults already answered
("attacker:victim", no alarm again); the traps' contacts by target and trap, with their last
telling on the game's real time and the touch; by active effect key, an Accumulate Magnitude
effect's rate and hold and the share of a value effect done at once; the summons fading out
(seconds left); the casts going on (`SavedCast`: the actor, the hand or source, dual, its
phase and the seconds since it began: its item is read again and its hand goes on where it
was, ready after the rest of its charge, nothing paid or told again) and the voice keys held
(the actor and the seconds held, which go on counting).

## World state kept while unloaded

GameState's own fields hold, and so save, what the world keeps of references that are not
loaded: `graphs` (the animated state an object's graph had as its 3D unloaded: a chest's lid
open, a lever pulled), the partial souls of soul gems (`itemStacks`' `soul`, the game's
ExtraSoul), and the corpses' ragdoll poses (`ActorState.corpse`, src/animation/corpse-pose.ts:
the nodes its ragdoll placed, in the world, and whether it lay at rest; kept as the corpse's
cell unloads and as the game is saved, before the state is written: the save's state holds the
live maps). A corpse lies again where it lay.

## Off the stage

An actor that leaves the stage with its cell or its view (the player goes through a door) keeps
what a save holds of a placed actor, as the original keeps the process of an actor that is not
loaded: `SavedActor` with `offStage` and `space`, held by the session while the game runs
(`GameSession.offStage`, `OffStageActors` in src/save/world-save.ts), written by each later save
and given back through the path a loaded save's unplaced actors have (`WorldRestore`). Only a save
reads the records: an actor that comes back during play is placed by its package and the game state
as before. Placed again, its record is gone.

- Bound: none for one dead, disabled or on a vehicle, or one with no package progress that stands
  within 16 units of where the game state has it (nothing the game state does not hold); no graph
  (made anew as its 3D is; furniture, sneaking and a drawn weapon rebuild it), no fight, no paired
  animation; and the 512 that left last (`OFF_STAGE_KEPT`). TODO(M13): inferred, the original's
  rule for what an actor loses as its 3D unloads is not known.
- A record is dropped at the next save once the game state's place for the actor has changed since
  it left (a script's move, the low process through a door), or it died or left the world. An
  actor a script moves off the stage while it leaves keeps no record (TODO(M13): inferred, whether
  the original's MoveTo keeps a package's progress). After a load, a script's move to a place not
  loaded drops the save's record as well: the record must not win over the move.
- `space`: an exterior's cell key names the grid cell alone, and a walled city's worldspace has the
  same keys as the world around it. An actor is placed only by a view of its own space.
- After a load the low process leaves an off-stage actor where the save has it while its package is
  the one saved and keeps it about a place; time passing changes nothing else until its cell loads
  (as for a loaded save's unplaced actors). A package that takes it somewhere (`elsewhere`, Travel,
  Follow, Escort), another package, or a scene's restart hands it to the low process at once, from
  the saved place, or a scene would wait for good on an actor whose cell never loads. A saved actor
  of the loaded area is unchanged: it still waits for its cell, a restart on it as it is placed.
- `WorldSave.trips` (`SavedTrip`): an actor walking between load doors (src/shell/actors-away.ts)
  is saved where it is along its way, with its destination, package and speed; a flier also as a
  flier. Its road is planned again from there as the first frame runs, not kept (long, and the doors
  it may pass can change), and the first schedule run for the player's space does not end it: a load
  passes no time. As during play, a trip keeps its package's id alone, not its progress.

Test: tests/sim-save-offstage.int.test.ts, tests/sim-actors-away-saved.test.ts.

## What actors keep

The original saves with each actor (observed in the original) its actor state (the movement
bits with sneaking, sitting and sleeping, flying, life, knock and attack states; head tracking on
or off, the weapon's state, forced running and sneaking), its flags (among them the stealth eye's
"do not show", attack on sight, no bleedout recovery, favors, bribed) and, while it has one, its
process: the middle process's alpha among much else, the high process's head track target of
each kind. Ours:

- Kept in the game state (`ActorState`), so they hold as cells unload too: SetAlpha's alpha
  (`alpha`; the stage draws it as a veil, reached over fActorAlphaFadeSeconds when asked to fade,
  at once as an actor is placed), SetHeadTracking (`headTrackingOff`), SetLookAt and ClearLookAt
  (`lookAt`: the script kind of head track target; the others, dialogue, combat and procedure,
  are asked again by the systems that hold them as those go on after the load),
  SetNotShowOnStealthMeter (`hiddenOnStealthMeter`), and as before ghost, restrained, don't move,
  AI enabled, alerted, unconscious, attack on sight, vehicle; a reference's activation blocked and
  motion type. As a save loads, the head tracking and look targets are told to the world again
  (`loadGameScripts`).
- Kept with the loaded actors (`SavedActor`): `sneaking` (StartSneaking: it sneaks again while
  the package it was set in, resumed, runs) and `weaponDrawn` (its weapon out, as DrawWeapon
  leaves it outside a fight, or in one): its graph is put back with the weapon out (below,
  "Animation graphs"), so it is out at once, in its hand, without drawing again. A save made
  before graphs were kept draws it again as it is loaded.
- The player's (`WorldSave.player`, `SavedPlayer`): sneaking, the weapon out, getting out of
  their vehicle; with their graphs, as an NPC's. The camera: first or third person and the
  world's and first person's fields of view (the original's player camera keeps both). The
  furniture they sit, sleep or lean in (`furniture`): as their body is there they are in it
  again at once, at its marker, their graph (put back seated) not told to enter it again, and a
  movement key gets them up as before. Before, the loaded player's graph sat while nothing held
  them in the seat. TODO(M13): the camera they had before the furniture forced one is not kept
  (they stand with the forced one).
- `flying` (a flier in the air: cruising, hovering, landing): as it loads it is not set on the
  ground but stays where it was saved, and its flight, finding it high above the ground, has it
  cruise on from there (before, MQ104's dragon circling the Western Watchtower came down at
  once and took off again).
- Not kept, as in the original: SetExpressionOverride's expression (the face's animation data
  belongs to its 3D, which the save does not hold; neither the actor's nor its process's save
  writes it).

A procedure's step after a load goes on: a patrol's, to the point it went to
(`SavedPackage.goal`, as the original's patrol package data holds it; before, the opening's
horses turned back to their patrols' first points); a sandbox's, with its activity
(`SavedPackage.step`, `SavedStep`, ProcedureRun.setStep: its kind, the furniture or idle marker
it uses, the game hour it began and its hours, and the plan's counts of what it did least
lately): seated, at its marker, wandering or eating, until its hours from when it began, as the
original's sandbox keeps its activity and times in the save (before, it chose again, a new stay
of a new length). Test: procedure-runs.test.ts "a sandbox after a load". TODO(M13): an imported
.ess's sandbox activity (its times are among the Sandbox state's values, not read). A Travel to a
reference that moves aims where the reference is as it begins; to end where the original's
continuing travel would, a travel to a moving destination ends within reach of where the
destination is now, not of where its path led: an actor at its path's end whose target moved on
goes on after it (src/shell/actor-movers.ts).

## Vehicles

As the original keeps them with the references (src/shell/actor-vehicles.ts):

- A cart's tether: TetherToHorse puts the horse in the cart's reference state (`horse`). As
  a physics world starts (a loaded game, a view opened again) the vehicles take every kept tether
  up again, the horse not moved (it stands in its shafts), a cart a script keyframed still so.
- A pulled cart's place: its root goes to its reference state (position and rotation) as the
  game is saved and as the view closes, so it is placed there again, still tethered. A persistent
  object stands with the cell it is in now, not the one it was placed in
  (`Worldspace.persistentReferencesNow`): the player's cart, saved on the road, loads although
  the cell where the ride began does not.
- Its riders: the game state keeps each actor's vehicle (SetVehicle); an actor placed on the
  stage, and the player once their play starts, ride it again. A rider's graph (its riding idle
  seats it) goes on in its saved state as it loads, as every actor's does (below, "Animation
  graphs"). A rider part-way out of its vehicle (its exit idle begun, it let go of the vehicle)
  keeps where the vehicle was as it let go and how far its exit's root motion has taken it
  (`SavedActor.vehicleExit`, `SavedPlayer.vehicleExit`): loaded, it has let go already, and its
  exit idle goes on from where it was and takes it on out from there to the exit's end
  (ExitCartEnd ends the ride). Before, it was saved seated.
- The horse's package goes on with its patrol's point (above): the ride goes on after the load.
- An NPC riding a horse (src/shell/actor-mounts.ts): `SavedActor.riding` names the horse; loaded,
  the rider is put in the saddle at once (HorseEnterInstant) as soon as both are placed (it waits
  up to ten seconds for the horse's cell). An original save's Interaction extra (Elenwen beside
  the carts) imports to the same field.

## Animation graphs

The original keeps each actor's behavior graph with the actor (observed in the original): the
graph's internal state as Havok Behavior defines it (hkbBehaviorGraphInternalState: each active
node's own state by its node id, and the variable values; a state machine's own state is its
state, the seconds in it and its transitions under way; a clip's, its local time and play
direction). Ours
(`SavedActor.graph`, `WorldSave.playerGraphs` with the body's and the first-person graph,
`ActorGraphState`, src/animation/behavior-runtime.ts):

- Every loaded actor's graph (not a corpse's: it lies by its ragdoll pose) and the player's.
- Per behavior file reached, keyed by the file's name as its reference gives it (the root file
  ''): each active state machine's state id and seconds in it, by the machine's place among the
  file's machines; each playing clip's local time and direction, by its place among the file's
  clips (both in the order reached from the file's root, which a reload of the same data gives
  again).
- The variables by name, those whose values moved from their files' initial ones (put back over
  a graph that starts at the initial values, the same as keeping them all), and the vector
  variables (TargetLocation).
- The events it has not handled yet, by name with their payloads (an event a node raises is
  handled at the graph's next update): put back, they are handled as it first runs, not raised
  to the engine again. Lost, the graph stayed in the state the event would have taken it from:
  the player saved the frame the Whirlwind Sprint's release clip reached its end (raising
  shoutStop) loaded with their graph held in the shout for ever, animation-driven and unable to
  move.

As an actor is placed (the player as their body is there), its graph is put back before it first
runs: its variables, each machine starts in its saved state as long in it as it was (its enter
events not raised again), each clip goes on from its local time (what lies at that time is not
passed again). A file not reached yet takes its states as it is. Then the engine's systems take
it up as it is: one in furniture is in it without its graph being told to enter (it goes on
part-way through its sitting, sleeping or leaning idle, a workbench's held idle), its weapon is
out in its hand, its sneak, a script's or a scene's idle go on. The graph's variables the
engine sets every frame (Speed, Direction, IsSneaking) are set again from what the actor does,
as in the original.

What the is-active modifiers (BSIsActiveModifier) say is not taken from the save but from what is
active as the graph runs again: one of a state a transition still blended from said it was
active, and kept so, the player saved just up from the opening's block stayed animation-driven
(bAnimationDriven) and could not walk.

Also kept per file (`SavedGraphFile`): each transition under way (`transitions`: the machine,
its blends from the outermost in, each its state, seconds blended, duration, curve and flags,
and what the innermost blends from: a state, or the pose the machine had for a blend into
itself), so a machine saved mid-blend blends on from where it was instead of snapping into the
state it blended to (what it blends from plays on from its saved clip times beside it); the
active modifiers' own states (`modifiers`, by their place among the file's modifiers: a timer's
seconds, a modify-once that ran, an event-driven modifier switched on, a damping's values),
put back without activating them again; the cyclic blends frozen or cross-blending (`cyclic`).
A syncing blender's phase follows from its clips' local times, which are kept. A placed
object's skeletal graph is kept in the same form (`SavedGraph.skeleton`, its behavior
references' machines included); saves made before kept its own machines' states alone. Test:
tests/graph-save-events.int.test.ts "blends on from a transition caught mid-blend".

Bleedout and paired animations (`SavedActor.down`, `SavedPlayer.down`: `SavedDown`,
ActorCombat.saveDown): the seconds an actor has been bleeding out (it goes on bleeding out,
regaining, and gets up as before; its graph is in its bleedout already), its side of a paired
animation, whether it is a killmove, the seconds in it, a victim's killer and its partner
(`partner`: any pair, a feeding or a paired idle too, so pairedStop ends a loaded pair for both;
a save without it derives a killmove's partners from the killer); the deferred kills
under way are kept by the actors' engine (`RuntimeSave.engines.deferredKills`). A killmove caught
in a save plays on to its end, which kills its victim by its killer: neither partner is left
half-way (before, the victim's deferral and the pair were lost, and it stood with no health,
alive). Test: actor-engine.test.ts "a deferred kill across a save".

An imported .ess keeps each graph by names instead (`ActorGraphState.named`, `SavedGraph.named`:
`NamedGraphState`, src/animation/named-graph-state.ts; docs/formats/ess.md "Animation
graphs"): the active machines' states and the playing clips' times by the behavior graph's
name and the node's, every word variable as its 32 bits, the quads as vectors. As each behavior
file is reached the machines and clips of its graph's name are found by their names among the
file's and go on as a save of ours would have them (no seconds in the state: the original keeps
none); a word becomes its variable's value by the variable's type as its file's scope is made.
A save of ours made after the import keeps the graphs in our own form.

## Not saved yet

- What a low-process actor would have done off the stage in the time since it left, while its
  package stays the one saved (TODO(M13); "Off the stage"); a combat
  group's own timers (its dialogue and update timers: they run from the load); each body of an articulated object in motion on its own (`motions` keeps the first's,
  TODO(M13)).

- (Each save has its thumbnail: the frame drawn as it was made, src/shell/save-screenshot.ts;
  an import keeps the .ess's.)

The character a save belongs to, as observed in the original (src/save/character-id.ts): a
game's character has an id, a random u32 drawn as it is first needed (here as the race menu
names the player, else as the first save is made), never 0 and not one a known character
uses; it is kept with the game (`GameState.characterId`) and in each save's header
(`characterId`; the original writes it into the save file's name). The Load list groups the
saves by it: one entry per character, the one saved last first, named as its newest save names
the player; the journal's Save and Load list the playing character's. Naming the player keeps
the id while the name is the one the id goes by (or the player was never named), else draws a
new one, so a new character with a name used before is listed apart. Saves made before the id
was kept are grouped by the player's name. An imported .ess keeps the id its file name carries.
TODO(M13): the original also keys a character by whether its saves had mods (the file name's
"modded" digit), which ours does not.

Save on Pause, as observed in the original: the "pause" is the tween menu opening. With
bSaveOnPause on, once fAutosaveEveryXMins real minutes have passed since the last save and the
player's health is above fPlayerHealthSaveOnPauseLimit (0.25) of its maximum, the game shows
sAutoSaving ("Autosaving...") and autosaves (src/shell/save-manager.ts, the reason `pause`;
GameMenus.onPause). The settings menu's defaults turn the four Save on rules on and set
fAutosaveEveryXMins to 15. TODO(M13): one more check of the player the original makes there
is not read (here: none).

## In Play

The journal's System page: Save lists the saves newest first under the movie's [NEW SAVE] and
saves a new one or over the one chosen; Load lists them and loads the one chosen (`IsOKtoLoad`
is answered at once with `ConfirmOKToLoad`); Delete removes one; Quicksave writes the quicksave.
A save's list entry: `text` (name and location), `name`, `level`, `raceName`, `playTime` (the
game time), `index`, `fileNum`; then `onSaveLoadBatchComplete(true, count, count)`. F5
quicksaves, F9 loads the quicksave. Autosaves (`Autosave 1` to `3`, in turn) after a load door
or a journey (bSaveOnTravel), after waiting (bSaveOnWait) and after sleeping (bSaveOnRest). The
reload after the player's death loads the newest save. Saves live in IndexedDB
(`itjustworks-saves`: headers and files, keyed by name).

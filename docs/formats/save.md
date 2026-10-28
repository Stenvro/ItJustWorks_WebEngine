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
`ScriptRuntime.placement` gives it), `weather` (the sky's current weather), `unsaved` (what
could not be saved, logged again as it loads) and `world` (the loaded world beside the scripts,
below).

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
  again once it and its target are on the stage. Saved actors whose cell goes before it is
  placed come back where their packages have them.
- `graphs`: the loaded objects whose graphs moved from their start (an event sent, a variable
  set): the sequences' graph (each active state machine's state in the order reached from the
  root, the variables scripts set) and the skeletal graph (each state machine's state by its
  place among the graph's machines, its variables). As the object is placed again its graph
  starts there: its sequences played long ago, held at their ends, sending no text keys again
  (a lever pulled stays down before its script's OnLoad). TODO(M13): machines inside behavior
  references.

`RuntimeSave.scenes` (`SceneDirector.saveData`): each playing scene's phase, cast, clock and
actions (status, done, a timer's seconds left), and the starts waiting for their actors. On load
a scene plays on in its phase (IsPlaying is true at once): its begin and that phase's start
fragments do not run again, its actions not done start again (a line is said again, a package
action gives its package again, a timer runs on), those done that still run keep their looks.

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
  marker, favorites and hotkeys, books read, tutorials, active magic effects.
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
  `storyManager` (when quests were last started, what each node started).
- `instances`: every script instance (quests, aliases, references, active magic effects): its
  object, script, state and variables per script level.

Beside the runtime's data the body keeps `hazards` (src/scripting/runtime/hazard-engine.ts
SavedHazard: each hazard standing, its HAZD, source, age, lifetime, seconds to its next hits and
radius; its reference comes back with the game's created references and the hazard engine tracks
it again as the save loads) and, in `world`, `projectiles` (src/save/world-save.ts
SavedProjectile: each projectile in flight and each lobber at rest, a rune waiting for its
trigger: its PROJ, the magic item it carries with its caster, how it was cast and dual casting,
its position, velocity, the units flown, its age and whether it rests). They fly on as the loaded
world's physics attaches (MagicProjectiles.restore); a flame's sprays are not kept (the stream
ends with the cast), nor a cone's wave or a Magelight stuck to a wall (TODO(M13)).

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
player's cell or worldspace behind the loading screen (as a new game does) and sets the saved
weather. What could not be matched (a script no longer attached, a variable gone, a missing
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
calls the native again as it loads (TODO(M13): whether the original calls it again or hands the
caller the native's default result is not read).

Not held (logged as not saved, by where they are): a thread between a callee's return and its
caller taking the result, or in the full properties' Set functions before an OnInit
(TODO(M13)).

## Translations

TranslateTo's translations in progress (`RuntimeSave.translations`): the reference, where to,
the seconds the whole way takes, the share after which it is almost complete
(fRefTranslationAlmostDonePercent) and the seconds gone. After a load each goes on from there:
its almost-complete event if not yet told, then its end.

## World state kept while unloaded

GameState's own fields hold, and so save, what the world keeps of references that are not
loaded: `graphs` (the animated state an object's graph had as its 3D unloaded: a chest's lid
open, a lever pulled), the partial souls of soul gems (`itemStacks`' `soul`, the game's
ExtraSoul), and the corpses' ragdoll poses (`ActorState.corpse`, src/animation/corpse-pose.ts:
the nodes its ragdoll placed, in the world, and whether it lay at rest; kept as the corpse's
cell unloads and as the game is saved, before the state is written: the save's state holds the
live maps). A corpse lies again where it lay.

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
  leaves it outside a fight: drawn again as it is loaded; TODO(M13): the original's save keeps
  its graph with the weapon out, so it does not draw again).
- Not kept, as in the original: SetExpressionOverride's expression (the face's animation data
  belongs to its 3D, which the save does not hold; neither the actor's nor its process's save
  writes it).

A procedure's step after a load begins again (no progress inside a step is saved). A Travel to a
reference that moves aims where the reference is as it begins; to end where the original's
continuing travel would, a travel to a moving destination ends within reach of where the
destination is now, not of where its path led: an actor at its path's end whose target moved on
goes on after it (src/shell/actor-movers.ts).

## Not saved yet

- The player's sneaking and drawn weapon (the actor state's, as the NPCs' above): TODO(M12).
- The procedures' own progress inside a step (a patrol's next marker, a sandbox's activity: they choose again), actors' graphs
  beyond their furniture, the sky's transition; the actors of cells not loaded when saving
  (their packages place them, as before).

- The main menu's Load list and the save list's character filter (Continue loads the newest
  save), thumbnails, Save on Pause (bSaveOnPause with fAutosaveEveryXMins).

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

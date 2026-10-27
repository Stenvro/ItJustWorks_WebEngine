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
| `$a` | a Papyrus array: `[value, …]`                                       |
| `$o` | a plain object whose own keys start with `$` (wrapped)              |

Any other class instance is refused while saving (state the save would lose silently). Papyrus
arrays are saved by value: two variables that held the same array hold equal copies after a
load (TODO(M13): array identity).

## The body

`GameSave`: `runtime` (below), `player` (position, rotation, cell or worldspace, scale: as
`ScriptRuntime.placement` gives it), `weather` (the sky's current weather) and `unsaved` (what
could not be saved, logged again as it loads).

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

## Loading

The world is rebuilt from the plugins as for a new game, except that no quest starts and no
OnInit runs: the quests' records are read, the save's state is put into the fresh `GameState`
(Maps and Sets filled in place), the script instances are made as the plugins attach them and
take the save's variables and states (their property setters do not run again), the update
registrations are re-armed, and the player's lasting effects are prepared. Play then loads the
player's cell or worldspace behind the loading screen (as a new game does) and sets the saved
weather. What could not be matched (a script no longer attached, a variable gone, a missing
plugin) is logged under `save`.

## Not saved yet

- Papyrus threads in flight (a handler in `Utility.Wait`, `WaitGameTime`, a lock): their stacks
  are JavaScript calls and cannot be written down. Each is logged as not saved (TODO(M12):
  resumable frames). Update registrations are saved, so scripts that wait by registering go on.
- Scenes playing, objects translating (TranslateTo), hazards standing, projectiles, actors' AI
  package progress and combat, ragdolls and moved actors' places (actors start at their
  packages' places), the sky's transition.
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

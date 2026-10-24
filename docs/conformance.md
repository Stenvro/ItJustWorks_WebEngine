# Conformance: every system against the original's expected output

We don't measure progress by playtesting. Every system of the original engine
([engine-map.md](engine-map.md)) gets a conformance suite. A suite gives the system an input and
checks that our engine produces what the original produces. A system is complete when its suite is
complete and passes. The engine is complete when every suite is.

## Where the expected output comes from

Each case names its source in a comment. The sources, in order of preference:

1. **The game data.** What a record, a script or a graph says must happen. For example: a quest's
   stage after a script fires, a package's conditions at a given hour, a leveled list's picks at a
   given level.
2. **The engine's own rule**, as the original game behaves. It is described in our own
   words, with its numbers taken from game settings by name. Code and addresses from the original never
   enter the repository.
3. **The game settings' built-in defaults** (GMST, INI).
4. **UESP and community tools** (xEdit, nif.xml, CommonLibSSE), for formulas and structures.

A case whose expected value we chose ourselves is not a conformance case.

## The cases

Each case is one of three kinds.

- **Unit case.** One system, its input built in the test, for example a formula, a state machine or
  a parser.
- **Data case.** One system over the local game data (`*.int.test.ts`, skipped without game data).
  Where a rule applies to a whole class, the case sweeps the whole class across the load order: every
  door, every package, every effect archetype. It reports the counts, not just one example.
- **Interaction case.** Several systems at once in the headless simulation (`tests/helpers/sim.ts`):
  the real records, scripts, AI, physics and animation graphs, with no renderer, audio device or
  menus. The case sets up a world state, steps it at a fixed time step, and asserts what it can
  observe:
  - script events sent;
  - quest stages;
  - packages chosen;
  - positions;
  - HUD notices;
  - sounds asked for;
  - items moved.

Suites live in `tests/conformance/<area>/<system>.test.ts`. The areas are the ones in the engine map:
scripting, ai, combat, magic, animation, physics, rendering, ui.

- A behaviour the original has but we don't yet is written down as `it.todo('…')`, with its source,
  so the suite lists the whole system from the start.
- A behaviour known to differ is written as `it.fails('…')`, with a `TODO(Mx)`.

Writing the full list of a system's behaviours first is what makes "complete" countable.

## The report

`node tools/conformance-report.ts` (`npm run conformance`) runs the suites and prints, for every system
in the engine map, how many cases there are and how many pass, fail, differ as known (`it.fails`) or
are still todo (`--json report.json` reads a Vitest JSON report instead). A suite file maps to its row
by its folder (the area heading's first word) and its name (the system's name in lower case, words
joined by hyphens: `Followers, horses, furniture` is `followers-horses-furniture.test.ts`). The status
words in [engine-map.md](engine-map.md) follow from that table:

- **complete:** every case is written and passes;
- **partial:** some pass;
- **missing:** none pass.

An `it.fails` case that passes is reported as failing (Vitest fails it): the difference is gone, and
the case becomes a plain one.

## The headless simulation

`src/sim/` runs the game's world in Node with its real systems and no screen, speaker or page:
interaction cases use it through `tests/helpers/sim.ts`.

What runs: one game session over the local game data (records, the VFS, the Papyrus runtime with a
new game's quests, the story manager, the event hub), the loaded area as the page's viewers load it
(an interior cell, or a grid of exterior cells streamed around the player: objects placed with their
sequences, graphs and skeletons, their collision in a Rapier physics world, the navmeshes), the actor
stage with every actor system on it (AI packages and procedures, movers, senses and detection,
furniture, doors, combat, casting and magic, mounts and vehicles, behaviour graphs and their engine
handlers), and the player as a controllable actor (their physics body, user events by name, their
body's graphs).

How the presentation is cut off: the engine reaches it through ports.

- **Render** (`src/render/render-port.ts`): models are made from model data, scenes, morphs, water
  types, materials and decals are drawn. The page gives its WebGPU renderer; the simulation's
  (`headless-render.ts`) makes models without draws (their nodes, controllers, sequences and graph
  kept) and no scenes.
- **Sounds:** what the world asks for goes through `GameSession.playSound` (and Sound.Play, the actors'
  footsteps and graph sounds) and is recorded. Voices (`GameSession.voices`) take as long as their files
  say, from the files' headers, with their lip data (`headless-voices.ts`).
- **HUD and menus:** the simulation is the HUD's sink and the menus (`sim-log.ts`): notifications,
  quest updates, locations, subtitles and help messages are recorded; message boxes answer with the
  buttons a case queues (else the first).
- **Log:** the engine logs through the `Terminal` interface; the simulation keeps its lines.

How a step runs (`SimWorld.step`, 1/60 s by default), in the page's frame order: the player and the
physics, the game clock and the sky, the player's body, the actors, the objects' graphs, then the
scripts' clocks. A step then settles: it waits until the Papyrus threads wait, the story manager has
worked through its events, the cells and objects being placed are in and the game folder's reads are
done. The engine's reads of the page's clock (`performance.now`), its timers (`setTimeout`) and its
dice (`Math.random`) are replaced while a simulation runs (`virtual-clock.ts`): the clock moves only
with the steps, a timer fires when the simulation's clock reaches it, the dice are seeded. So the same
seed, place and steps observe the same records, step for step (`tests/sim-world.int.test.ts`), and a
second waited is a second of the simulation however fast it runs.

What it observes (`SimLog`, typed): every event-hub event, every event sent to scripts with its
arguments, every story manager event with the quests it started, the HUD's texts, the sounds asked
for, voice lines, footsteps and the menus opened. The helper reads stages set, packages per actor,
positions, deaths and items moved from them.

Speed (2026-10-24, a desktop CPU): the Bannered Mare with its 5 actors runs 30 s of game in 7.0 s
(4.3 game seconds per real second, 3.9 ms a step); Whiterun's busiest exterior cell with the 8 around
it and 38 actors 20 s in 13.2 s (1.5 per second, 11 ms a step); a new game takes 4.4 s first.
`node tools/sim-speed.ts --interior <cell>` or `--exterior <world> [x y]` measures it.

Not headless yet, each a `TODO(sim)` where it is:

- the page's viewers (`src/shell/model-viewer.ts`, `world-viewer.ts`) still carry their own copy of the
  loaded area's glue (the scripts' view, activation, streaming): they are to run on `SimWorld` and only
  draw it;
- outdoors, the sky's light (detection has no daylight outside) and the regions the player stands in
  (`src/shell/world-sky.ts` makes them with the sky's draws); the weather region is entered;
- the dialogue, container, barter, gift and training menus have no headless runner: they are recorded
  and close at once;
- the sound system does not run: a sound's conditions, the ambience, the music and the impact sounds
  are not decided (what was asked for is recorded);
- models have no draws: what reads a model's draw parts (a severed limb's skinned parts, an effect
  shader's membrane) finds none.

### The helper

`tests/helpers/sim.ts`:

- `openSim({ interior | exterior: { world, cell }, arrival?, hour?, day?, opening?, seed?,
gridRadius? })` starts a new game and opens the place; `openInterior`, `openExterior` go elsewhere;
- time: `setHour`, `setDay` (as scripts set GameHour and GameDaysPassed), `hour`, `time`, `step(seconds)`,
  `until(condition, seconds)`;
- state: `setStage`, `stage`, `stageDone`, `isRunning`, `setGlobal`, `openState`, `enabled`, `formId(type,
editorId)`;
- references and actors: `actor`, `actors`, `position`, `distance`, `package`, `place` (PlaceAtMe),
  `kill`;
- the player: `activate` (as through the crosshair), `moveTo`, `walkTo`, `equip`, `cast`, `press`;
- what happened: `records`, `scriptEvents({ event, target, since })`, `events(kind)`, `stagesSet`,
  `questsStarted`, `packages`, `deaths`, `notices`, `sounds`, `itemsMoved`, `storyEvents(type)`, `menus`,
  `problems`;
- `close()`.

## Working rules

- No browser for conformance work. The browser QA runner (`docs/qa.md`) checks rendering and the
  final playable build. It does not decide whether a system is right.
- One system at a time:
  1. write its full case list from the sources above;
  2. make the cases pass;
  3. update the engine map.
- Interactions between systems get their own cases: the event that one system raises and another
  answers (see the engine map's cross-cutting findings: event sources, settings, time and budget,
  persistence).

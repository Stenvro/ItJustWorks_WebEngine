# ItJustWorks-Webengine

A new engine for The Elder Scrolls V: Skyrim Special Edition that runs in the browser
(TypeScript and WebGPU). It contains no game content: everything it shows and plays (models,
textures, sounds, music, records, scripts) is read from your own installation of the game, on
your own machine. Like [OpenMW](https://openmw.org) for Morrowind, it is a reimplementation of
the engine only, and needs a legitimately owned copy of Skyrim Special Edition. It runs on
`localhost` only: nothing is uploaded anywhere.

> **Status: early development.** The game starts as the original does — its launcher, the
> intro, the main menu, a new game — and its quests and scripts run in the engine's own Papyrus
> virtual machine, with the game's own menus (HUD, inventory, map, journal, dialogue, ...).
> The worlds can be walked through with their people and creatures standing in them, animated
> by the game's own behavior graphs. They do not act yet: AI (packages, combat) is next, so the
> opening's cart does not drive to Helgen. See [Milestones](#milestones).

## What works

- **Game data:** the load order (ESM, ESP, ESL and Creation Club content), BSA archives with
  LZ4, loose files that override archives, and the records of every plugin.
- **Rendering (WebGPU):** models with the game's materials, textures (BC1–BC7), alpha, decals,
  particles and animated objects; interiors with their lighting and image spaces; exteriors
  with terrain and its texture blending, LOD, grass, water, sky, clouds, weather, shadows and
  post-processing.
- **Playing:** the player in first and third person with the game's controls and movement
  speeds, collision and physics (Rapier) built from the models' Havok data, doors between
  cells and worldspaces, swimming, picking up and holding objects.
- **Audio:** sound effects in 3D with reverb by acoustic space, ambience, water, impacts,
  footsteps by ground material, and the music system with its types and crossfades.
- **Actors:** people and creatures dressed and skinned on their race's skeleton, with FaceGen
  heads; the game's Havok animations and behavior graphs (also of animated objects, from
  packfiles and Creation Club tagfiles); blinking, moods and lip-synced voice lines; the
  player's own body in third person; ragdolls and hinged objects held by their constraints, the
  dead lying as ragdolls; actors where their AI packages have them as their cells load (on
  their posts, in their ambush alcoves, away when asleep elsewhere).
- **Scripts and quests:** the game's compiled Papyrus scripts (PEX) in the engine's own virtual
  machine, with its threads, events and the game's native functions; quests with their stages,
  objectives, aliases and scenes, dialogue with its conditions, the story manager, the game's
  clock and globals.
- **Menus:** the game's own Scaleform menus (`interface\*.swf`) played in
  [Ruffle](https://ruffle.rs), the engine standing in for Scaleform: the main menu with its
  intro, the loading screens, the HUD, the tween menu, inventory, magic, favorites, containers,
  barter, the map and local map, the journal with its settings and controls, dialogue, books,
  crafting, lockpicking, skills and levelling up, training, sleeping and waiting, message boxes,
  tutorials, character creation and the console, with the game's keyboard and mouse controls.

## Milestones

| Milestone | What                                                                      | State |
| --------- | ------------------------------------------------------------------------- | ----- |
| M0        | Vite, TypeScript and WebGPU; picking the game folder                      | done  |
| M1        | Virtual file system, BSA reader (LZ4), load order                         | done  |
| M2        | NIF and DDS: models with materials and alpha                              | done  |
| M3        | ESM records; interior cells                                               | done  |
| M4        | Tamriel's exterior: terrain, streaming, LOD, water, sky, weather          | done  |
| M5        | The player: first and third person, collision, physics                    | done  |
| M6        | Audio: xWMA, 3D sound, the music system                                   | done  |
| M7        | Actors: skinning, Havok animations and behavior graphs, faces, lip sync   | done  |
| M8        | The Papyrus virtual machine: quests and scripts as in the original        | done  |
| M9        | The game's own menus (Scaleform through Ruffle)                           | done  |
| M10       | AI: packages, navigation meshes, combat, detection, schedules             | next  |
| M11       | Gameplay: skills, perks, magic, shouts, crafting, crime, factions         |       |
| M12       | Savegames (own format, then importing `.ess` saves), mod load order       |       |
| M13       | Polish: performance, memory, edge cases, the main quest from start to end |       |

How the engine reads each format and why it behaves as it does is written down in
[`docs/`](docs): [file formats](docs/formats), [rendering](docs/rendering.md),
[physics](docs/physics.md), [audio](docs/audio.md), [animation](docs/animation.md),
[AI](docs/ai.md), [scripting](docs/scripting.md) and [the menus](docs/ui.md).

## Requirements

- Node 24 or newer
- Chrome or Edge on a desktop (WebGPU and the File System Access API)
- The Elder Scrolls V: Skyrim Special Edition (or Anniversary Edition), installed: the folder
  with `Data\`, `Skyrim.ccc` and `Skyrim_Default.ini`

## Running it

```bash
git clone <this repository> itjustworks-webengine
cd itjustworks-webengine
npm install
npm run dev
```

Open http://localhost:5173 and choose the game's installation folder (choosing its `Data`
folder also works, without Creation Club content). The browser keeps access to the folder for
the next visit.

- **Play** is the game itself: its launcher (Options: windowed or full screen), the intro and
  the game's main menu. **New** starts the opening, which waits for AI (M10): the cart does not
  drive yet. To play freely, open the console at the main menu (`~`) and type
  `coc Riverwood` (or any cell): as in the original, a new game starts there without the
  opening. The brand in the top left corner leaves the game.
- **Sandbox** opens any model, interior cell or worldspace, with a developer panel (time,
  weather, quest and scene states). Click the scene to play; H hides the panels.

The controls are the game's PC defaults (the control map, remappable on the journal's Controls
page): WASD to move, the mouse to look, Space to jump, Shift held to walk, Alt to sprint, Caps
Lock to always run, Ctrl to sneak, E to activate, F for the camera, Tab for the tween menu, I,
P, M and J for inventory, magic, map and journal, Q for favorites, T to wait, Esc to pause and
`~` for the console. In full screen the page keeps the game's keys (Keyboard Lock); in a
window the browser releases the mouse on Esc, which pauses the game.

To start over from the folder picker (a first run), clear the site's data: in Chrome or Edge,
open the developer tools (F12) → Application → Storage → **Clear site data**, then reload.
`http://localhost:5173/?reset` does the same.

### Development with local game data

The tools and integration tests read a copy of the game's `Data` folder outside the repository.
Point them at it with the `SKYRIM_DATA` environment variable, or put the path on one line in a
file `.gamedata` in the repository root (ignored by git):

```text
D:\Games\Skyrim Special Edition\Data
```

Without it the integration tests are skipped. With it, http://localhost:5173/?devdata skips the
folder picker: the dev server serves that folder read-only on `/@gamedata/` (dev server only,
never in a build).

## Commands

| Command                                 | What it does                                                  |
| --------------------------------------- | ------------------------------------------------------------- |
| `npm install`                           | Installs dependencies and enables the git hooks               |
| `npm run dev`                           | Dev server at http://localhost:5173                           |
| `npm run build`                         | Typecheck and a production build in `dist/`                   |
| `npm test`                              | Unit and integration tests (the latter only with game data)   |
| `npm run check`                         | Typecheck, lint, formatting, tests and the game-file check    |
| `node tools/data-info.ts`               | Checks the local Data folder                                  |
| `node tools/vfs-info.ts [path]`         | Load order, archives, and where a file comes from             |
| `node tools/bsa-list.ts <bsa> --verify` | Contents of an archive; verifies and extracts everything      |
| `node tools/nif-stats.ts --parse`       | Block types of all meshes; parses every block                 |
| `node tools/navmesh-info.ts --verify`   | Reads every navigation mesh                                   |
| `node tools/hkx-info.ts --audit`        | Loads and starts every behavior graph a mesh names            |
| `node tools/actor-info.ts <npc>`        | An actor's look, skeleton and behavior graph                  |
| `node tools/package-info.ts <actor>`    | An actor's AI packages and where they have it                 |
| `node tools/music-info.ts [type]`       | Music types and tracks of the load order                      |
| `node tools/pex-dump.ts --verify`       | Parses every compiled script; disassembles one                |
| `node tools/papyrus-run.ts`             | Runs a new game's scripts in Node and reports what they did   |
| `node tools/quest-info.ts <quest>`      | A quest's stages, objectives and aliases                      |
| `node tools/dialogue-info.ts <quest>`   | A quest's dialogue topics, responses and voice files          |
| `node tools/swf-info.ts [movie]`        | The interface movies: stage, exports, imports, fonts          |
| `node tools/controlmap-info.ts --all`   | The control map's contexts and bindings                       |
| `node tools/spawn-audit.ts [filter]`    | Arrives through every load door; walks through doors          |
| `node tools/stairs-audit.ts [filter]`   | Walks the player up and down every staircase of the interiors |

Every parser has a tool like these that runs it over the real game files, and is tested
against them before anything is built on it.

## Project layout

```text
src/
  formats/    parsers (BSA, NIF, DDS, ESM, HKX, PEX, audio): no browser APIs, they run in Node
  vfs/        the virtual file system: loose files over archives, load order
  world/      records, cells, worldspaces, streaming, weather, navigation meshes
  render/     WebGPU: shaders, terrain, water, sky, particles, LOD, post-processing
  physics/    Rapier: collision from the Havok data, the character controller
  audio/      Web Audio: 3D sound, reverb, music
  animation/  skeletons, the Havok Behavior runtime, faces and lip sync, tree sway
  scripting/  the Papyrus virtual machine and the game's native functions
  ai/         AI packages: where they put actors
  gameplay/   inventory, crafting, character creation, fast travel and other game rules
  ui/         Ruffle and the Scaleform bridge: the game's menus, their keys and mouse
  shell/      the web shell, Play (the game's menus in play) and the sandbox viewers
  workers/    parsing off the main thread
tools/        command-line tools over the local game files
tests/        integration tests against the local game files
docs/         formats and engine behaviour
```

## No game files in the repository

Game files never go into this repository, not even renamed or converted: no archives, plugins,
models, textures, sounds, scripts, interface files, INI files or anything extracted from them.
A pre-commit hook (`.githooks/pre-commit`, enabled by `npm install`) and `npm run check`
reject them by name, extension and content; continuous integration also checks every commit
of the history (`npm run check:history`).

## Contributing

Issues and pull requests are welcome. Please never attach game files or anything extracted
from them, also not to issues. Code, comments, docs and commit messages are in English; run
`npm run check` before sending a change. Engine behaviour is derived from documentation
(UESP, nif.xml, xEdit, community tools) and written down in `docs/`; what is not known yet is
marked with a `TODO` naming the milestone that settles it.

## Licence and credits

Copyright (C) 2026 stenvro

ItJustWorks-Webengine is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version ([`LICENSE`](LICENSE)). It is
distributed in the hope that it will be useful, but without any warranty.

Code adapted from other projects (Community Shaders, webgl-noise, Separable SSS, the SAO
reference implementation) and the dependencies with their licences are listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), with the documentation the engine was
written from.

The Elder Scrolls, Skyrim and Bethesda are trademarks of ZeniMax Media Inc. This project is
not affiliated with or endorsed by ZeniMax Media, Bethesda Softworks or Microsoft. It does not
contain, and will never provide, any part of the game: you need your own legitimately owned
copy.

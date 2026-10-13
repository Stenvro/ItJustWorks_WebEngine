# ItJustWorks-Webengine

A new engine for The Elder Scrolls V: Skyrim Special Edition that runs in the browser
(TypeScript and WebGPU). It contains no game content: everything it shows and plays (models,
textures, sounds, music, records, scripts) is read from your own installation of the game,
on your own machine. Like [OpenMW](https://openmw.org) for Morrowind, it is a reimplementation
of the engine only, and needs a legitimately owned copy of Skyrim Special Edition.

What it does so far is listed under "Milestones" in [`CLAUDE.md`](CLAUDE.md); the formats and
the engine's behaviour are written down in [`docs/`](docs).

## Requirements

- Node 24 or newer
- Chrome or Edge (WebGPU and the File System Access API)
- Skyrim Special Edition, installed (the folder with `Data\`, `Skyrim.ccc` and
  `Skyrim_Default.ini`)

## Running it

```bash
npm install
npm run dev
```

Open http://localhost:5173 and choose the game's installation folder (choosing its `Data`
folder also works, without Creation Club content). The browser keeps access to the folder for
the next visit; nothing is uploaded anywhere — the engine runs on `localhost` only.

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

| Command                                 | What it does                                                |
| --------------------------------------- | ----------------------------------------------------------- |
| `npm install`                           | Installs dependencies and enables the git hooks             |
| `npm run dev`                           | Dev server at http://localhost:5173                         |
| `npm test`                              | Unit and integration tests (the latter only with game data) |
| `npm run check`                         | Typecheck, lint, formatting, tests and game-file check      |
| `node tools/data-info.ts`               | Checks the local Data folder                                |
| `node tools/vfs-info.ts [path]`         | Load order, archives, and where a file comes from           |
| `node tools/bsa-list.ts <bsa> --verify` | Contents of an archive; verifies and extracts everything    |
| `node tools/nif-stats.ts --parse`       | Block types of all meshes; parses every block               |
| `node tools/music-info.ts [type]`       | Music types and tracks of the load order                    |

## No game files in the repository

Game files never go into this repository, not even renamed or converted. A pre-commit hook
(`.githooks/pre-commit`, enabled by `npm install`) and `npm run check:gamefiles` reject them by
extension and by content.

## Licence and credits

Code adapted from other projects (Community Shaders, webgl-noise, Separable SSS, the SAO
reference implementation) and the dependencies with their licences are listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), with the documentation the engine was
written from.

The Elder Scrolls, Skyrim and Bethesda are trademarks of ZeniMax Media Inc. This project is
not affiliated with or endorsed by ZeniMax Media, Bethesda Softworks or Microsoft.

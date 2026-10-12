# Skyrim Web

A new engine for Skyrim Special Edition in the browser (WebGPU). All content comes from
your own local installation; this repo contains no game files. See `CLAUDE.md` for the
goal, rules and milestones, and `docs/formats/` for format details.

## Requirements

- Node 24 or newer
- Chrome or Edge (WebGPU + File System Access API)
- Skyrim Special Edition; a copy of the installation folder in `F:\skyrim-data`
  (at least `Data\`, `Skyrim.ccc` and `Skyrim_Default.ini`). Different path: set the
  `SKYRIM_DATA` environment variable to point to the `Data` folder.

In the browser, choose the installation folder (`F:\skyrim-data`). Choosing the Data folder
itself also works, but then no Creation Club content is loaded.

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

A pre-commit hook (`.githooks/pre-commit`) rejects commits containing game files, even if
they have been renamed.

# Skyrim Web

Een nieuwe engine voor Skyrim Special Edition in de browser (WebGPU). Alle content komt uit
je eigen, lokale installatie; er staan geen gamebestanden in deze repo. Zie `CLAUDE.md` voor
doel, regels en mijlpalen.

## Vereisten

- Node 24 of nieuwer
- Chrome of Edge (WebGPU + File System Access API)
- Skyrim Special Edition; een kopie van de `Data`-map in `F:\skyrim-data\Data`
  (ander pad: omgevingsvariabele `SKYRIM_DATA`)

## Commando's

| Commando                  | Wat het doet                                               |
| ------------------------- | ---------------------------------------------------------- |
| `npm install`             | Dependencies installeren en de git-hooks aanzetten         |
| `npm run dev`             | Dev-server op http://localhost:5173                        |
| `npm test`                | Unit- en integratietests (die laatste alleen met gamedata) |
| `npm run check`           | Typecheck, lint, opmaak, tests en gamebestanden-controle   |
| `node tools/data-info.ts` | Controleert de lokale Data-map                             |

Een pre-commit-hook (`.githooks/pre-commit`) weigert commits met gamebestanden, ook als ze
hernoemd zijn.

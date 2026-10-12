# Skyrim Web

Een nieuwe engine voor Skyrim Special Edition in de browser (WebGPU). Alle content komt uit
je eigen, lokale installatie; er staan geen gamebestanden in deze repo. Zie `CLAUDE.md` voor
doel, regels en mijlpalen, en `docs/formats/` voor formaatdetails.

## Vereisten

- Node 24 of nieuwer
- Chrome of Edge (WebGPU + File System Access API)
- Skyrim Special Edition; een kopie van de installatiemap in `F:\skyrim-data`
  (minimaal `Data\`, `Skyrim.ccc` en `Skyrim_Default.ini`). Ander pad: omgevingsvariabele
  `SKYRIM_DATA` die naar de `Data`-map wijst.

In de browser kies je de installatiemap (`F:\skyrim-data`). De Data-map zelf kan ook, maar
dan wordt er geen Creation Club-content geladen.

## Commando's

| Commando                                | Wat het doet                                               |
| --------------------------------------- | ---------------------------------------------------------- |
| `npm install`                           | Dependencies installeren en de git-hooks aanzetten         |
| `npm run dev`                           | Dev-server op http://localhost:5173                        |
| `npm test`                              | Unit- en integratietests (die laatste alleen met gamedata) |
| `npm run check`                         | Typecheck, lint, opmaak, tests en gamebestanden-controle   |
| `node tools/data-info.ts`               | Controleert de lokale Data-map                             |
| `node tools/vfs-info.ts [pad]`          | Laadvolgorde, archieven, en waar een bestand vandaan komt  |
| `node tools/bsa-list.ts <bsa> --verify` | Inhoud van een archief; controleert en pakt alles uit      |

Een pre-commit-hook (`.githooks/pre-commit`) weigert commits met gamebestanden, ook als ze
hernoemd zijn.

# Laadvolgorde: plugins en archieven

Implementatie: `src/vfs/load-order.ts`, `src/vfs/vfs.ts`. Bronnen: UESP, libloadorder
(LOOT), de vanilla `Skyrim.ccc` en `Skyrim_Default.ini`.

## Waar staat wat

| Bestand              | Locatie                                      | Inhoud                               |
| -------------------- | -------------------------------------------- | ------------------------------------ |
| `Skyrim.ccc`         | installatiemap (naast `Data`)                | Creation Club-plugins, op volgorde   |
| `Skyrim_Default.ini` | installatiemap                               | o.a. `[Archive]`-lijsten             |
| `Plugins.txt`        | `%LOCALAPPDATA%\Skyrim Special Edition\`     | mods; `*Naam.esp` = actief           |
| `Skyrim.ini`         | `Documenten\My Games\Skyrim Special Edition` | kopie van de default-INI, aanpasbaar |

In de browser is alleen bereikbaar wat de gebruiker kiest. Daarom kiest de gebruiker de
**installatiemap** (de Data-map alleen kan ook, maar dan ontbreekt `Skyrim.ccc` en laadt
er, net als in het origineel zonder dat bestand, geen Creation Club-content).
`Plugins.txt` en `Skyrim.ini` vallen buiten de installatiemap.
TODO(M12): plugins.txt en Skyrim.ini importeren of een eigen mod-manager-scherm.

## Plugins

1. Vaste masters, als ze bestaan: `Skyrim.esm`, `Update.esm`, `Dawnguard.esm`,
   `HearthFires.esm`, `Dragonborn.esm`.
2. Plugins uit `Skyrim.ccc`, in die volgorde, alleen als ze in `Data` staan. Ze zijn altijd
   actief. (Het bestand somt ~75 plugins op; de meeste ontbreken zonder Anniversary Upgrade.)
3. Actieve regels uit `Plugins.txt` (`*` vooraan). Al geplaatste plugins worden genegeerd.
4. Daarna **masters vóór niet-masters**, verder stabiel. Master = extensie `.esm`/`.esl` of
   ESM-vlag (`0x1`) in de TES4-header.

Indexen (bepalen de bovenste byte van FormID's):

- volledige plugins: `00`-`FD` (max. 254);
- light plugins (`.esl` of ESL-vlag `0x200`): allemaal `FE`, met een eigen index
  `000`-`FFF` (max. 4096). Een `.esp` met ESL-vlag is light maar géén master.

Vanilla + gratis Anniversary-content geeft: `00`-`04` vaste masters, `05` Fish,
`FE:000` SurvivalMode, `FE:001` Curios, `06` AdvDSGS, `FE:002` \_ResourcePack.

TODO(M12): ontbrekende masters van een plugin detecteren (vereist de MAST-records, M3).

## Archieven

Volgorde van laag naar hoog; bij hetzelfde pad wint het **later** geladen archief:

1. `sResourceArchiveList`, dan `sResourceArchiveList2` uit `[Archive]` van de INI. Niet
   bestaande archieven worden overgeslagen (`Skyrim - Patch.bsa` staat erin maar bestaat
   niet in SSE). Taal zit in deze lijst (`Skyrim - Voices_en0.bsa`).
2. Per plugin in laadvolgorde: `<naam>.bsa`, dan `<naam> - Textures.bsa`.

**Losse bestanden** in `Data` gaan altijd voor alle archieven (anders dan Oblivion telt de
bestandsdatum niet).

`MarketplaceTextures.bsa` hoort bij geen INI-lijst of plugin en zit dus niet in de VFS.
TODO(M9): nagaan wanneer het Creations-menu dit archief laadt.
`sArchiveToLoadInMemoryList` (Animations) is alleen een prestatie-hint.

Vanilla-conflicten: 44 bestanden uit `Skyrim - Animations.bsa` en 3 uit
`ccBGSSSE037-Curios.bsa` worden overschreven door later geladen archieven
(`node tools/vfs-info.ts`).

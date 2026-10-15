# Load order: plugins and archives

Implementation: `src/vfs/load-order.ts`, `src/vfs/vfs.ts`. Sources: UESP, libloadorder
(LOOT), the vanilla `Skyrim.ccc` and `Skyrim_Default.ini`.

## What lives where

| File                 | Location                                    | Contents                           |
| -------------------- | ------------------------------------------- | ---------------------------------- |
| `Skyrim.ccc`         | installation folder (next to `Data`)        | Creation Club plugins, in order    |
| `Skyrim_Default.ini` | installation folder                         | among others the `[Archive]` lists |
| `Plugins.txt`        | `%LOCALAPPDATA%\Skyrim Special Edition\`    | mods; `*Name.esp` = active         |
| `Skyrim.ini`         | `Documents\My Games\Skyrim Special Edition` | copy of the default INI, editable  |

In the browser, only what the user picks is reachable. That is why the user picks the
**installation folder** (the Data folder alone also works, but then `Skyrim.ccc` is missing and,
just like in the original without that file, no Creation Club content is loaded).
`Plugins.txt` and `Skyrim.ini` are outside the installation folder.
TODO(M12): import plugins.txt and Skyrim.ini, or build a dedicated mod manager screen.

## Plugins

1. Fixed masters, if they exist: `Skyrim.esm`, `Update.esm`, `Dawnguard.esm`,
   `HearthFires.esm`, `Dragonborn.esm`.
2. Plugins from `Skyrim.ccc`, in that order, only if they are in `Data`. They are always
   active. (The file lists ~75 plugins; most are missing without the Anniversary Upgrade.)
3. Active lines from `Plugins.txt` (`*` prefix). Plugins already placed are ignored.
4. Then **masters before non-masters**, otherwise stable. Master = extension `.esm`/`.esl` or
   ESM flag (`0x1`) in the TES4 header.

Indexes (determine the top byte of FormIDs):

- full plugins: `00`-`FD` (max. 254);
- light plugins (`.esl` or ESL flag `0x200`): all `FE`, with their own index
  `000`-`FFF` (max. 4096). An `.esp` with the ESL flag is light but **not** a master.

Vanilla + free Anniversary content gives: `00`-`04` fixed masters, `05` Fish,
`FE:000` SurvivalMode, `FE:001` Curios, `06` AdvDSGS, `FE:002` \_ResourcePack.

TODO(M12): detect a plugin's missing masters (requires the MAST records, M3).

## Archives

Order from low to high; for the same path the archive loaded **later** wins:

1. `sResourceArchiveList`, then `sResourceArchiveList2` from `[Archive]` in the INI.
   Non-existent archives are skipped (`Skyrim - Patch.bsa` is listed but does not exist
   in SSE). The language is part of this list (`Skyrim - Voices_en0.bsa`).
2. Per plugin in load order: `<name>.bsa`, then `<name> - Textures.bsa`.

**Loose files** in `Data` always take precedence over all archives (unlike Oblivion, the
file date does not matter).

`MarketplaceTextures.bsa` belongs to no INI list or plugin and is therefore not in the VFS.
It holds only `interfacemarketplace*.png`, the online Creations store's pictures, so it
is never needed offline.
`sArchiveToLoadInMemoryList` (Animations) is only a performance hint.

Vanilla conflicts: 44 files from `Skyrim - Animations.bsa` and 3 from
`ccBGSSSE037-Curios.bsa` are overridden by archives loaded later
(`node tools/vfs-info.ts`).

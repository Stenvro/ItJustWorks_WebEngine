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
`Plugins.txt`, `Skyrim.ini` and `SkyrimPrefs.ini` are outside the installation folder, so the
shell keeps its own copies in IndexedDB beside the stored folder handle
(`src/vfs/browser/user-files.ts`):

- **The plugin screen** (main menu, `src/shell/plugin-screen.ts`) lists every `.esm`/`.esp`/
  `.esl` in `Data`: the game's own (implicit masters, Skyrim.ccc's Creations) first, always
  active and fixed in place; then the user's list in its order; then plugins the list does not
  name, inactive (`src/vfs/plugin-list.ts`, `pluginScreenList`). The user ticks and moves them;
  _apply_ stores the list as Plugins.txt text and mounts the game again. A refused plugin shows
  why in red, its index as `--`.
- **Import Plugins.txt**: the user picks their own file; the same rule as the original (line
  order, `*` = active, `#` comments; the game's own plugins in it are ignored).
- **Import Skyrim.ini / SkyrimPrefs.ini**: read once, the text stored; the user's files are never
  written. _forget ini files_ drops the copies.

`node tools/vfs-info.ts --plugins <Plugins.txt> --ini <Skyrim.ini> --prefs <SkyrimPrefs.ini>`
mounts with them in Node.

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

### Masters

Each plugin's TES4 record is read whole at mount (it is small; `parsePluginMasters` reads its
`MAST` fields without the rest of the file). After the order above, an active plugin whose master
is missing from `Data` or not active is **not loaded**, and so in turn are the plugins needing it
(repeated until nothing changes); the game does not load records pointing into a file it lacks.
The reason (`its master X is missing` / `is not active`) goes to the log and the plugin screen
(`Vfs.refused`), and its archives are not mounted. Indexes are given after refusing, so the
plugins after it close up.

A master that loads **after** a plugin needing it (an `.esp` needing a later `.esp`; masters
before non-masters prevents the rest) is reported (`X loads before its master Y`) but loaded.
TODO(M13): what the original does then; LOOT and libloadorder call the order invalid.

Vanilla: every plugin's masters load before it (`Update.esm` needs `Skyrim.esm`; the DLCs both;
the Creations all five, `_ResourcePack.esl` Skyrim, Update, HearthFires).

## Archives

Order from low to high; for the same path the archive loaded **later** wins:

1. `sResourceArchiveList`, then `sResourceArchiveList2` from `[Archive]` in the layered INI
   (below: a list the player's or a plugin's INI sets replaces the default's).
   Non-existent archives are skipped (`Skyrim - Patch.bsa` is listed but does not exist
   in SSE). The language is part of this list (`Skyrim - Voices_en0.bsa`).
2. Per plugin in load order: `<name>.bsa`, then `<name> - Textures.bsa`.

**Loose files** in `Data` always take precedence over all archives (unlike Oblivion, the
file date does not matter).

`MarketplaceTextures.bsa` belongs to no INI list or plugin and is therefore not in the VFS.
It holds only `interfacemarketplace*.png`, the online Creations store's pictures, so it
is never needed offline.
`sArchiveToLoadInMemoryList` (Animations) is only a performance hint.

**The game's own content** (`gameContentArchives`, `Vfs.isGameContent`): the archives of the
default INI's lists and of the plugins the game loads by itself (its masters and Skyrim.ccc's
Creations), not those of plugins.txt. A file the game's own content names that none of them holds
is one the game itself lacks (no fault of the load order: logged as info, not as a warning).
Loose files never count as the game's.

Vanilla conflicts: 44 files from `Skyrim - Animations.bsa` and 3 from
`ccBGSSSE037-Curios.bsa` are overridden by archives loaded later
(`node tools/vfs-info.ts`).

## INI files

`Vfs.ini` layers the settings, low to high; a key a later file sets replaces the earlier one's
(`mergeIni`):

1. `Skyrim_Default.ini` (installation folder);
2. the player's `Skyrim.ini` (imported). In the original the launcher copies the default to
   `Skyrim.ini` when that is missing and the game then reads only `Skyrim.ini`; the player's copy
   holds the default's keys plus their own, so laying it over the default gives the same values
   and still works for a short file;
3. the player's `SkyrimPrefs.ini` (imported);
4. `<Plugin>.ini` in `Data` for each **loaded** plugin, in load order (the original reads an INI
   named like a plugin; mods ship `[Archive]` lists or tweaks that way).

Over the INI layer come the settings-menu changes kept in the browser (`src/shell/preferences.ts`,
`IniSettings`). Everything that reads a setting goes through it (`GameSession.ini`, the player,
the mist menu): `uGridsToLoad` sets the loaded grid (`src/shell/world-viewer.ts`) and the
scripts' attached area, `fGamma` the brightness, `[Display] bFull Screen` the launcher's window
mode when its Options were never saved. `Vfs.defaultIni` stays the installation's file alone (the
settings menu's defaults; the game's own archives, `gameContentArchives`).

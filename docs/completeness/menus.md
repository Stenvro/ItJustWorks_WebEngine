# Menus: completeness checklist

"100" for the menus: every menu the original has, from every movie in `interface\` (the base
game's, the DLCs' and the Creation Club's, as the load order mounts them), opens when the
original opens it and behaves as the original's: every GFx call the movies make is answered,
every value the engine pushes into them is pushed, every key and gamepad path works.

How it is measured: `node tools/menu-inventory.ts` sweeps every movie of the mounted interface
folder, reads the names each one passes to `GameDelegate.call` (what it asks of the engine) and
`GameDelegate.addCallBack` (what the engine may call in it) from its ActionScript, and looks for
each name in our menu code (`src/ui`, `src/shell`, the chargen catalog). `--markdown` prints the
tables below. The match is static: a name found in code counts as done. Rows marked "n/a" are
names or movies the PC game never uses, with the reason. The behaviour checklist after the
counts holds what a name sweep cannot see.

## Counts (2026-10-30)

| Part                             | Items | Done | Open | n/a |
| -------------------------------- | ----: | ---: | ---: | --: |
| Movies                           |    50 |   35 |    2 |  13 |
| GameDelegate calls and callbacks |   425 |  374 |   11 |  40 |
| Menu names the original opens    |    41 |   30 |    1 |  10 |
| Behaviour items (below)          |    37 |   23 |   11 |   3 |
| All                              |   553 |  462 |   25 |  66 |

Some behaviour items name calls the sweep also lists (they say what is still missing around
them). The movies' `ExternalInterface.call("__handleEvent")` (CLIK's sound and focus events) is answered
by the bridge for every movie and is not counted per movie.

## Behaviour checklist

Things a name sweep cannot see: what the engine does around the calls, values it pushes by
path (GFx Invoke and SetVariable), keys and gamepad paths, and the player's own reports.

| Item                                                                                  | Status | Where / reason                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Main menu Load: characters, then their saves; load, delete                            | done   | src/shell/save-list.ts, src/shell/play-mode.ts                                                                                                                                                                                                                                                                                             |
| Journal Load's character list (PopulateCharacterList, CharacterSelected)              | done   | src/shell/save-list.ts, src/shell/journal-menu.ts                                                                                                                                                                                                                                                                                          |
| Journal Save and Load list the character playing                                      | done   | src/shell/save-list.ts                                                                                                                                                                                                                                                                                                                     |
| SetButtonMapping to every movie that registers it (keyboard and mouse)                | done   | src/ui/menu-host.ts, src/ui/button-art.ts (buttonMappings)                                                                                                                                                                                                                                                                                 |
| SetButtonMapping sent again after a remap or a reset                                  | done   | src/shell/journal-controls.ts                                                                                                                                                                                                                                                                                                              |
| A menu's movie read from interface\exported\<name>.gfx when its .swf is missing       | done   | src/ui/movie-file.ts (movieFile)                                                                                                                                                                                                                                                                                                           |
| HUD MovementDisabled mode                                                             | done   | src/shell/hud-elements.ts (movementDisabledStep), src/shell/hud-controller.ts                                                                                                                                                                                                                                                              |
| HUD CartMode, HorseMode, WarHorseMode                                                 | done   | src/shell/hud-elements.ts (rideModes)                                                                                                                                                                                                                                                                                                      |
| Menu stack with the original's IMenu flags, saving permission, UI.IsMenuOpen          | done   | src/ui/menu-stack.ts                                                                                                                                                                                                                                                                                                                       |
| Gamepad: contexts, GFx gamepad keys, remap, live SetPlatform                          | done   | src/shell/gamepad-input.ts, src/ui/input-platform.ts                                                                                                                                                                                                                                                                                       |
| SetButtonMapping with a gamepad (the gamepad's bindings, their art names)             | open   | the gamepad's art names are not built                                                                                                                                                                                                                                                                                                      |
| Save screenshots (PrepSaveGameScreenshot, ScreenshotReady)                            | done   | src/shell/save-screenshot.ts, src/shell/save-list.ts, src/render/renderer.ts (captureFrame)                                                                                                                                                                                                                                                |
| The map's relief overlay                                                              | open   | the map's LOD land shader: how the original tells snow and blends the two normals is not read (docs/ui.md, "The map")                                                                                                                                                                                                                      |
| The lockpicking strings the maintainer saw                                            | open   | to check on screen which text; the bar's labels are translation keys ($Lock Level, $Lockpicks Left)                                                                                                                                                                                                                                        |
| Lockpicking debug display (UpdatePickAngle, UpdateLockAngle, UpdateSweetSpot, ...)    | done   | src/shell/lockpicking-menu.ts: SetPickMinMax as it is made, UpdateSweetSpot as it shows, the angles and the pick's health as they change (the display shows only after ToggleDebugMode, which the engine never sends)                                                                                                                      |
| Controls page: the left/right swap the maintainer saw                                 | open   | the data path is as the original's: Left Attack/Block is the right mouse button (Mouse2), as the movie's own default table has it; to check on screen which side looks swapped                                                                                                                                                             |
| Ruffle: scale9Grid not drawn                                                          | done   | Ruffle 0.7.1 does not slice them (seen on screen); src/ui/scale9.ts cuts every grid sprite's shapes, nested clips' too, as it scales (docs/ui.md, "Ruffle's limits")                                                                                                                                                                       |
| Ruffle: the "Times New Roman" device font                                             | done   | src/ui/movie-patches.ts (patchDeviceFonts): a device font the font library lacks draws no text, as the original has no system font provider; hudmenu.swf's one empty field is the only one                                                                                                                                                 |
| Item menus' ToggleMenuFade (the menu fades out and back)                              | done   | src/shell/item-3d.ts: as a zoom starts (ZoomItemModel from rest, Item Zoom, Cancel while zoomed in), as the original                                                                                                                                                                                                                       |
| Map over the journal (ShowJournal: the map's bar hidden while the journal shows)      | done   | src/shell/map-menu.ts (showJournal), src/shell/game-menus.ts: the map stays open under the journal                                                                                                                                                                                                                                         |
| Tween menu HideMenu, ResetStatsButton, ShowMenu                                       | done   | src/shell/game-menus.ts: hidden under the menu chosen, shown again when an item menu goes back to it                                                                                                                                                                                                                                       |
| Journal HideMenu, ShowMenu, StartCloseMenu, RefreshSystemButtons, BackOutFromLoadGame | open   | StartCloseMenu(true) as the engine hides it (a save from the journal): src/shell/journal-menu.ts; HideMenu: the engine calls it in the tween menu only (n/a); ShowMenu ("Show Journal") and RefreshSystemButtons ("RefreshMenu"): their senders are not found (the strings sit in a table built at run time); BackOutFromLoadGame not read |
| Main menu ConfirmNewGame, ConfirmContinue, HELP, OnDisabledLoadPress, QuitToMainMenu  | done   | src/shell/play-mode.ts (the original answers the last three with nothing)                                                                                                                                                                                                                                                                  |
| Main menu Load's import of an original save (.ess)                                    | done   | src/shell/play-mode.ts (pickImport), src/shell/save-list.ts: the picker opens as the entry is pressed                                                                                                                                                                                                                                      |
| Favorites StartFadeOut, SetSelectedItem; dialogue Cancel                              | open   | not sent                                                                                                                                                                                                                                                                                                                                   |
| Book PrepForClose                                                                     | done   | src/shell/book-menu.ts                                                                                                                                                                                                                                                                                                                     |
| Message box setIsVertical; HUD FadeOutChargeMeters, ValidateCrosshair                 | open   | FadeOutChargeMeters: src/shell/hud-controller.ts (the tween, inventory, magic and container menus as they open); ValidateCrosshair: sent while a spell is aimed (each effect checked at the aim point), not built; setIsVertical not sent                                                                                                  |
| HUD SetCompassTemperature (Survival Mode)                                             | open   | the engine has no such name: Survival Mode's own scripts would drive it; not checked                                                                                                                                                                                                                                                       |
| Quantity Menu as a menu of its own                                                    | n/a    | no menu of the original is made under the name: the item menus' quantity slider plays inside their movie                                                                                                                                                                                                                                   |
| Top Menu, Overlay Menu, Overlay Interaction Menu                                      | n/a    | no menu of the original is made under these names (they are only looked up)                                                                                                                                                                                                                                                                |
| SafeZoneMenu                                                                          | n/a    | the consoles' safe-zone setting: the PC's display page has none                                                                                                                                                                                                                                                                            |
| Debug Text Menu                                                                       | open   | its flags and when the original opens it are not read                                                                                                                                                                                                                                                                                      |
| TitleSequence Menu and LoadWaitSpinner in the menu stack                              | done   | src/shell/title-sequence.ts, src/shell/load-wait-spinner.ts (shown while a save is written)                                                                                                                                                                                                                                                |
| The inventory 3D turned and zoomed by each model's BSInvMarker                        | done   | src/shell/item-3d-view.ts, src/shell/item-3d.ts: the marker's rotation (x, y, z), its zoom, the bound radius, the 16:9 rule, the mouse and stick turns, the straight zoom                                                                                                                                                                  |
| Lockpicking: the failed tries on a lock (for IsLockBroken)                            | done   | src/scripting/runtime/natives/reference.ts (lockBroken): the lock's own tries (game state lockTries) against one, or two with Ignore Broken Lock; broken picks are the menu's own count, not the lock's (src/shell/lockpicking-menu.ts); what adds to a lock's tries is not read (TODO(M13))                                               |
| Beast perk trees, low-stat tutorials, Survival HUD                                    | open   | docs/engine-map.md ("UI")                                                                                                                                                                                                                                                                                                                  |
| Creation Club menu, Mod Manager, Bethesda.net login                                   | open   | online services, never reached from localhost (hard rule 4); the installed Creations could be listed offline: not decided                                                                                                                                                                                                                  |

## Sweep tables

Printed by `node tools/menu-inventory.ts --markdown` (2026-10-30).

### Movies

| Movie                                           | Status | Opened by / reason                                                               |
| ----------------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| bartermenu.swf                                  | done   | src/shell/barter-menu.ts                                                         |
| bethesdanetlogin.swf                            | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4)     |
| book.swf                                        | done   | src/shell/book-menu.ts                                                           |
| bookmenu.swf                                    | done   | src/shell/book-menu.ts                                                           |
| console.swf                                     | done   | src/shell/console-menu.ts                                                        |
| containermenu.swf                               | done   | src/shell/container-menu.ts                                                      |
| craftingmenu.swf                                | done   | src/shell/crafting-menu.ts                                                       |
| creationclubmenu.swf                            | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4)     |
| creditsmenu.swf                                 | done   | src/shell/credits-menu.ts                                                        |
| cursormenu.swf                                  | done   | src/ui/menu-host.ts                                                              |
| dialoguemenu.swf                                | done   | src/shell/dialogue-menu.ts                                                       |
| exported\hudmenu.gfx                            | n/a    | read only without interface\hudmenu.swf, which ships                             |
| exported\quest_journal.gfx                      | n/a    | read only without interface\quest_journal.swf, which ships                       |
| exported\racesex_menu.gfx                       | n/a    | read only without interface\racesex_menu.swf, which ships                        |
| exported\safezone.gfx                           | n/a    | read only without interface\safezone.swf, which ships                            |
| exported\textentry.gfx                          | n/a    | read only without interface\textentry.swf, which ships                           |
| exported\tutorialmenu.gfx                       | n/a    | read only without interface\tutorialmenu.swf, which ships                        |
| fadermenu.swf                                   | done   | src/shell/fader-menu.ts                                                          |
| favoritesmenu.swf                               | done   | src/shell/favorites-menu.ts                                                      |
| giftmenu.swf                                    | done   | src/shell/gift-menu.ts                                                           |
| hudmenu.swf                                     | done   | src/shell/hud-controller.ts                                                      |
| inventory components\bottombar.swf              | done   | loaded by bartermenu.swf, containermenu.swf, craftingmenu.swf, giftmenu.swf, ... |
| inventory components\inventorylists.swf         | done   | loaded by bartermenu.swf, containermenu.swf, craftingmenu.swf, giftmenu.swf, ... |
| inventory components\invertedinventorylists.swf | done   | loaded by magicmenu.swf                                                          |
| inventory components\itemcard.swf               | done   | loaded by bartermenu.swf, containermenu.swf, craftingmenu.swf, giftmenu.swf, ... |
| inventorymenu.swf                               | done   | src/shell/inventory-menu.ts                                                      |
| kinectmenu.swf                                  | n/a    | consoles only (PlayStation, Xbox, Switch)                                        |
| levelupmenu.swf                                 | done   | src/shell/level-up-menu.ts                                                       |
| loadingmenu.swf                                 | done   | src/shell/play-mode.ts                                                           |
| loadwaitspinner.swf                             | done   | src/shell/load-wait-spinner.ts                                                   |
| lockpickingmenu.swf                             | done   | src/shell/lockpicking-menu.ts                                                    |
| logindialog.swf                                 | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4)     |
| magicmenu.swf                                   | done   | src/shell/magic-menu.ts                                                          |
| map.swf                                         | done   | src/ui/movie-patches.ts, src/shell/map-menu.ts                                   |
| messagebox.swf                                  | done   | src/shell/message-boxes.ts                                                       |
| modmanager.swf                                  | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4)     |
| quest_journal.swf                               | done   | src/shell/journal-menu.ts                                                        |
| racesex_menu.swf                                | done   | src/shell/race-menu.ts                                                           |
| safezone.swf                                    | n/a    | the consoles' safe-zone setting: the PC's display page has none                  |
| sharedcomponents.swf                            | open   |                                                                                  |
| sleepwaitmenu.swf                               | done   | src/shell/sleep-wait-menu.ts                                                     |
| startmenu.swf                                   | done   | src/shell/play-mode.ts                                                           |
| statsmenu.swf                                   | done   | src/shell/skills-menu.ts                                                         |
| streaminginstall.swf                            | n/a    | consoles only (PlayStation, Xbox, Switch)                                        |
| textentry.swf                                   | done   | loaded by exported\racesex_menu.gfx, racesex_menu.swf                            |
| titles.swf                                      | done   | src/shell/title-sequence.ts                                                      |
| trainingmenu.swf                                | done   | src/shell/training-menu.ts                                                       |
| tutorialmenu.swf                                | done   | src/shell/tutorial-menu.ts                                                       |
| tweenmenu.swf                                   | done   | src/shell/game-menus.ts                                                          |
| widgetoverlay.swf                               | open   |                                                                                  |

### Menu names

| Menu                     | Status | Reason                                                                       |
| ------------------------ | ------ | ---------------------------------------------------------------------------- |
| BarterMenu               | done   |                                                                              |
| Book Menu                | done   |                                                                              |
| Console                  | done   |                                                                              |
| Console Native UI Menu   | n/a    | consoles only (PlayStation, Xbox, Switch)                                    |
| ContainerMenu            | done   |                                                                              |
| Crafting Menu            | done   |                                                                              |
| Creation Club Menu       | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4) |
| Credits Menu             | done   |                                                                              |
| Cursor Menu              | done   |                                                                              |
| Debug Text Menu          | open   |                                                                              |
| Dialogue Menu            | done   |                                                                              |
| Fader Menu               | done   |                                                                              |
| FavoritesMenu            | done   |                                                                              |
| GiftMenu                 | done   |                                                                              |
| HUD Menu                 | done   |                                                                              |
| InventoryMenu            | done   |                                                                              |
| Journal Menu             | done   |                                                                              |
| Kinect Menu              | n/a    | consoles only (PlayStation, Xbox, Switch)                                    |
| LevelUp Menu             | done   |                                                                              |
| Loading Menu             | done   |                                                                              |
| LoadWaitSpinner          | done   |                                                                              |
| Lockpicking Menu         | done   |                                                                              |
| MagicMenu                | done   |                                                                              |
| Main Menu                | done   |                                                                              |
| MapMenu                  | done   |                                                                              |
| MessageBoxMenu           | done   |                                                                              |
| Mist Menu                | done   |                                                                              |
| Mod Manager Menu         | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4) |
| Overlay Interaction Menu | n/a    | no menu of the original is made under this name (it is only looked up)       |
| Overlay Menu             | n/a    | no menu of the original is made under this name (it is only looked up)       |
| Quantity Menu            | n/a    | no menu of the original is made under this name (it is only looked up)       |
| RaceSex Menu             | done   |                                                                              |
| SafeZoneMenu             | n/a    | the consoles' safe-zone setting: the PC's display page has none              |
| Sleep/Wait Menu          | done   |                                                                              |
| StatsMenu                | done   |                                                                              |
| StreamingInstallMenu     | n/a    | consoles only (PlayStation, Xbox, Switch)                                    |
| TitleSequence Menu       | done   |                                                                              |
| Top Menu                 | n/a    | no menu of the original is made under this name (it is only looked up)       |
| Training Menu            | done   |                                                                              |
| Tutorial Menu            | done   |                                                                              |
| TweenMenu                | done   |                                                                              |

### bartermenu.swf

| Kind     | Name                    | Status | Where / reason           |
| -------- | ----------------------- | ------ | ------------------------ |
| call     | CloseMenu               | done   | src/shell/item-menu.ts   |
| call     | DisabledItemSelect      | done   | src/shell/item-menu.ts   |
| call     | GetRawDealWarningString | done   | src/shell/barter-menu.ts |
| call     | ItemSelect              | done   | src/shell/item-menu.ts   |
| call     | PlaySound               | done   | src/shell/play-mode.ts   |
| call     | QuantitySliderOpen      | done   | src/shell/item-menu.ts   |
| call     | RequestItemCardInfo     | done   | src/shell/item-menu.ts   |
| call     | SaveIndices             | done   | src/shell/item-menu.ts   |
| call     | StartMouseRotation      | done   | src/shell/item-menu.ts   |
| call     | StopMouseRotation       | done   | src/shell/item-menu.ts   |
| call     | UpdateItem3D            | done   | src/shell/item-menu.ts   |
| call     | ZoomItemModel           | done   | src/shell/item-menu.ts   |
| call     | myLog                   | done   | src/shell/play-mode.ts   |
| callback | InvalidateListData      | done   | src/shell/item-menu.ts   |
| callback | RestoreIndices          | done   | src/shell/item-menu.ts   |
| callback | SetBarterMultipliers    | done   | src/shell/barter-menu.ts |
| callback | SetButtonMapping        | done   | src/ui/menu-host.ts      |
| callback | SetCategoriesList       | done   | src/shell/item-menu.ts   |
| callback | ToggleMenuFade          | done   | src/shell/item-3d.ts     |
| callback | UpdateItemCardInfo      | done   | src/shell/item-menu.ts   |
| callback | UpdatePlayerInfo        | done   | src/shell/item-menu.ts   |

### book.swf

| Kind     | Name         | Status | Where / reason         |
| -------- | ------------ | ------ | ---------------------- |
| callback | PrepForClose | done   | src/shell/book-menu.ts |
| callback | SetBookText  | done   | src/shell/book-menu.ts |
| callback | TurnPage     | done   | src/shell/book-menu.ts |

### bookmenu.swf

| Kind     | Name                  | Status | Where / reason                                          |
| -------- | --------------------- | ------ | ------------------------------------------------------- |
| call     | myLog                 | done   | src/shell/play-mode.ts                                  |
| callback | ShowTakeButton        | done   | src/shell/book-menu.ts                                  |
| callback | UpdateTurnPagesButton | n/a    | the original engine has no such name: it never sends it |

### console.swf

| Kind | Name           | Status | Where / reason            |
| ---- | -------------- | ------ | ------------------------- |
| call | ExecuteCommand | done   | src/shell/console-menu.ts |
| call | HideComplete   | done   | src/shell/console-menu.ts |

### containermenu.swf

| Kind     | Name                | Status | Where / reason         |
| -------- | ------------------- | ------ | ---------------------- |
| call     | CheckForMouseEquip  | done   | src/shell/item-menu.ts |
| call     | CloseMenu           | done   | src/shell/item-menu.ts |
| call     | DisabledItemSelect  | done   | src/shell/item-menu.ts |
| call     | EquipItem           | done   | src/shell/item-menu.ts |
| call     | ItemSelect          | done   | src/shell/item-menu.ts |
| call     | ItemTransfer        | done   | src/shell/item-menu.ts |
| call     | PlaySound           | done   | src/shell/play-mode.ts |
| call     | QuantitySliderOpen  | done   | src/shell/item-menu.ts |
| call     | RequestItemCardInfo | done   | src/shell/item-menu.ts |
| call     | SaveIndices         | done   | src/shell/item-menu.ts |
| call     | StartMouseRotation  | done   | src/shell/item-menu.ts |
| call     | StopMouseRotation   | done   | src/shell/item-menu.ts |
| call     | TakeAllItems        | done   | src/shell/item-menu.ts |
| call     | UpdateItem3D        | done   | src/shell/item-menu.ts |
| call     | ZoomItemModel       | done   | src/shell/item-menu.ts |
| call     | myLog               | done   | src/shell/play-mode.ts |
| callback | AttemptEquip        | done   | src/shell/item-menu.ts |
| callback | InvalidateListData  | done   | src/shell/item-menu.ts |
| callback | RestoreIndices      | done   | src/shell/item-menu.ts |
| callback | SetButtonMapping    | done   | src/ui/menu-host.ts    |
| callback | SetCategoriesList   | done   | src/shell/item-menu.ts |
| callback | ToggleMenuFade      | done   | src/shell/item-3d.ts   |
| callback | UpdateItemCardInfo  | done   | src/shell/item-menu.ts |
| callback | UpdatePlayerInfo    | done   | src/shell/item-menu.ts |
| callback | XButtonPress        | done   | src/shell/item-menu.ts |

### craftingmenu.swf

| Kind     | Name                | Status | Where / reason             |
| -------- | ------------------- | ------ | -------------------------- |
| call     | AuxButtonPress      | done   | src/shell/crafting-menu.ts |
| call     | CalculateCharge     | done   | src/shell/crafting-menu.ts |
| call     | CanFadeItemInfo     | done   | src/shell/crafting-menu.ts |
| call     | ChooseItem          | done   | src/shell/crafting-menu.ts |
| call     | CloseMenu           | done   | src/shell/crafting-menu.ts |
| call     | CraftButtonPress    | done   | src/shell/crafting-menu.ts |
| call     | CraftSelectedItem   | done   | src/shell/crafting-menu.ts |
| call     | EndItemRename       | done   | src/shell/crafting-menu.ts |
| call     | PlaySound           | done   | src/shell/play-mode.ts     |
| call     | SetSelectedCategory | done   | src/shell/crafting-menu.ts |
| call     | SetSelectedItem     | done   | src/shell/crafting-menu.ts |
| call     | ShowItem3D          | done   | src/shell/crafting-menu.ts |
| call     | SliderClose         | done   | src/shell/crafting-menu.ts |
| call     | StartMouseRotation  | done   | src/shell/crafting-menu.ts |
| call     | StopMouseRotation   | done   | src/shell/crafting-menu.ts |
| call     | myLog               | done   | src/shell/play-mode.ts     |
| callback | InvalidateListData  | done   | src/shell/crafting-menu.ts |
| callback | SetButtonMapping    | done   | src/ui/menu-host.ts        |
| callback | SetCategoriesList   | done   | src/shell/crafting-menu.ts |

### creditsmenu.swf

| Kind | Name  | Status | Where / reason         |
| ---- | ----- | ------ | ---------------------- |
| call | myLog | done   | src/shell/play-mode.ts |

### dialoguemenu.swf

| Kind     | Name                 | Status | Where / reason                                          |
| -------- | -------------------- | ------ | ------------------------------------------------------- |
| call     | CloseMenu            | done   | src/shell/dialogue-menu.ts                              |
| call     | FadeDone             | done   | src/shell/dialogue-menu.ts                              |
| call     | SkipText             | done   | src/shell/dialogue-menu.ts                              |
| call     | TopicClicked         | done   | src/shell/dialogue-menu.ts                              |
| call     | myLog                | done   | src/shell/play-mode.ts                                  |
| callback | AdjustForPALSD       | n/a    | the original engine has no such name: it never sends it |
| callback | Cancel               | open   |                                                         |
| callback | HideDialogueText     | done   | src/shell/dialogue-menu.ts                              |
| callback | NotifyVoiceReady     | done   | src/shell/dialogue-menu.ts                              |
| callback | PopulateDialogueList | done   | src/shell/dialogue-menu.ts                              |
| callback | SetButtonMapping     | done   | src/ui/menu-host.ts                                     |
| callback | SetSpeakerName       | done   | src/shell/dialogue-menu.ts                              |
| callback | ShowDialogueList     | done   | src/shell/dialogue-menu.ts                              |
| callback | ShowDialogueText     | done   | src/shell/dialogue-menu.ts                              |
| callback | StartHideMenu        | done   | src/shell/dialogue-menu.ts                              |

### fadermenu.swf

| Kind     | Name       | Status | Where / reason          |
| -------- | ---------- | ------ | ----------------------- |
| call     | FadeDone   | done   | src/shell/fader-menu.ts |
| callback | InitFade   | done   | src/shell/fader-menu.ts |
| callback | UpdateFade | done   | src/shell/fader-menu.ts |

### favoritesmenu.swf

| Kind     | Name            | Status | Where / reason                                          |
| -------- | --------------- | ------ | ------------------------------------------------------- |
| call     | FadeDone        | done   | src/shell/favorites-menu.ts                             |
| call     | ItemSelect      | done   | src/shell/favorites-menu.ts                             |
| call     | PlaySound       | done   | src/shell/play-mode.ts                                  |
| callback | PopulateItems   | n/a    | the original engine has no such name: it never sends it |
| callback | SetSelectedItem | open   |                                                         |
| callback | StartFadeOut    | open   |                                                         |

### giftmenu.swf

| Kind     | Name                | Status | Where / reason         |
| -------- | ------------------- | ------ | ---------------------- |
| call     | CloseMenu           | done   | src/shell/item-menu.ts |
| call     | DisabledItemSelect  | done   | src/shell/item-menu.ts |
| call     | ItemSelect          | done   | src/shell/item-menu.ts |
| call     | PlaySound           | done   | src/shell/play-mode.ts |
| call     | QuantitySliderOpen  | done   | src/shell/item-menu.ts |
| call     | RequestItemCardInfo | done   | src/shell/item-menu.ts |
| call     | SaveIndices         | done   | src/shell/item-menu.ts |
| call     | StartMouseRotation  | done   | src/shell/item-menu.ts |
| call     | StopMouseRotation   | done   | src/shell/item-menu.ts |
| call     | UpdateItem3D        | done   | src/shell/item-menu.ts |
| call     | ZoomItemModel       | done   | src/shell/item-menu.ts |
| call     | myLog               | done   | src/shell/play-mode.ts |
| callback | InvalidateListData  | done   | src/shell/item-menu.ts |
| callback | RestoreIndices      | done   | src/shell/item-menu.ts |
| callback | SetButtonMapping    | done   | src/ui/menu-host.ts    |
| callback | SetCategoriesList   | done   | src/shell/item-menu.ts |
| callback | SetMenuInfo         | done   | src/shell/gift-menu.ts |
| callback | ToggleMenuFade      | done   | src/shell/item-3d.ts   |
| callback | UpdateItemCardInfo  | done   | src/shell/item-menu.ts |
| callback | UpdatePlayerInfo    | done   | src/shell/item-menu.ts |

### hudmenu.swf

| Kind     | Name                        | Status | Where / reason                                                                          |
| -------- | --------------------------- | ------ | --------------------------------------------------------------------------------------- |
| call     | GetButtonFromUserEvent      | done   | src/shell/play-mode.ts                                                                  |
| call     | PlaySound                   | done   | src/shell/play-mode.ts                                                                  |
| call     | RegisterHUDComponents       | done   | src/shell/hud-controller.ts                                                             |
| call     | myLog                       | done   | src/shell/play-mode.ts                                                                  |
| callback | FadeOutChargeMeters         | done   | src/shell/hud-controller.ts                                                             |
| callback | FadeOutStamina              | done   | src/shell/hud-controller.ts                                                             |
| callback | FlashShoutMeter             | done   | src/shell/hud-controller.ts                                                             |
| callback | HideSubtitle                | done   | src/shell/hud-controller.ts                                                             |
| callback | SetChargeMeterPercent       | done   | src/shell/hud-controller.ts                                                             |
| callback | SetCompassAngle             | done   | src/shell/hud-controller.ts                                                             |
| callback | SetCompassMarkers           | done   | src/shell/hud-controller.ts                                                             |
| callback | SetCompassTemperature       | open   | the engine has no such name; whether Survival Mode's scripts send it is not checked     |
| callback | SetCrosshairEnabled         | done   | src/shell/hud-controller.ts                                                             |
| callback | SetCrosshairTarget          | done   | src/shell/hud-controller.ts                                                             |
| callback | SetEnemyHealthPercent       | done   | src/shell/hud-controller.ts                                                             |
| callback | SetEnemyHealthTargetPercent | done   | src/shell/hud-controller.ts                                                             |
| callback | SetHealthMeterPercent       | done   | src/shell/hud-controller.ts (SetMeterPercent)                                           |
| callback | SetLoadDoorInfo             | done   | src/shell/hud-controller.ts                                                             |
| callback | SetLocationName             | done   | src/shell/hud-controller.ts                                                             |
| callback | SetMagickaMeterPercent      | done   | src/shell/hud-controller.ts (SetMeterPercent)                                           |
| callback | SetShoutMeterPercent        | done   | src/shell/hud-controller.ts                                                             |
| callback | SetStaminaMeterPercent      | done   | src/shell/hud-controller.ts (SetMeterPercent)                                           |
| callback | SetSubtitlesEnabled         | done   | src/shell/hud-controller.ts                                                             |
| callback | ShowElements                | done   | src/shell/hud-controller.ts                                                             |
| callback | ShowMessage                 | done   | src/shell/hud-controller.ts                                                             |
| callback | ShowNotification            | done   | src/shell/hud-controller.ts                                                             |
| callback | ShowSubtitle                | done   | src/shell/hud-controller.ts                                                             |
| callback | ShowTutorialHintText        | done   | src/shell/hud-controller.ts                                                             |
| callback | StartMagickaMeterBlinking   | done   | src/shell/hud-controller.ts                                                             |
| callback | StartStaminaMeterBlinking   | done   | src/shell/hud-controller.ts                                                             |
| callback | ValidateCrosshair           | open   | sent while a spell is aimed (the caster checks each effect at the aim point), not built |

### inventory components\bottombar.swf

| Kind     | Name             | Status | Where / reason         |
| -------- | ---------------- | ------ | ---------------------- |
| call     | myLog            | done   | src/shell/play-mode.ts |
| callback | SetButtonMapping | done   | src/ui/menu-host.ts    |

### inventory components\inventorylists.swf

| Kind     | Name               | Status | Where / reason             |
| -------- | ------------------ | ------ | -------------------------- |
| call     | PlaySound          | done   | src/shell/play-mode.ts     |
| call     | myLog              | done   | src/shell/play-mode.ts     |
| callback | InvalidateListData | done   | src/shell/crafting-menu.ts |
| callback | SetCategoriesList  | done   | src/shell/crafting-menu.ts |

### inventory components\invertedinventorylists.swf

| Kind     | Name               | Status | Where / reason         |
| -------- | ------------------ | ------ | ---------------------- |
| call     | PlaySound          | done   | src/shell/play-mode.ts |
| callback | InvalidateListData | done   | src/shell/item-menu.ts |
| callback | SetCategoriesList  | done   | src/shell/item-menu.ts |

### inventory components\itemcard.swf

| Kind | Name      | Status | Where / reason         |
| ---- | --------- | ------ | ---------------------- |
| call | PlaySound | done   | src/shell/play-mode.ts |
| call | myLog     | done   | src/shell/play-mode.ts |

### inventorymenu.swf

| Kind     | Name                 | Status | Where / reason         |
| -------- | -------------------- | ------ | ---------------------- |
| call     | CheckForMouseEquip   | done   | src/shell/item-menu.ts |
| call     | CloseMenu            | done   | src/shell/item-menu.ts |
| call     | CloseTweenMenu       | done   | src/shell/item-menu.ts |
| call     | DisabledItemSelect   | done   | src/shell/item-menu.ts |
| call     | ItemCardListCallback | done   | src/shell/item-menu.ts |
| call     | ItemDrop             | done   | src/shell/item-menu.ts |
| call     | ItemSelect           | done   | src/shell/item-menu.ts |
| call     | PlaySound            | done   | src/shell/play-mode.ts |
| call     | QuantitySliderOpen   | done   | src/shell/item-menu.ts |
| call     | RequestItemCardInfo  | done   | src/shell/item-menu.ts |
| call     | SaveIndices          | done   | src/shell/item-menu.ts |
| call     | ShowSoulGemList      | done   | src/shell/item-menu.ts |
| call     | ShowTweenMenu        | done   | src/shell/item-menu.ts |
| call     | StartMouseRotation   | done   | src/shell/item-menu.ts |
| call     | StopMouseRotation    | done   | src/shell/item-menu.ts |
| call     | UpdateItem3D         | done   | src/shell/item-menu.ts |
| call     | ZoomItemModel        | done   | src/shell/item-menu.ts |
| call     | myLog                | done   | src/shell/play-mode.ts |
| callback | AttemptChargeItem    | done   | src/shell/item-menu.ts |
| callback | AttemptEquip         | done   | src/shell/item-menu.ts |
| callback | DropItem             | done   | src/shell/item-menu.ts |
| callback | InvalidateListData   | done   | src/shell/item-menu.ts |
| callback | ItemRotating         | done   | src/shell/item-3d.ts   |
| callback | RestoreIndices       | done   | src/shell/item-menu.ts |
| callback | SetButtonMapping     | done   | src/ui/menu-host.ts    |
| callback | SetCategoriesList    | done   | src/shell/item-menu.ts |
| callback | ToggleMenuFade       | done   | src/shell/item-3d.ts   |
| callback | UpdateItemCardInfo   | done   | src/shell/item-menu.ts |
| callback | UpdatePlayerInfo     | done   | src/shell/item-menu.ts |

### levelupmenu.swf

| Kind | Name       | Status | Where / reason             |
| ---- | ---------- | ------ | -------------------------- |
| call | PlaySound  | done   | src/shell/play-mode.ts     |
| call | addHealth  | done   | src/shell/level-up-menu.ts |
| call | addMagicka | done   | src/shell/level-up-menu.ts |
| call | addStamina | done   | src/shell/level-up-menu.ts |

### loadingmenu.swf

| Kind | Name               | Status | Where / reason            |
| ---- | ------------------ | ------ | ------------------------- |
| call | RequestLoadingText | done   | src/shell/play-mode.ts    |
| call | RequestPlayerInfo  | done   | src/shell/journal-menu.ts |

### lockpickingmenu.swf

| Kind     | Name                          | Status | Where / reason                                          |
| -------- | ----------------------------- | ------ | ------------------------------------------------------- |
| call     | myLog                         | done   | src/shell/play-mode.ts                                  |
| callback | SetLockInfo                   | done   | src/shell/lockpicking-menu.ts                           |
| callback | SetPickMinMax                 | done   | src/shell/lockpicking-menu.ts                           |
| callback | ToggleDebugMode               | n/a    | the original engine has no such name: it never sends it |
| callback | UpdateLockAngle               | done   | src/shell/lockpicking-menu.ts                           |
| callback | UpdateLockPickingButtonPrompt | n/a    | the Switch only (its NXArt)                             |
| callback | UpdatePickAngle               | done   | src/shell/lockpicking-menu.ts                           |
| callback | UpdatePickHealth              | done   | src/shell/lockpicking-menu.ts                           |
| callback | UpdateSweetSpot               | done   | src/shell/lockpicking-menu.ts                           |

### magicmenu.swf

| Kind     | Name                | Status | Where / reason         |
| -------- | ------------------- | ------ | ---------------------- |
| call     | CloseMenu           | done   | src/shell/item-menu.ts |
| call     | CloseTweenMenu      | done   | src/shell/item-menu.ts |
| call     | DisabledItemSelect  | done   | src/shell/item-menu.ts |
| call     | ItemSelect          | done   | src/shell/item-menu.ts |
| call     | PlaySound           | done   | src/shell/play-mode.ts |
| call     | RequestItemCardInfo | done   | src/shell/item-menu.ts |
| call     | SaveIndices         | done   | src/shell/item-menu.ts |
| call     | ShowShoutFail       | done   | src/shell/item-menu.ts |
| call     | ShowTweenMenu       | done   | src/shell/item-menu.ts |
| call     | StartMouseRotation  | done   | src/shell/item-menu.ts |
| call     | StopMouseRotation   | done   | src/shell/item-menu.ts |
| call     | UpdateItem3D        | done   | src/shell/item-menu.ts |
| call     | ZoomItemModel       | done   | src/shell/item-menu.ts |
| call     | myLog               | done   | src/shell/play-mode.ts |
| callback | AttemptEquip        | done   | src/shell/item-menu.ts |
| callback | DragonSoulSpent     | done   | src/shell/item-menu.ts |
| callback | InvalidateListData  | done   | src/shell/item-menu.ts |
| callback | RestoreIndices      | done   | src/shell/item-menu.ts |
| callback | SetButtonMapping    | done   | src/ui/menu-host.ts    |
| callback | SetCategoriesList   | done   | src/shell/item-menu.ts |
| callback | ToggleMenuFade      | done   | src/shell/item-3d.ts   |
| callback | UpdateItemCardInfo  | done   | src/shell/item-menu.ts |
| callback | UpdatePlayerInfo    | done   | src/shell/item-menu.ts |

### map.swf

| Kind     | Name                            | Status | Where / reason                                   |
| -------- | ------------------------------- | ------ | ------------------------------------------------ |
| call     | ClickCallback                   | done   | src/shell/map-menu.ts                            |
| call     | CurrentLocationCallback         | done   | src/shell/map-menu.ts                            |
| call     | GetMouseButtonForSetDestination | n/a    | the Switch with a mouse only (PLATFORM_NX_MOUSE) |
| call     | MarkerClick                     | done   | src/shell/map-menu.ts                            |
| call     | OpenJournalCallback             | done   | src/shell/map-menu.ts                            |
| call     | PlaySound                       | done   | src/shell/play-mode.ts                           |
| call     | SetLocalMapExtents              | done   | src/shell/map-menu.ts                            |
| call     | ToggleMapCallback               | done   | src/shell/map-menu.ts                            |
| call     | myLog                           | done   | src/shell/play-mode.ts                           |
| callback | ClickSelectedMarker             | done   | src/shell/map-menu.ts                            |
| callback | RefreshMarkers                  | done   | src/shell/local-map.ts                           |
| callback | SetDateString                   | done   | src/shell/map-menu.ts                            |
| callback | SetSelectedMarker               | done   | src/shell/local-map.ts                           |
| callback | ShowJournal                     | done   | src/shell/map-menu.ts                            |

### messagebox.swf

| Kind     | Name             | Status | Where / reason             |
| -------- | ---------------- | ------ | -------------------------- |
| call     | PlaySound        | done   | src/shell/play-mode.ts     |
| call     | buttonPress      | done   | src/shell/message-boxes.ts |
| callback | setButtons       | done   | src/shell/message-boxes.ts |
| callback | setIsCancellable | done   | src/shell/message-boxes.ts |
| callback | setIsVertical    | open   |                            |
| callback | setMessageText   | done   | src/shell/message-boxes.ts |

### quest_journal.swf

| Kind     | Name                          | Status | Where / reason                                                                                              |
| -------- | ----------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| call     | CharacterSelected             | done   | src/shell/save-list.ts                                                                                      |
| call     | CloseMenu                     | done   | src/shell/journal-menu.ts                                                                                   |
| call     | DeleteSave                    | done   | src/shell/save-list.ts                                                                                      |
| call     | ForceStopSaveListLoading      | done   | src/shell/save-list.ts                                                                                      |
| call     | GetButtonFromUserEvent        | done   | src/shell/play-mode.ts                                                                                      |
| call     | IsOKtoLoad                    | done   | src/shell/save-list.ts                                                                                      |
| call     | LOAD                          | done   | src/shell/save-list.ts                                                                                      |
| call     | LoadGame                      | done   | src/shell/save-list.ts                                                                                      |
| call     | ModManager                    | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4)                                |
| call     | ORBISDeleteSave               | n/a    | consoles only (PlayStation, Xbox, Switch)                                                                   |
| call     | OpenKinectTuner               | n/a    | consoles only (PlayStation, Xbox, Switch)                                                                   |
| call     | OptionChange                  | done   | src/shell/journal-settings.ts                                                                               |
| call     | PlaySound                     | done   | src/shell/play-mode.ts                                                                                      |
| call     | PopulateCharacterList         | done   | src/shell/save-list.ts                                                                                      |
| call     | PopulateCreationClubTopics    | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4)                                |
| call     | PopulateHelpTopics            | done   | src/shell/journal-menu.ts                                                                                   |
| call     | PrepSaveGameScreenshot        | done   | src/shell/save-list.ts                                                                                      |
| call     | QuickSave                     | done   | src/shell/journal-menu.ts                                                                                   |
| call     | QuitToDesktop                 | done   | src/shell/journal-menu.ts                                                                                   |
| call     | QuitToMainMenu                | done   | src/shell/journal-menu.ts                                                                                   |
| call     | RememberCurrentTabIndex       | done   | src/shell/journal-menu.ts                                                                                   |
| call     | RequestAudioOptions           | done   | src/shell/journal-settings.ts                                                                               |
| call     | RequestCreationClubText       | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4)                                |
| call     | RequestDisplayOptions         | done   | src/shell/journal-settings.ts                                                                               |
| call     | RequestGameplayOptions        | done   | src/shell/journal-settings.ts                                                                               |
| call     | RequestHelpText               | done   | src/shell/journal-menu.ts                                                                                   |
| call     | RequestInputMappings          | done   | src/shell/journal-controls.ts                                                                               |
| call     | RequestIsOnPC                 | done   | src/shell/journal-menu.ts                                                                                   |
| call     | RequestObjectivesData         | done   | src/shell/journal-menu.ts                                                                                   |
| call     | RequestPlayerInfo             | done   | src/shell/journal-menu.ts                                                                                   |
| call     | RequestQuestsData             | done   | src/shell/journal-menu.ts                                                                                   |
| call     | ResetControlsToDefaults       | done   | src/shell/journal-controls.ts                                                                               |
| call     | ResetControlsToDefaults_Ounce | done   | src/shell/journal-controls.ts                                                                               |
| call     | SAVE                          | done   | src/shell/save-list.ts                                                                                      |
| call     | SaveControls                  | done   | src/shell/journal-controls.ts                                                                               |
| call     | SaveGame                      | done   | src/shell/journal-menu.ts                                                                                   |
| call     | SaveSettings                  | done   | src/shell/journal-settings.ts                                                                               |
| call     | SetSaveDisabled               | done   | src/shell/journal-menu.ts                                                                                   |
| call     | SetVersionText                | done   | src/shell/journal-menu.ts                                                                                   |
| call     | ShouldShowKinectTunerOption   | done   | src/shell/journal-menu.ts                                                                                   |
| call     | ShouldShowMod                 | done   | src/shell/journal-menu.ts                                                                                   |
| call     | ShowTargetOnMap               | done   | src/shell/journal-menu.ts                                                                                   |
| call     | StartRemapMode                | done   | src/shell/journal-controls.ts                                                                               |
| call     | ToggleQuestActiveStatus       | done   | src/shell/journal-menu.ts                                                                                   |
| call     | ToggleShowMiscObjectives      | done   | src/shell/journal-menu.ts                                                                                   |
| call     | UseCurrentCharacterFilter     | done   | src/shell/save-list.ts                                                                                      |
| call     | myLog                         | done   | src/shell/play-mode.ts                                                                                      |
| call     | updateStats                   | done   | src/shell/journal-menu.ts                                                                                   |
| callback | BackOutFromLoadGame           | open   |                                                                                                             |
| callback | ConfirmOKToLoad               | done   | src/shell/save-list.ts                                                                                      |
| callback | FinishRemapMode               | done   | src/shell/journal-controls.ts                                                                               |
| callback | HideMenu                      | n/a    | observed in the original: the engine calls HideMenu in the tween menu only (the journal is never hidden so) |
| callback | OnSaveDataEventLoadCANCEL     | n/a    | consoles only (PlayStation, Xbox, Switch)                                                                   |
| callback | OnSaveDataEventSaveCANCEL     | n/a    | consoles only (PlayStation, Xbox, Switch)                                                                   |
| callback | OnSaveDataEventSaveSUCCESS    | n/a    | consoles only (PlayStation, Xbox, Switch)                                                                   |
| callback | RefreshSystemButtons          | open   |                                                                                                             |
| callback | RestoreSavedSettings          | done   | src/shell/journal-menu.ts                                                                                   |
| callback | ScreenshotReady               | done   | src/shell/save-list.ts                                                                                      |
| callback | SetButtonMapping              | done   | src/ui/menu-host.ts                                                                                         |
| callback | SetRemoteDevice               | n/a    | consoles only (PlayStation, Xbox, Switch)                                                                   |
| callback | SettingsSaved                 | done   | src/shell/journal-controls.ts                                                                               |
| callback | ShowMenu                      | open   |                                                                                                             |
| callback | StartCloseMenu                | done   | src/shell/journal-menu.ts                                                                                   |
| callback | UpdatePermissions             | n/a    | consoles only (PlayStation, Xbox, Switch)                                                                   |
| callback | onFillCharacterListComplete   | done   | src/shell/save-list.ts                                                                                      |
| callback | onRightStickInput             | open   |                                                                                                             |
| callback | onSaveLoadBatchComplete       | done   | src/shell/save-list.ts                                                                                      |

### racesex_menu.swf

| Kind     | Name                  | Status | Where / reason                                          |
| -------- | --------------------- | ------ | ------------------------------------------------------- |
| call     | ChangeDoubleMorph     | done   | src/gameplay/chargen.ts                                 |
| call     | ChangeFaceDetails     | done   | src/gameplay/chargen.ts                                 |
| call     | ChangeHairColorPreset | done   | src/gameplay/chargen.ts                                 |
| call     | ChangeHeadPart        | done   | src/gameplay/chargen.ts                                 |
| call     | ChangeHeadPreset      | done   | src/gameplay/chargen.ts                                 |
| call     | ChangeName            | done   | src/shell/race-menu.ts                                  |
| call     | ChangePreset          | done   | src/gameplay/chargen.ts                                 |
| call     | ChangeRace            | done   | src/shell/race-menu.ts                                  |
| call     | ChangeTintingMask     | done   | src/gameplay/chargen.ts                                 |
| call     | ChangeWeight          | done   | src/gameplay/chargen.ts                                 |
| call     | ConfirmDone           | done   | src/shell/race-menu.ts                                  |
| call     | PlaySound             | done   | src/shell/play-mode.ts                                  |
| call     | SetAllowTextInput     | done   | src/shell/race-menu.ts                                  |
| call     | ShowVirtualKeyboard   | done   | src/shell/race-menu.ts                                  |
| call     | ZoomPC                | done   | src/shell/race-menu.ts                                  |
| call     | myLog                 | done   | src/shell/play-mode.ts                                  |
| callback | FadeOut               | done   | src/shell/race-menu.ts                                  |
| callback | HideLoadingIcon       | done   | src/shell/race-menu.ts                                  |
| callback | SetCategoriesList     | done   | src/shell/race-menu.ts                                  |
| callback | SetNameText           | done   | src/shell/race-menu.ts                                  |
| callback | SetOptionSliders      | done   | src/shell/race-menu.ts                                  |
| callback | SetRaceList           | done   | src/shell/race-menu.ts                                  |
| callback | SetRaceText           | done   | src/shell/race-menu.ts                                  |
| callback | ShowTextEntry         | done   | src/shell/race-menu.ts                                  |
| callback | ShowTextEntryField    | done   | src/shell/race-menu.ts                                  |
| callback | moveCategoriesUp      | n/a    | the original engine has no such name: it never sends it |

### sleepwaitmenu.swf

| Kind | Name      | Status | Where / reason               |
| ---- | --------- | ------ | ---------------------------- |
| call | Cancel    | done   | src/shell/sleep-wait-menu.ts |
| call | OK        | done   | src/shell/sleep-wait-menu.ts |
| call | PlaySound | done   | src/shell/play-mode.ts       |
| call | myLog     | done   | src/shell/play-mode.ts       |

### startmenu.swf

| Kind     | Name                             | Status | Where / reason                                                               |
| -------- | -------------------------------- | ------ | ---------------------------------------------------------------------------- |
| call     | ActivateJoyConStrapInstruction   | n/a    | consoles only (PlayStation, Xbox, Switch)                                    |
| call     | CONTINUE                         | done   | src/shell/play-mode.ts                                                       |
| call     | ChangeUser                       | n/a    | consoles only (PlayStation, Xbox, Switch)                                    |
| call     | CharacterSelected                | done   | src/shell/save-list.ts                                                       |
| call     | CreationClub                     | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4) |
| call     | DeleteSave                       | done   | src/shell/save-list.ts                                                       |
| call     | DoDeleteSaveUISanityCheck        | done   | src/shell/play-mode.ts                                                       |
| call     | DoLoadDLCPlugins                 | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4) |
| call     | DownloadAll                      | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4) |
| call     | EndPressStartState               | done   | src/shell/play-mode.ts                                                       |
| call     | FirstTimeOunceDataTransferCheck  | n/a    | consoles only (PlayStation, Xbox, Switch)                                    |
| call     | ForceStopSaveListLoading         | done   | src/shell/save-list.ts                                                       |
| call     | HELP                             | done   | src/shell/play-mode.ts                                                       |
| call     | IsOKtoLoad                       | done   | src/shell/save-list.ts                                                       |
| call     | LoadDLC                          | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4) |
| call     | MOD                              | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4) |
| call     | NEW                              | done   | src/shell/play-mode.ts                                                       |
| call     | ORBISDeleteSave                  | n/a    | consoles only (PlayStation, Xbox, Switch)                                    |
| call     | OnDisabledLoadPress              | done   | src/shell/play-mode.ts                                                       |
| call     | OnOunceDataTransfer              | n/a    | consoles only (PlayStation, Xbox, Switch)                                    |
| call     | OnPS5DataTransfer                | n/a    | consoles only (PlayStation, Xbox, Switch)                                    |
| call     | OpenMarketplace                  | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4) |
| call     | PlaySound                        | done   | src/shell/play-mode.ts                                                       |
| call     | PopulateCharacterList            | done   | src/shell/save-list.ts                                                       |
| call     | PrepSaveGameScreenshot           | done   | src/shell/save-list.ts                                                       |
| call     | QuitToDesktop                    | done   | src/shell/journal-menu.ts                                                    |
| call     | QuitToMainMenu                   | done   | src/shell/journal-menu.ts                                                    |
| call     | Sky10DLCPressed                  | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4) |
| call     | StartState                       | done   | src/shell/play-mode.ts                                                       |
| call     | currentState                     | done   | src/shell/play-mode.ts                                                       |
| call     | fadeOutStarted                   | done   | src/shell/play-mode.ts                                                       |
| call     | myLog                            | done   | src/shell/play-mode.ts                                                       |
| callback | ConfirmContinue                  | done   | src/shell/play-mode.ts                                                       |
| callback | ConfirmNewGame                   | done   | src/shell/play-mode.ts                                                       |
| callback | ConfirmOKToLoad                  | done   | src/shell/save-list.ts                                                       |
| callback | DoneLoadingDLC                   | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4) |
| callback | ExitJoyConStrapInstructionScreen | n/a    | consoles only (PlayStation, Xbox, Switch)                                    |
| callback | FadeInMenu                       | done   | src/shell/play-mode.ts                                                       |
| callback | FadeOutMenu                      | done   | src/shell/play-mode.ts                                                       |
| callback | OnDeleteSaveUISanityCheck        | done   | src/shell/play-mode.ts                                                       |
| callback | OnSaveDataEventLoadCANCEL        | n/a    | consoles only (PlayStation, Xbox, Switch)                                    |
| callback | OnSaveDataEventLoadSUCCESS       | n/a    | consoles only (PlayStation, Xbox, Switch)                                    |
| callback | ScreenshotReady                  | done   | src/shell/save-list.ts                                                       |
| callback | SetFirstExitedMenu               | n/a    | the original engine has no such name: it never sends it                      |
| callback | ShowGamerTagAndIcon              | n/a    | consoles only (PlayStation, Xbox, Switch)                                    |
| callback | StartLoadingDLC                  | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4) |
| callback | onFillCharacterListComplete      | done   | src/shell/save-list.ts                                                       |
| callback | onProfileChange                  | n/a    | consoles only (PlayStation, Xbox, Switch)                                    |
| callback | onSaveLoadBatchComplete          | done   | src/shell/save-list.ts                                                       |
| callback | onStartButtonProcessFinished     | open   |                                                                              |
| callback | sendMenuProperties               | done   | src/shell/play-mode.ts                                                       |

### statsmenu.swf

| Kind     | Name                    | Status | Where / reason                                          |
| -------- | ----------------------- | ------ | ------------------------------------------------------- |
| call     | MoveCamera              | done   | src/shell/skills-menu.ts                                |
| call     | SetFadedIn              | done   | src/shell/skills-menu.ts                                |
| call     | myLog                   | done   | src/shell/play-mode.ts                                  |
| callback | HideRing                | done   | src/shell/skills-menu.ts                                |
| callback | SetDescriptionCard      | done   | src/shell/skills-menu.ts                                |
| callback | SetDirection            | done   | src/shell/skills-menu.ts                                |
| callback | SetPerkCount            | n/a    | the original engine has no such name: it never sends it |
| callback | SetPlayerInfo           | done   | src/shell/skills-menu.ts                                |
| callback | SetStatsMode            | done   | src/shell/skills-menu.ts                                |
| callback | ShowLegendaryButtonHint | done   | src/shell/skills-menu.ts                                |
| callback | UpdateSkillList         | done   | src/shell/skills-menu.ts                                |

### textentry.swf

| Kind | Name  | Status | Where / reason         |
| ---- | ----- | ------ | ---------------------- |
| call | myLog | done   | src/shell/play-mode.ts |

### trainingmenu.swf

| Kind | Name  | Status | Where / reason             |
| ---- | ----- | ------ | -------------------------- |
| call | Exit  | done   | src/shell/training-menu.ts |
| call | Train | done   | src/shell/training-menu.ts |
| call | myLog | done   | src/shell/play-mode.ts     |

### tutorialmenu.swf

| Kind     | Name                   | Status | Where / reason             |
| -------- | ---------------------- | ------ | -------------------------- |
| call     | CloseMenu              | done   | src/shell/tutorial-menu.ts |
| call     | GetButtonFromUserEvent | done   | src/shell/play-mode.ts     |
| call     | myLog                  | done   | src/shell/play-mode.ts     |
| callback | SetButtonMapping       | done   | src/ui/menu-host.ts        |

### tweenmenu.swf

| Kind     | Name                | Status | Where / reason             |
| -------- | ------------------- | ------ | -------------------------- |
| call     | CloseMenu           | done   | src/shell/crafting-menu.ts |
| call     | HighlightMenu       | done   | src/shell/game-menus.ts    |
| call     | OpenAnimFinished    | done   | src/shell/game-menus.ts    |
| call     | OpenHighlightedMenu | done   | src/shell/game-menus.ts    |
| call     | StartCloseMenu      | done   | src/shell/game-menus.ts    |
| call     | myLog               | done   | src/shell/play-mode.ts     |
| callback | HideMenu            | done   | src/shell/game-menus.ts    |
| callback | ResetStatsButton    | done   | src/shell/game-menus.ts    |
| callback | ShowMenu            | done   | src/shell/game-menus.ts    |
| callback | StartCloseMenuAnim  | done   | src/shell/game-menus.ts    |
| callback | StartOpenMenuAnim   | done   | src/shell/game-menus.ts    |

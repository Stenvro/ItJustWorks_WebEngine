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

## Counts (2026-10-31)

| Part                             | Items | Done | Open | n/a |
| -------------------------------- | ----: | ---: | ---: | --: |
| Movies                           |    50 |   35 |    0 |  15 |
| GameDelegate calls and callbacks |   425 |  385 |    0 |  40 |
| Menu names the original opens    |    41 |   30 |    0 |  11 |
| Behaviour items (below)          |    46 |   41 |    0 |   5 |
| All                              |   562 |  491 |    0 |  71 |

Some behaviour items name calls the sweep also lists (they say what is still missing around
them). The movies' `ExternalInterface.call("__handleEvent")` (CLIK's sound and focus events) is answered
by the bridge for every movie and is not counted per movie.

## Behaviour checklist

Things a name sweep cannot see: what the engine does around the calls, values it pushes by
path (GFx Invoke and SetVariable), keys and gamepad paths, and the player's own reports.

| Item                                                                                     | Status | Where / reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main menu Load: characters, then their saves; load, delete                               | done   | src/shell/save-list.ts, src/shell/play-mode.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Journal Load's character list (PopulateCharacterList, CharacterSelected)                 | done   | src/shell/save-list.ts, src/shell/journal-menu.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Journal Save and Load list the character playing                                         | done   | src/shell/save-list.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SetButtonMapping to every movie that registers it (keyboard and mouse)                   | done   | src/ui/menu-host.ts, src/ui/button-art.ts (buttonMappings)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| SetButtonMapping sent again after a remap or a reset                                     | done   | src/shell/journal-controls.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A menu's movie read from interface\exported\<name>.gfx when its .swf is missing          | done   | src/ui/movie-file.ts (movieFile)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| HUD MovementDisabled mode                                                                | done   | src/shell/hud-elements.ts (movementDisabledStep), src/shell/hud-controller.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| HUD CartMode, HorseMode, WarHorseMode                                                    | done   | src/shell/hud-elements.ts (rideModes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Menu stack with the original's IMenu flags, saving permission, UI.IsMenuOpen             | done   | src/ui/menu-stack.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Gamepad: contexts, GFx gamepad keys, remap, live SetPlatform                             | done   | src/shell/gamepad-input.ts, src/ui/input-platform.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| SetButtonMapping with a gamepad (the gamepad's bindings, their art names)                | done   | src/ui/button-art.ts (buttonMappings, parseButtonNames: the names of interface\controls\pc\gamepad.txt), src/shell/play-mode.ts (sent again as the device in use changes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Save screenshots (PrepSaveGameScreenshot, ScreenshotReady)                               | done   | src/shell/save-screenshot.ts, src/shell/save-list.ts, src/render/renderer.ts (captureFrame)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| The map's relief overlay                                                                 | done   | lighting.wgsl worldMapRelief, src/shell/world-map-view.ts (rendering's); seen in a headless run with the map open. Its weights and snow mask are inferred: docs/completeness/rendering.md                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| The lockpicking strings the maintainer saw                                               | done   | the bar is the movie's own: SetLockInfo's level name after its translated "$Lock Level" ("Lock Level: Novice") and the picks after "$Lockpicks Left" ("Lockpicks Left: 12", ": 99+" above 99), both keys in translate_english.txt and replaced as the movie loads (src/ui/translate-movie.ts); src/shell/lockpicking-menu.ts sends the level name (sLockLevelName*) and the count. On screen: these two lines under the skill meter                                                                                                                                                                                                                                                                                                                                                                             |
| Lockpicking debug display (UpdatePickAngle, UpdateLockAngle, UpdateSweetSpot, ...)       | done   | src/shell/lockpicking-menu.ts: SetPickMinMax as it is made, UpdateSweetSpot as it shows, the angles and the pick's health as they change (the display shows only after ToggleDebugMode, which the engine never sends)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Controls page: the left/right swap the maintainer saw                                    | done   | as the original: translate_english.txt names $Left Attack/Block "Left Hand" and $Right Attack/Block "Right Hand", and the control map binds the left hand to the right mouse button (Mouse2, "Right Click") and the right hand to the left (Mouse1): the page shows "Left Hand: Right Click", "Right Hand: Left Click" (src/shell/journal-controls.ts, src/ui/button-art.ts). On screen: those two rows                                                                                                                                                                                                                                                                                                                                                                                                         |
| Ruffle: scale9Grid not drawn                                                             | done   | Ruffle 0.7.1 does not slice them (seen on screen); src/ui/scale9.ts cuts every grid sprite's shapes, nested clips' too, as it scales (docs/ui.md, "Ruffle's limits")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Ruffle's scale9Grid: below the corners' size, turned grid sprites, content moving        | done   | src/ui/scale9.ts: the corners shrink together below their size (scale9Axis, Flash's rule); a sprite's scale along its own axes; wrappers that moved placed again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Ruffle's scale9Grid: a shape turned within its grid sprite                               | done   | no movie has one: tests/interface.int.test.ts sweeps every grid sprite (and the sprites under it) of every movie, none places a shape or clip turned or skewed; the scripts turn only whole clips at or above their grid sprites (the map's markers, CLIK's scroll bars), which src/ui/scale9.ts measures along their own axes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Ruffle's scale9Grid: grids set at run time on clips without shapes                       | done   | src/ui/scale9.ts: MovieClip's scale9Grid is ours (the setter registers the clip as a grid sprite, null takes the grid away, the getter gives the rectangle); a movie whose scripts set it (quest_journal.swf, tutorialmenu.swf: CLIK's CoreList and TextArea give the container they attach their renderers and scroll bar into a 1 × 1 grid) gets the property in an init action before its own scripts and the shapes of every sprite it exports wrapped, so what is attached under such a container is cut as Scaleform cuts it; the components counter-scale the container, so only a scaled ancestor shows it (src/ui/scale9.test.ts, tests/interface.int.test.ts)                                                                                                                                         |
| Ruffle: the "Times New Roman" device font                                                | done   | src/ui/movie-patches.ts (patchDeviceFonts): a device font the font library lacks draws no text, as the original has no system font provider; hudmenu.swf's one empty field is the only one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Item menus' ToggleMenuFade (the menu fades out and back)                                 | done   | src/shell/item-3d.ts: as a zoom starts (ZoomItemModel from rest, Item Zoom, Cancel while zoomed in), as the original                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Map over the journal (ShowJournal: the map's bar hidden while the journal shows)         | done   | src/shell/map-menu.ts (showJournal), src/shell/game-menus.ts: the map stays open under the journal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Tween menu HideMenu, ResetStatsButton, ShowMenu                                          | done   | src/shell/game-menus.ts: hidden under the menu chosen, shown again when an item menu goes back to it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Journal BackOutFromLoadGame, onRightStickInput, StartCloseMenu                           | done   | src/shell/journal-menu.ts: a load that does not go ahead backs out of the load list; the right stick every [MapMenu] iRightStickRepeatRate ms (src/shell/gamepad-input.ts); StartCloseMenu(true) as the engine hides it; HideMenu: the tween menu's only (n/a)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Journal ShowMenu, RefreshSystemButtons: who posts "Show Journal" and "RefreshMenu" to it | done   | observed in the original: the journal's system page itself, as it hears the save system's results (a delete done: RefreshMenu; a save, load or delete failed: sSaveGameDeviceError, then Show Journal) and the input devices' gamepad event (RefreshMenu); src/shell/journal-menu.ts (#deviceError, gamepadChanged), src/shell/save-list.ts (deleted, failed), src/shell/gamepad-input.ts (gamepadconnected, gamepaddisconnected). The gamepad event is the input device manager's remote gamepad event, sent at the end of its poll when a flag it keeps was set; what sets the flag on the PC was not found (TODO(M13)). A save written: a save the player made hides the journal, an autosave is RefreshMenu, a quicksave nothing (src/shell/journal-menu.ts saveWritten, src/shell/save-manager.ts written) |
| Main menu ConfirmNewGame, ConfirmContinue, HELP, OnDisabledLoadPress, QuitToMainMenu     | done   | src/shell/play-mode.ts (the original answers the last three with nothing)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Main menu Load's import of an original save (.ess)                                       | done   | src/shell/play-mode.ts (pickImport), src/shell/save-list.ts: the picker opens as the entry is pressed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Favorites StartFadeOut, SetSelectedItem; dialogue Cancel                                 | done   | src/shell/favorites-menu.ts (the entry chosen last selected on opening; an inventory change remakes the list, an empty one fades out); src/shell/dialogue-menu.ts (Cancel on the control map's Cancel; the route is inferred, TODO(M13))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Book PrepForClose                                                                        | done   | src/shell/book-menu.ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Message box setIsVertical; HUD FadeOutChargeMeters, ValidateCrosshair                    | done   | src/shell/message-boxes.ts (off: no box of ours is vertical); src/shell/hud-controller.ts (FadeOutChargeMeters); src/shell/hud-crosshair.ts (a Target Location spell's effects checked at the aim point every 200 ms: Normal or Alert, then ValidateCrosshair)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| HUD SetCompassTemperature (Survival Mode)                                                | done   | the movie's own ShowSurvivalElements calls it; src/shell/hud-controller.ts sends that (the engine has no such name)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Quantity Menu as a menu of its own                                                       | n/a    | no menu of the original is made under the name: the item menus' quantity slider plays inside their movie                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Top Menu, Overlay Menu, Overlay Interaction Menu                                         | n/a    | no menu of the original is made under these names (they are only looked up)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| SafeZoneMenu                                                                             | n/a    | the consoles' safe-zone setting: the PC's display page has none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Debug Text Menu                                                                          | n/a    | observed in the original: the console's ToggleDebugText (TDT), SetDebugText (sdt) and SaveDebugTextPages (SaveDTP) return at once, and the code that would open the menu or draw its text is never called: src/shell/console-commands.ts takes the three and prints nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| TitleSequence Menu and LoadWaitSpinner in the menu stack                                 | done   | src/shell/title-sequence.ts, src/shell/load-wait-spinner.ts (shown while a save is written)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| The inventory 3D turned and zoomed by each model's BSInvMarker                           | done   | src/shell/item-3d-view.ts, src/shell/item-3d.ts: the marker's rotation (x, y, z), its zoom, the bound radius, the 16:9 rule, the mouse and stick turns, the straight zoom                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Lockpicking: the failed tries on a lock (for IsLockBroken)                               | done   | src/scripting/runtime/natives/reference.ts (lockBroken): the lock's own tries (game state lockTries) against one, or two with Ignore Broken Lock; broken picks are the menu's own count, not the lock's (src/shell/lockpicking-menu.ts); what adds to a lock's tries is not read (TODO(M13))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Beast perk trees (werewolf, vampire lord), low-stat tutorials                            | done   | src/gameplay/beast-perk-trees.ts: the form by the default objects WerewolfRace and VampireRace, its points the globals WerewolfAvailablePerks and VampireAvailablePerks name (DLC1WerewolfPerkPoints, DLC1VampirePerkPoints), its meter the actor value the feeding scripts keep (WerewolfPerks, VampirePerks); src/gameplay/low-stat-tutorials.ts: fLow<Stat>TutorialPercentage (0.25), health's only while above 0, and none while a save game loads or with the control map's main four off (Game.DisablePlayerControls' abMenu), as observed in the original                                                                                                                                                                                                                                                |
| A beast tree's level number                                                              | done   | observed in the original: in a beast form the skills menu sends no skill list (SkillStatsA, UpdateSkillList) and writes the beast skill element (StatsMenuBaseInstance.BeastSkillHolder.BeastSkillInstance: its label the actor value's name, its ShortBar at frame 200 − progress × 1.99); the game's statsmenu.swf has no such element, so no level number shows: src/shell/skills-menu.ts (#showBeastSkill), tests/interface.int.test.ts. What else fills the bar is not read (TODO(M13); never seen with the game's movie)                                                                                                                                                                                                                                                                                  |
| Survival HUD (the Creation's temperature and penalties)                                  | done   | src/gameplay/survival-hud.ts, src/shell/hud-controller.ts (ShowSurvivalElements); no Creation in the install brings a movie of its own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| The wait menu's date without its year (SetCurrentTime)                                   | done   | observed in the original: the date is written with ", 4E 201" for the tween menu, the map and the journal, without it for the sleep/wait menu (src/world/game-time.ts formatGameDate `withYear`, src/shell/sleep-wait-menu.ts); with the year the line ran out of the box ("4E 2(")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The level-up menu over the skills menu                                                   | done   | observed in the original: the skills menu goes on under the LevelUp Menu and takes its level-up state once it has closed; src/shell/game-menus.ts (#openLevelUp: the skills menu first, the level-up menu above it, the skills menu's refresh after the choice), src/shell/skills-menu.ts (refresh)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| dpc (DisablePlayerControls from the console) locks the camera's switch                   | done   | src/shell/console-commands.ts: dpc takes a lock of aiDisablePOVType 0 as the native's abCamSwitch does (it cleared the locks, so F still switched the view); epc frees every lock                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Creation Club menu, Mod Manager, Bethesda.net login                                      | n/a    | online services, never reached from localhost (hard rule 4); the installed Creations load by Skyrim.ccc (src/vfs), the journal's Creations entry stays hidden (ShouldShowMod)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## On screen (2026-10-31)

Each menu opened in a running game and looked at against what the movie lays out, its
translated strings and what the engine passes: `node tools/qa-menus.ts --out <folder>` (a headless
Chrome; Riverwood by coc, `--cell new` for a new game; screenshots and tour.json outside the
repository). "As the original" means the movie's own layout with the original's strings and the
engine's values in it, nothing missing or out of place; notes say what was fixed or not compared.

| Menu (movie)                                           | On screen       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Main menu (startmenu.swf)                              | as the original | NEW, LOAD (off without saves), CREATIONS, CREDITS, QUIT over the mist and the logo; NEW asks "Start a new game?"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Credits (creditsmenu.swf)                              | as the original | CREDITS clicked: the menu fades out, the credits roll over the mist, Tab Back                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Loading screen (loadingmenu.swf)                       | as the original | the mist first; once chosen the loading screen's model and its text at the bottom right                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| HUD (hudmenu.swf)                                      | as the original | compass, crosshair; full meters fade out after arriving                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| HUD activation text                                    | as the original | "Use" over "Alchemy Lab" at the crosshair; an actor (Alvor) at the crosshair: "Talk" over "Alvor". The tour now brings the actor back before the view and turns to his head (his package had walked him off)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| HUD in a new game's opening                            | as the original | titles over black, then the cart in CartMode and MovementDisabled (no compass, no crosshair); CartMode off and the controls back: compass, crosshair, "Use Mouse to look around." The whole of MQ101 was not played through in the browser                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Tween menu (tweenmenu.swf)                             | as the original | SKILLS, MAGIC, ITEMS, MAP, the level bar, the date with its year, the world blurred                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Inventory (inventorymenu.swf)                          | as the original | opens on its categories alone (the movie's ShowCategoriesList: one panel); Enter slides the items list in; carry weight, gold, health. The categories reaching under the bottom bar at 16:9 are the movie's own layout, not the engine's sizing: a centred list, the selected entry below numTopHalfEntries (7) rows of 40.4 from the list's top (60), its border 656.5 to the screen's bottom; at 16:9 every scale mode shows the stage one to one. Each menu is now loaded with the original's scale mode (most exactFit) and safe zone (the stage less the margins), which matters on screens of another shape                                                                                                                                                                                                                                |
| Magic (magicmenu.swf)                                  | as the original | categories at the right, the spells, the card (Flames: Novice, 22 per sec), M1 M2 Equip, F Favorite, the school's skill meter and magicka                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Favorites (favoritesmenu.swf)                          | as the original | the list at the left over the HUD                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Journal: quests, stats, system (quest_journal.swf)     | as the original | the tabs by click; the system page's list QUICKSAVE to QUIT                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Journal: controls page                                 | as the original | Forward W, Back S, Strafe A and D, Left Hand M2, Right Hand M1, Activate E, Ready/Sheathe R; the left hand on the right button is the original's control map                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Map: world and local (map.swf)                         | as the original | markers, the bar (L Local Map, J Journal, Wheel Zoom, E Current Location, M1 Set Destination, the date); the local map of the place with its doors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Skills and perk tree (statsmenu.swf)                   | fixed           | name, level and race, the skills, the attribute bars. The perk names overlapped ("Ebony Smithing" over "Orcish Smithing"): the camera only pitched up to a flat tree of rows 6 apart. Now as the original: stars in their point's frame (a row 15 further out and 9 higher, from 5 up; at fStatsStarScale 0.15), the camera going over a second to the selected star's camera point (8 toward the middle, looking 1 above it), its frustum from tan(fStatsCameraFOV) × 0.4125; names only for stars on the screen, html white or grey (#999999) by the next rank's conditions, "(owned/count)" for ranks. Seen with the camera at the star and the grey Arcane Blacksmith; the wider frustum was not shot again (the tour stalled on the Survival Mode box). TODO(M13): the column origin (the engine's perk tree width) and the camera's easing |
| Level up (levelupmenu.swf)                             | fixed           | showed over the world with the HUD and opened the skills menu after; now over the skills menu (behaviour checklist)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Sleep and wait (sleepwaitmenu.swf)                     | fixed           | the date ran out of the box ("4E 2("); now without its year, as the original writes it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Dialogue (dialoguemenu.swf)                            | as the original | the speaker's name, the topics at the right, Tab Exit; Esc or Tab skips the line being spoken first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Barter (bartermenu.swf)                                | as the original | the vendor's categories, the divider, the player's; Gold and the vendor's gold. A long list runs on under the bottom bar's dark band: the movie's centred list (as the inventory's), the same in the original                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Gift (giftmenu.swf)                                    | as the original | GIVE GIFT, the categories; the bar's buttons come with a highlighted item (the movie hides them as it opens)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Training (trainingmenu.swf)                            | as the original | a trainer's skill and tier, times trained, cost, gold, E Train, Tab Exit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Container (containermenu.swf)                          | as the original | the chest's categories, the divider, the player's; carry weight, gold, health                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Lockpicking (lockpickingmenu.swf)                      | as the original | the lock and pick in 3D; Mouse Rotate Pick, A D Rotate Lock, Tab Exit, the skill meter, Lock Level, Lockpicks Left                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Book (book.swf, bookmenu.swf)                          | as the original | the 3D book open at its title page, M1 M2 Turn Pages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Crafting: forge, enchanter, alchemy (craftingmenu.swf) | as the original | the categories, the station's prompt at the top right, the skill meter, Tab Exit; the station in view. A long list runs under the bar as in barter (the movie's own layout)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Message box (messagebox.swf)                           | as the original | title, text, buttons (the Survival Mode offer)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Tutorials (tutorialmenu.swf)                           | as the original | the box over the menu the first time (Favorites, Quest Journal, Barter, Map, Skills, Level Up, Lockpicking, the stations), Tab Exit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Console (console.swf)                                  | as the original | its history and command line over the movie's own background (iConsoleSizeScreenPercent 40)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Race menu (racesex_menu.swf)                           | as the original | Race, Body, Head; the races, the description, name and race. The camera zooming out on a blur was not reproduced: the page's blur, focus and visibility events make the movie call nothing (ZoomPC comes only with a category change) and the camera stays                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Pause (Esc: the journal's system page)                 | as the original | opens on the system page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Controls disabled                                      | fixed           | dpc left Toggle POV working (F switched the view); now locked (behaviour checklist). Tab, the hotkeys and the quick keys stay shut as before                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Fixed meanwhile: WebGPU "used in submit while destroyed" as the skills menu was closed by the
engine at once (its 3D view's update closes it in the middle of the frame that draws its scenes).
What is let go of while a frame is recorded is destroyed after that frame's submit
(src/render/frame-release.ts); the skills, forge and barter menus closed so show no WebGPU errors.

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
| containermenu.swf                               | done   | src/shell/container-menu.ts, src/shell/item-menu.ts                              |
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
| inventorymenu.swf                               | done   | src/shell/inventory-menu.ts, src/shell/item-menu.ts                              |
| kinectmenu.swf                                  | n/a    | consoles only (PlayStation, Xbox, Switch)                                        |
| levelupmenu.swf                                 | done   | src/shell/level-up-menu.ts                                                       |
| loadingmenu.swf                                 | done   | src/shell/play-mode.ts                                                           |
| loadwaitspinner.swf                             | done   | src/shell/load-wait-spinner.ts                                                   |
| lockpickingmenu.swf                             | done   | src/shell/lockpicking-menu.ts                                                    |
| logindialog.swf                                 | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4)     |
| magicmenu.swf                                   | done   | src/shell/item-menu.ts, src/shell/magic-menu.ts                                  |
| map.swf                                         | done   | src/ui/movie-patches.ts, src/shell/map-menu.ts                                   |
| messagebox.swf                                  | done   | src/shell/message-boxes.ts                                                       |
| modmanager.swf                                  | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4)     |
| quest_journal.swf                               | done   | src/shell/journal-menu.ts                                                        |
| racesex_menu.swf                                | done   | src/shell/race-menu.ts                                                           |
| safezone.swf                                    | n/a    | the consoles' safe-zone setting: the PC's display page has none                  |
| sharedcomponents.swf                            | n/a    | nothing loads it: neither the engine nor any movie names it                      |
| sleepwaitmenu.swf                               | done   | src/shell/sleep-wait-menu.ts                                                     |
| startmenu.swf                                   | done   | src/shell/play-mode.ts                                                           |
| statsmenu.swf                                   | done   | src/shell/skills-menu.ts                                                         |
| streaminginstall.swf                            | n/a    | consoles only (PlayStation, Xbox, Switch)                                        |
| textentry.swf                                   | done   | loaded by exported\racesex_menu.gfx, racesex_menu.swf                            |
| titles.swf                                      | done   | src/shell/title-sequence.ts                                                      |
| trainingmenu.swf                                | done   | src/shell/training-menu.ts                                                       |
| tutorialmenu.swf                                | done   | src/shell/tutorial-menu.ts                                                       |
| tweenmenu.swf                                   | done   | src/shell/game-menus.ts                                                          |
| widgetoverlay.swf                               | n/a    | nothing loads it: neither the engine nor any movie names it                      |

### Menu names

| Menu                     | Status | Reason                                                                                                                    |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| BarterMenu               | done   |                                                                                                                           |
| Book Menu                | done   |                                                                                                                           |
| Console                  | done   |                                                                                                                           |
| Console Native UI Menu   | n/a    | consoles only (PlayStation, Xbox, Switch)                                                                                 |
| ContainerMenu            | done   |                                                                                                                           |
| Crafting Menu            | done   |                                                                                                                           |
| Creation Club Menu       | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4)                                              |
| Credits Menu             | done   |                                                                                                                           |
| Cursor Menu              | done   |                                                                                                                           |
| Debug Text Menu          | n/a    | the original never opens it: ToggleDebugText and SetDebugText return at once, the code that would show it is never called |
| Dialogue Menu            | done   |                                                                                                                           |
| Fader Menu               | done   |                                                                                                                           |
| FavoritesMenu            | done   |                                                                                                                           |
| GiftMenu                 | done   |                                                                                                                           |
| HUD Menu                 | done   |                                                                                                                           |
| InventoryMenu            | done   |                                                                                                                           |
| Journal Menu             | done   |                                                                                                                           |
| Kinect Menu              | n/a    | consoles only (PlayStation, Xbox, Switch)                                                                                 |
| LevelUp Menu             | done   |                                                                                                                           |
| Loading Menu             | done   |                                                                                                                           |
| LoadWaitSpinner          | done   |                                                                                                                           |
| Lockpicking Menu         | done   |                                                                                                                           |
| MagicMenu                | done   |                                                                                                                           |
| Main Menu                | done   |                                                                                                                           |
| MapMenu                  | done   |                                                                                                                           |
| MessageBoxMenu           | done   |                                                                                                                           |
| Mist Menu                | done   |                                                                                                                           |
| Mod Manager Menu         | n/a    | an online service (Bethesda.net): never reached from localhost (hard rule 4)                                              |
| Overlay Interaction Menu | n/a    | no menu of the original is made under this name (it is only looked up)                                                    |
| Overlay Menu             | n/a    | no menu of the original is made under this name (it is only looked up)                                                    |
| Quantity Menu            | n/a    | no menu of the original is made under this name (it is only looked up)                                                    |
| RaceSex Menu             | done   |                                                                                                                           |
| SafeZoneMenu             | n/a    | the consoles' safe-zone setting: the PC's display page has none                                                           |
| Sleep/Wait Menu          | done   |                                                                                                                           |
| StatsMenu                | done   |                                                                                                                           |
| StreamingInstallMenu     | n/a    | consoles only (PlayStation, Xbox, Switch)                                                                                 |
| TitleSequence Menu       | done   |                                                                                                                           |
| Top Menu                 | n/a    | no menu of the original is made under this name (it is only looked up)                                                    |
| Training Menu            | done   |                                                                                                                           |
| Tutorial Menu            | done   |                                                                                                                           |
| TweenMenu                | done   |                                                                                                                           |

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
| callback | Cancel               | done   | src/shell/dialogue-menu.ts                              |
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
| callback | SetSelectedItem | done   | src/shell/favorites-menu.ts                             |
| callback | StartFadeOut    | done   | src/shell/favorites-menu.ts                             |

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

| Kind     | Name                        | Status | Where / reason                                                                         |
| -------- | --------------------------- | ------ | -------------------------------------------------------------------------------------- |
| call     | GetButtonFromUserEvent      | done   | src/shell/play-mode.ts                                                                 |
| call     | PlaySound                   | done   | src/shell/play-mode.ts                                                                 |
| call     | RegisterHUDComponents       | done   | src/shell/hud-controller.ts                                                            |
| call     | myLog                       | done   | src/shell/play-mode.ts                                                                 |
| callback | FadeOutChargeMeters         | done   | src/shell/hud-controller.ts                                                            |
| callback | FadeOutStamina              | done   | src/shell/hud-controller.ts                                                            |
| callback | FlashShoutMeter             | done   | src/shell/hud-controller.ts                                                            |
| callback | HideSubtitle                | done   | src/shell/hud-controller.ts                                                            |
| callback | SetChargeMeterPercent       | done   | src/shell/hud-controller.ts                                                            |
| callback | SetCompassAngle             | done   | src/shell/hud-controller.ts                                                            |
| callback | SetCompassMarkers           | done   | src/shell/hud-controller.ts                                                            |
| callback | SetCompassTemperature       | done   | the movie's own ShowSurvivalElements calls it (src/shell/hud-controller.ts sends that) |
| callback | SetCrosshairEnabled         | done   | src/shell/hud-controller.ts                                                            |
| callback | SetCrosshairTarget          | done   | src/shell/hud-controller.ts                                                            |
| callback | SetEnemyHealthPercent       | done   | src/shell/hud-controller.ts                                                            |
| callback | SetEnemyHealthTargetPercent | done   | src/shell/hud-controller.ts                                                            |
| callback | SetHealthMeterPercent       | done   | src/shell/hud-controller.ts (SetMeterPercent)                                          |
| callback | SetLoadDoorInfo             | done   | src/shell/hud-controller.ts                                                            |
| callback | SetLocationName             | done   | src/shell/hud-controller.ts                                                            |
| callback | SetMagickaMeterPercent      | done   | src/shell/hud-controller.ts (SetMeterPercent)                                          |
| callback | SetShoutMeterPercent        | done   | src/shell/hud-controller.ts                                                            |
| callback | SetStaminaMeterPercent      | done   | src/shell/hud-controller.ts (SetMeterPercent)                                          |
| callback | SetSubtitlesEnabled         | done   | src/shell/hud-controller.ts                                                            |
| callback | ShowElements                | done   | src/shell/hud-controller.ts                                                            |
| callback | ShowMessage                 | done   | src/shell/hud-controller.ts                                                            |
| callback | ShowNotification            | done   | src/shell/hud-controller.ts                                                            |
| callback | ShowSubtitle                | done   | src/shell/hud-controller.ts                                                            |
| callback | ShowTutorialHintText        | done   | src/shell/hud-controller.ts                                                            |
| callback | StartMagickaMeterBlinking   | done   | src/shell/hud-controller.ts                                                            |
| callback | StartStaminaMeterBlinking   | done   | src/shell/hud-controller.ts                                                            |
| callback | ValidateCrosshair           | done   | src/shell/hud-controller.ts                                                            |

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
| callback | setIsVertical    | done   | src/shell/message-boxes.ts |
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
| callback | BackOutFromLoadGame           | done   | src/shell/journal-menu.ts                                                                                   |
| callback | ConfirmOKToLoad               | done   | src/shell/save-list.ts                                                                                      |
| callback | FinishRemapMode               | done   | src/shell/journal-controls.ts                                                                               |
| callback | HideMenu                      | n/a    | observed in the original: the engine calls HideMenu in the tween menu only (the journal is never hidden so) |
| callback | OnSaveDataEventLoadCANCEL     | n/a    | consoles only (PlayStation, Xbox, Switch)                                                                   |
| callback | OnSaveDataEventSaveCANCEL     | n/a    | consoles only (PlayStation, Xbox, Switch)                                                                   |
| callback | OnSaveDataEventSaveSUCCESS    | n/a    | consoles only (PlayStation, Xbox, Switch)                                                                   |
| callback | RefreshSystemButtons          | done   | src/shell/journal-menu.ts                                                                                   |
| callback | RestoreSavedSettings          | done   | src/shell/journal-menu.ts                                                                                   |
| callback | ScreenshotReady               | done   | src/shell/save-list.ts                                                                                      |
| callback | SetButtonMapping              | done   | src/ui/menu-host.ts                                                                                         |
| callback | SetRemoteDevice               | n/a    | consoles only (PlayStation, Xbox, Switch)                                                                   |
| callback | SettingsSaved                 | done   | src/shell/journal-controls.ts                                                                               |
| callback | ShowMenu                      | done   | src/shell/journal-menu.ts                                                                                   |
| callback | StartCloseMenu                | done   | src/shell/journal-menu.ts                                                                                   |
| callback | UpdatePermissions             | n/a    | consoles only (PlayStation, Xbox, Switch)                                                                   |
| callback | onFillCharacterListComplete   | done   | src/shell/save-list.ts                                                                                      |
| callback | onRightStickInput             | done   | src/shell/journal-menu.ts                                                                                   |
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
| callback | onStartButtonProcessFinished     | done   | src/shell/play-mode.ts                                                       |
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

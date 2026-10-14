# The interface: the game's own menus

Milestone M9. The game's menus are Scaleform GFx movies (ActionScript 2, `interface\*.swf`, see
[formats/swf.md](formats/swf.md)). They play in [Ruffle](https://ruffle.rs), a Flash player in
WebAssembly, with the engine standing in for the Scaleform player and the game around them:
the same movies, the same ActionScript, the same calls in both directions.

## Ruffle

`@ruffle-rs/ruffle` (self-hosted build) is served on `/ruffle/` from its npm package
(`tools/ruffle-plugin.ts`: the dev server serves the folder, a build copies it). `loadRuffle()`
(`src/ui/ruffle.ts`) loads it once; each menu plays in a player of its own, as each menu is a
movie of its own under Scaleform (its own `_root` and `_global`).

Ruffle ticks with `requestAnimationFrame`: in a hidden tab no frame runs, so no ActionScript
either.

## Files the menus load

A menu imports from other movies by relative URL (`gfxfontlib.swf`, `Inventory
components/ItemCard.swf`), which Ruffle fetches. A movie plays with base `/@interface/`;
`InterfaceFiles.serve()` (`src/ui/interface-files.ts`) answers fetches of that prefix in the page
from the virtual file system (loose files over archives, as for every file), so nothing goes over
the network.

**Fonts**: the menus import their fonts by name from `gfxfontlib.swf`; Scaleform answers from
`fontconfig.txt`. The engine builds that `gfxfontlib.swf` (`src/ui/font-library.ts`): every
mapped name a copy of its font from the font libraries the config loads, renamed to the name
and exported under it; names only the shipped gfxfontlib.swf exports keep its fonts. All ten
names the vanilla menus import are covered (`node tools/swf-info.ts --fontlib`).

## The bridge

How the game's menus talk to the engine is in their own code: `gfx.io.GameDelegate` (in every
menu, `node tools/swf-actions.ts hudmenu.swf GameDelegate`):

- `GameDelegate.call(name, params, scope, callback)`: a request id is kept with the callback,
  then `ExternalInterface.call(name, id, ...params)`. The engine answers through the callback
  `respond` (`receiveResponse(id, ...values)`).
- A request is answered during the call: `GameDelegate.call` keeps the callback only until
  `ExternalInterface.call` returns (it deletes it from its `responseHash` right after), so the
  engine reads what a menu will ask for before it opens and answers at once.
- A clip passed in a call (the journal passes the quest list it wants filled) reaches the engine
  as a reference: GFx hands the engine the object; a Flash player's ExternalInterface only copies.
  The bridge passes a clip as `__itjwRef:<n>` and keeps it as `_global.__itjwRefs[n]`
  (`Menu.reference()` gives that path), so the engine fills it through the paths below.
- `GameDelegate.addCallBack(name, scope, method)`: the engine calls it through the callback
  `call` (`receiveCall(name, ...args)`), e.g. the HUD's `SetCompassAngle`, `SetLocationName`,
  `ShowNotification`, registered in `HUDMovieBaseInstance.InitExtensions()`.

GFx also lets the engine invoke any function and set or read any variable by its path; a Flash
player only calls what a movie registered with `ExternalInterface.addCallback`. So before a menu
plays, `withBridge()` (`src/ui/menu-bridge.ts`) puts a DoAction of the engine's first into its
first frame (after the header tags; written with `src/formats/swf/avm1-writer.ts`):

- `_global.gfxExtensions = true`, as under Scaleform.
- `ExternalInterface.call` (made writable with `ASSetPropFlags`, as Ruffle guards its classes'
  members) is wrapped to call the page function `__itjwMenuCall(menu, name, ...args)`: several
  menus play at once, and the call says which one it comes from.
- Callbacks `__itjwInvoke(objectPath, method, args)`, `__itjwSetVariable(path, value)` and
  `__itjwGetVariable(path)` do what GFx's Invoke, SetVariable and GetVariable do (paths as
  ActionScript resolves them: `_root.HUDMovieBaseInstance.LocationLockBase`).

Checked in the browser on `hudmenu.swf`: its own calls reach the page tagged with the menu, and
`InitExtensions` then `call("SetLocationName", "Whiterun")` set the location text.

## What the menus ask of the engine

`node tools/swf-actions.ts --calls` lists, per menu, the names it passes to `GameDelegate.call`
(requests the engine answers), to `GameDelegate.addCallBack` (what the engine calls) and to
`ExternalInterface.call` directly (CLIK's `__handleEvent`). The HUD, for instance, asks
`RegisterHUDComponents`, `GetButtonFromUserEvent`, `PlaySound` and `myLog`, and offers
`SetCompassAngle`, `SetCompassMarkers`, `SetHealthMeterPercent`, `SetMagickaMeterPercent`,
`SetStaminaMeterPercent`, `SetCrosshairTarget`, `SetLocationName`, `ShowNotification`,
`ShowMessage`, `ShowSubtitle`, `SetLoadDoorInfo`, `ShowElements` and more. The start menu asks
`NEW`, `CONTINUE`, `StartState`, `EndPressStartState`, `PlaySound`, ... and offers
`ConfirmNewGame`, `FadeInMenu`, `FadeOutMenu`, ...

Keyboard and mouse reach the movies as Flash input (the Key and Mouse objects; CLIK's
`InputDelegate` turns keys into `handleInput` down the focus path), as under Scaleform.

## Translations

Scaleform shows a text field whose text is a translation key (`$NEW`) as the key's text from
`interface\translate_english.txt` (UTF-16 lines of `$KEY<tab>text`, 861 keys; matched as
written, then ignoring case). A Flash player has no translator, and a TextField's `text` is
native, so the engine translates the movie as it loads (`src/ui/translate-movie.ts`): every
string of its ActionScript (ConstantPool entries, pushed strings) and every text field's initial
text (plain, or between HTML tags) that is a key is replaced by its text; strings that are no
key (font names such as `$EverywhereFont`) stay. The ActionScript is re-encoded with every
branch, function, With and Try size moved along (`src/formats/swf/avm1-rewrite.ts`); the
integration test translates every vanilla menu and checks every branch still lands on an action.
Placed instances' clip actions (PlaceObject2/3, `src/formats/swf/place-object.ts`) are
translated too: that is where a CLIK component gets the parameters set for it in Flash's
component inspector (the start menu's `$Yes`, `$No`, `$Delete` button labels). The integration
test checks that no string of any vanilla menu is still a key. Text the engine sends is translated before it is sent.

## The main menu

`src/shell/play-mode.ts` opens `startmenu.swf` as the game does: once its first frame has run,
`_root.MenuHolder.Menu_mc.InitExtensions()`, then the callback `sendMenuProperties` with the
menu's properties (read by its `setupMainMenu` by index: 0 Quit, 1 saves exist (Continue, Load),
2 version text, 3 Press Start, 4 the Anniversary upgrade banner, 5 Downloadable Content, 6 Help,
7 Mod Manager, 8 Creations shown, 9 logged in, 11 PS5 transfer, 12 new Creations, 13 Creations
usable, 14 Switch transfer), then `FadeInMenu`. On PC since 1.6.1130 Mods are part of Creations
(UESP). Creations is an online store and stays unusable (localhost only). It shows NEW, LOAD,
CREATIONS, CREDITS, QUIT.

## Stage.visibleRect and Stage.safeRect

The menus lay themselves out with Scaleform's Stage extensions (their `Shared.GlobalFunc`
`Lock("BR")` and the like): `Stage.visibleRect`, the part of the screen the movie shows in its
stage coordinates, and `Stage.safeRect`, whose x and y are the safe zone margins ([Interface]
`fSafeZoneX` / `fSafeZoneY`, and the Wide pair on widescreen; 15 by default, per the STEP INI
guide). Without them every locked position is NaN and the menu vanishes. The bridge sets both
first in the menu's first frame, for its stage shown whole on the screen; the host sets them
again once the menu has set its own scale mode and whenever the window resizes
(`src/ui/stage-rects.ts`).

## Focus and keys

Keys reach a menu as Flash input; CLIK's `InputDelegate` turns them into `handleInput` calls
down the focus path that `FocusHandler` keeps. Both rely on Scaleform's focus model, which the
bridge gives each menu: any clip may take focus (Flash: only those with `focusEnabled`), with no
focus rectangle, and its multi-controller extensions for one controller in focus group 0
(`System.capabilities.numControllers` 1, `Selection.getControllerFocusGroup` 0,
`Selection.getControllerMaskByFocusGroup` 1, `Selection.setControllerFocusGroup`,
`Selection.getModalClip` / `setModalClip`). Without them no menu takes a key.

The engine tells each menu its platform (`SetPlatform(0, false)`: PC with keyboard and mouse);
the start menu then shows the mouse version of its buttons, and `ShowDeleteButtonHelp(false)`
hides the delete-save hint while there is no save. PRESS ANY BUTTON (property 3) is not shown:
the menu opens on its list.

## Scaleform's text fields

GFx gives AS2 text fields some members a Flash player's AS2 lacks, and the menus use them
(`node tools/swf-actions.ts --strings`: `getLineMetrics` in the HUD, the item menus, the
message box, the journal, books; `numLines`; `appendText`/`appendHtml` in the journal, the race
menu, the tutorial). The bridge adds them to `TextField.prototype`:

- `numLines`: `maxscroll + bottomScroll - scroll` (the lines past the first one in view, plus
  those in view): exact.
- `getLineMetrics(line)`: `{x: 0, width: textWidth, height: textHeight / numLines, leading}`:
  the widest line's width, exact for the single-line fields that ask (the HUD's letters measure
  each letter this way); the menus read `width`, and books `leading`.
- `appendText`, `appendHtml`: add to `text` / `htmlText`.
- `getLineOffset`, `getCharBoundaries`, `getLineIndexAtPoint`: from a hidden measuring field on
  `_root` set up like the field (width, wrapping, fonts, first format): a line's first character
  is where a prefix of the text first takes that many lines; a character's box spans the width
  of its line's text before it, at its line's top (the journal places its objectives under the
  description's last line this way).
- Texts set at run time that are keys: GFx translates a text beginning with "$" as it is set
  (the journal's stats are `"$" + name`). The menus set their texts through
  `Shared.GlobalFunc`'s `SetText`; the bridge wraps it as the movie defines it (`Object.watch`
  on `TextField.prototype`), and a key goes to the engine (`__itjwTranslate`, answered from the
  translations at once) before the text is set.
- `new TextField()`: under GFx a text object off the stage whose `text` keeps what is set (the
  HUD writes a quest's status before its name through one, "Quest completed: "). The bridge's
  `TextField` makes one, and leaves the fields the player places to the original class (Ruffle
  constructs those with `_global.TextField` as well; they have a `_width`, an object off the
  stage has none). Its prototype is the original one, so `instanceof TextField` holds.

Still missing in Ruffle (0.7.1), and so in the menus: `<img>` in a text field's HTML (the HUD's
help messages show their keys' art as `<img src='E.png'>`: the text shows, the key does not),
`textAutoSize` and `verticalAlign`. TODO(M9).

## The main menu's background: the mist menu

Behind the start menu the game renders its "Mist Menu" (CommonLibSSE-NG's `RE::MistMenu`:
six directional ambient colours, the mist model, a camera path, the default logo's shader
property, a load screen model, the image space it replaces). `src/shell/mist-menu.ts`:

- The mist: `meshesinterfaceintmenufogparticles.nif` (a particle system on AutoPlay),
  turned by `fUIMistModel_RotateZ_G` (-180) and moved by `fUIMistModel_Translate*_G` (0).
- The logo: `meshesinterfacelogologo.nif` (a lit, mirror-like shape, 39 × 73 units, and
  the Autoplay behavior), scaled by `fUIMistMenu_DefaultLogoNIFScale` (1), moved by
  `fUIAltLogoModel_Translate*_G` (0).
- The camera and the light: the INI's camera (`fUIMistMenu_CameraX/Y/Z_G` -50, 600, 80 looking
  at -50, 0, 0) shows the logo at about 12% of the screen's height, and the data holds no light
  for the menu (`rUIMistMenu_Ambient*` are 0). Both are fitted to the game as it shows itself
  (1.7.104, a screenshot of its main menu): the logo 69% of the screen's height, its middle at
  36% of the width and 47% of the height, lit from the upper left and the front; the field of
  view is the INI's `fUIMistMenu_CameraFOV_G` (75, horizontal of a 4:3 frame).
- TODO(M9): the AE logo models (`logo01ae*.nif`, silver to gold) for players with the
  Anniversary upgrade; the image space the menu sets; how the engine places its camera.

## A new size

A menu lays itself out once, as it opens (the game cannot change resolution with a menu open).
When the layer's size changes (a resized window, full screen), the host loads each menu laid out
for another size again and runs its owner's setup again (`MenuOptions.setup`: for the start
menu its extensions, properties, platform and fade-in), as the game would after a change of
resolution. A click in the game gives the keys back to the topmost menu; the engine's own
corner button leaves the keyboard's tab order in Play, so Enter always reaches the game.

## The launcher

Play starts where the game starts, at its launcher (`src/shell/launcher.ts`): Play, Options,
Exit. Options keeps what the launcher writes to SkyrimPrefs.ini (in the browser's storage, per
player): Windowed Mode (off: Play asks for full screen in the click that starts it) and the
Detail preset. The Graphics Adapter shows the GPU. The launcher's art lives in its executable,
not in the game's data, so it wears the engine's own look. TODO(M13): the detail presets and the
Advanced settings (detail, view distance, water) applied by the renderer, which draws at Ultra.

## New game and loading screens

New (the start menu's `NEW` call) starts a new game as the game does: the start menu fades out
(`FadeOutMenu`); the loading menu (`loadingmenu.swf`: the engine calls `_root.InitExtensions`,
`_root.SetPlatform(0)`, `_root.Menu_mc.FadeInMenu`, and answers `RequestLoadingText` with the
loading screen's text and `RequestPlayerInfo` with level 1, no progress, no meter) shows over
the mist while the game's scripts start a clean new game; once the opening has placed the
player (MQ101 stage 0 → 10, `Fragment_4`: the player to `MQ101PlayerStartMarker` in Tamriel,
by the cart), the loading screen is chosen, the world there loads, and the loading menu fades
out.

**Loading screens** (LSCR, `src/world/loading-screens.ts`): DESC the text, CTDA conditions (run
on the player), NNAM the static whose model is shown, SNAM its scale, RNAM its rotation
(degrees), ONAM the rotation limits, XNAM its offset, MOD2 a camera path. Of the 371 vanilla
screens 134 have conditions; after a new game's opening exactly one holds, `ChargenLoadScreen`
(MQ101 stage 10: Alduin's wall and the Song of the Dragonborn). Screens whose conditions hold
are taken before those without (inferred from the new game always showing its own); else one at
random.

**Camera paths** (`meshes\cameras\LSCamera*.nif`, `src/render/camera-path.ts`): a
`CameraPathNode` moved by the 60-second looping `CameraPath` sequence, with an NiCamera under it
(nif.xml: NiAVObject, camera flags, frustum left/right/top/bottom/near/far, orthographic,
viewport, LOD adjust, scene, screen polygons and textures). The paths place the camera 250–300
units in front of the model on the -Y side: it looks along +Y with +Z up (the NiCamera's 90°
turn maps Gamebryo's X-forward camera onto the world's axes); the frustum gives 45° across a
4:3 frame. TODO(M9): turning the model with the mouse within ONAM's limits.

## The HUD

In the game Play opens `hudmenu.swf` (`src/shell/hud-controller.ts`):
`HUDMovieBaseInstance.InitExtensions()` and `SetPlatform(0, false)`, then every frame the
GameDelegate callbacks the engine drives it with: `SetCompassAngle(playerAngle, compassAngle,
show)` (the heading in degrees, 0 north, 90 east; the compass strip is placed by lerping
`CompassZeroX` → `CompassThreeSixtyX` over 0..360), `SetHealthMeterPercent`,
`SetMagickaMeterPercent`, `SetStaminaMeterPercent` (0..100, from the player's actor values),
`SetCrosshairTarget(abActivate, aName, abShowButton, abTextOnly, abFavorMode, abShowCrosshair,
aWeight, aCost, aFieldValue, aFieldText)` for what the crosshair is on (the play session's
activation target, through `HudSignals`), and `ShowMessage` for Debug.Notification (the
messages at the top left). The engine's own prompt, notice and loading screen stay out of Play.

Every menu's `PlaySound(id)` plays a UI sound by editor id at no place: a sound descriptor's
(`UIObjectiveNew`, `UIMenuFocus`: SNDR) or a sound's (`UIMenuOK`: SOUN, through its SDSC).

Quest updates (`QuestNotification` in the HUD): the HUD shows one notification at a time, and
the engine sends the next only once `QuestUpdateBaseInstance.CanShowNotification()` says the last
one has played out. A notification is `ShowNotification(text, status, soundId, objectiveCount,
type, ...)` (type 0: a quest's) with the objectives put into `QuestUpdateBaseInstance.ObjectivesA`
first, as pairs of text and status (a status shows as "Status: text"); the HUD shows at most 3.
With a text, the HUD spells out `status: TEXT` letter by letter, then the objectives; without
one, only the objectives (and their sound, `UIObjectiveNew`). The engine sends (`questUpdate` in
`src/shell/hud-controller.ts`, from the runtime's quest updates):

- a quest's first objective shown: the quest's name, no status, `UIQuestNew`, the objective;
- later objectives: their lines (completed or failed ones after `sHUDCompleted` /
  `sHUDFailed`), together while they come together;
- a quest completed or failed: its name after `sQuestCompletedText` / `sQuestFailed` ("QUEST
  COMPLETED: UNBOUND"), `UIQuestComplete`.

Miscellaneous objectives (quest type 6) and quests without a name announce no quest, only lines.
Texts have their tags filled in (`src/scripting/runtime/quest-text.ts`: `<Alias=...>`,
`<Alias.ShortName=...>`, `<Global=...>` of the quest's QTGL globals).

Help messages (Message.ShowAsHelpMessage) are `ShowTutorialHintText(text, show)`: shown for
their seconds, again after their interval, at most their times, until the player presses their
user event; one done is not shown again until `ResetHelpMessage`. A "[Activate]" in the text
becomes the key's art: the HUD asks `GetButtonFromUserEvent("Activate")` and the engine answers
the art's name (`E`; `src/ui/button-art.ts`: the event's first key in the control map, else its
mouse button) for the HUD's exported bitmap `E.png`.

## Menu mode

While a menu that pauses the game is open (a message box now; the journal, the inventory and
the game's other menus as they come), the game is in menu mode (`PlayMode`, `GameSession.
menuMode`): the frames' game clock stands still (`main.ts`), so the player, the actors'
animations, the particles and the sky's hour stop; the scripts' clocks stop too, and only
`Utility.WaitMenuMode` counts on (`PapyrusScheduler.wallTime`; `Utility.Wait` waits out the
menu), `Utility.IsInMenuMode` is true; the sound categories the data pauses during menus
(`AudioCategoryPausedDuringMenu`, `...Fade`, `...Load`) go quiet while music and the interface
play on; the mouse leaves the 3D view for the menu's cursor and comes back after.

## Message boxes

`messagebox.swf` shows Debug.MessageBox and Message.Show (`src/shell/message-boxes.ts`), one at
a time: `_root.InitExtensions()`, `_root.SetPlatform(0, false)`, then the callbacks
`setMessageText(text, html)`, `setIsCancellable(cancellable, cancelIndex)` and
`setButtons(focusFirst, ...labels)` (a box without buttons of its own shows `sOk`); the menu
answers `buttonPress(index)`. On PC the buttons take no keyboard focus (the movie sets
`disableFocus` for platform 0): they are clicked, and a Yes/No box also takes Y and N.

## The game's menus in play

`src/shell/game-menus.ts` opens the menus the player opens by the control map's gameplay
events (Tween Menu, Journal, Pause, Quick Inventory, Quick Magic, Quick Stats, Quick Map,
Favorites, Wait), one at a time, each in menu mode, and sets the HUD's mode for it
(`ShowElements(mode, show)`: the HUD shows the elements of its last mode, `TweenMode`,
`InventoryMode`, `DialogueMode`, `BookMode`, `BarterMode`, `WorldMapMode`, ...).

Esc: a page cannot keep the browser from freeing the mouse on Esc, so in Play the mouse let go
while the game plays opens Pause, as Esc does in the game. In full screen the page keeps Esc
(Keyboard Lock, Chromium) and the key itself is the game's. Tab stays with the menus (the
menu layer keeps it from moving the page's focus).

The tween menu (`tweenmenu.swf`): `_root.InitExtensions()`, `_root.SetPlatform(0, false)`, then
`StartOpenMenuAnim(abLevelUp, date, level, progress)`: its bottom bar shows the date as the game
writes it (`formatGameDate`, `src/world/game-time.ts`: "Sundas, 7:12 PM, 17th of Last Seed, 4E
201" from `sDay*`, `sMonth*`, `sTimeAM`/`sTimePM`, the ordinal suffixes and `sOf`; the era has
no setting), the player's level and the progress to the next. The menu asks `HighlightMenu(i)`
and `OpenHighlightedMenu(i)` (1 Skills, up; 2 Magic, left; 3 Inventory, right; 4 Map, down: its
`FrameToLabelMap`), and on Tab or Esc `StartCloseMenu`; the engine answers
`StartCloseMenuAnim()`, and the menu's `CloseMenu` once its animation is done closes it. A
menu chosen takes the tween's place at once.
TODO(M9): the tween camera (the view of the player in third person behind the menu) and the
sounds of highlighting and choosing.

## The journal

`quest_journal.swf` (`src/shell/journal-menu.ts`): J opens it on the page it was left on, Pause
(Esc) on the system page: `_root.InitExtensions()`, `_root.SetPlatform(0, false)`, then
`RestoreSavedSettings(page, tabsDisabled)`. It asks `ShouldShowMod` (no: the installed content
page is an online store), `RememberCurrentTabIndex(page)` and, as it closes,
`CloseMenu(page, quest, instance)` (both remembered for the next time); its bottom bar asks
`RequestPlayerInfo` (the date, the level and the progress, as the tween menu's bar).

Quests (`journalQuests`, `src/scripting/runtime/journal.ts`): the quests given to the player (an
objective shown, or a journal text from a stage), newest update first. `RequestQuestsData(list)`
fills the list's `entryList` with `{text, formID, instance, active, completed, type}` (type picks
the title's end pieces: the quest's type) and answers `(questToSelect, instance, hasMisc,
miscActive, allowShowOnMap)`; the menu adds the MISCELLANEOUS entry itself and sorts (done
quests last). `RequestObjectivesData` (no answer: the menu reads the entry right after) sets
the selected entry's `description` (the latest journal text the quest's stages chose: their log
entries' CNAM) and `objectives` (`{text, active, completed, failed}`, newer first; for
MISCELLANEOUS every miscellaneous objective not done, with its quest's `formID`).
`ToggleQuestActiveStatus(formID, instance)` turns a quest active or not (several may be) and
answers its new state; `ToggleShowMiscObjectives(active)` does it for the miscellaneous ones.

Stats: `updateStats` is answered with every statistic as name, value, category and an unused
field (`src/gameplay/misc-stats.ts`: the game's stats in the journal's order and categories,
after UESP); the menu shows `"$" + name`, translated as it is set.

System: the menu lists Quicksave, Save, Load, Installed Content, Settings, Controls, Help and
Quit. Quit to the main menu ends the game and opens its main menu; quit to the desktop leaves
Play. Help: `PopulateHelpTopics(list)` gets the topics of HelpManualPC (FLST 0x163, Skyrim.esm:
its messages, by their titles) as `{text, index}`; `RequestHelpText(index, titleField,
textField)` sets the message's title and text, and the menu turns its "[Event]"s into key art
(`GetButtonFromUserEvent`, answered for every menu in Play). TODO(M12): saving and loading.
TODO(M9): the settings, the controls, Show on Map.

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

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
Text the engine sends is translated before it is sent.

## The main menu

`src/shell/play-mode.ts` opens `startmenu.swf` as the game does: once its first frame has run,
`_root.MenuHolder.Menu_mc.InitExtensions()`, then the callback `sendMenuProperties` with the
menu's properties (read by its `setupMainMenu` by index: 0 Quit, 1 saves exist (Continue, Load),
2 version text, 3 Press Start, 4 the Anniversary upgrade banner, 5 Downloadable Content, 6 Help,
7 Mod Manager, 8 Creations shown, 9 logged in, 11 PS5 transfer, 12 new Creations, 13 Creations
usable, 14 Switch transfer), then `FadeInMenu`. On PC since 1.6.1130 Mods are part of Creations
(UESP). Creations is an online store and stays unusable (localhost only). It shows NEW, LOAD,
CREATIONS, CREDITS, QUIT.

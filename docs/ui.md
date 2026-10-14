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

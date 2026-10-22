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
names the vanilla menus import are covered (`node tools/swf-info.ts --fontlib`). Each menu is
served with the fonts it imports linked into it (docs/formats/swf.md, "Linking imports"): Ruffle
loads an imported library anew for every player, which made a menu take seconds to open.

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
CREATIONS, CREDITS, QUIT. Its music is `music\special\mus_maintheme.xwm` (the file music mods
replace), played once from the menu's start in the music category; it fades out with the menu as
a new game starts. The menu plays its own sounds (UIMenuOK, UIMenuFocus, UIStartNewGame).

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
(`System.capabilities.numControllers` 1, `Selection.numFocusGroups` 1,
`Selection.getControllerFocusGroup` 0, `Selection.getControllerMaskByFocusGroup` 1,
`Selection.setControllerFocusGroup`, `Selection.getFocusBitmask` (1 for the focused clip),
`Selection.getModalClip` / `setModalClip`). Without them no menu takes a key. CLIK's
`UIComponent.focused` setter walks `Selection.numFocusGroups` and the controllers of each group
to move `Selection`: without it `focused = true` (the race menu's name box, `ShowTextEntryField`)
focuses nothing, and CLIK's `TextInput` hands the focus on to its text field only for the
controllers `getFocusBitmask` names.

The engine hands the keys over itself (`Menu.pressKey`, `src/ui/menu-host.ts`), as GFx gets
them from the game: a page key on the topmost menu becomes `InputDelegate.instance
.handleKeyPress("keyDown" | "keyHold" | "keyUp", code)` with its Flash key code
(`src/ui/key-codes.ts`), and the page's event stops there. A Flash player takes keys only once
it has been clicked (Ruffle's own focus, which no script can give it), and a menu opened by a key
(E on a chest, Tab) must take keys at once. Keys the engine handles first (`onKey`: F to favor,
R to drop) and keys a menu takes as others come before: its own (`keyAs`), else the control
map's Menu Mode context (`src/ui/menu-keys.ts`, `MenuHost.menuKey`), whose Accept, Cancel, Up,
Down, Left and Right are bound "as" gameplay events: E is Enter, Tab and Esc are Tab, W, S, A
and D are the arrows, following the player's bindings. A menu without an `InputDelegate`, or a
text field being typed into, gets the page's keys from the player itself. The console's key
passes every menu (`MenuHost.passKey`; Menu Mode binds Console too): it opens over any of them.

Ruffle enters no other player while one runs a call into the engine (a GameDelegate.call, a
button's onPress): a call into another menu then answers undefined and does nothing (the HUD's
`ShowElements("TweenMode", false)` as the tween menu closes was lost, leaving the HUD in tween
mode). The host runs such calls once that call has returned (a microtask), in order; calls into
the menu whose call runs work at once.

The engine tells each menu its platform (`SetPlatform(0, false)`: PC with keyboard and mouse);
the start menu then shows the mouse version of its buttons, and `ShowDeleteButtonHelp(false)`
hides the delete-save hint while there is no save. PRESS ANY BUTTON (property 3) is not shown:
the menu opens on its list.

## The mouse

Ruffle takes the mouse itself and picks as Flash does: a clip with mouse handlers (`onPress`,
`onRollOver`, ...) gets the events of everything in it, within its `hitArea` if it has one. Two
things the menus count on under GFx are added:

- `Mouse.getTopMostEntity` (`src/ui/gfx-mouse.ts`), Scaleform's: the topmost object under the
  mouse, the deepest clip whose own shapes are hit or a text field. The race menu's list and
  panels take a click on themselves and ask it which entry is under the mouse (the list walks up
  from it to its selected entry, a panel calls `onPress` of its parent); CLIK's components ask it
  as the wheel turns. Without it their clicks did nothing.
- Text fields keep their own `autoSize` when GFx's `verticalAutoSize` or `verticalAlign` fits
  their height (below): a message box's button centers its label (`autoSize = "center"`) over
  its `HitArea`; sized from the left instead, the label stood beside the area that takes the
  mouse.

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
- A field's `text`: GFx gives an HTML field that is one paragraph (`<p align="right">VALUE</p>`)
  without a paragraph end ("VALUE"), Ruffle with one ("VALUE\r"); the HUD builds its item
  prompt from such fields ("WEIGHT 9 VALUE 25"), which then broke over lines. As the movie
  loads (`src/ui/translate-movie.ts`) such a field's paragraph becomes its own alignment (its
  layout) and its text loses the `<p>`: it shows the same.

GFx sizes fields to their text (`src/ui/gfx-text.ts`): `verticalAutoSize` ("top": the field grows
down to fit its text, as AS2's `autoSize`; "bottom", "center": that edge stays), `textAutoSize`
("shrink", "fit": the size goes down a point at a time until the text fits, from the size the
field was made with) and `verticalAlign` ("bottom", "center": the text sits so in the field's box).
The bridge gives TextField those properties; the fields that need it again as their text changes
are watched (a clip's onEnterFrame on `_root`) and fitted again the next frame. The height fits
through AS2's `autoSize`, which sizes the width too: a field's own `autoSize` stays, one without
gets its text's alignment ("left", "center", "right": the text stays where it is). Vanilla uses
"top" and "bottom" (the HUD), "shrink" and "bottom" alignment (the loading menu).

Still missing in Ruffle (0.7.1), and so in the menus: `<img>` in a text field's HTML (the HUD's
help messages show their keys' art as `<img src='E.png'>`: the text shows, the key does not).
TODO(M13), ruffle-rs/ruffle#16618.

## Videos

Before the main menu the intro plays: [General] sIntroSequence (by default `BGS_LOGO.BIK`; a
comma-separated list plays in turn, an empty one none), the files under `DataVideo`; Game.PlayBink
plays one over the game. The browser plays no Bink: the audio worker converts the file with
ffmpeg.wasm (binkvideo and binkaudio_dct to H.264 and AAC in an MP4, `src/audio/bink-video.ts`;
the 6.9-second 1920 × 1080 logo takes about 3 s, black meanwhile) and a `<video>` element plays
it over everything (`src/shell/video-player.ts`), its sound into the master volume. A key (Esc,
Enter, Space, Tab, E) or a click skips it. BGS_Logo.bik has two stereo audio tracks; the first
plays (TODO(M13): what the second is for).

## The main menu's background: the mist menu

Behind the start menu the game renders its "Mist Menu" (CommonLibSSE-NG's `RE::MistMenu`:
six directional ambient colours, the mist model, a camera path, the default logo's shader
property, a load screen model, the image space it replaces). `src/shell/mist-menu.ts`:

- The mist: `meshes\interface\intmenufogparticles.nif` (a particle system on AutoPlay),
  turned by `fUIMistModel_RotateZ_G` (-180) and moved by `fUIMistModel_Translate*_G` (0).
- The logo: `meshes\interface\logo\logo.nif` (a lit, mirror-like shape, 39 × 73 units, and
  the Autoplay behavior), scaled by `fUIMistMenu_DefaultLogoNIFScale` (1), moved by
  `fUIAltLogoModel_Translate*_G` (0).
- The camera and the light: the INI's camera (`fUIMistMenu_CameraX/Y/Z_G` -50, 600, 80 looking
  at -50, 0, 0) shows the logo at about 12% of the screen's height, and the data holds no light
  for the menu (`rUIMistMenu_Ambient*` are 0). Both are fitted to the game as it shows itself
  (1.7.104, a screenshot of its main menu): the logo 69% of the screen's height, its middle at
  36% of the width and 47% of the height, lit from the upper left and the front; the field of
  view is the INI's `fUIMistMenu_CameraFOV_G` (75, horizontal of a 4:3 frame).
  A loading screen's camera path looks at its model from the -Y side, so its light is the same
  one mirrored to that side (still the viewer's upper left and front): the main menu's would
  light the models from behind (a flat one, the war map of `SkyrimHolds`, black).
- The Anniversary Edition's logo (`logo01ae_animated.nif`, silver to gold) when the load order
  has Creations beyond the free ones (Fish, Survival Mode, Rare Curios, Saints & Seducers and
  their resource pack): inferred, as the upgrade installs them. TODO(M13): the image space the
  menu sets and how the engine places its camera (fitted to a screenshot above).

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
out. The engine plays UILoadscreenMist as a loading menu opens.

**How long it takes** (NEW to the HUD; headless Chrome with `?devdata`, the maintainer's
machine; the game itself takes 10–15 s). It was 91–98 s: the scripts' new game 38 s (OnInit of
the 2,338 quests 4.2 s, the persistent references 7.4 s, the 443 quests that start with the game
25.7 s, DA16 alone 16 s), the world 32 s and its actors and the player's body 14 s, the rest
fades and the loading screen. Nearly all of it was waiting: 66,000 reads, most of them one
record or one script at a time, each a round trip that the next one waited for. Now 14.5–19 s:
the new game 8.5 s (1.2 s to the scripts, quests 0.8 s, persistent references 0.8 s, the quests
that start 6.2 s, DA16 3.2 s of it), the world with its actors 4–7.5 s, the fades 1 s; 6,400
reads. The plugins and archives are read through block caches
([formats/esm.md](formats/esm.md#reading-records)), and reads whose order does not matter are
made side by side ([scripting.md](scripting.md#a-new-game)). What is left is mostly work on the
main thread: the quests' alias searches (conditions on every persistent reference), and while
the world loads, its frames behind the loading screen (the world drawn, the player and actors
stepped, so everyone stands there before the fade) and the actors' face tints.

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
4:3 frame. The mouse turns the model about Z ([Interface] fUILogoModel_MouseToRotateSpeed, 0.02,
times the mouse's input as mouse look scales it: π × fMouseHeadingSensitivity radians a pixel,
so about 0.05° a pixel; taken as radians a pixel alone it turned some 80 times too fast); after fUILogoModel_RotationPauseDuration (0.25 s) without the mouse it turns on
its own at fUILogoModel_AutoRotateSpeed (0.1 radians a second), within ONAM's limits (degrees
from RNAM's turn; back and forth between them unless they are a full turn: 350 of the 371 vanilla
screens allow −180 .. 180). The settings' units are inferred from their names and sizes.

**Load doors** in Play go behind the loading menu and a loading screen as well
(`PlayMode.loadingScreen`), as fast travel does: the place loads with the game running (the
player is put down in it), and the screen goes once it has.

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
messages at the top left). The shout meter: `SetShoutMeterPercent(aPercent, abForce)` (0..100:
full once the voice has recovered; the casting engine's `voiceMeter`, sent as it changes by a
whole percent) and `FlashShoutMeter()` as the player shouts before it has recovered
(docs/gameplay.md, "Casting and shouts"). The engine's own prompt, notice and loading screen stay
out of Play.

The stealth meter (`src/shell/hud-stealth.ts`): `RegisterHUDComponents` hands the engine the
clips it drives itself, among them `StealthMeterInstance` (frames `FadeIn` 1, `FadeOut` 6,
`FadedOut` 10), its eye `SneakAnimInstance` (120 frames: 1 `invisible`, shut, to 100 `visible`,
open, where it stops; 101–120 play back to `visible`) and its text
`SneakTextHolder.SneakTextClip.SneakTextInstance` (the holder plays 45 frames from `Start`).
While the player sneaks the HUD is in `ShowElements("StealthMode", true)` (every element but
the crosshair) and the meter plays `FadeIn` (`FadeOut` as they stand); the eye is set to the
frame of how far it is open (the actor that knows the player best:
[ai.md](ai.md#detection)), easing a quarter of a second from shut to open; the text flashes
`sSneakDetected` ("[DETECTED]") as an actor comes to detect the player and `sSneakHidden`
("[HIDDEN]") as the last one aware of them loses them.

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
`<Alias.ShortName=...>`, `<Global=...>` of the quest's QTGL globals, the pronouns of the actor in
an alias by its sex, `<Alias.Pronoun=...>` he / she, `.PronounObj` him / her, `.PronounPos` his
/ hers, `.PronounPosObj` his / her, `.PronounRef` and `.PronounInt` himself / herself (the
settings sPronoun*Male / *Female), and its race's name, `<Alias.Race=...>`).

Help messages (Message.ShowAsHelpMessage) are `ShowTutorialHintText(text, show)`: shown for
their seconds, again after their interval, at most their times, until the player presses their
user event; one done is not shown again until `ResetHelpMessage`. A "[Activate]" in the text
becomes the key's art: the HUD asks `GetButtonFromUserEvent("Activate")` and the engine answers
the art's name (`E`; `src/ui/button-art.ts`: the event's first key in the control map, else its
mouse button) for the HUD's exported bitmap `E.png`.

The compass (`src/shell/compass.ts`): four times a second the engine sets
`HUDMovieBaseInstance.CompassTargetDataA` (per marker its heading in degrees from north, alpha
0..100, the "Compass Marker" frame, scale in percent) and calls `SetCompassMarkers()` when it
changed. Its frames: 1 Quest, 2 QuestDoor, 3 PlayerSet, 4 Enemy, 5 + a map marker's type
(discovered), 72 + its type (undiscovered). It shows the targets of the active quests' shown
objectives (QOBJ QSTA, the alias's reference, its conditions run on the target: DialogueFollower's
"is waiting for you" is the follower's WaitingForPlayer) in the player's worldspace or cell; a
target in another cell or world at the load door the way there goes through (QuestDoor: the
first door of the route over the navmeshes and load doors, `src/ai/routes.ts`, searched once per
target and space); the actors fighting the player (Enemy) within fHUDCompassLocationMaxDist; and
the map markers within iMapMarkerVisibleDistance, fading from iMapMarkerFadeStartDistance; a
marker seen so is visible on the map, one reached within iMapMarkerRevealDistance is discovered
(it can be travelled to) and announced as a quest is: its name and sDiscoveredText, with its
discovery music (by the marker's type: MUSDiscoveryCity for cities and their castles,
MUSDiscoveryTown, MUSDiscoveryDungeon for caves, forts, ruins, mines and dragon lairs,
MUSDiscoveryGeneric else; one selection, then the type ends). Skyrim gives no experience for it
(iXPRewardDiscoverMapMarker is one of Fallout's unused settings).

Riding a horse the HUD is in `ShowElements("HorseMode", true)` (the meters, the compass,
messages; no crosshair), with the weapon drawn in `WarHorseMode` (the crosshair, stamina, the
charge meter and arrow info too).

The HUD also shows: speech around the player (`ShowSubtitle(text)`, `HideSubtitle()`; with
General Subtitles, `SetSubtitlesEnabled`), the lines actors say from scripts
(`src/shell/world-lines.ts`, ObjectReference.Say: the topic's first valid info in the speaker's
voice, lips moving); a location the player enters (`SetLocationName(name)`, as the player's
location changes, their scripts hearing OnLocationChange(old, new)); a load door's prompt kept
while its place loads (`SetLoadDoorInfo(show, text)`).

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
`disableFocus` for platform 0) and the movie's CLIK input does not reach them in Ruffle: they
are clicked, and the engine takes the menu keys itself (Enter or E presses the focused button,
the arrows or W, A, S, D move the focus, Tab or Esc cancels a box that may be cancelled).

## The game's menus in play

`src/shell/game-menus.ts` opens the menus the player opens by the control map's gameplay
events (Tween Menu, Journal, Pause, Quick Inventory, Quick Magic, Quick Stats, Quick Map,
Favorites, Wait), one at a time, each in menu mode, and sets the HUD's mode for it
(`ShowElements(mode, show)`: the HUD shows the elements of its last mode, `TweenMode`,
`InventoryMode`, `DialogueMode`, `BookMode`, `BarterMode`, `WorldMapMode`, ...).

Esc: a page cannot keep the browser from freeing the mouse on Esc, so in Play the mouse let go
while the game plays opens Pause, as Esc does in the game. In full screen the page keeps the
game's keys (Keyboard Lock, Chromium: `LOCKED_KEYS` in `src/main.ts`, every key but Tab and
F11, which stay with the system and the browser), so Esc is the game's and the browser's
shortcuts do not act on its keys. Outside full screen they still would (Ctrl+W, sneaking
forward, closes the tab; F5, Quicksave, reloads it): while a game runs the page asks before it
is left (beforeunload; Vite's reloads in development pass). A game key's release is the
game's too (Alt, Sprint, let go would focus the browser's menu button). Tab stays with the
menus (the menu layer keeps it from moving the page's focus), and menus that take no input are
inert, so the page's focus never lands in the HUD's player.

The shell's brand (top left) leaves Play: in a game it asks as the journal's Quit to Desktop
does ("Quit to desktop? Any unsaved progress will be lost.", Yes / No); Play ends with its
world unloaded and its sounds stopped.

The tween menu (`tweenmenu.swf`): `_root.InitExtensions()`, `_root.SetPlatform(0, false)`, then
`StartOpenMenuAnim(abLevelUp, date, level, progress)`: its bottom bar shows the date as the game
writes it (`formatGameDate`, `src/world/game-time.ts`: "Sundas, 7:12 PM, 17th of Last Seed, 4E
201" from `sDay*`, `sMonth*`, `sTimeAM`/`sTimePM`, the ordinal suffixes and `sOf`; the era has
no setting), the player's level and the progress to the next. The menu asks `HighlightMenu(i)`
and `OpenHighlightedMenu(i)` (1 Skills, up; 2 Magic, left; 3 Inventory, right; 4 Map, down: its
`FrameToLabelMap`), and on Tab or Esc `StartCloseMenu`; the engine answers
`StartCloseMenuAnim()`, and the menu's `CloseMenu` once its animation is done closes it. A
menu chosen takes the tween's place at once.
The movie plays no sounds; choosing plays the engine's UITweenSelectSD (silence in the vanilla
data), highlighting nothing.

**The tween camera** (`src/shell/tween-camera.ts`; CommonLibSSE-NG's TweenMenuCameraState: the
rotation and field of view it began with, an added rotation and field of view eased toward
targets, an ending flag). The view stays the one the menu opened over, first or third person
(camera mods keep the state before it: SmoothCam, TrueDirectionalMovement); it zooms in by
[Camera] fTweenCamZoomFOVMod (10°) at fTweenCamZoomSpeed (25° a second) and leans
fTweenCamRotAngle (0.05 radians) toward the highlighted choice (Skills up, Magic left, Items
right, Map down) at fTweenCamRotSpeed (4), coming back at fTweenCamRotClosingSpeed (10) as it
closes. The easing and the signs are inferred from the settings' names (TODO(M13): check).

While scripts keep the menus from the player (`Game.DisablePlayerControls`' abMenu, as the
opening does) only the journal opens, and with abJournalTabs its system page alone
(`RestoreSavedSettings(tab, abTabsDisabled)`).

## Waiting and sleeping

`sleepwaitmenu.swf` (`src/shell/sleep-wait-menu.ts`; T, or a bed's Sleep): the engine calls
`_root.InitExtensions()`, `_root.SetPlatform(0, false)`, then `SleepWaitMenu_mc.SetSleeping(b)`
("Rest how long?" or "Wait how long?") and `SetCurrentTime(date)`. `OK(hours)` passes the hours
one at a time (the clock and the scripts' game-time timers with them, the menu's time and hours
counting down; the game's pace is not documented: 0.2 s an hour), then closes the menu;
`Cancel` (Tab, Esc) closes it. A sleep sends `OnSleepStart(start, desired end)` and
`OnSleepStop(interrupted)` to those registered (`RegisterForSleep`), in game days.

The menu does not open where the player may not wait, and the game's message says why:
`sNoWaitDefault` / `sNoSleepDefault` while scripts disable waiting (`Game.SetInChargen`'s
abDisableWaiting), `sNoWaitInAir` / `sNoSleepInAir` off the ground, `sNoWaitHostileActorsNear`
while someone fights the player, `sNoWaitTakingHealthDamage` while an effect takes their health,
`sNoWaitWhileAlarm` while guards pursue them and `sNoWaitTrespass` where they trespass (the
sleep versions likewise; `noWaitReason`, src/gameplay/waiting.ts). A bed is furniture with a
sleep marker (FURN FNPR type 2); its prompt is `sFurnitureSleep`; another's bed is not slept in
(`sNoSleepInOwnedBed`). As in the game the player does not lie down: the menu opens where they
stand (the bed animations are the NPCs'; mods such as Go To Bed add the player's). Each hour
health, magicka and stamina regenerate as over the real seconds it stands for; the rested
bonuses are the scripts' (PlayerSleepQuest's OnSleepStop: Rested, Well Rested, Lover's Comfort).
After the hours the actors are where their packages had them meanwhile (docs/ai.md, "Actors
away"); an attack breaks the wait off (a sleep is told it was interrupted).

## Training

`trainingmenu.swf` (`src/shell/training-menu.ts`; `Game.ShowTrainingMenu(trainer)` from a
dialogue's script) has no calls to fill it: the engine sets the card's fields
(`_root.TrainingMenuObj`: `SkillName` the skill and the player's level in it, `TrainerSkill`
the trainer's tier as a skill level name, `TimesTrained` "n/5", `TrainCost`, `CurrentGold`) and
calls its `SetPlatform`. The movie handles no keys: Accept (E, Enter) trains and Cancel (Tab,
Esc) leaves, as its buttons do (`Train`, `Exit`). The skill is the trainer's class's (CLAS DATA:
skill u8 @4, 0 one-handed .. 17 enchanting; the level it teaches up to u8 @5: 50, 75, 90).
A session (UESP, "Trainers") raises the skill by one, five a player level, and costs
fTrainingMultCost × (1, iTrainingExpertCost above 50, iTrainingMasterCost above 75) × skill +
50 gold, which goes to the trainer; sCanNotTrainAnymore, sCanNotTrainHigher and
sInsufficientGoldToTrain say why one cannot be had. An actor value's name is its AVIF record's,
the one named "AV" + the value's name. A session raises the skill as if earned (the
experience it lacked: docs/gameplay.md); the card's `SkillMeter` shows its progress.

## Levelling up

`levelupmenu.swf` (`src/shell/level-up-menu.ts`): `_root.InitExtensions()`; the menu calls
`addHealth`, `addMagicka` or `addStamina` as its buttons are pressed. The choice raises the
attribute by iAVDhmsLevelUp (stamina also the carry weight by fLevelUpCarryWeightMod), the level
by one, and gives a perk point (UESP, "Leveling"). It opens instead of the skills menu while a
level-up waits (`GameState.levelUps`; the tween menu's `StartOpenMenuAnim(abLevelUp, ...)` shows
it), the skills menu after it. A level-up waits as the experience skills give covers the level's threshold (docs/gameplay.md).

## The console

`console.swf` (`src/shell/console-menu.ts`; ~): the engine shows it (`Console.Show()`) and hides
it (`Console.Hide()`, then the menu's `HideComplete`); the command field is the player's own text
input (Ruffle takes the typing), and Enter makes the menu call `ExecuteCommand(line)`. What a
command prints goes to `Console.AddHistory(text)` (kept between openings). The game is in menu
mode while it is open. The commands (`src/shell/console-commands.ts`): a line is a command and
its arguments (quotes keep spaces), optionally after a reference and a dot ("player.additem f
100"); forms by editor id or hex form id; an unknown command prints `Script command "x" not
found.`. Built: help, coc, additem, removeitem, setstage, getstage, startquest, stopquest,
completequest, set ... to, getav, setav, modav, forceav, advlevel, tm, fw, epc, dpc, tgm (god
mode: "God Mode -- ON"; the player takes no damage and cannot die), kill (as Actor.Kill;
`player.kill` shows the player's death: [ai.md](ai.md#combat)), showracemenu, qqq. coc (`src/shell/cell-placement.ts`) puts the player in an interior cell at
its entrance, in an exterior cell at its COC marker (COCMarkerHeading), else at its middle on
the ground. TODO(M13): the rest of the game's commands, selecting references by clicking.

The console opens at the main menu too, as in the game: there `coc <cell>` starts a new game in
that cell without the opening (Unbound, MQ101, is not started: `ScriptRuntime.newGame`'s
`opening`), with the HUD and the player's controls as a game without it has them; `qqq`
quits; the game's other commands answer that no game is running.

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
after UESP); the menu shows `"$" + name`, translated as it is set. Favorite Weapon, Spell,
School and Shout are names: what the player used most (`src/scripting/runtime/usage-stats.ts`:
each swing of a melee weapon or shot of a bow, each spell cast (a concentration spell each time
it is let go) and its school (its cost's skill, named by its AVIF), each shout; the first to reach
the most on a tie; TODO(M13): what the engine counts as a use), read as the journal opens.

System: the menu lists Quicksave, Save, Load, Installed Content, Settings, Controls, Help and
Quit. Quit to the main menu ends the game and opens its main menu; quit to the desktop leaves
Play. Help: `PopulateHelpTopics(list)` gets the topics of HelpManualPC (FLST 0x163, Skyrim.esm:
its messages, by their titles) as `{text, index}`; `RequestHelpText(index, titleField,
textField)` sets the message's title and text, and the menu turns its "[Event]"s into key art
(`GetButtonFromUserEvent`, answered for every menu in Play). TODO(M12): saving and loading.
Show on Map: an objective with a target on the map gets the `questTargetID` of its first
target (its reference); the movie closes the journal and calls `ShowTargetOnMap(id)`, and the
map opens over that target (`src/shell/game-menus.ts`: the map of the target's world, without
the player when it is another map).

Settings (`src/shell/journal-settings.ts`, `src/shell/settings-options.ts`): the movie lists each
page's entries and asks the engine to fill them (`RequestGameplayOptions`, `RequestDisplayOptions`,
`RequestAudioOptions(entryList)`): an entry the engine has gets its `ID` (the INI setting,
"Interface:bDialogueSubtitles"), `value` and `defaultVal`; those left without an ID are dropped
(the console's and Kinect's options, Survival Mode, Tree LOD Fade and DDOF Intensity: TODO(M13)).
A slider's value is its position 0..1 (the movie moves its bar by value × 20), a stepper's its
index, a checkbox's 0 or 1. The slider ends are the game's where known: Object, Actor and Item
Fade from the Low to the Ultra preset of the installation (Low.ini, Ultra.ini: 5–30, 5–15,
1.5–10), Grass, Light, Specularity and Shadow Fade from 0 to the maxima in Skyrim_Default.ini
(7000, 3500, 2000, 1000); Brightness and Look Sensitivity are not documented (linear about their
defaults, Brightness fGamma 0.5–1.5: TODO(M13) check against the game). The audio page lists the master; the engine adds the
sound categories with a slider (SNCT: on the menu, its name, UNAM its default). `OptionChange(ID,
value)` changes a setting, `SaveSettings` keeps them (`src/shell/preferences.ts`: in the
browser, as the game's SkyrimPrefs.ini). The engine reads them through `IniSettings` over the
INI files and applies them at once: Dialogue Subtitles (the dialogue menu's text; off by default,
as in the game), Crosshair (`SetCrosshairEnabled`), HUD Opacity, Invert Y, Grass Fade, Light
Fade, Brightness (fGamma, the final image's gamma), the volumes. TODO(M13): Object, Actor, Item,
Specularity and Shadow Fade (references and effects fading by distance). Leaving a changed page
the menu says "Saving...", calls `SaveSettings` and waits for the engine's `SettingsSaved`.

Controls (`src/shell/journal-controls.ts`, keyboard and mouse): `RequestInputMappings(entryList)`
gets the main gameplay events the player may remap (the control map's remappable columns) as
`{text, buttonName}` (the menu shows "$" + the name, and the art of the key or button);
`StartRemapMode(event, entryList)`: the next key or mouse button the player presses becomes the
event's, `FinishRemapMode(true)` and the list's art redone; a key a fixed gameplay event uses
(Esc for Pause, the hotkeys' digits) is reserved (`FinishRemapMode(false)`); a key another
remappable event used goes to it in exchange (`src/formats/controlmap/remap.ts`).
`ResetControlsToDefaults` returns to the control map; `SaveControls` keeps the bindings in the
browser (as the game's ControlMap_Custom.txt) and the engine answers `SettingsSaved`. The
player takes new bindings at once.

## Dialogue

Talking to an actor in Play opens `dialoguemenu.swf` (`src/shell/dialogue-menu.ts`) over the game,
which goes on (no menu mode; the HUD in `DialogueMode`, the mouse on the menu): the engine calls
`_root.InitExtensions()`, `_root.SetPlatform(0, false)`, `SetSpeakerName(name)`; the actor greets
(`ShowDialogueText(line)` while each response is said, `HideDialogueText()` after;
`NotifyVoiceReady()` lets the player skip, which the menu asks with `SkipText`); then the topics:
`PopulateDialogueList(text, isNew, index, ..., selected)` (triples, then the topic to select or -1)
and `ShowDialogueList(slideAnim, copyVisible)`. The menu asks `TopicClicked(index)`; the actor says
the topic's info, and its choices (or the actor's topics again) are listed; a Goodbye info, or
no topics left, ends it with `StartHideMenu()`. Tab: the menu fades, asks `CloseMenu`, and
`FadeDone` once faded. A menu the conversation opens (barter, gift, training) hides it; back, the
conversation's menu has the keys again. An actor with no topics to offer (Nazeem; Camilla before
The Golden Claw) opens no menu: it says its greeting where it stands, as a line outside a
conversation (its voice, the HUD's subtitle with General Subtitles), and the mouse stays the
game's.

The topics' texts have their tags filled in as a quest's texts do (`<Global=RoomCost>`:
"I'd like to rent a room. (10 gold)"). The valid rumors (topic subtype Rumors, most without a
text of their own) are one entry with the text of the first that has one ("Give me the latest
gossip."): chosen, one of them is said at random (inferred; TODO(M13): how the game picks).
An entry without text is not listed.

The first conversation waits for nothing read once: the dialogue and the actors' relationships
(a condition of many topics; read in one pass) are read while a new game's world loads, the
menu's movie translated and linked once it has (`DialogueMenu.prepare`).

What is said (`src/scripting/runtime/dialogue-engine.ts`, after the Creation Kit's "Dialogue" and
"Topic Info" pages): the greeting is the first valid info of the running quests' Hello topics
(`HELO`, by quest priority, then topic priority); the player's topics are the starting topics of
the top-level dialogue branches of running quests (a blocking branch's valid topic alone) or the
info's choices (TCLT); a topic says its first info whose conditions hold (run on the speaker, the
player their target, the topic's quest for alias conditions; the quest's dialogue conditions
first), a run of Random infos one of its valid ones, Say Once infos once; a shared info's
responses (DNAM) are said with its voice files. Each response is the voice file of the speaker's
voice type (`src/world/dialogue.ts`: `Sound\Voice\<plugin>\<voice type>\<quest>_<topic>_<info>_<n>.fuz`)
with the face lip-syncing; without one the subtitle stays for `fAIDefaultSpeechMult` seconds a
character. The info's fragments (TIF scripts: begin, end) run with the speaker as `akSpeakerRef`.
The game's dialogue (20,000 topics, 41,000 infos, about 40 MB) is read in bulk once as a new
game starts. Each response's emotion shows on the speaker's face and it gestures (ActionTalking);
an info with Force Subtitle shows its text whatever the setting. The dialogue camera turns the
player's view to the speaker's head and zooms in while they talk (ai.md, "Talking").
Persuade, bribe and intimidate are the game's own topics: their infos' conditions (the
player's Speech and perks, GetIntimidateSuccess, GetBribeSuccess, ...) are valued as every
condition is (docs/scripting.md, "Conditions"), and FavorDialogueScript does the rest through the
natives (GetBribeAmount, SetBribed, SetIntimidated, Game.AdvanceSkill; docs/gameplay.md,
"Guards, fines and jail"). A follower's favors (wait, trade, "I need you to do
something") are the vanilla scripts' and the engine's command mode (ai.md, "Followers, mounts
and vehicles").

## The item menus

The inventory (`inventorymenu.swf`, `src/shell/inventory-menu.ts`; I, or the tween menu's Items),
as its movie expects to be driven (and the container, barter, gift, magic and favorites menus,
which share its parts, alike):

- It imports its parts: `Inventory components/InventoryLists.swf`, `ItemCard.swf`, `BottomBar.swf`
  (served and translated like the menus; the lists' panel animations are only there).
- The engine calls `_root.InitExtensions()`, `_root.SetPlatform(0, false)`, then
  `SetCategoriesList(text, flag, alwaysShown, ...)` (triples; the first category must be Favorites:
  its bit is the one the favorite button tests), fills
  `Menu_mc.InventoryLists_mc.ItemsListHolder.List_mc.entryList` with
  `{text, count, equipState, favorite, filterFlag, enabled, ...}`, calls `InvalidateListData()`, then
  `UpdatePlayerInfo({encumbrance, maxEncumbrance, gold, armor, damage, health, maxHealth, ...})`
  and `RestoreIndices(...)` with what `SaveIndices` gave last time.
- Categories (`src/gameplay/inventory.ts`): their labels are the settings sFavorites, sAllItems,
  sWeapons, ...; their bits (which the movie only tests) the documented vanilla values: Favorites
  0x1, Weapons 0x2, Apparel 0x4, Potions 0x8, Scrolls 0x10, Food 0x20, Ingredients 0x40, Books
  0x80, Keys 0x100, Misc 0x200; All is all of them.
- `RequestItemCardInfo` (on every highlight) is answered at once with the selected item's card
  (`{type, name, count, value, weight, armor | damage | effects | description | soulLVL ...}`; the
  type is InventoryDefines' ICT_ARMOR 1, ICT_WEAPON 2, ...); effects are their magic effects'
  descriptions with the values filled in.
- `ItemSelect(slot)` equips or takes off (the equip system, docs/gameplay.md "Equipment": the
  hand asked for, 0 left and 1 right; the mouse's buttons ask through the movie's
  `AttemptEquip`), uses potions, food and ingredients, reads books;
  `ItemDrop(amount)` removes them; `ShowTweenMenu` (Left) and `CloseTweenMenu` (Tab) say where the
  player goes once the menu has faded and asked `CloseMenu`.
- Keys the engine takes in the item menus: F (favorite), and Esc and E reach the movie as Tab and
  Enter (the control map's menu contexts: Cancel is Tab and Esc, Accept is E).
- A click: GFx calls an entry's `onPress(controller, keyboardOrMouse)` with 0 for the mouse,
  Ruffle with no arguments, so the movie (whose `onItemSelect` asks ItemSelect only for a key)
  takes the click for Enter and asks `ItemSelect()` without a hand; the engine equips the click
  itself (`AttemptEquip(hand)`) and drops that ItemSelect when the click's own follows in the
  same event (else a left click equipped and took off again).
- The HUD stays in the menu's mode (`ShowElements`: InventoryMode, the barter menu's
  BarterMode): its messages and quest updates show over the menu (sItemTooExpensive), the rest
  hides.

The magic menu (`magicmenu.swf`, `src/shell/magic-menu.ts`; P, or the tween menu's Magic) is
driven the same way (`src/shell/item-menu.ts` holds what they share; each menu is a model of what
it lists and what its entries do):

- Its categories: sFavorites 0x1, sAllItems, sAlteration 0x2, sIllusion 0x4, sDestruction 0x8,
  sConjuration 0x10, sRestoration 0x20, sShouts 0x40, sPowers 0x80, sActiveEffects 0x100; before
  the list is filled the engine sets `Menu_mc.hideButtonFlag` to the active effects' bit (their
  entries show no buttons).
- A spell's school is its costliest effect's magic skill; its card (ICT_SPELL 7) has `castLevel`
  (that effect's minimum skill: sNoviceDisplayName below 25 .. sMasterDisplayName at 100),
  `castTime` (SPIT's charge time; 0 for concentration spells, whose cost the card shows per
  second), `spellCost`: the casting engine's magicka cost (`CastingEngine.menuCost`: the base
  cost × (1 − (skill / 400)^0.65), UESP "Magic Overview"; docs/gameplay.md, "Casting and
  shouts"), and for the bottom bar's MagicSkill frame `magicSchoolName`, `magicSchoolLevel`,
  `magicSchoolPct` (the school's skill, the player's level and its progress; without them the
  bar shows the movie's placeholder, "Conjuration 99"). Powers have ICT_SPELL_DEFAULT 13, shouts
  ICT_SHOUT 10 with `word0..2`
  (translation), `dragonWord0..2` and `unlocked0..2`, and the recovery of the last unlocked word
  as their cost; `showUnlocked` while a learned word is locked puts Unlock on the bottom bar
  (`$Unlock`): R asks sConfirmSpendSoul, spends a dragon soul on it (sFailSpendSoul without one)
  and tells the movie `DragonSoulSpent()`.

The favorites menu (`favoritesmenu.swf`, `src/shell/favorites-menu.ts`; Q) lists the items,
spells and shouts marked with F. Its own `PopulateItems` names a function the movie does not
have, so the engine sets `_root.MenuHolder.Menu_mc.itemList.entryList` itself (`{text, hotkey,
equipState, index}`; index the form id) and invokes its `InvalidateData()`. On `ItemSelect` the
engine reads `_root.GetSelectedIndex()` and acts as the inventory or the magic menu would; the
menu closes itself with its fade (Tab, Esc, Q) and `FadeDone`. 1-8 (the control map's
Hotkey1..8: the digits and the keypad's) give the highlighted entry that hotkey (`hotkey` 0..7:
the movie's AppendHotkeyText shows "1. Iron Sword"), taken from the favorite that had it; its
own hotkey again takes it off (`GameState.hotkeys`). In the game, Hotkey1..8 choose their
favorite as the menu would (equipped where it goes, taken off where it is, a potion drunk).

The container menu (`containermenu.swf`, `src/shell/container-menu.ts`; a chest opened, a corpse
searched) lists the container's items and the player's in one list:

- Its categories are the container's (the inventory's without Favorites, their bits moved up by
  10), a divider (a category whose bits are 0: `{text: "", flag: 0, bDontHide: true}`), then the
  player's (the inventory's). The movie is viewing the container while the category selected is
  above the divider (`isViewingContainer`), and shows its buttons for that side.
- E takes or stores the selected item (`ItemTransfer(amount, fromContainer)`, after the
  quantity slider for a stack); R is the movie's X button (`XButtonPress`, which the engine
  calls): on the container's side `TakeAllItems`, on the player's it stores. Equipping a
  container's item (`EquipItem(hand, amount)`) takes it first; the player's (`EquipItem(slot)`)
  is the inventory's.
- Items moved play their pick-up or put-down sound (the item's YNAM / ZNAM, else the default
  object PUSW/PDSW for weapons, PUSA/PDSA armor, PUSB/PDSB books, PUSI/PDSI ingredients,
  PUSG/PDSG the rest).

Activating in the world (`objectActivation`, `src/shell/play-session.ts`): the prompts' verbs are
the settings sOpen, sClose, sTake, sSearch, sTalk, sActivate, or an activator's or flora's RNAM;
an item's prompt shows its weight and value (SetCrosshairTarget's aWeight and aCost; the HUD
leaves out those passed undefined). A container opens its menu, its lid's open sequence and
sound playing (and close as the menu closes); an item is taken (`ScriptRuntime.pickUp`: the
reference leaves the world, its count joins the player's items, OnContainerChanged and
OnItemAdded); the dead are searched.

The barter menu (`bartermenu.swf`, `src/shell/barter-menu.ts`; a dialogue's
`Actor.ShowBarterMenu`) lists the vendor's goods above the divider and below it what the vendor
buys:

- The vendor is the actor's vendor faction (FACT DATA flag 0x4000; its hours and conditions, see
  docs/formats/esm.md): its goods are those in its merchant chest (VENC), what it buys the
  player's items with a keyword in its list (VEND), or without one when it buys what is not
  listed; its gold the chest's and its own (UESP, "Merchants").
- `SetBarterMultipliers(buy, sell)`: the menu shows a vendor's item at value × buy and the
  player's at value × sell. The factor is fBarterMax − (fBarterMax − fBarterMin) × min(Speech, 100) / 100; buying costs at least 1.05 × value, selling gets at most the value (UESP,
  "Speech").
- `UpdatePlayerInfo(playerGold, vendorGold, vendorName, info)`; `ItemSelect(amount, price,
fromVendor)` trades (the movie's `[aiAmount, itemInfo.value, IsViewingVendorItems()]`: an AS2
  array is pushed last element first, so the disassembly reads backwards; the price is the
  card's, its multiplier applied): bought from the chest (sItemTooExpensive when the player cannot pay), sold
  into it, the vendor paying what it has. Selling for more asks first: `GetRawDealWarningString
(total)` is answered at once with sNotEnoughVendorGold.

The gift menu (`giftmenu.swf`, `src/shell/gift-menu.ts`; `Actor.ShowGiftMenu(abGiving,
apFilterList, abShowStolenItems, abUseFavorPoints)`) lists the giver's items (only those of the
filter list, by form or keyword); `SetMenuInfo(abGiving, abUseFavorPoints)` names it GIVE GIFT or
TAKE GIFT; `ItemSelect(amount)` moves them. The function is latent: it returns once the menu
closes. A conversation's menus show in its place: the dialogue menu steps aside and comes back,
and keeps the mouse.

The merchant chest restocks 48 game hours after it last did (UESP "Merchants"; reckoned from
the first trade, checked as the barter menu opens: `ScriptRuntime.restock`): what was sold to it
goes (with its references, improvements and stolen marks) and its own goods and gold are there
again, its leveled lists picked anew (the container's seed moves on with each restock).

Quest items (`src/scripting/runtime/quest-items.ts`: references in a running quest's Quest
Object alias, ALFA FNAM 0x4, held in a container) do not leave the player: not dropped (ItemDrop:
sDropQuestItemWarning), not eaten (sNoEatQuestItem), not stored or placed in a container or a
pocket (their entries `enabled: false`: the movie asks `DisabledItemSelect`, answered with
sDropQuestItemWarning), not offered for sale, not given (unless the gift menu's list names them:
a quest's item asked for). A teammate's inventory (`OpenInventory`: the container menu in NPC
mode, only a teammate's unless abForceOpen) keeps its starting armor (its outfit's pieces:
disabled, sTeammateCantTakeOutfit; giving one of them sTeammateCantGiveOutfit) and takes no more
than it can carry (its name and sTeammateOverencumbered). In the magic menu a shout or power
chosen while the player shouts is disabled (`ShowShoutFail`: sFailShouting). A book lying in the
world is not read while the player fights (sCanNotReadBook).

Dropped items (R, after the quantity slider for a stack) lie in the world a little in front of
the player's feet and fall to the ground (a created reference with their count:
`src/shell/created-objects.ts`; TODO(M13): an improved item's improvement and a stolen item's
owner go with it in the game).

Potions, food and ingredients are used, poisons put on
the weapon and the magic menu's Active Effects listed through the magic system (docs/gameplay.md,
"Magic effects"). Improved items are rows of their own ("Iron Sword (Fine)": the crafting
engine's item stacks), moved and equipped as such. An enchanted weapon's card shows its charge
(`charge`, `usedCharge`: percent); under 100 the inventory's T (`AttemptChargeItem`) has the
movie ask `ShowSoulGemList`: the engine sets the card to a list (ICT_LIST: `listItems` of
`text`, `soulLVL`, `count`, `chargeAdded`, and `currentCharge`; none: sNoChargeItems), and
`ItemCardListCallback(index)` recharges with that gem. Armor, damage and spell costs are shown
with the player's perks (the perk system's entry points).

## The menus' 3D

Some menus show 3D over the world: the book being read, the item turned in the inventory, the
lock picked, the skills' stars. The renderer draws it after the world's image is finished
(`src/render/menu-overlay.ts`, `Renderer.overlay`): with a camera and a light of its own (a second
frame state in the SceneRenderer: `createFrame`, `useFrame`), into the multisampled targets cleared
to transparent (the opaque parts, then the blended ones), resolved, and laid over the image: its
coverage is the share of samples it drew depth into (or the blended parts' alpha), its colour as
rendered with the player's gamma (the world's eye adaptation and grading do not apply to it). Its
particles go after the world's in the frame's particle buffer. It runs on a clock of its own: the
world's stands still in menu mode.

Its space (`src/shell/menu-3d.ts`) is the one the [Interface] settings place things in: the
camera at the origin looking along −Y with +Z up (the mist menu's camera looks along −Y too), so
+X is the screen's left. The book lies fBookDistance (110) in front, tilted by fBookXRotation
(−25: its top away), its middle at fBookPosWidthPercentage / fBookPosHeightPercentage of the
screen (0.5, 0.445 from the top); the inventory's item at fInventory3DItemPos (−29, −500, 16;
the Wide values −22, −500, 12 on screens wider than 4:3): right of the middle, the magic menu's
at fMagic3DItemPos (29, −500, 8): left. Their lights (fBookLight*, fInventoryMenuLight* with
fInventoryLight* colours, dimmers and radii, fLockpickLight*) stand in the same space: the
inventory's 150 in front of its item (y −350 before −500), the book's second 35 in front of it
(its first, y −350, behind it: a rim light); the lock is placed 150 behind its light (y −1000),
as the item is (its distance is not among the settings). The camera's field of view
is not among the settings: a vertical 15° is fitted so the open book at fBookDistance takes
about the screen's height it takes in the game (TODO(M13): the engine's value). Values from the
STEP guide to the Skyrim INI ("Interface").

## The item menus' 3D

The inventory, container, barter, gift and magic menus show the highlighted entry in 3D beside
the list (`src/shell/item-3d.ts`): the movie calls `UpdateItem3D(true)` as the highlight changes
and `UpdateItem3D(false)` as the list hides. An item shows its world model (armor the player's
sex's, a book its inventory art, BOOK INAM), a spell its costliest effect's menu display object
(MGEF MDOB), a shout its own (SHOU MDOB). It is scaled so its bound sphere's radius is
fInventory3DBoundRadiusScale (12.5) times the place's scale (fInventory3DItemPosScale 1.87, Wide
1.5; the magic menu's 1.87 / 1.75). Dragging it (`StartMouseRotation`, `StopMouseRotation`)
turns it about its upright axis (the menu hears `ItemRotating` as it turns: the zoom button
shows); the wheel over it (`ZoomItemModel(±1)`) brings it to fInventory3DItemZoom (0, −500, 0)
at fInventory3DItemZoomScale (2.25) and back, at fInventory3DItemZoomSpeed.

## Books

Reading (`src/shell/book-menu.ts`): a book lying in the world is read by activating it (sRead),
one in the inventory by its Read (a spell tome's Learn teaches its spell instead, UISpellLearned
and "<spell> sAddItemtoSpellList", or sAlreadyKnown, and is used up; it opens no book).

- The 3D book is the book's inventory art (BOOK INAM, a static of
  `meshes\clutter\books\...\character assets`: JournalBasic, Book02, the spell tomes, Note01 ..
  Note04). Its BSBehaviorGraphExtraData names its graph: Book01Project (events Open, PageForward,
  PageBack, Close; it raises OpenStop, PageForwardStop, PageBackStop, CloseOut and
  SoundPlay.ITMBookOpen / ITMBookPageTurnForwardSD / ...), a note's Note01 (Open, Close; OpenStop,
  CloseStop). The graph plays skeletal clips on the model's nodes, as other animated objects'.
- The pages are `book.swf` (300 × 475), played off the page in a player of its own drawing into a
  2D canvas: `SetBookText(text, isNote)` lays out the book's DESC in pages (one every 30 ms; its
  `[pagebreak]` tags break them; `iPaginationIndex` is −1 when it is done, `PageInfoA` holds them);
  `TurnPage(delta)` (±2 a spread, ±1 a note's page; false past the ends) moves `iLeftPageNumber`;
  `ShowPageAtOffset(n)` shows page `iPageSetIndex + n` of the four it keeps. Each page shown is
  copied from the canvas into a texture (`copyExternalImageToTexture`) on a text rectangle of the
  book (`src/render/page-quad.ts`: the hidden "PageText" shape is such a rectangle, 15 × 20, with an
  effect shader whose texture the engine fills). The texts hide while a page turns or the book
  closes.
- Where the texts lie was measured from the models in the open pose (BookOpen's last frame): the
  right page flat at z 1.21 from the spine (x −9.7) to x 8.2; the left page (Base Page1 on the
  turned cover) sloping 12.5° down from the spine to x −25 (0.06 higher once a page has turned
  onto it); y −12.4 .. 12.0 (Book02's −11.1 .. 10.8); an open note flat at z ≈ 0.25, x −8 .. 8,
  y −11 .. 11. A note's text is wider (BookMenu.NOTE_WIDTH 400 from the visible rect's left plus
  NOTE_X_OFFSET 20), so its page is drawn wider around the stage.
- `bookmenu.swf` is the bar under it: `ShowTakeButton(show, steal)` (Take, or Steal for a book
  someone else owns; none for one that cannot be taken, BOOK DATA flag 0x2, or one read from the
  inventory). The control map's Book context: PrevPage (A, Left, the left mouse button, the
  wheel down), NextPage (D, Right, the right mouse button, the wheel up); Accept (E) takes the
  book and closes it, Cancel (Tab, Esc) closes it.
- The first time a skill book (BOOK DATA flag 0x1) is read its skill rises (sSkillIncreased); a
  book read from the world sends OnRead to its reference.

## Crafting

Workbenches (FURN with WBDT: the bench type, the skill) open `craftingmenu.swf`
(`src/shell/crafting-menu.ts`; the data: `src/world/crafting-records.ts`,
`src/gameplay/crafting.ts`, docs/formats/esm.md "Crafting"); the prompt is sCraft. The movie
has no InitExtensions: the engine goes to the subtype's frame (`ConstructibleObject`,
`Smithing`, `EnchantConstruct`, `Alchemy`), calls `_root.Menu.Initialize()` and
`_root.SetPlatform(0, false)`, sets `Menu.MenuName` (the header over the categories: the
workbench's name, or the menu's) and `Menu.MenuDescription`, clears the line under the card
(its placeholder text), sends `SetCategoriesList` (alchemy:
`SetPartitionedFilterMode(true)` first), fills `Menu.ItemList.entryList` and calls
`InvalidateListData`, sets `Menu.ButtonText` ([select, exit, aux, craft]; "" hides one) and
`bCanCraft` (its setter; then `UpdateButtonText`), and the bottom bar's skill
(`BottomBarInfo.UpdateCraftingInfo(name, level, percent)`, or `HidePlayerInfo` for benches
without one). There is no RequestItemCardInfo: on `SetSelectedItem(index)` the engine sets
`Menu.ItemInfo.itemInfo` and `UpdateIngredients(title, [{Name, RequiredCount, PlayerCount}],
showCount)`; `ShowItem3D` shows the entry's 3D (the item menus' Item3D); `ChooseItem(index)`
(E, Enter, a click) is the subtype's action; R crafts (`CraftButtonPress` for the mouse), F the
aux action; Esc and Tab close unless the card's slider or name field is open (the movie takes
Tab then). After a change: `InvalidateListData`, `UpdateItemList(false)`, `UpdateItemDisplay`
(alchemy, its categories changed: `PreRebuildList`, `SetCategoriesList`, the entries,
`PostRebuildList(true)`).

- **Constructible** (forges, smelters, tanning racks, cooking pots, HearthFire's tables): the
  recipes (COBJ) whose workbench keyword the bench has and whose conditions hold for the
  player, in the material categories; greyed without the components; choosing one removes
  them, adds the made object (NAM1 of it), plays UISmithingCreateGeneric, gives the skill its
  use (fConstructibleSkillUse*) and tells the story manager (CRFT).
- **Smithing** (the grindstone: weapons; the armor workbench: armor): the player's items with
  a tempering recipe at the bench (an enchanted variant: its template's), each improved
  instance an entry of its own named with its quality (sHealthDataPrefixWeap1.. "Fine");
  choosing one improves that instance as far as the skill reaches (docs/gameplay.md
  "Crafting"), else says why (sLackRequiredPerkToImproveMagical, sLackRequiredPerksToImprove,
  sLackRequiredToImprove, sLackRequiredSkillToImprove); UISmithingImproveWeapon /
  UISmithingImproveArmor.
- **Enchanting**: enchanted items to disenchant (sConfirmDisenchant: the item goes, its base
  enchantment is learned, sEnchantmentsLearned; known: sEnchantmentKnown), items (each
  improved instance its own), the learned enchantments (greyed when they do not go on the
  chosen item: sEnchantArmorIncompatible) and filled soul gems to choose; F renames the chosen
  item (`EditItemName`, `EndItemRename`). A weapon enchantment chosen for a weapon opens the
  card's slider (`Menu.ShowSlider(max, min, current, snap)`: its magnitude, 1 .. the largest);
  the movie calls `CalculateCharge(value)` as it moves (its callback, SetChargeValues, is
  defined nowhere: the engine sets the card, its effects at that value, `sliderShown` and
  `totalCharges`, the hits) and `SliderClose(value, accepted)`. The chosen item's card shows
  the name and effects it will get. R asks sEnchantItem and makes it (the crafting engine: a
  made enchantment and enchanted item; UIEnchantingItemCreate; the story manager's craft
  event).
- **Alchemy**: the player's ingredients, by the effects they know (partitioned filter flags);
  up to three chosen; R uses them up: with no shared effect it fails (sPotionCreationFailed,
  UIAlchemyFail), else the shared effects are learned on each (UIAlchemyLearnEffect) and the
  potion or poison made joins the player's items (UIAlchemyCreatePotion /
  UIAlchemyCreatePoison; the story manager's craft event).

Each bench's first use shows its tutorial (HBFG forges, HBSM the grindstone, HBSA the armor
workbench, HBEC enchanting, HBAL alchemy, HBCO cooking pots, HBML smelters, HBTA tanning racks).
The player uses the workbench first (its marker and enter idle, as actors use furniture:
`src/shell/player-furniture.ts`), then its menu opens; closing it gets them up
(src/shell/play-session.ts). The crafting perks are the perk system's
entry points (docs/gameplay.md "Crafting", "Perks").

## Lockpicking

A locked door or container (REFR XLOC: level 1 Novice, 25 Apprentice, 50 Adept, 75 Expert, 100
Master, 255 a key only; scripts lock and unlock it since) is prompted "Unlock" (sUnlock) with
its lock's level after its name (sLockLevelName*, UESP: "Unlock (object)", the level shown).
Activating it opens it with its key when the player carries it (sOpenWithKey, then it opens),
says sImpossibleLock for a key-only lock, sOutOfLockpicks without a lockpick (or the Skeleton
Key), and else opens the lockpicking menu (`src/shell/lockpicking-menu.ts`):

- `lockpickingmenu.swf` is the bar: `SetLockInfo(skill, next skill, progress, level name,
lockpicks)`; the rest is the menus' 3D. `meshes\interface\lockpicking\lockpickshiv01.nif` is the
  lock with its cylinder and the shiv (its Intro slides the lock in; its Rotate turns the cylinder
  and the shiv a quarter turn over 2.96 s, which the engine plays to the lock's angle);
  `lockpick01.nif` (the Skeleton Key's `lockpickskeletonkey01.nif`) the pick (Intro into the
  keyhole, PickDamage while it is strained, PickBreak). The cylinder turns about
  LockPickLockTumble, the pick about its tip (LockPick01 after its Intro), both about the lock's
  axis; the pick turns with the cylinder.
- The control map's Lockpicking context: the mouse sweeps the pick over the keyhole (0..180°,
  fPickMouseRotationSpeed), RotateLock (the movement keys) turns the lock at fLockRotationSpeed
  as far as the pick allows; let go, it turns back. Cancel (Tab, Esc) leaves.
- The sizes (src/gameplay/lockpicking.ts, UESP "Lockpicking" with the game settings): sweet spot
  60 × 2^−d × (0.82 + fLockpickSkillSweetSpotMult × skill) × the perks' Mod Lockpick Sweet Spot
  (the level's perk: 1.75 + 0.25 d); partial zones fPartialPick<level> × (fLockpickSkillPartialPickBase +
  fLockpickSkillPartialPickMult × skill) each side; in the sweet spot the lock turns all the way
  (90°: open), in a partial zone the less the farther out, beyond not at all. Held against the
  pick the strain breaks it after 2, 1, 0.75, 0.5, 0.25 s by level × (1 + skill / 200)
  (Unbreakable and the Skeleton Key: never; Make Lockpicks Unbreakable). Locksmith starts the
  pick within its starting arc (45°) about the opening (Set Lockpick Starting Arc). A lock's
  sweet spot stays where it is until the game is loaded again. Opened, Wax Key gives its key
  (Mod Lockpicking Key Reward Chance); Quick Hands keeps it unnoticed (Mod Lockpicking Crime
  Chance).
- Sounds: UILockpickingEnter, PickMovement, CylinderTurn, CylinderStop, PickTensionLPM (while
  strained), PickBreak, Unlock. The opened lock sends OnLockStateChanged.

## The skills menu

`statsmenu.swf` over the menus' 3D (`src/shell/skills-menu.ts`; the tween menu's Skills, the
Quick Stats key, and after a level up in its LEVEL_UP state: `SetStatsMode(false, perkPoints)`).

- The sky dome `meshes\interface\intperkskydome.nif`: its CameraIntro brings its CameraPosition node
  (the camera: it looks along its local X, here +Y) from z −3000 up to −16.44, CameraOutro back
  down as the menu closes; its own Idle animation moves the nebula meanwhile. While it is open the
  music type MUSSkillsMenu plays (30 s of silence that ducks the other music). The camera turns
  about the dome's middle; its field of view is fStatsCameraFOV (50, of a 4:3 frame).
- The ring (`src/gameplay/skills-ring.ts`): the dome's Point00 .. Point17 every 20° clockwise from
  +Y, each with its constellation image (cImage00 .. 17: its quad spans about ±9° about its point,
  7° .. 30° up, about 92 out). The images name the skills (Point01 the anvil: Smithing, Point09
  the key: Lockpicking); clockwise: Enchanting, Smithing, Heavy Armor, Block, Two-handed,
  One-handed, Archery, Light Armor, Sneak, Lockpicking, Pickpocket, Speech, Alchemy, Illusion,
  Conjuration, Destruction, Restoration, Alteration. The movie's names follow the same ring
  (`_global.StatsMenu.SkillStatsA`: level, name, progress, colour, legendary count, five a skill,
  then `UpdateSkillList(true)`; `SetDirection(degrees)` turns them with the camera; SKILL_ANGLE 20).
- A perk's star (`intperkstars01.nif`, its graph Interface\INTPerkStars01.hkx: Locked (lavender),
  Unlocked, Owned (golden), Selected, Own as it is taken; the engine sends reset, UnlockedWild,
  OwnedWild, SelectedWild) stands on its constellation's image: fStatsStarXIncrement (5) a grid
  column (AVIF XNAM + HNAM) along it, the tree's columns about the point; fStatsStarYIncrement +
  fStatsStarZIncrement (15 − 9 = 6) a grid row (YNAM + VNAM) up it from its foot (z −2). These fit
  the images (Smithing's twelve columns span its anvil's 35°, Lockpicking's five rows its key).
  Lines (`intperkline01.nif`: a beam along +Y to BeamEnd at 56.2, scaled to the distance; its
  graph: Locked, Unlocked) join a perk to those it leads to (CNAM), lit when both are owned.
- In a tree the camera pitches up to the tree's middle; the perks' names stand where their stars
  are (`_global.StatsMenu.PerkNamesA`: name, x, y in 0..1, then
  `StatsMenuInstance.UpdatePerkText(true)`); `HideRing` hides the skill names.
- `SetPlayerInfo(name, level, level progress, race, magicka now, max, colour, health ..., stamina
...)`, `SetDescriptionCard(perkMode, name, meter, description, requirements, skill level, skill,
legendary count)`: a skill's card on the ring, a perk's in a tree (its rank, sRequirements or
  sStatsNextRank with the skill levels its conditions ask), `SetPerkCount(points)`.
- A perk can be taken when the tree leads to it (the root, or a perk before it owned) and its
  conditions (the CTDA before its effects) hold: Accept asks sStatsPerkConfirm, then it is the
  player's (the next rank of a perk with ranks, NNAM). The card's requirement line is
  sRequirements or sStatsNextRank (which brings its own colon) with the skill levels.
- TODO(M13): the camera in a tree. The executable has settings the data does not set:
  fStatsStarCameraOffsetX/Y/Z, fStatsStarLookAtX/Y/Z, fStatsSkillsLookAtX/Y/Z,
  fStatsStarZInitialOffset, fStatsStarScale, fStatsLineScale (their defaults are in its
  encrypted code). Without them the camera only pitches up to the tree from the dome's middle,
  and a narrow tree's names (One-Handed: Armsman, Fighting Stance, Bladesman, Bone Breaker
  within a few degrees) stand over each other. Space at a skill of 100 makes it Legendary
  (sLegendaryResetConfirm, sLegendaryResetSecondConfirm): back to 15, its perks' points returned.

## The map

`map.swf` over the engine's 3D world map (`src/shell/map-menu.ts`, the 3D in
`src/shell/world-map-view.ts`, its camera in `src/world/map-camera.ts`; M, or the tween menu's
Map). The movie's root makes `WorldMap = new Map.MapMenu()`; its bottom bar (journal, local map,
the player's place, the date) and its markers are the movie's, everything under them the
engine's.

- **The 3D.** The renderer draws the map in place of the world (`Renderer.setView`) while it is
  open. The world as its distant LOD draws it, locked to one block size everywhere: terrain at
  uLockedTerrainLOD (32), objects at uLockedObjectMapLOD (16), no tree billboards. The sky,
  light and imagespaces are those of WorldMapWeather (WTHR 000A6858, its own ISWorldMapWeather
  DAWN/DAY/DUSK/NIGHT imagespaces) at the game's time. Nothing in the data names that weather or
  the map's sound: the engine takes them by form id. The imagespace gets [Display]
  fGlobalMapBloomThresholdBoost, fGlobalMapBrightnessBoost and fGlobalMapContrastBoost added, and
  the map's blur (ISWorldMap, Community Shaders' ISWorldMap.hlsl, in
  `src/render/shaders/dof.wgsl`): a 7 × 7 box whose step (pixels) is the distance from
  fWorldMapFocalDepth times fWorldMapDepthBlurScale, up to fWorldMapMaximumDepthBlur, times
  fWorldMapNearDepthBlurScale nearer than the focus (the clouds near the camera); the sky too
  unless bWorldMapNoSkyDepthBlur. The clouds are the map world's WRLD MODL
  (Solstheim: `DLC02\Sky\DLC2WorldMapCloudBank_Low.nif`). Tamriel has none and gets
  `meshes\sky\skyrimworldmapcloudbank.nif`, which no record names.
- **Which map.** A world shows its map world's map: its parent's when it uses the parent's map
  data (WRLD PNAM 0x4, as Whiterun's world uses Tamriel's), else its own (WRLD MNAM). Its places
  are moved onto that map by WRLD ONAM: position × scale + offset. Blackreach is scaled 2.5 under
  Tamriel. Small worlds (the East Empire Warehouse) have scale 0 or 0.0001 and sit at one point.
  A negative scale (Sovngarde, Apocrypha) puts the world on no map. The player inside (a house, a
  dungeon) shows at the outer side of the door that leads in (`src/world/exterior-doors.ts`: the
  load doors' way out, fewest doors first). Without a place on any map the map opens on
  [MapMenu] sMapWorldDefaultWorldSpace (Tamriel), at its middle.
- **The camera** (WRLD MNAM: the map's cells NW (−30, 15) .. SE (40, −40) for Tamriel, heights
  50000 .. 80000, pitch 50). It opens over the player and rises from fMapWorldTransitionHeight
  above them to the highest height, fMapTransitionSpeed of the way a second. It always looks at
  a point of the map, from the height at the pitch.
  - The mouse wheel zooms (fMapZoomMouseSpeed: a tenth of the height range a notch, times it);
    the height eases to where it was sent at fMapWorldHeightAdjustmentForce.
  - The movement keys, and the cursor beyond fMapWorldCursorMoveArea of the screen toward an
    edge, pan at fMapWorldMinPanSpeed (zoomed in) .. fMapWorldMaxPanSpeed (out).
  - Look mode (MapLookMode: the right mouse button held) turns it by fMapLookMouseSpeed, within
    fMapWorldYawRange about north and fMapWorldMinPitch .. fMapWorldMaxPitch.
  - PlayerPosition (E, the bottom bar's button) glides back to the player in
    fMapWorldTargetTransitionTime.
  - The field of view is the world's (fDefaultWorldFOV), the near plane fMapMenuNearClipPlane.
  - The pan and turn rates per unit of the settings are fitted: TODO(M13) the engine's.
- **Markers.** Created once: `WorldMap.PlayerLocationMarkerType` (66, the YouAreHereMarker) and
  `MarkerData` (name, icon, undiscovered: three per marker), `SetNumMarkers(n)`, then
  `CreateMarkers` while `GetCreatingMarkers`. Every frame `MarkerData` is set again (shown, x, y
  as shares of the screen, rotation: four per marker) and `RefreshMarkers` places them. The
  icons are `Map.MapMarker.IconTypes`:
  - 0 .. 59: a map marker's type (REFR TNAM: EmptyMarker, CityMarker, TownMarker, ...,
    DLC02CastleKarstaagMarker).
  - 61 DoorMarker, 62 QuestTargetMarker, 63 QuestTargetDoorMarker,
    64 MultipleQuestTargetMarker, 65 PlayerSetMarker, 66 YouAreHereMarker.

  The map shows:
  - The map markers seen (the compass shows them on the map as they come near) or shown by the
    plugin (XMRK FNAM 0x1); undiscovered ones get their Undiscovered icon.
  - The targets of the active quests' shown objectives, those inside at the door that leads in.
    Several quests at one place share one marker, which lists them.
  - The player's own marker (sPlayerSetMarkerName).
  - The player, an arrow turned with their heading.

- **Choosing.** The marker nearest the cursor within fMaxMarkerSelectionDist (squared, in shares
  of the screen's height) is the engine's choice: `MarkerDescriptionObj.SetDescription(title,
lines)` (lines: `{Item, Value}`), then `SetSelectedMarker(index)`. A click on the map
  (`ClickCallback`) on it calls `ClickSelectedMarker`, and the movie answers `MarkerClick(index)`:
  - A discovered place asks sFastTravelConfirm and fast travels.
  - An undiscovered one asks sPlaceMarkerUndiscovered and puts the player's marker on it.
  - The player's own asks sMoveMarkerQuestion (sMoveMarker: the next click places it;
    sRemoveMarker; sLeaveMarker).

  PlacePlayerMarker (P) puts the player's marker on the landscape under the cursor (the ray
  stepped onto the land's heights). Journal (J, its button) opens the journal, and Tab and Esc
  close the map. While the map is open, its acoustic space UIWorldMap (ASPC 000C276B: the wind
  loop AMBrWindBedWorldMapLP) plays, fading over fMapLoopFadeTimeSeconds.

- **Fast travel** (`src/gameplay/fast-travel.ts`).
  - It is refused when:
    - scripts block it (sNoFastTravelScriptBlock);
    - the world (WRLD DATA 0x2) or the interior (CELL DATA 0x4) forbids it (sNoFastTravelCell);
    - the player is in the air (sNoFastTravelInAir);
    - the player carries more than their carry weight (sNoFastTravelOverencumbered).
  - The time passes that walking the way would take: the distance on the map, at the NPCDefault
    movement type's forward walk speed times fFastTravelSpeedMult (1 unless a plugin sets it),
    at the timescale. The game's rounding is unknown (UESP).
  - The player arrives at the map marker's reference, behind the loading menu and a loading
    screen, as through a load door. Game.FastTravel goes the same way.

## The local map

L, or the bottom bar's Local Map, in the map (`src/shell/local-map.ts`).

- **The movie's side.** `WorldMap.LocalMapMenu` (a `Map.LocalMap`, `LocalMapFader.MapClip`) is
  shown: `SetTitle(name, cleared)` (the player's location, CELL XLCN, and sCleared when it is
  cleared), `Show(true)` (the fader's fade in), `InitMap()`. InitMap loads the engine's picture
  into `LocalMapHolder_mc` (`img://Local_Map`, sized 800 × 450) and calls
  `SetLocalMapExtents(x0, y0, x1, y1)` with the picture's corners on the stage. Its icons are a
  `Map.MapMenu` of its own (`LocalMapMenu.IconDisplay`) over the picture's 800 × 450, made and
  placed as the world map's are (x, y as shares of the picture).
- **The picture.** In the game it is a render target Scaleform draws. Here the movie gets an
  empty picture (`InterfaceFiles.emptyImage`, served for `img://` by the page's fetch). The
  engine draws the local map under the movie, in the picture's place on the canvas, as the menus'
  3D (`Renderer.overlay`, `src/render/menu-overlay.ts`), its landscape too.
  - The movie draws the picture over its frame: an ornate grey border around a black field, at
    80%. The movie is changed as it loads (`src/ui/movie-patches.ts`): the black fill of that
    frame becomes transparent, so the border stays the movie's. The engine draws the black field
    (80%, faded with the frame: `LocalMapMenu._alpha`) and the picture on it.
  - The picture is the drawn image as the game's ISLocalMap makes it (Community Shaders'
    ISLocalMap.hlsl). It is grey by luminance (× 1.04) and opaque by its edges: a Sobel filter
    over the 8 neighbours, the channels weighted 0.5, 0.25, 1, squared, × 4, summed × 1.75, plus
    the luminance. It fades toward the picture's sides (1 − (2|uv − ½|)⁵ on each axis) and is
    hidden where the player has not been.
- **What is drawn** (the viewer on screen: `WorldViewer.localMapContent`,
  `ModelViewer.localMapContent`). Outside: the loaded cells' landscape and objects, seen from
  fMapLocalHeight above the player. Inside: the cell, seen from just over the player's head
  (`INTERIOR_CUT`: the ceilings over them go; fitted). It is lit from above, without fog.
- **The camera** (`src/world/local-map-camera.ts`) is orthographic, north up outside. Inside, the
  cell's NorthMarker (STAT 0x3) heading is up: the Creation Kit turns an interior's local map so.
  - The picture spans fMapLocalMinFrustumWidth .. the loaded area (inside: the cell's extent).
    The wheel zooms by fMapLocalMouseZoomSpeed a notch.
  - Dragging with the left button (LocalMapMoveMode) moves the map with the cursor. The cursor
    beyond fMapWorldCursorMoveArea of the picture toward a side moves it at
    fMapLocalCursorPanSpeed.
- **Icons** (fMapLocalMarkerSelectionDist from the cursor, in shares of the picture, chooses):
  - the load doors (DoorMarker, their destination's name);
  - the map markers in the area;
  - the targets of the active quests there;
  - the player's own marker;
  - the player, its arrow turned by their heading less the map's.
- **Fog of war** (`src/world/seen-data.ts`). Inside, what the player has come within SEEN_RADIUS
  of (fitted: the game's is not documented) is seen. It is kept per cell as the engine family's
  SEEN_DATA: a 32 × 32 bit grid for each 4096-unit block. The save's CELL change form holds it
  (CHANGE_CELL_SEENDATA); its layout is not documented, TODO(M12). The rest stays dark (the
  game's LOCALMAP_FOGOFWAR pass, which ISLocalMap reads as its alpha). Outside there is none.

## The game's cursor

While a menu that uses the cursor is open, `cursormenu.swf` plays over every menu (depth 100,
taking no input) and the system's cursor is hidden over the menus (`.game-cursor`). Its root
clip `mc_Cursor` would follow `Mouse.onMouseMove`; a movie that takes no input gets no mouse,
so the host moves the clip itself, to the mouse in the movie's stage coordinates
(`src/ui/menu-host.ts`). Interactive menus use it unless their options say not
(`MenuOptions.cursor`): the lockpicking and skills menus are steered by the mouse without one
(CommonLib's kUsesCursor is off for them).

## Fades

Game.FadeOutGame(abFadingOut, abBlackFade, afSecsBeforeFade, afFadeDuration) plays
`fadermenu.swf` (`src/shell/fader-menu.ts`, over the HUD and the menus, under the loading
menu). Its `InitExtensions` registers the movie's `InitFade` and `UpdateFade`. The engine calls
`InitFade(fading in, black, duration, seconds before)` (fading in: the rect starts opaque; white when the second is false), then `UpdateFade(seconds)` every frame
with the real time that passed. The movie fades its rect (black, or white with
`Color.setRGB(0xFFFFFF)`) once the seconds before have passed, and calls `FadeDone` at the end.
Faded out it stays until a fade in, which closes it.

## Credits

The main menu's CREDITS fades the menu out (`FadeOutAndCall`) and calls `OpenCreditsMenu`; the
credits (`creditsmenu.swf`, `src/shell/credits-menu.ts`) open over it, and as they close the
main menu fades in again (`FadeInMenu`).

- **The code object.** The movie asks the engine through a code object: `_root.CodeObj`, whose
  methods are the engine's (`requestCredits(field, second field)`, `getScrollSpeed()`,
  `closeMenu()`). The engine fills it, then calls `_root.onCodeObjectInit`. The bridge gives an
  object such methods (`Menu.native(path, names)`: each calls the engine by its name, as an
  ExternalInterface call, answered as the menu's handlers are).
- **The text** is the file [Interface] sCreditsFile names (`Interface\Credits.txt`), HTML, set
  as the first field's `htmlText`. The second field is for text the first has no room for; here
  the first holds it all.
  - The text places logos (`<img src='SkyrimLogo'>`: symbols of the movie's library). Ruffle
    lays out text with images wrongly (ruffle-rs/ruffle#16618), as with the books' illuminated
    letters. They are left out: TODO(M13).
- **Scrolling.** The movie moves the text up by `getScrollSpeed()` pixels a frame (not among the
  settings: 1, TODO(M13)). It closes at the end, on a click, Tab or Esc.

## Title cards

The opening's title cards (`titles.swf`, `src/shell/title-sequence.ts`) hold four sequences:
the clips `sequence1` .. `sequence4`, each a card fading in and out, stopped on an empty first
frame. MQ101's fragment calls Game.ShowTitleSequenceMenu on the cart, and its quest script plays
them one after another (`StartTitleSequence("Sequence1")` .. `"Sequence4"`, 5, 12, 5 and 10
seconds apart) before HideTitleSequenceMenu.

## Tutorials

The first time the player does something the game explains, `tutorialmenu.swf`
(`src/shell/tutorial-menu.ts`) shows its help message until they close it (Exit: Esc, Tab or
its button; `CloseMenu`).

- **The messages** are default objects (DOBJ). HBLK: lockpicking. HBMM: the world map. HBJL: the
  journal. HBSK: the skills. HBLU: levelling up. HBBR: bartering. HBFS: favorites. HBFG: the forge.
  HBCO: cooking. HBML: the smelter. HBTA: the tanning rack. HBEC: enchanting. HBSM: the
  grindstone. HBSA: the armor bench. HBAL: alchemy. HBLH, HBLM, HBLS: health, magicka or stamina
  low. HBHJ: jail. HBFT: follower commands. HBWC: weapon charge. Dragonborn adds dragon riding's.
  CommonLib's `TutorialMenu::OpenTutorialMenu` takes such a default object.
- **The box.** The message's name is the box's title (`Menu_mc.HelpTitle`), its text the help
  (`Menu_mc.HelpScrollingText`, a CLIK text: set through its `__set__text`, which keeps it as
  the text the component writes into its `textField` as it draws; the field set alone came out
  empty when the component drew after it, as beside the barter menu loading). `ApplyButtonArt`
  turns its "[Event]"s into key art.
- Each shows once in a game, only with [Interface] bShowTutorials (TODO(M12): which were shown,
  in the save). The menus open theirs as they open: the map, the journal, the skills, the
  level-up, bartering, favorites and lockpicking. The others come with what they explain:
  crafting (M9's crafting menu), low bars, jail and followers (M10, M11).

## Character creation

The race menu (`src/shell/race-menu.ts`): `interface\racesex_menu.swf` (1280×720; the name box
is `TextEntry.swf`'s TextEntryClip, linked in like any import). Game.ShowRaceMenu opens it (a
new game's MQ101 at stage 75, TriggerRaceMenuScript, the console's `showracemenu`, which slides
the console away first), Game.ShowLimitedRaceMenu its limited form (the race cannot change and
there is no name: Dawnguard's surgery). Neither is latent: the scripts go on once the menu has
closed, as the game stands still in menu mode while it is open. CommonLib's RaceSexMenu: menu
mode, the cursor, the ItemMenu control context.

- **Opening.** `_root.InitExtensions()`, `_root.SetPlatform(0, false)`, for the limited menu
  `RaceSexPanelsInstance.bLimitedMenu = true` (the race list then carries the Body category's
  flag and the menu opens on Body), `ShowTextEntry(true)` (the PC's name box, not a console's
  keyboard), `SetCategoriesList(text, flag, ...)` (sRSMRace .. sRSMHair; the movie's constants
  are RACE 0, BODY 1, HEAD 2), `SetOptionSliders(...)` (8 per slider: text, filter flag,
  callback, min, max, position, interval, id; a slider shows under a category whose flag it
  shares), `SetRaceList(name, description, equipState, ...)` (the playable races, the player's
  with equip state 1; after the categories) and `SetNameText(name)`.
- **The sliders** (`src/gameplay/chargen.ts`): the movie calls each slider's callback with
  (value, id): ChangeSex (the engine's own name: the movie names none), ChangeHeadPreset,
  ChangeTintingMask, ChangeWeight (0..1), ChangeFaceDetails, ChangeHeadPart,
  ChangeHairColorPreset, ChangePreset (a nose, eye or mouth type), ChangeDoubleMorph (−1..1). The
  ids follow the movie's developer harness (`FaceChanges`). A change is the player's appearance
  at once (`GameState.playerAppearance`) and their body is made again
  (`src/shell/player-look.ts`, docs/animation.md "The player"): a tint only paints the face
  tint again, the other sex starts from the race's default look for it, and the sliders are
  sent again where ranges or positions moved (presets, war paint and dirt masks).
- **The categories** (the bar at the top, `CagetoryLockBaseInstance.CategoryInstance.List_mc`)
  change on PC by the mouse only: the movie's `LeftClickInstance` and `RightClickInstance`
  (invisible CLIK buttons over the bar's left and right halves, alpha 0) call
  `moveCategoriesDown` / `moveCategoriesUp`; the gamepad's triggers (L2/R2 navigation codes,
  not on platform 0) do too, and no keyboard event is bound to them. The bar is locked to the
  top of the visible area (`Lock("T")`) and the click areas are not: with a screen taller than
  16:9 they sit under the bar, as in the game. In the lists W and S move, A and D move a slider.
- **ChangeRace(index)** comes 600 ms after the race list stops moving, the movie's loading icon
  showing: the race's default look (default head parts, complexion, hair colour, a neutral
  shape, the tint layers' default colours; the sex and weight kept; TODO(M13): whether vanilla
  starts from the race's first preset), `SetRaceText(name)`, the sliders again, and
  `HideLoadingIcon()` once the new body stands there. A race the scripts gave the player
  (Actor.SetRace) is given up for it.
- **The camera** (`src/shell/race-menu-camera.ts`) stands in front of the player looking at
  fRSMCameraLookAtPercent (0.955) of their height: fPlayerFaceEditDistance (100) away on the
  face, farther on the body (fitted: TODO(M13)), moving over fPlayerZoomTime (1000 ms) as the
  movie calls `ZoomPC(true)` (Race, Head and the face's categories) or `ZoomPC(false)` (Body).
  Two lights (fUIRaceSexLight*, fUIRaceSexLight2*: colour × dimmer, radius 1400) light the
  player, placed from the point looked at as the other menus' lights are from what they show
  (TODO(M13): against the game). The player holds sPosePlayerRaceSexMenu
  (OffsetBoundStandingPlayerInstant, a behavior event) and animates on real time while the world
  stands still; the mouse with its right button held turns them (the game has the gamepad's
  Rotate only: TODO(M13)). The HUD is hidden.
- **Done** (its button, or R: the ItemMenu context's XButton) asks sRSMConfirm "Finish and name
  your character?"; Yes brings the name box (`ShowTextEntryField()`: the movie focuses its
  field, `TextInputInstance.focused = true`, which needs Scaleform's `Selection.numFocusGroups`
  and `getFocusBitmask` ("Focus and keys"), and asks SetAllowTextInput; the field takes the typed keys, Enter accepts and Esc or Tab
  cancels through the movie's handleInput). The movie sends `ChangeName(name)` as the box
  accepts and again as it fades (every category change fades it too, with the name or none):
  only a name while the engine waits for one counts. sRSMNameWarning "Start game as %s?": Yes
  sets the player's name (the Player base's name for the scripts' texts and the menus) and
  closes, No brings the box back; a cancelled box goes back to the menu. The limited menu asks
  sRSMFinishedWarning "Finished?". Closing: `FadeOut()` (the root's frames 2..9, until
  `_root._currentframe` is 9), then the menu closes and the player's camera, controls and HUD
  come back.
- The race it finishes with brings its abilities (RACE SPLO: the magic system's lasting effects
  follow the new race). After the opening's race menu (one finished before:
  `GameState.raceChosen`) a new race also resets the skills to the race's (UESP "Console":
  showracemenu; the skill increases' bases and experience go, the level and perks stay); the
  limited menu keeps the race. TODO(M12): the appearance and the name in the save.

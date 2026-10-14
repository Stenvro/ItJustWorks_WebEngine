# SWF and GFX: the interface movies

The game's interface is Scaleform GFx: Flash movies (ActionScript 2) in `Skyrim -
Interface.bsa`. Parser: `src/formats/swf/swf.ts`; `node tools/swf-info.ts` lists every movie
(`node tools/swf-info.ts hudmenu.swf` for one in detail). Reference: Adobe's _SWF File
Format Specification_ (version 19) and Scaleform's extension tags (as Ruffle and JPEXS list
them).

## What there is

- **Menus**, `interface\*.swf`, one movie per menu: hudmenu, startmenu, dialoguemenu,
  inventorymenu, containermenu, bartermenu, giftmenu, magicmenu, craftingmenu, favoritesmenu,
  map, quest_journal, statsmenu, levelupmenu, trainingmenu, sleepwaitmenu, lockpickingmenu,
  bookmenu (with book.swf), messagebox, tweenmenu, loadingmenu, fadermenu, cursormenu,
  console, racesex_menu, textentry, tutorialmenu, creditsmenu, titles, kinectmenu,
  creationclubmenu, modmanager, logindialog, bethesdanetlogin, streaminginstall, widgetoverlay,
  loadwaitspinner, safezone. Shared parts: `interface\inventory components\*.swf` (ItemCard,
  InventoryLists, InvertedInventoryLists, BottomBar), imported by the item menus by path, and
  sharedcomponents.swf.
- **Exported movies**, `interface\exported\*.gfx` (hudmenu, quest_journal, racesex_menu,
  textentry, tutorialmenu, safezone): Scaleform's own form of the same menus (`CFX`).
- **Fonts**: `fontconfig.txt` (below), `fonts_en.swf` and its other languages, `fonts_console.swf`,
  `fonts_buttons.swf`, `fonts_cclub.swf`, and `gfxfontlib.swf`.
- **Text**: `translate_english.txt` (UTF-16: `$KEY<tab>text`), the `$` strings the menus show.
- Almost all are SWF 15 (CWS), 1280×720, 24 or 30 fps.

## Header and tags

`FWS` (uncompressed), `CWS` (zlib after the first 8 bytes), `ZWS` (LZMA, not used by the game);
Scaleform's `GFX` / `CFX` are the same with its extension tags. Byte 3 is the version, bytes
4–7 the uncompressed length. Then a RECT (a 5-bit field size, four signed fields: the stage
in twips, 1/20 pixel), the frame rate (8.8 fixed) and the frame count, then tags: a u16 of
`code << 6 | length`, a length of 0x3f meaning a u32 length follows. DefineSprite (39) holds
its own tags after its id and frame count. Strings are null-terminated UTF-8 (SWF 6+).

`fonts_pl.swf` gives a length 8 bytes shorter than its body inflates to; the parser refuses
it (it is not needed for English).

Scaleform's tags (1000–1009): ExporterInfo, DefineExternalImage (an image in a separate file,
e.g. a DDS), FontTextureInfo, DefineExternalGradient, DefineGradientMap, DefineCompactedFont,
DefineExternalSound, DefineExternalStreamSound, DefineSubImage, DefineExternalImage2.

## Fonts

The menus do not carry their fonts: each imports them from `gfxfontlib.swf` by name
(ImportAssets2): `$EverywhereMediumFont`, `$EverywhereFont`, `$EverywhereBoldFont`,
`$DragonFont`, ... The shipped `gfxfontlib.swf` exports only 12 of those names; Scaleform
resolves the rest through `fontconfig.txt`, which loads font libraries (`fontlib
"Interface\fonts_en.swf"`) and maps each name to a font in them (`map "$EverywhereMediumFont"
= "Futura Condensed" Normal`). `fonts_en.swf` holds the fonts themselves (DefineFont3 with
their glyphs: Futura Condensed, Futura CondensedLight, the book and rune fonts, the controller
buttons).

## Linking imports

Scaleform loads the movies a menu imports symbols from (ImportAssets2) before the menu plays;
a Flash player loads them afterwards, and Ruffle neither places an imported clip in the frame
that ran before it arrived nor lets it be attached later. The item menus build themselves from
imported parts (`Inventory components/InventoryLists.swf`, `ItemCard.swf`, `BottomBar.swf`), so
the engine links them in (`src/formats/swf/swf-link.ts`): each import of such a movie is
replaced, where it stands, by that movie's definitions (shapes, bitmaps, sprites, edit texts,
fonts, their own imports of the font library, their class code, their exports; not its own
timeline). Their character ids move past the importing movie's own, and the symbol imported
takes the id the import gave it. What names a character by id is renumbered: definitions,
placements in sprites (PlaceObject2/3, the character after a class name), edit texts' fonts,
bitmap fills in shapes (DefineShape 1–4's fill style arrays, in the shape's header and in its
records' new styles; LINESTYLE2 fills), CSM text settings, scaling grids, init actions, exports
and imports. Text records, buttons and morph shapes, which no linked movie has, are refused.
The font library (`gfxfontlib.swf`) stays an import. The integration test checks that every
menu with parts links and that every character placed in it is defined.

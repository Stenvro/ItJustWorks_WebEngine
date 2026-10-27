# Control map

`interface\controls\pc\controlmap.txt` (Skyrim - Interface.bsa) binds the game's user events to
keys, mouse buttons and gamepad buttons (`src/formats/controlmap/controlmap.ts`; listing:
`node tools/controlmap-info.ts [--all]`).

- Lines starting with `//` are comments. A blank line (only tabs) ends an **input context**; in
  file order: main gameplay, menu mode, console, item menus, inventory, debug text, favorites,
  map, stats, cursor, book, debug overlay, journal, TFC mode, debug map, lockpicking, creations,
  favor.
- Columns are tab-separated (event names contain spaces): user event name, keyboard,
  mouse, gamepad, then three remappable flags (keyboard, mouse, gamepad: 1/0) and the user
  event flags (hex; groups events switched on and off together, e.g. `0x801` movement).
- A binding column lists alternatives separated by commas (`0x02,0x4f`); `a+b` is a
  combination held together (`0x1d+0xb7`); `0xff` is unmapped; `!0,Name` takes the bindings
  of another event (menus reuse Activate, Forward, ...).
- Keys are **DirectInput scan codes** (DIK): 0x11 W, 0x1f S, 0x1e A, 0x20 D, 0x12 E (Activate),
  0x21 F (Toggle POV), 0x39 Space (Jump), 0x38 Left Alt (Sprint), 0x2a Left Shift (Run, i.e.
  walk while always running), 0x3a Caps Lock (Toggle Always Run), 0x1d Left Ctrl (Sneak), 0x2e
  C (Auto-Move). Browsers report physical keys by `KeyboardEvent.code`, mapped from the scan
  codes. Mouse ids: 0 left, 1 right, 2 middle, 8 wheel up, 9 wheel down, 0xa movement.

## The gamepad

The gamepad column holds XInput button bits: `0x1` d-pad up, `0x2` down, `0x4` left, `0x8` right,
`0x10` Start, `0x20` Back, `0x40` left thumb, `0x80` right thumb, `0x100` left shoulder, `0x200`
right shoulder, `0x1000` A, `0x2000` B, `0x4000` X, `0x8000` Y; and four analog ids: `0x9` left
trigger, `0xa` right trigger, `0xb` left stick, `0xc` right stick. The browser's Gamepad API
(standard mapping) reports the same Xbox controller by button index 0–15
(`src/formats/controlmap/gamepad.ts` `STANDARD_BUTTONS`).

A menu gets a gamepad button as a key through CLIK's `InputDelegate.handleKeyPress`: the
Accept, Cancel and direction events of the menu's contexts as Enter (13), Tab (9) and the arrows,
any other button as GFx's gamepad key code, which the movies' `InputDelegate.inputToNav` reads
as `NavigationCode.GAMEPAD_*`: 96 A, 97 B, 98 X, 99 Y, 100 L1, 101 L2, 102 L3, 103 R1, 104 R2,
105 R3, 106 Start, 107 Back (read from the movies' AS2; the `NavigationCode` values are the
strings `gamepad_A` ... `gamepad_R3`, `start` and `back`). While the gamepad is the device last
used the menus are told `SetPlatform(1)` (PLATFORM_PC_GAMEPAD).

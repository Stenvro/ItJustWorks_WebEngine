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

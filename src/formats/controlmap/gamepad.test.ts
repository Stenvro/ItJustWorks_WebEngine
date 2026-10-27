import { describe, expect, it } from 'vitest';
import { InputContext, parseControlMap } from './controlmap.ts';
import {
  deadzoned,
  inputContexts,
  menuPadKey,
  padEvents,
  PadInput,
  readPad,
  stickDirection,
} from './gamepad.ts';
import { applyRemaps, remapEvent } from './remap.ts';

// The shape of the game's controlmap.txt: gameplay, Menu Mode, Console, Item Menus, then the
// favorites as the seventh context (empty contexts kept by a placeholder line each).
const MAP = parseControlMap(
  [
    '// Main Gameplay',
    'Activate\t0x12\t0xff\t0x1000\t1\t0\t1\t0x804',
    'Jump\t0x39\t0xff\t0x8000\t1\t0\t1\t0xc01',
    'Tween Menu\t0x0f\t0xff\t0x2000\t1\t0\t1\t0x908',
    'Left Attack/Block\t0xff\t0x1\t0x9\t0\t1\t1\t0x841',
    'Favorites\t0x10\t0xff\t0x1,0x2\t1\t0\t0\t0x908',
    '',
    '// Menu Mode',
    'Accept\t!0,Activate\t0xff\t0x1000\t0\t0\t0\t0x8',
    'Cancel\t!0,Tween Menu\t0xff\t0x2000\t0\t0\t0\t0x8',
    'Up\t!0,Forward\t0xff\t0x1\t0\t0\t0\t0x8',
    'Down\t!0,Back\t0xff\t0x2\t0\t0\t0\t0x8',
    '',
    '// Console',
    'NextFocus\t0x0f\t0xff\t0x200\t0\t0\t0\t0x10',
    '',
    '// Item Menus',
    'XButton\t!0,Ready Weapon\t0xff\t0x4000\t0\t0\t0\t0x8',
    '',
    'Placeholder\t0xff\t0xff\t0xff\t0\t0\t0\t0x8',
    '',
    'Placeholder\t0xff\t0xff\t0xff\t0\t0\t0\t0x8',
    '',
    '// Favorites',
    'Cancel\t!0,Favorites\t0xff\t0x2000\t0\t0\t0\t0x8',
  ].join('\r\n'),
);

const pad = (pressed: number[], axes: number[] = [0, 0, 0, 0]) => ({
  buttons: Array.from({ length: 17 }, (_, index) => ({
    pressed: pressed.includes(index),
    value: pressed.includes(index) ? 1 : 0,
  })),
  axes,
});

describe('gamepad', () => {
  it('reads the gamepad column as XInput bits', () => {
    expect(padEvents(MAP, InputContext.gameplay, PadInput.a)).toEqual(['Activate']);
    expect(padEvents(MAP, InputContext.gameplay, PadInput.dpadDown)).toEqual(['Favorites']);
    expect(padEvents(MAP, InputContext.gameplay, PadInput.leftTrigger)).toEqual([
      'Left Attack/Block',
    ]);
    expect(padEvents(MAP, InputContext.menuMode, PadInput.b)).toEqual(['Cancel']);
  });

  it('maps the standard Gamepad API buttons and sticks', () => {
    const state = readPad(pad([0, 6, 12], [0, -1, 0.05, 0]));
    expect([...state.held].sort((a, b) => a - b)).toEqual([
      PadInput.dpadUp,
      PadInput.leftTrigger,
      PadInput.a,
    ]);
    // Up on the browser's axis is negative; the game's forward is positive.
    expect(state.leftStick[1]).toBeCloseTo(1);
    // Inside the dead zone the right stick is still.
    expect(state.rightStick).toEqual([0, 0]);
    expect(deadzoned(0.1, 0.1, 0.24)).toEqual([0, 0]);
    expect(stickDirection([0.9, 0.1])).toBe(PadInput.dpadRight);
  });

  it('puts the open menu’s context over Menu Mode', () => {
    expect(inputContexts([])).toEqual([InputContext.gameplay]);
    expect(inputContexts(['HUD Menu'])).toEqual([InputContext.gameplay]);
    expect(inputContexts(['HUD Menu', 'FavoritesMenu'])).toEqual([
      InputContext.favorites,
      InputContext.menuMode,
    ]);
    expect(inputContexts(['HUD Menu', 'Lockpicking Menu', 'Fader Menu'])).toEqual([
      InputContext.lockpicking,
      InputContext.menuMode,
    ]);
    expect(inputContexts(['TweenMenu'])).toEqual([InputContext.menuMode]);
    expect(inputContexts(['Console'])).toEqual([InputContext.console]);
  });

  it('gives a menu the Menu Mode keys, else the GFx gamepad codes', () => {
    expect(menuPadKey(MAP, PadInput.a)).toBe(13);
    expect(menuPadKey(MAP, PadInput.b)).toBe(9);
    expect(menuPadKey(MAP, PadInput.dpadDown)).toBe(40);
    // X in the inventory: NavigationCode.GAMEPAD_X (98).
    expect(menuPadKey(MAP, PadInput.x, inputContexts(['InventoryMenu']))).toBe(98);
    expect(menuPadKey(MAP, PadInput.b, inputContexts(['FavoritesMenu']))).toBe(9);
    expect(menuPadKey(MAP, PadInput.start)).toBe(106);
    expect(menuPadKey(undefined, PadInput.rightShoulder)).toBe(103);
  });

  it('remaps the gamepad column, swapping with the event that had the button', () => {
    const remaps = remapEvent(MAP, new Map(), 'Activate', { pad: PadInput.y });
    const map = remaps && applyRemaps(MAP, remaps);
    expect(map && padEvents(map, InputContext.gameplay, PadInput.y)).toEqual(['Activate']);
    expect(map && padEvents(map, InputContext.gameplay, PadInput.a)).toEqual(['Jump']);
    // Favorites may not be remapped on the gamepad.
    expect(remapEvent(MAP, new Map(), 'Favorites', { pad: PadInput.x })).toBeUndefined();
  });
});

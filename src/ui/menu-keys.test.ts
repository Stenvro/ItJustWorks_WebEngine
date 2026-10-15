import { describe, expect, it } from 'vitest';
import type { ControlMap, UserEvent } from '../formats/controlmap/controlmap.ts';
import { DEFAULT_MENU_KEYS, menuKeys } from './menu-keys.ts';

const event = (name: string, keys: number[][], aliases: string[] = []): UserEvent => ({
  name,
  keys,
  mouse: [],
  gamepad: [],
  aliases,
  remappable: [true, true, true],
  flags: 0,
});

// Scan codes: W 0x11, A 0x1e, S 0x1f, D 0x20, E 0x12, Tab 0x0f, Esc 0x01.
const CONTROLS: ControlMap = {
  contexts: [
    [
      event('Forward', [[0x11]]),
      event('Back', [[0x1f]]),
      event('Strafe Left', [[0x1e]]),
      event('Strafe Right', [[0x20]]),
      event('Activate', [[0x12]]),
      event('Tween Menu', [[0x0f]]),
      event('Pause', [[0x01]]),
    ],
    [
      event('Accept', [], ['Activate']),
      event('Cancel', [], ['Tween Menu', 'Pause']),
      event('Up', [], ['Forward']),
      event('Down', [], ['Back']),
      event('Left', [], ['Strafe Left']),
      event('Right', [], ['Strafe Right']),
    ],
  ],
};

describe('menu keys', () => {
  it('take the gameplay keys the Menu Mode events are bound as (W, A, S, D as the arrows)', () => {
    expect(menuKeys(CONTROLS)).toEqual({
      KeyE: 'Enter',
      Escape: 'Tab',
      KeyW: 'ArrowUp',
      KeyS: 'ArrowDown',
      KeyA: 'ArrowLeft',
      KeyD: 'ArrowRight',
    });
  });

  it('fall back to Esc as Tab and E as Enter without a control map', () => {
    expect(menuKeys(undefined)).toEqual(DEFAULT_MENU_KEYS);
  });
});

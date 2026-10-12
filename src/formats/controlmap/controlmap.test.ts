import { describe, expect, it } from 'vitest';
import { InputContext, parseControlMap, SCAN_CODES } from './controlmap.ts';

const SAMPLE = [
  '// 1st field: User event name.\t\t\t',
  '//\t\t\t\t\t\t\t',
  '// Main Gameplay\t\t\t\t\t\t\t',
  'Forward\t\t\t\t0x11\t\t\t\t0xff\t0xff\t\t\t\t1\t1\t0\t0x801',
  'Strafe Left\t\t\t0x1e\t\t\t\t0xff\t0xff\t\t\t\t1\t1\t0\t0x801',
  'Look\t\t\t\t0xff\t\t\t\t0xa\t\t0x000c\t\t\t\t0\t0\t0\t0x2',
  'Hotkey1\t\t\t\t0x02,0x4f\t\t\t0xff\t0x0004\t\t\t\t0\t0\t0\t0x908',
  'Multi-Screenshot\t0x1d+0xb7,0x9d+0xb7\t0xff\t0xff\t\t\t\t0\t0\t0',
  'Quicksave\t\t\t0x3f\t\t\t\t0xff\t0xff\t\t\t\t1\t0\t0\t',
  '\t\t\t\t\t\t\t',
  '// Menu Mode\t\t\t\t\t\t\t',
  'Accept\t\t!0,Activate\t\t\t\t!0,Activate\t\t\t\t0x1000\t\t\t0\t0\t0\t0x8',
  '',
  '// Console',
  'Up\t\t\t\t0xc8\t\t\t\t0xff\t0xff\t0\t0\t0\t0x10',
].join('\r\n');

describe('parseControlMap', () => {
  const map = parseControlMap(SAMPLE);

  it('splits the input contexts at blank lines', () => {
    expect(map.contexts).toHaveLength(3);
    expect(map.contexts[InputContext.gameplay]?.map((event) => event.name)).toEqual([
      'Forward',
      'Strafe Left',
      'Look',
      'Hotkey1',
      'Multi-Screenshot',
      'Quicksave',
    ]);
  });

  it('reads keys, mouse buttons, gamepad buttons, remapping and flags', () => {
    const [forward, , look, hotkey, screenshot, quicksave] = map.contexts[0] ?? [];
    expect(forward).toEqual({
      name: 'Forward',
      keys: [[0x11]],
      mouse: [],
      gamepad: [],
      aliases: [],
      remappable: [true, true, false],
      flags: 0x801,
    });
    expect(look?.mouse).toEqual([0xa]);
    expect(look?.gamepad).toEqual([0x000c]);
    expect(hotkey?.keys).toEqual([[0x02], [0x4f]]);
    expect(screenshot?.keys).toEqual([
      [0x1d, 0xb7],
      [0x9d, 0xb7],
    ]);
    expect(quicksave?.flags).toBe(0);
  });

  it('keeps the events an entry borrows its bindings from', () => {
    expect(map.contexts[InputContext.menuMode]?.[0]?.aliases).toEqual(['Activate']);
  });
});

describe('SCAN_CODES', () => {
  it('maps DirectInput scan codes to keyboard codes', () => {
    expect(SCAN_CODES.get(0x11)).toBe('KeyW');
    expect(SCAN_CODES.get(0x1e)).toBe('KeyA');
    expect(SCAN_CODES.get(0x2c)).toBe('KeyZ');
    expect(SCAN_CODES.get(0x39)).toBe('Space');
    expect(SCAN_CODES.get(0x0b)).toBe('Digit0');
    expect(SCAN_CODES.get(0x44)).toBe('F10');
  });
});

import { describe, expect, it } from 'vitest';
import type { UserEvent } from '../formats/controlmap/controlmap.ts';
import { buttonArt, keyArt, keyLabel, mouseArt, UNKNOWN_KEY, withKeyLabels } from './button-art.ts';

const event = (keys: number[][], mouse: number[] = []): UserEvent => ({
  name: 'Test',
  keys,
  mouse,
  gamepad: [],
  aliases: [],
  remappable: [true, true, true],
  flags: 0,
});

describe('button art', () => {
  it('names keys as the menus export their pictures', () => {
    expect(keyArt(0x12)).toBe('E');
    expect(keyArt(0x02)).toBe('1');
    expect(keyArt(0x0f)).toBe('Tab');
    expect(keyArt(0x2a)).toBe('L-Shift');
    expect(keyArt(0x1d)).toBe('L-Ctrl');
    expect(keyArt(0x38)).toBe('L-Alt');
    expect(keyArt(0x29)).toBe('Tilde');
    expect(keyArt(0x01)).toBe('Esc');
    expect(keyArt(0x3b)).toBe('F1');
    expect(keyArt(0xc8)).toBe('Up');
    expect(keyArt(0x4f)).toBe('NumPad1');
    expect(keyArt(0xfe)).toBe(UNKNOWN_KEY);
  });

  it('names mouse buttons, the wheel and movement', () => {
    expect(mouseArt(0)).toBe('Mouse1');
    expect(mouseArt(1)).toBe('Mouse2');
    expect(mouseArt(8)).toBe('Wheel');
    expect(mouseArt(0xa)).toBe('MouseMove');
  });

  it('shows an event by its first key, else its mouse button', () => {
    expect(buttonArt(event([[0x12]]))).toBe('E');
    expect(buttonArt(event([[0x1d, 0xb7]]))).toBe(UNKNOWN_KEY);
    expect(buttonArt(event([], [0]))).toBe('Mouse1');
    expect(buttonArt(undefined)).toBe(UNKNOWN_KEY);
  });
});

describe('key labels', () => {
  it('reads an art as the key it shows', () => {
    expect(keyLabel('E')).toBe('E');
    expect(keyLabel('L-Shift')).toBe('Shift');
    expect(keyLabel('Mouse1')).toBe('Left Click');
    expect(keyLabel('NumPad5')).toBe('Num 5');
  });

  it("writes a text's [Event]s as their keys, other brackets as they are", () => {
    // Activate on E (scan code 0x12), Jump on Space (0x39).
    const controls = {
      contexts: [
        [
          { ...event([[0x12]]), name: 'Activate' },
          { ...event([[0x39]]), name: 'Jump' },
        ],
      ],
    };
    expect(withKeyLabels('Press [Activate] to take, [jump] to jump [here].', controls)).toBe(
      'Press E to take, Space to jump [here].',
    );
  });
});

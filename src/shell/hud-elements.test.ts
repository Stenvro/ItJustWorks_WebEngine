import { describe, expect, it } from 'vitest';
import { floatingMarker, HudModes, METER_KEEP_MS, MeterFade } from './hud-elements.ts';

describe('HUD modes', () => {
  it('keeps the movie’s mode stack: the last one on shows', () => {
    const modes = new HudModes();
    expect(modes.top).toBe('All');
    modes.set('InventoryMode', true);
    modes.set('BookMode', true);
    expect(modes.top).toBe('BookMode');
    modes.set('InventoryMode', false);
    expect(modes.top).toBe('BookMode');
    modes.set('BookMode', false);
    expect(modes.top).toBe('All');
  });

  it('shows notices in the book and item modes, holds them on the map and in the journal', () => {
    const modes = new HudModes();
    for (const mode of ['BookMode', 'InventoryMode', 'TweenMode', 'DialogueMode']) {
      modes.set(mode, true);
      expect(modes.showsNotices).toBe(true);
      modes.set(mode, false);
    }
    for (const mode of ['WorldMapMode', 'JournalMode', 'CartMode']) {
      modes.set(mode, true);
      expect(modes.showsNotices).toBe(false);
      modes.set(mode, false);
    }
  });
});

describe('meter fade', () => {
  it('sends a change, keeps a meter that is not full, lets a full one fade', () => {
    const meter = new MeterFade();
    expect(meter.step(100, 0)).toEqual({ set: true, keep: false, filled: false });
    expect(meter.step(100, 5000)).toEqual({ set: false, keep: false, filled: false });
    expect(meter.step(60, 5100)).toEqual({ set: true, keep: false, filled: false });
    // Standing still while low: shown again once a keep interval has passed.
    expect(meter.step(60, 5100 + METER_KEEP_MS - 1).keep).toBe(false);
    expect(meter.step(60, 5100 + METER_KEEP_MS).keep).toBe(true);
    expect(meter.step(60, 5100 + METER_KEEP_MS + 10).keep).toBe(false);
    expect(meter.step(100, 9000)).toEqual({ set: true, keep: false, filled: true });
    expect(meter.step(100, 20000).keep).toBe(false);
  });
});

describe('floating quest marker', () => {
  const ahead = (point: readonly [number, number, number]): readonly [number, number] => [
    0.5 + point[0] / 10000,
    0.5,
  ];

  it('stands over the nearest target in reach, fading from the minimum to the maximum', () => {
    const near = floatingMarker(
      [
        [1500, 0, 0],
        [800, 0, 0],
      ],
      [0, 0, 0],
      ahead,
    );
    expect(near).toEqual({ screen: [0.58, 0.5], alpha: 100 });
    expect(floatingMarker([[1500, 0, 0]], [0, 0, 0], ahead)?.alpha).toBe(50);
    expect(floatingMarker([[2500, 0, 0]], [0, 0, 0], ahead)).toBeUndefined();
  });

  it('shows nothing for a target behind the camera or off the screen', () => {
    expect(floatingMarker([[500, 0, 0]], [0, 0, 0], () => undefined)).toBeUndefined();
    expect(floatingMarker([[500, 0, 0]], [0, 0, 0], () => [1.2, 0.5])).toBeUndefined();
  });
});

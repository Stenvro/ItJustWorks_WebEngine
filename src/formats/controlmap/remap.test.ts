import { describe, expect, it } from 'vitest';
import { parseControlMap } from './controlmap.ts';
import { applyRemaps, remapEvent } from './remap.ts';

const MAP = parseControlMap(
  [
    '// Main Gameplay',
    'Forward\t0x11\t0xff\t0xff\t1\t1\t0\t0x801',
    'Back\t0x1f\t0xff\t0xff\t1\t1\t0\t0x801',
    'Journal\t0x24\t0xff\t0xff\t1\t0\t0\t0x8',
    'Pause\t0x01\t0xff\t0xff\t0\t0\t0\t0x8',
    '',
    '// Menu Mode',
    'Cancel\t0x0f\t0xff\t0xff\t0\t0\t0\t0x8',
  ].join('\r\n'),
);

const keysOf = (map: ReturnType<typeof applyRemaps>, name: string) =>
  map.contexts[0]?.find((event) => event.name === name)?.keys;

describe('remapEvent', () => {
  it('binds an event to a free key', () => {
    const remaps = remapEvent(MAP, new Map(), 'Forward', { key: 0x48 });
    expect(remaps && keysOf(applyRemaps(MAP, remaps), 'Forward')).toEqual([[0x48]]);
  });

  it('swaps with another remappable event that had the key', () => {
    const remaps = remapEvent(MAP, new Map(), 'Forward', { key: 0x1f });
    const map = remaps && applyRemaps(MAP, remaps);
    expect(map && keysOf(map, 'Forward')).toEqual([[0x1f]]);
    expect(map && keysOf(map, 'Back')).toEqual([[0x11]]);
  });

  it('refuses keys fixed events use and events that may not be remapped so', () => {
    expect(remapEvent(MAP, new Map(), 'Forward', { key: 0x01 })).toBeUndefined();
    expect(remapEvent(MAP, new Map(), 'Forward', { key: 0x0f })).toBeDefined();
    expect(remapEvent(MAP, new Map(), 'Pause', { key: 0x48 })).toBeUndefined();
    expect(remapEvent(MAP, new Map(), 'Journal', { mouse: 2 })).toBeUndefined();
  });
});

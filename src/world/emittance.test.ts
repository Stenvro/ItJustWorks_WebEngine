import { describe, expect, it } from 'vitest';
import { emittanceColor, emittanceWeather, type EmittanceSource } from './emittance.ts';

describe('emittance', () => {
  it('gives a light its own colour at every hour', () => {
    const source: EmittanceSource = { kind: 'light', color: [1, 0.6, 0.3] };
    expect(emittanceColor(source, undefined, undefined, 3)).toEqual([1, 0.6, 0.3]);
    expect(emittanceColor(source, undefined, undefined, 15)).toEqual([1, 0.6, 0.3]);
    expect(emittanceWeather(source)).toBe(undefined);
  });

  it('follows the most likely weather of a region', () => {
    const source: EmittanceSource = {
      kind: 'region',
      weathers: [
        { weather: 0x10, chance: 20, global: undefined },
        { weather: 0x20, chance: 60, global: undefined },
        { weather: 0x30, chance: 20, global: undefined },
      ],
    };
    expect(emittanceWeather(source)).toBe(0x20);
    // Without its weather record, the region gives no light.
    expect(emittanceColor(source, undefined, undefined, 12)).toEqual([0, 0, 0]);
  });
});

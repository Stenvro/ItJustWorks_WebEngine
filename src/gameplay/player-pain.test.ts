import { describe, expect, it } from 'vitest';
import { PlayerPain, readPlayerPainSettings } from './player-pain.ts';

describe('the player’s pain', () => {
  it('rumbles fRumblePainStrength (0.75) for fRumblePainTime (0.5 s) on a painful hit', () => {
    const pain = new PlayerPain();
    expect(pain.hit(10, true)).toEqual({ strength: 0.75, seconds: 0.5 });
  });

  it('gives a Painless hit none, and none again within fPainDelay (1.5 s)', () => {
    const pain = new PlayerPain();
    expect(pain.hit(0, false)).toBeUndefined();
    expect(pain.hit(1, true)).toBeDefined();
    expect(pain.hit(2, true)).toBeUndefined();
    expect(pain.hit(2.5, true)).toBeDefined();
  });

  it('reads the settings by their names, the engine’s defaults for those missing', () => {
    const settings = readPlayerPainSettings((name) => (name === 'fPainDelay' ? 3 : undefined));
    expect(settings).toEqual({ delay: 3, rumbleSeconds: 0.5, rumbleStrength: 0.75 });
  });
});

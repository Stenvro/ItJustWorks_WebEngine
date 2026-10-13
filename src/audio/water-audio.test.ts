import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../render/math.ts';
import { IniSettings } from '../world/ini-settings.ts';
import { WaterAudio, waterAreaHeight, type WaterPlayer, type WaterSound } from './water-audio.ts';

const RIVER = 0x500;
const RIVER_SOUND = 0x600;

interface Played {
  sound: number;
  place: () => Vec3;
  fadeIn: number;
  fadedOut: number | undefined;
}

class FakePlayer implements WaterPlayer {
  readonly played: Played[] = [];

  waterSound(type: number): Promise<number | undefined> {
    return Promise.resolve(type === RIVER ? RIVER_SOUND : undefined);
  }

  play(sound: number, place: () => Vec3, fadeIn: number): Promise<WaterSound | undefined> {
    const entry: Played = { sound, place, fadeIn, fadedOut: undefined };
    this.played.push(entry);
    return Promise.resolve({
      fadeOut: (seconds: number) => {
        entry.fadedOut = seconds;
      },
      stop: () => undefined,
    });
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** A river along x = 1000 (water where x > 900), 100 deep below z 0. */
const river = (x: number): { height: number; type: number } | undefined =>
  x > 900 ? { height: 0, type: RIVER } : undefined;

describe('water audio', () => {
  const ini = new IniSettings(undefined);

  it('plays a water type’s sound towards the nearest water, fading in and out', async () => {
    const player = new FakePlayer();
    const water = new WaterAudio(player, ini);
    water.update([0, 0, 100], river, 0);
    await settle();
    water.update([0, 0, 100], river, 1);
    await settle();
    expect(player.played).toHaveLength(1);
    const loop = player.played[0];
    expect(loop?.sound).toBe(RIVER_SOUND);
    expect(loop?.fadeIn).toBe(ini.number('Audio', 'fWaterAudioFadeInSeconds'));
    // East of the listener, about as far as the nearest water sample point.
    const [x, , z] = loop?.place() ?? [0, 0, 0];
    expect(x).toBeGreaterThan(900);
    expect(x).toBeLessThan(1400);
    expect(z).toBeLessThan(100);
    // Walking away from the water: the loop fades out.
    water.update([-5000, 0, 100], river, 2);
    expect(loop?.fadedOut).toBe(ini.number('Audio', 'fWaterAudioFadeOutSeconds'));
  });

  it('ignores water without a sound, and no water at all', async () => {
    const player = new FakePlayer();
    const water = new WaterAudio(player, ini);
    water.update([0, 0, 0], () => ({ height: 0, type: 0x501 }), 0);
    await settle();
    water.update([0, 0, 0], () => ({ height: 0, type: 0x501 }), 1);
    water.update([0, 0, 0], undefined, 2);
    expect(player.played).toHaveLength(0);
  });

  it("finds a water activator's surface over a point", () => {
    // A 1024-unit water plane at z 50, turned 90° around z.
    const area = {
      type: RIVER,
      world: new Float32Array([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 100, 200, 50, 1]),
      min: [-512, -512, 0] as const,
      max: [512, 512, 0] as const,
    };
    expect(waterAreaHeight(area, 100, 200)).toBeCloseTo(50);
    expect(waterAreaHeight(area, 600, 200)).toBeCloseTo(50);
    expect(waterAreaHeight(area, 700, 200)).toBeUndefined();
  });
});

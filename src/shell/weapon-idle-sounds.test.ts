import { describe, expect, it } from 'vitest';
import { WeaponIdleSounds } from './weapon-idle-sounds.ts';

describe('WeaponIdleSounds', () => {
  it('loops a drawn weapon’s idle sound until it is sheathed, and starts it once', async () => {
    const started: number[] = [];
    let stopped = 0;
    const idles = new WeaponIdleSounds((descriptor) => {
      started.push(descriptor);
      return Promise.resolve({ stop: () => (stopped += 1) });
    });
    const sword = { reference: 0x14, sound: 0xbeef, place: () => [0, 0, 0] as const };
    idles.update([sword]);
    idles.update([sword]);
    await Promise.resolve();
    expect(started).toEqual([0xbeef]);
    expect(idles.sounding).toEqual([0x14]);
    idles.update([]);
    expect(stopped).toBe(1);
    expect(idles.sounding).toEqual([]);
  });

  it('stops a loop that was still starting', async () => {
    let stopped = 0;
    const idles = new WeaponIdleSounds(() => Promise.resolve({ stop: () => (stopped += 1) }));
    idles.update([{ reference: 7, sound: 1, place: () => [0, 0, 0] }]);
    idles.clear();
    await Promise.resolve();
    expect(stopped).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { TRIGGER_EVENT_DELAY_MS, TriggerVolumes } from './trigger-volumes.ts';
import { GRIDS_TO_LOAD, inAttachedArea } from './runtime.ts';

describe('trigger volumes', () => {
  it('tell those inside at once, then every fTriggerEventDelayMS while they stay', () => {
    const volumes = new TriggerVolumes();
    const told: string[] = [];
    const tell = (trigger: number, reference: number): void => {
      told.push(`${String(trigger)}:${String(reference)}`);
    };
    volumes.enter(1, 7);
    volumes.update(0.016, tell);
    expect(told).toEqual(['1:7']);
    // Not again before the delay.
    volumes.update(0.3, tell);
    expect(told).toEqual(['1:7']);
    volumes.enter(1, 8);
    volumes.update((TRIGGER_EVENT_DELAY_MS - 300) / 1000, tell);
    expect(told).toEqual(['1:7', '1:7', '1:8']);
    // Gone: no more.
    volumes.leave(1, 7);
    volumes.forget(8);
    volumes.update(1, tell);
    expect(told).toHaveLength(3);
  });

  it("follow the INI's delay", () => {
    const volumes = new TriggerVolumes();
    volumes.delayMs = 100;
    let count = 0;
    volumes.enter(1, 7);
    for (let frame = 0; frame < 30; frame++)
      volumes.update(0.01, () => {
        count++;
      });
    expect(count).toBe(3);
  });
});

describe('the attached area', () => {
  const player = { position: [1000, 1000, 0] as [number, number, number], cell: 5, world: 60 };

  it("is the player's interior cell inside", () => {
    const inside = { position: [0, 0, 0] as [number, number, number], cell: 9, world: undefined };
    expect(inAttachedArea(inside, { ...inside }, GRIDS_TO_LOAD)).toBe(true);
    expect(inAttachedArea({ ...inside, cell: 10 }, inside, GRIDS_TO_LOAD)).toBe(false);
    expect(inAttachedArea(inside, player, GRIDS_TO_LOAD)).toBe(false);
  });

  it("is the uGridsToLoad cells round the player's outside", () => {
    const at = (x: number, y: number) => ({
      position: [x, y, 0] as [number, number, number],
      cell: undefined,
      world: 60,
    });
    expect(inAttachedArea(at(2 * 4096 + 10, 0), player, GRIDS_TO_LOAD)).toBe(true);
    expect(inAttachedArea(at(3 * 4096 + 10, 0), player, GRIDS_TO_LOAD)).toBe(false);
    expect(inAttachedArea(at(0, -2 * 4096), player, GRIDS_TO_LOAD)).toBe(true);
    expect(inAttachedArea({ ...at(0, 0), world: 61 }, player, GRIDS_TO_LOAD)).toBe(false);
  });
});

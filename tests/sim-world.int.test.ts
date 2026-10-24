// Integration test: the headless simulation (src/sim/) on the local game data. A world runs
// in Node without a screen; the same seed, place and steps observe the same things, step for
// step. Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, openSim, PLAYER_REF } from './helpers/sim.ts';

/** The Bannered Mare (interior CELL). */
const BANNERED_MARE = 0x1605e;
/** Hulda, its innkeeper. */
const HULDA = 0x1a66e;

/** What a run observed, as text (its records, the actors' places). */
async function run(seed: number): Promise<{ records: string[]; places: string[] }> {
  const sim = await openSim({ interior: BANNERED_MARE, hour: 10, seed });
  try {
    await sim.step(5);
    const records = sim
      .records()
      .map((record) => `${record.at.toFixed(3)} ${JSON.stringify({ ...record, at: undefined })}`);
    const places = sim
      .actors()
      .map(
        (actor) =>
          `${actor.reference.toString(16)} ${actor.position.map((v) => v.toFixed(2)).join(',')}`,
      );
    return { records, places };
  } finally {
    await sim.close();
  }
}

describe.skipIf(!hasGamedata())('the headless simulation', () => {
  it('runs a cell’s actors, scripts and physics with no screen', async () => {
    const sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    try {
      await sim.step(3);
      expect(sim.actor(HULDA)).toBeDefined();
      expect(sim.package(HULDA)).toBeDefined();
      expect(sim.world.play?.spawned).toBe(true);
      expect((await sim.position(PLAYER_REF))?.length).toBe(3);
      expect(sim.records().some((record) => record.kind === 'footstep')).toBe(true);
      expect(sim.problems()).toEqual([]);
    } finally {
      await sim.close();
    }
  }, 300_000);

  it('observes the same, step for step, from the same seed', async () => {
    const first = await run(7);
    const second = await run(7);
    expect(second.places).toEqual(first.places);
    expect(second.records).toEqual(first.records);
  }, 300_000);
});

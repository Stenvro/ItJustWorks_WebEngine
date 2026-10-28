// The player's falls in the simulation: as an actor's, they go through the idle tree (ActionFall:
// 0_master's JumpFall idle only falling faster than 350 units a second), so a step down or a
// short drop plays no fall and no landing, and a long drop does.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasGamedata, openSim, type Sim } from './helpers/sim.ts';

const TAMRIEL = 0x3c;

describe.skipIf(!hasGamedata())('the player’s falls in the simulation', () => {
  let sim: Sim;
  beforeAll(async () => {
    sim = await openSim({ exterior: { world: TAMRIEL, cell: [4, -11] }, hour: 10, gridRadius: 1 });
    await sim.step(2);
  }, 180_000);
  afterAll(async () => {
    await sim.close();
  });

  /**
   * Drops the player from `height` above where they stand: their vertical speed as their graph
   * took a fall (undefined: it took none before they landed).
   */
  async function drop(height: number): Promise<number | undefined> {
    const feet = sim.world.player.feet;
    await sim.moveTo([feet[0], feet[1], feet[2] + height]);
    for (let i = 0; i < 60; i++) {
      await sim.step(0.05);
      const states = sim.world.playerView?.avatar?.body.behavior?.states() ?? [];
      if (states.some(({ state }) => /jumpfall/i.test(state))) {
        return sim.world.player.character.verticalSpeed;
      }
      if (i > 2 && sim.world.player.character.grounded) return undefined;
    }
    return undefined;
  }

  it('plays no fall stepping down a little', async () => {
    expect(sim.world.player.character.grounded).toBe(true);
    expect(await drop(40)).toBeUndefined();
  }, 60_000);

  it('plays a fall from high up once falling faster than 350 units a second', async () => {
    await sim.step(1);
    const speed = await drop(600);
    expect(speed).toBeDefined();
    expect(speed ?? 0).toBeLessThan(-340);
  }, 60_000);
});

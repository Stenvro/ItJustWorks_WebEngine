// Water's physics in the simulation (src/physics/water-physics.ts): something dropped into
// Riverwood's river floats and drifts downstream along the river's flow map.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Layer } from '../src/physics/collision-layers.ts';
import { HAVOK_SCALE } from '../src/physics/collision-data.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const TAMRIEL = 0x3c;
/** Riverwood's cells and the river's next to it. */
const RIVER_CELLS: readonly (readonly [number, number])[] = [
  [4, -11],
  [5, -11],
  [3, -11],
  [4, -12],
];

describe.skipIf(!hasGamedata())('water in the simulation', () => {
  let sim: Sim;
  beforeAll(async () => {
    sim = await openSim({ exterior: { world: TAMRIEL, cell: [4, -11] }, hour: 10 });
  }, 180_000);
  afterAll(async () => {
    await sim.close();
  });

  it('floats firewood dropped into Riverwood’s river downstream', async () => {
    const play = sim.world.play;
    const water = play?.water;
    if (!play || !water) throw new Error('no play');
    // A point of the river at least 80 units deep that flows: its flow maps load as asked.
    const points: [number, number][] = [];
    for (const [cx, cy] of RIVER_CELLS) {
      for (let x = 64; x < 4096; x += 128) {
        for (let y = 64; y < 4096; y += 128) points.push([cx * 4096 + x, cy * 4096 + y]);
      }
    }
    const flowing = (): { at: [number, number, number]; flow: [number, number] } | undefined => {
      for (const [x, y] of points) {
        const hit = play.physics.raycast([x, y, 6000], [0, 0, -1], 12_000, Layer.charController);
        if (!hit) continue;
        const surface = water.surface(x, y, hit.point[2]);
        if (!surface || surface.height - hit.point[2] < 80) continue;
        const [fx, fy] = water.current(surface.type, x, y);
        if (Math.hypot(fx, fy) * HAVOK_SCALE < 60) continue;
        return { at: [x, y, surface.height], flow: [fx, fy] };
      }
      return undefined;
    };
    for (let i = 0; i < 30 && !flowing(); i++) await sim.step(0.2);
    const river = flowing();
    expect(river).toBeDefined();
    if (!river) return;
    const [x, y, surface] = river.at;
    // The firewood dropped from a metre above the river.
    const firewood = await sim.place(await sim.formId('MISC', 'Firewood01'), PLAYER_REF);
    sim.runtime.move(firewood, [x + 40, y + 40, surface + 100]);
    await sim.step(0.2);
    const start = await sim.position(firewood);
    await sim.step(8);
    const end = await sim.position(firewood);
    if (!start || !end) throw new Error('no firewood');
    // It floats at the surface ...
    expect(Math.abs(end[2] - surface)).toBeLessThan(40);
    // ... and went downstream, along the river's flow.
    const moved = [end[0] - start[0], end[1] - start[1]] as const;
    const along = (moved[0] * river.flow[0] + moved[1] * river.flow[1]) / Math.hypot(...river.flow);
    console.log(
      `firewood: from ${start.map(Math.round).join(',')} to ${end.map(Math.round).join(',')}, ` +
        `${Math.round(along)} units downstream`,
    );
    expect(along).toBeGreaterThan(200);
  }, 120_000);

  // TODO(M10): an NPC told to walk across a pond swims (race Swims, NPCSwimming) and comes out.
  it.todo('swims an NPC across a pond and out again');
});

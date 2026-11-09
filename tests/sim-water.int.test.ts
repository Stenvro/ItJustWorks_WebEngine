// Water's physics in the simulation (src/physics/water-physics.ts): something dropped into
// Riverwood's river floats and drifts downstream along the river's flow map.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Layer } from '../src/physics/collision-layers.ts';
import { HAVOK_SCALE } from '../src/physics/collision-data.ts';
import { findPath } from '../src/ai/pathfinding.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const TAMRIEL = 0x3c;
/** Riverwood's cells and the river's next to it. */
const RIVER_CELLS: readonly (readonly [number, number])[] = [
  [4, -11],
  [5, -11],
  [3, -11],
  [4, -12],
];
/** Water this deep (units) is over a human's shoulders: one of a race that swims swims there. */
const SWIM_DEPTH = 120;

type Vec3 = [number, number, number];

describe.skipIf(!hasGamedata())('water in the simulation', () => {
  let sim: Sim;
  beforeAll(async () => {
    sim = await openSim({ exterior: { world: TAMRIEL, cell: [4, -11] }, hour: 10 });
  }, 180_000);
  afterAll(async () => {
    await sim.close();
  });

  it('jumps out of the water fJumpSwimmingMult times as high, and swims again', async () => {
    const play = sim.world.play;
    const water = play?.water;
    if (!play || !water) throw new Error('no play');
    // The deepest water of the river's cells (they load as the world steps).
    const deepest = (): { floor: [number, number, number]; depth: number } | undefined => {
      let found: { floor: [number, number, number]; depth: number } | undefined;
      for (const [cx, cy] of RIVER_CELLS) {
        for (let x = 64; x < 4096; x += 128) {
          for (let y = 64; y < 4096; y += 128) {
            const at: [number, number] = [cx * 4096 + x, cy * 4096 + y];
            const hit = play.physics.raycast(
              [...at, 6000],
              [0, 0, -1],
              12_000,
              Layer.charController,
            );
            const surface = hit && water.surface(at[0], at[1], hit.point[2]);
            if (surface && surface.height - hit.point[2] > (found?.depth ?? 0)) {
              found = {
                floor: [at[0], at[1], hit.point[2]],
                depth: surface.height - hit.point[2],
              };
            }
          }
        }
      }
      return found;
    };
    let deep = deepest();
    for (let i = 0; i < 30 && (deep?.depth ?? 0) < 110; i++) {
      await sim.step(0.2);
      deep = deepest();
    }
    if (!deep) throw new Error('no water');
    expect(deep.depth).toBeGreaterThan(110);
    await sim.moveTo([deep.floor[0], deep.floor[1], deep.floor[2] + 5]);
    const player = sim.world.player;
    expect(await sim.until(() => player.swimming, 3)).toBe(true);
    await sim.step(1.5);
    const swum = player.feet[2];
    sim.press('Jump', true);
    await sim.step(1 / 60);
    sim.press('Jump', false);
    let top = swum;
    for (let i = 0; i < 60; i++) {
      await sim.step(1 / 60);
      top = Math.max(top, player.feet[2]);
    }
    // fJumpHeightMin (76) × 2, less what a step's gravity takes.
    expect(top - swum).toBeGreaterThan(130);
    expect(top - swum).toBeLessThan(165);
    expect(await sim.until(() => player.swimming, 5)).toBe(true);
  }, 120_000);

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

  // An NPC sent over the river (as a script's PathToReference sends one: it runs no package, so
  // its race's Swims lets it swim, src/ai/race-ai-flags.ts) wades in, swims across along the
  // navmesh's water triangles and walks out on the far bank.
  it('swims an NPC across a pond and out again', async () => {
    const play = sim.world.play;
    const water = play?.water;
    if (!play || !water) throw new Error('no play');
    const navmeshes = sim.world.navmeshes;
    /** The ground at a point and the water's depth over it (0: dry). */
    const ground = (x: number, y: number): { z: number; depth: number } | undefined => {
      const hit = play.physics.raycast([x, y, 6000], [0, 0, -1], 12_000, Layer.charController);
      if (!hit) return undefined;
      const surface = water.surface(x, y, hit.point[2]);
      return { z: hit.point[2], depth: surface ? Math.max(0, surface.height - hit.point[2]) : 0 };
    };
    /** Deep water's points of the river's cells (they load as the world steps). */
    const deepWater = (): [number, number][] => {
      const found: [number, number][] = [];
      for (const [cx, cy] of RIVER_CELLS) {
        for (let x = 64; x < 4096; x += 256) {
          for (let y = 64; y < 4096; y += 256) {
            const at: [number, number] = [cx * 4096 + x, cy * 4096 + y];
            if ((ground(...at)?.depth ?? 0) > SWIM_DEPTH) found.push(at);
          }
        }
      }
      return found;
    };
    let deep = deepWater();
    for (let i = 0; i < 30 && deep.length === 0; i++) {
      await sim.step(0.2);
      deep = deepWater();
    }
    expect(deep.length).toBeGreaterThan(0);
    /** Dry navmesh ground beyond the water from a point of it, along a way. */
    const bank = (at: [number, number], dx: number, dy: number): Vec3 | undefined => {
      for (let d = 32; d < 1500; d += 32) {
        const x = at[0] + dx * d;
        const y = at[1] + dy * d;
        const here = ground(x, y);
        if (!here) return undefined;
        if (here.depth > 0) continue;
        // On dry ground: a little further in, on the navmesh.
        const inland = ground(x + dx * 160, y + dy * 160);
        if (!inland || inland.depth > 0) return undefined;
        const on: Vec3 = [x + dx * 160, y + dy * 160, inland.z];
        return navmeshes.locate(on) ? on : undefined;
      }
      return undefined;
    };
    /** The deepest water along a path's legs (0: it keeps to dry ground). */
    const deepestOn = (points: readonly (readonly [number, number, number])[]): number => {
      let deepest = 0;
      for (let i = 1; i < points.length; i++) {
        const [a, b] = [points[i - 1], points[i]];
        if (!a || !b) continue;
        const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 32);
        for (let k = 0; k <= steps; k++) {
          const depth = ground(
            a[0] + ((b[0] - a[0]) * k) / steps,
            a[1] + ((b[1] - a[1]) * k) / steps,
          )?.depth;
          deepest = Math.max(deepest, depth ?? 0);
        }
      }
      return deepest;
    };
    // A way across: banks on either side of deep water whose way over the navmeshes, for one who
    // swims, goes straight through the deep water (not round by Riverwood's bridge).
    let crossing: { from: Vec3; to: Vec3 } | undefined;
    for (const at of deep) {
      for (let i = 0; i < 8 && !crossing; i++) {
        const angle = (i * Math.PI) / 8;
        const [dx, dy] = [Math.cos(angle), Math.sin(angle)];
        const from = bank(at, dx, dy);
        const to = bank(at, -dx, -dy);
        if (!from || !to) continue;
        const path = findPath(navmeshes, from, to, { radius: 20, swims: true });
        if (!path?.complete) continue;
        const straight = Math.hypot(from[0] - to[0], from[1] - to[1]);
        let length = 0;
        for (let k = 1; k < path.points.length; k++) {
          const [a, b] = [path.points[k - 1], path.points[k]];
          if (a && b) length += Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
        if (length < straight * 1.3 && deepestOn(path.points) > SWIM_DEPTH) crossing = { from, to };
      }
      if (crossing) break;
    }
    expect(crossing).toBeDefined();
    if (!crossing) return;
    const { from, to } = crossing;
    // The NPC is placed on the near bank and held from packages; the player stands back from it
    // (out of its greeting's reach, which would stop it to greet them).
    await sim.moveTo([from[0] + 64, from[1], from[2] + 5]);
    const walker = await sim.place(await sim.formId('NPC_', 'Hulda'), PLAYER_REF);
    sim.world.stage.ai.hold(walker, true);
    sim.runtime.move(walker, [from[0], from[1], from[2] + 5]);
    const width = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const back: Vec3 = [
      from[0] - ((to[0] - from[0]) / width) * 600,
      from[1] - ((to[1] - from[1]) / width) * 600,
      from[2],
    ];
    const stand = navmeshes.nearest?.(back, 1024);
    await sim.moveTo(
      stand ? [stand[0], stand[1], stand[2] + 5] : [back[0], back[1], back[2] + 100],
    );
    await sim.step(1);
    const movers = sim.world.stage.movers;
    let arrived: boolean | undefined;
    void movers.travel(walker, to, 'run', 48).then((done) => {
      arrived = done;
    });
    // Whether it swims (its controller) and whether its graph swims (Swim_State, its swim clips).
    let swam = false;
    let graphSwam = false;
    const graphSwims = (): boolean =>
      (sim.actor(walker)?.placed.behavior?.states() ?? []).some((entry) =>
        /^swim/i.test(entry.state),
      );
    await sim.until(() => {
      if (movers.motion(walker)?.swimming === true) swam = true;
      if (graphSwims()) graphSwam = true;
      return arrived !== undefined;
    }, 90);
    const end = await sim.position(walker);
    console.log(
      `walker: arrived ${String(arrived)}, swam ${String(swam)} (graph ${String(graphSwam)}), ` +
        `end ${end?.map(Math.round).join(',') ?? '-'}`,
    );
    expect(swam).toBe(true);
    expect(graphSwam).toBe(true);
    expect(arrived).toBe(true);
    // Out again: on the far bank, its feet over the water if any, swimming no more.
    if (!end) throw new Error('no walker');
    expect(Math.hypot(end[0] - to[0], end[1] - to[1])).toBeLessThan(100);
    const over = water.surface(end[0], end[1], end[2]);
    expect(over === undefined || over.height <= end[2] + 1).toBe(true);
    await sim.step(0.5);
    expect(movers.motion(walker)?.swimming).toBe(false);
    expect(graphSwims()).toBe(false);
  }, 180_000);
});

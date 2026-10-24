// Conformance: the people's foot IK (engine map: Animation and bodies > Procedural modifiers):
// the knee bends the hinge's way, never backwards.
//
// Sources:
// - The data: the people's hkbFootIkDriverInfo (actors\character\defaultmale.hkx's character
//   data): each leg's hip, knee and ankle, the knee's hinge axis (-1, 0, 0 in the knee's space)
//   and its interior angle within 5..165 degrees (docs/animation.md, "Procedural modifiers").
// - original: the two-joint solver turns the knee about its hinge by the wanted interior angle less
//   the one it has, taken without a sign: a leg the clip holds straight, or a little past
//   straight, bends forward to the limit. Ours took the side from the angle's sign and bent such
//   knees 15 degrees backwards for a frame or a few (the maintainer's "knocking knees" of NPCs
//   walking and standing): 15 of 3,652 knee solves in the Bannered Mare, 439 of 11,540 in
//   Whiterun's market.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ModelSpace } from '../../../src/animation/procedural.ts';
import { loadCharacterInfo, type FootIkSetup } from '../../../src/formats/hkx/behavior.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

/** The Bannered Mare (Whiterun): people walk, stand, sit and play. */
const BANNERED_MARE = 0x1605e;
const PROJECT = 'meshes\\actors\\character\\defaultmale.hkx';

type Vec3 = readonly [number, number, number];

function turned(q: readonly number[], v: Vec3): Vec3 {
  const [x = 0, y = 0, z = 0, w = 1] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** The knee's signed angle from the thigh to the calf about its hinge (degrees; 180 straight). */
function kneeAngle(space: ModelSpace, leg: FootIkSetup['legs'][number]): number {
  const hip = space.position(leg.hipIndex);
  const knee = space.position(leg.kneeIndex);
  const ankle = space.position(leg.ankleIndex);
  const hinge = turned(space.rotation(leg.kneeIndex), leg.kneeAxis);
  const up = [hip[0] - knee[0], hip[1] - knee[1], hip[2] - knee[2]] as const;
  const down = [ankle[0] - knee[0], ankle[1] - knee[1], ankle[2] - knee[2]] as const;
  const cross = [
    up[1] * down[2] - up[2] * down[1],
    up[2] * down[0] - up[0] * down[2],
    up[0] * down[1] - up[1] * down[0],
  ] as const;
  const sine = hinge[0] * cross[0] + hinge[1] * cross[1] + hinge[2] * cross[2];
  const cosine = up[0] * down[0] + up[1] * down[1] + up[2] * down[2];
  return (Math.atan2(sine, cosine) * 180) / Math.PI;
}

describe.skipIf(!hasGamedata())('the people’s knees under foot IK (headless simulation)', () => {
  let sim: Sim;
  let samples = 0;
  const backwards: string[] = [];

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    const vfs = sim.world.session.vfs;
    const legs = (await loadCharacterInfo(PROJECT, (path) => vfs.read(path))).footIk?.legs ?? [];
    await sim.step(4);
    for (let frame = 0; frame < 90; frame++) {
      await sim.step(1 / 30);
      for (const actor of sim.actors()) {
        const graph = actor.placed.behavior;
        if (graph?.variable('bHumanoidFootIKEnable') !== 1) continue;
        if (!graph.skeleton.bones.some((bone) => bone.name === 'NPC L Calf [LClf]')) continue;
        const space = new ModelSpace(graph.skeleton.parents);
        space.update(graph.pose);
        for (const leg of legs) {
          samples++;
          const angle = kneeAngle(space, leg);
          if (angle < 0) backwards.push(`${actor.placed.actor.editorId} ${angle.toFixed(0)}`);
        }
      }
    }
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('no knee bends backwards, walking or standing', () => {
    expect(samples).toBeGreaterThan(500);
    expect(backwards).toEqual([]);
  });
});

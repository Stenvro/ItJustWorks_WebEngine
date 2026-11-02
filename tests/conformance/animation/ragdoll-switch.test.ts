// Conformance: the switch from animation into ragdoll (engine map: Animation and bodies >
// Ragdolls, death). A living actor's ragdoll bodies follow its animated pose by Havok's key frame
// hierarchy controller (src/physics/keyframe-hierarchy.ts) with their blend collision objects'
// gains (1 and 1 in every skeleton of the data: keyframed exactly); let go as it dies, they go on
// from where the pose had them, moving as the animation moved them (a keyframed Havok body
// carries its velocity), so the ragdoll starts from the pose without a jump or a stop.
//
// Sources:
// - The data: every bhkBlendCollisionObject's heirGain and velocityGain are 1
//   (`node tools/animation-physics-completeness.ts`); the human graph's AnimateToRagdoll keyframes
//   all 18 ragdoll bones, its Root state's DriveRagdollRB holds Havok's default control data.
// - Havok's documented hkaKeyFrameHierarchyUtility control data (docs/physics.md, "The
//   hierarchy controller").

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAVOK_SCALE } from '../../../src/physics/collision-data.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const BANNERED_MARE = 0x1605e;
const HULDA = 0x1a66e;

type V = readonly [number, number, number];

const ZERO: V = [0, 0, 0];
const minus = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const length = (a: V): number => Math.hypot(a[0], a[1], a[2]);

describe.skipIf(!hasGamedata())(
  'a death lets the ragdoll go from the animated pose (headless)',
  () => {
    let sim: Sim | undefined;
    let before: V[] = [];
    let last: V[] = [];
    let after: V[] = [];
    let velocities: V[] = [];
    let dynamic: boolean[] = [];
    let moving = 0;

    const sample = (): V[] =>
      (sim?.world.stage.bodies.placements(HULDA)[0]?.bodies ?? []).map(({ body }) => {
        const t = body.translation();
        return [t.x, t.y, t.z];
      });

    beforeAll(async () => {
      const opened = await openSim({ interior: BANNERED_MARE, hour: 10 });
      sim = opened;
      const furniture = opened.world.stage.furniture;
      await opened.until(() => furniture.interaction(HULDA)?.state === 3, 60);
      await opened.step(1.5);
      before = sample();
      await opened.step(1 / 60);
      last = sample();
      await opened.kill(HULDA, PLAYER_REF);
      after = sample();
      const bodies = opened.world.stage.bodies.placements(HULDA)[0]?.bodies ?? [];
      dynamic = bodies
        .filter(({ data }) => data.motion === 'dynamic')
        .map(({ body }) => body.isDynamic());
      velocities = bodies.map(({ body }) => {
        const v = body.linvel();
        return [v.x, v.y, v.z];
      });
      moving = Math.max(...last.map((p, i) => length(minus(p, before[i] ?? p)) * 60 * HAVOK_SCALE));
    }, 900_000);
    afterAll(async () => {
      await sim?.close();
    });

    it('her bodies are let go (simulated) where her pose had them: no jump at the switch', () => {
      expect(after.length).toBeGreaterThan(10);
      expect(dynamic.every(Boolean)).toBe(true);
      after.forEach((p, i) => {
        expect(length(minus(p, last[i] ?? ZERO)) * HAVOK_SCALE).toBeLessThan(0.5);
      });
    });

    it('each body moves on as the animation moved it the frame before', () => {
      // Her lean idle moves her (a hand at some 40 units a second).
      expect(moving).toBeGreaterThan(10);
      velocities.forEach((v, i) => {
        const moved = minus(last[i] ?? ZERO, before[i] ?? ZERO);
        const animated: V = [moved[0] * 60, moved[1] * 60, moved[2] * 60];
        const gap = length(minus(v, animated)) * HAVOK_SCALE;
        expect(gap).toBeLessThan(0.5 + 0.05 * length(animated) * HAVOK_SCALE);
      });
    });
  },
);

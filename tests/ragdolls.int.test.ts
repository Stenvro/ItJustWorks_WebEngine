// Integration test: the dead's ragdolls on the local game data: placed ragdoll poses (XRGD)
// read and applied as the engine walks them, and race skeletons' ragdolls coming to rest.
// Skipped without game data.

import { beforeAll, describe, expect, it } from 'vitest';
import { ActorPose, ActorSkeleton, buildRig } from '../src/animation/skeleton.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { buildCollision, HAVOK_SCALE, type CollisionData } from '../src/physics/collision-data.ts';
import {
  CollisionMatrix,
  Layer,
  parseCollisionLayer,
  type CollisionLayer,
} from '../src/physics/collision-layers.ts';
import { GRAVITY, initPhysics, PHYSICS_STEP, PhysicsWorld } from '../src/physics/physics-world.ts';
import { ActorResolver } from '../src/world/actors.ts';
import { parseRagdollData, ragdollPoseLocals } from '../src/world/ragdoll-data.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const HUMAN = 'meshes\\actors\\character\\character assets\\skeleton.nif';

describe.skipIf(!hasGamedata())('ragdolls on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let matrix: CollisionMatrix;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    const layers: CollisionLayer[] = [];
    for (const formId of db.formIdsOfType('COLL')) {
      const record = await db.get(formId);
      if (record) layers.push(parseCollisionLayer(record));
    }
    matrix = new CollisionMatrix(layers);
    await initPhysics();
  }, 60_000);

  it('applies the placed ragdoll poses of the dead as the engine walks them', async () => {
    const resolver = new ActorResolver(db);
    const models = new Map<string, CollisionData>();
    let posed = 0;
    let complete = 0;
    let lying: number | undefined;
    for (const formId of db.formIdsOfType('ACHR')) {
      const record = await db.get(formId);
      const data = record && parseRagdollData(record.fields);
      if (!record || !data) continue;
      const path = (await resolver.resolve(record.formIdField('NAME') ?? 0, formId))?.skeleton;
      if (path === undefined || !vfs.has(path)) continue;
      let collision = models.get(path);
      if (!collision) {
        collision = buildCollision(parseNif(await vfs.read(path)));
        models.set(path, collision);
      }
      const order = collision.poseOrder;
      if (!order) continue;
      posed++;
      const names = new Map(order.map((entry, i) => [entry.node.toLowerCase(), i]));
      const result = ragdollPoseLocals(
        data,
        order,
        (name) => names.get(name.toLowerCase()),
        () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      );
      if (result.complete) complete++;
      // A dead human placed in its pose lies: its head near the floor.
      if (lying === undefined && result.complete && path.toLowerCase() === HUMAN) {
        const rig = buildRig(parseNif(await vfs.read(path)));
        const skeleton = new ActorSkeleton(rig, undefined);
        const pose = new ActorPose(skeleton);
        pose.placeLocals(
          ragdollPoseLocals(
            data,
            order,
            (name) => skeleton.nodeByName.get(name.toLowerCase()),
            (node) => rig.local.subarray(node * 16, node * 16 + 16),
          ).locals,
        );
        lying = pose.world('NPC Head [Head]')?.[14];
      }
    }
    // 1,463 of the dead carry a pose; nine in ten match their skeleton's bodies all through.
    expect(posed).toBeGreaterThan(1400);
    expect(complete / posed).toBeGreaterThan(0.88);
    expect(lying).toBeDefined();
    expect(Math.abs(lying ?? Infinity)).toBeLessThan(45);
  }, 120_000);

  it("lays race skeletons' ragdolls down on a floor and has them rest", async () => {
    for (const path of [
      HUMAN,
      'meshes\\actors\\canine\\character assets dog\\skeleton.nif',
      'meshes\\actors\\horse\\character assets\\skeleton.nif',
      'meshes\\actors\\draugr\\character assets\\skeletons.nif',
    ]) {
      const collision = buildCollision(parseNif(await vfs.read(path)));
      const physics = new PhysicsWorld(matrix, GRAVITY);
      physics.addMesh(
        Float32Array.of(-5000, -5000, 0, 5000, -5000, 0, 5000, 5000, 0, -5000, 5000, 0),
        Uint32Array.of(0, 1, 2, 0, 2, 3),
        Layer.ground,
        { reference: 0, kind: 'landscape' },
        true,
      );
      const world = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 1]);
      const placed = physics.addObject(collision, world, { reference: 1, kind: 'actor' }, false);
      physics.setMotion(placed, false);
      physics.setLayer(placed, Layer.deadBip);
      const bodies = placed.bodies.filter(({ body }) => body.isDynamic());
      const top = (): number => Math.max(...bodies.map(({ body }) => body.translation().z));
      const standing = top();
      let rested: number | undefined;
      for (let i = 0; i < 20 * 60 && rested === undefined; i++) {
        physics.step(PHYSICS_STEP);
        if (bodies.every(({ body }) => body.isSleeping())) rested = i * PHYSICS_STEP;
      }
      expect(rested, path).toBeDefined();
      expect(top() / standing, path).toBeLessThan(0.8);
      expect(
        Math.min(...bodies.map(({ body }) => body.translation().z * HAVOK_SCALE)),
      ).toBeGreaterThan(-5);
      physics.free();
    }
  }, 120_000);
});

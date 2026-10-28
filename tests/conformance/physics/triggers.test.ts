// Conformance: triggers (engine map: Physics > Triggers). What enters a trigger volume and what it
// is told: OnTriggerEnter (597 vanilla scripts), OnTriggerLeave (123), OnTrigger (38). Skipped
// without game data.
//
// Sources:
// - The engine's rule, observed in the original (src/scripting/runtime/trigger-volumes.ts): a volume tells
//   each reference inside it as it finds it there and again once [Havok] fTriggerEventDelayMS
//   (500 ms) has passed since it last told any; entering and leaving are told apart
//   (TESTriggerEnterEvent, TESTriggerLeaveEvent).
// - The collision layers (COLL records): which layers L_TRIGGER collides with: what can be in a
//   trigger volume (its phantom reports what its layer collides with).
// - The data: a trigger is an activator placed with a primitive (REFR XPRM, its volume on
//   L_TRIGGER: src/world/cell-loader.ts).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CollisionMatrix as Matrix,
  Layer,
  LayerFlag,
  readCollisionMatrix,
  type CollisionMatrix,
} from '../../../src/physics/collision-layers.ts';
import type { CollisionData } from '../../../src/physics/collision-data.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from '../../../src/physics/physics-world.ts';
import {
  TRIGGER_EVENT_DELAY_MS,
  TriggerVolumes,
} from '../../../src/scripting/runtime/trigger-volumes.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { scriptEventUsage } from '../../../tools/script-event-usage.ts';
import { hasGamedata } from '../../helpers/sim.ts';

describe('trigger volumes (the engine’s rule)', () => {
  it('tells everyone inside once fTriggerEventDelayMS (500 ms) has passed, again and again', () => {
    const volumes = new TriggerVolumes();
    const told: string[] = [];
    volumes.enter(1, 20);
    volumes.enter(1, 21);
    for (let step = 0; step < 4; step++) {
      volumes.update(0.3, (trigger, reference) =>
        told.push(`${String(trigger)}:${String(reference)}`),
      );
    }
    // At once (never told yet), then after 600 ms (the delay passed at the third step).
    expect(told).toEqual(['1:20', '1:21', '1:20', '1:21']);
    expect(TRIGGER_EVENT_DELAY_MS).toBe(500);
  });

  it('stops telling one that left', () => {
    const volumes = new TriggerVolumes();
    const told: number[] = [];
    volumes.enter(1, 20);
    volumes.leave(1, 20);
    volumes.update(1, (_, reference) => told.push(reference));
    expect(told).toEqual([]);
  });
});

describe.skipIf(!hasGamedata())('what can be in a trigger (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let matrix: CollisionMatrix;
  let handlers: ReadonlyMap<string, readonly string[]>;
  let triggers = 0;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    matrix = await readCollisionMatrix(db);
    handlers = (await scriptEventUsage(vfs)).handlers;
    const activators = new Set(db.formIdsOfType('ACTI'));
    await db.scan(
      ['REFR'],
      () => true,
      (record) => {
        const base = record.formIdField('NAME');
        if (
          !record.deleted &&
          base !== undefined &&
          activators.has(base) &&
          record.fields.has('XPRM')
        )
          triggers++;
      },
    );
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts the scripts that handle the trigger events (597, 123, 38)', () => {
    expect(handlers.get('ontriggerenter')?.length).toBe(597);
    expect(handlers.get('ontriggerleave')?.length).toBe(123);
    expect(handlers.get('ontrigger')?.length).toBe(38);
  });

  it('counts the 5,286 activators placed with a primitive (trigger volumes)', () => {
    expect(triggers).toBe(5286);
  });

  it('lets L_TRIGGER take in 14 layers (COLL): actors, clutter, weapons, projectiles, spells, …', () => {
    const takes = Object.entries(Layer)
      .filter(([, index]) => matrix.collides(Layer.trigger, index))
      .map(([name]) => name);
    expect(takes).toEqual([
      'unidentified',
      'clutter',
      'weapon',
      'projectile',
      'spell',
      'biped',
      'trap',
      'debrisLarge',
      'invisibleWall',
      'charController',
      'deadBip',
      'coneProjectile',
      'customPick1',
      'customPick2',
    ]);
  });
});

describe('what enters a trigger', () => {
  it(
    'tells a trigger a clutter object thrown into it, and not an object of a layer the ' +
      'trigger’s does not collide with (the layer matrix)  [COLL]',
    async () => {
      await initPhysics();
      // L_TRIGGER meets L_CLUTTER, not L_PROPS.
      const matrix = new Matrix([
        {
          formId: 3,
          editorId: 'L_TRIGGER',
          index: Layer.trigger,
          name: '',
          flags: LayerFlag.triggerVolume,
          collidesWith: [4],
        },
        {
          formId: 4,
          editorId: 'L_CLUTTER',
          index: Layer.clutter,
          name: '',
          flags: 0,
          collidesWith: [3],
        },
        {
          formId: 5,
          editorId: 'L_PROPS',
          index: Layer.props,
          name: '',
          flags: 0,
          collidesWith: [],
        },
      ]);
      const physics = new PhysicsWorld(matrix, GRAVITY);
      const at = (x: number, y: number, z: number): Float32Array =>
        new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
      physics.addPrimitive('box', [100, 100, 100], at(0, 0, 0), Layer.trigger, {
        reference: 0x77,
        kind: 'object',
      });
      const box = (layer: number): CollisionData => {
        const points: number[] = [];
        for (const x of [-5, 5])
          for (const y of [-5, 5]) for (const z of [-5, 5]) points.push(x, y, z);
        return {
          bodies: [
            {
              node: 'Box',
              transform: at(0, 0, 0),
              motion: 'dynamic',
              phantom: false,
              layer,
              mass: 2,
              inertia: [0.02, 0.02, 0.02],
              centerOfMass: [0, 0, 0],
              friction: 0.5,
              restitution: 0.4,
              linearDamping: 0,
              angularDamping: 0.05,
              gravityFactor: 1,
              maxLinearVelocity: 0,
              maxAngularVelocity: 0,
              quality: 0,
              solverDeactivation: 1,
              shapes: [
                {
                  type: 'convex',
                  layer,
                  material: 0,
                  points: Float32Array.from(points),
                  radius: 0,
                },
              ],
            },
          ],
          skipped: [],
        };
      };
      // Both thrown down through it from above (thrown, not placed by a cell: no settling).
      const clutter = physics.addObject(
        box(Layer.clutter),
        at(0, 0, 150),
        { reference: 0x10, kind: 'object' },
        false,
      );
      const prop = physics.addObject(
        box(Layer.props),
        at(30, 0, 150),
        { reference: 0x11, kind: 'object' },
        false,
      );
      expect(clutter.dynamic && prop.dynamic).toBe(true);
      for (const { body } of [...clutter.bodies, ...prop.bodies]) {
        physics.release(body);
        body.wakeUp();
      }
      const entered = new Map<number, Set<number>>();
      for (let i = 0; i < 300; i++) {
        physics.step(1 / 60);
        for (const [object, triggers] of physics.movingInTriggers())
          for (const trigger of triggers)
            entered.set(object, (entered.get(object) ?? new Set()).add(trigger));
      }
      expect([...(entered.get(0x10) ?? [])]).toEqual([0x77]);
      expect(entered.get(0x11)).toBeUndefined();
      physics.free();
      // A clutter object a cell placed in the volume (it settles, the warm start) is not told
      // as its cell loads: the game's placed clutter lies inactive until disturbed [original]. (No
      // gravity here: it stays in the volume without a floor.)
      const still = new PhysicsWorld(matrix, 0);
      still.addPrimitive('box', [100, 100, 100], at(0, 0, 0), Layer.trigger, {
        reference: 0x77,
        kind: 'object',
      });
      const placed = still.addObject(box(Layer.clutter), at(0, 0, 0), {
        reference: 0x12,
        kind: 'object',
      });
      const seen = (): boolean => still.movingInTriggers().has(0x12);
      let told = false;
      for (let i = 0; i < 30; i++) {
        still.step(1 / 60);
        told ||= seen();
      }
      expect(told).toBe(false);
      // Settled, then disturbed: it enters as it moves.
      for (let i = 0; i < 60 * still.settleSeconds; i++) still.step(1 / 60);
      placed.bodies[0]?.body.applyImpulse({ x: 0.05, y: 0, z: 0 }, true);
      still.step(1 / 60);
      expect(seen()).toBe(true);
      still.free();
    },
  );
  it.todo('tells a trigger an arrow or spell flying through it (L_PROJECTILE)  [COLL] (sim)');
  it.todo('tells a trigger a dead body in it (L_DEADBIP)  [COLL] (sim)');
  it.todo('tells a trigger a weapon dropped into it (L_WEAPON)  [COLL] (sim)');
  it.todo(
    'tells a trigger a spell’s or a flame’s projectile in it (L_SPELL, L_CONEPROJECTILE)  [COLL] (sim)',
  );
  it.todo(
    'tells a trigger a trap’s moving body in it (L_TRAP) and large debris (L_DEBRIS_LARGE)  [COLL] (sim)',
  );
  it.todo(
    'checks the layer matrix for every trigger: a layer that does not collide with the ' +
      'trigger’s is not told (the trigger’s own layer: XTRI)  [COLL] (sim)',
  );
  it.todo(
    'tells what was inside a trigger when it is enabled or its cell loads (OnTriggerEnter on ' +
      'what stands in it)  [original] (sim)',
  );
  it.todo('tells OnTriggerLeave as something inside is disabled or deleted  [original] (sim)');
});

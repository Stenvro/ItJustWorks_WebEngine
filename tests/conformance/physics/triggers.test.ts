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
//   L_TRIGGER: src/world/cell-loader.ts). Who it takes in is by its layer (XTRI): 5,286 of them,
//   4,457 without XTRI and 829 with. An activator with a keyword (ACTI KNAM) takes in only what
//   has it: 1,025 of the placed ones ask for PlayerKeyword or the like.
// - Also observed in the original: a volume keeps one entry per reference, so OnTriggerEnter is
//   told once however many of its bodies come in; and a living actor counts by its controller.

import type { ScriptRuntime } from '../../../src/scripting/runtime/runtime.ts';
import { ActivatorKeywords } from '../../../src/scripting/runtime/activator-keywords.ts';
import { ProjectileTriggers } from '../../../src/shell/projectile-triggers.ts';
import RAPIER from '@dimforge/rapier3d-compat';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CollisionMatrix as Matrix,
  Layer,
  LayerFlag,
  readCollisionMatrix,
  type CollisionLayer as CollisionLayerRow,
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
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

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
  const volumeLayers = new Map<number, number>();

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
        ) {
          triggers++;
          const xtri = record.fields.first('XTRI');
          const layer = xtri
            ? new DataView(xtri.buffer, xtri.byteOffset, 4).getUint32(0, true)
            : Layer.trigger;
          volumeLayers.set(layer, (volumeLayers.get(layer) ?? 0) + 1);
        }
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

  it('counts the layers those volumes are on (XTRI), and what each takes in (COLL)', () => {
    expect(Object.fromEntries(volumeLayers)).toEqual({
      [Layer.trigger]: 4457 + 197,
      [Layer.actorZone]: 158,
      [Layer.projectileZone]: 18,
      [DEAD_ACTOR_ZONE]: 7,
      [LIVING_AND_DEAD_ACTORS]: 5,
      [TRAP_TRIGGER]: 56,
      [Layer.nonCollidable]: 387,
      [Layer.transparent]: 1,
    });
    const takes = (layer: number, other: number): boolean => matrix.collides(layer, other);
    expect(takes(Layer.actorZone, Layer.charController)).toBe(true);
    expect(takes(Layer.actorZone, Layer.deadBip)).toBe(false);
    expect(takes(Layer.projectileZone, Layer.charController)).toBe(false);
    expect(takes(Layer.projectileZone, Layer.spell)).toBe(true);
    expect(takes(DEAD_ACTOR_ZONE, Layer.charController)).toBe(false);
    expect(takes(DEAD_ACTOR_ZONE, Layer.deadBip)).toBe(true);
    expect(takes(TRAP_TRIGGER, Layer.clutter)).toBe(false);
    expect(takes(TRAP_TRIGGER, Layer.charController)).toBe(true);
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

const IDENTITY_AT = (x: number, y: number, z: number): Float32Array =>
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

/** L_DEADACTORZONE, L_LIVING_AND_DEAD_ACTORS and L_TRAP_TRIGGER (COLL BNAM). */
const DEAD_ACTOR_ZONE = 0x2f;
const LIVING_AND_DEAD_ACTORS = 0x34;
const TRAP_TRIGGER = 0x36;

const MERCER_FREY_HOUSE = 0x37cc6;
/** A plain trigger box (L_TRIGGER), long along y, and a place on the floor inside it. */
const BOX = 0x94027;
const IN_THE_BOX: [number, number, number] = [-1026, 1346, -60];
const IRON_SWORD = 0x12eb7;

describe.skipIf(!hasGamedata())('what comes into a trigger box (headless simulation)', () => {
  let sim: Sim;

  /** What the box was told of a reference since `from` (true: it entered). */
  const told = (reference: number, from = 0): boolean[] =>
    sim
      .events('triggerEnterLeave')
      .slice(from)
      .filter((event) => event.trigger === BOX && event.reference === reference)
      .map((event) => event.entered);
  const count = (): Promise<unknown> =>
    sim.native(sim.runtime.referenceHandle(BOX), 'ObjectReference', 'GetTriggerObjectCount', []);
  const handle = (reference: number): ReturnType<ScriptRuntime['referenceHandle']> =>
    sim.runtime.referenceHandle(reference);

  beforeAll(async () => {
    // The player arrives inside it, with its cell.
    sim = await openSim({
      interior: MERCER_FREY_HOUSE,
      hour: 10,
      arrival: { position: IN_THE_BOX, heading: 0 },
    });
    await sim.step(1);
    sim.look([IN_THE_BOX[0], IN_THE_BOX[1] + 100, IN_THE_BOX[2] + 20]);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('tells what was inside a trigger when its cell loads (OnTriggerEnter on what stands in it)  [original]', async () => {
    expect(told(PLAYER_REF)).toEqual([true]);
    expect(await count()).toBe(1);
  });

  it('tells what stands in a trigger as it is disabled and enabled  [original]', async () => {
    const from = sim.events('triggerEnterLeave').length;
    await sim.native(handle(BOX), 'ObjectReference', 'Disable', [false]);
    await sim.step(0.5);
    expect(told(PLAYER_REF, from)).toEqual([false]);
    expect(await count()).toBe(0);
    await sim.native(handle(BOX), 'ObjectReference', 'Enable', [false]);
    await sim.step(0.5);
    expect(told(PLAYER_REF, from)).toEqual([false, true]);
    expect(await count()).toBe(1);
  });

  it('tells a trigger a weapon dropped into it (L_WEAPON), and its leaving as it is disabled  [COLL, original]', async () => {
    const from = sim.events('triggerEnterLeave').length;
    await sim.native(handle(PLAYER_REF), 'ObjectReference', 'AddItem', [
      sim.runtime.formHandle(IRON_SWORD),
      1,
      true,
    ]);
    expect(await sim.drop(IRON_SWORD)).toBe(true);
    const others = (): { reference: number; entered: boolean }[] =>
      sim
        .events('triggerEnterLeave')
        .slice(from)
        .filter((event) => event.trigger === BOX && event.reference !== PLAYER_REF);
    expect(await sim.until(() => others().length > 0, 8)).toBe(true);
    const dropped = others()[0]?.reference ?? 0;
    expect((await sim.runtime.baseOf(dropped))?.toString(16)).toBe(IRON_SWORD.toString(16));
    expect(others()[0]?.entered).toBe(true);
    expect(await count()).toBe(2);
    await sim.native(handle(dropped), 'ObjectReference', 'Disable', [false]);
    await sim.step(0.5);
    expect(told(dropped, from)).toEqual([true, false]);
    expect(await count()).toBe(1);
  });

  it('tells a trigger a dead body in it (L_DEADBIP), and OnTriggerLeave as it is deleted  [COLL, original]', async () => {
    const from = sim.events('triggerEnterLeave').length;
    const actor = await sim.place(await sim.formId('NPC_', 'Hulda'), PLAYER_REF);
    await sim.step(1);
    expect(told(actor, from)).toEqual([true]);
    await sim.native(handle(actor), 'ObjectReference', 'Disable', [false]);
    await sim.step(0.5);
    expect(told(actor, from)).toEqual([true, false]);
    await sim.native(handle(actor), 'ObjectReference', 'Enable', [false]);
    await sim.step(1);
    expect(told(actor, from)).toEqual([true, false, true]);
    // Its controller goes with its life; its ragdoll's bodies are in the box from then on.
    await sim.kill(actor, PLAYER_REF);
    await sim.step(1);
    expect(told(actor, from)).toEqual([true, false, true, false, true]);
    await sim.native(handle(actor), 'ObjectReference', 'Delete', []);
    await sim.step(0.5);
    expect(told(actor, from)).toEqual([true, false, true, false, true, false]);
    expect(await count()).toBe(1);
  });

  it('tells a trigger a spell’s, a flame’s, a beam’s or a cone’s projectile in it (L_SPELL, L_CONEPROJECTILE)  [COLL]', async () => {
    for (const editorId of ['FireBolt', 'Flames', 'Sparks', 'VoiceUnrelentingForce1']) {
      const from = sim.events('triggerEnterLeave').length;
      expect(await sim.cast(await sim.formId('SPEL', editorId))).toBe(true);
      await sim.step(2);
      const shots = sim
        .events('triggerEnterLeave')
        .slice(from)
        .filter((event) => event.trigger === BOX && event.reference >= 0xff000000);
      expect(shots.map((event) => event.entered)).toEqual([true, false]);
      expect(shots[0]?.reference).toBe(shots[1]?.reference);
      const base = await sim.db.get((await sim.runtime.baseOf(shots[0]?.reference ?? 0)) ?? 0);
      expect(base?.type).toBe('PROJ');
    }
  });
});

const NIGHTGATE_CELLAR = 0x27552;
/** One of the cellar's five volumes on L_DEADACTORZONE, and one on PlayerKeyword's. */
const DEAD_ZONE = 0x5a9dd;
const GOLDENGLOW_ESTATE = 0x2d3e8;
const PLAYER_ONLY = 0xeb0f9;

describe.skipIf(!hasGamedata())('who a volume takes in (headless simulation)', () => {
  it('checks the layer matrix for every trigger: a layer that does not collide with the trigger’s is not told (the trigger’s own layer: XTRI)  [COLL]', async () => {
    const sim = await openSim({ interior: NIGHTGATE_CELLAR, hour: 10 });
    try {
      await sim.step(1);
      const at = await sim.position(DEAD_ZONE);
      expect(at).toBeDefined();
      if (!at) return;
      const told = (): number[] =>
        sim
          .events('triggerEnterLeave')
          .filter((event) => event.trigger === DEAD_ZONE)
          .map((event) => event.reference);
      await sim.moveTo([at[0], at[1], at[2]]);
      await sim.step(1);
      // The player in it: a living controller is nothing to L_DEADACTORZONE.
      expect(told()).toEqual([]);
      const actor = await sim.place(await sim.formId('NPC_', 'Hulda'), PLAYER_REF);
      await sim.step(1);
      expect(told()).toEqual([]);
      // Dead, its bodies are.
      await sim.kill(actor, PLAYER_REF);
      expect(await sim.until(() => told().includes(actor), 5)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);

  it('tells an activator with a keyword (ACTI KNAM) only what has it: the player its PlayerKeyword, no one else  [original, data]', async () => {
    const sim = await openSim({ interior: GOLDENGLOW_ESTATE, hour: 10 });
    try {
      await sim.step(1);
      const at = await sim.position(PLAYER_ONLY);
      expect(at).toBeDefined();
      if (!at) return;
      const told = (): number[] =>
        sim
          .events('triggerEnterLeave')
          .filter((event) => event.trigger === PLAYER_ONLY)
          .map((event) => event.reference);
      const actor = await sim.place(await sim.formId('NPC_', 'Hulda'), PLAYER_ONLY);
      await sim.step(1.5);
      expect(told()).not.toContain(actor);
      await sim.moveTo([at[0], at[1], at[2]]);
      await sim.step(1);
      expect(told()).toEqual([PLAYER_REF]);
    } finally {
      await sim.close();
    }
  }, 600_000);
});

describe('what enters a trigger', () => {
  it('asks an activator’s keyword once, and tells nothing of those without it  [original]', async () => {
    let asked = 0;
    const keywords = new ActivatorKeywords(
      (reference) => {
        asked++;
        return Promise.resolve(reference === 1 ? 0x99 : undefined);
      },
      (who) => Promise.resolve(who === 20),
    );
    expect(keywords.asksNothing(2)).toBe(false);
    expect(await keywords.admits(2, 21)).toBe(true);
    expect(keywords.asksNothing(2)).toBe(true);
    expect(await keywords.admits(1, 21)).toBe(false);
    expect(await keywords.admits(1, 20)).toBe(true);
    expect(asked).toBe(2);
  });
  it(
    'finds a trigger by its own layer: a controller is not told L_PROJECTILEZONE, a body not ' +
      'L_ACTORZONE  [COLL]',
    async () => {
      await initPhysics();
      const layer = (
        index: number,
        flags: number,
        collidesWith: readonly number[],
      ): CollisionLayerRow => ({
        formId: index + 100,
        editorId: String(index),
        index,
        name: '',
        flags,
        collidesWith: collidesWith.map((other) => other + 100),
      });
      const matrix = new Matrix([
        layer(Layer.charController, 0, [Layer.trigger, Layer.actorZone]),
        layer(Layer.biped, 0, [Layer.trigger]),
        layer(Layer.trigger, LayerFlag.triggerVolume, [Layer.charController, Layer.biped]),
        layer(Layer.actorZone, LayerFlag.triggerVolume, [Layer.charController]),
        layer(Layer.projectileZone, LayerFlag.triggerVolume, [Layer.spell]),
        layer(Layer.spell, 0, [Layer.projectileZone]),
      ]);
      const physics = new PhysicsWorld(matrix, 0);
      for (const [index, reference] of [
        [Layer.trigger, 1],
        [Layer.actorZone, 2],
        [Layer.projectileZone, 3],
      ] as const) {
        physics.addPrimitive('box', [100, 100, 100], IDENTITY_AT(0, 0, 0), index, {
          reference,
          kind: 'object',
        });
      }
      const body = (index: number): RAPIER.Collider => {
        const collider = physics.world.createCollider(
          RAPIER.ColliderDesc.ball(0.2),
          physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()),
        );
        physics.register(collider, index, { reference: 0x50 + index, kind: 'object' });
        return collider;
      };
      const controller = body(Layer.charController);
      const biped = body(Layer.biped);
      physics.step(1 / 60);
      expect([...physics.triggersOverlapping(controller)].sort()).toEqual([1, 2]);
      expect([...physics.triggersOverlapping(biped)]).toEqual([1]);
      physics.free();
    },
  );
  it('tells a trigger a trap’s moving body in it (L_TRAP) and large debris (L_DEBRIS_LARGE)  [COLL]', async () => {
    await initPhysics();
    const layer = (
      index: number,
      flags: number,
      collidesWith: readonly number[],
    ): CollisionLayerRow => ({
      formId: index + 100,
      editorId: String(index),
      index,
      name: '',
      flags,
      collidesWith: collidesWith.map((other) => other + 100),
    });
    const matrix = new Matrix([
      layer(Layer.trigger, LayerFlag.triggerVolume, [Layer.trap, Layer.debrisLarge]),
      layer(Layer.trap, 0, [Layer.trigger]),
      layer(Layer.debrisLarge, 0, [Layer.trigger]),
    ]);
    const physics = new PhysicsWorld(matrix, 0);
    physics.addPrimitive('box', [50, 50, 50], IDENTITY_AT(0, 0, 0), Layer.trigger, {
      reference: 0x77,
      kind: 'object',
    });
    // A keyframed body on L_TRAP, as an animation moves it.
    const blade = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(10, 0, 0),
    );
    physics.register(
      physics.world.createCollider(RAPIER.ColliderDesc.ball(0.2), blade),
      Layer.trap,
      {
        reference: 0x10,
        kind: 'object',
      },
    );
    physics.step(1 / 60);
    expect(physics.movingInTriggers().has(0x10)).toBe(false);
    // Still, even in a volume, it tells nothing; moved in, it does.
    blade.setNextKinematicTranslation({ x: 0, y: 0, z: 0 });
    physics.step(1 / 60);
    expect([...(physics.movingInTriggers().get(0x10) ?? [])]).toEqual([0x77]);
    physics.step(1 / 60);
    expect(physics.movingInTriggers().has(0x10)).toBe(false);
    // Large debris falls through as a dynamic body does.
    const debris = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0, 0).setLinvel(0.1, 0, 0),
    );
    physics.register(
      physics.world.createCollider(RAPIER.ColliderDesc.ball(0.2), debris),
      Layer.debrisLarge,
      { reference: 0x11, kind: 'object' },
    );
    physics.step(1 / 60);
    expect([...(physics.movingInTriggers().get(0x11) ?? [])]).toEqual([0x77]);
    physics.free();
  });
  it('tells the leaving of what is gone, at rest or not, once asked what went  [original]', async () => {
    await initPhysics();
    const physics = new PhysicsWorld(new Matrix([]), 0);
    const placed = physics.addPrimitive('box', [10, 10, 10], IDENTITY_AT(0, 0, 0), Layer.trigger, {
      reference: 0x77,
      kind: 'object',
    });
    physics.setEnabled(placed, true);
    expect(physics.takeGone().size).toBe(0);
    physics.setEnabled(placed, false);
    expect([...physics.takeGone()]).toEqual([0x77]);
    expect(physics.takeGone().size).toBe(0);
    physics.remove(placed);
    expect([...physics.takeGone()]).toEqual([0x77]);
    physics.free();
  });
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
  it('tells a trigger an arrow or spell flying through it, in and out  [COLL]', () => {
    const told: (readonly [number, number, boolean])[] = [];
    let made = 0;
    let deleted = 0;
    const runtime = {
      state: {
        create: () => ++made + 0xff000000,
        reference: () => ({ position: [0, 0, 0] }),
      },
      triggered: (trigger: number, reference: number, entered: boolean) => {
        told.push([trigger, reference, entered]);
      },
      deleteReference: () => {
        deleted++;
      },
    } as unknown as ScriptRuntime;
    // A box of a trigger from x 10 to x 20.
    const along = (from: readonly number[]): ReadonlySet<number> =>
      (from[0] ?? 0) >= 10 && (from[0] ?? 0) < 20 ? new Set([7]) : new Set();
    const triggers = new ProjectileTriggers(() => runtime, along);
    const shot = {};
    const way = (x: number): void => {
      triggers.step(shot, 0x99, [x, 0, 0], [x + 5, 0, 0], 6);
    };
    way(0);
    expect(made).toBe(0);
    way(10);
    way(15);
    way(20);
    const reference = 0xff000001;
    expect(told).toEqual([
      [7, reference, true],
      [7, reference, false],
    ]);
    triggers.end(shot);
    expect(deleted).toBe(1);
    // One whose flight ends inside leaves as it ends.
    const other = {};
    triggers.step(other, 0x99, [10, 0, 0], [12, 0, 0], 6);
    triggers.end(other);
    expect(told.at(-1)?.[2]).toBe(false);
    expect(deleted).toBe(2);
  });
});

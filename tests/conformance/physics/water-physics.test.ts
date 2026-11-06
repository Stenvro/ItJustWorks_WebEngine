// Conformance: water physics (engine map: Physics > Water physics). What water does to bodies:
// buoyancy, currents, damage, splashes. Skipped without game data where it needs it.
//
// Sources:
// - The data (every WATR of the load order): TNAM, its material (MATT); DATA, damage a second;
//   XNAM, the spell it casts on what is in it; NAM0 and NAM1, the water's linear and angular
//   velocity (its current); FNAM's flags (UESP "Skyrim Mod:Mod File Format/WATR"; xEdit's WATR).
// - The settings' built-in values (the engine's defaults): fBuoyancyMultBody 1,
//   fBuoyancyMultExtremity −0.3 (a ragdoll's trunk floats, its limbs sink), [HAVOK]
//   fDefaultWaterfallCurrentVelocity 6, fWaterKnockdownVelocity 10 (Skyrim.esm 5).
// - The engine's rule, observed in the original: TODO(M13): the buoyancy action (which bodies float, by
//   what density) is not read yet.
// - Inferred (TODO(M13) in src/physics/water-physics.ts): the lift, the drag's strength, and what a
//   waterfall does (CommonLibSSE names its collision shape; the vanilla falling water has a fixed
//   body of the Water material on L_STATIC). These cases keep those readings from changing
//   unnoticed; they do not say the original's numbers are these.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseNif } from '../../../src/formats/nif/nif.ts';
import {
  buildCollision,
  HAVOK_SCALE,
  type CollisionBody,
  type CollisionData,
} from '../../../src/physics/collision-data.ts';
import { CollisionMatrix, Layer } from '../../../src/physics/collision-layers.ts';
import { GRAVITY, initPhysics, PhysicsWorld } from '../../../src/physics/physics-world.ts';
import {
  DEFAULT_WATERFALL_VELOCITY,
  splashImpact,
  WATER_RULE_DEFAULTS,
  WaterPhysics,
  type WaterRules,
  type WaterSplash,
} from '../../../src/physics/water-physics.ts';
import { ObjectHandle } from '../../../src/scripting/values.ts';
import type { Mat4 } from '../../../src/render/math.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { ActorValue } from '../../../src/world/actor-values.ts';
import { materialId } from '../../../src/world/material-type.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { parseWaterBody } from '../../../src/world/water.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const IDENTITY: Mat4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const WATER_TYPE = 7;
const WOOD = 100;
const STONE = 101;

const matrix = new CollisionMatrix([
  { formId: 1, editorId: 'L_CLUTTER', index: Layer.clutter, name: '', flags: 0, collidesWith: [2] },
  { formId: 2, editorId: 'L_STATIC', index: Layer.static, name: '', flags: 0, collidesWith: [1] },
  { formId: 3, editorId: 'L_DEADBIP', index: Layer.deadBip, name: '', flags: 0, collidesWith: [] },
]);

/** A body: a cube `size` game units wide, of a material, on a layer. */
function cube(options: {
  readonly material: number;
  readonly mass: number;
  readonly size: number;
  readonly layer?: number;
  readonly node?: string;
  readonly fixed?: boolean;
}): CollisionData {
  const half = options.size / 2;
  const points: number[] = [];
  for (const x of [-half, half]) {
    for (const y of [-half, half]) for (const z of [-half, half]) points.push(x, y, z);
  }
  const layer = options.layer ?? Layer.clutter;
  const mass = options.mass;
  const body: CollisionBody = {
    node: options.node ?? 'Crate',
    transform: IDENTITY,
    motion: options.fixed === true ? 'fixed' : 'dynamic',
    phantom: false,
    layer,
    mass,
    inertia: [mass / 6, mass / 6, mass / 6],
    centerOfMass: [0, 0, 0],
    friction: 0.5,
    restitution: 0.2,
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
        material: options.material,
        points: Float32Array.from(points),
        radius: 0,
      },
    ],
  };
  return { bodies: [body], skipped: [] };
}

const at = (x: number, y: number, z: number): Mat4 => {
  const matrix4 = new Float32Array(IDENTITY);
  matrix4[12] = x;
  matrix4[13] = y;
  matrix4[14] = z;
  return matrix4;
};

/** Water 1000 units deep, its surface at z 0, of a type. */
function inWater(rules: WaterRules): { physics: PhysicsWorld; water: WaterPhysics } {
  const physics = new PhysicsWorld(matrix, GRAVITY);
  const water = new WaterPhysics(
    physics,
    (_x, _y, z) => (z > -1000 ? { height: 0, type: WATER_TYPE } : undefined),
    rules,
  );
  return { physics, water };
}

function run(physics: PhysicsWorld, water: WaterPhysics, seconds: number): void {
  for (let t = 0; seconds - t >= physics.stepSeconds / 2; t += physics.stepSeconds) {
    physics.step(physics.stepSeconds, (step) => {
      water.step(step);
    });
  }
}

/** What the water types of the load order carry that acts on bodies. */
interface WaterCensus {
  types: number;
  withMaterial: number;
  withDamage: number;
  withSpell: number;
  withCurrent: number;
}

describe.skipIf(!hasGamedata())('the water types of the load order (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  const census: WaterCensus = {
    types: 0,
    withMaterial: 0,
    withDamage: 0,
    withSpell: 0,
    withCurrent: 0,
  };

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    for (const formId of db.formIdsOfType('WATR')) {
      const record = await db.get(formId);
      if (!record) continue;
      const fields = record.fields;
      census.types++;
      if ((fields.first('TNAM')?.length ?? 0) >= 4) census.withMaterial++;
      const damage = fields.first('DATA');
      if (damage && damage.length >= 2 && (damage[0] ?? 0) + (damage[1] ?? 0) > 0)
        census.withDamage++;
      const spell = fields.first('XNAM');
      if (spell?.some((byte) => byte !== 0) === true) census.withSpell++;
      const velocity = fields.first('NAM0');
      if (velocity && velocity.length >= 12) {
        const view = new DataView(velocity.buffer, velocity.byteOffset, velocity.byteLength);
        const speed = Math.hypot(
          view.getFloat32(0, true),
          view.getFloat32(4, true),
          view.getFloat32(8, true),
        );
        if (speed > 0) census.withCurrent++;
      }
    }
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts 58 water types: 35 with a current, 7 with a material, none that damages or casts', () => {
    expect(census).toEqual({
      types: 58,
      withMaterial: 7,
      withDamage: 0,
      withSpell: 0,
      withCurrent: 35,
    });
  });

  it('pushes what floats in a water with a current along its linear velocity (NAM0)', async () => {
    await initPhysics();
    // RiverWaterFlowSE [00108AC7].
    const record = await db.get(0x108ac7);
    if (!record) throw new Error('no water type');
    const body = parseWaterBody(record);
    expect(body.linearVelocity[0]).toBeCloseTo(1.8, 1);
    expect(body.linearVelocity[1]).toBeCloseTo(-2.2, 1);
    const { physics, water } = inWater({
      ...WATER_RULE_DEFAULTS,
      currents: new Map([
        [WATER_TYPE, { linear: [...body.linearVelocity], angular: [...body.angularVelocity] }],
      ]),
      buoyancy: new Map([[WOOD, 0.25]]),
    });
    const placed = physics.addObject(
      cube({ material: WOOD, mass: 300, size: HAVOK_SCALE }),
      at(0, 0, 100),
      { reference: 1, kind: 'object' },
    );
    run(physics, water, 20);
    const v = placed.bodies[0]?.body.linvel();
    expect(v?.x).toBeCloseTo(body.linearVelocity[0], 0);
    expect(v?.y).toBeCloseTo(body.linearVelocity[1], 0);
    physics.free();
  }, 60_000);

  it('knows the waterfall bodies: fixed shapes of the Water material on L_STATIC', async () => {
    for (const model of [
      'fxwaterfallbodytall',
      'fxwaterfallbodyslope',
      'fxwaterfallthin2048x128',
    ]) {
      const collision = buildCollision(parseNif(await vfs.read(`meshes\\effects\\${model}.nif`)));
      const body = collision.bodies[0];
      expect(body?.motion).toBe('fixed');
      expect(body?.layer).toBe(Layer.static);
      expect(body?.shapes[0]?.material).toBe(materialId('Water'));
    }
  }, 60_000);
});

describe('buoyancy', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('floats a ragdoll’s trunk (fBuoyancyMultBody 1) and sinks its limbs (fBuoyancyMultExtremity −0.3), a corpse’s too', () => {
    const { physics, water } = inWater(WATER_RULE_DEFAULTS);
    expect(WATER_RULE_DEFAULTS.ragdollBody).toBe(1);
    expect(WATER_RULE_DEFAULTS.ragdollExtremity).toBe(-0.3);
    const bone = (node: string, x: number) =>
      physics.addObject(
        // Half a metre across, of 50 kg: floats on 1, sinks on −0.3 (0.7 × 125 kg of water lifts).
        cube({ material: STONE, mass: 100, size: HAVOK_SCALE / 2, layer: Layer.deadBip, node }),
        at(x, 0, 200),
        { reference: 1, kind: 'object' },
      );
    const trunk = bone('NPC Spine [Spn0]', 0);
    const calf = bone('NPC L Calf [LClf]', 500);
    run(physics, water, 15);
    const z = (placed: ReturnType<typeof bone>): number =>
      (placed.bodies[0]?.body.translation().z ?? 0) * HAVOK_SCALE;
    // Lift at 2 × 125 kg of water holds 100 kg at 40 % under; 0.7 × 125 kg does not.
    expect(z(trunk)).toBeGreaterThan(-10);
    expect(z(trunk)).toBeLessThan(30);
    expect(z(calf)).toBeLessThan(-200);
    physics.free();
  });

  it('carries what touches a waterfall down it at fDefaultWaterfallCurrentVelocity (6)', () => {
    expect(DEFAULT_WATERFALL_VELOCITY).toBe(6);
    const pull = (material: number): number => {
      const physics = new PhysicsWorld(matrix, GRAVITY);
      const water = new WaterPhysics(physics, () => undefined, {
        ...WATER_RULE_DEFAULTS,
        waterMaterial: materialId('Water'),
      });
      // The falling water's body, and something against its side that gravity leaves alone.
      physics.addObject(
        cube({ material, mass: 0, size: 300, layer: Layer.static, fixed: true }),
        at(0, 0, 0),
        { reference: 1, kind: 'object' },
      );
      const placed = physics.addObject(
        cube({ material: WOOD, mass: 10, size: 30 }),
        at(164.9, 0, 0),
        { reference: 2, kind: 'object' },
      );
      const body = placed.bodies[0]?.body;
      if (!body) throw new Error('no body');
      physics.settle(placed);
      body.setGravityScale(0, true);
      physics.step(physics.stepSeconds);
      for (let i = 0; i < 300; i++) {
        // Held to the side: contacts with the fall stay.
        body.setTranslation({ x: 164.9 / HAVOK_SCALE, y: 0, z: 0 }, true);
        body.setLinvel({ x: -0.1, y: 0, z: body.linvel().z }, true);
        physics.step(physics.stepSeconds, (step) => {
          water.step(step);
        });
      }
      const speed = body.linvel().z;
      physics.free();
      return speed;
    };
    // Towards the setting's speed, at the water's drag, while it touches: never past it.
    expect(pull(materialId('Water'))).toBeLessThan(-2);
    expect(pull(materialId('Water'))).toBeGreaterThan(-6.1);
    expect(Math.abs(pull(STONE))).toBeLessThan(0.1);
  });
});

describe('splashes', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('slows what enters water (water drag)', () => {
    const { physics, water } = inWater({
      ...WATER_RULE_DEFAULTS,
      buoyancy: new Map([[STONE, -1]]),
    });
    const placed = physics.addObject(cube({ material: STONE, mass: 100, size: 40 }), at(0, 0, 40), {
      reference: 1,
      kind: 'object',
    });
    const body = placed.bodies[0]?.body;
    if (!body) throw new Error('no body');
    body.setLinvel({ x: 0, y: 0, z: -15 }, true);
    run(physics, water, 3);
    // Three seconds' free fall would have it at −44 Havok units a second; water settles it at
    // gravity over the drag.
    expect(body.linvel().z).toBeGreaterThan(-8.5);
    expect(body.linvel().z).toBeLessThan(-5);
    physics.free();
  });

  it('keeps a splash’s material for its sound: the thing’s against the water’s', () => {
    const splash: WaterSplash = {
      key: 7,
      actor: false,
      position: [1, 2, 3],
      size: 'light',
      leaving: false,
      speed: 200,
      material: WOOD,
      waterType: WATER_TYPE,
      model: 'Effects\\waterSplash.NIF',
      scale: 0.4,
    };
    const impact = splashImpact(splash, 55);
    expect(impact.material).toBe(WOOD);
    expect(impact.against).toBe(55);
  });
});

const TAMRIEL = 0x3c;

describe.skipIf(!hasGamedata())('water in the simulation', () => {
  let sim: Sim;
  /** A deep point of Riverwood's river: its bed and its surface. */
  let bed: [number, number, number] = [0, 0, 0];
  let surface = 0;
  let npc = 0;

  const water = (): WaterPhysics => {
    const found = sim.world.play?.water;
    if (!found) throw new Error('no water');
    return found;
  };

  function deepest(): { floor: [number, number, number]; depth: number } | undefined {
    const play = sim.world.play;
    if (!play) return undefined;
    let found: { floor: [number, number, number]; depth: number } | undefined;
    for (const [cx, cy] of [
      [4, -11],
      [5, -11],
      [4, -12],
    ] as const) {
      for (let x = 64; x < 4096; x += 128) {
        for (let y = 64; y < 4096; y += 128) {
          const point: [number, number] = [cx * 4096 + x, cy * 4096 + y];
          const hit = play.physics.raycast(
            [...point, 6000],
            [0, 0, -1],
            12_000,
            Layer.charController,
          );
          const over = hit && water().surface(point[0], point[1], hit.point[2]);
          if (over && over.height - hit.point[2] > (found?.depth ?? 0)) {
            found = {
              floor: [point[0], point[1], hit.point[2]],
              depth: over.height - hit.point[2],
            };
          }
        }
      }
    }
    return found;
  }

  beforeAll(async () => {
    sim = await openSim({ exterior: { world: TAMRIEL, cell: [4, -11] }, hour: 10 });
    let deep = deepest();
    for (let i = 0; i < 30 && (deep?.depth ?? 0) < 130; i++) {
      await sim.step(0.2);
      deep = deepest();
    }
    if (!deep) throw new Error('no water');
    bed = deep.floor;
    surface = bed[2] + deep.depth;
    await sim.moveTo([bed[0] - 400, bed[1], surface + 200]);
    await sim.step(1);
    for (const staged of sim.actors()) {
      if (staged.dead || !sim.world.stage.movers.motion(staged.reference)) continue;
      if (!/^(Embry|Sigrid|Alvor|Hod|Gerdur|Faendal|Sven)/.test(staged.placed.look.editorId)) {
        continue;
      }
      npc = staged.reference;
      break;
    }
    if (npc === 0) throw new Error('no one in the town');
    await sim.native(new ObjectHandle(npc, 'actor'), 'Actor', 'EnableAI', [false]);
  }, 300_000);
  afterAll(async () => {
    await sim.close();
  });

  it('reads a water’s material for its splashes (TNAM): the puddles’ own, else Water', () => {
    const puddle = 0xfe092;
    const river = 0x108ac7;
    expect(water().waterMaterial(puddle)).toBe(materialId('MaterialWaterPuddle'));
    expect(water().waterMaterial(river)).toBe(materialId('Water'));
  });

  it('floats a loose object dropped into water at the surface, and sinks an iron one', async () => {
    const dropped = async (editorId: string, aside: number): Promise<number> => {
      const reference = await sim.place(await sim.formId('MISC', editorId), PLAYER_REF);
      sim.runtime.move(reference, [bed[0] + aside, bed[1] + aside, surface + 100]);
      await sim.step(6);
      const end = await sim.position(reference);
      if (!end) throw new Error('nothing there');
      return end[2];
    };
    expect(Math.abs((await dropped('Firewood01', 60)) - surface)).toBeLessThan(40);
    // Down to whatever lies under it there: the bed, 90 units or more under the surface here.
    const iron = await dropped('IngotIron', 0);
    expect(iron).toBeLessThan(surface - 90);
  }, 120_000);

  it('splashes where a body or an actor enters water: its sound, its model at the surface', async () => {
    const show = vi.spyOn(sim.world.stage.fx, 'show');
    const play = sim.world.play;
    if (!play) throw new Error('no play');
    const heard: WaterSplash[] = [];
    const shown = play.onSplash;
    play.onSplash = (splash) => {
      heard.push(splash);
      shown?.(splash);
    };
    sim.runtime.move(npc, [bed[0], bed[1], surface + 400]);
    await sim.step(2);
    const actor = heard.find((splash) => splash.actor && splash.key === npc);
    expect(actor).toBeDefined();
    expect(actor?.leaving).toBe(false);
    expect(actor?.position[2]).toBeCloseTo(surface, 3);
    const body = await sim.place(await sim.formId('MISC', 'Firewood01'), PLAYER_REF);
    sim.runtime.move(body, [bed[0] + 150, bed[1], surface + 600]);
    await sim.step(2);
    expect(heard.some((splash) => !splash.actor)).toBe(true);
    // Its model shows at the surface at the splash's scale.
    expect(
      show.mock.calls.some(
        ([model, , place, options]) =>
          model === actor?.model && place[2] === surface && options.scale === actor?.scale,
      ),
    ).toBe(true);
    play.onSplash = shown;
    show.mockRestore();
  }, 120_000);

  it('damages what stands in a water with damage each second, and casts its spell', async () => {
    const rules = water().rules;
    const over = water().surface(bed[0], bed[1], bed[2]);
    if (!over) throw new Error('no surface');
    const spell = await sim.formId('SPEL', 'Flames');
    const cast = vi.spyOn(sim.runtime.magic, 'cast').mockResolvedValue(true);
    water().rules = {
      ...rules,
      harms: new Map([[over.type, { causesDamage: true, damagePerSecond: 5, spell }]]),
    };
    const health = async (reference: number): Promise<number> =>
      (await sim.runtime.actors.value(reference, ActorValue.health)).current;
    try {
      sim.runtime.move(npc, [bed[0], bed[1], bed[2] + 2]);
      await sim.moveTo([bed[0] - 300, bed[1], bed[2] + 2]);
      await sim.step(0.5);
      const before = [await health(npc), await health(PLAYER_REF)] as const;
      await sim.step(2);
      const after = [await health(npc), await health(PLAYER_REF)] as const;
      // 5 a second over 2 s, what regeneration gives back aside.
      expect(before[0] - after[0]).toBeGreaterThan(8);
      expect(before[0] - after[0]).toBeLessThan(12);
      expect(before[1] - after[1]).toBeGreaterThan(8);
      expect(before[1] - after[1]).toBeLessThan(12);
      const on = (reference: number): boolean =>
        cast.mock.calls.some(([form, , target]) => form === spell && target === reference);
      expect(on(npc)).toBe(true);
      expect(on(PLAYER_REF)).toBe(true);
    } finally {
      water().rules = rules;
      cast.mockRestore();
    }
  }, 120_000);
});
